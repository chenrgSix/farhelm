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

test("network observations are authenticated, scoped, validated, durable, idempotent and paginated", async () => {
  const root = mkdtempSync(join(tmpdir(), "fleet-network-"));
  execFileSync(
    "bash",
    ["../../deploy/dev/generate-tls.sh", join(root, "tls")],
    { stdio: "ignore" },
  );
  const config = {
    dataDir: join(root, "data"),
    tlsCert: join(root, "tls/server.crt"),
    tlsKey: join(root, "tls/server.key"),
    adminUsername: "admin",
    adminPassword: "network-test-password",
  };
  let server = await buildServer(config);
  let agent: WebSocket | undefined;
  try {
    await server.app.listen({ host: "127.0.0.1", port: 0 });
    const db = server.store.db;
    db.prepare(
      "INSERT INTO devices(id,public_key,name,created_at) VALUES('device','key','network-device',1)",
    ).run();
    db.prepare(
      "INSERT INTO devices(id,public_key,name,created_at) VALUES('other','key2','another-device',1)",
    ).run();
    async function login(username: string) {
      return (
        await server.app.inject({
          method: "POST",
          url: "/api/v1/login",
          payload: { username, password: config.adminPassword },
        })
      ).json().access_token;
    }
    let admin = await login("admin");
    async function get(path = "/devices/device/network", auth = admin) {
      return server.app.inject({
        method: "GET",
        url: "/api/v1" + path,
        headers: { authorization: "Bearer " + auth },
      });
    }
    server.store.seedUser({
      username: "auditor",
      password: config.adminPassword,
      role: "auditor",
      deviceScope: ["device"],
    });
    const reader = await login("auditor");
    assert.equal((await get(undefined, reader)).statusCode, 200);
    assert.equal((await get("/devices/other/network", reader)).statusCode, 403);
    assert.equal((await get(undefined, "bad")).statusCode, 401);
    assert.equal((await get()).json().snapshot, null);
    const access = token();
    db.prepare(
      "INSERT INTO device_tokens(token_hash,device_id,expires_at,scope) VALUES(?,'device',?,'agent-control-output')",
    ).run(hash(access), Date.now() + 60000);
    agent = new WebSocket(
      `wss://localhost:${(server.app.server.address() as any).port}/agent/ws`,
      {
        ca: readFileSync(join(root, "tls/ca.crt")),
        headers: { authorization: "Bearer " + access },
      },
    );
    const frames: any[] = [];
    agent.on("message", (raw) => frames.push(JSON.parse(raw.toString())));
    agent.on("error", () => {});
    await once(agent, "open");
    const send = (type: string, body: any) =>
      agent!.send(JSON.stringify({ v: 1, type, body }));
    const expectFrame = async (type: string, body: any, expected: string) => {
      const offset = frames.length;
      send(type, body);
      for (let i = 0; i < 150; i++) {
        if (frames.length > offset) break;
        await new Promise((r) => setTimeout(r, 10));
      }
      assert.equal(frames[offset]?.type, expected);
      return frames[offset]?.body;
    };
    const snapshot = {
      observed_at: 100,
      addresses: [
        { interface: "eth0", address: "10.2.3.4", family: "ipv4", up: true },
        { interface: "eth0", address: "fe80::1", family: "ipv6", up: true },
      ],
      truncated: false,
    };
    assert.equal(
      (await expectFrame("agent.network", snapshot, "error")).code,
      "NETWORK_HELLO_REQUIRED",
    );
    send("agent.hello", {
      agent_version: "0.2.2",
      capabilities: ["agent.network.v1"],
    });
    send("agent.network", snapshot);
    for (let i = 0; i < 100 && !(await get()).json().snapshot; i++)
      await new Promise((r) => setTimeout(r, 10));
    const data = (await get()).json();
    assert.equal(data.snapshot.addresses[0].address, "10.2.3.4");
    assert.equal(data.supported, true);
    assert.deepEqual((await get("/devices")).json().devices[0].ip_addresses, [
      "10.2.3.4",
      "fe80::1",
    ]);
    for (const invalid of [
      {
        ...snapshot,
        addresses: [{ ...snapshot.addresses[0], address: "999.2.3.4" }],
      },
      { ...snapshot, device_id: "other" },
      { ...snapshot, addresses: Array(129).fill(snapshot.addresses[0]) },
      {
        ...snapshot,
        addresses: [snapshot.addresses[0], snapshot.addresses[0]],
      },
    ])
      await expectFrame("agent.network", invalid, "error");
    const event = {
      event_id: randomUUID(),
      reason: "connection_lost",
      last_contact_at: 100,
      detected_at: 200,
      recovered_at: 300,
    };
    assert.deepEqual(
      await expectFrame("agent.network.event", event, "agent.network.ack"),
      { event_id: event.event_id },
    );
    await expectFrame("agent.network.event", event, "agent.network.ack");
    assert.equal((await get()).json().events.length, 1);
    assert.equal(
      (
        await expectFrame(
          "agent.network.event",
          { ...event, recovered_at: 350 },
          "error",
        )
      ).code,
      "NETWORK_EVENT_CONFLICT",
    );
    await expectFrame(
      "agent.network.event",
      { ...event, event_id: randomUUID(), recovered_at: 199 },
      "error",
    );
    await expectFrame(
      "agent.network.event",
      { ...event, device_id: "other" },
      "error",
    );
    assert.equal((await get("/devices/other/network")).json().events.length, 0);
    // Persisted ACK is safe even after reconnect/replay; pagination uses immutable sequence IDs.
    for (let i = 0; i < 51; i++)
      await expectFrame(
        "agent.network.event",
        { ...event, event_id: randomUUID() },
        "agent.network.ack",
      );
    const first = (await get()).json();
    assert.equal(first.events.length, 50);
    const second = (
      await get(`/devices/device/network?before=${first.next_before}`)
    ).json();
    assert.equal(second.events.length, 2);
    assert.equal(second.next_before, null);
    assert.equal(
      new Set([...first.events, ...second.events].map((e) => e.event_id)).size,
      52,
    );
    agent.terminate();
    await server.close();
    server = await buildServer(config);
    admin = await login("admin");
    const restored = (await get()).json();
    assert.equal(restored.device_online, false);
    assert.equal(restored.snapshot.observed_at, 100);
    assert.equal(restored.events.length, 50);
  } finally {
    agent?.terminate();
    await server.close();
  }
});
