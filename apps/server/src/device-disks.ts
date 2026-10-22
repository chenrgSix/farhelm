import type { FastifyInstance, FastifyRequest } from "fastify";
import { randomUUID } from "node:crypto";
import type { Store } from "./store.js";
import type { User } from "./types.js";
import {
  fail,
  integer,
  keys,
  object,
  str,
  version,
  type RateLimiter,
} from "./util.js";
import {
  parseDiskUsage,
  validateDiskUsage,
  type DiskUsage,
} from "./disk-usage.js";

const HOUR = 3600000;
const CACHE_MS = 5 * 60000;
const ERROR_COOLDOWN_MS = 60000;
const INTERVALS = [1, 2, 8, 12, 24];
type Row = {
  device_id: string;
  interval_hours: number;
  revision: number;
  snapshot_json: string | null;
  checked_at: number | null;
  last_attempt_at: number | null;
  last_error: string | null;
  next_at: number;
};
type Agent = {
  connectionId: string;
  send(type: string, body: unknown): boolean;
};
export function registerDeviceDisks(
  app: FastifyInstance,
  d: {
    store: Store;
    reader(req: FastifyRequest): User;
    admin(req: FastifyRequest): User;
    requireScope(user: User, id: string): void;
    requireDevice(id: string): { revoked_at: number | null };
    agent(id: string): Agent | undefined;
    ssh(id: string): Promise<string>;
    rate: RateLimiter;
    now?: () => number;
  },
) {
  const db = d.store.db,
    now = d.now ?? Date.now;
  const pending = new Map<string, Promise<void>>();
  const requests = new Map<
    string,
    {
      deviceId: string;
      connectionId: string;
      finish(value?: DiskUsage, error?: string): void;
    }
  >();
  let closed = false;
  function row(id: string): Row {
    db.prepare(
      "INSERT OR IGNORE INTO device_disks(device_id,next_at) VALUES(?,?)",
    ).run(id, now() + 24 * HOUR);
    return db
      .prepare("SELECT * FROM device_disks WHERE device_id=?")
      .get(id) as Row;
  }
  function cacheUntil(r: Row) {
    return r.last_attempt_at === null
      ? null
      : r.last_attempt_at + (r.last_error ? ERROR_COOLDOWN_MS : CACHE_MS);
  }
  function view(id: string) {
    const r = row(id);
    return {
      v: 1,
      device_id: id,
      interval_hours: r.interval_hours,
      revision: r.revision,
      usage: r.snapshot_json
        ? (JSON.parse(r.snapshot_json) as DiskUsage)
        : null,
      checked_at: r.checked_at,
      last_error: r.last_error,
      next_collection_at: r.next_at,
      cache_until: cacheUntil(r),
      collecting: pending.has(id),
      stale:
        r.checked_at === null ||
        !!r.last_error ||
        now() - r.checked_at >= r.interval_hours * HOUR,
    };
  }
  function authorize(req: FastifyRequest, editing = false) {
    const user = editing ? d.admin(req) : d.reader(req),
      id = str((req.params as any).id, 1, 128);
    d.requireScope(user, id);
    const device = d.requireDevice(id);
    return { user, id, device };
  }
  function agentUsage(id: string, agent: Agent): Promise<DiskUsage> {
    const requestId = randomUUID();
    return new Promise((resolve, reject) => {
      const finish = (value?: DiskUsage, error?: string) => {
        if (!requests.delete(requestId)) return;
        clearTimeout(timer);
        if (value) resolve(value);
        else reject(new Error(error ?? "DISK_COLLECTION_FAILED"));
      };
      const timer = setTimeout(
        () => finish(undefined, "DISK_COLLECTION_TIMEOUT"),
        10000,
      );
      requests.set(requestId, {
        deviceId: id,
        connectionId: agent.connectionId,
        finish,
      });
      if (!agent.send("agent.disk.request", { request_id: requestId }))
        finish(undefined, "DEVICE_OFFLINE");
    });
  }
  function collect(id: string, actor: string | null) {
    if (closed) fail(503, "SERVER_SHUTDOWN");
    const running = pending.get(id);
    if (running) return running;
    const saved = row(id),
      until = cacheUntil(saved);
    if (until !== null && until > now()) return Promise.resolve();
    if (pending.size >= 4) fail(429, "DISK_COLLECTION_BUSY");
    if (d.requireDevice(id).revoked_at) fail(409, "DEVICE_REVOKED");
    const started = now();
    d.store.transaction(() => {
      db.prepare(
        "UPDATE device_disks SET last_attempt_at=?,next_at=? WHERE device_id=?",
      ).run(started, started + saved.interval_hours * HOUR, id);
      d.store.audit("device.disk_requested", actor, id, null, {
        source: actor ? "viewer" : "schedule",
      });
    });
    const work = Promise.resolve()
      .then(async () => {
        try {
          const agent = d.agent(id);
          const usage = agent
            ? await agentUsage(id, agent)
            : parseDiskUsage(await d.ssh(id));
          if (closed) return;
          if (d.requireDevice(id).revoked_at) fail(409, "DEVICE_REVOKED");
          d.store.transaction(() => {
            db.prepare(
              "UPDATE device_disks SET snapshot_json=?,checked_at=?,last_attempt_at=?,last_error=NULL WHERE device_id=?",
            ).run(JSON.stringify(usage), now(), now(), id);
            d.store.audit("device.disk_collected", actor, id, null, {
              backend: agent ? "agent" : "ssh",
            });
          });
        } catch (error) {
          if (closed) return;
          const raw = error instanceof Error ? error.message : "";
          const reason = [
            "DEVICE_OFFLINE",
            "DEVICE_REVOKED",
            "DISK_AGENT_UPDATE_REQUIRED",
            "DISK_COLLECTION_TIMEOUT",
            "DISK_OUTPUT_LIMIT",
            "DISK_NO_LOCAL_FILESYSTEM",
            "SSH_HOST_KEY_MISMATCH",
            "SSH_AUTH_FAILED",
            "SSH_CONNECT_FAILED",
            "SSH_NOT_CONFIGURED",
            "DEVICE_CONNECTION_CHANGED",
          ].includes(raw)
            ? raw
            : "DISK_COLLECTION_FAILED";
          d.store.transaction(() => {
            db.prepare(
              "UPDATE device_disks SET last_attempt_at=?,last_error=? WHERE device_id=?",
            ).run(now(), reason, id);
            d.store.audit("device.disk_failed", actor, id, null, { reason });
          });
        }
      })
      .finally(() => pending.delete(id));
    pending.set(id, work);
    return work;
  }
  app.get("/api/v1/devices/:id/disk", async (req) => view(authorize(req).id));
  app.post("/api/v1/devices/:id/disk/collect", async (req) => {
    const { user, id, device } = authorize(req);
    const body = object(req.body);
    keys(body, ["v"]);
    version(body);
    if (device.revoked_at) fail(409, "DEVICE_REVOKED");
    d.rate.check("disk-viewer:" + user.id, 30);
    d.rate.check("disk-global", 120);
    await collect(id, user.id);
    authorize(req); // Recheck scope/session after waiting for a shared collection.
    return view(id);
  });
  app.put("/api/v1/devices/:id/disk/settings", async (req) => {
    const { user, id, device } = authorize(req, true);
    if (device.revoked_at) fail(409, "DEVICE_REVOKED");
    const body = object(req.body);
    keys(body, ["v", "revision", "interval_hours"]);
    version(body);
    const interval = integer(body.interval_hours, 1, 24);
    if (!INTERVALS.includes(interval)) fail(400, "INVALID_DISK_INTERVAL");
    const saved = row(id);
    if (
      integer(body.revision, 0, Number.MAX_SAFE_INTEGER - 1) !== saved.revision
    )
      fail(409, "REVISION_CONFLICT");
    d.store.transaction(() => {
      db.prepare(
        "UPDATE device_disks SET interval_hours=?,revision=revision+1,next_at=? WHERE device_id=?",
      ).run(interval, now() + interval * HOUR, id);
      d.store.audit("device.disk_schedule_updated", user.id, id, null, {
        interval_hours: interval,
      });
    });
    return view(id);
  });
  function tick() {
    if (closed) return;
    try {
      // New devices start one full interval later; jitter avoids a restart/enrollment stampede.
      db.prepare(
        "INSERT OR IGNORE INTO device_disks(device_id,next_at) SELECT id,? + abs(random() % 900000) FROM devices WHERE revoked_at IS NULL",
      ).run(now() + 24 * HOUR);
      const due = db
        .prepare(
          "SELECT s.device_id FROM device_disks s JOIN devices d ON d.id=s.device_id WHERE s.next_at<=? AND d.revoked_at IS NULL ORDER BY s.next_at LIMIT 4",
        )
        .all(now()) as { device_id: string }[];
      for (const { device_id } of due) {
        if (pending.size >= 4) break;
        void collect(device_id, null).catch((error) =>
          app.log.error(
            { err: { code: error?.code } },
            "Disk collection failed",
          ),
        );
      }
    } catch (error) {
      app.log.error(
        { err: { code: (error as any)?.code } },
        "Disk schedule unavailable",
      );
    }
  }
  const timer = setInterval(tick, 60000);
  timer.unref();
  async function close() {
    closed = true;
    clearInterval(timer);
    for (const request of requests.values())
      request.finish(undefined, "SERVER_SHUTDOWN");
    await Promise.allSettled(pending.values());
  }
  app.addHook("onClose", close);
  return {
    tick,
    close,
    receive(deviceId: string, connectionId: string, value: unknown) {
      const body = object(value);
      keys(body, ["request_id", "usage", "error"]);
      const request = requests.get(str(body.request_id, 36, 36));
      if (
        !request ||
        request.deviceId !== deviceId ||
        request.connectionId !== connectionId
      )
        return;
      if (body.usage !== null) {
        if (body.error !== null) fail(400, "INVALID_DISK_USAGE");
        request.finish(validateDiskUsage(body.usage));
      } else {
        if (body.error !== "DISK_COLLECTION_FAILED")
          fail(400, "INVALID_DISK_USAGE");
        request.finish(undefined, body.error);
      }
    },
    disconnect(deviceId: string, connectionId: string) {
      for (const request of requests.values())
        if (
          request.deviceId === deviceId &&
          request.connectionId === connectionId
        )
          request.finish(undefined, "DEVICE_OFFLINE");
    },
  };
}
