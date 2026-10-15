import type { FastifyInstance, FastifyRequest } from "fastify";
import { randomUUID } from "node:crypto";
import {
  readFileSync,
  mkdirSync,
  writeFileSync,
  renameSync,
  existsSync,
  openSync,
  fsyncSync,
  closeSync,
} from "node:fs";
import { join } from "node:path";
import type { Store } from "./store.js";
import type { User } from "./types.js";
import {
  canonical,
  fail,
  hash,
  integer,
  keys,
  object,
  str,
  version,
} from "./util.js";
type Artifact = { bytes: Buffer; digest: string };
export type UpgradeInfo = {
  arch: string;
  sha256: string;
  version: string;
  supported: boolean;
};
type Job = {
  id: string;
  batch_id: string;
  device_id: string;
  arch: string;
  sha256: string;
  size: number;
  version: string;
  status: string;
  reason: string | null;
  created_at: number;
  updated_at: number;
};
const terminal = new Set(["SUCCEEDED", "FAILED"]);
const stages = [
  "DOWNLOADING",
  "WAITING_IDLE",
  "RESTARTING",
  "SUCCEEDED",
  "FAILED",
];
const reasons = [
  "DOWNLOAD_FAILED",
  "PACKAGE_INVALID",
  "PERSIST_FAILED",
  "TRIAL_FAILED",
  "BUSY_EXPIRED",
  "REVOKED",
  "PACKAGE_MISSING",
  "RESULT_UNCONFIRMED",
];
function digest(value: unknown) {
  const s = str(value, 64, 64);
  if (!/^[a-f0-9]{64}$/.test(s)) fail(400, "INVALID_SHA256");
  return s;
}
function releaseVersion(value: unknown) {
  const s = str(value, 1, 64);
  if (!/^\d{1,6}\.\d{1,6}\.\d{1,6}$/.test(s))
    fail(400, "INVALID_AGENT_VERSION");
  return s;
}
function older(next: string, current: string) {
  const a = next.split(".").map(Number),
    b = current.split(".").map(Number);
  for (let i = 0; i < 3; i++) {
    if (a[i] !== b[i]) return a[i]! < b[i]!;
  }
  return false;
}
export function registerAgentUpgrades(
  app: FastifyInstance,
  d: {
    store: Store;
    admin: (req: FastifyRequest) => User;
    deviceAuth: (req: FastifyRequest) => { id: string };
    distDir?: string;
    artifact: (arch: string) => Artifact | undefined;
    agent: (
      id: string,
    ) =>
      | { info?: UpgradeInfo; send(type: string, body: unknown): boolean }
      | undefined;
  },
) {
  const { db } = d.store,
    dir = join(d.store.dataDir, "objects", "agent-releases");
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const sent = new Set<string>();
  function releases() {
    return ["aarch64", "x86_64"].flatMap((arch) => {
      try {
        const f = d.artifact(arch);
        if (!f || !d.distDir) return [];
        const m = object(
          JSON.parse(
            readFileSync(
              join(d.distDir, `farhelm-agent-linux-${arch}.json`),
              "utf8",
            ),
          ),
        );
        keys(m, ["arch", "version", "upgrade_protocol", "sha256", "size"]);
        if (
          m.arch !== arch ||
          m.upgrade_protocol !== 1 ||
          m.sha256 !== f.digest ||
          m.size !== f.bytes.length
        )
          return [];
        return [
          {
            arch,
            version: releaseVersion(m.version),
            sha256: f.digest,
            size: f.bytes.length,
          },
        ];
      } catch {
        return [];
      }
    });
  }
  function jobs() {
    return db
      .prepare(
        "SELECT * FROM agent_upgrades ORDER BY created_at DESC,id LIMIT 500",
      )
      .all() as Job[];
  }
  function snapshot() {
    return {
      v: 1,
      releases: releases(),
      devices: (
        db
          .prepare(
            "SELECT d.id,d.name,d.agent_version,r.arch,r.sha256,r.upgrade_supported FROM devices d LEFT JOIN agent_runtime r ON r.device_id=d.id WHERE d.connection_kind='agent' AND d.revoked_at IS NULL ORDER BY d.name,d.id",
          )
          .all() as any[]
      ).map((row) => ({
        device_id: row.id,
        name: row.name,
        version: row.agent_version,
        arch: row.arch ?? null,
        sha256: row.sha256 ?? null,
        supported: !!row.upgrade_supported,
        online: !!d.agent(row.id),
      })),
      jobs: jobs(),
    };
  }
  function update(job: Job, status: string, reason: string | null) {
    if (job.status === status && job.reason === reason) return;
    d.store.transaction(() => {
      db.prepare(
        "UPDATE agent_upgrades SET status=?,reason=?,updated_at=? WHERE id=?",
      ).run(status, reason, Date.now(), job.id);
      d.store.audit("agent.upgrade_status", null, job.device_id, null, {
        upgrade_id: job.id,
        status,
        reason,
      });
    });
  }
  function remember(
    id: string,
    agentVersion: string,
    value: unknown,
    supported: boolean,
  ) {
    if (value === undefined) {
      db.prepare(
        "UPDATE agent_runtime SET upgrade_supported=0 WHERE device_id=?",
      ).run(id);
      return undefined;
    }
    const b = object(value);
    keys(b, ["arch", "sha256"]);
    const arch = str(b.arch, 1, 16);
    if (!["aarch64", "x86_64"].includes(arch)) fail(400, "INVALID_AGENT_ARCH");
    const info = {
      arch,
      sha256: digest(b.sha256),
      version: releaseVersion(agentVersion),
      supported,
    };
    db.prepare(
      "INSERT INTO agent_runtime(device_id,arch,sha256,version,upgrade_supported,updated_at) VALUES(?,?,?,?,?,?) ON CONFLICT(device_id) DO UPDATE SET arch=excluded.arch,sha256=excluded.sha256,version=excluded.version,upgrade_supported=excluded.upgrade_supported,updated_at=excluded.updated_at",
    ).run(id, arch, info.sha256, info.version, Number(supported), Date.now());
    for (const job of db
      .prepare(
        "SELECT * FROM agent_upgrades WHERE device_id=? AND status NOT IN ('SUCCEEDED','FAILED')",
      )
      .all(id) as Job[])
      sent.delete(job.id);
    return info;
  }
  function result(id: string, value: unknown) {
    const b = object(value);
    keys(b, ["upgrade_id", "status", "reason"]);
    const job = db
      .prepare("SELECT * FROM agent_upgrades WHERE id=? AND device_id=?")
      .get(str(b.upgrade_id, 36, 36), id) as Job | undefined;
    const status = str(b.status, 1, 32),
      reason = b.reason === null ? null : str(b.reason, 1, 64);
    if (
      !stages.includes(status) ||
      (status === "FAILED" ? !reasons.includes(reason ?? "") : reason !== null)
    )
      fail(400, "INVALID_UPGRADE_RESULT");
    if (!job || terminal.has(job.status)) return;
    if (status === "SUCCEEDED" && d.agent(id)?.info?.sha256 !== job.sha256)
      fail(409, "UPGRADE_BUILD_MISMATCH");
    if (
      status !== "FAILED" &&
      status !== "SUCCEEDED" &&
      job.status !== "UNKNOWN" &&
      stages.indexOf(status) < stages.indexOf(job.status)
    )
      return;
    update(job, status, reason);
  }
  function active(id: string) {
    return !!db
      .prepare(
        "SELECT 1 FROM agent_upgrades WHERE device_id=? AND status IN ('DOWNLOADING','WAITING_IDLE','RESTARTING','UNKNOWN')",
      )
      .get(id);
  }
  function tick() {
    const all = db
      .prepare(
        "SELECT j.*,b.concurrency,d.revoked_at FROM agent_upgrades j JOIN agent_upgrade_batches b ON b.id=j.batch_id JOIN devices d ON d.id=j.device_id WHERE j.status NOT IN ('SUCCEEDED','FAILED') ORDER BY j.created_at,j.id",
      )
      .all() as (Job & { concurrency: number; revoked_at: number | null })[];
    let running = all.filter((j) => j.status !== "QUEUED").length;
    for (const job of all) {
      if (job.revoked_at) {
        update(job, "FAILED", "REVOKED");
        continue;
      }
      if (
        Date.now() - job.created_at > 86400000 &&
        ["QUEUED", "WAITING_IDLE"].includes(job.status)
      ) {
        update(
          job,
          job.status === "QUEUED" ? "FAILED" : "UNKNOWN",
          job.status === "QUEUED" ? "BUSY_EXPIRED" : "RESULT_UNCONFIRMED",
        );
        continue;
      }
      if (
        ["DOWNLOADING", "RESTARTING"].includes(job.status) &&
        Date.now() - job.updated_at > 180000
      ) {
        update(job, "UNKNOWN", "RESULT_UNCONFIRMED");
        continue;
      }
      const a = d.agent(job.device_id);
      if (!a?.info?.supported || sent.has(job.id)) continue;
      if (job.status === "QUEUED") {
        const batchRunning = all.filter(
          (j) =>
            j.batch_id === job.batch_id &&
            j.status !== "QUEUED" &&
            !terminal.has(j.status),
        ).length;
        if (running >= 5 || batchRunning >= job.concurrency) continue;
        update(job, "DOWNLOADING", null);
        job.status = "DOWNLOADING";
        running++;
      }
      if (
        a.send("agent.upgrade", {
          upgrade_id: job.id,
          arch: job.arch,
          sha256: job.sha256,
          size: job.size,
          version: job.version,
        })
      )
        sent.add(job.id);
    }
  }
  app.get("/api/v1/agent-upgrades", async (req) => {
    d.admin(req);
    return snapshot();
  });
  app.post("/api/v1/agent-upgrades", async (req) => {
    const user = d.admin(req),
      b = object(req.body);
    version(b);
    keys(b, ["v", "request_id", "concurrency", "targets"]);
    const id = str(b.request_id, 36, 36);
    if (
      !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(
        id,
      )
    )
      fail(400, "INVALID_REQUEST_ID");
    const concurrency = integer(b.concurrency, 1, 5);
    if (
      !Array.isArray(b.targets) ||
      b.targets.length < 1 ||
      b.targets.length > 100
    )
      fail(400, "INVALID_UPGRADE_TARGETS");
    const targets = b.targets.map((v: unknown) => {
      const t = object(v);
      keys(t, ["device_id", "sha256"]);
      return { device_id: str(t.device_id, 1, 128), sha256: digest(t.sha256) };
    });
    if (new Set(targets.map((t) => t.device_id)).size !== targets.length)
      fail(400, "DUPLICATE_UPGRADE_TARGET");
    const request = canonical({ concurrency, targets }),
      existing = db
        .prepare("SELECT * FROM agent_upgrade_batches WHERE id=?")
        .get(id) as any;
    if (existing) {
      if (existing.actor_id !== user.id || existing.request_json !== request)
        fail(409, "IDEMPOTENCY_CONFLICT");
      return { v: 1, batch_id: id };
    }
    const available = releases();
    const prepared = targets.map((t) => {
      const runtime = db
        .prepare(
          "SELECT r.* FROM agent_runtime r JOIN devices d ON d.id=r.device_id WHERE d.id=? AND d.connection_kind='agent' AND d.revoked_at IS NULL",
        )
        .get(t.device_id) as any;
      if (!runtime?.upgrade_supported) fail(409, "AGENT_UPGRADE_NOT_SUPPORTED");
      const release = available.find(
        (r) => r.arch === runtime.arch && r.sha256 === t.sha256,
      );
      if (!release) fail(409, "AGENT_RELEASE_CHANGED");
      if (older(release.version, runtime.version))
        fail(409, "AGENT_DOWNGRADE_NOT_ALLOWED");
      if (
        db
          .prepare(
            "SELECT 1 FROM agent_upgrades WHERE device_id=? AND status NOT IN ('SUCCEEDED','FAILED')",
          )
          .get(t.device_id)
      )
        fail(409, "AGENT_UPGRADE_IN_PROGRESS");
      const file = d.artifact(release.arch);
      if (!file || file.digest !== release.sha256)
        fail(409, "AGENT_RELEASE_CHANGED");
      const path = join(dir, release.sha256);
      if (!existsSync(path)) {
        const temp = path + "." + randomUUID();
        writeFileSync(temp, file.bytes, { mode: 0o600, flag: "wx" });
        const fd = openSync(temp, "r");
        try {
          fsyncSync(fd);
        } finally {
          closeSync(fd);
        }
        renameSync(temp, path);
        const folder = openSync(dir, "r");
        try {
          fsyncSync(folder);
        } finally {
          closeSync(folder);
        }
      }
      return { ...release, device_id: t.device_id };
    });
    d.store.transaction(() => {
      const now = Date.now();
      db.prepare(
        "INSERT INTO agent_upgrade_batches(id,actor_id,request_json,concurrency,created_at) VALUES(?,?,?,?,?)",
      ).run(id, user.id, request, concurrency, now);
      for (const r of prepared) {
        const jobId = randomUUID();
        db.prepare(
          "INSERT INTO agent_upgrades(id,batch_id,device_id,arch,sha256,size,version,status,created_at,updated_at) VALUES(?,?,?,?,?,?,?,'QUEUED',?,?)",
        ).run(
          jobId,
          id,
          r.device_id,
          r.arch,
          r.sha256,
          r.size,
          r.version,
          now,
          now,
        );
        d.store.audit("agent.upgrade_requested", user.id, r.device_id, null, {
          upgrade_id: jobId,
          batch_id: id,
          version: r.version,
          sha256: r.sha256,
        });
      }
    });
    tick();
    return { v: 1, batch_id: id };
  });
  app.get<{ Params: { id: string } }>(
    "/api/agent/upgrades/:id/package",
    async (req, reply) => {
      const device = d.deviceAuth(req),
        job = db
          .prepare(
            "SELECT * FROM agent_upgrades WHERE id=? AND device_id=? AND status NOT IN ('SUCCEEDED','FAILED')",
          )
          .get(req.params.id, device.id) as Job | undefined;
      if (!job || Date.now() - job.created_at > 86400000)
        fail(404, "UPGRADE_NOT_FOUND");
      const bytes = readFileSync(join(dir, job.sha256));
      if (bytes.length !== job.size || hash(bytes) !== job.sha256)
        fail(409, "AGENT_PACKAGE_CHANGED");
      return reply.type("application/octet-stream").send(bytes);
    },
  );
  return { tick, remember, result, active };
}
