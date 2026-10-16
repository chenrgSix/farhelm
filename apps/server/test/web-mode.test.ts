import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { once } from "node:events";
import { WebSocket } from "ws";
import { buildServer } from "../src/server.js";
import { runtimeConfig } from "../src/runtime-config.js";

const base = {
  FLEET_DEVICE_ACCESS: "ssh-only",
  FLEET_WEB_ENABLED: "1",
  FLEET_WEB_PROTOCOL: "http",
};
test("device access, web visibility and protocol are independent explicit settings", () => {
  const http = runtimeConfig({
    ...base,
    FLEET_TLS_CERT: "/unused",
    FLEET_TLS_KEY: "/unused",
    FLEET_CA_CERT: "/unused",
    FLEET_ACME_ENABLED: "1",
    FLEET_WEB_DIST: "/web",
  });
  assert.equal(http.localAdmin, false);
  assert.equal(http.tls, false);
  assert.equal(http.port, 8080);
  assert.equal(http.config.webDist, "/web");
  assert.equal(http.config.ssh?.port, 2222);
  assert.equal(http.config.tlsCert, undefined);
  assert.equal(http.config.agentInstall, undefined);
  assert.equal(http.config.acme, undefined);
  const off = runtimeConfig({
    ...base,
    FLEET_WEB_ENABLED: "0",
    FLEET_PORT: "unused",
    FLEET_WEB_DIST: "/unused",
  });
  assert.equal(off.localAdmin, true);
  assert.equal(off.config.webDist, undefined);
  assert.equal(off.port, undefined);
  const secure = runtimeConfig({
    ...base,
    FLEET_WEB_PROTOCOL: "https",
    FLEET_TLS_CERT: "cert",
    FLEET_TLS_KEY: "key",
  });
  assert.equal(secure.tls, true);
  assert.equal(secure.config.deviceAccess, "ssh-only");
  const agentWithoutWeb = runtimeConfig({
    FLEET_DEVICE_ACCESS: "agent-ssh",
    FLEET_WEB_ENABLED: "0",
    FLEET_TLS_CERT: "cert",
    FLEET_TLS_KEY: "key",
    FLEET_WEB_DIST: "/unused",
  });
  assert.equal(agentWithoutWeb.tls, true);
  assert.equal(agentWithoutWeb.localAdmin, false);
  assert.equal(agentWithoutWeb.config.webDist, undefined);
  assert.ok(agentWithoutWeb.config.agentInstall);
  assert.equal(
    runtimeConfig({ ...base, FLEET_MODE: "ssh-only" }).localAdmin,
    false,
  );
  for (const vars of [
    { FLEET_DEVICE_ACCESS: "bad" },
    { FLEET_WEB_ENABLED: "yes" },
    { FLEET_WEB_PROTOCOL: "ftp" },
    { FLEET_DEVICE_ACCESS: "agent-ssh" },
  ])
    assert.throws(() => runtimeConfig({ ...base, ...vars }));
  assert.throws(
    () => runtimeConfig({ ...base, FLEET_WEB_PROTOCOL: "https" }),
    /FLEET_TLS_CERT/,
  );
  assert.throws(
    () =>
      runtimeConfig({ ...base, FLEET_WEB_ENABLED: "0", FLEET_SSH_PORT: "0" }),
    /FLEET_SSH_PORT/,
  );
});

test(
  "HTTP management serves UI and keeps auth and origin checks without reading certificates or accepting Agents",
  { timeout: 15000 },
  async () => {
    const root = mkdtempSync(join(tmpdir(), "fh-http-")),
      dataDir = join(root, "data"),
      webDist = join(root, "web");
    mkdirSync(join(dataDir, "certificates"), { recursive: true });
    for (const name of ["active.json", "retired.json", "private-ca.json"])
      writeFileSync(join(dataDir, "certificates", name), "unused broken TLS");
    mkdirSync(webDist);
    writeFileSync(
      join(webDist, "index.html"),
      "<html>Farhelm HTTP management</html>",
    );
    const server = await buildServer({
      dataDir,
      deviceAccess: "ssh-only",
      webEnabled: true,
      webProtocol: "http",
      webDist,
      tlsCert: "/unused",
      tlsKey: "/unused",
      agentInstall: {
        publicUrl: "invalid",
        caCert: "/unused",
        distDir: "/unused",
      },
      adminUsername: "admin",
      adminPassword: "http-management-test-password1",
    });
    try {
      await server.app.listen({ host: "127.0.0.1", port: 0 });
      const origin = `http://127.0.0.1:${(server.app.server.address() as any).port}`;
      const page = await fetch(origin);
      assert.equal(page.status, 200);
      assert.match(await page.text(), /Farhelm/);
      assert.equal(page.headers.get("strict-transport-security"), null);
      for (const path of [
        "/api/v1/devices",
        "/api/v1/access",
        "/api/v1/terminal-sessions",
      ])
        assert.equal((await fetch(origin + path)).status, 401);
      const login = await server.app.inject({
        method: "POST",
        url: "/api/v1/login",
        payload: {
          username: "admin",
          password: "http-management-test-password1",
        },
      });
      assert.equal(login.statusCode, 200);
      const headers = { authorization: "Bearer " + login.json().access_token };
      const me = (
        await server.app.inject({ url: "/api/v1/me", headers })
      ).json();
      assert.deepEqual(me.runtime, {
        device_access: "ssh-only",
        web_enabled: true,
        web_protocol: "http",
      });
      for (const path of [
        "/api/v1/devices",
        "/api/v1/access",
        "/api/v1/terminal-sessions",
      ])
        assert.equal(
          (await server.app.inject({ url: path, headers })).statusCode,
          200,
        );
      assert.equal(
        (
          await server.app.inject({
            url: "/api/v1/settings/certificate",
            headers,
          })
        ).statusCode,
        404,
      );
      for (const path of [
        "/api/agent/challenge",
        "/api/agent/enroll",
        "/api/agent/auth",
        "/api/v1/enrollment-tokens",
        "/api/v1/agent-installations",
        "/api/v1/commands",
      ]) {
        const result = await server.app.inject({
          method: "POST",
          url: path,
          headers,
          payload: { v: 1 },
        });
        assert.equal(result.statusCode, 403, path);
        assert.equal(result.json().error, "AGENT_ACCESS_DISABLED");
      }
      const wsUrl = origin.replace("http:", "ws:") + "/api/v1/terminal/ws";
      for (const badOrigin of [
        "http://other.test",
        origin.replace("http:", "https:"),
      ]) {
        const ws = new WebSocket(wsUrl, { origin: badOrigin });
        await assert.rejects(once(ws, "open"), /403/);
        ws.terminate();
      }
      const ws = new WebSocket(wsUrl, { origin });
      await once(ws, "open");
      ws.close();
      await once(ws, "close");
      const agent = new WebSocket(origin.replace("http:", "ws:") + "/agent/ws");
      await assert.rejects(once(agent, "open"), /403/);
      agent.terminate();
      assert.equal(
        readFileSync(join(dataDir, "certificates/active.json"), "utf8"),
        "unused broken TLS",
      );
    } finally {
      await server.close();
    }
  },
);
