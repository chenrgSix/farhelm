import type { FastifyInstance, FastifyRequest } from "fastify";
import type { Store } from "./store.js";
import type { User } from "./types.js";
import { fail, integer, keys, object, version } from "./util.js";
export const LIMIT_BOUNDS = {
  per_user: 128,
  per_device: 128,
  terminal_total: 1024,
  ssh_total: 1024,
  ssh_per_ip: 1024,
} as const;
export type Limits = {
  per_user: number;
  per_device: number;
  terminal_total: number;
  ssh_total: number;
  ssh_per_ip: number;
  revision: number;
  updated_at: number | null;
};
export class ConnectionLimits {
  private slots = new Map<string, string>();
  constructor(private store: Store) {}
  current(): Limits {
    const { id, ...row } = this.store.db
      .prepare("SELECT * FROM connection_limits WHERE id=1")
      .get()!;
    return row as Limits;
  }
  acquire(key: string, actorId: string) {
    if (this.slots.has(key)) {
      if (this.slots.get(key) !== actorId)
        fail(403, "CONNECTION_OWNER_MISMATCH");
      return;
    }
    if (
      [...this.slots.values()].filter((id) => id === actorId).length >=
      this.current().per_user
    )
      fail(429, "USER_CONNECTION_LIMIT");
    this.slots.set(key, actorId);
  }
  release(key: string) {
    this.slots.delete(key);
  }
  holds(key: string, actorId: string) {
    return this.slots.get(key) === actorId;
  }
  register(
    app: FastifyInstance,
    admin: (req: FastifyRequest) => User,
    availableStorage: () => void,
  ) {
    app.get("/api/v1/settings/connections", async (req) => {
      admin(req);
      return { v: 1, ...this.current() };
    });
    app.put("/api/v1/settings/connections", async (req) => {
      const user = admin(req),
        b = object(req.body);
      version(b);
      keys(b, ["v", "revision", ...Object.keys(LIMIT_BOUNDS)]);
      const revision = integer(b.revision, 0, Number.MAX_SAFE_INTEGER - 1);
      const next = Object.fromEntries(
        Object.entries(LIMIT_BOUNDS).map(([key, max]) => [
          key,
          integer(b[key], 1, max),
        ]),
      );
      availableStorage();
      return this.store.transaction(() => {
        const before = this.current();
        if (before.revision !== revision)
          fail(409, "SETTINGS_REVISION_CONFLICT");
        if (
          Object.keys(next).every(
            (key) => next[key] === before[key as keyof Limits],
          )
        )
          return { v: 1, ...before };
        this.store.db
          .prepare(
            "UPDATE connection_limits SET per_user=?,per_device=?,terminal_total=?,ssh_total=?,ssh_per_ip=?,revision=revision+1,updated_at=? WHERE id=1",
          )
          .run(
            next.per_user!,
            next.per_device!,
            next.terminal_total!,
            next.ssh_total!,
            next.ssh_per_ip!,
            Date.now(),
          );
        this.store.audit("settings.connections_updated", user.id, null, null, {
          ...next,
          revision: revision + 1,
        });
        return { v: 1, ...this.current() };
      });
    });
  }
}
