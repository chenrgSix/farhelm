import { randomUUID } from "node:crypto";
import type { Store } from "./store.js";
import { fail, integer, keys, object, str } from "./util.js";
export interface AddressTarget {
  revision: number;
  platform_server_url: string;
}
interface Agent {
  supported: boolean;
  send(type: string, body: unknown): boolean;
}
type Row = {
  device_id: string;
  revision: number;
  request_id: string;
  server_url: string;
  status: string;
  reason: string | null;
  updated_at: number;
};
export function agentAddressSync(
  store: Store,
  agent: (id: string) => Agent | undefined,
  networkManaged: (id: string) => boolean = () => false,
) {
  const { db } = store;
  function enqueue(target: AddressTarget, retry = false) {
    const devices = db
      .prepare(
        "SELECT id,agent_server_url FROM devices WHERE connection_kind='agent' AND revoked_at IS NULL",
      )
      .all() as { id: string; agent_server_url: string | null }[];
    for (const { id, agent_server_url } of devices) {
      const serverUrl = agent_server_url ?? target.platform_server_url;
      const old = row(id);
      if (
        old?.revision === target.revision &&
        old.server_url === serverUrl &&
        (!retry || ["applied", "saved", "checking"].includes(old.status))
      )
        continue;
      db.prepare(
        "INSERT INTO agent_address_sync(device_id,revision,request_id,server_url,status,reason,updated_at) VALUES(?,?,?,?,'pending',NULL,?) ON CONFLICT(device_id) DO UPDATE SET revision=excluded.revision,request_id=excluded.request_id,server_url=excluded.server_url,status='pending',reason=NULL,updated_at=excluded.updated_at",
      ).run(id, target.revision, randomUUID(), serverUrl, Date.now());
    }
  }
  function row(id: string) {
    return db
      .prepare("SELECT * FROM agent_address_sync WHERE device_id=?")
      .get(id) as Row | undefined;
  }
  function result(id: string, value: unknown) {
    const b = object(value);
    keys(b, ["request_id", "revision", "status", "reason"]);
    const requestId = str(b.request_id, 36, 36),
      revision = integer(b.revision, 1, Number.MAX_SAFE_INTEGER);
    const status = str(b.status, 1, 16),
      reason = b.reason === null ? null : str(b.reason, 1, 64);
    if (
      !["saved", "applied", "failed"].includes(status) ||
      (status === "failed"
        ? !["PROBE_FAILED", "PERSIST_FAILED", "CONNECT_FAILED"].includes(
            reason ?? "",
          )
        : reason !== null)
    )
      fail(400, "INVALID_ADDRESS_RESULT");
    const r = row(id);
    if (!r || r.request_id !== requestId || r.revision !== revision) return;
    // A delayed result must not downgrade a confirmed connection or a superseding attempt.
    if (
      r.status === "applied" ||
      (r.status === "saved" && status === "saved") ||
      (r.status === "failed" && status !== "applied") ||
      r.status === status
    )
      return;
    update(r, status, reason);
  }
  function update(r: Row, status: string, reason: string | null) {
    store.transaction(() => {
      db.prepare(
        "UPDATE agent_address_sync SET status=?,reason=?,updated_at=? WHERE device_id=?",
      ).run(status, reason, Date.now(), r.device_id);
      store.audit("settings.agent_sync", null, r.device_id, null, {
        revision: r.revision,
        status,
        reason,
      });
    });
  }
  function deliver(id: string) {
    const r = row(id),
      a = agent(id);
    if (!r || r.status !== "pending" || !a?.supported || networkManaged(id))
      return;
    if (
      a.send("agent.address.update", {
        request_id: r.request_id,
        revision: r.revision,
        server_url: r.server_url,
      })
    )
      db.prepare(
        "UPDATE agent_address_sync SET status='checking',reason=NULL,updated_at=? WHERE device_id=?",
      ).run(Date.now(), id);
  }
  function connected(id: string, serverUrl: unknown, target: AddressTarget) {
    if (!agent(id)?.supported) return;
    const url = str(serverUrl, 1, 2048);
    if (target.revision < 1) return;
    // Include Agents enrolled after the setting was saved.
    enqueue(target);
    if (networkManaged(id)) return;
    const r = row(id)!;
    if (r.status === "applied" && r.server_url === url) return;
    if (["checking", "saved", "applied"].includes(r.status))
      db.prepare(
        "UPDATE agent_address_sync SET status='pending',updated_at=? WHERE device_id=?",
      ).run(Date.now(), id);
    deliver(id);
  }
  function flush() {
    for (const r of db
      .prepare(
        "SELECT * FROM agent_address_sync WHERE status IN ('pending','checking')",
      )
      .all() as Row[]) {
      if (
        r.status === "checking" &&
        (!agent(r.device_id) || networkManaged(r.device_id))
      )
        db.prepare(
          "UPDATE agent_address_sync SET status='pending',updated_at=? WHERE device_id=?",
        ).run(Date.now(), r.device_id);
      else if (r.status === "checking" && Date.now() - r.updated_at > 45000)
        update(r, "failed", "TIMEOUT");
      else deliver(r.device_id);
    }
  }
  function snapshot(target: AddressTarget) {
    return {
      v: 1,
      revision: target.revision,
      devices: (
        db
          .prepare(
            "SELECT s.*,d.name FROM agent_address_sync s JOIN devices d ON d.id=s.device_id WHERE d.connection_kind='agent' AND d.revoked_at IS NULL ORDER BY d.name,d.id",
          )
          .all() as (Row & { name: string })[]
      ).map((r) => {
        const a = agent(r.device_id);
        return {
          device_id: r.device_id,
          name: r.name,
          revision: r.revision,
          server_url: r.server_url,
          status: networkManaged(r.device_id)
            ? "network_managed"
            : a && !a.supported
              ? "unsupported"
              : r.status,
          reason: networkManaged(r.device_id) ? null : r.reason,
          online: !!a,
          updated_at: r.updated_at,
        };
      }),
    };
  }
  return { enqueue, result, connected, flush, snapshot };
}
