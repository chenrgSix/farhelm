import test from "node:test";
import assert from "node:assert/strict";
import Fastify from "fastify";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setImmediate as immediate } from "node:timers/promises";
import { Store } from "../src/store.js";
import { ApiError, fail, RateLimiter } from "../src/util.js";
import { registerDeviceDisks } from "../src/device-disks.js";
import { parseDiskUsage, validateDiskUsage } from "../src/disk-usage.js";
import { assertValid } from "../../../tests/contracts/validate.mjs";

const text = readFileSync(
  new URL("../../../tests/fixtures/disk-usage.txt", import.meta.url),
  "utf8",
);
const usage = {
  total_bytes: 3072000,
  used_bytes: 1536000,
  available_bytes: 1331200,
  filesystem_count: 2,
};
function fixture() {
  const root = mkdtempSync(join(tmpdir(), "farhelm-disk-"));
  const store = new Store(root),
    app = Fastify();
  const admin = store.seedUser({
    username: "admin",
    password: "disk-fixture-password1",
    role: "admin",
    deviceScope: "*",
  });
  let clock = 1000000000,
    scope = true,
    ssh = false,
    sshCalls = 0;
  for (let i = 0; i < 6; i++)
    store.db
      .prepare(
        "INSERT INTO devices(id,public_key,name,created_at) VALUES(?,?,?,1)",
      )
      .run("d" + i, "key" + i, "Device " + i);
  const frames: { id: string; body: any }[] = [];
  app.setErrorHandler((error, _req, reply) =>
    reply
      .code(error instanceof ApiError ? error.statusCode : 500)
      .send({ error: error.message }),
  );
  const disks = registerDeviceDisks(app, {
    store,
    rate: new RateLimiter(),
    now: () => clock,
    reader(req) {
      if (!req.headers.authorization) fail(401, "UNAUTHORIZED");
      return {
        ...admin,
        role: req.headers.authorization === "admin" ? "admin" : "ops",
      };
    },
    admin(req) {
      if (req.headers.authorization !== "admin") fail(403, "ADMIN_REQUIRED");
      return admin;
    },
    requireScope(user, id) {
      if (user.role !== "admin" && (!scope || id !== "d0"))
        fail(403, "DEVICE_SCOPE_DENIED");
    },
    requireDevice(id) {
      const row = store.db
        .prepare("SELECT revoked_at FROM devices WHERE id=?")
        .get(id);
      if (!row) fail(404, "DEVICE_NOT_FOUND");
      return row as any;
    },
    agent(id) {
      return ssh
        ? undefined
        : {
            connectionId: "connection",
            send(type, body) {
              assert.equal(type, "agent.disk.request");
              assertValid("envelope", { v: 1, type, body });
              frames.push({ id, body });
              return true;
            },
          };
    },
    async ssh() {
      sshCalls++;
      return text;
    },
  });
  const api = (method: string, id = "d0", body?: unknown, auth = "admin") =>
    app.inject({
      method: method as any,
      url:
        "/api/v1/devices/" +
        id +
        "/disk" +
        (method === "POST" ? "/collect" : method === "PUT" ? "/settings" : ""),
      headers: { authorization: auth },
      ...(body ? { payload: body } : {}),
    });
  async function waitFrames(n: number) {
    for (let i = 0; i < 100 && frames.length < n; i++) await immediate();
    assert.equal(frames.length, n);
  }
  function finish(i: number, error = false) {
    const frame = frames[i]!;
    disks.receive(frame.id, "connection", {
      request_id: frame.body.request_id,
      usage: error ? null : usage,
      error: error ? "DISK_COLLECTION_FAILED" : null,
    });
  }
  return {
    store,
    root,
    app,
    disks,
    api,
    frames,
    waitFrames,
    finish,
    advance(ms: number) {
      clock += ms;
    },
    deny() {
      scope = false;
    },
    useSsh() {
      ssh = true;
    },
    get sshCalls() {
      return sshCalls;
    },
    async close() {
      await app.close();
      store.close();
      rmSync(root, { recursive: true, force: true });
    },
  };
}

test("disk totals exclude duplicate, virtual and remote filesystems and reject impossible capacities", () => {
  assert.deepEqual(parseDiskUsage(text), usage);
  assert.throws(() => parseDiskUsage("header\ntmpfs tmpfs 100 20 80 20% /run"));
  assert.throws(() =>
    parseDiskUsage("header\n/dev/sda ext4 100 120 10 100% /"),
  );
  assert.throws(() =>
    validateDiskUsage({ ...usage, used_bytes: usage.total_bytes + 1 }),
  );
});

test("viewing cache is passive; concurrent viewers share one sample, enforce scope after waiting and reuse persisted results", async () => {
  const f = fixture();
  try {
    const initial = await f.api("GET");
    assertValid("device-disk-response", initial.json());
    assert.equal(initial.json().interval_hours, 24);
    assert.equal(initial.json().usage, null);
    f.disks.tick();
    assert.equal(f.frames.length, 0);
    const first = f.api("POST", "d0", { v: 1 }).then((r) => r),
      second = f.api("POST", "d0", { v: 1 }, "reader").then((r) => r);
    await f.waitFrames(1);
    f.disks.receive("d1", "connection", {
      request_id: f.frames[0]!.body.request_id,
      usage,
      error: null,
    });
    assert.equal((await f.api("GET")).json().usage, null);
    f.disks.receive("d0", "old-connection", {
      request_id: f.frames[0]!.body.request_id,
      usage,
      error: null,
    });
    assert.equal((await f.api("GET")).json().usage, null);
    f.deny();
    f.finish(0);
    assert.equal((await first).statusCode, 200);
    assert.equal((await second).statusCode, 403);
    const cached = await f.api("POST", "d0", { v: 1 });
    assert.equal(f.frames.length, 1);
    assert.deepEqual(cached.json().usage, usage);
    assertValid("device-disk-response", cached.json());
    await f.app.close();
    f.store.close();
    const restored = new Store(f.root);
    assert.deepEqual(
      JSON.parse(
        (
          restored.db
            .prepare("SELECT snapshot_json FROM device_disks WHERE device_id=?")
            .get("d0") as any
        ).snapshot_json,
      ),
      usage,
    );
    restored.close();
    rmSync(f.root, { recursive: true, force: true });
  } catch (error) {
    await f.close();
    throw error;
  }
});

test("collection concurrency is globally bounded and slots recover after failed samples", async () => {
  const f = fixture();
  try {
    const pending = Array.from({ length: 4 }, (_, i) =>
      f.api("POST", "d" + i, { v: 1 }).then((r) => r),
    );
    await f.waitFrames(4);
    assert.equal((await f.api("POST", "d4", { v: 1 })).statusCode, 429);
    for (let i = 0; i < 4; i++) f.finish(i, true);
    await Promise.all(pending);
    await f.api("POST", "d0", { v: 1 });
    assert.equal(
      f.frames.length,
      4,
      "failure cooldown must suppress repeated sampling",
    );
    f.advance(60001);
    const retry = f.api("POST", "d0", { v: 1 }).then((r) => r);
    await f.waitFrames(5);
    f.finish(4);
    assert.equal((await retry).json().last_error, null);
  } finally {
    await f.close();
  }
});

test("a failed refresh preserves the previous successful values and marks them stale", async () => {
  const f = fixture();
  try {
    const first = f.api("POST", "d0", { v: 1 }).then((r) => r);
    await f.waitFrames(1);
    f.finish(0);
    const saved = (await first).json();
    f.advance(5 * 60000 + 1);
    const retry = f.api("POST", "d0", { v: 1 }).then((r) => r);
    await f.waitFrames(2);
    f.finish(1, true);
    const failed = (await retry).json();
    assert.deepEqual(failed.usage, saved.usage);
    assert.equal(failed.checked_at, saved.checked_at);
    assert.equal(failed.stale, true);
    assert.equal(failed.last_error, "DISK_COLLECTION_FAILED");
    await f.api("POST", "d0", { v: 1 });
    assert.equal(f.frames.length, 2);
  } finally {
    await f.close();
  }
});

test("24-hour default and explicit intervals schedule only when due; readers cannot change plans, revoked devices never run", async () => {
  const f = fixture();
  try {
    assert.equal(
      (
        await f.api(
          "PUT",
          "d0",
          { v: 1, revision: 0, interval_hours: 2 },
          "reader",
        )
      ).statusCode,
      403,
    );
    assert.equal(
      (await f.api("PUT", "d0", { v: 1, revision: 0, interval_hours: 3 }))
        .statusCode,
      400,
    );
    for (const [revision, interval] of [24, 12, 8, 1, 2].entries()) {
      const result = await f.api("PUT", "d0", {
        v: 1,
        revision,
        interval_hours: interval,
      });
      assert.equal(result.statusCode, 200);
      assert.equal(result.json().interval_hours, interval);
    }
    assert.equal(
      (await f.api("PUT", "d0", { v: 1, revision: 0, interval_hours: 1 }))
        .statusCode,
      409,
    );
    f.disks.tick();
    f.advance(3600000);
    f.disks.tick();
    assert.equal(f.frames.length, 0);
    f.advance(3600000);
    f.disks.tick();
    await f.waitFrames(1);
    f.finish(0);
    await immediate();
    assert.equal((await f.api("GET")).json().stale, false);
    f.store.db.prepare("UPDATE devices SET revoked_at=1 WHERE id='d0'").run();
    f.advance(2 * 3600000);
    f.disks.tick();
    assert.equal(f.frames.length, 1);
    assert.equal((await f.api("POST", "d0", { v: 1 })).statusCode, 409);
  } finally {
    await f.close();
  }
});

test("SSH devices use the same shared cache and recollect only after expiration", async () => {
  const f = fixture();
  try {
    f.useSsh();
    assert.equal((await f.api("POST", "d0", { v: 1 })).statusCode, 200);
    assert.deepEqual((await f.api("GET")).json().usage, usage);
    await f.api("POST", "d0", { v: 1 });
    assert.equal(f.sshCalls, 1);
    f.advance(5 * 60000 + 1);
    await f.api("POST", "d0", { v: 1 });
    assert.equal(f.sshCalls, 2);
  } finally {
    await f.close();
  }
});
