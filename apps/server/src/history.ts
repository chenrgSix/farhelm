import type { DatabaseSync, SQLInputValue } from "node:sqlite";
import type { User } from "./types.js";
import { canReadOtherRecordings } from "./permissions.js";
import { fail, hash, integer, keys, object, str } from "./util.js";

type Kind = "tasks" | "audit" | "sessions";
const taskStatuses = [
  "QUEUED",
  "SENT",
  "ACCEPTED",
  "RUNNING",
  "SUCCEEDED",
  "FAILED",
  "TIMED_OUT",
  "CANCELLED",
  "EXPIRED",
  "UNKNOWN",
];
const sessionStatuses = ["OPENING", "OPEN", "CLOSED", "INTERRUPTED"];

/** Apply authorization before pagination, including when a client supplies a cursor. */
export function historyPage(
  db: DatabaseSync,
  user: User,
  kind: Kind,
  raw: unknown,
) {
  const query = object(raw);
  keys(query, [
    "limit",
    "cursor",
    "q",
    "device_id",
    "actor_id",
    "status",
    "action",
    "from",
    "to",
  ]);
  const text = (name: string, max = 256) =>
    query[name] === undefined ? "" : str(query[name], 1, max).trim();
  const number = (name: string) => {
    const value = str(query[name], 1, 16);
    if (!/^\d+$/.test(value)) fail(400, "INVALID_HISTORY_QUERY");
    return integer(Number(value), 0, Number.MAX_SAFE_INTEGER);
  };
  const limit =
    query.limit === undefined
      ? kind === "audit"
        ? 1000
        : 500
      : integer(number("limit"), 1, 100);
  const q = text("q"),
    device = text("device_id", 128),
    actor = text("actor_id", 128),
    status = text("status", 32),
    action = text("action", 128);
  const from = query.from === undefined ? undefined : number("from");
  const to = query.to === undefined ? undefined : number("to");
  if (
    (from !== undefined && to !== undefined && from > to) ||
    (action && kind !== "audit") ||
    (status &&
      (kind === "audit" ||
        !(kind === "tasks" ? taskStatuses : sessionStatuses).includes(status)))
  )
    fail(400, "INVALID_HISTORY_QUERY");
  const filter = hash(
    JSON.stringify({
      kind,
      user: user.id,
      scope: user.device_scope,
      role: user.role,
      otherRecordings: kind === "sessions" && canReadOtherRecordings(user),
      limit,
      q,
      device,
      actor,
      status,
      action,
      from,
      to,
    }),
  );
  const conditions: string[] = [];
  const values: SQLInputValue[] = [];
  const add = (condition: string, ...args: SQLInputValue[]) => {
    conditions.push(`(${condition})`);
    values.push(...args);
  };
  const scope = Array.isArray(user.device_scope) ? user.device_scope : [];
  if (user.role !== "admin") {
    if (kind === "audit") {
      if (user.device_scope === "*")
        add("r.device_id IS NOT NULL OR r.actor_id=?", user.id);
      else if (scope.length)
        add(
          "r.actor_id=? OR r.device_id IN (SELECT value FROM json_each(?))",
          user.id,
          JSON.stringify(scope),
        );
      else add("r.actor_id=?", user.id);
    } else if (user.device_scope !== "*") {
      if (scope.length)
        add(
          "r.device_id IN (SELECT value FROM json_each(?))",
          JSON.stringify(scope),
        );
      else add("0");
    }
  }
  if (kind === "sessions" && !canReadOtherRecordings(user))
    add("r.actor_id=?", user.id);
  if (device) add("r.device_id=?", device);
  if (actor) add("r.actor_id=? OR u.username=?", actor, actor);
  if (status) add("r.status=?", status);
  if (action) add("r.action=?", action);
  const time = kind === "audit" ? "r.at" : "r.created_at";
  if (from !== undefined) add(`${time}>=?`, from);
  if (to !== undefined) add(`${time}<=?`, to);
  if (q) {
    const pattern = `%${q.replace(/[\\%_]/g, "\\$&")}%`;
    const columns = [
      "CAST(r.id AS TEXT)",
      "r.device_id",
      "d.name",
      "r.actor_id",
      "u.username",
      ...(kind === "tasks"
        ? ["r.task_json", "r.status"]
        : kind === "audit"
          ? ["r.action", "r.task_id"]
          : ["r.status"]),
    ];
    add(
      columns.map((column) => `${column} LIKE ? ESCAPE '\\'`).join(" OR "),
      ...columns.map(() => pattern),
    );
  }
  if (query.cursor !== undefined) {
    let cursor: Record<string, any>;
    try {
      const encoded = str(query.cursor, 1, 2048);
      if (!/^[A-Za-z0-9_-]+$/.test(encoded)) throw new Error();
      cursor = object(
        JSON.parse(Buffer.from(encoded, "base64url").toString("utf8")),
      );
      keys(cursor, ["v", "kind", "filter", "at", "id"]);
      if (cursor.v !== 1 || cursor.kind !== kind || cursor.filter !== filter)
        throw new Error();
      integer(cursor.at, 0, Number.MAX_SAFE_INTEGER);
      if (kind === "audit") integer(cursor.id, 1, Number.MAX_SAFE_INTEGER);
      else str(cursor.id, 1, 128);
    } catch {
      fail(400, "INVALID_HISTORY_CURSOR");
    }
    if (kind === "audit") add("r.id<?", cursor.id);
    else
      add(
        `${time}<? OR (${time}=? AND r.id<?)`,
        cursor.at,
        cursor.at,
        cursor.id,
      );
  }
  const table = kind === "sessions" ? "terminal_sessions" : kind;
  const order = kind === "audit" ? "r.id DESC" : "r.created_at DESC,r.id DESC";
  const rows = db
    .prepare(
      `SELECT r.* FROM ${table} r LEFT JOIN devices d ON d.id=r.device_id LEFT JOIN users u ON u.id=r.actor_id${conditions.length ? " WHERE " + conditions.join(" AND ") : ""} ORDER BY ${order} LIMIT ?`,
    )
    .all(...values, limit + 1) as Record<string, any>[];
  const hasMore = rows.length > limit;
  if (hasMore) rows.pop();
  const last = rows.at(-1);
  const nextCursor =
    hasMore && last
      ? Buffer.from(
          JSON.stringify({
            v: 1,
            kind,
            filter,
            at: kind === "audit" ? last.at : last.created_at,
            id: last.id,
          }),
        ).toString("base64url")
      : null;
  return { rows, page: { limit, has_more: hasMore, next_cursor: nextCursor } };
}
