import type { FastifyInstance, FastifyRequest } from "fastify";
import { randomUUID } from "node:crypto";
import type { Store } from "./store.js";
import type { Scope, User } from "./types.js";
import { PERMISSIONS, type Permission } from "./permissions.js";
import {
  canonical,
  fail,
  integer,
  keys,
  object,
  accountPassword,
  passwordHash,
  passwordVerify,
  str,
  version,
  type RateLimiter,
} from "./util.js";

export const permissionCatalog = [
  {
    id: "devices.read",
    label: "查看设备",
    description: "查看授权设备及网络、健康状态",
  },
  {
    id: "terminal.connect",
    label: "连接终端",
    description: "通过网页或 SSH 入口操作授权设备",
  },
  {
    id: "terminal.sudo",
    label: "允许使用 sudo／root 终端",
    description: "允许在已授权设备打开 root 终端，使用托管凭据或免密 sudo",
  },
  {
    id: "tasks.read",
    label: "查看本人任务",
    description: "查看本人在授权设备上的任务及输出",
  },
  {
    id: "tasks.read_all",
    label: "查看他人任务",
    description:
      "审计授权设备上其他用户的任务、详情及输出，不授予取消他人任务的权限",
  },
  {
    id: "tasks.execute",
    label: "执行命令",
    description: "创建和取消授权设备上的命令任务",
  },
  {
    id: "recordings.read",
    label: "查看本人会话与录制",
    description: "查看本人在授权设备上的终端会话，回放和导出本人的录制",
  },
  {
    id: "recordings.read_all",
    label: "查看他人会话与录制",
    description:
      "审计授权设备上其他用户的终端会话，回放和导出其录制；不授予操作或结束他人会话的权限",
  },
  {
    id: "audit.read",
    label: "查看本人操作审计",
    description: "查看本人发起的操作及结果",
  },
  {
    id: "audit.read_all",
    label: "查看他人操作审计",
    description:
      "审计授权设备上其他用户的操作；设备范围为全部设备时也可查看平台级事件",
  },
  {
    id: "health.manage",
    label: "管理健康检查",
    description: "配置并运行授权设备的业务健康检查",
  },
  {
    id: "network.manage",
    label: "管理网络探测",
    description: "配置授权设备的网络探测",
  },
];
const MAX_REVISION = Number.MAX_SAFE_INTEGER - 1;
export function registerAccessControl(
  app: FastifyInstance,
  d: {
    store: Store;
    admin(req: FastifyRequest): User;
    passwordAuth(req: FastifyRequest): User;
    availableStorage(): void;
    rate: RateLimiter;
    changed(): void;
  },
) {
  const db = d.store.db;
  const ids = (value: unknown, max: number) => {
    if (!Array.isArray(value) || value.length > max)
      fail(400, "INVALID_ACCESS_IDS");
    const result = value.map((id: unknown) => str(id, 1, 128));
    if (new Set(result).size !== result.length)
      fail(400, "DUPLICATE_ACCESS_IDS");
    return result.sort();
  };
  function references(table: string, list: string[]) {
    for (const id of list)
      if (!db.prepare(`SELECT id FROM ${table} WHERE id=?`).get(id))
        fail(400, "UNKNOWN_ACCESS_REFERENCE");
    return list;
  }
  function scope(value: unknown): Scope {
    return value === "*" ? "*" : references("devices", ids(value, 1000));
  }
  function name(value: unknown) {
    const s = str(value, 1, 64).trim();
    if (!s || /[\x00-\x1f\x7f]/.test(s)) fail(400, "INVALID_ACCESS_NAME");
    return s;
  }
  function description(value: unknown) {
    return str(value, 0, 500).trim();
  }
  function unique(table: string, field: string, value: string, except = "") {
    if (
      db
        .prepare(
          `SELECT id FROM ${table} WHERE ${field}=? COLLATE NOCASE AND id<>?`,
        )
        .get(value, except)
    )
      fail(409, "ACCESS_NAME_EXISTS");
  }
  function row(table: string, id: string) {
    const result = db
      .prepare(`SELECT * FROM ${table} WHERE id=?`)
      .get(id) as any;
    if (!result) fail(404, "ACCESS_ENTRY_NOT_FOUND");
    return result;
  }
  function id(req: FastifyRequest) {
    return str((req.params as any).id, 1, 128);
  }
  function checkRevision(current: any, value: unknown) {
    if (integer(value, 0, MAX_REVISION) !== current.revision)
      fail(409, "ACCESS_REVISION_CONFLICT");
  }
  function memberships(
    table: string,
    field: string,
    value: string,
    select: string,
  ): string[] {
    return (
      db
        .prepare(
          `SELECT ${select} AS id FROM ${table} WHERE ${field}=? ORDER BY ${select}`,
        )
        .all(value) as any[]
    ).map((r) => r.id);
  }
  function replace(
    table: string,
    ownerField: string,
    owner: string,
    otherField: string,
    list: string[],
  ) {
    db.prepare(`DELETE FROM ${table} WHERE ${ownerField}=?`).run(owner);
    const insert = db.prepare(
      `INSERT INTO ${table}(${ownerField},${otherField}) VALUES(?,?)`,
    );
    for (const other of list) insert.run(owner, other);
  }
  function userView(r: any) {
    const effective = d.store.user(r);
    return {
      id: r.id,
      username: r.username,
      enabled: !!r.enabled,
      must_change_password: !!r.must_change_password,
      revision: r.revision,
      created_at: r.created_at,
      role_ids: memberships("user_roles", "user_id", r.id, "role_id"),
      group_ids: effective.group_ids,
      device_scope: JSON.parse(r.device_scope),
      effective_role: effective.role,
      effective_permissions: effective.permissions,
      effective_device_scope: effective.device_scope,
      role_names: effective.role_names,
    };
  }
  function roleView(r: any) {
    return {
      id: r.id,
      name: r.name,
      description: r.description,
      permissions: JSON.parse(r.permissions),
      builtin: !!r.builtin,
      revision: r.revision,
      user_count: memberships("user_roles", "role_id", r.id, "user_id").length,
      group_count: memberships("group_roles", "role_id", r.id, "group_id")
        .length,
    };
  }
  function groupView(r: any) {
    return {
      id: r.id,
      name: r.name,
      description: r.description,
      device_scope: JSON.parse(r.device_scope),
      revision: r.revision,
      role_ids: memberships("group_roles", "group_id", r.id, "role_id"),
      member_ids: memberships("group_members", "group_id", r.id, "user_id"),
    };
  }
  function deviceGroupView(r: any) {
    return {
      id: r.id,
      name: r.name,
      description: r.description,
      revision: r.revision,
      device_ids: memberships(
        "device_group_members",
        "group_id",
        r.id,
        "device_id",
      ),
    };
  }
  function setGroupDevices(groupId: string, devices: string[]) {
    // Changing classification tags does not modify any user or user-group grant.
    db.prepare(
      "DELETE FROM device_group_members WHERE group_id=? AND device_id NOT IN (SELECT value FROM json_each(?))",
    ).run(groupId, canonical(devices));
    for (const device of devices)
      db.prepare(
        "INSERT OR IGNORE INTO device_group_members(device_id,group_id) VALUES(?,?)",
      ).run(device, groupId);
  }
  function roleUsers(roleId: string): string[] {
    return (
      db
        .prepare(
          "SELECT user_id AS id FROM user_roles WHERE role_id=? UNION SELECT m.user_id AS id FROM group_members m JOIN group_roles r ON r.group_id=m.group_id WHERE r.role_id=?",
        )
        .all(roleId, roleId) as any[]
    ).map((r) => r.id);
  }
  function invalidate(users: string[]) {
    for (const user of new Set(users)) {
      db.prepare("DELETE FROM user_sessions WHERE user_id=?").run(user);
      db.prepare("UPDATE users SET revision=revision+1 WHERE id=?").run(user);
    }
  }
  function protectAdmins(actor: User) {
    const admins = db
      .prepare(
        "SELECT COUNT(*) AS n FROM users u WHERE u.enabled=1 AND (EXISTS(SELECT 1 FROM user_roles r WHERE r.user_id=u.id AND r.role_id='admin') OR EXISTS(SELECT 1 FROM group_members m JOIN group_roles r ON r.group_id=m.group_id WHERE m.user_id=u.id AND r.role_id='admin'))",
      )
      .get() as any;
    if (!admins.n) fail(409, "LAST_ADMIN_REQUIRED");
    const self = row("users", actor.id);
    if (!self.enabled || d.store.user(self).role !== "admin")
      fail(409, "SELF_ADMIN_REQUIRED");
  }
  function mutate(
    req: FastifyRequest,
    action: string,
    callback: (actor: User) => {
      target: string;
      revision: number;
      changes: unknown;
      result: unknown;
    },
  ) {
    const actor = d.admin(req);
    d.rate.check("access-management:" + actor.id, 60);
    d.availableStorage();
    const result = d.store.transaction(() => {
      const change = callback(actor);
      protectAdmins(actor);
      d.store.audit(action, actor.id, null, null, {
        target_id: change.target,
        revision: change.revision,
        changes: change.changes,
      });
      return change.result;
    });
    d.changed();
    return result;
  }
  function limit(table: string, max: number) {
    if (
      (db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get() as any).n >= max
    )
      fail(409, "ACCESS_ENTRY_LIMIT");
  }
  function userInput(b: Record<string, any>) {
    const username = name(b.username);
    if (!/^[A-Za-z0-9][A-Za-z0-9_.@-]{0,63}$/.test(username))
      fail(400, "INVALID_USERNAME");
    if (typeof b.enabled !== "boolean") fail(400, "INVALID_USER_ENABLED");
    return {
      username,
      enabled: b.enabled,
      role_ids: references("access_roles", ids(b.role_ids, 32)),
      group_ids: references("access_groups", ids(b.group_ids, 100)),
      device_scope: scope(b.device_scope),
    };
  }
  function updateGroups(userId: string, groups: string[]) {
    const previous = memberships(
      "group_members",
      "user_id",
      userId,
      "group_id",
    );
    replace("group_members", "user_id", userId, "group_id", groups);
    for (const group of new Set([...previous, ...groups])) {
      if (previous.includes(group) !== groups.includes(group))
        db.prepare(
          "UPDATE access_groups SET revision=revision+1,updated_at=? WHERE id=?",
        ).run(Date.now(), group);
    }
  }
  function roleInput(b: Record<string, any>) {
    const permissions = ids(b.permissions, PERMISSIONS.length) as Permission[];
    if (permissions.some((p) => !PERMISSIONS.includes(p)))
      fail(400, "INVALID_PERMISSION");
    if (permissions.length && !permissions.includes("devices.read"))
      fail(400, "DEVICE_READ_PERMISSION_REQUIRED");
    if (
      permissions.includes("terminal.sudo") &&
      !permissions.includes("terminal.connect")
    )
      fail(400, "TERMINAL_CONNECT_PERMISSION_REQUIRED");
    if (
      permissions.includes("tasks.execute") &&
      !permissions.includes("tasks.read")
    )
      fail(400, "TASK_READ_PERMISSION_REQUIRED");
    if (
      permissions.includes("recordings.read_all") &&
      !permissions.includes("recordings.read")
    )
      fail(400, "RECORDING_READ_PERMISSION_REQUIRED");
    if (
      permissions.includes("tasks.read_all") &&
      !permissions.includes("tasks.read")
    )
      fail(400, "TASK_READ_PERMISSION_REQUIRED");
    if (
      permissions.includes("audit.read_all") &&
      !permissions.includes("audit.read")
    )
      fail(400, "AUDIT_READ_PERMISSION_REQUIRED");
    return {
      name: name(b.name),
      description: description(b.description),
      permissions,
    };
  }
  function groupInput(b: Record<string, any>) {
    return {
      name: name(b.name),
      description: description(b.description),
      role_ids: references("access_roles", ids(b.role_ids, 32)),
      member_ids: references("users", ids(b.member_ids, 1000)),
      device_scope: scope(b.device_scope),
    };
  }
  app.get("/api/v1/access", async (req) => {
    d.admin(req);
    return {
      v: 1,
      permissions: permissionCatalog,
      users: db
        .prepare("SELECT * FROM users ORDER BY username")
        .all()
        .map(userView),
      roles: db
        .prepare("SELECT * FROM access_roles ORDER BY builtin DESC,name")
        .all()
        .map(roleView),
      groups: db
        .prepare("SELECT * FROM access_groups ORDER BY name")
        .all()
        .map(groupView),
      device_groups: db
        .prepare("SELECT * FROM device_groups ORDER BY name")
        .all()
        .map(deviceGroupView),
    };
  });
  app.post("/api/v1/users", async (req) =>
    mutate(req, "access.user_created", () => {
      const b = object(req.body);
      keys(b, [
        "v",
        "username",
        "password",
        "must_change_password",
        "enabled",
        "role_ids",
        "group_ids",
        "device_scope",
      ]);
      version(b);
      const mustChangePassword = b.must_change_password ?? false;
      if (
        typeof mustChangePassword !== "boolean" ||
        b.must_change_password === null
      )
        fail(400, "INVALID_PASSWORD_CHANGE_REQUIRED");
      const input = {
        ...userInput(b),
        must_change_password: mustChangePassword,
      };
      unique("users", "username", input.username);
      limit("users", 1000);
      const password = passwordHash(accountPassword(b.password)),
        userId = randomUUID();
      db.prepare(
        "INSERT INTO users(id,username,password_hash,role,device_scope,created_at,enabled,must_change_password) VALUES(?,?,?,'business',?,?,?,?)",
      ).run(
        userId,
        input.username,
        password,
        canonical(input.device_scope),
        Date.now(),
        Number(input.enabled),
        Number(input.must_change_password),
      );
      replace("user_roles", "user_id", userId, "role_id", input.role_ids);
      updateGroups(userId, input.group_ids);
      return {
        target: userId,
        revision: 0,
        changes: input,
        result: { v: 1, user: userView(row("users", userId)) },
      };
    }),
  );
  app.put("/api/v1/users/:id", async (req) =>
    mutate(req, "access.user_updated", () => {
      const b = object(req.body);
      keys(b, [
        "v",
        "revision",
        "username",
        "enabled",
        "role_ids",
        "group_ids",
        "device_scope",
      ]);
      version(b);
      const userId = id(req),
        current = row("users", userId);
      checkRevision(current, b.revision);
      const input = userInput(b);
      unique("users", "username", input.username, userId);
      db.prepare(
        "UPDATE users SET username=?,enabled=?,device_scope=? WHERE id=?",
      ).run(
        input.username,
        Number(input.enabled),
        canonical(input.device_scope),
        userId,
      );
      replace("user_roles", "user_id", userId, "role_id", input.role_ids);
      updateGroups(userId, input.group_ids);
      invalidate([userId]);
      return {
        target: userId,
        revision: current.revision + 1,
        changes: input,
        result: { v: 1, user: userView(row("users", userId)) },
      };
    }),
  );
  app.post("/api/v1/me/password", async (req) => {
    const actor = d.passwordAuth(req);
    const b = object(req.body);
    keys(b, ["v", "current_password", "new_password"]);
    version(b);
    const currentPassword = str(b.current_password, 1, 1024);
    const newPassword = accountPassword(b.new_password);
    d.rate.check("password-change-global", 100);
    d.rate.check("password-change-user:" + actor.id, 5);
    d.availableStorage();
    const current = row("users", actor.id);
    if (!passwordVerify(currentPassword, current.password_hash)) {
      d.store.audit("user.password_change_failed", actor.id, null, null);
      // An incorrect current password does not invalidate the authenticated session.
      fail(400, "CURRENT_PASSWORD_INCORRECT");
    }
    if (currentPassword === newPassword) fail(400, "PASSWORD_UNCHANGED");
    const encoded = passwordHash(newPassword);
    d.store.transaction(() => {
      db.prepare(
        "UPDATE users SET password_hash=?,must_change_password=0 WHERE id=?",
      ).run(encoded, actor.id);
      invalidate([actor.id]);
      d.store.audit("access.password_changed", actor.id, null, null, {
        target_id: actor.id,
        revision: current.revision + 1,
        changes: current.must_change_password
          ? { must_change_password: false }
          : {},
      });
    });
    d.changed();
    return { v: 1, ok: true };
  });
  app.post("/api/v1/users/:id/password", async (req) =>
    mutate(req, "access.password_reset", () => {
      const b = object(req.body);
      keys(b, ["v", "revision", "password"]);
      version(b);
      const userId = id(req),
        current = row("users", userId);
      checkRevision(current, b.revision);
      const password = passwordHash(accountPassword(b.password));
      db.prepare("UPDATE users SET password_hash=? WHERE id=?").run(
        password,
        userId,
      );
      invalidate([userId]);
      return {
        target: userId,
        revision: current.revision + 1,
        changes: {},
        result: { v: 1, ok: true },
      };
    }),
  );
  app.post("/api/v1/roles", async (req) =>
    mutate(req, "access.role_created", () => {
      const b = object(req.body);
      keys(b, ["v", "name", "description", "permissions"]);
      version(b);
      const input = roleInput(b);
      unique("access_roles", "name", input.name);
      limit("access_roles", 100);
      const roleId = randomUUID(),
        now = Date.now();
      db.prepare(
        "INSERT INTO access_roles(id,name,description,permissions,created_at,updated_at) VALUES(?,?,?,?,?,?)",
      ).run(
        roleId,
        input.name,
        input.description,
        canonical(input.permissions),
        now,
        now,
      );
      return {
        target: roleId,
        revision: 0,
        changes: input,
        result: { v: 1, role: roleView(row("access_roles", roleId)) },
      };
    }),
  );
  app.put("/api/v1/roles/:id", async (req) =>
    mutate(req, "access.role_updated", () => {
      const b = object(req.body);
      keys(b, ["v", "revision", "name", "description", "permissions"]);
      version(b);
      const roleId = id(req),
        current = row("access_roles", roleId);
      checkRevision(current, b.revision);
      if (current.builtin) fail(409, "BUILTIN_ROLE_READ_ONLY");
      const input = roleInput(b);
      unique("access_roles", "name", input.name, roleId);
      db.prepare(
        "UPDATE access_roles SET name=?,description=?,permissions=?,revision=revision+1,updated_at=? WHERE id=?",
      ).run(
        input.name,
        input.description,
        canonical(input.permissions),
        Date.now(),
        roleId,
      );
      invalidate(roleUsers(roleId));
      return {
        target: roleId,
        revision: current.revision + 1,
        changes: input,
        result: { v: 1, role: roleView(row("access_roles", roleId)) },
      };
    }),
  );
  app.delete("/api/v1/roles/:id", async (req) =>
    mutate(req, "access.role_deleted", () => {
      const b = object(req.body);
      keys(b, ["v", "revision"]);
      version(b);
      const roleId = id(req),
        current = row("access_roles", roleId);
      checkRevision(current, b.revision);
      if (current.builtin) fail(409, "BUILTIN_ROLE_READ_ONLY");
      if (
        memberships("user_roles", "role_id", roleId, "user_id").length ||
        memberships("group_roles", "role_id", roleId, "group_id").length
      )
        fail(409, "ROLE_IN_USE");
      db.prepare("DELETE FROM access_roles WHERE id=?").run(roleId);
      return {
        target: roleId,
        revision: current.revision + 1,
        changes: { name: current.name },
        result: { v: 1, ok: true },
      };
    }),
  );
  app.post("/api/v1/groups", async (req) =>
    mutate(req, "access.group_created", () => {
      const b = object(req.body);
      keys(b, [
        "v",
        "name",
        "description",
        "role_ids",
        "member_ids",
        "device_scope",
      ]);
      version(b);
      const input = groupInput(b);
      unique("access_groups", "name", input.name);
      limit("access_groups", 100);
      const groupId = randomUUID(),
        now = Date.now();
      db.prepare(
        "INSERT INTO access_groups(id,name,description,device_scope,created_at,updated_at) VALUES(?,?,?,?,?,?)",
      ).run(
        groupId,
        input.name,
        input.description,
        canonical(input.device_scope),
        now,
        now,
      );
      replace("group_roles", "group_id", groupId, "role_id", input.role_ids);
      replace(
        "group_members",
        "group_id",
        groupId,
        "user_id",
        input.member_ids,
      );
      invalidate(input.member_ids);
      return {
        target: groupId,
        revision: 0,
        changes: input,
        result: { v: 1, group: groupView(row("access_groups", groupId)) },
      };
    }),
  );
  app.put("/api/v1/groups/:id", async (req) =>
    mutate(req, "access.group_updated", () => {
      const b = object(req.body);
      keys(b, [
        "v",
        "revision",
        "name",
        "description",
        "role_ids",
        "member_ids",
        "device_scope",
      ]);
      version(b);
      const groupId = id(req),
        current = row("access_groups", groupId);
      checkRevision(current, b.revision);
      const input = groupInput(b);
      unique("access_groups", "name", input.name, groupId);
      const previous = memberships(
        "group_members",
        "group_id",
        groupId,
        "user_id",
      );
      db.prepare(
        "UPDATE access_groups SET name=?,description=?,device_scope=?,revision=revision+1,updated_at=? WHERE id=?",
      ).run(
        input.name,
        input.description,
        canonical(input.device_scope),
        Date.now(),
        groupId,
      );
      replace("group_roles", "group_id", groupId, "role_id", input.role_ids);
      replace(
        "group_members",
        "group_id",
        groupId,
        "user_id",
        input.member_ids,
      );
      invalidate([...previous, ...input.member_ids]);
      return {
        target: groupId,
        revision: current.revision + 1,
        changes: input,
        result: { v: 1, group: groupView(row("access_groups", groupId)) },
      };
    }),
  );
  app.delete("/api/v1/groups/:id", async (req) =>
    mutate(req, "access.group_deleted", () => {
      const b = object(req.body);
      keys(b, ["v", "revision"]);
      version(b);
      const groupId = id(req),
        current = row("access_groups", groupId);
      checkRevision(current, b.revision);
      const members = memberships(
        "group_members",
        "group_id",
        groupId,
        "user_id",
      );
      db.prepare("DELETE FROM access_groups WHERE id=?").run(groupId);
      invalidate(members);
      return {
        target: groupId,
        revision: current.revision + 1,
        changes: { name: current.name },
        result: { v: 1, ok: true },
      };
    }),
  );
  function deviceGroupInput(b: Record<string, any>) {
    return {
      name: name(b.name),
      description: description(b.description),
      device_ids: references("devices", ids(b.device_ids, 1000)),
    };
  }
  app.get("/api/v1/device-groups", async (req) => {
    d.admin(req);
    return {
      v: 1,
      device_groups: db
        .prepare("SELECT * FROM device_groups ORDER BY name")
        .all()
        .map(deviceGroupView),
    };
  });
  app.post("/api/v1/device-groups/batch", async (req) =>
    mutate(req, "access.device_tags_updated", () => {
      const b = object(req.body);
      keys(b, ["v", "operation", "device_ids", "group_ids"]);
      version(b);
      if (b.operation !== "add" && b.operation !== "remove")
        fail(400, "INVALID_TAG_OPERATION");
      const devices = references("devices", ids(b.device_ids, 1000)),
        groups = references("device_groups", ids(b.group_ids, 100));
      if (!devices.length || !groups.length) fail(400, "EMPTY_TAG_SELECTION");
      const devicesJson = canonical(devices);
      let count = 0;
      for (const group of groups) {
        if (b.operation === "add") {
          const total = db
            .prepare(
              "SELECT COUNT(*) AS n FROM (SELECT device_id FROM device_group_members WHERE group_id=? UNION SELECT value FROM json_each(?))",
            )
            .get(group, devicesJson) as any;
          if (total.n > 1000) fail(409, "DEVICE_GROUP_SIZE_LIMIT");
          count += Number(
            db
              .prepare(
                "INSERT OR IGNORE INTO device_group_members(device_id,group_id) SELECT value,? FROM json_each(?)",
              )
              .run(group, devicesJson).changes,
          );
        } else {
          count += Number(
            db
              .prepare(
                "DELETE FROM device_group_members WHERE group_id=? AND device_id IN (SELECT value FROM json_each(?))",
              )
              .run(group, devicesJson).changes,
          );
        }
        db.prepare("UPDATE device_groups SET updated_at=? WHERE id=?").run(
          Date.now(),
          group,
        );
      }
      return {
        target: randomUUID(),
        revision: 0,
        changes: {
          operation: b.operation,
          device_ids: devices,
          group_ids: groups,
        },
        result: { v: 1, changed_count: count },
      };
    }),
  );
  app.post("/api/v1/device-groups", async (req) =>
    mutate(req, "access.device_group_created", () => {
      const b = object(req.body);
      keys(b, ["v", "name", "description", "device_ids"]);
      version(b);
      const input = deviceGroupInput(b);
      unique("device_groups", "name", input.name);
      limit("device_groups", 100);
      const groupId = randomUUID(),
        now = Date.now();
      db.prepare(
        "INSERT INTO device_groups(id,name,description,created_at,updated_at) VALUES(?,?,?,?,?)",
      ).run(groupId, input.name, input.description, now, now);
      setGroupDevices(groupId, input.device_ids);
      const group = deviceGroupView(row("device_groups", groupId));
      return {
        target: groupId,
        revision: group.revision,
        changes: input,
        result: { v: 1, device_group: group },
      };
    }),
  );
  app.put("/api/v1/device-groups/:id", async (req) =>
    mutate(req, "access.device_group_updated", () => {
      const b = object(req.body);
      keys(b, ["v", "revision", "name", "description", "device_ids"]);
      version(b);
      const groupId = id(req),
        current = row("device_groups", groupId);
      checkRevision(current, b.revision);
      const input = deviceGroupInput(b);
      unique("device_groups", "name", input.name, groupId);
      db.prepare(
        "UPDATE device_groups SET name=?,description=?,revision=revision+1,updated_at=? WHERE id=?",
      ).run(input.name, input.description, Date.now(), groupId);
      setGroupDevices(groupId, input.device_ids);
      const group = deviceGroupView(row("device_groups", groupId));
      return {
        target: groupId,
        revision: group.revision,
        changes: input,
        result: { v: 1, device_group: group },
      };
    }),
  );
  app.delete("/api/v1/device-groups/:id", async (req) =>
    mutate(req, "access.device_group_deleted", () => {
      const b = object(req.body);
      keys(b, ["v", "revision"]);
      version(b);
      const groupId = id(req),
        current = row("device_groups", groupId);
      checkRevision(current, b.revision);
      db.prepare("DELETE FROM device_groups WHERE id=?").run(groupId);
      return {
        target: groupId,
        revision: current.revision + 1,
        changes: { name: current.name },
        result: { v: 1, ok: true },
      };
    }),
  );
}
