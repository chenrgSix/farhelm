import type { FastifyInstance, FastifyRequest } from "fastify";
import type { Store } from "./store.js";
import type { User } from "./types.js";
import {
  canonical,
  fail,
  integer,
  keys,
  object,
  str,
  version,
  type RateLimiter,
} from "./util.js";
export interface ProbeConfig {
  revision: number;
  enabled: boolean;
  interval_secs: number;
  timeout_ms: number;
  failure_threshold: number;
  targets: string[];
}
const defaults: ProbeConfig = {
  revision: 0,
  enabled: false,
  interval_secs: 30,
  timeout_ms: 3000,
  failure_threshold: 3,
  targets: [],
};
const MAX = Number.MAX_SAFE_INTEGER;
export function validateProbeConfig(value: unknown): ProbeConfig {
  const b = object(value);
  keys(b, [
    "revision",
    "enabled",
    "interval_secs",
    "timeout_ms",
    "failure_threshold",
    "targets",
  ]);
  const revision = integer(b.revision, 0, MAX),
    interval_secs = integer(b.interval_secs, 5, 3600),
    timeout_ms = integer(
      b.timeout_ms,
      100,
      Math.min(10000, interval_secs * 1000),
    ),
    failure_threshold = integer(b.failure_threshold, 1, 10);
  if (
    typeof b.enabled !== "boolean" ||
    !Array.isArray(b.targets) ||
    b.targets.length > 5 ||
    (b.enabled && b.targets.length < 2)
  )
    fail(400, "NETWORK_PROBES_REQUIRE_TWO_TO_FIVE_TARGETS");
  const seen = new Set();
  const targets = b.targets.map((value: unknown) => {
    const target = str(value, 1, 512);
    let u: URL;
    try {
      u = new URL(target);
    } catch {
      fail(400, "INVALID_NETWORK_PROBE_TARGET");
    }
    if (
      /[\s\x00-\x1f\x7f]/.test(target) ||
      !["http:", "https:", "tcp:"].includes(u.protocol) ||
      !u.hostname ||
      u.username ||
      u.password ||
      u.hash ||
      (u.protocol === "tcp:" &&
        (!u.port ||
          Number(u.port) < 1 ||
          !["", "/"].includes(u.pathname) ||
          u.search))
    )
      fail(400, "INVALID_NETWORK_PROBE_TARGET");
    if (seen.has(u.href)) fail(400, "DUPLICATE_NETWORK_PROBE_TARGET");
    seen.add(u.href);
    return target;
  });
  return {
    revision,
    enabled: b.enabled,
    interval_secs,
    timeout_ms,
    failure_threshold,
    targets,
  };
}
export function classifyProbe(
  platform: boolean,
  results: { reachable: boolean }[],
  failures: number,
  threshold: number,
) {
  const passed = results.filter((r) => r.reachable).length;
  if (!results.length) return "disabled";
  if (passed === results.length)
    return platform ? "healthy" : "platform_unreachable";
  if (passed) return "partial_unreachable";
  if (failures < threshold) return "checking";
  return platform ? "targets_unreachable" : "suspected_offline";
}
interface Agent {
  supported: boolean;
  connectionId: string;
  send(type: string, body: unknown): boolean;
}
export function registerNetworkProbes(
  app: FastifyInstance,
  d: {
    store: Store;
    userAuth(req: FastifyRequest): User;
    operator(req: FastifyRequest): User;
    requireScope(user: User, id: string): void;
    requireDevice(id: string): {
      connection_kind?: string;
      revoked_at: number | null;
    };
    agent(id: string): Agent | undefined;
    availableStorage(): void;
    rate: RateLimiter;
  },
) {
  const db = d.store.db;
  function config(id: string, revision?: number): ProbeConfig {
    if (revision === 0) return { ...defaults };
    const row = (
      revision === undefined
        ? db
            .prepare(
              "SELECT config FROM network_probe_configs WHERE device_id=? ORDER BY revision DESC LIMIT 1",
            )
            .get(id)
        : db
            .prepare(
              "SELECT config FROM network_probe_configs WHERE device_id=? AND revision=?",
            )
            .get(id, revision)
    ) as any;
    if (!row && revision !== undefined)
      fail(400, "UNKNOWN_NETWORK_PROBE_REVISION");
    return row ? JSON.parse(row.config) : { ...defaults };
  }
  function view(id: string, before = MAX) {
    const current = config(id),
      agent = d.agent(id),
      latest = db
        .prepare("SELECT * FROM network_probe_latest WHERE device_id=?")
        .get(id) as any;
    const applied = db
      .prepare("SELECT revision FROM network_probe_applied WHERE device_id=?")
      .get(id) as any;
    const report = latest ? JSON.parse(latest.report) : null;
    const fresh = !!(
      current.enabled &&
      agent?.supported &&
      latest &&
      latest.connection_id === agent.connectionId &&
      report.revision === current.revision &&
      report.platform_connected &&
      Date.now() >= latest.received_at &&
      Date.now() - latest.received_at + latest.age_ms <=
        current.interval_secs * 2000 + current.timeout_ms
    );
    const rows = db
      .prepare(
        "SELECT seq,report,received_at FROM network_probe_events WHERE device_id=? AND seq<? ORDER BY seq DESC LIMIT 51",
      )
      .all(id, before) as any[];
    return {
      v: 1,
      config: current,
      applied_revision: applied?.revision ?? null,
      supported: !!agent?.supported,
      device_online: !!agent,
      result: report,
      result_fresh: fresh,
      events: rows
        .slice(0, 50)
        .map((r) => ({ ...JSON.parse(r.report), received_at: r.received_at })),
      next_before: rows.length > 50 ? rows[49].seq : null,
    };
  }
  function device(req: FastifyRequest, edit = false) {
    const user = edit ? d.operator(req) : d.userAuth(req),
      id = str((req.params as any).id, 1, 128);
    d.requireScope(user, id);
    const row = d.requireDevice(id);
    if (row.connection_kind === "ssh") fail(409, "AGENT_REQUIRED");
    if (edit && row.revoked_at) fail(409, "DEVICE_REVOKED");
    return { id, user };
  }
  app.get("/api/v1/devices/:id/network-probes", async (req) => {
    const { id } = device(req),
      q = object(req.query);
    keys(q, ["before"]);
    const before =
      q.before === undefined
        ? MAX
        : integer(Number(str(q.before, 1, 16)), 1, MAX);
    return view(id, before);
  });
  app.put("/api/v1/devices/:id/network-probes", async (req) => {
    const { id, user } = device(req, true),
      b = object(req.body);
    keys(b, ["v", "config"]);
    version(b);
    const proposed = validateProbeConfig(b.config);
    integer(proposed.revision, 0, MAX - 1);
    d.rate.check("network-probe-config:" + user.id, 60);
    d.availableStorage();
    d.store.transaction(() => {
      if (config(id).revision !== proposed.revision)
        fail(409, "NETWORK_PROBE_CONFIG_CHANGED_RELOAD");
      proposed.revision++;
      db.prepare(
        "INSERT INTO network_probe_configs(device_id,revision,config,updated_at) VALUES(?,?,?,?)",
      ).run(id, proposed.revision, canonical(proposed), Date.now());
      d.store.audit("network.probes_configured", user.id, id, null, {
        revision: proposed.revision,
        enabled: proposed.enabled,
        target_count: proposed.targets.length,
        interval_secs: proposed.interval_secs,
      });
    });
    const agent = d.agent(id);
    if (agent?.supported) agent.send("agent.network.probe.config", proposed);
    return view(id);
  });
  function validateReport(id: string, value: unknown) {
    const b = object(value);
    keys(b, [
      "sample_id",
      "seq",
      "revision",
      "observed_at",
      "platform_connected",
      "status",
      "consecutive_failures",
      "results",
    ]);
    const sample = str(b.sample_id, 36, 36);
    if (
      !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(
        sample,
      )
    )
      fail(400, "INVALID_PROBE_SAMPLE_ID");
    integer(b.seq, 1, MAX);
    integer(b.observed_at, 1, MAX);
    const revision = integer(b.revision, 0, MAX),
      settings = config(id, revision),
      failures = integer(b.consecutive_failures, 0, 10);
    if (
      typeof b.platform_connected !== "boolean" ||
      !Array.isArray(b.results) ||
      b.results.length !== (settings.enabled ? settings.targets.length : 0)
    )
      fail(400, "INVALID_NETWORK_PROBE_RESULT");
    for (const [i, result] of b.results.entries()) {
      const r = object(result);
      keys(r, ["target", "reachable", "reason", "duration_ms"]);
      if (
        r.target !== settings.targets[i] ||
        typeof r.reachable !== "boolean" ||
        !(
          r.reachable
            ? ["TCP_CONNECTED", "HTTP_RESPONSE"]
            : ["CONNECT_FAILED", "HTTP_OR_TLS_FAILED", "TIMEOUT"]
        ).includes(r.reason)
      )
        fail(400, "INVALID_NETWORK_PROBE_RESULT");
      integer(r.duration_ms, 0, settings.timeout_ms);
    }
    if (
      b.results.some((r: any) => r.reachable) || !b.results.length
        ? failures !== 0
        : failures === 0
    )
      fail(400, "INVALID_NETWORK_PROBE_FAILURES");
    if (
      b.status !==
      classifyProbe(
        b.platform_connected,
        b.results,
        failures,
        settings.failure_threshold,
      )
    )
      fail(400, "INVALID_NETWORK_PROBE_CLASSIFICATION");
    return b;
  }
  function checkSample(id: string, r: any, serialized: string) {
    const existing = db
      .prepare(
        "SELECT report FROM network_probe_events WHERE device_id=? AND (seq=? OR sample_id=?)",
      )
      .all(id, r.seq, r.sample_id) as any[];
    const latest = db
      .prepare(
        "SELECT report FROM network_probe_latest WHERE device_id=? AND (seq=? OR json_extract(report,'$.sample_id')=?)",
      )
      .get(id, r.seq, r.sample_id) as any;
    if (
      existing.some((row) => row.report !== serialized) ||
      (latest && latest.report !== serialized)
    )
      fail(409, "NETWORK_PROBE_SAMPLE_CONFLICT");
  }
  return {
    config,
    applied(id: string, value: unknown) {
      const b = object(value);
      keys(b, ["revision"]);
      const revision = integer(b.revision, 0, MAX);
      config(id, revision);
      db.prepare(
        "INSERT INTO network_probe_applied(device_id,revision) VALUES(?,?) ON CONFLICT(device_id) DO UPDATE SET revision=MAX(revision,excluded.revision)",
      ).run(id, revision);
    },
    latest(id: string, value: unknown) {
      const b = object(value);
      keys(b, ["report", "age_ms"]);
      const r = validateReport(id, b.report),
        age = integer(b.age_ms, 0, MAX),
        agent = d.agent(id);
      if (!agent?.supported) return;
      const previous = db
        .prepare(
          "SELECT seq,report FROM network_probe_latest WHERE device_id=?",
        )
        .get(id) as any;
      const serialized = canonical(r);
      checkSample(id, r, serialized);
      if (previous?.seq === r.seq && previous.report !== serialized)
        fail(409, "NETWORK_PROBE_SAMPLE_CONFLICT");
      if (!previous || previous.seq <= r.seq)
        db.prepare(
          "INSERT INTO network_probe_latest(device_id,seq,report,received_at,age_ms,connection_id) VALUES(?,?,?,?,?,?) ON CONFLICT(device_id) DO UPDATE SET seq=excluded.seq,report=excluded.report,received_at=excluded.received_at,age_ms=excluded.age_ms,connection_id=excluded.connection_id",
        ).run(id, r.seq, serialized, Date.now(), age, agent.connectionId);
    },
    event(id: string, value: unknown) {
      const r = validateReport(id, value),
        serialized = canonical(r);
      d.store.transaction(() => {
        checkSample(id, r, serialized);
        const existing = db
          .prepare(
            "SELECT report FROM network_probe_events WHERE device_id=? AND (seq=? OR sample_id=?)",
          )
          .all(id, r.seq, r.sample_id) as any[];
        if (existing.some((x) => x.report !== serialized))
          fail(409, "NETWORK_PROBE_SAMPLE_CONFLICT");
        if (!existing.length)
          db.prepare(
            "INSERT INTO network_probe_events(device_id,seq,sample_id,report,received_at) VALUES(?,?,?,?,?)",
          ).run(id, r.seq, r.sample_id, serialized, Date.now());
      });
      return { sample_id: r.sample_id, seq: r.seq };
    },
  };
}
