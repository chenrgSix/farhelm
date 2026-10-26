import { randomUUID } from "node:crypto";
import type { FastifyInstance, FastifyRequest } from "fastify";
import type { Store } from "./store.js";
import type { User } from "./types.js";
import type { registerConnectionAuthorizations } from "./connection-authorizations.js";
import {
  defaultAccountId,
  type AccountAuthorization,
} from "./account-authorizations.js";
import { hasPermission } from "./permissions.js";
import { fail, integer, keys, object, str, version } from "./util.js";
export function registerAccessAuthorizations(
  app: FastifyInstance,
  d: {
    store: Store;
    admin(req: FastifyRequest): User;
    authorization: ReturnType<typeof registerConnectionAuthorizations>;
    changed(): void;
    availableStorage(): void;
  },
) {
  const db = d.store.db,
    policy = d.authorization.policy;
  const scope = (user: User, id: string) =>
    user.role === "admin" ||
    user.device_scope === "*" ||
    user.device_scope.includes(id);
  function choices(admin: User) {
    const devices = db
      .prepare(
        "SELECT id,name FROM devices WHERE revoked_at IS NULL ORDER BY name,id",
      )
      .all() as { id: string; name: string }[];
    return {
      devices,
      accounts: devices.flatMap((device) => {
        policy.ensureDefault(device.id);
        return d.authorization.loginAccounts(admin, device.id);
      }),
    };
  }
  function view(row: AccountAuthorization) {
    const subject_type = row.inherit_scope
      ? "device_scope"
      : row.user_id
        ? "user"
        : row.group_id
          ? "group"
          : "role";
    const subject_id = row.user_id ?? row.group_id ?? row.role_id;
    const subject_name = row.inherit_scope
      ? "继承原设备授权"
      : (row.user_id
          ? db
              .prepare("SELECT username AS name FROM users WHERE id=?")
              .get(row.user_id)
          : row.group_id
            ? db
                .prepare("SELECT name FROM access_groups WHERE id=?")
                .get(row.group_id)
            : db
                .prepare("SELECT name FROM access_roles WHERE id=?")
                .get(row.role_id!)
        )?.name;
    return {
      id: row.id,
      device_id: row.device_id,
      account_id: row.account_id ?? defaultAccountId(row.device_id),
      subject_type,
      subject_id,
      subject_name: String(subject_name ?? "已删除对象"),
      legacy_scope: !!row.legacy_scope,
      revision: row.revision,
    };
  }
  app.get("/api/v1/access-authorizations", async (req) => {
    const admin = d.admin(req),
      resources = choices(admin);
    return {
      v: 1,
      ...resources,
      rules: (
        db
          .prepare(
            "SELECT a.* FROM account_authorizations a JOIN devices d ON d.id=a.device_id WHERE d.revoked_at IS NULL AND a.account_id IS NULL ORDER BY d.name,a.id",
          )
          .all() as unknown as AccountAuthorization[]
      ).map(view),
    };
  });
  app.post("/api/v1/access-authorizations", async (req) => {
    const admin = d.admin(req),
      b = object(req.body);
    version(b);
    keys(b, ["v", "device_id", "account_ids", "subject_type", "subject_id"]);
    const deviceId = str(b.device_id, 1, 128);
    if (
      !db
        .prepare("SELECT 1 FROM devices WHERE id=? AND revoked_at IS NULL")
        .get(deviceId)
    )
      fail(404, "DEVICE_NOT_FOUND");
    if (!["user", "group", "role", "device_scope"].includes(b.subject_type))
      fail(400, "INVALID_AUTHORIZATION_SUBJECT");
    const subjectId =
      b.subject_type === "device_scope" ? null : str(b.subject_id, 1, 128);
    if (b.subject_type === "device_scope" && b.subject_id != null)
      fail(400, "INVALID_AUTHORIZATION_SUBJECT");
    const table =
      b.subject_type === "user"
        ? "users"
        : b.subject_type === "group"
          ? "access_groups"
          : "access_roles";
    if (
      subjectId &&
      !db
        .prepare(
          `SELECT 1 FROM ${table} WHERE id=?${table === "users" ? " AND enabled=1" : ""}`,
        )
        .get(subjectId)
    )
      fail(400, "INVALID_AUTHORIZATION_SUBJECT");
    // Omission authorizes the configured ordinary connection. Keep old clients
    // that explicitly identify that same default compatible, without accepting
    // archived accounts or copying any of their grants.
    if (Object.hasOwn(b, "account_ids")) {
      if (!Array.isArray(b.account_ids) || b.account_ids.length !== 1)
        fail(400, "INVALID_AUTHORIZATION_ACCOUNTS");
      if (b.account_ids[0] !== defaultAccountId(deviceId))
        fail(400, "ACCOUNT_AUTHORIZATION_REMOVED");
    }
    const accountIds = [null];
    d.availableStorage();
    const added = d.store.transaction(() => {
      policy.ensureDefault(deviceId);
      const ids: string[] = [];
      for (const accountId of accountIds) {
        const userId = b.subject_type === "user" ? subjectId : null;
        const groupId = b.subject_type === "group" ? subjectId : null;
        const roleId = b.subject_type === "role" ? subjectId : null;
        const inherited = Number(b.subject_type === "device_scope");
        const old = db
          .prepare(
            "SELECT id FROM account_authorizations WHERE device_id=? AND account_id IS ? AND user_id IS ? AND group_id IS ? AND role_id IS ? AND inherit_scope=? AND legacy_scope=?",
          )
          .get(
            deviceId,
            accountId,
            userId,
            groupId,
            roleId,
            inherited,
            inherited,
          );
        if (old) {
          ids.push(old.id as string);
          continue;
        }
        const id = randomUUID();
        db.prepare(
          "INSERT INTO account_authorizations(id,device_id,account_id,user_id,group_id,role_id,inherit_scope,legacy_scope) VALUES(?,?,?,?,?,?,?,?)",
        ).run(
          id,
          deviceId,
          accountId,
          userId,
          groupId,
          roleId,
          inherited,
          inherited,
        );
        d.store.audit(
          "access.authorization_created",
          admin.id,
          deviceId,
          null,
          {
            rule_id: id,
            account_id: accountId ?? defaultAccountId(deviceId),
            subject_type: b.subject_type,
            subject_id: subjectId,
          },
        );
        ids.push(id);
      }
      return ids;
    });
    d.changed();
    return { v: 1, rule_ids: added };
  });
  app.delete("/api/v1/access-authorizations/:id", async (req) => {
    const admin = d.admin(req),
      b = object(req.body);
    version(b);
    keys(b, ["v", "revision"]);
    const id = str((req.params as any).id, 1, 128);
    d.store.transaction(() => {
      const row = db
        .prepare("SELECT * FROM account_authorizations WHERE id=?")
        .get(id) as unknown as AccountAuthorization | undefined;
      if (!row) fail(404, "AUTHORIZATION_NOT_FOUND");
      if (row.account_id !== null) fail(410, "ACCOUNT_AUTHORIZATION_REMOVED");
      if (integer(b.revision, 1, Number.MAX_SAFE_INTEGER) !== row.revision)
        fail(409, "AUTHORIZATION_CHANGED_RELOAD");
      db.prepare("DELETE FROM account_authorizations WHERE id=?").run(id);
      const current = view(row);
      d.store.audit(
        "access.authorization_deleted",
        admin.id,
        row.device_id,
        null,
        {
          rule_id: id,
          account_id: current.account_id,
          subject_type: current.subject_type,
          subject_id: current.subject_id,
        },
      );
    });
    d.changed();
    return { v: 1, ok: true };
  });
  app.get("/api/v1/access-authorizations/effective/:userId", async (req) => {
    const admin = d.admin(req),
      id = str((req.params as any).userId, 1, 128);
    const row = db.prepare("SELECT * FROM users WHERE id=?").get(id);
    if (!row) fail(404, "USER_NOT_FOUND");
    const user = d.store.user(row),
      resources = choices(admin);
    const accounts = resources.accounts.flatMap((account) => {
      const accountId = null;
      const reasons =
        user.role === "admin"
          ? ["管理员全平台权限"]
          : policy
              .matches(user, account.device_id, accountId, true)
              .map((r) => {
                const v = view(r);
                return (
                  v.subject_name +
                  (v.legacy_scope && !r.inherit_scope
                    ? "（原账号授权，受原设备范围限制）"
                    : "")
                );
              });
      if (!reasons.length) return [];
      const missing: string[] = [];
      if (!policy.allowed(user, account.device_id, accountId))
        missing.push("原设备范围");
      if (!row.enabled) missing.push("用户已停用");
      if (user.must_change_password) missing.push("须先修改密码");
      if (!scope(user, account.device_id)) missing.push("设备范围");
      if (!hasPermission(user, "terminal.connect"))
        missing.push("终端连接权限");
      if (
        account.is_default &&
        d.authorization.defaultNeedsSudo(user, account.device_id) &&
        !hasPermission(user, "terminal.sudo")
      )
        missing.push("sudo／特权账号权限");
      return [{ ...account, allowed: !missing.length, reasons, missing }];
    });
    return {
      v: 1,
      user: {
        id: user.id,
        username: user.username,
        role_names: user.role_names,
        permissions: user.permissions,
      },
      accounts,
    };
  });
}
