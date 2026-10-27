import { randomUUID } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import type { User } from "./types.js";
import {
  AccountAuthorizations,
  MATCH_SUBJECT,
} from "./account-authorizations.js";
import { hasPermission } from "./permissions.js";
export type SudoRule = {
  id: string;
  device_id: string;
  user_id: string | null;
  group_id: string | null;
  role_id: string | null;
  effect: "allow" | "deny";
  origin: "explicit" | "legacy";
  legacy_role_ids: string;
  revision: number;
};
export function deviceSudo(db: DatabaseSync, user: User, deviceId: string) {
  if (user.api_token_id && !hasPermission(user, "terminal.sudo"))
    return { allowed: false, rules: [] as SudoRule[], reason: "TOKEN_DENIED" };
  const rows = db
    .prepare(
      `SELECT a.* FROM device_sudo_rules a WHERE a.device_id=? AND ${MATCH_SUBJECT} ORDER BY a.id`,
    )
    .all(deviceId, user.id, user.id, user.id, user.id) as unknown as SudoRule[];
  const explicit = rows.filter((r) => r.origin === "explicit");
  const deny = explicit.filter(
    (r) => r.user_id === user.id && r.effect === "deny",
  );
  if (deny.length)
    return { allowed: false, rules: deny, reason: "USER_DENIED" };
  const direct = explicit.filter(
    (r) => r.user_id === user.id && r.effect === "allow",
  );
  if (direct.length)
    return { allowed: true, rules: direct, reason: "USER_ALLOWED" };
  const inherited = explicit.filter((r) => r.effect === "allow");
  const legacy = rows.filter(
    (r) =>
      r.origin === "legacy" &&
      (JSON.parse(r.legacy_role_ids) as string[]).some(
        (id) =>
          !!db
            .prepare(
              "SELECT 1 FROM user_roles WHERE user_id=? AND role_id=? UNION SELECT 1 FROM group_roles gr JOIN group_members gm ON gm.group_id=gr.group_id WHERE gm.user_id=? AND gr.role_id=?",
            )
            .get(user.id, id, user.id, id) &&
          !!db
            .prepare(
              "SELECT 1 FROM access_roles WHERE id=? AND EXISTS(SELECT 1 FROM json_each(permissions) WHERE value='terminal.sudo')",
            )
            .get(id),
      ),
  );
  const allowed = [...inherited, ...legacy];
  return {
    allowed: allowed.length > 0,
    rules: allowed,
    reason: allowed.length ? "INHERITED" : "NOT_GRANTED",
  };
}

// Preserve the old effective user/device intersection once. A migrated rule
// retains its contributing roles; leaving a group/role cannot leave a permanent
// personal grant behind. Sudo rules never contribute ordinary device scope.
export function migrateDeviceSudo(
  db: DatabaseSync,
  configuredUser: (row: any) => User,
) {
  if (db.prepare("SELECT 1 FROM meta WHERE key='device_sudo_v1'").get()) return;
  db.exec("BEGIN IMMEDIATE");
  try {
    const policy = new AccountAuthorizations(db);
    const devices = db
      .prepare("SELECT id FROM devices WHERE revoked_at IS NULL")
      .all();
    for (const row of db.prepare("SELECT * FROM users").all()) {
      const user = configuredUser({ ...row, enabled: 1 });
      if (
        !hasPermission(user, "terminal.connect") ||
        !hasPermission(user, "terminal.sudo")
      )
        continue;
      const roles = user.role_ids!.filter(
        (id) =>
          !!db
            .prepare(
              "SELECT 1 FROM access_roles WHERE id=? AND EXISTS(SELECT 1 FROM json_each(permissions) WHERE value='terminal.sudo')",
            )
            .get(id),
      );
      for (const device of devices) {
        const id = device.id as string;
        if (
          !(user.device_scope === "*" || user.device_scope.includes(id)) ||
          !policy.allowed(user, id, null)
        )
          continue;
        db.prepare(
          "INSERT INTO device_sudo_rules(id,device_id,user_id,effect,origin,legacy_role_ids) VALUES(?,?,?,'allow','legacy',?)",
        ).run(randomUUID(), id, user.id, JSON.stringify(roles));
      }
    }
    db.prepare(
      "INSERT INTO meta(key,value) VALUES('device_sudo_v1','1')",
    ).run();
    db.exec("COMMIT");
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
}
