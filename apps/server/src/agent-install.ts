import type { FastifyInstance, FastifyRequest } from "fastify";
import { randomUUID } from "node:crypto";
import { existsSync, lstatSync, readFileSync } from "node:fs";
import { join } from "node:path";
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
  // Keep only the current pair of packages in memory. Commands pin their hashes at creation.
  const cache = new Map<
    string,
    { stamp: string; bytes: Buffer; digest: string }
  >();
  function artifact(machine: string) {
    if (!settings || !machines.includes(machine as any)) return undefined;
    const path = join(settings.distDir, `farhelm-agent-linux-${machine}`);
    if (!existsSync(path)) return undefined;
    const stat = lstatSync(path);
    if (!stat.isFile() || stat.size < 64 || stat.size > 64 * 1024 * 1024)
      return undefined;
    const stamp = `${stat.ino}:${stat.mtimeMs}:${stat.ctimeMs}:${stat.size}`;
    if (cache.get(machine)?.stamp !== stamp) {
      const bytes = readFileSync(path);
      if (
        bytes.subarray(0, 6).toString("hex") !== "7f454c460201" ||
        bytes.readUInt16LE(18) !== (machine === "x86_64" ? 62 : 183)
      )
        return undefined;
      cache.set(machine, { stamp, bytes, digest: hash(bytes) });
    }
    return cache.get(machine)!;
  }
  function available() {
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
        "SELECT i.*,e.expires_at,e.redeemed_device_id FROM agent_installations i JOIN enrollment_tokens e ON e.token_hash=i.token_hash WHERE i.token_hash=? AND e.expires_at>?",
      )
      .get(hash(auth.slice(7)), Date.now()) as any;
    if (!row || (unredeemed && row.redeemed_device_id))
      fail(401, "ENROLLMENT_INVALID");
    return {
      ...row,
      secret: auth.slice(7),
      config: JSON.parse(row.config_json) as InstallConfig,
    };
  }
  function status(row: any) {
    const device = row.redeemed_device_id
      ? (db
          .prepare("SELECT id,revoked_at FROM devices WHERE id=?")
          .get(row.redeemed_device_id) as any)
      : undefined;
    return {
      v: 1,
      device_id: device?.id ?? null,
      status: device?.revoked_at
        ? "revoked"
        : device && d.online(device.id)
          ? "online"
          : device
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
      private_ca: !!ca,
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
      "run_user",
      "ttl_seconds",
      "allow_sudo",
      "start_mode",
    ]);
    const name = str(b.name, 1, 128).trim(),
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
      ca,
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
      db.prepare(
        "INSERT INTO enrollment_tokens(token_hash,expires_at,created_by,name) VALUES(?,?,?,?)",
      ).run(hash(secret), expires, user.id, name);
      db.prepare(
        "INSERT INTO agent_installations(id,token_hash,config_json) VALUES(?,?,?)",
      ).run(id, hash(secret), JSON.stringify(c));
      d.store.audit("enrollment.created", user.id, null, null, {
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
      const file = artifact(req.params.machine);
      if (!file || file.digest !== row.config.artifacts[req.params.machine])
        fail(409, "AGENT_PACKAGE_CHANGED");
      return reply.type("application/octet-stream").send(file.bytes);
    },
  );
  return { artifact };
}
