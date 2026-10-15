import { DatabaseSync } from "node:sqlite";
import { randomUUID } from "node:crypto";
import { readFileSync, mkdirSync, chmodSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { passwordHash, canonical, fail, str } from "./util.js";
import type { User, Role, Scope, Task } from "./types.js";
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
    this.db
      .prepare(
        "INSERT INTO audit(at,actor_id,device_id,task_id,action,detail_json) VALUES(?,?,?,?,?,?)",
      )
      .run(Date.now(), actorId, deviceId, taskId, action, canonical(detail));
  }
  seedUser(input: {
    username: string;
    password: string;
    role: Role;
    deviceScope: Scope;
  }): User {
    str(input.username, 1, 128);
    str(input.password, 12, 1024);
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
      return {
        id,
        username: input.username,
        role: input.role,
        device_scope: input.deviceScope,
      };
    });
  }

  user(row: any): User {
    return {
      id: row.id,
      username: row.username,
      role: row.role,
      device_scope: JSON.parse(row.device_scope),
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
