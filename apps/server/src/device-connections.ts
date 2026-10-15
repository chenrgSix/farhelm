import type { FastifyInstance, FastifyRequest } from "fastify";
import { randomUUID } from "node:crypto";
import { isIP } from "node:net";
import ssh2 from "ssh2";
import type { Store } from "./store.js";
import type { User } from "./types.js";
import { Credentials } from "./credentials.js";
import {
  SshTargets,
  preparePrivateKey,
  type SshTargetConfig,
} from "./ssh-target.js";
import {
  fail,
  object,
  keys,
  str,
  integer,
  version,
  type RateLimiter,
} from "./util.js";

export function registerDeviceConnections(
  app: FastifyInstance,
  d: {
    store: Store;
    admin(req: FastifyRequest): User;
    requireDevice(id: string): any;
    availableStorage(): void;
    rate: RateLimiter;
  },
) {
  const db = d.store.db;
  const secrets = new Credentials(
    d.store.dataDir,
    !!db.prepare("SELECT 1 FROM device_connections LIMIT 1").get(),
  );
  const targets = new SshTargets();
  let probing = 0;
  function saved(id: string) {
    return db
      .prepare("SELECT * FROM device_connections WHERE device_id=?")
      .get(id) as any;
  }
  function kind(id: string): "agent" | "ssh" {
    return d.requireDevice(id).connection_kind;
  }
  function hasSsh(id: string) {
    const row = saved(id);
    return !!row && !!JSON.parse(row.config_json).host;
  }
  function target(id: string): SshTargetConfig {
    const row = saved(id);
    if (!row || !hasSsh(id)) fail(409, "SSH_NOT_CONFIGURED");
    const config = JSON.parse(row.config_json),
      credential = secrets.open(id, row.secrets);
    return {
      ...config,
      privateKey: credential.private_key,
      passphrase: credential.passphrase,
    };
  }
  function view(id: string) {
    const row = saved(id),
      credential = row ? secrets.open(id, row.secrets) : {};
    return {
      v: 1,
      device_id: id,
      kind: kind(id),
      revision: row?.revision ?? 0,
      ssh: hasSsh(id) ? JSON.parse(row.config_json) : null,
      has_private_key: !!credential.private_key,
      has_passphrase: !!credential.passphrase,
      has_sudo_password: !!credential.sudo_password,
      last_checked_at: row?.last_checked_at ?? null,
      last_error: row?.last_error ?? null,
    };
  }
  function address(b: Record<string, any>) {
    const host = str(b.host, 1, 253);
    if (
      !isIP(host) &&
      !host
        .split(".")
        .every((label) =>
          /^[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?$/.test(label),
        )
    )
      fail(400, "INVALID_SSH_HOST");
    return { host, port: integer(b.port, 1, 65535) };
  }
  function validate(id: string, type: "agent" | "ssh", b: Record<string, any>) {
    const old = saved(id);
    const credential = old ? secrets.open(id, old.secrets) : {};
    let config: Record<string, any> = old ? JSON.parse(old.config_json) : {};
    if (type === "agent") {
      if (b.sudo_password === null) delete credential.sudo_password;
      else if (b.sudo_password !== undefined)
        credential.sudo_password = str(b.sudo_password, 1, 1024);
    } else if (b.sudo_password !== undefined) {
      fail(400, "SSH_SUDO_FIELD_NOT_ALLOWED");
    }
    if (b.ssh === null) {
      if (type === "ssh") fail(400, "SSH_CONFIGURATION_REQUIRED");
      if (b.private_key !== undefined || b.passphrase !== undefined)
        fail(400, "SSH_NOT_CONFIGURED");
      config = {};
      delete credential.private_key;
      delete credential.passphrase;
    } else if (b.ssh !== undefined) {
      const ssh = object(b.ssh);
      keys(ssh, ["host", "port", "username", "fingerprint"]);
      config = {
        ...address(ssh),
        username: str(ssh.username, 1, 128),
        fingerprint: str(ssh.fingerprint, 50, 50),
      };
      if (
        /[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/u.test(config.username) ||
        !/^SHA256:[A-Za-z0-9+/]{43}$/.test(config.fingerprint)
      )
        fail(400, "INVALID_SSH_IDENTITY");
    }
    if (config.host) {
      if (b.private_key !== undefined) {
        credential.private_key = str(b.private_key, 1, 32768);
        delete credential.passphrase;
      }
      if (b.passphrase === null) delete credential.passphrase;
      else if (b.passphrase !== undefined)
        credential.passphrase = str(b.passphrase, 1, 1024);
      if (!credential.private_key) fail(400, "SSH_PRIVATE_KEY_REQUIRED");
      let prepared;
      try {
        prepared = preparePrivateKey(
          credential.private_key,
          credential.passphrase,
        );
      } catch {
        fail(400, "SSH_PRIVATE_KEY_INVALID_OR_PASSPHRASE_REQUIRED");
      }
      const parsed = ssh2.utils.parseKey(
        prepared.privateKey,
        prepared.passphrase,
      );
      const key =
        Array.isArray(parsed) && parsed.length === 1 ? parsed[0] : parsed;
      if (
        !key ||
        key instanceof Error ||
        Array.isArray(key) ||
        !key.isPrivateKey()
      )
        fail(400, "SSH_PRIVATE_KEY_INVALID_OR_PASSPHRASE_REQUIRED");
    }
    if (
      !config.host &&
      (type === "ssh" ||
        b.private_key !== undefined ||
        b.passphrase !== undefined)
    )
      fail(400, "SSH_CONFIGURATION_REQUIRED");
    return { config, credential };
  }
  function persist(
    id: string,
    user: User,
    revision: number,
    data: ReturnType<typeof validate>,
  ) {
    db.prepare(
      "INSERT INTO device_connections(device_id,revision,config_json,secrets,updated_at,actor_id) VALUES(?,?,?,?,?,?) ON CONFLICT(device_id) DO UPDATE SET revision=excluded.revision,config_json=excluded.config_json,secrets=excluded.secrets,updated_at=excluded.updated_at,actor_id=excluded.actor_id,last_checked_at=NULL,last_error=NULL",
    ).run(
      id,
      revision,
      JSON.stringify(data.config),
      secrets.seal(id, data.credential),
      Date.now(),
      user.id,
    );
    d.store.audit("connection.configured", user.id, id, null, {
      revision,
      kind: kind(id),
    });
  }
  function device(req: FastifyRequest) {
    const user = d.admin(req),
      id = str((req.params as any).id, 1, 128);
    const row = d.requireDevice(id);
    if (row.revoked_at) fail(409, "DEVICE_REVOKED");
    return { user, id };
  }
  function beginProbe(user: User) {
    d.rate.check("ssh-probe:" + user.id, 12);
    if (probing >= 8) fail(429, "SSH_PROBE_LIMIT");
    probing++;
  }
  app.post("/api/v1/ssh/host-key", async (req) => {
    const user = d.admin(req),
      b = object(req.body);
    version(b);
    keys(b, ["v", "host", "port"]);
    const { host, port } = address(b);
    d.availableStorage();
    d.store.audit("connection.host_key_scanned", user.id, null, null);
    beginProbe(user);
    try {
      const fingerprint = await targets.scan(host, port);
      d.admin(req);
      return { v: 1, fingerprint };
    } catch {
      fail(502, "SSH_HOST_KEY_UNAVAILABLE");
    } finally {
      probing--;
    }
  });
  app.post("/api/v1/ssh-devices", async (req) => {
    const user = d.admin(req),
      b = object(req.body);
    version(b);
    keys(b, ["v", "name", "ssh", "private_key", "passphrase"]);
    d.rate.check("device-config:" + user.id, 30);
    const name = str(b.name, 1, 128);
    if (!name.trim() || /[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/u.test(name))
      fail(400, "INVALID_DEVICE_NAME");
    const id = randomUUID(),
      data = validate(id, "ssh", b);
    d.availableStorage();
    d.store.transaction(() => {
      // SSH inventory has no Agent identity. This namespace cannot be an Ed25519 public key.
      db.prepare(
        "INSERT INTO devices(id,public_key,name,created_at,connection_kind) VALUES(?,?,?,?,'ssh')",
      ).run(id, "ssh:" + id, name, Date.now());
      persist(id, user, 1, data);
    });
    return view(id);
  });
  app.get("/api/v1/devices/:id/connection", async (req) =>
    view(device(req).id),
  );
  app.put("/api/v1/devices/:id/connection", async (req) => {
    const { user, id } = device(req),
      b = object(req.body);
    version(b);
    keys(b, [
      "v",
      "revision",
      "ssh",
      "private_key",
      "passphrase",
      "sudo_password",
    ]);
    d.rate.check("device-config:" + user.id, 30);
    const revision = integer(b.revision, 0, Number.MAX_SAFE_INTEGER - 1);
    if ((saved(id)?.revision ?? 0) !== revision)
      fail(409, "CONNECTION_CHANGED_RELOAD");
    if (
      db
        .prepare(
          "SELECT 1 FROM terminal_sessions WHERE device_id=? AND ended_at IS NULL LIMIT 1",
        )
        .get(id)
    )
      fail(409, "CONNECTION_HAS_ACTIVE_SESSIONS");
    const data = validate(id, kind(id), b);
    d.availableStorage();
    d.store.transaction(() => persist(id, user, revision + 1, data));
    return view(id);
  });
  function checked(id: string, revision: number, error: string | null) {
    db.prepare(
      "UPDATE device_connections SET last_checked_at=?,last_error=? WHERE device_id=? AND revision=?",
    ).run(Date.now(), error, id, revision);
  }
  app.post("/api/v1/devices/:id/connection/test", async (req) => {
    const { user, id } = device(req),
      b = object(req.body);
    version(b);
    keys(b, ["v", "revision"]);
    if (!hasSsh(id)) fail(409, "SSH_NOT_CONFIGURED");
    const revision = integer(b.revision, 1, Number.MAX_SAFE_INTEGER);
    if (saved(id)?.revision !== revision)
      fail(409, "CONNECTION_CHANGED_RELOAD");
    const config = target(id);
    d.availableStorage();
    d.store.audit("connection.tested", user.id, id, null, { revision });
    beginProbe(user);
    try {
      const error = await targets.test(config);
      device(req);
      if (saved(id)?.revision !== revision)
        fail(409, "CONNECTION_CHANGED_RELOAD");
      checked(id, revision, error);
      return { ...view(id), ok: !error };
    } finally {
      probing--;
    }
  });
  return {
    kind,
    hasSsh,
    status(id: string) {
      const row = saved(id);
      return {
        ssh_checked_at: row?.last_checked_at ?? null,
        ssh_status: !row?.last_checked_at
          ? "unknown"
          : row.last_error
            ? "failed"
            : "connected",
      };
    },
    open(
      id: string,
      cols: number,
      rows: number,
      receive: (type: string, body: Record<string, any>) => void,
    ) {
      const revision = saved(id)?.revision;
      return targets.open(target(id), cols, rows, (type, body) => {
        try {
          if (type === "terminal.opened") checked(id, revision, null);
          else if (type === "terminal.closed" && body.reason !== "SHELL_EXIT")
            checked(id, revision, body.reason);
        } catch {
          receive("terminal.closed", { reason: "AUDIT_STORAGE_FAILURE" });
          return;
        }
        receive(type, body);
      });
    },
    close: () => targets.close(),
  };
}
