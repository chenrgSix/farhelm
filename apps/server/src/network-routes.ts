import { isIP } from "node:net";
import type { FastifyInstance, FastifyRequest } from "fastify";
import type { Store } from "./store.js";
import type { User } from "./types.js";
import { fail, integer, keys, object, str, version } from "./util.js";
import { observeEasyTier, type EasyTierPath } from "./easytier.js";

export type RouteChannel = "vpn" | "public" | "configured";
export interface NetworkPolicy {
  mode: "vpn_preferred" | "private_only";
  agent: { vpn_url: string; vpn_ip?: string; public_url: string | null } | null;
  ssh: {
    vpn_host: string;
    vpn_port: number;
    public_host: string | null;
    public_port: number | null;
  } | null;
}
export interface RouteObservation {
  channel: RouteChannel;
  endpoint: string;
  reason: string | null;
  checked_at: number;
  easytier: EasyTierPath;
}
export function privateIP(host: string) {
  if (isIP(host) === 4) {
    const [a = 0, b = 0] = host.split(".").map(Number);
    return (
      a === 10 ||
      a === 127 ||
      (a === 172 && b >= 16 && b <= 31) ||
      (a === 192 && b === 168) ||
      (a === 100 && b >= 64 && b <= 127)
    );
  }
  return isIP(host) === 6 && (host === "::1" || /^f[cd]/i.test(host));
}
export function validatePolicy(value: unknown): NetworkPolicy | null {
  if (value === null) return null;
  const p = object(value);
  keys(p, ["mode", "agent", "ssh"]);
  if (!["vpn_preferred", "private_only"].includes(p.mode))
    fail(400, "INVALID_NETWORK_MODE");
  function origin(value: unknown, privateOnly: boolean) {
    const text = str(value, 1, 2048);
    let u: URL;
    try {
      u = new URL(text);
    } catch {
      return fail(400, "INVALID_NETWORK_URL");
    }
    if (
      u.protocol !== "https:" ||
      u.username ||
      u.password ||
      u.pathname !== "/" ||
      u.search ||
      u.hash ||
      /[\s\x00-\x1f]/.test(text)
    )
      fail(400, "INVALID_NETWORK_URL");
    if (privateOnly && !privateIP(u.hostname.replace(/^\[|\]$/g, "")))
      fail(400, "VPN_LITERAL_PRIVATE_IP_REQUIRED");
    return u.origin;
  }
  const agent =
    p.agent === null
      ? null
      : (() => {
          const a = object(p.agent);
          keys(a, ["vpn_url", "vpn_ip", "public_url"]);
          const vpn_url = origin(a.vpn_url, false),
            public_url =
              p.mode === "private_only"
                ? null
                : a.public_url === null
                  ? null
                  : origin(a.public_url, false);
          const host = new URL(vpn_url).hostname.replace(/^\[|\]$/g, "");
          const vpn_ip =
            a.vpn_ip === undefined ? undefined : str(a.vpn_ip, 1, 45);
          if (!privateIP(vpn_ip ?? host))
            fail(400, "VPN_LITERAL_PRIVATE_IP_REQUIRED");
          if (vpn_ip && isIP(host) && vpn_ip !== host)
            fail(400, "VPN_IP_HOST_MISMATCH");
          if (public_url === vpn_url && (!vpn_ip || isIP(host)))
            fail(400, "DUPLICATE_NETWORK_ENDPOINT");
          if (p.mode === "private_only" && a.public_url !== null)
            fail(400, "PUBLIC_FALLBACK_FORBIDDEN");
          return { vpn_url, ...(vpn_ip ? { vpn_ip } : {}), public_url };
        })();
  const ssh =
    p.ssh === null
      ? null
      : (() => {
          const s = object(p.ssh);
          keys(s, ["vpn_host", "vpn_port", "public_host", "public_port"]);
          const vpn_host = str(s.vpn_host, 1, 45),
            vpn_port = integer(s.vpn_port, 1, 65535);
          if (!privateIP(vpn_host))
            fail(400, "VPN_LITERAL_PRIVATE_IP_REQUIRED");
          const public_host =
            s.public_host === null ? null : str(s.public_host, 1, 253);
          if (
            public_host &&
            !isIP(public_host) &&
            !public_host
              .split(".")
              .every((l) =>
                /^[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?$/.test(l),
              )
          )
            fail(400, "INVALID_SSH_HOST");
          const public_port = public_host
            ? integer(s.public_port, 1, 65535)
            : null;
          if (
            (!public_host && s.public_port !== null) ||
            (p.mode === "private_only" && public_host)
          )
            fail(400, "PUBLIC_FALLBACK_FORBIDDEN");
          if (vpn_host === public_host && vpn_port === public_port)
            fail(400, "DUPLICATE_NETWORK_ENDPOINT");
          return { vpn_host, vpn_port, public_host, public_port };
        })();
  if (!agent && !ssh) fail(400, "NETWORK_ENDPOINT_REQUIRED");
  return { mode: p.mode, agent, ssh };
}
export function registerNetworkRoutes(
  app: FastifyInstance,
  d: {
    store: Store;
    admin(req: FastifyRequest): User;
    reader(req: FastifyRequest): User;
    requireScope(user: User, id: string): void;
    requireDevice(id: string): any;
    agent(id: string):
      | {
          supported: boolean;
          connectionId: string;
          send(type: string, body: unknown): boolean;
        }
      | undefined;
  },
) {
  const { db } = d.store;
  const agentStates = new Map<
    string,
    { revision: number; connectionId: string; observation: RouteObservation }
  >();
  const sshStates = new Map<string, RouteObservation>();
  function current(id: string): {
    revision: number;
    policy: NetworkPolicy | null;
  } {
    const row = db
      .prepare(
        "SELECT revision,config_json FROM device_network_routes WHERE device_id=?",
      )
      .get(id) as any;
    return row
      ? { revision: row.revision, policy: JSON.parse(row.config_json) }
      : { revision: 0, policy: null };
  }
  function allowed(id: string) {
    const config = current(id);
    if (!config.policy) return true;
    const a = d.agent(id),
      state = agentStates.get(id);
    return !!(
      config.policy.agent &&
      a?.supported &&
      state &&
      state.connectionId === a.connectionId &&
      state.revision === config.revision &&
      Date.now() - state.observation.checked_at < 75000 &&
      (config.policy.mode !== "private_only" ||
        state.observation.channel === "vpn")
    );
  }
  function snapshot(id: string) {
    const config = current(id),
      a = d.agent(id),
      s = agentStates.get(id);
    const agent = s
      ? {
          ...s.observation,
          connected:
            !!a &&
            s.connectionId === a.connectionId &&
            Date.now() - s.observation.checked_at < 75000,
        }
      : null;
    return {
      ...config,
      ssh_active: !!db
        .prepare(
          "SELECT 1 FROM terminal_sessions WHERE device_id=? AND backend='ssh' AND ended_at IS NULL",
        )
        .get(id),
      agent_supported: a ? a.supported : null,
      agent_applied: allowed(id),
      agent,
      ssh: sshStates.get(id) ?? null,
    };
  }
  function deliver(id: string) {
    const a = d.agent(id);
    if (a?.supported) a.send("agent.route.config", current(id));
  }
  function receive(id: string, value: unknown) {
    const a = d.agent(id);
    if (!a?.supported) fail(400, "NETWORK_ROUTE_HELLO_REQUIRED");
    const b = object(value);
    keys(b, ["revision", "channel", "endpoint", "reason", "easytier"]);
    const revision = integer(b.revision, 0, Number.MAX_SAFE_INTEGER),
      config = current(id);
    if (revision !== config.revision) return;
    if (!["vpn", "public", "configured"].includes(b.channel))
      fail(400, "INVALID_NETWORK_CHANNEL");
    const endpoint = str(b.endpoint, 1, 2048),
      channel = b.channel as RouteChannel;
    if (config.policy) {
      const expected =
        channel === "vpn"
          ? config.policy.agent?.vpn_url
          : channel === "public" && config.policy.mode === "vpn_preferred"
            ? config.policy.agent?.public_url
            : null;
      if (!expected || endpoint !== expected)
        fail(400, "NETWORK_ROUTE_POLICY_MISMATCH");
    } else if (channel !== "configured")
      fail(400, "NETWORK_ROUTE_POLICY_MISMATCH");
    const reason = b.reason === null ? null : str(b.reason, 1, 64);
    if (
      reason !== null &&
      !["VPN_UNREACHABLE", "VPN_RECOVERY_WAITING_IDLE"].includes(reason)
    )
      fail(400, "INVALID_NETWORK_REASON");
    const e = object(b.easytier);
    keys(e, ["state", "latency_ms"]);
    if (!["p2p", "relay", "not_detected", "unknown"].includes(e.state))
      fail(400, "INVALID_EASYTIER_STATE");
    if (
      e.latency_ms !== null &&
      (typeof e.latency_ms !== "number" ||
        !Number.isFinite(e.latency_ms) ||
        e.latency_ms < 0 ||
        e.latency_ms > 3600000)
    )
      fail(400, "INVALID_EASYTIER_LATENCY");
    const observation: RouteObservation = {
      channel,
      endpoint,
      reason,
      checked_at: Date.now(),
      easytier: { state: e.state, latency_ms: e.latency_ms },
    };
    const old = agentStates.get(id);
    if (
      old?.observation.channel !== channel ||
      old.observation.reason !== reason
    )
      d.store.audit("network.route_changed", null, id, null, {
        backend: "agent",
        revision,
        channel,
        endpoint,
        reason,
      });
    agentStates.set(id, {
      revision,
      connectionId: a!.connectionId,
      observation,
    });
  }
  app.get("/api/v1/devices/:id/network-route", async (req) => {
    const user = d.reader(req),
      id = str((req.params as any).id, 1, 128);
    d.requireScope(user, id);
    d.requireDevice(id);
    return { v: 1, device_id: id, ...snapshot(id) };
  });
  app.put("/api/v1/devices/:id/network-route", async (req) => {
    const user = d.admin(req),
      id = str((req.params as any).id, 1, 128),
      device = d.requireDevice(id);
    if (device.revoked_at) fail(409, "DEVICE_REVOKED");
    const b = object(req.body);
    version(b);
    keys(b, ["v", "revision", "policy"]);
    const revision = integer(b.revision, 0, Number.MAX_SAFE_INTEGER - 1),
      policy = validatePolicy(b.policy);
    if (current(id).revision !== revision)
      fail(409, "NETWORK_ROUTE_CHANGED_RELOAD");
    if (
      db
        .prepare(
          "SELECT 1 FROM terminal_sessions WHERE device_id=? AND ended_at IS NULL",
        )
        .get(id) ||
      db
        .prepare(
          "SELECT 1 FROM tasks WHERE device_id=? AND status IN ('SENT','ACCEPTED','RUNNING')",
        )
        .get(id)
    )
      fail(409, "NETWORK_ROUTE_BUSY");
    if (policy && device.connection_kind === "agent" && !policy.agent)
      fail(400, "AGENT_NETWORK_ENDPOINT_REQUIRED");
    if (policy && device.connection_kind === "ssh" && !policy.ssh)
      fail(400, "SSH_NETWORK_ENDPOINT_REQUIRED");
    d.store.transaction(() => {
      db.prepare(
        "INSERT INTO device_network_routes VALUES(?,?,?,?) ON CONFLICT(device_id) DO UPDATE SET revision=excluded.revision,config_json=excluded.config_json,updated_at=excluded.updated_at",
      ).run(id, revision + 1, JSON.stringify(policy), Date.now());
      d.store.audit("network.route_configured", user.id, id, null, {
        revision: revision + 1,
        policy,
      });
    });
    sshStates.delete(id);
    deliver(id);
    return { v: 1, device_id: id, ...snapshot(id) };
  });
  return {
    current,
    snapshot,
    allowed,
    deliver,
    receive,
    async sshObserved(
      id: string,
      revision: number,
      channel: RouteChannel,
      host: string,
      port: number,
      reason: string | null,
    ) {
      if (current(id).revision !== revision) return;
      const observation: RouteObservation = {
        channel,
        endpoint: `${host}:${port}`,
        reason,
        checked_at: Date.now(),
        easytier: { state: "unknown", latency_ms: null },
      };
      sshStates.set(id, observation);
      d.store.audit("network.route_changed", null, id, null, {
        backend: "ssh",
        revision,
        channel,
        endpoint: observation.endpoint,
        reason,
      });
      const easytier = await observeEasyTier(host);
      if (
        current(id).revision === revision &&
        sshStates.get(id) === observation
      )
        observation.easytier = easytier;
    },
  };
}
