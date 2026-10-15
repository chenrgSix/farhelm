import test from "node:test";
import assert from "node:assert/strict";
import {
  mkdtempSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
  rmSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { buildServer } from "../src/server.js";
import { hash } from "../src/util.js";
const root = mkdtempSync(join(tmpdir(), "fleet-releases-test-"));
execFileSync("bash", ["../../deploy/dev/generate-tls.sh", join(root, "tls")], {
  stdio: "ignore",
});
function artifact(
  version = "0.2.1",
  arch = "aarch64",
  byte = 1,
  size = 2 * 1024 * 1024,
) {
  const bytes = Buffer.alloc(size, byte);
  Buffer.from("7f454c460201", "hex").copy(bytes);
  bytes.writeUInt16LE(arch === "aarch64" ? 183 : 62, 18);
  return {
    bytes,
    manifest: { version, arch, size, sha256: hash(bytes), upgrade_protocol: 1 },
  };
}
async function fixture() {
  const dataDir = mkdtempSync(join(root, "data-")),
    distDir = join(dataDir, "empty-dist");
  mkdirSync(distDir);
  const config = {
    dataDir,
    tlsCert: join(root, "tls/server.crt"),
    tlsKey: join(root, "tls/server.key"),
    adminUsername: "admin",
    adminPassword: "release-test-password",
    agentInstall: {
      distDir,
      publicUrl: "https://fleet.example.com",
      caCert: join(root, "tls/ca.crt"),
    },
  };
  const server = await buildServer(config);
  const login = async (username: string) =>
    (
      await server.app.inject({
        method: "POST",
        url: "/api/v1/login",
        payload: { username, password: "release-test-password" },
      })
    ).json().access_token as string;
  const admin = await login("admin");
  server.store.seedUser({
    username: "ops",
    password: "release-test-password",
    role: "ops",
    deviceScope: "*",
  });
  const ops = await login("ops");
  const api = (
    method: "GET" | "PUT" | "POST",
    url: string,
    payload?: any,
    token = admin,
    headers: Record<string, string> = {},
  ) =>
    server.app.inject({
      method,
      url,
      payload,
      headers: { authorization: "Bearer " + token, ...headers },
    });
  const upload = (
    a: ReturnType<typeof artifact>,
    token = admin,
    manifest: any = a.manifest,
  ) =>
    api("PUT", "/api/v1/agent-releases/" + a.manifest.sha256, a.bytes, token, {
      "content-type": "application/octet-stream",
      "x-agent-manifest":
        typeof manifest === "string" ? manifest : JSON.stringify(manifest),
    });
  const list = async () =>
    (await api("GET", "/api/v1/agent-releases")).json().releases;
  return { ...server, config, api, upload, list, admin, ops };
}
test("admin upload accepts bounded binary larger than normal API bodies; retries, version conflicts and validation are safe", async () => {
  const f = await fixture();
  try {
    const a = artifact();
    assert.equal(
      (await f.api("GET", "/api/v1/agent-releases", undefined, f.ops))
        .statusCode,
      403,
    );
    assert.equal((await f.upload(a, f.ops)).statusCode, 403);
    assert.equal((await f.upload(a, f.admin, "{")).statusCode, 400);
    for (const fields of [
      { version: "../../a" },
      { arch: "x86_64" },
      { sha256: "a".repeat(64) },
      { size: a.bytes.length - 1 },
      { upgrade_protocol: 2 },
      { extra: 1 },
    ])
      assert.equal(
        (await f.upload(a, f.admin, { ...a.manifest, ...fields })).statusCode,
        400,
      );
    const invalid = { ...a, bytes: Buffer.from(a.bytes) };
    invalid.bytes[100] = 0;
    assert.equal((await f.upload(invalid)).statusCode, 400);
    assert.equal((await f.list()).length, 0);
    const saved = await f.upload(a);
    assert.equal(saved.statusCode, 200, saved.body);
    const { upgrade_protocol, ...fields } = a.manifest;
    assert.deepEqual(saved.json().release, {
      ...fields,
      enabled: true,
      source: "upload",
      created_at: saved.json().release.created_at,
    });
  } finally {
    await f.close();
  }
});
test("immutable versions survive restart; disable prevents new batches but preserves pinned downloads and old install commands", async () => {
  const f = await fixture();
  let closed = false;
  try {
    const old = artifact("0.2.1"),
      next = artifact("0.3.0", "aarch64", 2);
    assert.equal((await f.upload(old)).statusCode, 200);
    assert.equal((await f.upload(old)).statusCode, 200);
    assert.equal(
      (await f.upload(artifact("0.2.1", "aarch64", 3))).statusCode,
      409,
    );
    const install = (
      await f.api("POST", "/api/v1/agent-installations", {
        v: 1,
        name: "pin-test",
      })
    ).json();
    assert.ok(install.command);
    const row = f.store.db
      .prepare("SELECT config_json FROM agent_installations WHERE id=?")
      .get(install.id) as any;
    assert.equal(
      JSON.parse(row.config_json).artifacts.aarch64,
      old.manifest.sha256,
    );
    f.store.db
      .prepare(
        "INSERT INTO devices(id,name,public_key,created_at,connection_kind,agent_version) VALUES('device','device','key',1,'agent','0.2.0')",
      )
      .run();
    f.store.db
      .prepare(
        "INSERT INTO agent_runtime(device_id,arch,sha256,version,upgrade_supported,updated_at) VALUES('device','aarch64',?,'0.2.0',1,1)",
      )
      .run("b".repeat(64));
    const batch = {
      v: 1,
      request_id: randomUUID(),
      concurrency: 1,
      targets: [{ device_id: "device", sha256: old.manifest.sha256 }],
    };
    assert.equal(
      (await f.api("POST", "/api/v1/agent-upgrades", batch)).statusCode,
      200,
    );
    assert.equal((await f.upload(next)).statusCode, 200);
    assert.equal(
      (
        await f.api(
          "POST",
          "/api/v1/agent-releases/" + old.manifest.sha256,
          { v: 1, enabled: false },
          f.ops,
        )
      ).statusCode,
      403,
    );
    assert.equal(
      (
        await f.api("POST", "/api/v1/agent-releases/" + old.manifest.sha256, {
          v: 1,
          enabled: false,
        })
      ).statusCode,
      200,
    );
    // Same bytes retried must not reactivate an intentionally disabled release.
    assert.equal((await f.upload(old)).json().release.enabled, false);
    assert.deepEqual(
      (await f.api("GET", "/api/v1/agent-upgrades"))
        .json()
        .releases.map((r: any) => r.version),
      ["0.3.0"],
    );
    assert.equal(
      (
        await f.api("POST", "/api/v1/agent-upgrades", {
          ...batch,
          request_id: randomUUID(),
        })
      ).statusCode,
      409,
    );
    const job = f.store.db.prepare("SELECT * FROM agent_upgrades").get() as any;
    assert.equal(job.sha256, old.manifest.sha256);
    assert.deepEqual(
      readFileSync(
        join(f.config.dataDir, "objects/agent-releases", job.sha256),
      ),
      old.bytes,
    );
    const newInstall = (
      await f.api("POST", "/api/v1/agent-installations", {
        v: 1,
        name: "new-pin",
      })
    ).json();
    const c = f.store.db
      .prepare("SELECT config_json FROM agent_installations WHERE id=?")
      .get(newInstall.id) as any;
    assert.equal(
      JSON.parse(c.config_json).artifacts.aarch64,
      next.manifest.sha256,
    );
    const audit = f.store.db
      .prepare("SELECT action FROM audit WHERE action='agent.release_uploaded'")
      .all();
    assert.equal(audit.length, 2);
    await f.close();
    closed = true;
    const restarted = await buildServer(f.config);
    try {
      assert.equal(
        (
          restarted.store.db
            .prepare("SELECT COUNT(*) AS n FROM agent_releases")
            .get() as any
        ).n,
        2,
      );
      assert.equal(
        (
          restarted.store.db
            .prepare("SELECT enabled FROM agent_releases WHERE sha256=?")
            .get(old.manifest.sha256) as any
        ).enabled,
        0,
      );
    } finally {
      await restarted.close();
    }
  } finally {
    if (!closed) await f.close();
  }
});
test("failed audit publishes nothing; incomplete/corrupt objects can be safely retried without a second release", async () => {
  const f = await fixture();
  try {
    const a = artifact();
    f.store.db.exec(
      "CREATE TRIGGER reject_release BEFORE INSERT ON audit WHEN NEW.action='agent.release_uploaded' BEGIN SELECT RAISE(ABORT,'test'); END;",
    );
    assert.equal((await f.upload(a)).statusCode, 500);
    assert.equal((await f.list()).length, 0);
    f.store.db.exec("DROP TRIGGER reject_release");
    assert.equal((await f.upload(a)).statusCode, 200);
    const path = join(
      f.config.dataDir,
      "objects/agent-releases",
      a.manifest.sha256,
    );
    writeFileSync(path, "corrupt");
    assert.equal((await f.upload(a)).statusCode, 200);
    assert.equal(hash(readFileSync(path)), a.manifest.sha256);
    rmSync(path);
    assert.equal((await f.upload(a)).statusCode, 200);
    assert.equal((await f.list()).length, 1);
    assert.equal(
      (
        await f.api("POST", "/api/v1/agent-releases/" + a.manifest.sha256, {
          v: 1,
          enabled: false,
        })
      ).statusCode,
      200,
    );
    assert.equal(
      (
        await f.api("POST", "/api/v1/agent-releases/" + a.manifest.sha256, {
          v: 1,
          enabled: true,
        })
      ).statusCode,
      200,
    );
  } finally {
    await f.close();
  }
});
