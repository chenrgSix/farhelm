import type { FastifyInstance, FastifyRequest } from "fastify";
import type { Store } from "./store.js";
import type { User } from "./types.js";
import {
  fail,
  integer,
  keys,
  object,
  str,
  version,
  type RateLimiter,
} from "./util.js";

type Row = {
  device_id: string;
  revision: number;
  desired_enabled: number | null;
  observed_revision: number | null;
  observed_enabled: number | null;
  blocked: number;
  status: string;
  reason: string | null;
  updated_at: number;
};
const reasons = [
  "ACTIVE_TERMINALS",
  "NO_NEW_PRIVS",
  "PERSIST_FAILED",
  "STALE_REVISION",
  "REVISION_CONFLICT",
];
export function registerTerminalPrivilege(
  app: FastifyInstance,
  d: {
    store: Store;
    admin(req: FastifyRequest): User;
    requireDevice(id: string): { connection_kind: string };
    availableStorage(): void;
    rate: RateLimiter;
    agent(id: string):
      | {
          supported: boolean;
          reported: boolean;
          send(type: string, body: unknown): boolean;
        }
      | undefined;
  },
) {
  const db = d.store.db,
    sent = new Map<string, number>();
  function row(id: string) {
    return db
      .prepare("SELECT * FROM agent_terminal_privilege WHERE device_id=?")
      .get(id) as Row | undefined;
  }
  function view(id: string) {
    const r = row(id),
      a = d.agent(id);
    const unconfirmed = !!a && (!a.supported || !a.reported);
    return {
      v: 1,
      device_id: id,
      revision: r?.revision ?? 0,
      enabled:
        unconfirmed || r?.observed_enabled == null
          ? null
          : !!r.observed_enabled,
      desired_enabled: r?.desired_enabled == null ? null : !!r.desired_enabled,
      online: !!a,
      supported: a?.supported ?? null,
      blocked: !!r?.blocked,
      status:
        unconfirmed && r?.status !== "pending"
          ? "unknown"
          : (r?.status ?? "unknown"),
      reason: r?.reason ?? null,
    };
  }
  function request(req: FastifyRequest) {
    const user = d.admin(req),
      id = str((req.params as any).id, 1, 128);
    if (d.requireDevice(id).connection_kind !== "agent")
      fail(409, "AGENT_REQUIRED");
    return { user, id };
  }
  function deliver(id: string) {
    const r = row(id),
      a = d.agent(id);
    if (
      !r ||
      r.status !== "pending" ||
      !a?.supported ||
      Date.now() - (sent.get(id) ?? 0) < 3000
    )
      return;
    if (
      a.send("agent.terminal.config", {
        revision: r.revision,
        enabled: !!r.desired_enabled,
      })
    )
      sent.set(id, Date.now());
  }
  app.get("/api/v1/devices/:id/terminal-privilege", async (req) =>
    view(request(req).id),
  );
  app.put("/api/v1/devices/:id/terminal-privilege", async (req) => {
    const { user, id } = request(req),
      b = object(req.body);
    version(b);
    keys(b, ["v", "revision", "enabled"]);
    const previous = row(id),
      revision = integer(b.revision, 0, Number.MAX_SAFE_INTEGER - 1);
    if (typeof b.enabled !== "boolean") fail(400, "INVALID_TERMINAL_PRIVILEGE");
    if (revision !== (previous?.revision ?? 0))
      fail(409, "TERMINAL_PRIVILEGE_CHANGED_RELOAD");
    const a = d.agent(id);
    if (!a) fail(409, "DEVICE_OFFLINE");
    if (!a.supported)
      fail(409, "TERMINAL_PRIVILEGE_NOT_SUPPORTED_UPDATE_AGENT");
    if (!a.reported || previous?.observed_enabled == null)
      fail(409, "TERMINAL_PRIVILEGE_STATUS_PENDING");
    if (b.enabled && previous.blocked)
      fail(409, "TERMINAL_PRIVILEGE_NO_NEW_PRIVS");
    if (
      db
        .prepare(
          "SELECT 1 FROM terminal_sessions WHERE device_id=? AND backend='agent' AND ended_at IS NULL",
        )
        .get(id)
    )
      fail(409, "CONNECTION_HAS_ACTIVE_SESSIONS");
    d.rate.check("terminal-privilege:" + user.id, 30);
    d.availableStorage();
    d.store.transaction(() => {
      db.prepare(
        "UPDATE agent_terminal_privilege SET revision=?,desired_enabled=?,status='pending',reason=NULL,updated_at=? WHERE device_id=?",
      ).run(revision + 1, Number(b.enabled), Date.now(), id);
      d.store.audit("terminal.privilege_requested", user.id, id, null, {
        revision: revision + 1,
        enabled: b.enabled,
        reason: null,
      });
    });
    sent.delete(id);
    deliver(id);
    return view(id);
  });
  function receive(id: string, value: unknown) {
    const b = object(value);
    keys(b, ["revision", "enabled", "request_revision", "blocked", "reason"]);
    const revision = integer(b.revision, 0, Number.MAX_SAFE_INTEGER),
      requested =
        b.request_revision === null
          ? null
          : integer(b.request_revision, 1, Number.MAX_SAFE_INTEGER);
    if (
      typeof b.enabled !== "boolean" ||
      typeof b.blocked !== "boolean" ||
      (b.blocked && b.enabled) ||
      (b.reason !== null && !reasons.includes(b.reason))
    )
      fail(400, "INVALID_TERMINAL_PRIVILEGE_STATUS");
    const old = row(id);
    if (
      old?.observed_revision != null &&
      revision < old.observed_revision &&
      requested !== null
    )
      return;
    // A restored platform learns the Agent's newer durable revision without replaying an older decision.
    const adopted = !old || revision > old.revision;
    const desired = adopted ? null : old.desired_enabled;
    const controlRevision = Math.max(revision, old?.revision ?? 0);
    let status = adopted || desired === null ? "applied" : old.status,
      reason = adopted || desired === null ? null : old.reason;
    if (desired !== null) {
      if (
        b.reason !== null &&
        (requested === controlRevision || revision === controlRevision)
      ) {
        status = "failed";
        reason = b.reason;
      } else if (
        revision === controlRevision &&
        Number(b.enabled) === desired &&
        b.reason === null
      ) {
        status = "applied";
        reason = null;
      } else if (requested === null) {
        status = "pending";
        reason = null;
      }
    }
    d.store.transaction(() => {
      db.prepare(
        "INSERT INTO agent_terminal_privilege(device_id,revision,desired_enabled,observed_revision,observed_enabled,blocked,status,reason,updated_at) VALUES(?,?,?,?,?,?,?,?,?) ON CONFLICT(device_id) DO UPDATE SET revision=excluded.revision,desired_enabled=excluded.desired_enabled,observed_revision=excluded.observed_revision,observed_enabled=excluded.observed_enabled,blocked=excluded.blocked,status=excluded.status,reason=excluded.reason,updated_at=excluded.updated_at",
      ).run(
        id,
        controlRevision,
        desired,
        revision,
        Number(b.enabled),
        Number(b.blocked),
        status,
        reason,
        Date.now(),
      );
      if (
        old &&
        desired !== null &&
        (old.status !== status || old.reason !== reason) &&
        ["applied", "failed"].includes(status)
      )
        d.store.audit("terminal.privilege_result", null, id, null, {
          revision: controlRevision,
          enabled: b.enabled,
          reason,
        });
    });
    deliver(id);
  }
  return {
    receive,
    flush() {
      for (const r of db
        .prepare(
          "SELECT device_id FROM agent_terminal_privilege WHERE status='pending'",
        )
        .all())
        deliver(r.device_id as string);
    },
    effective(id: string) {
      const r = row(id);
      return r?.desired_enabled === 0
        ? false
        : r?.observed_enabled == null
          ? undefined
          : !!r.observed_enabled;
    },
  };
}
