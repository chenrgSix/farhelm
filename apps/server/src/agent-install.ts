import type { FastifyInstance, FastifyRequest } from "fastify";
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import type { Artifact, ReleaseCatalog } from "./agent-releases.js";
import type { Store } from "./store.js";
import type { ServerConfig, User } from "./types.js";
import { platformServerUrl } from "./settings.js";
import {
  fail,
  hash,
  integer,
  keys,
  object,
  RateLimiter,
  str,
  token,
  version,
} from "./util.js";

const machines = ["x86_64", "aarch64"] as const;
type InstallConfig = {
  server_url: string;
  name: string;
  run_user: string;
  allow_sudo: boolean;
  start_mode: "auto" | "systemd" | "background";
  ca: string;
  artifacts: Record<string, string>;
};
const quote = (s: string) => "'" + s.replaceAll("'", "'\"'\"'") + "'";
const b64 = (s: string) => Buffer.from(s).toString("base64");
export function registerAgentInstall(
  app: FastifyInstance,
  d: {
    store: Store;
    config: ServerConfig;
    admin: (req: FastifyRequest) => User;
    rate: RateLimiter;
    online: (id: string) => boolean;
    serverUrl: () => string;
    ca?: (url: string, fallback: string) => string;
    releases: ReleaseCatalog;
    artifact: (arch: string) => Artifact | undefined;
  },
) {
  const { db } = d.store;
  const settings = d.config.agentInstall;
  function serverOrigin() {
    const publicUrl = d.serverUrl();
    if (!publicUrl) fail(503, "AGENT_SERVER_URL_UNCONFIGURED");
    return platformServerUrl(publicUrl);
  }
  const ca = settings?.caCert ? readFileSync(settings.caCert, "utf8") : "";
  const template = readFileSync(
    new URL("../resources/agent-install.sh", import.meta.url),
    "utf8",
  );
  function artifact(machine: string) {
    return d.releases.has(machine)
      ? d.releases.latest(machine)
      : d.artifact(machine);
  }
  function available() {
    d.releases.list();
    return Object.fromEntries(
      machines.flatMap((m) => {
        const file = artifact(m);
        return file ? [[m, file.digest]] : [];
      }),
    );
  }
  function lookup(req: FastifyRequest, unredeemed: boolean) {
    const auth = req.headers.authorization;
    if (!auth || !/^Bearer [A-Za-z0-9_-]{43}$/.test(auth))
      fail(401, "ENROLLMENT_INVALID");
    const row = db
      .prepare(
        "SELECT i.*,e.expires_at,e.redeemed_device_id,e.target_device_id FROM agent_installations i JOIN enrollment_tokens e ON e.token_hash=i.token_hash WHERE i.token_hash=? AND e.expires_at>?",
      )
      .get(hash(auth.slice(7)), Date.now()) as any;
    if (!row || (unredeemed && row.redeemed_device_id))
      fail(401, "ENROLLMENT_INVALID");
    if (
      row.target_device_id &&
      (
        db
          .prepare("SELECT revoked_at FROM devices WHERE id=?")
          .get(row.target_device_id) as any
      )?.revoked_at
    )
      fail(401, "DEVICE_REVOKED");
    return {
      ...row,
      secret: auth.slice(7),
      config: JSON.parse(row.config_json) as InstallConfig,
    };
  }
  function status(row: any) {
    const id = row.target_device_id ?? row.redeemed_device_id;
    const device = id
      ? (db
          .prepare(
            "SELECT id,revoked_at,connection_kind FROM devices WHERE id=?",
          )
          .get(id) as any)
      : undefined;
    const registered = !!row.redeemed_device_id;
    return {
      v: 1,
      device_id: device?.id ?? null,
      status: device?.revoked_at
        ? "revoked"
        : registered &&
            device?.connection_kind === "agent" &&
            d.online(device.id)
          ? "online"
          : registered
            ? "registered"
            : row.expires_at <= Date.now()
              ? "expired"
              : "waiting",
    };
  }
  function installer(c: InstallConfig, secret: string) {
    // Quote for both systemd EnvironmentFile and the background launcher's Bash source.
    const envQuote = (s: string) => '"' + s.replace(/[\\"$`]/g, "\\$&") + '"';
    const env = {
      FLEET_SERVER_URL: c.server_url,
      FLEET_DEVICE_NAME: c.name,
      FLEET_STATE_DIR: "/var/lib/farhelm-agent",
      FLEET_ENROLLMENT_TOKEN: secret,
      FLEET_EXECUTION_BACKEND: "same-uid",
      FLEET_TERMINAL_ALLOW_PRIVILEGE_ESCALATION: c.allow_sudo ? "1" : "0",
      ...(c.ca ? { FLEET_CA_CERT: "/etc/farhelm-agent/ca.crt" } : {}),
    };
    const prefix = [
      `server=${quote(c.server_url)}`,
      `run_user=${quote(c.run_user)}`,
      `start_mode=${quote(c.start_mode)}`,
      `enrollment_token=${quote(secret)}`,
      `ca_b64=${quote(b64(c.ca))}`,
      `env_b64=${quote(
        b64(
          Object.entries(env)
            .map(([k, v]) => `${k}=${envQuote(v)}`)
            .join("\n") + "\n",
        ),
      )}`,
      ...machines.map((m) => `sha_${m}=${quote(c.artifacts[m] ?? "")}`),
    ].join("\n");
    return template.replace("# INSTALL_CONFIGURATION", prefix);
  }
  app.get("/api/v1/agent-install/options", async (req) => {
    d.admin(req);
    return {
      v: 1,
      server_url: d.serverUrl() ? serverOrigin() : "",
      architectures: Object.keys(available()),
      private_ca: !!(d.serverUrl() ? (d.ca?.(serverOrigin(), ca) ?? ca) : ca),
    };
  });
  app.post("/api/v1/agent-installations", async (req) => {
    const user = d.admin(req);
    d.rate.check("agent-install:" + user.id, 12);
    const b = object(req.body);
    version(b);
    keys(b, [
      "v",
      "name",
      "device_id",
      "run_user",
      "ttl_seconds",
      "allow_sudo",
      "start_mode",
    ]);
    const targetId =
      b.device_id === undefined ? undefined : str(b.device_id, 1, 128);
    const target = targetId
      ? (db.prepare("SELECT * FROM devices WHERE id=?").get(targetId) as any)
      : undefined;
    if (targetId) {
      if (!target) fail(404, "DEVICE_NOT_FOUND");
      if (target.revoked_at !== null) fail(409, "DEVICE_REVOKED");
      if (target.connection_kind !== "ssh") fail(409, "SSH_DEVICE_REQUIRED");
      if (target.agent_pending_public_key)
        fail(409, "AGENT_ALREADY_REGISTERED");
    }
    const name = target ? target.name : str(b.name, 1, 128).trim(),
      runUser = str(b.run_user ?? "farhelm", 1, 32);
    if (!name || /[\x00-\x1f\x7f]/.test(name)) fail(400, "INVALID_DEVICE_NAME");
    if (!/^[a-z_][a-z0-9_-]{0,31}$/.test(runUser) || runUser === "root")
      fail(400, "INVALID_AGENT_USER");
    if (b.allow_sudo !== undefined && typeof b.allow_sudo !== "boolean")
      fail(400, "INVALID_BODY");
    const mode = b.start_mode ?? "auto";
    if (!["auto", "systemd", "background"].includes(mode))
      fail(400, "INVALID_START_MODE");
    const artifacts = available();
    if (!Object.keys(artifacts).length) fail(503, "AGENT_PACKAGES_UNAVAILABLE");
    const c: InstallConfig = {
      server_url: serverOrigin(),
      name,
      run_user: runUser,
      start_mode: mode,
      allow_sudo: b.allow_sudo ?? false,
      ca: d.ca?.(serverOrigin(), ca) ?? ca,
      artifacts,
    };
    const expires =
      Date.now() + 1000 * integer(b.ttl_seconds ?? 3600, 60, 86400);
    const secret = token(),
      id = randomUUID();
    const script = installer(c, secret);
    // Download completely and verify before invoking a root shell. No secret is placed in a URL or curl argv.
    const bootstrap = `set -eu; umask 077; t=$(mktemp -d); trap 'rm -rf "$t"' EXIT; printf %s ${quote(b64(c.ca))} | base64 -d > "$t/ca.crt"; printf %s ${quote(b64("Authorization: Bearer " + secret + "\n"))} | base64 -d > "$t/auth"; curl --fail --silent --show-error --proto '=https' --connect-timeout 10 --max-time 120 ${c.ca ? '--cacert "$t/ca.crt" ' : ""}--header @"$t/auth" ${quote(c.server_url + "/api/agent/install.sh")} -o "$t/install.sh"; printf '%s  %s\\n' ${quote(hash(script))} "$t/install.sh" | sha256sum -c - >/dev/null; if [ "$(id -u)" -eq 0 ]; then bash "$t/install.sh"; else sudo bash "$t/install.sh"; fi`;
    d.store.transaction(() => {
      if (targetId)
        db.prepare(
          "UPDATE enrollment_tokens SET expires_at=MIN(expires_at,?) WHERE target_device_id=? AND redeemed_device_id IS NULL",
        ).run(Date.now(), targetId);
      db.prepare(
        "INSERT INTO enrollment_tokens(token_hash,expires_at,created_by,name,target_device_id) VALUES(?,?,?,?,?)",
      ).run(hash(secret), expires, user.id, name, targetId ?? null);
      db.prepare(
        "INSERT INTO agent_installations(id,token_hash,config_json) VALUES(?,?,?)",
      ).run(id, hash(secret), JSON.stringify(c));
      d.store.audit("enrollment.created", user.id, targetId ?? null, null, {
        expires_at: expires,
        name,
      });
    });
    return {
      v: 1,
      id,
      command: "bash -c " + quote(bootstrap),
      expires_at: expires,
      server_url: c.server_url,
    };
  });
  app.get<{ Params: { id: string } }>(
    "/api/v1/agent-installations/:id",
    async (req) => {
      d.admin(req);
      const row = db
        .prepare(
          "SELECT e.* FROM agent_installations i JOIN enrollment_tokens e ON e.token_hash=i.token_hash WHERE i.id=?",
        )
        .get(req.params.id);
      if (!row) fail(404, "INSTALLATION_NOT_FOUND");
      return status(row);
    },
  );
  app.get("/api/agent/install.sh", async (req, reply) => {
    d.rate.check("install-download:" + req.ip, 60);
    const row = lookup(req, true);
    return reply
      .type("text/x-shellscript")
      .send(installer(row.config, row.secret));
  });
  app.get("/api/agent/install-status", async (req) =>
    status(lookup(req, false)),
  );
  app.get<{ Params: { machine: string } }>(
    "/api/agent/packages/:machine",
    async (req, reply) => {
      d.rate.check("install-download:" + req.ip, 60);
      const row = lookup(req, true);
      const file =
        d.releases.get(
          row.config.artifacts[req.params.machine],
          req.params.machine,
        ) ?? d.artifact(req.params.machine);
      if (!file || file.digest !== row.config.artifacts[req.params.machine])
        fail(409, "AGENT_PACKAGE_CHANGED");
      return reply.type("application/octet-stream").send(file.bytes);
    },
  );
  function enrollTarget(enrollment: any, publicKey: string) {
    if (!enrollment.target_device_id) return undefined;
    const device = db
      .prepare("SELECT * FROM devices WHERE id=?")
      .get(enrollment.target_device_id) as any;
    if (!device || device.revoked_at !== null) fail(401, "DEVICE_REVOKED");
    if (enrollment.redeemed_device_id) {
      if (
        enrollment.redeemed_device_id !== device.id ||
        ![device.public_key, device.agent_pending_public_key].includes(
          publicKey,
        )
      )
        fail(401, "ENROLLMENT_REDEEMED");
      return device;
    }
    if (device.connection_kind !== "ssh") fail(409, "SSH_DEVICE_REQUIRED");
    if (
      device.agent_pending_public_key &&
      device.agent_pending_public_key !== publicKey
    )
      fail(409, "AGENT_ALREADY_REGISTERED");
    const other = db
      .prepare(
        "SELECT id FROM devices WHERE id<>? AND (public_key=? OR agent_pending_public_key=?)",
      )
      .get(device.id, publicKey, publicKey);
    if (other) fail(409, "AGENT_IDENTITY_ALREADY_BOUND");
    db.prepare("UPDATE devices SET agent_pending_public_key=? WHERE id=?").run(
      publicKey,
      device.id,
    );
    return device;
  }
  // Called inside the first valid hello transaction. Existing SSH sessions keep their backend.
  function activate(id: string) {
    const device = db
      .prepare(
        "SELECT * FROM devices WHERE id=? AND connection_kind='ssh' AND agent_pending_public_key IS NOT NULL",
      )
      .get(id) as any;
    if (!device) return;
    const enrollment = db
      .prepare(
        "SELECT e.created_by,i.id FROM enrollment_tokens e JOIN agent_installations i ON i.token_hash=e.token_hash WHERE e.target_device_id=? AND e.redeemed_device_id=? ORDER BY e.expires_at DESC LIMIT 1",
      )
      .get(id, id) as any;
    if (!enrollment) fail(401, "ENROLLMENT_INVALID");
    db.prepare(
      "UPDATE devices SET public_key=agent_pending_public_key,agent_pending_public_key=NULL,connection_kind='agent' WHERE id=?",
    ).run(id);
    d.store.audit("device.agent_enabled", enrollment.created_by, id, null, {
      installation_id: enrollment.id,
    });
  }
  return { artifact, enrollTarget, activate };
}
