import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { once } from "node:events";
import { WebSocket } from "ws";
import { randomUUID } from "node:crypto";
import { buildServer } from "../src/server.js";
import { hash, token } from "../src/util.js";
const root = mkdtempSync(join(tmpdir(), "fleet-health-"));
execFileSync("bash", ["../../deploy/dev/generate-tls.sh", join(root, "tls")], {
  stdio: "ignore",
});
async function fixture() {
  const config = {
    dataDir: mkdtempSync(join(root, "data-")),
    tlsCert: join(root, "tls/server.crt"),
    tlsKey: join(root, "tls/server.key"),
    adminUsername: "admin",
    adminPassword: "health-test-password",
  };
  const server = await buildServer(config);
  await server.app.listen({ host: "127.0.0.1", port: 0 });
  const url = `wss://localhost:${(server.app.server.address() as any).port}/agent/ws`;
  async function api(method: string, path: string, body?: any, auth = admin) {
    const response = await server.app.inject({
      method: method as any,
      url: "/api/v1" + path,
      payload: body,
      headers: { authorization: "Bearer " + auth },
    });
    return { status: response.statusCode, body: response.json() };
  }
  let admin = "";
  admin = (
    await api("POST", "/login", {
      username: "admin",
      password: "health-test-password",
    })
  ).body.access_token;
  server.store.db
    .prepare(
      "INSERT INTO devices(id,public_key,name,created_at) VALUES('device','key','health-device',1)",
    )
    .run();
  const access = token();
  server.store.db
    .prepare(
      "INSERT INTO device_tokens(token_hash,device_id,expires_at,scope) VALUES(?,'device',?,'agent-control-output')",
    )
    .run(hash(access), Date.now() + 60000);
  const frames: any[] = [],
    agents: WebSocket[] = [];
  async function connect(supported = true) {
    const agent = new WebSocket(url, {
      ca: readFileSync(join(root, "tls/ca.crt")),
      headers: { authorization: "Bearer " + access },
    });
    agents.push(agent);
    agent.on("error", () => {});
    agent.on("message", (raw) => frames.push(JSON.parse(raw.toString())));
    await once(agent, "open");
    agent.send(
      JSON.stringify({
        v: 1,
        type: "agent.hello",
        body: {
          agent_version: "test",
          capabilities: supported ? ["health.probes.v1"] : [],
        },
      }),
    );
    await until(
      async () => (await api("GET", "/devices")).body.devices[0].control_online,
    );
    return agent;
  }
  const agent = await connect();
  async function result(
    check: any,
    seq: number,
    healthy: boolean | null,
    revision = 1,
    sender = agent,
  ) {
    sender.send(
      JSON.stringify({
        v: 1,
        type: "health.result",
        body: {
          revision,
          check_id: check.id,
          seq,
          healthy,
          reason: healthy === true ? "OK" : "TCP_CONNECT_FAILED",
          duration_ms: 4,
        },
      }),
    );
    await new Promise((r) => setTimeout(r, 20));
  }
  async function role(
    name: string,
    scope: string[] | "*",
    role: "ops" | "business" | "auditor" = "ops",
  ) {
    server.store.seedUser({
      username: name,
      password: "health-test-password",
      role,
      deviceScope: scope,
    });
    return (
      await api("POST", "/login", {
        username: name,
        password: "health-test-password",
      })
    ).body.access_token;
  }
  return {
    ...server,
    config,
    api,
    admin,
    agent,
    connect,
    frames,
    result,
    role,
    close: async () => {
      for (const a of agents) a.terminate();
      await server.close();
    },
  };
}
async function until(condition: () => any) {
  for (let i = 0; i < 100; i++) {
    if (await condition()) return;
    await new Promise((r) => setTimeout(r, 10));
  }
  throw Error("Health state did not converge");
}
function check() {
  return {
    id: randomUUID(),
    name: "TCP service",
    enabled: true,
    interval_secs: 5,
    timeout_ms: 1000,
    failure_threshold: 2,
    probe: { kind: "tcp", host: "127.0.0.1", port: 8080 },
  };
}
test("health config is scoped, validated, versioned, auditable and dispatched only to a capable Agent", async () => {
  const f = await fixture();
  const path = "/devices/device/health-checks";
  try {
    const business = await f.role("business", "*", "business"),
      denied = await f.role("unscoped", []),
      ops = await f.role("ops", ["device"]);
    const c = check(),
      body = { v: 1, revision: 0, checks: [c] };
    assert.equal((await f.api("GET", path, undefined, business)).status, 200);
    assert.equal((await f.api("PUT", path, body, business)).status, 403);
    assert.equal((await f.api("GET", path, undefined, denied)).status, 403);
    assert.equal(
      (await f.api("PUT", path, { ...body, checks: [c, c] })).status,
      400,
    );
    assert.equal(
      (
        await f.api("PUT", path, {
          ...body,
          checks: [
            { ...c, probe: { kind: "systemd", unit: "nginx.service;touch x" } },
          ],
        })
      ).status,
      400,
    );
    assert.equal(
      (
        await f.api("PUT", path, {
          ...body,
          checks: [
            {
              ...c,
              probe: {
                kind: "http",
                url: "http://user:pass@localhost",
                expected_status: 200,
                body_contains: "",
              },
            },
          ],
        })
      ).status,
      400,
    );
    const saved = await f.api("PUT", path, body, ops);
    assert.equal(saved.status, 200);
    assert.equal(saved.body.revision, 1);
    assert.equal((await f.api("PUT", path, body)).status, 409);
    await until(() =>
      f.frames.some((m) => m.type === "health.config" && m.body.revision === 1),
    );
    assert.equal(
      (await f.api("POST", path + "/run", { v: 1, revision: 1 }, business))
        .status,
      403,
    );
    assert.equal(
      (await f.api("POST", path + "/run", { v: 1, revision: 1 }, ops)).status,
      200,
    );
    await until(() => f.frames.some((m) => m.type === "health.run"));
    const audit = (await f.api("GET", "/audit")).body.audit;
    assert.ok(audit.some((a: any) => a.action === "health.configured"));
    assert.ok(audit.some((a: any) => a.action === "health.run_requested"));
    await f.connect(false);
    await until(async () => !(await f.api("GET", path)).body.supported);
    assert.equal(
      (await f.api("POST", path + "/run", { v: 1, revision: 1 })).body.error,
      "HEALTH_NOT_SUPPORTED_UPDATE_AGENT",
    );
    assert.equal(
      (await f.api("GET", "/devices")).body.devices[0].business_healthy,
      null,
    );
  } finally {
    await f.close();
  }
});
test("health thresholds reject duplicate/stale reports, recover, expire, disable and reset on reconnect", async () => {
  const f = await fixture();
  const path = "/devices/device/health-checks",
    c = check();
  const summary = async () =>
    (await f.api("GET", "/devices")).body.devices[0].business_healthy;
  try {
    await f.api("PUT", path, { v: 1, revision: 0, checks: [c] });
    await f.result(c, 1, false);
    assert.equal(await summary(), null);
    await f.result(c, 1, false);
    assert.equal(
      (await f.api("GET", path)).body.checks[0].result.consecutive_failures,
      1,
    );
    await f.result(c, 2, false);
    assert.equal(await summary(), false);
    await f.result(c, 3, true);
    assert.equal(await summary(), true);
    await f.result(c, 2, false);
    assert.equal(await summary(), true);
    await f.result(c, 99, false, 0);
    assert.equal(await summary(), true);
    f.store.db
      .prepare(
        "UPDATE health_results SET received_at=? WHERE device_id='device'",
      )
      .run(Date.now() - 60000);
    assert.equal(await summary(), null);
    const agent = await f.connect();
    assert.equal(await summary(), null);
    await f.result(c, 1, true, 1, agent);
    assert.equal(await summary(), true);
    const disabled = await f.api("PUT", path, {
      v: 1,
      revision: 1,
      checks: [{ ...c, enabled: false }],
    });
    assert.equal(disabled.body.checks[0].result.status, "disabled");
    assert.equal(await summary(), null);
    await f.result(c, 2, true, 1, agent);
    assert.equal(await summary(), null);
    assert.equal(
      (await f.api("POST", path + "/run", { v: 1, revision: 2 })).body.error,
      "NO_ENABLED_HEALTH_CHECKS",
    );
    await f.api("PUT", path, { v: 1, revision: 2, checks: [] });
    assert.equal((await f.api("GET", path)).body.checks.length, 0);
  } finally {
    await f.close();
  }
});
test("health configuration survives server restart while old results remain unknown until a new Agent report", async () => {
  const f = await fixture(),
    c = check();
  try {
    assert.equal(
      (
        await f.api("PUT", "/devices/device/health-checks", {
          v: 1,
          revision: 0,
          checks: [c],
        })
      ).status,
      200,
    );
    await f.result(c, 1, true);
  } finally {
    await f.close();
  }
  const server = await buildServer(f.config);
  try {
    const login = await server.app.inject({
      method: "POST",
      url: "/api/v1/login",
      payload: { username: "admin", password: "health-test-password" },
    });
    const response = await server.app.inject({
      method: "GET",
      url: "/api/v1/devices/device/health-checks",
      headers: { authorization: "Bearer " + login.json().access_token },
    });
    const data = response.json();
    assert.equal(data.revision, 1);
    assert.equal(data.checks[0].id, c.id);
    assert.deepEqual(data.checks[0].probe, c.probe);
    assert.equal(data.device_online, false);
    assert.equal(data.checks[0].result.status, "unknown");
    assert.equal(data.checks[0].result.reason, "DEVICE_OFFLINE");
  } finally {
    await server.close();
  }
});
