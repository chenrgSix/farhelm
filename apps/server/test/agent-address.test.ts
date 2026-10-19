import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Store } from "../src/store.js";
import { agentAddressSync } from "../src/agent-address.js";
function fixture() {
  const store = new Store(mkdtempSync(join(tmpdir(), "fleet-address-")));
  for (const id of ["online", "offline", "legacy", "ssh", "revoked"])
    store.db
      .prepare(
        "INSERT INTO devices(id,public_key,name,created_at,connection_kind,revoked_at) VALUES(?,?,?,1,?,?)",
      )
      .run(
        id,
        id,
        id,
        id === "ssh" ? "ssh" : "agent",
        id === "revoked" ? 1 : null,
      );
  const frames: { id: string; type: string; body: any }[] = [];
  const connections = new Map([
    ["online", true],
    ["legacy", false],
  ]);
  const managed = new Set<string>();
  const sync = agentAddressSync(
    store,
    (id) =>
      connections.has(id)
        ? {
            supported: connections.get(id)!,
            send: (type, body) => {
              frames.push({ id, type, body });
              return true;
            },
          }
        : undefined,
    (id) => managed.has(id),
  );
  const target = {
    revision: 1,
    platform_server_url: "https://new.example.com",
  };
  const snapshot = () => sync.snapshot(target).devices;
  return { store, sync, frames, connections, target, snapshot, managed };
}
test("device-specific install addresses survive first connection, global changes and retries", () => {
  const f = fixture();
  try {
    const localUrl = "https://192.168.1.100:8444";
    f.store.db
      .prepare("UPDATE devices SET agent_server_url=? WHERE id='online'")
      .run(localUrl);
    f.sync.connected("online", localUrl, f.target);
    assert.equal(f.frames[0]!.body.server_url, localUrl);
    assert.equal(
      f.snapshot().find((d) => d.device_id === "offline")!.server_url,
      f.target.platform_server_url,
    );
    const next = {
      revision: 2,
      platform_server_url: "https://changed.example.com",
    };
    f.sync.enqueue(next);
    f.sync.flush();
    assert.equal(f.frames[1]!.body.server_url, localUrl);
    const update = f.frames[1]!.body;
    f.sync.result("online", {
      request_id: update.request_id,
      revision: 2,
      status: "failed",
      reason: "PROBE_FAILED",
    });
    f.sync.enqueue(next, true);
    f.sync.flush();
    assert.equal(f.frames[2]!.body.server_url, localUrl);
    f.sync.connected("online", localUrl, next);
    assert.ok(f.frames.every((frame) => frame.body.server_url === localUrl));
    assert.equal(
      f.sync.snapshot(next).devices.find((d) => d.device_id === "offline")!
        .server_url,
      next.platform_server_url,
    );
  } finally {
    f.store.close();
  }
});
test("sync queues offline Agents, negotiates capabilities, excludes SSH/revoked devices and resumes after reconnect", () => {
  const f = fixture();
  try {
    f.sync.enqueue(f.target);
    f.sync.flush();
    assert.equal(f.frames.length, 1);
    assert.equal(f.frames[0]!.id, "online");
    assert.deepEqual(
      f.snapshot().map((d) => [d.name, d.status]),
      [
        ["legacy", "unsupported"],
        ["offline", "pending"],
        ["online", "checking"],
      ],
    );
    f.connections.set("offline", true);
    f.sync.connected("offline", "https://old.example.com", f.target);
    assert.equal(f.frames.length, 2);
    const update = f.frames[0]!.body;
    f.sync.result("online", {
      request_id: update.request_id,
      revision: 1,
      status: "saved",
      reason: null,
    });
    f.sync.connected("online", "https://new.example.com", f.target);
    assert.equal(
      f.snapshot().find((d) => d.name === "online")!.status,
      "checking",
      "a hello is not durable confirmation",
    );
    f.sync.result("online", {
      request_id: update.request_id,
      revision: 1,
      status: "applied",
      reason: null,
    });
    f.sync.result("online", {
      request_id: update.request_id,
      revision: 1,
      status: "failed",
      reason: "CONNECT_FAILED",
    });
    assert.equal(
      f.snapshot().find((d) => d.name === "online")!.status,
      "applied",
    );
    const count = f.frames.length;
    f.sync.flush();
    assert.equal(f.frames.length, count);
    f.connections.delete("offline");
    f.sync.flush();
    assert.equal(
      f.snapshot().find((d) => d.name === "offline")!.status,
      "pending",
      "disconnect during verification resumes on reconnect",
    );
  } finally {
    f.store.close();
  }
});
test("latest revision wins, retry uses a fresh request id, failures persist and audit commits atomically", () => {
  const f = fixture();
  try {
    f.sync.enqueue(f.target);
    f.sync.flush();
    const first = f.frames[0]!.body;
    const target = {
      ...f.target,
      revision: 2,
      platform_server_url: "https://latest.example.com",
    };
    f.sync.enqueue(target);
    f.sync.flush();
    const next = f.frames[1]!.body;
    f.sync.result("online", {
      request_id: first.request_id,
      revision: 1,
      status: "applied",
      reason: null,
    });
    assert.equal(
      f.sync.snapshot(target).devices.find((d) => d.name === "online")!.status,
      "checking",
    );
    f.sync.result("online", {
      request_id: next.request_id,
      revision: 2,
      status: "failed",
      reason: "PROBE_FAILED",
    });
    f.sync.connected("online", "https://old.example.com", target);
    assert.equal(
      f.frames.length,
      2,
      "failed attempts do not endlessly reconnect",
    );
    f.sync.enqueue(target, true);
    f.sync.flush();
    const retry = f.frames[2]!.body;
    assert.notEqual(retry.request_id, next.request_id);
    f.store.db.exec(
      "CREATE TRIGGER fail_sync_audit BEFORE INSERT ON audit WHEN NEW.action='settings.agent_sync' BEGIN SELECT RAISE(ABORT,'test'); END;",
    );
    assert.throws(() =>
      f.sync.result("online", {
        request_id: retry.request_id,
        revision: 2,
        status: "applied",
        reason: null,
      }),
    );
    assert.equal(
      f.sync.snapshot(target).devices.find((d) => d.name === "online")!.status,
      "checking",
    );
    f.store.db.exec("DROP TRIGGER fail_sync_audit");
    f.store.db
      .prepare(
        "UPDATE agent_address_sync SET updated_at=? WHERE device_id='online'",
      )
      .run(Date.now() - 46000);
    f.sync.flush();
    assert.equal(
      f.sync.snapshot(target).devices.find((d) => d.name === "online")!.reason,
      "TIMEOUT",
    );
    f.sync.result("online", {
      request_id: retry.request_id,
      revision: 2,
      status: "applied",
      reason: null,
    });
    assert.equal(
      f.sync.snapshot(target).devices.find((d) => d.name === "online")!.status,
      "applied",
      "late durable confirmation resolves uncertainty",
    );
  } finally {
    f.store.close();
  }
});

test("network-managed Agents retain online state, pause legacy updates and resume when policy is disabled", () => {
  const f = fixture();
  try {
    f.managed.add("online");
    f.managed.add("offline");
    f.sync.connected("online", "https://vpn.example.com", f.target);
    f.sync.flush();
    const online = f.snapshot().find((d) => d.device_id === "online")!;
    assert.equal(online.online, true);
    assert.equal(online.status, "network_managed");
    assert.equal(online.reason, null);
    assert.equal(
      f.snapshot().find((d) => d.device_id === "offline")!.online,
      false,
    );
    assert.equal(
      f.snapshot().find((d) => d.device_id === "offline")!.status,
      "network_managed",
    );
    assert.equal(f.frames.length, 0);
    f.managed.delete("online");
    f.sync.flush();
    assert.equal(f.frames.length, 1);
    assert.equal(
      f.snapshot().find((d) => d.device_id === "online")!.status,
      "checking",
    );
    f.managed.add("online");
    f.store.db
      .prepare(
        "UPDATE agent_address_sync SET updated_at=? WHERE device_id='online'",
      )
      .run(Date.now() - 46000);
    f.sync.flush();
    f.managed.delete("online");
    f.sync.flush();
    assert.equal(f.frames.length, 2);
    assert.equal(
      f.snapshot().find((d) => d.device_id === "online")!.reason,
      null,
    );
  } finally {
    f.store.close();
  }
});
