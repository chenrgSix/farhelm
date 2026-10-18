import { randomUUID } from "node:crypto";
import type { FastifyInstance, FastifyRequest } from "fastify";
import { auditContext, auditText } from "./audit-context.js";
import { permissionCatalog } from "./access-control.js";
import { PERMISSIONS, hasPermission, type Permission } from "./permissions.js";
import {
  openApiDocument,
  publicOperations,
  skillArchive,
} from "./public-api.js";
import type { Store } from "./store.js";
import type { Scope, User } from "./types.js";
import {
  canonical,
  fail,
  hash,
  integer,
  keys,
  object,
  str,
  token,
  version,
  type RateLimiter,
} from "./util.js";

const PREFIX = "fh_api_";
const MAX_LIFETIME = 366 * 86400000;
interface TokenRow {
  id: string;
  owner_id: string;
  name: string;
  token_hash: string;
  prefix: string;
  permissions: string;
  device_scope: string;
  expires_at: number;
  created_at: number;
  updated_at: number;
  revoked_at: number | null;
  last_used_at: number | null;
  last_used_address: string | null;
  revision: number;
}
export class ApiTokens {
  private requests = new WeakMap<
    FastifyRequest,
    { row: TokenRow; user?: User }
  >();
  constructor(private store: Store) {}
  private find(tokenHash: string) {
    return this.store.db
      .prepare("SELECT * FROM api_tokens WHERE token_hash=?")
      .get(tokenHash) as TokenRow | undefined;
  }
  private principal(row: TokenRow): User | undefined {
    if (row.revoked_at !== null || row.expires_at <= Date.now()) return;
    const owner = this.store.db
      .prepare("SELECT * FROM users WHERE id=? AND enabled=1")
      .get(row.owner_id) as any;
    if (!owner || owner.must_change_password) return;
    const user = this.store.user(owner);
    const granted = JSON.parse(row.device_scope) as Scope;
    const device_scope =
      granted === "*"
        ? user.device_scope
        : user.device_scope === "*"
          ? granted
          : granted.filter((id) => user.device_scope.includes(id));
    const permissions = (JSON.parse(row.permissions) as Permission[]).filter(
      (p) => hasPermission(user, p),
    );
    return {
      ...user,
      // Tokens never inherit admin bypasses. All decisions use effective capabilities.
      role: permissions.some((p) =>
        [
          "tasks.execute",
          "terminal.connect",
          "health.manage",
          "network.manage",
        ].includes(p),
      )
        ? "ops"
        : "business",
      permissions,
      device_scope,
      api_token_id: row.id,
      role_ids: [],
      role_names: [],
      group_ids: [],
    };
  }
  resolve(tokenHash: string) {
    const row = this.find(tokenHash);
    return row ? this.principal(row) : undefined;
  }
  actor(req: FastifyRequest) {
    return this.requests.get(req)?.row.owner_id;
  }
  user(req: FastifyRequest) {
    return this.requests.get(req)?.user;
  }
  register(
    app: FastifyInstance,
    d: {
      admin(req: FastifyRequest): User;
      userAuth(req: FastifyRequest): User;
      availableStorage(): void;
      rate: RateLimiter;
      changed(): void;
    },
  ) {
    const db = this.store.db;
    app.addHook("preValidation", async (req) => {
      const authorization = req.headers.authorization;
      if (
        typeof authorization !== "string" ||
        !authorization.startsWith("Bearer " + PREFIX)
      )
        return;
      if (!/^Bearer fh_api_[A-Za-z0-9_-]{43}$/.test(authorization))
        fail(401, "API_TOKEN_INVALID");
      const row = this.find(hash(authorization.slice(7)));
      if (!row) fail(401, "API_TOKEN_INVALID");
      this.requests.set(req, { row });
      Object.assign(auditContext.getStore() ?? {}, {
        source: "api",
        api_token_id: row.id,
        api_token_name: row.name,
      });
      const user = this.principal(row);
      if (!user) fail(401, "API_TOKEN_INVALID");
      this.requests.set(req, { row, user });
      d.rate.check("api-token:" + row.id, 300);
      d.rate.check("api-token-owner:" + row.owner_id, 1000);
      const operation = publicOperations.find(
        (o) =>
          "/api/v1" + o.path === req.routeOptions.url &&
          (o.method === req.method ||
            (req.method === "HEAD" && o.method === "GET")),
      );
      if (!operation) fail(403, "API_TOKEN_ENDPOINT_DENIED");
      if (operation.permission && !hasPermission(user, operation.permission))
        fail(403, "PERMISSION_DENIED");
      db.prepare(
        "UPDATE api_tokens SET last_used_at=?,last_used_address=? WHERE id=?",
      ).run(Date.now(), auditText(req.ip, 128) ?? null, row.id);
    });
    app.addHook("onSend", async (req, reply, payload) => {
      const entry = this.requests.get(req);
      if (!entry) return payload;
      // Persist before sending a response, including reads and denied/expired requests.
      this.requests.delete(req);
      let deviceId: string | null = null;
      let taskId: string | null = null;
      const route = req.routeOptions.url ?? "unknown";
      const params = req.params as Record<string, string>;
      if (route.startsWith("/api/v1/devices/:id")) deviceId = params.id ?? null;
      else if (route.startsWith("/api/v1/tasks/:")) {
        const task = db
          .prepare("SELECT id,device_id FROM tasks WHERE id=?")
          .get(params.id ?? params.task_id ?? "") as any;
        deviceId = task?.device_id ?? null;
        taskId = task?.id ?? null;
      } else if (route.startsWith("/api/v1/terminal-sessions/:id")) {
        const session = db
          .prepare("SELECT device_id FROM terminal_sessions WHERE id=?")
          .get(params.id ?? "") as any;
        deviceId = session?.device_id ?? null;
      } else if (
        ["/api/v1/commands", "/api/v1/terminal-sessions"].includes(route) &&
        req.method === "POST"
      ) {
        const id = (req.body as any)?.device_id;
        if (typeof id === "string") deviceId = id.slice(0, 128);
      }
      // Unknown caller-provided IDs cannot violate audit foreign keys.
      if (
        deviceId &&
        !db.prepare("SELECT id FROM devices WHERE id=?").get(deviceId)
      )
        deviceId = null;
      try {
        this.store.audit(
          "api_token.request",
          entry.row.owner_id,
          deviceId,
          taskId,
          { method: req.method, route, status_code: reply.statusCode },
        );
      } catch {
        reply.code(503).type("application/json");
        return JSON.stringify({ v: 1, error: "AUDIT_STORAGE_FAILURE" });
      }
      return payload;
    });
    const view = (row: TokenRow) => ({
      id: row.id,
      owner_id: row.owner_id,
      owner_username:
        (
          db
            .prepare("SELECT username FROM users WHERE id=?")
            .get(row.owner_id) as any
        )?.username ?? null,
      name: row.name,
      prefix: row.prefix,
      permissions: JSON.parse(row.permissions),
      device_scope: JSON.parse(row.device_scope),
      expires_at: row.expires_at,
      created_at: row.created_at,
      updated_at: row.updated_at,
      revoked_at: row.revoked_at,
      last_used_at: row.last_used_at,
      last_used_address: row.last_used_address,
      revision: row.revision,
      status:
        row.revoked_at !== null
          ? "revoked"
          : row.expires_at <= Date.now()
            ? "expired"
            : this.principal(row)
              ? "active"
              : "owner_disabled",
    });
    const parse = (body: unknown, owner: User, update = false) => {
      const b = object(body);
      keys(b, [
        "v",
        "name",
        "permissions",
        "device_scope",
        "expires_at",
        ...(update ? ["revision"] : []),
      ]);
      version(b);
      const name = str(b.name, 1, 64).trim();
      if (!name || /[\x00-\x1f\x7f]/.test(name))
        fail(400, "INVALID_TOKEN_NAME");
      if (
        !Array.isArray(b.permissions) ||
        !b.permissions.length ||
        b.permissions.length > PERMISSIONS.length ||
        new Set(b.permissions).size !== b.permissions.length ||
        b.permissions.some((p: any) => !PERMISSIONS.includes(p))
      )
        fail(400, "INVALID_TOKEN_PERMISSIONS");
      if (b.permissions.some((p: Permission) => !hasPermission(owner, p)))
        fail(403, "TOKEN_PERMISSION_EXCEEDS_OWNER");
      const permissions = [...b.permissions].sort() as Permission[];
      for (const p of ["tasks", "recordings", "audit"])
        if (
          permissions.includes((p + ".read_all") as Permission) &&
          !permissions.includes((p + ".read") as Permission)
        )
          fail(400, "TOKEN_PERMISSION_DEPENDENCY");
      let scope: Scope;
      if (b.device_scope === "*") {
        if (owner.device_scope !== "*") fail(403, "TOKEN_SCOPE_EXCEEDS_OWNER");
        scope = "*";
      } else {
        if (
          !Array.isArray(b.device_scope) ||
          b.device_scope.length > 1000 ||
          new Set(b.device_scope).size !== b.device_scope.length
        )
          fail(400, "INVALID_TOKEN_SCOPE");
        scope = b.device_scope.map((id: unknown) => str(id, 1, 128)).sort();
        for (const id of scope) {
          if (!db.prepare("SELECT id FROM devices WHERE id=?").get(id))
            fail(400, "UNKNOWN_DEVICE");
          if (owner.device_scope !== "*" && !owner.device_scope.includes(id))
            fail(403, "TOKEN_SCOPE_EXCEEDS_OWNER");
        }
      }
      const now = Date.now(),
        expires_at = integer(b.expires_at, now + 1000, now + MAX_LIFETIME);
      return { name, permissions, device_scope: scope, expires_at };
    };
    const findId = (req: FastifyRequest) => {
      const row = db
        .prepare("SELECT * FROM api_tokens WHERE id=?")
        .get(str((req.params as any).id, 1, 128)) as TokenRow | undefined;
      if (!row) fail(404, "API_TOKEN_NOT_FOUND");
      return row;
    };
    const management = (req: FastifyRequest) => {
      const actor = d.admin(req);
      if (actor.api_token_id) fail(403, "INTERACTIVE_LOGIN_REQUIRED");
      return actor;
    };
    app.get("/api/v1/api-tokens", async (req) => {
      management(req);
      return {
        v: 1,
        tokens: (
          db
            .prepare("SELECT * FROM api_tokens ORDER BY created_at DESC,id")
            .all() as unknown as TokenRow[]
        ).map(view),
        permissions: permissionCatalog,
      };
    });
    app.post("/api/v1/api-tokens", async (req) => {
      const actor = management(req),
        input = parse(req.body, actor);
      d.rate.check("api-token-create:" + actor.id, 10);
      d.availableStorage();
      const count = (
        db
          .prepare(
            "SELECT count(*) AS n FROM api_tokens WHERE owner_id=? AND revoked_at IS NULL AND expires_at>?",
          )
          .get(actor.id, Date.now()) as any
      ).n;
      if (count >= 100) fail(409, "API_TOKEN_LIMIT");
      const secret = PREFIX + token(),
        id = randomUUID(),
        now = Date.now();
      this.store.transaction(() => {
        db.prepare(
          "INSERT INTO api_tokens(id,owner_id,name,token_hash,prefix,permissions,device_scope,expires_at,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?)",
        ).run(
          id,
          actor.id,
          input.name,
          hash(secret),
          secret.slice(0, 15),
          canonical(input.permissions),
          canonical(input.device_scope),
          input.expires_at,
          now,
          now,
        );
        this.store.audit("api_token.created", actor.id, null, null, {
          token_id: id,
          owner_id: actor.id,
          ...input,
        });
      });
      return { v: 1, token: view(this.find(hash(secret))!), secret };
    });
    app.put("/api/v1/api-tokens/:id", async (req) => {
      const actor = management(req),
        row = findId(req);
      // Administrators can revoke all tokens, but only modify their own grants.
      if (row.owner_id !== actor.id) fail(403, "TOKEN_OWNER_REQUIRED");
      const input = parse(req.body, actor, true);
      if (
        integer((req.body as any).revision, 0, Number.MAX_SAFE_INTEGER - 1) !==
        row.revision
      )
        fail(409, "API_TOKEN_REVISION_CONFLICT");
      if (row.revoked_at !== null || row.expires_at <= Date.now())
        fail(409, "API_TOKEN_INACTIVE");
      d.availableStorage();
      this.store.transaction(() => {
        db.prepare(
          "UPDATE api_tokens SET name=?,permissions=?,device_scope=?,expires_at=?,updated_at=?,revision=revision+1 WHERE id=?",
        ).run(
          input.name,
          canonical(input.permissions),
          canonical(input.device_scope),
          input.expires_at,
          Date.now(),
          row.id,
        );
        this.store.audit("api_token.updated", actor.id, null, null, {
          token_id: row.id,
          owner_id: row.owner_id,
          ...input,
        });
      });
      d.changed();
      return { v: 1, token: view(findId(req)) };
    });
    app.post("/api/v1/api-tokens/:id/revoke", async (req) => {
      const actor = management(req),
        row = findId(req),
        b = object(req.body);
      keys(b, ["v"]);
      version(b);
      if (row.revoked_at === null) {
        d.availableStorage();
        this.store.transaction(() => {
          db.prepare(
            "UPDATE api_tokens SET revoked_at=?,updated_at=?,revision=revision+1 WHERE id=?",
          ).run(Date.now(), Date.now(), row.id);
          this.store.audit("api_token.revoked", actor.id, null, null, {
            token_id: row.id,
            owner_id: row.owner_id,
            name: row.name,
          });
        });
        d.changed();
      }
      return { v: 1, ok: true };
    });
    app.get("/api/v1/openapi.json", async (req) => {
      d.userAuth(req);
      return openApiDocument();
    });
    app.get("/api/v1/api-skill", async (req, reply) => {
      management(req);
      return reply
        .type("application/gzip")
        .header(
          "content-disposition",
          'attachment; filename="farhelm-api-skill.tar.gz"',
        )
        .send(skillArchive());
    });
  }
}
