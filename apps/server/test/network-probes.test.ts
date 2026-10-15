import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { once } from "node:events";
import { WebSocket } from "ws";
import { buildServer } from "../src/server.js";
import { hash, token } from "../src/util.js";

test("network probe configs are scoped and versioned; offline evidence is immutable, replayable and never masquerades as fresh", async () => {
  const root = mkdtempSync(join(tmpdir(), "fleet-probes-"));
  execFileSync(
    "bash",
    ["../../deploy/dev/generate-tls.sh", join(root, "tls")],
    { stdio: "ignore" },
  );
  const cfg = {
    dataDir: join(root, "data"),
    tlsCert: join(root, "tls/server.crt"),
    tlsKey: join(root, "tls/server.key"),
    adminUsername: "admin",
    adminPassword: "network-probe-test-password",
  };
  let s = await buildServer(cfg);
  let ws: WebSocket | undefined;
  try {
    await s.app.listen({ host: "127.0.0.1", port: 0 });
    const db = s.store.db;
    db.prepare(
      "INSERT INTO devices(id,public_key,name,created_at) VALUES('device','key','probe-device',1)",
    ).run();
    async function login(username: string) {
      return (
        await s.app.inject({
          method: "POST",
          url: "/api/v1/login",
          payload: { username, password: cfg.adminPassword },
        })
      ).json().access_token;
    }
    let admin = await login("admin");
    async function api(method: "GET" | "PUT", body?: unknown, auth = admin) {
      return s.app.inject({
        method,
        url: "/api/v1/devices/device/network-probes",
        payload: body,
        headers: { authorization: "Bearer " + auth },
      });
    }
    for (const [name, role, scope] of [
      ["reader", "auditor", ["device"]],
      ["denied", "ops", []],
    ] as const)
      s.store.seedUser({
        username: name,
        password: cfg.adminPassword,
        role,
        deviceScope: [...scope],
      });
    const reader = await login("reader"),
      denied = await login("denied");
    const config = {
      revision: 0,
      enabled: true,
      interval_secs: 5,
      timeout_ms: 500,
      failure_threshold: 2,
      targets: ["tcp://127.0.0.1:80", "https://example.test/"],
    };
    assert.equal((await api("GET", undefined, denied)).statusCode, 403);
    assert.equal((await api("PUT", { v: 1, config }, reader)).statusCode, 403);
    assert.equal((await api("GET", undefined, reader)).statusCode, 200);
    for (const bad of [
      { ...config, targets: [config.targets[0]] },
      { ...config, interval_secs: 1 },
      { ...config, targets: ["https://u:p@host", config.targets[0]] },
      { ...config, targets: ["tcp://host:80/path", config.targets[0]] },
      { ...config, targets: [config.targets[0], config.targets[0]] },
    ])
      assert.equal((await api("PUT", { v: 1, config: bad })).statusCode, 400);
    assert.equal((await api("PUT", { v: 1, config })).statusCode, 200);
    assert.equal((await api("PUT", { v: 1, config })).statusCode, 409);
    assert.equal((await api("GET")).json().applied_revision, null);
    const access = token();
    db.prepare(
      "INSERT INTO device_tokens(token_hash,device_id,expires_at,scope) VALUES(?,'device',?,'agent-control-output')",
    ).run(hash(access), Date.now() + 60000);
    ws = new WebSocket(
      `wss://localhost:${(s.app.server.address() as any).port}/agent/ws`,
      {
        ca: readFileSync(join(root, "tls/ca.crt")),
        headers: { authorization: "Bearer " + access },
      },
    );
    const frames: any[] = [];
    ws.on("message", (raw) => frames.push(JSON.parse(raw.toString())));
    ws.on("error", () => {});
    await once(ws, "open");
    const send = (type: string, body: unknown) =>
      ws!.send(JSON.stringify({ v: 1, type, body }));
    const until = async (fn: () => boolean | Promise<boolean>) => {
      for (let i = 0; i < 150; i++) {
        if (await fn()) return;
        await new Promise((r) => setTimeout(r, 10));
      }
      throw Error("probe state did not converge");
    };
    async function frame(type: string, body: unknown, expected: string) {
      const offset = frames.length;
      send(type, body);
      await until(() => frames.length > offset);
      assert.equal(frames[offset].type, expected);
      return frames[offset].body;
    }
    send("agent.hello", {
      agent_version: "0.2.3",
      capabilities: ["agent.network.probes.v1"],
    });
    await until(() => frames.length === 1);
    assert.equal(frames[0].type, "agent.network.probe.config");
    assert.equal(frames[0].body.revision, 1);
    send("agent.network.probe.configured", { revision: 1 });
    await until(async () => (await api("GET")).json().applied_revision === 1);
    const report = {
      sample_id: randomUUID(),
      seq: 1,
      revision: 1,
      observed_at: Date.now(),
      platform_connected: false,
      status: "platform_unreachable",
      consecutive_failures: 0,
      results: config.targets.map((target, i) => ({
        target,
        reachable: true,
        reason: i ? "HTTP_RESPONSE" : "TCP_CONNECTED",
        duration_ms: 2,
      })),
    };
    await frame("agent.network.probe.event", report, "agent.network.probe.ack");
    await frame("agent.network.probe.event", report, "agent.network.probe.ack");
    assert.equal((await api("GET")).json().events.length, 1);
    assert.equal(
      (
        await frame(
          "agent.network.probe.event",
          { ...report, status: "suspected_offline" },
          "error",
        )
      ).code,
      "INVALID_NETWORK_PROBE_CLASSIFICATION",
    );
    assert.equal(
      (
        await frame(
          "agent.network.probe.event",
          { ...report, observed_at: report.observed_at + 1 },
          "error",
        )
      ).code,
      "NETWORK_PROBE_SAMPLE_CONFLICT",
    );
    const online = {
      ...report,
      sample_id: randomUUID(),
      seq: 10,
      platform_connected: true,
      status: "healthy",
    };
    send("agent.network.probe.latest", { report: online, age_ms: 12000 });
    await until(async () => (await api("GET")).json().result?.seq === 10);
    assert.equal((await api("GET")).json().result_fresh, false);
    send("agent.network.probe.latest", {
      report: { ...online, sample_id: randomUUID(), seq: 11 },
      age_ms: 1,
    });
    await until(async () => (await api("GET")).json().result_fresh);
    await frame(
      "agent.network.probe.event",
      { ...report, sample_id: randomUUID(), seq: 2 },
      "agent.network.probe.ack",
    );
    assert.equal((await api("GET")).json().result.seq, 11);
    const latest = (await api("GET")).json().result;
    assert.equal(
      (
        await frame(
          "agent.network.probe.event",
          { ...latest, observed_at: latest.observed_at + 1 },
          "error",
        )
      ).code,
      "NETWORK_PROBE_SAMPLE_CONFLICT",
    );
    assert.equal(
      (
        await api("PUT", {
          v: 1,
          config: { ...config, revision: 1, enabled: false },
        })
      ).statusCode,
      200,
    );
    await until(() =>
      frames.some(
        (f) => f.type === "agent.network.probe.config" && f.body.revision === 2,
      ),
    );
    assert.equal((await api("GET")).json().result_fresh, false);
    // Offline reports from a previous config retain the exact targets and remain acceptable.
    await frame(
      "agent.network.probe.event",
      { ...report, sample_id: randomUUID(), seq: 3 },
      "agent.network.probe.ack",
    );
    const audits = db
      .prepare("SELECT * FROM audit WHERE action='network.probes_configured'")
      .all();
    assert.equal(audits.length, 2);
    ws.terminate();
    await s.close();
    s = await buildServer(cfg);
    admin = await login("admin");
    const restored = (await api("GET")).json();
    assert.equal(restored.config.revision, 2);
    assert.equal(restored.events.length, 3);
    assert.equal(restored.result_fresh, false);
  } finally {
    ws?.terminate();
    await s.close();
  }
});
