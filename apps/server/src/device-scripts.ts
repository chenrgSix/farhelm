import { randomUUID } from "node:crypto";
import type { FastifyInstance, FastifyRequest } from "fastify";
import type { Store } from "./store.js";
import type { User } from "./types.js";
import { hasPermission } from "./permissions.js";
import { fail, hash, integer, keys, object, str, version } from "./util.js";

export const SCRIPT_TIMEOUT_MS = 60000;
export const SCRIPT_OUTPUT_LIMIT = 262144;

export interface DeviceScript {
  id: string;
  device_id: string;
  revision: number;
  name: string;
  script: string;
}
export function registerDeviceScripts(
  app: FastifyInstance,
  d: {
    store: Store;
    reader(req: FastifyRequest): User;
    requireScope(user: User, deviceId: string): void;
    requireDevice(id: string): { revoked_at: number | null };
    availableStorage(): void;
    submit(req: FastifyRequest, user: User, script: DeviceScript): unknown;
  },
) {
  const db = d.store.db;
  const path = "/api/v1/devices/:id/scripts";
  const item = path + "/:scriptId";
  function device(req: FastifyRequest, user: User) {
    const id = str((req.params as any).id, 1, 128);
    d.requireScope(user, id);
    if (d.requireDevice(id).revoked_at != null) fail(409, "DEVICE_REVOKED");
    return id;
  }
  function manager(req: FastifyRequest) {
    const user = d.reader(req);
    if (!hasPermission(user, "scripts.manage"))
      fail(403, "SCRIPT_MANAGE_DENIED");
    return user;
  }
  function find(req: FastifyRequest, id: string) {
    const row = db
      .prepare("SELECT * FROM device_scripts WHERE device_id=? AND id=?")
      .get(id, str((req.params as any).scriptId, 1, 128)) as unknown as
      DeviceScript | undefined;
    if (!row) fail(404, "SCRIPT_NOT_FOUND");
    return row;
  }
  function authorizeRun(
    user: User,
    row: Pick<DeviceScript, "id" | "revision" | "device_id">,
  ) {
    d.requireScope(user, row.device_id);
    if (
      !hasPermission(user, "devices.read") ||
      !hasPermission(user, "scripts.run")
    )
      fail(403, "SCRIPT_ACCESS_DENIED");
    if (d.requireDevice(row.device_id).revoked_at != null)
      fail(409, "DEVICE_REVOKED");
    const current = db
      .prepare("SELECT revision FROM device_scripts WHERE id=? AND device_id=?")
      .get(row.id, row.device_id);
    if (current?.revision !== row.revision) fail(409, "SCRIPT_CHANGED");
  }
  app.get(path, async (req) => {
    const user = d.reader(req),
      id = device(req, user);
    const canManage = hasPermission(user, "scripts.manage");
    if (!canManage && !hasPermission(user, "scripts.run"))
      fail(403, "SCRIPT_ACCESS_DENIED");
    const scripts = db
      .prepare(
        canManage
          ? "SELECT id,name,revision,script FROM device_scripts WHERE device_id=? ORDER BY name,id"
          : "SELECT id,name,revision FROM device_scripts WHERE device_id=? ORDER BY name,id",
      )
      .all(id);
    const runs = hasPermission(user, "tasks.read")
      ? db
          .prepare(
            "SELECT t.id,s.name,t.status,t.created_at FROM tasks t JOIN device_script_tasks s ON s.task_id=t.id WHERE t.device_id=? AND t.actor_id=? ORDER BY t.created_at DESC,t.id DESC LIMIT 5",
          )
          .all(id, user.id)
      : [];
    return { v: 1, scripts, runs };
  });
  function save(req: FastifyRequest, editing: boolean) {
    const user = manager(req),
      id = device(req, user),
      b = object(req.body);
    version(b);
    keys(b, ["v", "name", "script", ...(editing ? ["revision"] : [])]);
    const name = str(b.name, 1, 80).trim(),
      script = str(b.script, 1, 8192);
    if (!name || !script.trim() || Buffer.byteLength(script) > 8192)
      fail(400, "INVALID_DEVICE_SCRIPT");
    d.availableStorage();
    return d.store.transaction(() => {
      const previous = editing ? find(req, id) : undefined;
      if (
        previous &&
        previous.revision !== integer(b.revision, 1, Number.MAX_SAFE_INTEGER)
      )
        fail(409, "SCRIPT_CHANGED");
      if (
        !previous &&
        Number(
          db
            .prepare(
              "SELECT count(*) AS n FROM device_scripts WHERE device_id=?",
            )
            .get(id)?.n,
        ) >= 64
      )
        fail(409, "SCRIPT_LIMIT");
      const scriptId = previous?.id ?? randomUUID(),
        revision = (previous?.revision ?? 0) + 1;
      if (
        db
          .prepare(
            "SELECT 1 FROM device_scripts WHERE device_id=? AND name=? AND id!=?",
          )
          .get(id, name, scriptId)
      )
        fail(409, "SCRIPT_NAME_EXISTS");
      db.prepare(
        "INSERT INTO device_scripts(id,device_id,name,script,revision) VALUES(?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET name=excluded.name,script=excluded.script,revision=excluded.revision",
      ).run(scriptId, id, name, script, revision);
      d.store.audit(
        editing ? "script.updated" : "script.created",
        user.id,
        id,
        null,
        {
          script_id: scriptId,
          name,
          revision,
          script_hash: hash(script),
        },
      );
      return { v: 1, id: scriptId, revision };
    });
  }
  app.post(path, async (req) => save(req, false));
  app.put(item, async (req) => save(req, true));
  app.delete(item, async (req) => {
    const user = manager(req),
      id = device(req, user),
      b = object(req.body);
    version(b);
    keys(b, ["v", "revision"]);
    d.availableStorage();
    return d.store.transaction(() => {
      const row = find(req, id);
      if (row.revision !== integer(b.revision, 1, Number.MAX_SAFE_INTEGER))
        fail(409, "SCRIPT_CHANGED");
      db.prepare("DELETE FROM device_scripts WHERE id=?").run(row.id);
      d.store.audit("script.deleted", user.id, id, null, {
        script_id: row.id,
        name: row.name,
        revision: row.revision,
      });
      return { v: 1 };
    });
  });
  app.post(item + "/run", async (req) => {
    const user = d.reader(req),
      id = device(req, user),
      b = object(req.body);
    version(b);
    keys(b, ["v", "revision"]);
    const row = find(req, id);
    authorizeRun(user, row);
    if (row.revision !== integer(b.revision, 1, Number.MAX_SAFE_INTEGER))
      fail(409, "SCRIPT_CHANGED");
    return d.submit(req, user, row);
  });
  return authorizeRun;
}
