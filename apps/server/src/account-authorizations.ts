import { createHash, randomUUID } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import type { User, Scope } from "./types.js";
export interface AccountAuthorization {
  id: string;
  device_id: string;
  account_id: string | null;
  user_id: string | null;
  group_id: string | null;
  role_id: string | null;
  inherit_scope: number;
  legacy_scope: number;
  revision: number;
}
export const MATCH_SUBJECT = `(a.user_id=? OR a.group_id IN (SELECT group_id FROM group_members WHERE user_id=?) OR a.role_id IN (SELECT role_id FROM user_roles WHERE user_id=? UNION SELECT r.role_id FROM group_roles r JOIN group_members m ON m.group_id=r.group_id WHERE m.user_id=?))`;
export function defaultAccountId(deviceId: string) {
  const bytes = createHash("sha256")
    .update("farhelm:default:" + deviceId)
    .digest();
  bytes[6] = (bytes[6]! & 15) | 80;
  bytes[8] = (bytes[8]! & 63) | 128;
  const h = bytes.subarray(0, 16).toString("hex");
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
}
export function legacyScope(db: DatabaseSync, userId: string): Scope {
  const row = db
    .prepare("SELECT device_scope FROM users WHERE id=?")
    .get(userId);
  const scopes: Scope[] = [
    row ? JSON.parse(row.device_scope as string) : [],
    ...db
      .prepare(
        "SELECT g.device_scope FROM access_groups g JOIN group_members m ON m.group_id=g.id WHERE m.user_id=?",
      )
      .all(userId)
      .map((g) => JSON.parse(g.device_scope as string)),
  ];
  return scopes.includes("*")
    ? "*"
    : [...new Set(scopes.flatMap((s) => (s === "*" ? [] : s)))];
}
export function grantedDevices(db: DatabaseSync, userId: string): string[] {
  return db
    .prepare(
      `SELECT DISTINCT a.device_id FROM account_authorizations a WHERE a.legacy_scope=0 AND a.inherit_scope=0 AND ${MATCH_SUBJECT}`,
    )
    .all(userId, userId, userId, userId)
    .map((r) => r.device_id as string);
}
export class AccountAuthorizations {
  constructor(private db: DatabaseSync) {}
  ensureDefault(deviceId: string) {
    if (
      this.db
        .prepare("SELECT 1 FROM default_account_policies WHERE device_id=?")
        .get(deviceId)
    )
      return;
    this.db.exec("SAVEPOINT ensure_default_account");
    try {
      const fresh = this.db
        .prepare(
          "INSERT OR IGNORE INTO default_account_policies(device_id) VALUES(?)",
        )
        .run(deviceId).changes;
      if (fresh)
        this.db
          .prepare(
            "INSERT INTO account_authorizations(id,device_id,inherit_scope,legacy_scope) VALUES(?,?,1,1)",
          )
          .run(randomUUID(), deviceId);
      this.db.exec("RELEASE ensure_default_account");
    } catch (error) {
      this.db.exec(
        "ROLLBACK TO ensure_default_account; RELEASE ensure_default_account",
      );
      throw error;
    }
  }
  rows(deviceId: string, accountId: string | null) {
    return this.db
      .prepare(
        "SELECT * FROM account_authorizations WHERE device_id=? AND account_id IS ? ORDER BY id",
      )
      .all(deviceId, accountId) as unknown as AccountAuthorization[];
  }
  matches(
    user: User,
    deviceId: string,
    accountId: string | null,
    includeBlocked = false,
  ) {
    if (accountId === null) this.ensureDefault(deviceId);
    const original = legacyScope(this.db, user.id);
    const scoped = original === "*" || original.includes(deviceId);
    return this.db
      .prepare(
        `SELECT * FROM account_authorizations a WHERE a.device_id=? AND a.account_id IS ? AND (a.legacy_scope=0 OR ?) AND ((a.inherit_scope=1 AND ?) OR ${MATCH_SUBJECT}) ORDER BY a.id`,
      )
      .all(
        deviceId,
        accountId,
        Number(scoped || includeBlocked),
        Number(scoped),
        user.id,
        user.id,
        user.id,
        user.id,
      ) as unknown as AccountAuthorization[];
  }
  allowed(user: User, deviceId: string, accountId: string | null) {
    if (accountId === null) this.ensureDefault(deviceId);
    return (
      user.role === "admin" ||
      this.matches(user, deviceId, accountId).length > 0
    );
  }
  grants(deviceId: string, accountId: string) {
    const rows = this.rows(deviceId, accountId);
    return {
      allowed_users: [
        ...new Set(rows.flatMap((r) => (r.user_id ? [r.user_id] : []))),
      ].sort(),
      allowed_groups: [
        ...new Set(rows.flatMap((r) => (r.group_id ? [r.group_id] : []))),
      ].sort(),
      allowed_roles: [
        ...new Set(rows.flatMap((r) => (r.role_id ? [r.role_id] : []))),
      ].sort(),
    };
  }
  replaceLegacy(
    deviceId: string,
    accountId: string,
    grants: {
      allowed_users: string[];
      allowed_groups: string[];
      allowed_roles: string[];
    },
  ) {
    const wanted = new Map<
      string,
      { column: "user_id" | "group_id" | "role_id"; id: string }
    >();
    for (const [column, ids] of [
      ["user_id", grants.allowed_users],
      ["group_id", grants.allowed_groups],
      ["role_id", grants.allowed_roles],
    ] as const)
      for (const id of ids) wanted.set(`${column}:${id}`, { column, id });
    for (const rule of this.rows(deviceId, accountId)) {
      const column = rule.user_id
        ? "user_id"
        : rule.group_id
          ? "group_id"
          : "role_id";
      const key = `${column}:${rule[column]}`;
      if (wanted.has(key)) wanted.delete(key);
      else if (
        !grants.allowed_users.includes(rule.user_id ?? "") &&
        !grants.allowed_groups.includes(rule.group_id ?? "") &&
        !grants.allowed_roles.includes(rule.role_id ?? "")
      )
        this.db
          .prepare("DELETE FROM account_authorizations WHERE id=?")
          .run(rule.id);
    }
    // Preserve the IDs and scope semantics of unchanged explicit grants, even for old clients.
    for (const { column, id } of wanted.values())
      this.db
        .prepare(
          `INSERT INTO account_authorizations(id,device_id,account_id,${column},legacy_scope) VALUES(?,?,?,?,1)`,
        )
        .run(randomUUID(), deviceId, accountId, id);
  }
}
export function migrateAccountAuthorizations(db: DatabaseSync) {
  if (
    db.prepare("SELECT 1 FROM meta WHERE key='account_authorizations_v1'").get()
  )
    return;
  db.exec("BEGIN IMMEDIATE");
  try {
    const policy = new AccountAuthorizations(db);
    for (const device of db.prepare("SELECT id FROM devices").all())
      policy.ensureDefault(device.id as string);
    for (const row of db
      .prepare("SELECT id,device_id,allowed_users FROM target_accounts")
      .all()) {
      const accountId = row.id as string;
      policy.replaceLegacy(row.device_id as string, accountId, {
        allowed_users: (
          JSON.parse(row.allowed_users as string) as string[]
        ).filter(
          (id) => !!db.prepare("SELECT 1 FROM users WHERE id=?").get(id),
        ),
        allowed_groups: db
          .prepare(
            "SELECT group_id FROM target_account_groups WHERE account_id=?",
          )
          .all(accountId)
          .map((r) => r.group_id as string),
        allowed_roles: db
          .prepare(
            "SELECT role_id FROM target_account_roles WHERE account_id=?",
          )
          .all(accountId)
          .map((r) => r.role_id as string),
      });
    }
    db.prepare(
      "INSERT INTO meta(key,value) VALUES('account_authorizations_v1','1')",
    ).run();
    db.exec("COMMIT");
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
}
