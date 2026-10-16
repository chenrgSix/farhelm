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
    vpn_host: string | null;
    vpn_port: number | null;
    public_host: string | null;
    public_port: number | null;
  } | null;
}
export interface PlatformNetworkSettings {
  enabled: boolean;
  mode: NetworkPolicy["mode"];
  agent: NetworkPolicy["agent"];
}
export function validatePlatformNetwork(
  value: unknown,
): PlatformNetworkSettings {
  const b = object(value);
  keys(b, ["enabled", "mode", "agent"]);
  if (
    typeof b.enabled !== "boolean" ||
    !["vpn_preferred", "private_only"].includes(b.mode)
  )
    fail(400, "INVALID_NETWORK_MODE");
  const agent =
    b.agent === null
      ? null
      : validatePolicy({ mode: b.mode, agent: b.agent, ssh: null })!.agent;
  return { enabled: b.enabled, mode: b.mode, agent };
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
    agentEnabled?: boolean;
    platformUrl?(): string;
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
  function platform() {
    const row = db
      .prepare("SELECT * FROM platform_network_settings WHERE id=1")
      .get() as any;
    return {
      revision: row?.revision ?? 0,
      updated_at: row?.updated_at ?? null,
      settings: row
        ? (JSON.parse(row.settings_json) as PlatformNetworkSettings)
        : ({
            enabled: false,
            mode: "vpn_preferred",
            agent: null,
          } as PlatformNetworkSettings),
    };
  }
  function addresses(id: string) {
    const row = db
      .prepare(
        "SELECT revision,vpn_ip,ssh_port FROM device_network_addresses WHERE device_id=?",
      )
      .get(id) as any;
    return row ?? { revision: 0, vpn_ip: null, ssh_port: null };
  }
  function sshConfig(id: string) {
    const row = db
      .prepare("SELECT config_json FROM device_connections WHERE device_id=?")
      .get(id) as any;
    const config = row ? JSON.parse(row.config_json) : null;
    return config?.host
      ? { host: config.host as string, port: config.port as number }
      : null;
  }
  function current(id: string): {
    revision: number;
    policy: NetworkPolicy | null;
  } {
    const row = db
      .prepare(
        "SELECT revision,config_json FROM device_network_routes WHERE device_id=?",
      )
      .get(id) as any;
    const saved = row
      ? {
          revision: row.revision,
          policy: JSON.parse(row.config_json) as NetworkPolicy | null,
        }
      : { revision: 0, policy: null };
    const global = platform();
    if (!global.revision) return saved;
    const device = d.requireDevice(id),
      a = addresses(id),
      ssh = sshConfig(id);
    const vpnHost = a.vpn_ip ?? (ssh && privateIP(ssh.host) ? ssh.host : null);
    const vpnPort = vpnHost ? (a.ssh_port ?? ssh?.port ?? 22) : null;
    const fallback =
      global.settings.mode === "vpn_preferred" &&
      ssh &&
      !(ssh.host === vpnHost && ssh.port === vpnPort)
        ? ssh
        : null;
    const policy: NetworkPolicy | null = global.settings.enabled
      ? {
          mode: global.settings.mode,
          agent:
            device.connection_kind === "agent" ? global.settings.agent : null,
          ssh: ssh
            ? {
                vpn_host: vpnHost,
                vpn_port: vpnPort,
                public_host: fallback?.host ?? null,
                public_port: fallback?.port ?? null,
              }
            : null,
        }
      : null;
    if (JSON.stringify(policy) === JSON.stringify(saved.policy)) return saved;
    if (saved.revision >= Number.MAX_SAFE_INTEGER)
      fail(409, "NETWORK_REVISION_EXHAUSTED");
    const revision = saved.revision + 1;
    db.prepare(
      "INSERT INTO device_network_routes VALUES(?,?,?,?) ON CONFLICT(device_id) DO UPDATE SET revision=excluded.revision,config_json=excluded.config_json,updated_at=excluded.updated_at",
    ).run(id, revision, JSON.stringify(policy), Date.now());
    sshStates.delete(id);
    // Materialize new devices and changed SSH endpoints without requiring per-device policy setup.
    queueMicrotask(() => {
      if (!closed) deliver(id);
    });
    return { revision, policy };
  }
  let closed = false;
  app.addHook("onClose", async () => {
    closed = true;
  });
  function allDevices() {
    return db
      .prepare(
        "SELECT id,connection_kind FROM devices WHERE revoked_at IS NULL ORDER BY id",
      )
      .all() as { id: string; connection_kind: string }[];
  }
  function platformSnapshot() {
    const global = platform(),
      devices = allDevices();
    const legacy = !global.revision
      ? devices
          .map((d) => current(d.id).policy)
          .filter((p): p is NetworkPolicy => p !== null)
      : [];
    const agents = legacy.map((p) => p.agent).filter(Boolean);
    const suggestion =
      agents.length &&
      agents.every((a) => JSON.stringify(a) === JSON.stringify(agents[0]))
        ? agents[0]
        : null;
    return {
      v: 1,
      ...global,
      agent_enabled: d.agentEnabled !== false,
      platform_server_url: d.platformUrl?.() ?? "",
      legacy_devices: legacy.length,
      suggested_agent: suggestion,
      device_count: devices.length,
      pending_agents: devices.filter(
        (x) =>
          d.agentEnabled !== false &&
          x.connection_kind === "agent" &&
          !!current(x.id).policy &&
          !allowed(x.id),
      ).length,
    };
  }
  function requireIdle(id?: string) {
    const params = id ? [id] : [];
    if (
      db
        .prepare(
          "SELECT 1 FROM terminal_sessions WHERE ended_at IS NULL" +
            (id ? " AND device_id=?" : "") +
            " LIMIT 1",
        )
        .get(...params) ||
      db
        .prepare(
          "SELECT 1 FROM tasks WHERE status IN ('SENT','ACCEPTED','RUNNING')" +
            (id ? " AND device_id=?" : "") +
            " LIMIT 1",
        )
        .get(...params)
    )
      fail(409, "NETWORK_ROUTE_BUSY");
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
    const global = platform(),
      address = addresses(id),
      sshConfigValue = sshConfig(id);
    return {
      ...config,
      source: global.revision
        ? "platform"
        : config.policy
          ? "legacy"
          : "configured",
      platform_revision: global.revision,
      address_revision: address.revision,
      addresses: { vpn_ip: address.vpn_ip, ssh_port: address.ssh_port },
      ssh_fallback:
        config.policy?.mode === "private_only" ? null : sshConfigValue,
      blocked_reason:
        config.policy &&
        d.agentEnabled !== false &&
        d.requireDevice(id).connection_kind === "agent" &&
        !config.policy.agent
          ? "AGENT_PLATFORM_ENDPOINT_REQUIRED"
          : config.policy?.mode === "private_only" &&
              sshConfigValue &&
              !config.policy.ssh?.vpn_host
            ? "SSH_VPN_IP_REQUIRED"
            : null,
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
    const config = current(id);
    if (a?.supported && (!config.policy || config.policy.agent))
      a.send("agent.route.config", config);
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
    if ("policy" in b) fail(400, "NETWORK_POLICY_MOVED_TO_SETTINGS");
    keys(b, ["v", "revision", "vpn_ip", "ssh_port"]);
    const revision = integer(b.revision, 0, Number.MAX_SAFE_INTEGER - 1);
    const vpn_ip = b.vpn_ip === null ? null : str(b.vpn_ip, 1, 45);
    if (vpn_ip && !privateIP(vpn_ip))
      fail(400, "VPN_LITERAL_PRIVATE_IP_REQUIRED");
    const ssh_port = b.ssh_port === null ? null : integer(b.ssh_port, 1, 65535);
    if (addresses(id).revision !== revision)
      fail(409, "NETWORK_ROUTE_CHANGED_RELOAD");
    requireIdle(id);
    d.store.transaction(() => {
      db.prepare(
        "INSERT INTO device_network_addresses VALUES(?,?,?,?,?) ON CONFLICT(device_id) DO UPDATE SET revision=excluded.revision,vpn_ip=excluded.vpn_ip,ssh_port=excluded.ssh_port,updated_at=excluded.updated_at",
      ).run(id, revision + 1, vpn_ip, ssh_port, Date.now());
      d.store.audit("network.device_address_updated", user.id, id, null, {
        revision: revision + 1,
        vpn_ip,
        ssh_port,
      });
      if (platform().revision) current(id);
      else {
        // Editing an address before global adoption must retain the old network mode/platform endpoints.
        const old = current(id);
        if (old.policy?.ssh) {
          const ssh = sshConfig(id);
          const host = vpn_ip ?? (ssh && privateIP(ssh.host) ? ssh.host : null);
          const policy = {
            ...old.policy,
            ssh: {
              ...old.policy.ssh,
              vpn_host: host,
              vpn_port: host ? (ssh_port ?? ssh?.port ?? 22) : null,
            },
          };
          db.prepare(
            "UPDATE device_network_routes SET revision=revision+1,config_json=?,updated_at=? WHERE device_id=?",
          ).run(JSON.stringify(policy), Date.now(), id);
        }
      }
    });
    deliver(id);
    return { v: 1, device_id: id, ...snapshot(id) };
  });
  app.get("/api/v1/settings/network", async (req) => {
    d.admin(req);
    return platformSnapshot();
  });
  app.put("/api/v1/settings/network", async (req) => {
    const user = d.admin(req),
      b = object(req.body);
    version(b);
    keys(b, ["v", "revision", "settings"]);
    const revision = integer(b.revision, 0, Number.MAX_SAFE_INTEGER - 1),
      settings = validatePlatformNetwork(b.settings);
    const previous = platform();
    if (previous.revision !== revision)
      fail(409, "NETWORK_ROUTE_CHANGED_RELOAD");
    if (settings.enabled && d.agentEnabled !== false && !settings.agent)
      fail(400, "AGENT_NETWORK_ENDPOINT_REQUIRED");
    if (
      revision > 0 &&
      JSON.stringify(settings) === JSON.stringify(previous.settings)
    )
      return platformSnapshot();
    requireIdle();
    d.store.transaction(() => {
      db.prepare(
        "INSERT INTO platform_network_settings VALUES(1,?,?,?) ON CONFLICT(id) DO UPDATE SET revision=excluded.revision,settings_json=excluded.settings_json,updated_at=excluded.updated_at",
      ).run(revision + 1, JSON.stringify(settings), Date.now());
      for (const { id } of allDevices()) current(id);
      d.store.audit("network.platform_settings_updated", user.id, null, null, {
        revision: revision + 1,
        settings,
      });
    });
    for (const { id } of allDevices()) deliver(id);
    return platformSnapshot();
  });
  return {
    current,
    platformSnapshot,
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
