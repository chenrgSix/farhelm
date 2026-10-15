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

export interface HealthCheck {
  id: string;
  name: string;
  enabled: boolean;
  interval_secs: number;
  timeout_ms: number;
  failure_threshold: number;
  probe:
    | {
        kind: "http";
        url: string;
        expected_status: number;
        body_contains: string;
      }
    | { kind: "tcp"; host: string; port: number }
    | { kind: "systemd"; unit: string };
}
interface Snapshot {
  revision: number;
  checks: HealthCheck[];
}
interface Agent {
  supported: boolean;
  connectionId: string;
  send(type: string, body: unknown): boolean;
}
interface Dependencies {
  store: Store;
  userAuth(req: FastifyRequest): User;
  operator(req: FastifyRequest): User;
  requireScope(user: User, id: string): void;
  requireDevice(id: string): { revoked_at: number | null };
  availableStorage(): void;
  agent(id: string): Agent | undefined;
  rate: RateLimiter;
}
export function validateCheck(value: unknown): HealthCheck {
  const c = object(value);
  keys(c, [
    "id",
    "name",
    "enabled",
    "interval_secs",
    "timeout_ms",
    "failure_threshold",
    "probe",
  ]);
  const id = str(c.id, 36, 36);
  if (
    !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id)
  )
    fail(400, "INVALID_CHECK_ID");
  const name = str(c.name, 1, 80);
  if (!name.trim() || typeof c.enabled !== "boolean")
    fail(400, "INVALID_HEALTH_CHECK");
  const interval_secs = integer(c.interval_secs, 5, 3600);
  const timeout_ms = integer(
    c.timeout_ms,
    100,
    Math.min(30000, interval_secs * 1000),
  );
  const failure_threshold = integer(c.failure_threshold, 1, 10);
  const p = object(c.probe);
  let probe: HealthCheck["probe"];
  if (p.kind === "http") {
    keys(p, ["kind", "url", "expected_status", "body_contains"]);
    const url = str(p.url, 1, 2048);
    let parsed: URL;
    try {
      parsed = new URL(url);
    } catch {
      fail(400, "INVALID_HEALTH_URL");
    }
    if (
      !["http:", "https:"].includes(parsed.protocol) ||
      parsed.username ||
      parsed.password ||
      parsed.hash
    )
      fail(400, "INVALID_HEALTH_URL");
    probe = {
      kind: "http",
      url,
      expected_status: integer(p.expected_status, 100, 599),
      body_contains: str(p.body_contains, 0, 256),
    };
  } else if (p.kind === "tcp") {
    keys(p, ["kind", "host", "port"]);
    const host = str(p.host, 1, 253);
    if (!/^[a-zA-Z0-9.:[\]_-]+$/.test(host)) fail(400, "INVALID_HEALTH_HOST");
    probe = { kind: "tcp", host, port: integer(p.port, 1, 65535) };
  } else if (p.kind === "systemd") {
    keys(p, ["kind", "unit"]);
    const unit = str(p.unit, 1, 200);
    if (!/^[a-zA-Z0-9_][a-zA-Z0-9_.@-]*\.service$/.test(unit))
      fail(400, "INVALID_SYSTEMD_UNIT");
    probe = { kind: "systemd", unit };
  } else fail(400, "INVALID_HEALTH_PROBE");
  return {
    id,
    name,
    enabled: c.enabled,
    interval_secs,
    timeout_ms,
    failure_threshold,
    probe,
  };
}
export function registerHealth(app: FastifyInstance, d: Dependencies) {
  const db = d.store.db;
  function snapshot(id: string): Snapshot {
    const row = db
      .prepare(
        "SELECT revision,checks_json FROM health_configs WHERE device_id=?",
      )
      .get(id) as any;
    return row
      ? { revision: row.revision, checks: JSON.parse(row.checks_json) }
      : { revision: 0, checks: [] };
  }
  function checkView(id: string, c: HealthCheck, revision: number) {
    const row = db
      .prepare("SELECT * FROM health_results WHERE device_id=? AND check_id=?")
      .get(id, c.id) as any;
    const agent = d.agent(id);
    const fresh =
      !!row &&
      !!agent?.supported &&
      row.revision === revision &&
      row.connection_id === agent.connectionId &&
      Date.now() >= row.received_at &&
      Date.now() - row.received_at <=
        Math.max(15000, c.interval_secs * 2000 + c.timeout_ms);
    return {
      ...c,
      result: {
        status: !c.enabled
          ? "disabled"
          : !fresh || row.healthy === null
            ? "unknown"
            : row.healthy
              ? "healthy"
              : "unhealthy",
        last_checked_at: row?.received_at ?? null,
        duration_ms: row?.duration_ms ?? null,
        reason: !c.enabled
          ? "DISABLED"
          : !agent
            ? "DEVICE_OFFLINE"
            : !agent.supported
              ? "AGENT_UPDATE_REQUIRED"
              : !fresh
                ? "AWAITING_RESULT"
                : row.reason,
        consecutive_failures: fresh ? row.failures : 0,
      },
    };
  }
  function view(id: string) {
    const config = snapshot(id),
      agent = d.agent(id);
    return {
      v: 1,
      revision: config.revision,
      supported: !!agent?.supported,
      device_online: !!agent,
      checks: config.checks.map((c) => checkView(id, c, config.revision)),
    };
  }
  function device(req: FastifyRequest, editing = false) {
    const user = editing ? d.operator(req) : d.userAuth(req);
    const id = str((req.params as any).id, 1, 128);
    d.requireScope(user, id);
    const row = d.requireDevice(id);
    if (editing && row.revoked_at) fail(409, "DEVICE_REVOKED");
    return { user, id };
  }
  app.get("/api/v1/devices/:id/health-checks", async (req) =>
    view(device(req).id),
  );
  app.put("/api/v1/devices/:id/health-checks", async (req) => {
    const { id, user } = device(req, true),
      body = object(req.body);
    version(body);
    keys(body, ["v", "revision", "checks"]);
    const revision = integer(body.revision, 0, Number.MAX_SAFE_INTEGER - 1);
    if (!Array.isArray(body.checks) || body.checks.length > 8)
      fail(400, "HEALTH_CHECK_LIMIT");
    const checks = body.checks.map(validateCheck);
    if (new Set(checks.map((c) => c.id)).size !== checks.length)
      fail(400, "DUPLICATE_HEALTH_CHECK_ID");
    d.rate.check("health-config:" + user.id, 60);
    d.availableStorage();
    d.store.transaction(() => {
      if (snapshot(id).revision !== revision)
        fail(409, "HEALTH_CONFIG_CHANGED_RELOAD");
      db.prepare(
        "INSERT INTO health_configs(device_id,revision,checks_json,updated_at,actor_id) VALUES(?,?,?,?,?) ON CONFLICT(device_id) DO UPDATE SET revision=excluded.revision,checks_json=excluded.checks_json,updated_at=excluded.updated_at,actor_id=excluded.actor_id",
      ).run(id, revision + 1, JSON.stringify(checks), Date.now(), user.id);
      db.prepare("DELETE FROM health_results WHERE device_id=?").run(id);
      d.store.audit("health.configured", user.id, id, null, {
        revision: revision + 1,
        check_ids: checks.map((c) => c.id),
      });
    });
    const agent = d.agent(id);
    if (agent?.supported) agent.send("health.config", snapshot(id));
    return view(id);
  });
  app.post("/api/v1/devices/:id/health-checks/run", async (req) => {
    const { id, user } = device(req, true),
      body = object(req.body);
    version(body);
    keys(body, ["v", "revision"]);
    const revision = integer(body.revision, 0, Number.MAX_SAFE_INTEGER);
    const config = snapshot(id);
    if (revision !== config.revision) fail(409, "HEALTH_CONFIG_CHANGED_RELOAD");
    const agent = d.agent(id);
    if (!agent) fail(409, "DEVICE_OFFLINE");
    if (!agent.supported) fail(409, "HEALTH_NOT_SUPPORTED_UPDATE_AGENT");
    if (!config.checks.some((c) => c.enabled))
      fail(409, "NO_ENABLED_HEALTH_CHECKS");
    d.rate.check("health-run:" + id, 12);
    d.store.audit("health.run_requested", user.id, id, null, { revision });
    if (!agent.send("health.run", { revision })) fail(409, "DEVICE_OFFLINE");
    return { v: 1, ok: true };
  });
  return {
    snapshot,
    summary(id: string): boolean | null {
      const config = snapshot(id),
        enabled = config.checks.filter((c) => c.enabled);
      const states = enabled.map(
        (c) => checkView(id, c, config.revision).result.status,
      );
      if (states.includes("unhealthy")) return false;
      return states.length && states.every((s) => s === "healthy")
        ? true
        : null;
    },
    receive(id: string, value: unknown) {
      const b = object(value);
      keys(b, [
        "revision",
        "check_id",
        "seq",
        "healthy",
        "reason",
        "duration_ms",
      ]);
      const revision = integer(b.revision, 0, Number.MAX_SAFE_INTEGER),
        seq = integer(b.seq, 1, Number.MAX_SAFE_INTEGER),
        checkId = str(b.check_id, 36, 36);
      if (b.healthy !== null && typeof b.healthy !== "boolean")
        fail(400, "INVALID_HEALTH_RESULT");
      const reason = str(b.reason, 1, 64);
      if (!/^[A-Z0-9_]+$/.test(reason)) fail(400, "INVALID_HEALTH_REASON");
      const duration = integer(b.duration_ms, 0, 30000);
      const config = snapshot(id),
        check = config.checks.find((c) => c.id === checkId && c.enabled),
        agent = d.agent(id);
      if (revision !== config.revision || !check || !agent?.supported) return;
      const old = db
        .prepare(
          "SELECT * FROM health_results WHERE device_id=? AND check_id=?",
        )
        .get(id, checkId) as any;
      const sameConnection =
        old?.revision === revision && old.connection_id === agent.connectionId;
      if (sameConnection && seq <= old.seq) return;
      const current =
        sameConnection &&
        Date.now() - old.received_at <=
          Math.max(15000, check.interval_secs * 2000 + check.timeout_ms);
      const failures =
        b.healthy === false
          ? Math.min(10, (current ? old.failures : 0) + 1)
          : 0;
      const healthy =
        b.healthy === null
          ? null
          : b.healthy
            ? 1
            : failures >= check.failure_threshold
              ? 0
              : current
                ? old.healthy
                : null;
      db.prepare(
        "INSERT INTO health_results(device_id,check_id,revision,seq,connection_id,received_at,healthy,failures,reason,duration_ms) VALUES(?,?,?,?,?,?,?,?,?,?) ON CONFLICT(device_id,check_id) DO UPDATE SET revision=excluded.revision,seq=excluded.seq,connection_id=excluded.connection_id,received_at=excluded.received_at,healthy=excluded.healthy,failures=excluded.failures,reason=excluded.reason,duration_ms=excluded.duration_ms",
      ).run(
        id,
        checkId,
        revision,
        seq,
        agent.connectionId,
        Date.now(),
        healthy,
        failures,
        reason,
        duration,
      );
    },
  };
}
