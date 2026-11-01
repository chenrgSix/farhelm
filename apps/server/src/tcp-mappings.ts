import { randomUUID } from "node:crypto";
import {
  createServer,
  type Server,
  type Socket,
  type BlockList,
} from "node:net";
import type { FastifyInstance, FastifyRequest } from "fastify";
import { auditContext } from "./audit-context.js";
import type { Store } from "./store.js";
import type { User } from "./types.js";
import type { MappingLogin } from "./ssh-forwarding.js";
import {
  mappingConfig,
  sourcePolicy,
  sourceAllowed,
  type MappingConfig,
} from "./tcp-mapping-policy.js";
import { ApiError, fail, integer, keys, object, str, version } from "./util.js";

export type TcpMapping = MappingConfig & {
  id: string;
  device_id: string;
  owner_id: string;
  revision: number;
  created_at: number;
  updated_at: number;
};
type Runtime = {
  server: Server;
  mapping: TcpMapping;
  active: boolean;
  sockets: Set<Socket>;
  lastDenied: number;
};
interface Dependencies {
  store: Store;
  admin(req: FastifyRequest): User;
  availableStorage(): void;
  permission(mapping: TcpMapping): User;
  forward(
    login: MappingLogin,
    host: string,
    port: number,
    socket: Socket,
    signal: AbortSignal,
  ): Promise<void>;
}
const code = (error: unknown) =>
  error instanceof Error ? error.message.slice(0, 128) : "MAPPING_FAILED";
export class TcpMappings {
  private live = new Map<string, Runtime>();
  private errors = new Map<string, string>();
  private cache = new Map<
    string,
    { mapping: TcpMapping; sources: BlockList; suspension: string | null }
  >();
  private queue: Promise<unknown> = Promise.resolve();
  private closing = false;
  private closings = new Set<Promise<void>>();
  constructor(private d: Dependencies) {}
  private exclusive<T>(fn: () => Promise<T>): Promise<T> {
    const result = this.queue.then(() => {
      if (this.closing) fail(503, "SERVER_CLOSING");
      return fn();
    });
    this.queue = result.catch(() => {});
    return result;
  }
  private parse(row: any): TcpMapping {
    const cached = this.cache.get(row.id);
    if (cached && cached.mapping.revision === row.revision)
      return cached.mapping;
    const config = mappingConfig(
      { v: 1, ...JSON.parse(row.config_json) },
      false,
    );
    const mapping = {
      ...config,
      id: row.id,
      device_id: row.device_id,
      owner_id: row.owner_id,
      revision: row.revision,
      created_at: row.created_at,
      updated_at: row.updated_at,
    };
    this.cache.set(mapping.id, {
      mapping,
      sources: sourcePolicy(config.source_cidrs),
      suspension: row.suspended_reason,
    });
    return mapping;
  }
  private current(id: string) {
    const row = this.d.store.db
      .prepare("SELECT * FROM tcp_mappings WHERE id=?")
      .get(id);
    if (!row) fail(404, "MAPPING_NOT_FOUND");
    return this.parse(row);
  }
  authorize(id: string, revision?: number, source?: string) {
    const mapping = this.current(id);
    const suspension = this.cache.get(id)!.suspension;
    if (suspension) fail(403, suspension);
    if (
      !mapping.enabled ||
      (revision !== undefined && mapping.revision !== revision)
    )
      fail(403, "MAPPING_DISABLED_OR_CHANGED");
    let user: User;
    try {
      user = this.d.permission(mapping);
    } catch (error) {
      if (error instanceof ApiError && error.statusCode === 403) {
        this.d.store.db
          .prepare(
            "UPDATE tcp_mappings SET suspended_reason=?,revision=revision+1,updated_at=? WHERE id=? AND revision=? AND suspended_reason IS NULL",
          )
          .run(error.code, Date.now(), id, mapping.revision);
      }
      throw error;
    }
    if (
      source !== undefined &&
      !sourceAllowed(this.cache.get(id)!.sources, source)
    )
      fail(403, "MAPPING_SOURCE_DENIED");
    return { mapping, user };
  }
  private view(mapping: TcpMapping) {
    const runtime = this.live.get(mapping.id);
    return {
      ...mapping,
      status: !mapping.enabled
        ? "disabled"
        : runtime?.active
          ? "listening"
          : "error",
      error: mapping.enabled
        ? (this.cache.get(mapping.id)?.suspension ??
          this.errors.get(mapping.id) ??
          (runtime?.active ? null : "MAPPING_NOT_LISTENING"))
        : null,
      connections: runtime?.sockets.size ?? 0,
    };
  }
  private disconnect(runtime: Runtime) {
    for (const socket of runtime.sockets) socket.destroy();
  }
  private stop(runtime: Runtime) {
    runtime.active = false;
    if (this.live.get(runtime.mapping.id) === runtime)
      this.live.delete(runtime.mapping.id);
    this.disconnect(runtime);
    const closed = new Promise<void>((resolve) =>
      runtime.server.close(() => resolve()),
    );
    this.closings.add(closed);
    void closed.finally(() => this.closings.delete(closed));
  }
  stopAll(reason: string) {
    for (const runtime of this.live.values()) {
      this.errors.set(runtime.mapping.id, reason);
      this.stop(runtime);
    }
  }
  tick() {
    for (const runtime of this.live.values()) {
      try {
        this.authorize(runtime.mapping.id, runtime.mapping.revision);
      } catch (error) {
        this.errors.set(runtime.mapping.id, code(error));
        this.stop(runtime);
      }
    }
  }
  permissionsChanged() {
    this.tick();
    // Include mappings that had already stopped (for example, after a bind failure).
    for (const row of this.d.store.db
      .prepare(
        "SELECT id FROM tcp_mappings WHERE suspended_reason IS NULL AND json_extract(config_json,'$.enabled')=1",
      )
      .all()) {
      const id = String(row.id);
      if (!this.live.has(id)) {
        try {
          this.authorize(id);
        } catch (error) {
          this.errors.set(id, code(error));
        }
      }
    }
  }
  private denied(runtime: Runtime, source: string, reason: string) {
    // Bound unauthenticated rejection logging; do not let scans fill audit storage.
    if (Date.now() - runtime.lastDenied >= 1000) {
      runtime.lastDenied = Date.now();
      try {
        this.d.store.auditMappingClient(
          "mapping.connection_denied",
          runtime.mapping.owner_id,
          runtime.mapping.device_id,
          {
            mapping_id: runtime.mapping.id,
            source_address: source,
            reason,
          },
        );
      } catch {
        /* already closed */
      }
    }
  }
  private accept(runtime: Runtime, socket: Socket) {
    socket.on("error", () => {});
    if (
      !runtime.active ||
      this.live.get(runtime.mapping.id) !== runtime ||
      this.closing
    ) {
      socket.destroy();
      return;
    }
    const controller = new AbortController(),
      source = socket.remoteAddress ?? "";
    runtime.sockets.add(socket);
    socket.once("close", () => {
      controller.abort();
      runtime.sockets.delete(socket);
    });
    auditContext.run({ source: "system", remote_address: source }, () => {
      try {
        this.d.availableStorage();
        const { mapping, user } = this.authorize(
          runtime.mapping.id,
          runtime.mapping.revision,
          source,
        );
        const login = {
          user,
          deviceId: mapping.device_id,
          mapping: { id: mapping.id, revision: mapping.revision, source },
        };
        void this.d
          .forward(
            login,
            mapping.target_host,
            mapping.target_port,
            socket,
            controller.signal,
          )
          .catch((error) => {
            socket.destroy();
            if (error instanceof ApiError)
              this.denied(runtime, source, error.code);
          });
      } catch (error) {
        socket.destroy();
        this.denied(
          runtime,
          source,
          error instanceof ApiError ? error.code : "MAPPING_FAILED",
        );
      }
    });
  }
  private async bind(mapping: TcpMapping) {
    const server = createServer({ allowHalfOpen: true, pauseOnConnect: true });
    const runtime: Runtime = {
      server,
      mapping,
      active: false,
      sockets: new Set(),
      lastDenied: 0,
    };
    server.maxConnections = 16;
    // Node drops excess sockets before emitting "connection".
    server.on("drop", (peer) => {
      if (!runtime.active || this.closing) return;
      const source = peer?.remoteAddress ?? "";
      auditContext.run({ source: "system", remote_address: source }, () =>
        this.denied(runtime, source, "FORWARD_LIMIT"),
      );
    });
    server.on("connection", (socket) => this.accept(runtime, socket));
    try {
      await new Promise<void>((resolve, reject) => {
        server.once("error", reject);
        server.listen(
          {
            host: mapping.listen_host,
            port: mapping.listen_port,
            ipv6Only: true,
            exclusive: true,
          },
          () => {
            server.removeListener("error", reject);
            resolve();
          },
        );
      });
    } catch (error: any) {
      server.close();
      fail(
        409,
        error.code === "EADDRINUSE"
          ? "MAPPING_PORT_IN_USE"
          : error.code === "EADDRNOTAVAIL"
            ? "MAPPING_BIND_UNAVAILABLE"
            : "MAPPING_LISTEN_FAILED",
      );
    }
    server.on("error", () => {
      this.errors.set(mapping.id, "MAPPING_LISTENER_FAILED");
      this.stop(runtime);
    });
    return runtime;
  }
  private activate(runtime: Runtime, mapping: TcpMapping) {
    runtime.mapping = mapping;
    runtime.active = true;
    this.live.set(mapping.id, runtime);
    this.errors.delete(mapping.id);
  }
  start() {
    return this.exclusive(async () => {
      for (const row of this.d.store.db
        .prepare("SELECT * FROM tcp_mappings ORDER BY created_at,id")
        .all()) {
        const mapping = this.parse(row);
        if (!mapping.enabled || this.live.has(mapping.id)) continue;
        try {
          this.authorize(mapping.id);
          const runtime = await this.bind(mapping);
          try {
            this.authorize(mapping.id, mapping.revision);
            this.activate(runtime, mapping);
          } catch (error) {
            this.stop(runtime);
            throw error;
          }
        } catch (error) {
          this.errors.set(mapping.id, code(error));
        }
      }
    });
  }
  async close() {
    this.closing = true;
    await this.queue;
    this.stopAll("SERVER_SHUTDOWN");
    await Promise.all([...this.closings]);
  }
  register(app: FastifyInstance) {
    const request = (req: FastifyRequest) => {
      const user = this.d.admin(req),
        deviceId = str((req.params as any).id, 1, 128);
      if (
        !this.d.store.db
          .prepare("SELECT 1 FROM devices WHERE id=? AND revoked_at IS NULL")
          .get(deviceId)
      )
        fail(404, "DEVICE_NOT_FOUND");
      return { user, deviceId };
    };
    const path = "/api/v1/devices/:id/tcp-mappings";
    app.get(path, async (req) => {
      const { deviceId } = request(req);
      this.tick();
      return {
        v: 1,
        mappings: this.d.store.db
          .prepare(
            "SELECT * FROM tcp_mappings WHERE device_id=? ORDER BY created_at,id",
          )
          .all(deviceId)
          .map((row) => this.view(this.parse(row))),
      };
    });
    const save = (req: FastifyRequest, updating: boolean) =>
      this.exclusive(async () => {
        const { user, deviceId } = request(req),
          config = mappingConfig(req.body, updating);
        const id = updating
          ? str((req.params as any).mappingId, 1, 128)
          : randomUUID();
        const before = updating ? this.current(id) : undefined;
        if (before && before.device_id !== deviceId)
          fail(404, "MAPPING_NOT_FOUND");
        const revision = updating
          ? integer(object(req.body).revision, 1, Number.MAX_SAFE_INTEGER - 1)
          : 0;
        if (before && before.revision !== revision)
          fail(409, "MAPPING_CHANGED_RELOAD");
        if (!before) {
          const counts = this.d.store.db
            .prepare(
              "SELECT COUNT(*) AS total,SUM(device_id=?) AS device FROM tcp_mappings",
            )
            .get(deviceId)!;
          if (Number(counts.total) >= 128 || Number(counts.device) >= 16)
            fail(429, "MAPPING_LIMIT");
        }
        const now = Date.now(),
          next: TcpMapping = {
            ...config,
            id,
            device_id: deviceId,
            owner_id: before?.owner_id ?? user.id,
            revision: revision + 1,
            created_at: before?.created_at ?? now,
            updated_at: now,
          };
        if (next.enabled) this.d.permission(next);
        this.d.availableStorage();
        const previous = this.live.get(id);
        const reusable =
          next.enabled &&
          previous?.mapping.listen_host === next.listen_host &&
          previous.mapping.listen_port === next.listen_port;
        const staged =
          next.enabled && !reusable ? await this.bind(next) : undefined;
        try {
          // Re-authenticate after asynchronous binding and before committing.
          request(req);
          if (next.enabled) this.d.permission(next);
          this.d.availableStorage();
          this.d.store.transaction(() => {
            if (before && this.current(id).revision !== revision)
              fail(409, "MAPPING_CHANGED_RELOAD");
            this.d.store.db
              .prepare(
                "INSERT INTO tcp_mappings(id,device_id,owner_id,config_json,revision,created_at,updated_at) VALUES(?,?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET config_json=excluded.config_json,revision=excluded.revision,updated_at=excluded.updated_at,suspended_reason=NULL",
              )
              .run(
                id,
                deviceId,
                next.owner_id,
                JSON.stringify(config),
                next.revision,
                next.created_at,
                now,
              );
            this.d.store.audit(
              before ? "mapping.updated" : "mapping.created",
              user.id,
              deviceId,
              null,
              {
                mapping_id: id,
                revision: next.revision,
                owner_id: next.owner_id,
                ...config,
              },
            );
          });
        } catch (error) {
          if (staged) this.stop(staged);
          throw error;
        }
        this.cache.delete(id);
        if (previous) {
          if (reusable) this.disconnect(previous);
          else this.stop(previous);
        }
        if (next.enabled) this.activate(staged ?? previous!, next);
        else this.errors.delete(id);
        return { v: 1, mapping: this.view(next) };
      });
    app.post(path, (req) => save(req, false));
    app.put(path + "/:mappingId", (req) => save(req, true));
    app.delete(path + "/:mappingId", (req) =>
      this.exclusive(async () => {
        const { user, deviceId } = request(req),
          b = object(req.body);
        version(b);
        keys(b, ["v", "revision"]);
        const id = str((req.params as any).mappingId, 1, 128),
          before = this.current(id);
        if (before.device_id !== deviceId) fail(404, "MAPPING_NOT_FOUND");
        const revision = integer(b.revision, 1, Number.MAX_SAFE_INTEGER);
        this.d.availableStorage();
        this.d.store.transaction(() => {
          if (before.revision !== revision) fail(409, "MAPPING_CHANGED_RELOAD");
          this.d.store.db
            .prepare("DELETE FROM tcp_mappings WHERE id=?")
            .run(id);
          this.d.store.audit("mapping.deleted", user.id, deviceId, null, {
            mapping_id: id,
            revision,
          });
        });
        const runtime = this.live.get(id);
        if (runtime) this.stop(runtime);
        this.errors.delete(id);
        this.cache.delete(id);
        return { v: 1, ok: true };
      }),
    );
    app.addHook("onListen", async () => {
      await this.start();
    });
  }
}
