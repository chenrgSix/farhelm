import { DatabaseSync } from "node:sqlite";
import { auditContext } from "./audit-context.js";
import { randomUUID } from "node:crypto";
import { readFileSync, mkdirSync, chmodSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { accountPassword, passwordHash, canonical, fail, str } from "./util.js";
import type { User, Role, Scope, Task } from "./types.js";
import type { Permission } from "./permissions.js";
export class Store {
  readonly db: DatabaseSync;
  readonly instance: string;
  constructor(public dataDir: string) {
    mkdirSync(dataDir, { recursive: true, mode: 0o700 });
    chmodSync(dataDir, 0o700);
    this.db = new DatabaseSync(join(dataDir, "fleet.sqlite"));
    chmodSync(join(dataDir, "fleet.sqlite"), 0o600);
    this.db.exec(
      "PRAGMA journal_mode=WAL;PRAGMA synchronous=FULL;PRAGMA foreign_keys=ON;PRAGMA busy_timeout=5000;",
    );
    this.db.exec(
      readFileSync(
        fileURLToPath(
          new URL("../migrations/001_initial.sql", import.meta.url),
        ),
        "utf8",
      ),
    );
    this.db.exec(
      readFileSync(
        new URL("../migrations/002_terminal.sql", import.meta.url),
        "utf8",
      ),
    );
    this.db.exec(
      readFileSync(
        new URL("../migrations/003_terminal_close_status.sql", import.meta.url),
        "utf8",
      ),
    );
    this.db.exec(
      readFileSync(
        new URL("../migrations/004_health_checks.sql", import.meta.url),
        "utf8",
      ),
    );
    if (
      !(
        this.db.prepare("PRAGMA table_info(terminal_sessions)").all() as any[]
      ).some((c) => c.name === "transport")
    ) {
      this.transaction(() =>
        this.db.exec(
          readFileSync(
            new URL(
              "../migrations/005_terminal_transport.sql",
              import.meta.url,
            ),
            "utf8",
          ),
        ),
      );
    }
    if (
      !(this.db.prepare("PRAGMA table_info(devices)").all() as any[]).some(
        (c) => c.name === "connection_kind",
      )
    ) {
      this.transaction(() =>
        this.db.exec(
          readFileSync(
            new URL(
              "../migrations/006_device_connections.sql",
              import.meta.url,
            ),
            "utf8",
          ),
        ),
      );
    }
    this.db.exec(
      readFileSync(
        new URL("../migrations/007_agent_installations.sql", import.meta.url),
        "utf8",
      ),
    );
    this.db.exec(
      readFileSync(
        new URL("../migrations/008_system_settings.sql", import.meta.url),
        "utf8",
      ),
    );
    this.db.exec(
      readFileSync(
        new URL("../migrations/009_agent_address_sync.sql", import.meta.url),
        "utf8",
      ),
    );
    this.db.exec(
      readFileSync(
        new URL("../migrations/010_agent_upgrades.sql", import.meta.url),
        "utf8",
      ),
    );
    this.db.exec(
      readFileSync(
        new URL("../migrations/011_agent_releases.sql", import.meta.url),
        "utf8",
      ),
    );
    this.db.exec(
      readFileSync(
        new URL("../migrations/012_agent_network.sql", import.meta.url),
        "utf8",
      ),
    );
    this.db.exec(
      readFileSync(
        new URL("../migrations/013_network_probes.sql", import.meta.url),
        "utf8",
      ),
    );
    if (
      !(this.db.prepare("PRAGMA table_info(users)").all() as any[]).some(
        (c) => c.name === "enabled",
      )
    ) {
      this.transaction(() =>
        this.db.exec(
          readFileSync(
            new URL("../migrations/014_access_control.sql", import.meta.url),
            "utf8",
          ),
        ),
      );
    }
    if (
      !this.db
        .prepare(
          "SELECT name FROM sqlite_master WHERE type='table' AND name='device_groups'",
        )
        .get()
    ) {
      this.transaction(() =>
        this.db.exec(
          readFileSync(
            new URL("../migrations/015_device_groups.sql", import.meta.url),
            "utf8",
          ),
        ),
      );
    }
    if (
      !(
        this.db.prepare("PRAGMA table_info(enrollment_tokens)").all() as any[]
      ).some((c) => c.name === "target_device_id")
    ) {
      this.transaction(() =>
        this.db.exec(
          readFileSync(
            new URL("../migrations/016_ssh_agent_install.sql", import.meta.url),
            "utf8",
          ),
        ),
      );
    }
    this.db.exec(
      readFileSync(
        new URL("../migrations/017_certificates.sql", import.meta.url),
        "utf8",
      ),
    );
    if (
      !(
        this.db
          .prepare("PRAGMA table_info(certificate_settings)")
          .all() as any[]
      ).some((c) => c.name === "mode")
    ) {
      this.transaction(() =>
        this.db.exec(
          readFileSync(
            new URL(
              "../migrations/018_private_certificates.sql",
              import.meta.url,
            ),
            "utf8",
          ),
        ),
      );
    }
    if (
      !this.db
        .prepare(
          "SELECT name FROM sqlite_master WHERE type='table' AND name='agent_ca_sync'",
        )
        .get()
    ) {
      this.transaction(() =>
        this.db.exec(
          readFileSync(
            new URL("../migrations/019_agent_ca_sync.sql", import.meta.url),
            "utf8",
          ),
        ),
      );
    }
    this.db.exec(
      readFileSync(
        new URL("../migrations/020_history.sql", import.meta.url),
        "utf8",
      ),
    );
    if (
      !(
        this.db
          .prepare("PRAGMA table_info(certificate_settings)")
          .all() as any[]
      ).some((c) => c.name === "challenge_type")
    ) {
      this.transaction(() =>
        this.db.exec(
          readFileSync(
            new URL(
              "../migrations/021_certificate_challenge.sql",
              import.meta.url,
            ),
            "utf8",
          ),
        ),
      );
    }
    this.transaction(() =>
      this.db.exec(
        readFileSync(
          new URL(
            "../migrations/022_recording_visibility.sql",
            import.meta.url,
          ),
          "utf8",
        ),
      ),
    );
    this.transaction(() =>
      this.db.exec(
        readFileSync(
          new URL("../migrations/023_history_visibility.sql", import.meta.url),
          "utf8",
        ),
      ),
    );
    if (
      !(this.db.prepare("PRAGMA table_info(audit)").all() as any[]).some(
        (c) => c.name === "request_context",
      )
    ) {
      this.transaction(() =>
        this.db.exec(
          readFileSync(
            new URL("../migrations/024_audit_context.sql", import.meta.url),
            "utf8",
          ),
        ),
      );
    }
    this.db.exec(
      readFileSync(
        new URL("../migrations/025_network_routes.sql", import.meta.url),
        "utf8",
      ),
    );
    this.db.exec(
      readFileSync(
        new URL("../migrations/026_platform_network.sql", import.meta.url),
        "utf8",
      ),
    );
    if (
      !(this.db.prepare("PRAGMA table_info(users)").all() as any[]).some(
        (c) => c.name === "must_change_password",
      )
    ) {
      this.transaction(() =>
        this.db.exec(
          readFileSync(
            new URL(
              "../migrations/027_first_login_password.sql",
              import.meta.url,
            ),
            "utf8",
          ),
        ),
      );
    }
    this.db.exec(
      readFileSync(
        new URL("../migrations/028_api_tokens.sql", import.meta.url),
        "utf8",
      ),
    );
    this.db
      .prepare(
        "INSERT OR IGNORE INTO meta(key,value) VALUES ('server_instance',?)",
      )
      .run(randomUUID());
    this.instance = (
      this.db
        .prepare("SELECT value FROM meta WHERE key='server_instance'")
        .get() as any
    ).value;
  }
  transaction<T>(fn: () => T): T {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const result = fn();
      this.db.exec("COMMIT");
      return result;
    } catch (e) {
      this.db.exec("ROLLBACK");
      throw e;
    }
  }
  audit(
    action: string,
    actorId: string | null,
    deviceId: string | null,
    taskId: string | null,
    detail: unknown = {},
  ) {
    const username = actorId
      ? ((
          this.db
            .prepare("SELECT username FROM users WHERE id=?")
            .get(actorId) as any
        )?.username ?? null)
      : null;
    const deviceName = deviceId
      ? ((
          this.db
            .prepare("SELECT name FROM devices WHERE id=?")
            .get(deviceId) as any
        )?.name ?? null)
      : null;
    const data =
      detail && typeof detail === "object" && !Array.isArray(detail)
        ? (detail as Record<string, any>)
        : {};
    const targetTable =
      action.startsWith("access.user_") ||
      ["access.password_reset", "access.password_changed"].includes(action)
        ? "users"
        : action.startsWith("access.role_")
          ? "access_roles"
          : action.startsWith("access.group_")
            ? "access_groups"
            : action.startsWith("access.device_group_")
              ? "device_groups"
              : null;
    const target =
      targetTable && typeof data.target_id === "string"
        ? (this.db
            .prepare(
              `SELECT ${targetTable === "users" ? "username" : "name"} AS name FROM ${targetTable} WHERE id=?`,
            )
            .get(data.target_id) as any)
        : undefined;
    const targetName =
      target?.name ?? data.changes?.username ?? data.changes?.name ?? null;
    this.db
      .prepare(
        "INSERT INTO audit(at,actor_id,device_id,task_id,action,detail_json,actor_username,device_name,target_name,request_context) VALUES(?,?,?,?,?,?,?,?,?,?)",
      )
      .run(
        Date.now(),
        actorId,
        deviceId,
        taskId,
        action,
        canonical(detail),
        username,
        deviceName,
        targetName,
        JSON.stringify(auditContext.getStore() ?? { source: "system" }),
      );
  }
  seedUser(input: {
    username: string;
    password: string;
    role: Role;
    deviceScope: Scope;
  }): User {
    str(input.username, 1, 128);
    accountPassword(input.password);
    if (!["admin", "ops", "business", "auditor"].includes(input.role))
      fail(400, "INVALID_ROLE");
    if (
      input.deviceScope !== "*" &&
      (!Array.isArray(input.deviceScope) ||
        input.deviceScope.length > 1000 ||
        input.deviceScope.some(
          (x) => typeof x !== "string" || !x || x.length > 128,
        ))
    )
      fail(400, "INVALID_SCOPE");
    const id = randomUUID();
    const credentialHash = passwordHash(input.password);
    return this.transaction(() => {
      this.db
        .prepare(
          "INSERT INTO users(id,username,password_hash,role,device_scope,created_at) VALUES(?,?,?,?,?,?)",
        )
        .run(
          id,
          input.username,
          credentialHash,
          input.role,
          JSON.stringify(input.deviceScope),
          Date.now(),
        );
      this.audit("user.bootstrap", id, null, null, {
        username: input.username,
        role: input.role,
      });
      this.db
        .prepare("INSERT INTO user_roles(user_id,role_id) VALUES(?,?)")
        .run(id, input.role);
      return this.user(
        this.db.prepare("SELECT * FROM users WHERE id=?").get(id),
      );
    });
  }

  user(row: any): User {
    const groups = this.db
      .prepare(
        "SELECT g.id,g.device_scope FROM access_groups g JOIN group_members m ON m.group_id=g.id WHERE m.user_id=? ORDER BY g.id",
      )
      .all(row.id) as any[];
    const roles = this.db
      .prepare(
        "SELECT DISTINCT r.id,r.name,r.permissions FROM access_roles r WHERE r.id IN (SELECT role_id FROM user_roles WHERE user_id=? UNION SELECT gr.role_id FROM group_roles gr JOIN group_members gm ON gm.group_id=gr.group_id WHERE gm.user_id=?) ORDER BY r.id",
      )
      .all(row.id, row.id) as any[];
    const permissions = row.enabled
      ? [
          ...new Set<Permission>(
            roles.flatMap((r) => JSON.parse(r.permissions)),
          ),
        ]
      : [];
    const admin = !!row.enabled && roles.some((r) => r.id === "admin");
    const scopes: Scope[] = [
      JSON.parse(row.device_scope),
      ...groups.map((g) => JSON.parse(g.device_scope)),
    ];
    const scope: Scope =
      admin || scopes.includes("*")
        ? "*"
        : [...new Set(scopes.flatMap((s) => (s === "*" ? [] : s)))].sort();
    return {
      id: row.id,
      username: row.username,
      must_change_password: !!row.must_change_password,
      role: admin
        ? "admin"
        : permissions.some((p) =>
              [
                "terminal.connect",
                "tasks.execute",
                "health.manage",
                "network.manage",
              ].includes(p),
            )
          ? "ops"
          : roles.some((r) => r.id === "business")
            ? "business"
            : "auditor",
      device_scope: row.enabled ? scope : [],
      permissions,
      role_ids: roles.map((r) => r.id),
      role_names: roles.map((r) => r.name),
      group_ids: groups.map((g) => g.id),
    };
  }
  task(id: string): any {
    const row = this.db
      .prepare("SELECT * FROM tasks WHERE id=?")
      .get(id) as any;
    if (!row) fail(404, "TASK_NOT_FOUND");
    return row;
  }
  taskView(row: any) {
    return {
      ...(JSON.parse(row.task_json) as Task),
      actor_username:
        row.actor_name ??
        (
          this.db
            .prepare("SELECT username FROM users WHERE id=?")
            .get(row.actor_id) as any
        )?.username ??
        null,
      device_name:
        row.device_label ??
        (
          this.db
            .prepare("SELECT name FROM devices WHERE id=?")
            .get(row.device_id) as any
        )?.name ??
        null,
      status: row.status,
      last_seq: row.last_seq,
      cancel_requested: !!row.cancel_requested,
      result: row.result_json ? JSON.parse(row.result_json) : null,
    };
  }
  close() {
    this.db.close();
  }
}
