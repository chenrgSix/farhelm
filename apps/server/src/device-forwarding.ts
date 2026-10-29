import type { FastifyInstance, FastifyRequest } from "fastify";
import type { Store } from "./store.js";
import type { User } from "./types.js";
import { fail, integer, keys, object, str, version } from "./util.js";

export class DeviceForwarding {
  constructor(private store: Store) {}

  current(deviceId: string) {
    const row = this.store.db
      .prepare(
        "SELECT enabled,revision,updated_at FROM device_forwarding WHERE device_id=?",
      )
      .get(deviceId);
    return {
      v: 1,
      device_id: deviceId,
      enabled: row?.enabled === 1,
      revision: Number(row?.revision ?? 0),
      updated_at: row?.updated_at ?? null,
    };
  }

  requireAllowed(deviceId: string) {
    if (!this.current(deviceId).enabled)
      fail(403, "DEVICE_FORWARDING_DISABLED");
  }

  register(
    app: FastifyInstance,
    admin: (req: FastifyRequest) => User,
    availableStorage: () => void,
    changed: () => void,
  ) {
    const deviceRequest = (req: FastifyRequest) => {
      const user = admin(req),
        id = str((req.params as any).id, 1, 128);
      if (
        !this.store.db
          .prepare("SELECT 1 FROM devices WHERE id=? AND revoked_at IS NULL")
          .get(id)
      )
        fail(404, "DEVICE_NOT_FOUND");
      return { user, id };
    };
    app.get("/api/v1/devices/:id/forwarding", async (req) =>
      this.current(deviceRequest(req).id),
    );
    app.put("/api/v1/devices/:id/forwarding", async (req) => {
      const { user, id } = deviceRequest(req),
        b = object(req.body);
      version(b);
      keys(b, ["v", "revision", "enabled"]);
      const revision = integer(b.revision, 0, Number.MAX_SAFE_INTEGER - 1);
      if (typeof b.enabled !== "boolean")
        fail(400, "INVALID_FORWARDING_ENABLED");
      const enabled = b.enabled;
      availableStorage();
      const saved = this.store.transaction(() => {
        const before = this.current(id);
        if (before.revision !== revision)
          fail(409, "DEVICE_FORWARDING_CHANGED_RELOAD");
        if (before.enabled === enabled) return before;
        this.store.db
          .prepare(
            "INSERT INTO device_forwarding(device_id,enabled,revision,updated_at) VALUES(?,?,?,?) ON CONFLICT(device_id) DO UPDATE SET enabled=excluded.enabled,revision=excluded.revision,updated_at=excluded.updated_at",
          )
          .run(id, Number(enabled), revision + 1, Date.now());
        const result = this.current(id);
        this.store.audit("device.forwarding_updated", user.id, id, null, {
          revision: result.revision,
          enabled,
        });
        return result;
      });
      // Recheck live and pending forwards only after the policy and audit commit.
      changed();
      return saved;
    });
  }
}
