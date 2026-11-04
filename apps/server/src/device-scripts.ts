import { parseScriptQuery, type ScriptQuery } from "./script-io.js";
import { randomUUID } from "node:crypto";
import type { FastifyInstance, FastifyRequest } from "fastify";
import type { Store } from "./store.js";
import type { User } from "./types.js";
import { hasPermission } from "./permissions.js";
import {
  ApiError,
  fail,
  hash,
  integer,
  keys,
  object,
  str,
  version,
} from "./util.js";

/** Older agents accept execution deadlines from 100 ms to one hour. */
export function needsExtendedTimeout(timeoutMs: number) {
  return timeoutMs === 0 || timeoutMs > 3_600_000;
}

export const SCRIPT_OUTPUT_LIMIT = 262144;

export interface DeviceScript {
  id: string;
  device_id: string;
  revision: number;
  name: string;
  script: string;
  interactive: number;
  run_timeout_minutes: number | null;
}
export function scriptTimeoutMinutes(
  script: Pick<DeviceScript, "interactive" | "run_timeout_minutes">,
) {
  return script.run_timeout_minutes ?? (script.interactive ? 5 : 1);
}

export class ScriptBusyError extends ApiError {
  constructor(readonly activeRun: Record<string, unknown>) {
    super(409, "SCRIPT_BUSY");
  }
}
export function requireScriptIdle(
  store: Store,
  deviceId: string,
  scriptId: string,
) {
  const blocking = store.db
    .prepare(
      "SELECT * FROM device_script_activity WHERE device_id=? AND script_id=? ORDER BY created_at,task_id LIMIT 1",
    )
    .get(deviceId, scriptId);
  if (blocking) throw new ScriptBusyError(blocking);
}
export function registerDeviceScripts(
  app: FastifyInstance,
  d: {
    store: Store;
    reader(req: FastifyRequest): User;
    requireScope(user: User, deviceId: string): void;
    requireDevice(id: string): { revoked_at: number | null };
    availableStorage(): void;
    io(
      task: string,
      device: string,
      backend: string,
      user: User,
      query: ScriptQuery,
    ): unknown;
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
  function viewer(req: FastifyRequest) {
    const user = d.reader(req),
      id = device(req, user),
      canManage = hasPermission(user, "scripts.manage");
    if (!canManage && !hasPermission(user, "scripts.run"))
      fail(403, "SCRIPT_ACCESS_DENIED");
    return { user, id, canManage };
  }
  function withMode({ interactive, ...row }: Record<string, unknown>) {
    return interactive ? { ...row, interactive: true } : row;
  }
  function activity(id: string) {
    return db
      .prepare(
        "SELECT a.*, json_extract(t.task_json,'$.interactive') AS interactive FROM device_script_activity a JOIN tasks t ON t.id=a.task_id WHERE a.device_id=? ORDER BY a.created_at,a.task_id",
      )
      .all(id)
      .map(withMode);
  }
  app.get(path + "/activity", async (req) => ({
    v: 1,
    activity: activity(viewer(req).id),
  }));
  app.get(path, async (req) => {
    const { user, id, canManage } = viewer(req);
    const scripts = db
      .prepare(
        canManage
          ? "SELECT id,name,revision,interactive,run_timeout_minutes AS timeout_minutes,script FROM device_scripts WHERE device_id=? ORDER BY name,id"
          : "SELECT id,name,revision,interactive FROM device_scripts WHERE device_id=? ORDER BY name,id",
      )
      .all(id)
      .map(withMode);
    const runs = hasPermission(user, "tasks.read")
      ? db
          .prepare(
            "SELECT t.id,s.name,s.script_id,json_extract(t.task_json,'$.interactive') AS interactive,t.status,t.created_at FROM tasks t JOIN device_script_tasks s ON s.task_id=t.id WHERE t.device_id=? AND t.actor_id=? ORDER BY t.created_at DESC,t.id DESC LIMIT 5",
          )
          .all(id, user.id)
      : [];
    return { v: 1, scripts, runs: runs.map(withMode), activity: activity(id) };
  });
  function save(req: FastifyRequest, editing: boolean) {
    const user = manager(req),
      id = device(req, user),
      b = object(req.body);
    version(b);
    keys(b, [
      "v",
      "name",
      "script",
      "interactive",
      "timeout_minutes",
      ...(editing ? ["revision"] : []),
    ]);
    if (b.interactive !== undefined && typeof b.interactive !== "boolean")
      fail(400, "INVALID_SCRIPT_MODE");
    const configuredTimeout =
      b.timeout_minutes == null
        ? b.timeout_minutes
        : integer(
            b.timeout_minutes,
            0,
            Math.floor(Number.MAX_SAFE_INTEGER / 60_000),
          );
    const name = str(b.name, 1, 80).trim(),
      script = str(b.script, 1, 8192);
    if (!name || !script.trim() || Buffer.byteLength(script) > 8192)
      fail(400, "INVALID_DEVICE_SCRIPT");
    d.availableStorage();
    return d.store.transaction(() => {
      const previous = editing ? find(req, id) : undefined;
      // A waiting prompt must keep the revision used to authorize its answers.
      if (previous?.interactive) requireScriptIdle(d.store, id, previous.id);
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
      const interactive =
        b.interactive === undefined
          ? (previous?.interactive ?? 0)
          : Number(b.interactive);
      const timeoutMinutes =
        configuredTimeout === undefined
          ? (previous?.run_timeout_minutes ?? null)
          : configuredTimeout;
      db.prepare(
        "INSERT INTO device_scripts(id,device_id,name,script,revision,interactive,run_timeout_minutes) VALUES(?,?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET name=excluded.name,script=excluded.script,revision=excluded.revision,interactive=excluded.interactive,run_timeout_minutes=excluded.run_timeout_minutes",
      ).run(scriptId, id, name, script, revision, interactive, timeoutMinutes);
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
          timeout_minutes: scriptTimeoutMinutes({
            interactive,
            run_timeout_minutes: timeoutMinutes,
          }),
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
      requireScriptIdle(d.store, id, row.id);
      db.prepare("DELETE FROM device_scripts WHERE id=?").run(row.id);
      d.store.audit("script.deleted", user.id, id, null, {
        script_id: row.id,
        name: row.name,
        revision: row.revision,
      });
      return { v: 1 };
    });
  });
  app.post(item + "/runs/:taskId/confirm-stopped", async (req) => {
    const user = manager(req),
      id = device(req, user),
      b = object(req.body);
    version(b);
    keys(b, ["v"]);
    const taskId = str((req.params as any).taskId, 1, 128);
    d.availableStorage();
    return d.store.transaction(() => {
      const script = find(req, id);
      const task = db
        .prepare(
          "SELECT t.status FROM tasks t JOIN device_script_tasks s ON s.task_id=t.id WHERE t.id=? AND t.device_id=? AND s.script_id=?",
        )
        .get(taskId, id, script.id);
      if (!task) fail(404, "TASK_NOT_FOUND");
      if (task.status !== "UNKNOWN") fail(409, "SCRIPT_REVIEW_NOT_ALLOWED");
      const inserted = db
        .prepare(
          "INSERT INTO device_script_reviews(task_id) VALUES(?) ON CONFLICT(task_id) DO NOTHING",
        )
        .run(taskId);
      if (inserted.changes)
        d.store.audit("script.stop_confirmed", user.id, id, taskId, {
          script_id: script.id,
          confirmed_stopped: true,
        });
      return { v: 1 };
    });
  });
  app.post(item + "/runs/:taskId/io", async (req) => {
    const user = d.reader(req),
      id = device(req, user);
    const b = object(req.body);
    version(b);
    const query = parseScriptQuery(b);
    const scriptId = str((req.params as any).scriptId, 1, 128);
    const taskId = str((req.params as any).taskId, 1, 128);
    const row = db
      .prepare(
        "SELECT t.status,t.task_json,s.backend,s.revision FROM tasks t JOIN device_script_tasks s ON s.task_id=t.id WHERE t.id=? AND t.device_id=? AND t.actor_id=? AND s.script_id=?",
      )
      .get(taskId, id, user.id, scriptId);
    if (!row || !JSON.parse(String(row.task_json)).interactive)
      fail(404, "TASK_NOT_FOUND");
    if (!hasPermission(user, "scripts.run")) fail(403, "SCRIPT_ACCESS_DENIED");
    if (query.input) {
      authorizeRun(user, {
        id: scriptId,
        device_id: id,
        revision: Number(row.revision),
      });
      if (row.status !== "RUNNING") fail(409, "SCRIPT_INPUT_CLOSED");
    }
    return d.io(taskId, id, String(row.backend), user, query);
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
