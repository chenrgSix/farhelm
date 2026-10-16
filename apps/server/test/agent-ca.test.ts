import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { setTimeout as delay } from "node:timers/promises";
import { Store } from "../src/store.js";
import { agentCASync } from "../src/agent-ca.js";
import { CertificateManager } from "../src/certificates.js";
import { buildServer } from "../src/server.js";
// @ts-ignore shared validator
import { assertValid } from "../../../tests/contracts/validate.mjs";
const fingerprint = "AB:".repeat(31) + "AB";
const draft = {
  v: 1,
  revision: 0,
  mode: "private",
  domain: "fleet.internal",
  email: "",
  enabled: false,
  tos_agreed: false,
};
function fixture() {
  const store = new Store(mkdtempSync(join(tmpdir(), "farhelm-ca-sync-")));
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
  store.db
    .prepare(
      "INSERT INTO certificate_settings(id,revision,domain,email,enabled,tos_agreed,updated_at,mode) VALUES(1,1,'fleet.internal','',0,0,1,'private')",
    )
    .run();
  const connections = new Map([
    ["online", true],
    ["legacy", false],
  ]);
  const frames: { id: string; type: string; body: any }[] = [];
  const adapter = (id: string) =>
    connections.has(id)
      ? {
          supported: connections.get(id)!,
          send: (type: string, body: unknown) => {
            frames.push({ id, type, body });
            return true;
          },
        }
      : undefined;
  const sync = agentCASync(store, adapter);
  for (const id of ["online", "offline"]) sync.remember(id, true, []);
  sync.remember("legacy", false, []);
  const target = {
    revision: 1,
    fingerprint,
    ca_pem: "public CA",
    proof_pem: "leaf certificate",
    server_name: "fleet.internal",
  };
  const snapshot = () => sync.snapshot(fingerprint, 1);
  const receipt = (
    frame: any,
    status = "applied",
    reason: string | null = null,
  ) => ({
    request_id: frame.request_id,
    revision: frame.revision,
    fingerprint: frame.fingerprint,
    status,
    reason,
  });
  return {
    store,
    connections,
    frames,
    sync,
    target,
    snapshot,
    receipt,
    adapter,
  };
}
test("CA rollout queues offline devices, blocks legacy agents, persists receipts and detects lost trust", () => {
  const f = fixture();
  try {
    f.sync.start(f.target, "admin");
    assert.equal(f.frames.length, 1);
    assert.deepEqual(
      f.snapshot().devices.map((d) => [d.name, d.status]),
      [
        ["legacy", "unsupported"],
        ["offline", "pending"],
        ["online", "checking"],
      ],
    );
    assertValid("agent-ca-sync", f.snapshot());
    assertValid("envelope", {
      v: 1,
      type: f.frames[0]!.type,
      body: f.frames[0]!.body,
    });
    assert.equal(f.sync.allReady(fingerprint), false);
    f.sync.result("online", f.receipt(f.frames[0]!.body));
    f.connections.delete("online");
    assert.equal(
      f.snapshot().devices.find((d) => d.name === "online")!.status,
      "ready",
      "durably confirmed offline devices remain ready",
    );
    f.connections.set("offline", true);
    f.sync.connected("offline");
    f.sync.result("offline", f.receipt(f.frames.at(-1)!.body));
    f.connections.set("legacy", true);
    f.sync.remember("legacy", true, []);
    f.sync.connected("legacy");
    f.sync.result("legacy", f.receipt(f.frames.at(-1)!.body));
    assert.equal(f.sync.allReady(fingerprint), true);
    const restarted = agentCASync(f.store, f.adapter);
    assert.equal(restarted.allReady(fingerprint), true);
    f.connections.set("online", true);
    restarted.remember("online", true, []);
    restarted.connected("online");
    assert.equal(
      restarted.allReady(fingerprint),
      false,
      "a restored/rolled back agent missing trust blocks cutover again",
    );
    assert.equal(f.frames.at(-1)!.id, "online");
    f.sync.result("online", f.receipt(f.frames.at(-1)!.body));
    f.sync.result(
      "online",
      f.receipt(f.frames.at(-1)!.body, "failed", "PERSIST_FAILED"),
    );
    assert.equal(
      f.sync.allReady(fingerprint),
      true,
      "late failure cannot undo confirmed success",
    );
  } finally {
    f.store.close();
  }
});
test("CA sync rejects malformed and stale receipts, retries timeouts, and stops superseded rollouts", () => {
  const f = fixture();
  try {
    assert.throws(() =>
      f.sync.remember("online", true, [fingerprint, fingerprint]),
    );
    f.sync.start(f.target, "admin");
    const first = f.frames[0]!.body;
    assert.throws(() =>
      f.sync.result("online", { ...f.receipt(first), private_key: "secret" }),
    );
    assert.throws(() => f.sync.result("online", f.receipt(first, "failed")));
    f.sync.result("online", { ...f.receipt(first), revision: 2 });
    assert.equal(
      f.snapshot().devices.find((d) => d.name === "online")!.status,
      "checking",
    );
    f.store.db
      .prepare("UPDATE agent_ca_sync SET updated_at=? WHERE device_id='online'")
      .run(Date.now() - 160000);
    f.sync.flush();
    assert.equal(
      f.snapshot().devices.find((d) => d.name === "online")!.reason,
      "TIMEOUT",
    );
    f.sync.start(f.target, "admin");
    const retry = f.frames.at(-1)!.body;
    assert.notEqual(first.request_id, retry.request_id);
    f.sync.result("online", f.receipt(first));
    assert.equal(f.sync.allReady(fingerprint), false);
    f.store.db.exec(
      "CREATE TRIGGER fail_ca_audit BEFORE INSERT ON audit WHEN NEW.action='certificate.agent_ca_synced' BEGIN SELECT RAISE(ABORT,'test'); END;",
    );
    assert.throws(() => f.sync.result("online", f.receipt(retry)));
    assert.equal(
      f.snapshot().devices.find((d) => d.name === "online")!.status,
      "checking",
    );
    f.store.db.exec("DROP TRIGGER fail_ca_audit");
    f.sync.result("online", f.receipt(retry));
    f.store.db.exec("UPDATE certificate_settings SET revision=2");
    f.connections.set("offline", true);
    const count = f.frames.length;
    f.sync.connected("offline");
    assert.equal(
      f.frames.length,
      count,
      "a changed settings revision requires a fresh proof",
    );
  } finally {
    f.store.close();
  }
});
const root = mkdtempSync(join(tmpdir(), "farhelm-ca-guard-"));
execFileSync("bash", ["../../deploy/dev/generate-tls.sh", join(root, "tls")], {
  stdio: "ignore",
});
test("CA activation requires all receipts, rechecks pending issuance and bypasses the barrier for same-CA renewals", async () => {
  const store = new Store(mkdtempSync(join(root, "data-")));
  const actor = store.seedUser({
    username: "admin",
    password: "test-ca-sync-password",
    role: "admin",
    deviceScope: "*",
  }).id;
  let ready = false,
    activated = 0,
    now = Date.now();
  const manager = new CertificateManager({
    store,
    privateAvailable: true,
    fallback: () => readFileSync(join(root, "tls/server.crt")),
    agentsReady: () => ready,
    now: () => now,
    activate: () => {
      activated++;
    },
  });
  try {
    await manager.start();
    manager.save(draft, actor);
    await manager.prepare({ v: 1, revision: 1 }, actor);
    assert.equal(manager.snapshot().activation_ready, false);
    assert.throws(
      () => manager.save({ ...draft, revision: 1, enabled: true }, actor),
      /AGENT_CA_SYNC_INCOMPLETE/,
    );
    const proof = await manager.trustProof(1);
    assert.equal(proof.server_name, draft.domain);
    assert.ok(!JSON.stringify(proof).includes("PRIVATE KEY"));
    await assert.rejects(
      () => manager.trustProof(2),
      /CERTIFICATE_REVISION_CONFLICT/,
    );
    ready = true;
    manager.save({ ...draft, revision: 1, enabled: true }, actor);
    ready = false;
    for (let i = 0; i < 200 && manager.snapshot().status !== "error"; i++)
      await delay(10);
    assert.equal(
      manager.snapshot().last_error?.code,
      "AGENT_CA_SYNC_INCOMPLETE",
    );
    assert.equal(
      activated,
      0,
      "new unprepared agent during signing prevents activation",
    );
    ready = true;
    now += 61000;
    await manager.tick();
    for (let i = 0; i < 200 && manager.snapshot().status !== "valid"; i++)
      await delay(10);
    assert.equal(manager.snapshot().status, "valid");
    assert.equal(activated, 1);
    ready = false;
    assert.equal(
      manager.snapshot().activation_ready,
      true,
      "the active CA is unchanged",
    );
    manager.save({ ...draft, revision: 2, enabled: true }, actor);
    assert.throws(
      () =>
        manager.save(
          { ...draft, revision: 2, domain: "another.internal", enabled: true },
          actor,
        ),
      /AGENT_CA_SYNC_INCOMPLETE/,
      "changing a bootstrap/retired hostname to the private CA needs its own readiness check",
    );
  } finally {
    await manager.close();
    store.close();
  }
});
test("CA sync APIs require an administrator and strict configuration revision", async () => {
  const server = await buildServer({
    dataDir: mkdtempSync(join(root, "api-")),
    tlsCert: join(root, "tls/server.crt"),
    tlsKey: join(root, "tls/server.key"),
    webDist: "../../apps/web/dist",
    adminUsername: "admin",
    adminPassword: "test-ca-sync-password",
  });
  try {
    const login = await server.app.inject({
      method: "POST",
      url: "/api/v1/login",
      payload: { username: "admin", password: "test-ca-sync-password" },
    });
    const headers = { authorization: `Bearer ${login.json().access_token}` };
    assert.equal(
      (
        await server.app.inject({
          url: "/api/v1/settings/certificate/agent-sync",
        })
      ).statusCode,
      401,
    );
    await server.app.inject({
      method: "PUT",
      url: "/api/v1/settings/certificate",
      headers,
      payload: draft,
    });
    await server.app.inject({
      method: "POST",
      url: "/api/v1/settings/certificate/ca",
      headers,
      payload: { v: 1, revision: 1 },
    });
    const send = (payload: unknown) =>
      server.app.inject({
        method: "POST",
        url: "/api/v1/settings/certificate/agent-sync",
        headers,
        payload,
      });
    assert.equal((await send({ v: 1, revision: 2 })).statusCode, 409);
    assert.equal(
      (await send({ v: 1, revision: 1, force: true })).statusCode,
      400,
    );
    const result = await send({ v: 1, revision: 1 });
    assert.equal(result.statusCode, 200, result.body);
    assertValid("agent-ca-sync", result.json());
    assert.equal(result.json().all_ready, true);
    server.store.seedUser({
      username: "viewer",
      password: "viewer-ca-sync-password",
      role: "auditor",
      deviceScope: "*",
    });
    const viewer = await server.app.inject({
      method: "POST",
      url: "/api/v1/login",
      payload: { username: "viewer", password: "viewer-ca-sync-password" },
    });
    for (const method of ["GET", "POST"] as const)
      assert.equal(
        (
          await server.app.inject({
            method,
            url: "/api/v1/settings/certificate/agent-sync",
            headers: { authorization: `Bearer ${viewer.json().access_token}` },
            ...(method === "POST" ? { payload: { v: 1, revision: 1 } } : {}),
          })
        ).statusCode,
        403,
      );
  } finally {
    await server.close();
  }
});
