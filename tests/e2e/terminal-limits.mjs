// Isolated release-package test: real Linux PTYs share device capacity across web and SSH.
import assert from "node:assert/strict";
import { spawn, execFileSync } from "node:child_process";
import { once } from "node:events";
import { mkdtempSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { createRequire } from "node:module";
import { buildServer } from "../../apps/server/dist/server.js";
import { assertValid } from "../contracts/validate.mjs";
const require = createRequire(import.meta.url),
  { WebSocket } = require("../../apps/server/node_modules/ws"),
  { Client } = require("../../apps/server/node_modules/ssh2");
const root = resolve(import.meta.dirname, "../.."),
  temp = mkdtempSync(join(tmpdir(), "farhelm-release-limits-")),
  tls = join(temp, "tls"),
  container = `farhelm-release-limits-${process.pid}`;
execFileSync("bash", [join(root, "deploy/dev/generate-tls.sh"), tls], {
  stdio: "ignore",
});
const ca = readFileSync(join(tls, "ca.crt"));
const server = await buildServer({
  dataDir: join(temp, "server"),
  tlsCert: join(tls, "server.crt"),
  tlsKey: join(tls, "server.key"),
  adminUsername: "admin",
  adminPassword: "accounts-e2e-login1",
  ssh: { host: "127.0.0.1", port: 0 },
});
await server.app.listen({ host: "127.0.0.1", port: 0 });
const port = server.app.server.address().port,
  origin = `https://localhost:${port}`,
  sockets = [],
  clients = [];
let admin,
  device,
  started = false;
async function until(fn, label) {
  const end = Date.now() + 20000;
  while (Date.now() < end) {
    if (await fn()) return;
    await new Promise((r) => setTimeout(r, 30));
  }
  throw Error("Timed out: " + label);
}
async function api(method, path, payload, auth = admin) {
  const r = await server.app.inject({
    method,
    url: "/api/v1" + path,
    payload,
    headers: auth ? { authorization: "Bearer " + auth } : {},
  });
  assert.equal(r.statusCode, 200, r.body);
  return r.json();
}
async function docker(args) {
  return new Promise((resolve, reject) => {
    const p = spawn("docker", args, { stdio: ["ignore", "pipe", "pipe"] });
    let output = "";
    p.stdout.on("data", (d) => (output += d));
    p.stderr.on("data", (d) => (output += d));
    p.on("error", reject);
    p.on("close", (code) =>
      code === 0 ? resolve(output) : reject(Error(output)),
    );
  });
}
async function open(auth = admin) {
  const created = await api(
    "POST",
    "/terminal-sessions",
    { v: 1, device_id: device.id, cols: 80, rows: 24 },
    auth,
  );
  const ws = new WebSocket(
    origin.replace("https:", "wss:") + "/api/v1/terminal/ws",
    { ca, headers: { origin } },
  );
  sockets.push(ws);
  const messages = [];
  ws.on("error", () => {});
  ws.on("message", (raw) => {
    const message = JSON.parse(raw);
    assertValid("terminal-envelope", message);
    messages.push(message);
  });
  await once(ws, "open");
  ws.send(
    JSON.stringify({
      v: 1,
      type: "terminal.attach",
      body: { session_id: created.session_id, ticket: created.ticket },
    }),
  );
  return {
    ws,
    messages,
    send: (text) =>
      ws.send(
        JSON.stringify({
          v: 1,
          type: "terminal.input",
          body: { data: Buffer.from(text).toString("base64") },
        }),
      ),
    ready: async () => {
      await until(
        () =>
          messages.some(
            (m) => m.type === "terminal.ready" || m.type === "terminal.closed",
          ),
        "real release PTY ready",
      );
      assert.ok(
        messages.some((m) => m.type === "terminal.ready"),
        JSON.stringify(messages),
      );
    },
  };
}
try {
  admin = (
    await api(
      "POST",
      "/login",
      { username: "admin", password: "accounts-e2e-login1" },
      "",
    )
  ).access_token;
  const enrollment = (
    await api("POST", "/enrollment-tokens", { v: 1, ttl_seconds: 600 })
  ).enrollment_token;
  const binary = process.env.FLEET_AGENT_BIN;
  assert.ok(binary, "Set FLEET_AGENT_BIN to the release package");
  const args = [
    "run",
    "--rm",
    "-d",
    "--name",
    container,
    "--user",
    "0",
    "--entrypoint",
    "bash",
    "--mount",
    `type=bind,source=${binary},target=/agent,readonly`,
    "--mount",
    `type=bind,source=${tls}/ca.crt,target=/ca.crt,readonly`,
  ];
  const env = {
    HOME: "/home/fleet",
    FLEET_SERVER_URL: `https://host.docker.internal:${port}`,
    FLEET_CA_CERT: "/ca.crt",
    FLEET_STATE_DIR: "/state",
    FLEET_ENROLLMENT_TOKEN: enrollment,
    FLEET_DEVICE_NAME: "release-limits-linux",
    FLEET_EXECUTION_BACKEND: "same-uid",
    FLEET_TERMINAL_ALLOW_PRIVILEGE_ESCALATION: "0",
    FLEET_HEARTBEAT_MS: "200",
  };
  for (const [key, value] of Object.entries(env))
    args.push("--env", `${key}=${value}`);
  args.push(
    process.env.FLEET_AGENT_DOCKER_IMAGE ?? "farhelm-agent-dev:local",
    "-c",
    "mkdir -p /state && chown fleet /state && exec runuser -u fleet -- /agent",
  );
  await docker(args);
  started = true;
  await until(async () => {
    device = (await api("GET", "/devices")).devices[0];
    return device?.control_online;
  }, "release Agent online");
  const role = (
    await api("POST", "/roles", {
      v: 1,
      name: "连接限额验证",
      description: "",
      permissions: ["devices.read", "terminal.connect"],
    })
  ).role;
  const user = (
    await api("POST", "/users", {
      v: 1,
      username: "connection-limits-e2e",
      password: "accounts-e2e-login1",
      enabled: true,
      role_ids: [role.id],
      group_ids: [],
      device_scope: [device.id],
    })
  ).user;
  const auth = (
    await api(
      "POST",
      "/login",
      { username: user.username, password: "accounts-e2e-login1" },
      "",
    )
  ).access_token;
  const { updated_at, ...original } = await api("GET", "/settings/connections");
  const settings = async (changes) => {
    const { updated_at, ...current } = await api(
      "GET",
      "/settings/connections",
    );
    return api("PUT", "/settings/connections", { ...current, ...changes });
  };
  const path = `/devices/${device.id}/terminal-limit`;
  const limit = async (value) => {
    const current = await api("GET", path);
    return api("PUT", path, {
      v: 1,
      revision: current.revision,
      limit: value,
    });
  };
  await settings({ per_user: 8, per_device: 2 });
  assert.equal((await api("GET", path)).effective_limit, 2);
  await limit(6);
  const terminals = [];
  for (let i = 0; i < 5; i++) {
    const t = await open(auth);
    await t.ready();
    terminals.push(t);
  }
  const c = new Client();
  clients.push(c);
  c.on("error", () => {});
  const ready = once(c, "ready");
  c.connect({
    host: "127.0.0.1",
    port: server.ssh.info().port,
    username: `${user.username}:${device.id}`,
    password: "accounts-e2e-login1",
    hostVerifier: (raw) =>
      "SHA256:" +
        require("node:crypto")
          .createHash("sha256")
          .update(raw)
          .digest("base64")
          .replace(/=+$/, "") ===
      server.ssh.info().fingerprint,
  });
  await ready;
  const channel = await new Promise((resolve, reject) =>
    c.shell({ term: "xterm", cols: 80, rows: 24 }, (error, stream) =>
      error ? reject(error) : resolve(stream),
    ),
  );
  let output = "";
  channel.on("data", (chunk) => (output += chunk.toString()));
  await until(() => output.includes("fleet@"), "sixth release PTY through SSH");
  const rejected = async () => {
    const r = await server.app.inject({
      method: "POST",
      url: "/api/v1/terminal-sessions",
      headers: { authorization: "Bearer " + auth },
      payload: { v: 1, device_id: device.id, cols: 80, rows: 24 },
    });
    assert.equal(r.statusCode, 429);
    assert.equal(r.json().error, "DEVICE_TERMINAL_LIMIT");
  };
  await rejected();
  await settings({ per_device: 1 });
  assert.equal((await api("GET", path)).effective_limit, 6);
  terminals[4].send("exit\r");
  await until(
    () => terminals[4].messages.some((m) => m.type === "terminal.closed"),
    "release capacity slot released",
  );
  const replacement = await open(auth);
  await replacement.ready();
  terminals.push(replacement);
  await limit(2);
  assert.equal(terminals[0].ws.readyState, WebSocket.OPEN);
  await rejected();
  for (const t of terminals.filter((_, i) => i !== 4)) {
    t.send("exit\r");
    await until(
      () => t.messages.some((m) => m.type === "terminal.closed"),
      "release PTY closed",
    );
  }
  channel.write("exit\r");
  await once(channel, "close");
  c.end();
  const inherited = await limit(null);
  assert.equal(inherited.source, "global");
  assert.equal(inherited.effective_limit, 1);
  const only = await open(auth);
  await only.ready();
  await rejected();
  only.send("exit\r");
  await until(
    () => only.messages.some((m) => m.type === "terminal.closed"),
    "inherited release PTY closed",
  );
  const { updated_at: ignored, ...current } = await api(
    "GET",
    "/settings/connections",
  );
  await api("PUT", "/settings/connections", {
    ...original,
    revision: current.revision,
  });
  assert.equal((await api("GET", path)).effective_limit, original.per_device);
  const runtime = server.store.db
    .prepare("SELECT arch,version,sha256 FROM agent_runtime WHERE device_id=?")
    .get(device.id);
  mkdirSync(join(root, ".test-output"), { recursive: true });
  const report = {
    passed: true,
    runtime,
    checks: {
      sixRealPtysWebAndSsh: true,
      seventhRejected: true,
      deviceOverrideAboveGlobalDefault: true,
      globalDefaultChanges: true,
      resetToInheritance: true,
      loweringKeepsExistingSessions: true,
    },
  };
  writeFileSync(
    join(root, ".test-output/terminal-limits-e2e.json"),
    JSON.stringify(report, null, 2) + "\n",
  );
  console.log(
    "Real release connection limits passed: five web + one SSH, independent override, global changes, live lowering and inheritance reset.",
  );
} catch (error) {
  if (started)
    console.error(
      await docker(["logs", container]).catch(() => "Agent log unavailable"),
    );
  throw error;
} finally {
  for (const ws of sockets) ws.terminate();
  for (const client of clients) client.destroy();
  await server.close();
  if (started) await docker(["rm", "-f", container]).catch(() => {});
}
