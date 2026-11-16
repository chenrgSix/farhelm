import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Fastify from "fastify";
import websocket from "@fastify/websocket";
import { Store } from "../src/store.js";
import { ConnectionLimits } from "../src/connection-limits.js";
import { registerTerminals, type TerminalPeer } from "../src/terminal.js";
import { RateLimiter } from "../src/util.js";
import { assertValid } from "../../../tests/contracts/validate.mjs";

for (const backend of ["agent", "ssh"] as const) {
  test(`${backend} terminal duration is snapshotted, supports unlimited and preserves authorization and opening expiry`, async (t) => {
    const dir = mkdtempSync(join(tmpdir(), "terminal-duration-"));
    const store = new Store(dir);
    const app = Fastify();
    await app.register(websocket);
    const user = store.seedUser({
      username: "duration",
      password: "duration-fixture-password1",
      role: "admin",
      deviceScope: "*",
    });
    store.db
      .prepare(
        "INSERT INTO devices(id,public_key,name,created_at) VALUES('device','key','test',1)",
      )
      .run();
    const limits = new ConnectionLimits(store);
    limits.acquire("ssh:login", user.id);
    let allowed = true;
    let capability = true;
    let now = Date.now();
    t.mock.method(Date, "now", () => now);
    const requests: any[] = [];
    let sshReceive: ((type: string, body: any) => void) | undefined;
    const manager = registerTerminals(app, {
      store,
      limits,
      rate: new RateLimiter(),
      operator: () => user,
      userAuth: () => user,
      credentialUser: () => (allowed ? user : undefined),
      requireScope: () => {},
      inScope: () => true,
      availableStorage: () => {},
      connections: {
        kind: () => backend,
        hasSsh: () => backend === "ssh",
        open: (_id, _cols, _rows, receive) => {
          sshReceive = receive;
          return { send: () => true, close: () => {} };
        },
      },
      agent: () => ({
        terminal: true,
        policy: true,
        configurableDuration: capability,
        send: (type, body) => {
          requests.push({ type, body });
          return true;
        },
      }),
    });
    const set = (minutes: number) =>
      store.db
        .prepare(
          "UPDATE connection_limits SET terminal_max_minutes=? WHERE id=1",
        )
        .run(minutes);
    function open(ready = true) {
      const events: any[] = [];
      const peer: TerminalPeer = {
        send: (type, body) => {
          events.push({ type, body });
          return true;
        },
        close: () => {},
        terminate: () => {},
      };
      manager.openSsh(user, "login", "device", 80, 24, peer);
      const row = store.db
        .prepare("SELECT id FROM terminal_sessions ORDER BY rowid DESC LIMIT 1")
        .get()!;
      const id = String(row.id);
      if (ready) {
        if (backend === "agent")
          manager.receive("device", "terminal.opened", { session_id: id });
        else sshReceive!("terminal.opened", {});
      }
      return {
        id,
        events,
        closed: () =>
          events.find((e) => e.type === "terminal.closed")?.body.reason,
      };
    }
    try {
      set(1);
      const short = open();
      if (backend === "agent") {
        assert.equal(requests.at(-1).body.max_duration_ms, 60000);
        assertValid("terminal-envelope", { v: 1, ...requests.at(-1) });
      }
      set(120);
      const long = open();
      set(0);
      const unlimited = open();
      now += 60000;
      manager.tick();
      assert.equal(short.closed(), "SESSION_EXPIRED");
      assert.equal(long.closed(), undefined);
      now += 3600000;
      manager.tick();
      assert.equal(
        long.closed(),
        undefined,
        "configured terminal survives the previous one-hour cap",
      );
      assert.equal(unlimited.closed(), undefined);
      set(1);
      now += 3540000;
      manager.tick();
      assert.equal(long.closed(), "SESSION_EXPIRED");
      assert.equal(
        unlimited.closed(),
        undefined,
        "lowering settings does not shorten an existing session",
      );
      const opening = open(false);
      now += 30001;
      manager.tick();
      assert.equal(
        opening.closed(),
        "SESSION_EXPIRED",
        "unused tickets still expire",
      );
      allowed = false;
      manager.tick();
      assert.equal(unlimited.closed(), "AUTHORIZATION_EXPIRED");
      allowed = true;
      if (backend === "agent") {
        capability = false;
        for (const minutes of [0, 61]) {
          set(minutes);
          assert.throws(
            () => open(),
            /TERMINAL_DURATION_NOT_SUPPORTED_UPDATE_AGENT/,
          );
        }
        set(60);
        open();
        assert.equal(
          Object.hasOwn(requests.at(-1).body, "max_duration_ms"),
          false,
          "legacy Agent receives no new fields",
        );
      }
      const records = store.db
        .prepare("SELECT * FROM audit WHERE action='terminal.created'")
        .all();
      // The event records the original lifetime, even when global settings change.
      assert.ok(
        records.some(
          (r) => JSON.parse(String(r.detail_json)).max_duration_ms === 7200000,
        ),
      );
    } finally {
      manager.close();
      await app.close();
      store.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });
}
