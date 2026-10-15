import assert from "node:assert/strict";
import { WebSocket } from "../../apps/server/node_modules/ws/wrapper.mjs";
import { spawn, execFileSync } from "node:child_process";
import { once } from "node:events";
import { readFileSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { request } from "node:https";
import { join } from "node:path";

// HTTPS front door used by a real Linux installer/Agent in ssh-target.mjs.
// Browser UI automation uses a separate loopback HTTP development listener;
// HTTPS requests here and both proxy hops verify their configured CA.
export async function startFrontendEntry({ mode, root, temp, tls, apiPort }) {
  assert.ok(["vite", "nginx"].includes(mode));
  let vite, container;
  const ca = readFileSync(join(tls, "ca.crt"));
  const get = (url, options = {}) =>
    new Promise((resolve, reject) => {
      const { body, ...requestOptions } = options;
      const req = request(url, { ca, ...requestOptions }, (res) => {
        const chunks = [];
        res.on("data", (c) => chunks.push(c));
        res.on("end", () =>
          resolve({
            status: res.statusCode,
            text: Buffer.concat(chunks).toString(),
          }),
        );
      });
      req.on("error", reject);
      req.setTimeout(3000, () => req.destroy(Error("timeout")));
      req.end(body);
    });
  async function close() {
    if (vite && vite.exitCode === null) {
      const ended = once(vite, "exit");
      vite.kill();
      await ended;
    }
    if (container) {
      try {
        execFileSync("docker", ["rm", "-f", container], { stdio: "ignore" });
      } catch {}
    }
  }
  try {
    let port;
    if (mode === "vite") {
      const probe = createServer();
      await new Promise((r) => probe.listen(0, "127.0.0.1", r));
      port = probe.address().port;
      await new Promise((r) => probe.close(r));
      vite = spawn(
        process.execPath,
        [
          join(root, "apps/web/node_modules/vite/bin/vite.js"),
          "--host",
          "127.0.0.1",
          "--port",
          String(port),
          "--strictPort",
        ],
        {
          cwd: join(root, "apps/web"),
          env: {
            ...process.env,
            NODE_EXTRA_CA_CERTS: join(tls, "ca.crt"),
            FLEET_DEV_API_TARGET: `https://localhost:${apiPort}`,
            FLEET_DEV_WEB_TLS_CERT: join(tls, "server.crt"),
            FLEET_DEV_WEB_TLS_KEY: join(tls, "server.key"),
          },
          stdio: "ignore",
        },
      );
    } else {
      container = `farhelm-entry-e2e-${process.pid}`;
      const config = readFileSync(
        join(root, "deploy/nginx/farhelm.conf"),
        "utf8",
      )
        .replace("fleet.example.com", "host.docker.internal")
        .replace("/etc/farhelm/tls/public.crt", "/fixture/tls/server.crt")
        .replace("/etc/farhelm/tls/public.key", "/fixture/tls/server.key")
        .replace("/etc/farhelm/tls/backend-ca.crt", "/fixture/tls/ca.crt")
        .replace("/srv/farhelm/web", "/web")
        .replaceAll(
          "https://127.0.0.1:8443",
          `https://host.docker.internal:${apiPort}`,
        );
      writeFileSync(join(temp, "frontend.conf"), config);
      execFileSync(
        "docker",
        [
          "run",
          "--rm",
          "-d",
          "--name",
          container,
          "--publish",
          "127.0.0.1::443",
          "--mount",
          `type=bind,source=${temp},target=/fixture,readonly`,
          "--mount",
          `type=bind,source=${temp}/frontend.conf,target=/etc/nginx/conf.d/default.conf,readonly`,
          "--mount",
          `type=bind,source=${root}/apps/web/dist,target=/web,readonly`,
          process.env.FLEET_NGINX_IMAGE || "nginx:stable-alpine",
        ],
        { stdio: "pipe" },
      );
      execFileSync("docker", ["exec", container, "nginx", "-t"], {
        stdio: "pipe",
      });
      port = Number(
        execFileSync("docker", ["port", container, "443/tcp"], {
          encoding: "utf8",
        })
          .trim()
          .split(":")
          .at(-1),
      );
    }
    const origin = `https://host.docker.internal:${port}`,
      local = `https://localhost:${port}`;
    let ready = false;
    for (let i = 0; i < 100; i++) {
      try {
        ready = (await get(local + "/healthz")).status === 200;
      } catch {}
      if (ready) break;
      await new Promise((r) => setTimeout(r, 100));
    }
    assert.ok(ready, mode + " HTTPS entry health");
    const index = await get(local + "/");
    assert.equal(index.status, 200);
    assert.ok(index.text.includes('<div id="app">'));
    for (const path of [
      "/agent/ws",
      "/agent/address-probe",
      "/api/agent/install.sh",
      "/api/v1/devices",
    ]) {
      const r = await get(local + path);
      assert.equal(
        r.status,
        401,
        `${mode}: ${path} must reach backend authentication rather than the SPA`,
      );
      assert.ok(r.text.includes('"error"'));
    }
    await assert.rejects(get(local + "/healthz", { ca: [] }));
    async function terminal(deviceId, token, backend, username) {
      const auth = {
        authorization: "Bearer " + token,
        host: new URL(origin).host,
      };
      const response = await get(local + "/api/v1/terminal-sessions", {
        method: "POST",
        headers: { ...auth, "content-type": "application/json" },
        body: JSON.stringify({ v: 1, device_id: deviceId, cols: 80, rows: 24 }),
      });
      assert.equal(response.status, 200, response.text);
      const created = JSON.parse(response.text);
      const ws = new WebSocket(
        local.replace("https:", "wss:") + "/api/v1/terminal/ws",
        { ca, headers: { origin, host: new URL(origin).host } },
      );
      const events = [];
      ws.on("message", (raw) => events.push(JSON.parse(raw.toString())));
      const send = (type, body) =>
        ws.send(JSON.stringify({ v: 1, type, body }));
      async function wait(type) {
        for (let i = 0; i < 300; i++) {
          const event = events.find((e) => e.type === type);
          if (event) return event.body;
          await new Promise((r) => setTimeout(r, 50));
        }
        throw Error(`${mode}: no ${type}`);
      }
      try {
        await once(ws, "open");
        send("terminal.attach", {
          session_id: created.session_id,
          ticket: created.ticket,
        });
        assert.equal((await wait("terminal.ready")).backend, backend);
        send("terminal.input", {
          data: Buffer.from(
            "stty -echo; printf '__FRONTEND_%s__\\n' \"$(id -un)\"; exit\r",
          ).toString("base64"),
        });
        await wait("terminal.closed");
        const records = await get(
          local + `/api/v1/terminal-sessions/${created.session_id}/recording`,
          { headers: auth },
        );
        assert.equal(records.status, 200);
        const text = JSON.parse(records.text)
          .events.filter((e) => e.kind === "output")
          .map((e) => Buffer.from(e.data.data, "base64").toString())
          .join("");
        assert.ok(text.includes(`__FRONTEND_${username}__`));
      } finally {
        ws.terminate();
      }
    }
    return { origin, close, terminal };
  } catch (e) {
    await close();
    throw e;
  }
}
