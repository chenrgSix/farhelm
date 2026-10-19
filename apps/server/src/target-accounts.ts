import type { FastifyInstance, FastifyRequest } from "fastify";
import { randomUUID } from "node:crypto";
import ssh2 from "ssh2";
import { Credentials } from "./credentials.js";
import { hasPermission } from "./permissions.js";
import type { Store } from "./store.js";
import type { User } from "./types.js";
import { preparePrivateKey } from "./ssh-target.js";
import { fail, integer, keys, object, str, version } from "./util.js";

export interface TargetAccount {
  id: string;
  device_id: string;
  name: string;
  username: string;
  method: "ssh" | "sudo";
  revision: number;
  allowed_users: string[];
}
type Row = Omit<TargetAccount, "allowed_users"> & {
  allowed_users: string;
  secrets: string;
};
export function registerTargetAccounts(
  app: FastifyInstance,
  d: {
    store: Store;
    admin(req: FastifyRequest): User;
    reader(req: FastifyRequest): User;
    requireScope(user: User, id: string): void;
    requireDevice(id: string): { connection_kind: string };
    hasSsh(id: string): boolean;
    sudoPassword(id: string): string | undefined;
  },
) {
  const db = d.store.db;
  const credentials = new Credentials(
    d.store.dataDir,
    !!db.prepare("SELECT 1 FROM target_accounts LIMIT 1").get(),
  );
  function row(id: string) {
    return db.prepare("SELECT * FROM target_accounts WHERE id=?").get(id) as
      Row | undefined;
  }
  function publicAccount(r: Row): TargetAccount {
    const { secrets: _, ...account } = r;
    return { ...account, allowed_users: JSON.parse(r.allowed_users) };
  }
  function allowed(user: User, r: Row) {
    return (
      hasPermission(user, "terminal.connect") &&
      (user.role === "admin" ||
        JSON.parse(r.allowed_users).includes(user.id)) &&
      (!(r.method === "sudo" || r.username === "root") ||
        hasPermission(user, "terminal.sudo"))
    );
  }
  function requireAccount(user: User, deviceId: string, accountId: string) {
    d.requireScope(user, deviceId);
    const r = row(accountId);
    if (!r || r.device_id !== deviceId || !allowed(user, r))
      fail(403, "TARGET_ACCOUNT_DENIED");
    return publicAccount(r);
  }
  function list(user: User, deviceId: string) {
    d.requireScope(user, deviceId);
    return (
      db
        .prepare(
          "SELECT * FROM target_accounts WHERE device_id=? ORDER BY name,id",
        )
        .all(deviceId) as Row[]
    )
      .filter((r) => user.role === "admin" || allowed(user, r))
      .map(publicAccount);
  }
  function request(req: FastifyRequest, admin = false) {
    const user = admin ? d.admin(req) : d.reader(req);
    const deviceId = str((req.params as any).id, 1, 128);
    d.requireScope(user, deviceId);
    const device = d.requireDevice(deviceId);
    return { user, deviceId, device };
  }
  function idle(deviceId: string) {
    if (
      db
        .prepare(
          "SELECT 1 FROM terminal_sessions WHERE device_id=? AND ended_at IS NULL",
        )
        .get(deviceId)
    )
      fail(409, "CONNECTION_HAS_ACTIVE_SESSIONS");
  }
  app.get("/api/v1/devices/:id/accounts", async (req) => {
    const { user, deviceId } = request(req);
    return {
      v: 1,
      accounts: list(user, deviceId),
      ...(user.role === "admin"
        ? {
            users: db
              .prepare(
                "SELECT id,username FROM users WHERE enabled=1 ORDER BY username",
              )
              .all(),
          }
        : {}),
    };
  });
  async function save(req: FastifyRequest, updating: boolean) {
    const { user, deviceId, device } = request(req, true),
      b = object(req.body);
    version(b);
    keys(b, [
      "v",
      "revision",
      "name",
      "username",
      "method",
      "allowed_users",
      "private_key",
      "passphrase",
      "sudo_password",
    ]);
    idle(deviceId);
    const accountId = updating
      ? str((req.params as any).accountId, 1, 128)
      : randomUUID();
    const previous = updating ? row(accountId) : undefined;
    if (updating && (!previous || previous.device_id !== deviceId))
      fail(404, "TARGET_ACCOUNT_NOT_FOUND");
    if (
      previous &&
      integer(b.revision, 1, Number.MAX_SAFE_INTEGER) !== previous.revision
    )
      fail(409, "TARGET_ACCOUNT_CHANGED_RELOAD");
    const name = str(b.name, 1, 128).trim(),
      username = str(b.username, 1, 32);
    if (
      !name ||
      /[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/u.test(name) ||
      !/^[a-z_][a-z0-9_-]{0,31}$/.test(username)
    )
      fail(400, "INVALID_TARGET_ACCOUNT");
    if (!["ssh", "sudo"].includes(b.method))
      fail(400, "INVALID_TARGET_ACCOUNT");
    if (b.method === "sudo" && device.connection_kind !== "agent")
      fail(409, "SUDO_AGENT_REQUIRED");
    if (b.method === "ssh" && !d.hasSsh(deviceId))
      fail(409, "SSH_NOT_CONFIGURED");
    if (
      !Array.isArray(b.allowed_users) ||
      b.allowed_users.length > 1000 ||
      new Set(b.allowed_users).size !== b.allowed_users.length
    )
      fail(400, "INVALID_ACCOUNT_USERS");
    for (const id of b.allowed_users) {
      if (
        !db
          .prepare("SELECT 1 FROM users WHERE id=? AND enabled=1")
          .get(str(id, 1, 128))
      )
        fail(400, "INVALID_ACCOUNT_USERS");
    }
    const secret =
      previous && previous.method === b.method
        ? credentials.open(accountId, previous.secrets)
        : {};
    if (b.method === "ssh") {
      if (b.sudo_password !== undefined) fail(400, "INVALID_TARGET_ACCOUNT");
      if (b.private_key !== undefined) {
        secret.private_key = str(b.private_key, 1, 32768);
        delete secret.passphrase;
      }
      if (b.passphrase === null) delete secret.passphrase;
      else if (b.passphrase !== undefined)
        secret.passphrase = str(b.passphrase, 1, 1024);
      if (!secret.private_key) fail(400, "SSH_PRIVATE_KEY_REQUIRED");
      try {
        const prepared = preparePrivateKey(
          secret.private_key,
          secret.passphrase,
        );
        const parsed = ssh2.utils.parseKey(
          prepared.privateKey,
          prepared.passphrase,
        );
        if (parsed instanceof Error || Array.isArray(parsed)) throw new Error();
        secret.private_key = prepared.privateKey;
        if (prepared.passphrase === undefined) delete secret.passphrase;
      } catch {
        fail(400, "SSH_PRIVATE_KEY_INVALID_OR_PASSPHRASE_REQUIRED");
      }
    } else {
      if (b.private_key !== undefined || b.passphrase !== undefined)
        fail(400, "INVALID_TARGET_ACCOUNT");
      if (b.sudo_password !== undefined)
        secret.sudo_password = str(b.sudo_password, 1, 1024);
      const password = secret.sudo_password ?? d.sudoPassword(deviceId);
      if (!password) fail(400, "SUDO_PASSWORD_REQUIRED");
      if (/[\r\n\0]/.test(password)) fail(400, "INVALID_SUDO_PASSWORD");
    }
    d.store.transaction(() => {
      db.prepare(
        "INSERT INTO target_accounts(id,device_id,name,username,method,revision,allowed_users,secrets) VALUES(?,?,?,?,?,1,?,?) ON CONFLICT(id) DO UPDATE SET name=excluded.name,username=excluded.username,method=excluded.method,revision=target_accounts.revision+1,allowed_users=excluded.allowed_users,secrets=excluded.secrets",
      ).run(
        accountId,
        deviceId,
        name,
        username,
        b.method,
        JSON.stringify(b.allowed_users),
        credentials.seal(accountId, secret),
      );
      d.store.audit("account.configured", user.id, deviceId, null, {
        account_id: accountId,
        username,
        method: b.method,
      });
    });
    return { v: 1, account: publicAccount(row(accountId)!) };
  }
  app.post("/api/v1/devices/:id/accounts", (req) => save(req, false));
  app.put("/api/v1/devices/:id/accounts/:accountId", (req) => save(req, true));
  app.delete("/api/v1/devices/:id/accounts/:accountId", async (req) => {
    const { user, deviceId } = request(req, true),
      b = object(req.body);
    version(b);
    keys(b, ["v", "revision"]);
    idle(deviceId);
    const r = row(str((req.params as any).accountId, 1, 128));
    if (!r || r.device_id !== deviceId) fail(404, "TARGET_ACCOUNT_NOT_FOUND");
    if (integer(b.revision, 1, Number.MAX_SAFE_INTEGER) !== r.revision)
      fail(409, "TARGET_ACCOUNT_CHANGED_RELOAD");
    d.store.transaction(() => {
      db.prepare("DELETE FROM target_accounts WHERE id=?").run(r.id);
      d.store.audit("account.deleted", user.id, deviceId, null, {
        account_id: r.id,
        username: r.username,
        method: r.method,
      });
    });
    return { v: 1, ok: true };
  });
  return {
    list,
    requireAccount,
    secret(id: string) {
      const r = row(id);
      if (!r) fail(404, "TARGET_ACCOUNT_NOT_FOUND");
      const secret = credentials.open(id, r.secrets);
      if (r.method === "sudo" && !secret.sudo_password)
        secret.sudo_password = d.sudoPassword(r.device_id)!;
      return secret;
    },
  };
}
