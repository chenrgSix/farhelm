import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import Fastify from "fastify";
import websocket from "@fastify/websocket";
import { Store } from "../src/store.js";
import { ConnectionLimits } from "../src/connection-limits.js";
import { registerTerminals } from "../src/terminal.js";
import { RateLimiter } from "../src/util.js";
import { assertValid } from "../../../tests/contracts/validate.mjs";

async function fixture(t: any, resumable = true) {
  const dir = mkdtempSync(join(tmpdir(), "terminal-reconnect-"));
  const store = new Store(dir),
    app = Fastify();
  await app.register(websocket);
  const user = store.seedUser({
    username: "resume",
    password: "resume-fixture-password1",
    role: "admin",
    deviceScope: "*",
  });
  const device = randomUUID();
  store.db
    .prepare(
      "INSERT INTO devices(id,public_key,name,created_at) VALUES(?, 'key', 'resume', 1)",
    )
    .run(device);
  const limits = new ConnectionLimits(store);
  limits.acquire("ssh:login", user.id);
  const state = {
    online: true,
    allowed: true,
    resumeId: resumable ? randomUUID() : undefined,
    now: Date.now(),
    send: true,
  };
  t.mock.method(Date, "now", () => state.now);
  const requests: any[] = [],
    events: any[] = [];
  const manager = registerTerminals(app, {
    store,
    limits,
    rate: new RateLimiter(),
    operator: () => user,
    userAuth: () => user,
    credentialUser: () => (state.allowed ? user : undefined),
    requireScope: () => {},
    inScope: () => true,
    availableStorage: () => {},
    connections: {
      kind: () => "agent",
      hasSsh: () => false,
      open: () => {
        throw Error("unexpected SSH backend");
      },
    },
    agent: () =>
      state.online
        ? {
            terminal: true,
            policy: true,
            sudoEnabled: true,
            configurableDuration: true,
            resumeId: state.resumeId,
            send: (type, body) => {
              assertValid("terminal-envelope", { v: 1, type, body });
              requests.push({ type, body });
              return state.send;
            },
          }
        : undefined,
  });
  const session = manager.openSsh(user, "login", device, 80, 24, {
    send: (type, body) => {
      assertValid("terminal-envelope", { v: 1, type, body });
      events.push({ type, body });
      return true;
    },
    close: () => {},
    terminate: () => {},
  });
  const id = String(
    store.db.prepare("SELECT id FROM terminal_sessions").get()!.id,
  );
  const receive = (type: string, body = {}) =>
    manager.receive(device, type, { session_id: id, ...body });
  receive("terminal.opened");
  t.after(async () => {
    manager.close();
    await app.close();
    store.close();
    rmSync(dir, { recursive: true, force: true });
  });
  return {
    app,
    state,
    store,
    manager,
    requests,
    events,
    session,
    id,
    device,
    receive,
    closed: () => events.find((e) => e.type === "terminal.closed")?.body.reason,
    disconnect() {
      state.online = false;
      manager.disconnect(device);
    },
    reconnect() {
      state.online = true;
      manager.reconcile(device, state.resumeId!, [id]);
    },
    input(text: string) {
      session.input("terminal.input", {
        data: Buffer.from(text).toString("base64"),
      });
    },
  };
}

test("resume preserves recording, reconciles input acknowledgements and discards offline keystrokes", async (t) => {
  const f = await fixture(t);
  assert.equal(f.requests[0].body.reconnect_grace_ms, 60000);
  f.input("first\n");
  f.input("second\n");
  const data = Buffer.from("saved output\r\n").toString("base64");
  f.receive("terminal.output", { seq: 1, data });
  f.disconnect();
  f.input("must not execute\n");
  f.session.input("terminal.resize", { cols: 123, rows: 45 });
  f.state.now += 22000;
  f.manager.tick();
  assert.equal(f.closed(), undefined);
  assert.equal(
    f.events.filter((e) => e.type === "terminal.reconnecting").length,
    1,
  );
  f.reconnect();
  assert.deepEqual(f.requests.at(-1), {
    type: "terminal.resume",
    body: { session_id: f.id, seq: 1 },
  });
  // Agent accepted input 1 before the lost acknowledgement. Only input 2 is resent.
  f.receive("terminal.resumed", { input_seq: 1 });
  const input = f.requests.filter((e) => e.type === "terminal.input");
  assert.deepEqual(
    input.map((e) => e.body.seq),
    [1, 2, 2],
  );
  assert.equal(f.requests.at(-1).body.cols, 123);
  assert.equal(f.events.at(-1).type, "terminal.resumed");
  // An output replay with the same sequence must not create a second recording.
  f.receive("terminal.output", { seq: 1, data });
  assert.equal(f.events.filter((e) => e.type === "terminal.output").length, 1);
  f.receive("terminal.input_ack", { seq: 2 });
  f.input("third\n");
  assert.equal(f.requests.at(-1).body.seq, 3);
  assert.equal(f.closed(), undefined);
  const audit = f.store.db
    .prepare(
      "SELECT action,detail_json FROM audit WHERE action IN ('terminal.reconnecting','terminal.resumed') ORDER BY id",
    )
    .all();
  assert.deepEqual(
    audit.map((a) => a.action),
    ["terminal.reconnecting", "terminal.resumed"],
  );
  assert.equal(JSON.parse(String(audit[1].detail_json)).disconnected_ms, 22000);
});

test("resuming the original terminal does not consume new-session quota", async (t) => {
  const f = await fixture(t);
  for (let index = 1; index <= 20; index++) {
    f.disconnect();
    f.disconnect();
    f.state.now += 3_000;
    f.reconnect();
    f.receive("terminal.resumed", { input_seq: 0 });
  }
  assert.equal(f.closed(), undefined);
  f.input("still connected\n");
  assert.equal(f.requests.at(-1).type, "terminal.input");
  const opened = await f.app.inject({
    method: "POST",
    url: "/api/v1/terminal-sessions",
    headers: { authorization: "Bearer login" },
    payload: { v: 1, device_id: f.device, cols: 80, rows: 24 },
  });
  assert.equal(opened.statusCode, 200, opened.body);
});

test("repeated disconnects cannot extend the grace deadline", async (t) => {
  const f = await fixture(t);
  f.disconnect();
  f.state.now += 59000;
  f.disconnect();
  f.manager.tick();
  assert.equal(f.closed(), undefined);
  f.state.now += 1000;
  f.manager.tick();
  assert.equal(f.closed(), "AGENT_RECONNECT_TIMEOUT");
  assert.equal(
    f.events.filter((e) => e.type === "terminal.reconnecting").length,
    1,
  );
  f.reconnect();
  assert.equal(
    f.requests.at(-1).type,
    "terminal.close",
    "orphan shell must be closed",
  );
});

for (const mode of [
  "revoke",
  "restart",
  "lost",
  "legacy",
  "sequence",
  "corrupt-output",
  "duration",
] as const) {
  test(`recovery fails closed for ${mode}`, async (t) => {
    const f = await fixture(t, mode !== "legacy");
    if (mode === "corrupt-output")
      f.receive("terminal.output", { seq: 1, data: "YWJj" });
    if (mode === "duration") f.state.now += 3599000;
    f.disconnect();
    let reason: string;
    if (mode === "legacy") reason = "AGENT_DISCONNECTED";
    else if (mode === "revoke") {
      f.state.allowed = false;
      f.manager.tick();
      reason = "AUTHORIZATION_EXPIRED";
    } else if (mode === "restart") {
      f.state.resumeId = randomUUID();
      f.reconnect();
      reason = "AGENT_RESTARTED";
    } else if (mode === "lost") {
      f.state.online = true;
      f.manager.reconcile(f.device, f.state.resumeId!, []);
      reason = "AGENT_SESSION_LOST";
    } else if (mode === "duration") {
      // The reconnect window never overrides the terminal lifetime.
      f.state.now += 1000;
      f.manager.tick();
      reason = "SESSION_EXPIRED";
    } else {
      f.reconnect();
      f.receive("terminal.resumed", { input_seq: mode === "sequence" ? 1 : 0 });
      if (mode === "corrupt-output")
        f.receive("terminal.output", { seq: 1, data: "ZGlmZmVyZW50" });
      reason = "TERMINAL_RECORDING_FAILURE";
    }
    assert.equal(f.closed(), reason);
  });
}
