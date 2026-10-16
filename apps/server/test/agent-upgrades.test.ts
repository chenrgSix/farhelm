import test from "node:test";
import assert from "node:assert/strict";
import Fastify from "fastify";
import { randomUUID } from "node:crypto";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { registerAgentReleases } from "../src/agent-releases.js";
import { Store } from "../src/store.js";
import {
  registerAgentUpgrades,
  type UpgradeInfo,
} from "../src/agent-upgrades.js";
import { fail, hash, ApiError } from "../src/util.js";
import type { User } from "../src/types.js";
function fixture() {
  const store = new Store(mkdtempSync(join(tmpdir(), "fleet-upgrades-"))),
    app = Fastify();
  const user = store.seedUser({
    username: "admin",
    password: "upgrade-test-password1",
    role: "admin",
    deviceScope: "*",
  });
  app.setErrorHandler((error, _req, reply) =>
    reply
      .code(error instanceof ApiError ? error.statusCode : 500)
      .send({ v: 1, error: error.message }),
  );
  const distDir = join(store.dataDir, "dist");
  mkdirSync(distDir);
  const bytes = Buffer.alloc(128);
  Buffer.from("7f454c460201", "hex").copy(bytes);
  bytes.writeUInt16LE(183, 18);
  const release = {
    arch: "aarch64",
    version: "0.2.1",
    sha256: hash(bytes),
    size: bytes.length,
  };
  writeFileSync(
    join(distDir, "farhelm-agent-linux-aarch64.json"),
    JSON.stringify({ ...release, upgrade_protocol: 1 }),
  );
  let artifact = { bytes, digest: release.sha256 };
  const frames: { id: string; type: string; body: any }[] = [],
    connections = new Map<string, UpgradeInfo>();
  const deps = {
    store,
    distDir,
    admin: (req: any) => {
      if (req.headers.authorization !== "admin") fail(403, "ADMIN_REQUIRED");
      return user as User;
    },
    deviceAuth: (req: any) => {
      if (!req.headers.authorization?.startsWith("device:"))
        fail(401, "UNAUTHORIZED");
      return { id: req.headers.authorization.slice(7) };
    },
    artifact: (arch: string) => (arch === "aarch64" ? artifact : undefined),
    agent: (id: string) =>
      connections.has(id)
        ? {
            info: connections.get(id),
            send: (type: string, body: unknown) => {
              frames.push({ id, type, body });
              return true;
            },
          }
        : undefined,
  };
  const releases = registerAgentReleases(app, deps);
  const upgradeDeps = { ...deps, releases };
  const upgrades = registerAgentUpgrades(app, upgradeDeps);
  for (const id of ["one", "two", "offline", "legacy", "ssh"]) {
    store.db
      .prepare(
        "INSERT INTO devices(id,public_key,name,created_at,connection_kind,agent_version) VALUES(?,?,?,1,?,?)",
      )
      .run(id, id, id, id === "ssh" ? "ssh" : "agent", "0.2.0");
    if (id !== "ssh" && id !== "legacy") {
      const info = upgrades.remember(
        id,
        "0.2.0",
        { arch: "aarch64", sha256: "a".repeat(64) },
        true,
      )!;
      if (id !== "offline") connections.set(id, info);
    }
  }
  const api = (
    method: "GET" | "POST",
    body?: any,
    authorization = "admin",
    url = "/api/v1/agent-upgrades",
  ) => app.inject({ method, url, payload: body, headers: { authorization } });
  const request = (ids = ["one", "two"], concurrency = 1) => ({
    v: 1,
    request_id: randomUUID(),
    concurrency,
    targets: ids.map((device_id) => ({ device_id, sha256: release.sha256 })),
  });
  const snapshot = async () => (await api("GET")).json();
  const close = async () => {
    await app.close();
    store.close();
  };
  return {
    store,
    app,
    upgrades,
    deps: upgradeDeps,
    connections,
    frames,
    release,
    bytes,
    distDir,
    api,
    request,
    snapshot,
    close,
    publish: (a: typeof artifact) => (artifact = a),
  };
}
test("admin-only batch validation is atomic, deduplicates retries and refuses legacy, SSH and downgrades", async () => {
  const f = fixture();
  try {
    assert.equal((await f.api("GET", undefined, "ops")).statusCode, 403);
    assert.equal((await f.api("POST", f.request(), "ops")).statusCode, 403);
    for (const ids of [
      ["one", "legacy"],
      ["one", "ssh"],
      ["one", "one"],
    ])
      assert.notEqual((await f.api("POST", f.request(ids))).statusCode, 200);
    assert.equal((await f.snapshot()).jobs.length, 0);
    const body = f.request();
    assert.equal((await f.api("POST", body)).statusCode, 200);
    assert.equal((await f.api("POST", body)).statusCode, 200);
    assert.equal((await f.snapshot()).jobs.length, 2);
    assert.equal(
      (await f.api("POST", { ...body, concurrency: 2 })).statusCode,
      409,
    );
    assert.equal((await f.api("POST", f.request(["one"]))).statusCode, 409);
    f.upgrades.remember(
      "offline",
      "9.0.0",
      { arch: "aarch64", sha256: "b".repeat(64) },
      true,
    );
    assert.equal((await f.api("POST", f.request(["offline"]))).statusCode, 409);
    assert.equal(
      (await f.api("POST", { ...f.request(), request_id: "-".repeat(36) }))
        .statusCode,
      400,
    );
  } finally {
    await f.close();
  }
});
test("concurrency, offline queue, durable replay and authenticated build confirmation", async () => {
  const f = fixture();
  try {
    const body = f.request(["one", "two", "offline"]);
    assert.equal((await f.api("POST", body)).statusCode, 200);
    assert.equal(f.frames.length, 1);
    f.upgrades.tick();
    assert.equal(f.frames.length, 1);
    const first = f.frames[0]!;
    assert.equal(f.upgrades.active(first.id), true);
    const receipt = {
      upgrade_id: first.body.upgrade_id,
      status: "SUCCEEDED",
      reason: null,
    };
    assert.throws(
      () => f.upgrades.result(first.id, receipt),
      /UPGRADE_BUILD_MISMATCH/,
    );
    f.upgrades.result(first.id, { ...receipt, status: "WAITING_IDLE" });
    f.upgrades.result(first.id, { ...receipt, status: "DOWNLOADING" });
    assert.equal(
      (await f.snapshot()).jobs.find((j: any) => j.id === receipt.upgrade_id)
        .status,
      "WAITING_IDLE",
    );
    f.connections.get(first.id)!.sha256 = f.release.sha256;
    f.upgrades.result(first.id, receipt);
    f.upgrades.tick();
    assert.equal(f.frames.length, 2);
    f.upgrades.result(first.id, {
      ...receipt,
      status: "FAILED",
      reason: "TRIAL_FAILED",
    });
    assert.equal(
      (await f.snapshot()).jobs.find((j: any) => j.id === receipt.upgrade_id)
        .status,
      "SUCCEEDED",
    );
    const second = f.frames[1]!;
    f.upgrades.result(second.id, {
      upgrade_id: second.body.upgrade_id,
      status: "FAILED",
      reason: "DOWNLOAD_FAILED",
    });
    f.upgrades.tick();
    assert.equal(f.frames.length, 2);
    // A fresh controller after a server restart can resume the persisted offline job.
    const app = Fastify(),
      restarted = registerAgentUpgrades(app, f.deps);
    try {
      const info = restarted.remember(
        "offline",
        "0.2.0",
        { arch: "aarch64", sha256: "a".repeat(64) },
        true,
      )!;
      f.connections.set("offline", info);
      restarted.tick();
      assert.equal(f.frames.length, 3);
      assert.equal(f.frames[2]!.id, "offline");
      restarted.remember(
        "offline",
        "0.2.0",
        { arch: "aarch64", sha256: "a".repeat(64) },
        true,
      );
      restarted.tick();
      assert.equal(f.frames.length, 4);
      assert.equal(f.frames[3]!.body.upgrade_id, f.frames[2]!.body.upgrade_id);
    } finally {
      await app.close();
    }
  } finally {
    await f.close();
  }
});
test("pinned downloads are device-scoped, survive publication changes and reject corruption", async () => {
  const f = fixture();
  try {
    await f.api("POST", f.request(["one"]));
    const frame = f.frames[0]!,
      url = `/api/agent/upgrades/${frame.body.upgrade_id}/package`;
    assert.equal((await f.api("GET", undefined, "admin", url)).statusCode, 401);
    assert.equal(
      (await f.api("GET", undefined, "device:two", url)).statusCode,
      404,
    );
    f.publish({ bytes: Buffer.alloc(64), digest: "b".repeat(64) });
    const response = await f.api("GET", undefined, "device:one", url);
    assert.equal(response.statusCode, 200);
    assert.deepEqual(response.rawPayload, f.bytes);
    const path = join(
      f.store.dataDir,
      "objects",
      "agent-releases",
      f.release.sha256,
    );
    const corrupt = readFileSync(path);
    corrupt[100] = 1;
    writeFileSync(path, corrupt);
    assert.equal(
      (await f.api("GET", undefined, "device:one", url)).statusCode,
      409,
    );
  } finally {
    await f.close();
  }
});
test("audit failure rolls back batches, and uncertain outcomes stay blocked until an Agent confirms", async () => {
  const f = fixture();
  try {
    f.store.db.exec(
      "CREATE TRIGGER fail_upgrade_audit BEFORE INSERT ON audit WHEN NEW.action='agent.upgrade_requested' BEGIN SELECT RAISE(ABORT,'test'); END;",
    );
    assert.equal((await f.api("POST", f.request(["one"]))).statusCode, 500);
    assert.equal((await f.snapshot()).jobs.length, 0);
    f.store.db.exec("DROP TRIGGER fail_upgrade_audit");
    await f.api("POST", f.request(["one"]));
    const frame = f.frames[0]!;
    f.store.db
      .prepare("UPDATE agent_upgrades SET updated_at=?")
      .run(Date.now() - 181000);
    f.upgrades.tick();
    assert.equal((await f.snapshot()).jobs[0].status, "UNKNOWN");
    assert.equal(f.upgrades.active("one"), true);
    f.upgrades.result("one", {
      upgrade_id: frame.body.upgrade_id,
      status: "FAILED",
      reason: "TRIAL_FAILED",
    });
    assert.equal(f.upgrades.active("one"), false);
    await f.api("POST", f.request(["offline"]));
    f.store.db
      .prepare(
        "UPDATE agent_upgrades SET created_at=? WHERE device_id='offline'",
      )
      .run(Date.now() - 86400001);
    f.upgrades.tick();
    assert.equal(
      (await f.snapshot()).jobs.find((j: any) => j.device_id === "offline")
        .reason,
      "BUSY_EXPIRED",
    );
  } finally {
    await f.close();
  }
});
