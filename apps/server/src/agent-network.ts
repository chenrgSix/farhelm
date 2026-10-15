import type { FastifyInstance, FastifyRequest } from "fastify";
import { isIP } from "node:net";
import type { Store } from "./store.js";
import type { User } from "./types.js";
import { canonical, fail, integer, keys, object, str } from "./util.js";

export function registerAgentNetwork(
  app: FastifyInstance,
  deps: {
    store: Store;
    userAuth(req: FastifyRequest): User;
    requireScope(user: User, id: string): void;
    requireDevice(id: string): {
      connection_kind?: string;
      last_seen: number | null;
    };
    online(id: string): boolean;
    supported(id: string): boolean;
  },
) {
  const db = deps.store.db;
  function snapshot(id: string) {
    const row = db
      .prepare(
        "SELECT snapshot,received_at FROM agent_network WHERE device_id=?",
      )
      .get(id) as any;
    return row
      ? { ...JSON.parse(row.snapshot), received_at: row.received_at }
      : null;
  }
  app.get("/api/v1/devices/:id/network", async (req) => {
    const user = deps.userAuth(req);
    const id = str((req.params as any).id, 1, 128);
    deps.requireScope(user, id);
    const device = deps.requireDevice(id);
    if (device.connection_kind === "ssh") fail(400, "AGENT_REQUIRED");
    const query = object(req.query);
    keys(query, ["before"]);
    const before =
      query.before === undefined
        ? Number.MAX_SAFE_INTEGER
        : integer(Number(str(query.before, 1, 16)), 1, Number.MAX_SAFE_INTEGER);
    const rows = db
      .prepare(
        "SELECT sequence,event,received_at FROM agent_network_events WHERE device_id=? AND sequence<? ORDER BY sequence DESC LIMIT 51",
      )
      .all(id, before) as any[];
    const current = snapshot(id);
    return {
      v: 1,
      device_id: id,
      device_online: deps.online(id),
      supported: deps.online(id) ? deps.supported(id) : !!current,
      last_seen: device.last_seen,
      snapshot: current,
      events: rows
        .slice(0, 50)
        .map((r) => ({ ...JSON.parse(r.event), received_at: r.received_at })),
      next_before: rows.length > 50 ? rows[49].sequence : null,
    };
  });
  return {
    snapshot,
    receive(id: string, value: unknown) {
      const b = object(value);
      keys(b, ["observed_at", "addresses", "truncated"]);
      integer(b.observed_at, 1, Number.MAX_SAFE_INTEGER);
      if (
        !Array.isArray(b.addresses) ||
        b.addresses.length > 128 ||
        typeof b.truncated !== "boolean"
      )
        fail(400, "INVALID_NETWORK_SNAPSHOT");
      const seen = new Set<string>();
      for (const value of b.addresses) {
        const a = object(value);
        keys(a, ["interface", "address", "family", "up"]);
        const name = str(a.interface, 1, 64),
          address = str(a.address, 1, 45);
        if (
          /[\x00-\x1f\x7f]/.test(name) ||
          !["ipv4", "ipv6"].includes(a.family) ||
          isIP(address) !== (a.family === "ipv4" ? 4 : 6) ||
          typeof a.up !== "boolean"
        )
          fail(400, "INVALID_NETWORK_ADDRESS");
        const key = name + ":" + address;
        if (seen.has(key)) fail(400, "DUPLICATE_NETWORK_ADDRESS");
        seen.add(key);
      }
      db.prepare(
        "INSERT INTO agent_network(device_id,snapshot,received_at) VALUES(?,?,?) ON CONFLICT(device_id) DO UPDATE SET snapshot=excluded.snapshot,received_at=excluded.received_at",
      ).run(id, canonical(b), Date.now());
    },
    event(id: string, value: unknown) {
      const b = object(value);
      keys(b, [
        "event_id",
        "reason",
        "last_contact_at",
        "detected_at",
        "recovered_at",
      ]);
      const eventId = str(b.event_id, 36, 36);
      if (
        !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(
          eventId,
        ) ||
        !["connection_lost", "connection_failed", "agent_restart"].includes(
          b.reason,
        )
      )
        fail(400, "INVALID_NETWORK_EVENT");
      const detected = integer(b.detected_at, 1, Number.MAX_SAFE_INTEGER);
      integer(b.recovered_at, detected, Number.MAX_SAFE_INTEGER);
      if (b.last_contact_at !== null)
        integer(b.last_contact_at, 1, Number.MAX_SAFE_INTEGER);
      const serialized = canonical(b);
      deps.store.transaction(() => {
        const old = db
          .prepare(
            "SELECT event FROM agent_network_events WHERE device_id=? AND event_id=?",
          )
          .get(id, eventId) as any;
        if (old && old.event !== serialized)
          fail(409, "NETWORK_EVENT_CONFLICT");
        if (!old)
          db.prepare(
            "INSERT INTO agent_network_events(device_id,event_id,event,received_at) VALUES(?,?,?,?)",
          ).run(id, eventId, serialized, Date.now());
      });
      return { event_id: eventId };
    },
  };
}
