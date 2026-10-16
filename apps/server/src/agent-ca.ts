import type { FastifyInstance, FastifyRequest } from "fastify";
import { randomUUID } from "node:crypto";
import type { Store } from "./store.js";
import type { User } from "./types.js";
import type { CertificateManager } from "./certificates.js";
import { fail, integer, keys, object, str, version } from "./util.js";
type Target = {
  revision: number;
  fingerprint: string;
  ca_pem: string;
  proof_pem: string;
  server_name: string;
};
type Row = {
  device_id: string;
  revision: number;
  fingerprint: string;
  request_id: string;
  status: string;
  reason: string | null;
  updated_at: number;
};
const fingerprintPattern = /^(?:[0-9A-F]{2}:){31}[0-9A-F]{2}$/;
export function agentCASync(
  store: Store,
  agent: (
    id: string,
  ) =>
    | { supported: boolean; send(type: string, body: unknown): boolean }
    | undefined,
) {
  const { db } = store;
  function devices() {
    return db
      .prepare(
        "SELECT id,name FROM devices WHERE connection_kind='agent' AND revoked_at IS NULL ORDER BY name,id",
      )
      .all() as { id: string; name: string }[];
  }
  function capability(id: string) {
    const row = db
      .prepare("SELECT * FROM agent_ca_capabilities WHERE device_id=?")
      .get(id) as { supported: number; fingerprints_json: string } | undefined;
    return {
      supported: !!row?.supported,
      fingerprints: row ? (JSON.parse(row.fingerprints_json) as string[]) : [],
    };
  }
  function remember(id: string, supported: boolean, fingerprints: unknown) {
    const values = fingerprints ?? [];
    if (
      !Array.isArray(values) ||
      values.length > 16 ||
      values.some(
        (v) => typeof v !== "string" || !fingerprintPattern.test(v),
      ) ||
      new Set(values).size !== values.length
    )
      fail(400, "INVALID_TRUST_FINGERPRINTS");
    db.prepare(
      "INSERT INTO agent_ca_capabilities(device_id,supported,fingerprints_json,updated_at) VALUES(?,?,?,?) ON CONFLICT(device_id) DO UPDATE SET supported=excluded.supported,fingerprints_json=excluded.fingerprints_json,updated_at=excluded.updated_at",
    ).run(
      id,
      Number(supported),
      JSON.stringify(supported ? values : []),
      Date.now(),
    );
  }
  function ready(id: string, fingerprint: string) {
    return capability(id).fingerprints.includes(fingerprint);
  }
  function allReady(fingerprint: string) {
    return devices().every(({ id }) => ready(id, fingerprint));
  }
  function target() {
    return db.prepare("SELECT * FROM agent_ca_rollout WHERE id=1").get() as
      Target | undefined;
  }
  function row(id: string) {
    return db
      .prepare("SELECT * FROM agent_ca_sync WHERE device_id=?")
      .get(id) as Row | undefined;
  }
  function queue(t: Target, retry = false) {
    for (const { id } of devices()) {
      if (ready(id, t.fingerprint)) continue;
      const old = row(id);
      if (
        old?.revision === t.revision &&
        old.fingerprint === t.fingerprint &&
        (!retry || old.status === "checking")
      )
        continue;
      db.prepare(
        "INSERT INTO agent_ca_sync(device_id,revision,fingerprint,request_id,status,reason,updated_at) VALUES(?,?,?,?,'pending',NULL,?) ON CONFLICT(device_id) DO UPDATE SET revision=excluded.revision,fingerprint=excluded.fingerprint,request_id=excluded.request_id,status='pending',reason=NULL,updated_at=excluded.updated_at",
      ).run(id, t.revision, t.fingerprint, randomUUID(), Date.now());
    }
  }
  function start(t: Target, actor: string) {
    store.transaction(() => {
      db.prepare(
        "INSERT INTO agent_ca_rollout(id,revision,fingerprint,ca_pem,proof_pem,server_name) VALUES(1,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET revision=excluded.revision,fingerprint=excluded.fingerprint,ca_pem=excluded.ca_pem,proof_pem=excluded.proof_pem,server_name=excluded.server_name",
      ).run(t.revision, t.fingerprint, t.ca_pem, t.proof_pem, t.server_name);
      queue(t, true);
      store.audit("certificate.ca_sync_requested", actor, null, null, {
        revision: t.revision,
        fingerprint: t.fingerprint,
      });
    });
    flush();
  }
  function result(id: string, value: unknown) {
    const b = object(value);
    keys(b, ["request_id", "revision", "fingerprint", "status", "reason"]);
    const request = str(b.request_id, 36, 36),
      revision = integer(b.revision, 1, Number.MAX_SAFE_INTEGER),
      fingerprint = str(b.fingerprint, 95, 95);
    if (
      !fingerprintPattern.test(fingerprint) ||
      !["applied", "failed"].includes(b.status) ||
      (b.status === "failed"
        ? !["CERTIFICATE_INVALID", "PERSIST_FAILED", "CONFIG_FAILED"].includes(
            b.reason,
          )
        : b.reason !== null)
    )
      fail(400, "INVALID_TRUST_RESULT");
    const r = row(id);
    if (
      !r ||
      r.request_id !== request ||
      r.revision !== revision ||
      r.fingerprint !== fingerprint ||
      r.status === "applied"
    )
      return;
    store.transaction(() => {
      db.prepare(
        "UPDATE agent_ca_sync SET status=?,reason=?,updated_at=? WHERE device_id=?",
      ).run(b.status, b.reason, Date.now(), id);
      if (b.status === "applied") {
        const values = capability(id).fingerprints.filter(
          (f) => f !== fingerprint,
        );
        remember(id, true, [fingerprint, ...values].slice(0, 16));
      }
      store.audit("certificate.agent_ca_synced", null, id, null, {
        fingerprint,
        status: b.status,
        reason: b.reason,
      });
    });
  }
  function connected(id: string) {
    const t = target();
    if (!t) return;
    const r = row(id);
    if (r && !ready(id, t.fingerprint))
      db.prepare(
        "UPDATE agent_ca_sync SET status='pending',reason=NULL,updated_at=? WHERE device_id=?",
      ).run(Date.now(), id);
    queue(t);
    flush();
  }
  function flush() {
    const t = target();
    if (!t) return;
    const settings = db
      .prepare("SELECT mode,revision FROM certificate_settings WHERE id=1")
      .get() as { mode: string; revision: number } | undefined;
    if (settings?.mode !== "private" || settings.revision !== t.revision)
      return;
    for (const r of db
      .prepare(
        "SELECT s.* FROM agent_ca_sync s JOIN devices d ON d.id=s.device_id WHERE s.status IN ('pending','checking') AND d.connection_kind='agent' AND d.revoked_at IS NULL",
      )
      .all() as Row[]) {
      if (
        r.revision !== t.revision ||
        r.fingerprint !== t.fingerprint ||
        ready(r.device_id, t.fingerprint)
      )
        continue;
      const a = agent(r.device_id);
      if (!a) {
        if (r.status === "checking")
          db.prepare(
            "UPDATE agent_ca_sync SET status='pending',updated_at=? WHERE device_id=?",
          ).run(Date.now(), r.device_id);
        continue;
      }
      if (!a.supported) continue;
      if (r.status === "checking") {
        if (Date.now() - r.updated_at > 150000)
          db.prepare(
            "UPDATE agent_ca_sync SET status='failed',reason='TIMEOUT',updated_at=? WHERE device_id=?",
          ).run(Date.now(), r.device_id);
        continue;
      }
      const { id: _id, ...payload } = t as Target & { id?: number };
      if (
        a.send("agent.trust.update", { ...payload, request_id: r.request_id })
      )
        db.prepare(
          "UPDATE agent_ca_sync SET status='checking',reason=NULL,updated_at=? WHERE device_id=?",
        ).run(Date.now(), r.device_id);
    }
  }
  function snapshot(fingerprint: string | null, revision: number) {
    const rows = devices().map(({ id, name }) => {
      const c = capability(id),
        r = row(id),
        a = agent(id),
        done = !!fingerprint && ready(id, fingerprint);
      const matching =
        r?.fingerprint === fingerprint && r?.revision === revision;
      return {
        device_id: id,
        name,
        online: !!a,
        supported: c.supported,
        status: done
          ? "ready"
          : !c.supported
            ? "unsupported"
            : matching
              ? r!.status === "applied"
                ? "pending"
                : r!.status
              : "pending",
        reason: !done && matching ? r!.reason : null,
        updated_at: matching ? r!.updated_at : null,
      };
    });
    return {
      v: 1,
      revision,
      fingerprint,
      all_ready: !!fingerprint && rows.every((r) => r.status === "ready"),
      devices: rows,
    };
  }
  return { remember, allReady, start, result, connected, flush, snapshot };
}
export function registerAgentCASync(
  app: FastifyInstance,
  certificates: CertificateManager,
  sync: ReturnType<typeof agentCASync>,
  admin: (req: FastifyRequest) => User,
) {
  const snapshot = () => {
    const s = certificates.snapshot();
    return sync.snapshot(s.private_ca?.fingerprint ?? null, s.revision);
  };
  app.get("/api/v1/settings/certificate/agent-sync", async (req) => {
    admin(req);
    return snapshot();
  });
  app.post("/api/v1/settings/certificate/agent-sync", async (req) => {
    const user = admin(req),
      b = object(req.body);
    version(b);
    keys(b, ["v", "revision"]);
    const revision = integer(b.revision, 1, Number.MAX_SAFE_INTEGER);
    const proof = await certificates.trustProof(revision);
    sync.start(proof, user.id);
    return snapshot();
  });
}
