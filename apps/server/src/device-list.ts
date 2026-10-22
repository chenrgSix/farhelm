import type { DatabaseSync, SQLInputValue } from "node:sqlite";
import type { User } from "./types.js";
import { fail, integer, keys, object, str } from "./util.js";

/** Legacy callers keep the full list. Opt-in queries filter and page IDs before projection. */
export function deviceListPage(db: DatabaseSync, user: User, raw: unknown) {
  const query = object(raw);
  keys(query, ["page", "limit", "q", "group"]);
  if (!Object.keys(query).length) return null;
  const number = (name: string, fallback: number, max: number) => {
    if (query[name] === undefined) return fallback;
    const text = str(query[name], 1, 16);
    if (!/^\d+$/.test(text)) fail(400, "INVALID_DEVICE_QUERY");
    return integer(Number(text), 1, max);
  };
  const requested = number("page", 1, Number.MAX_SAFE_INTEGER);
  const limit = number("limit", 50, 100);
  const q =
    query.q === undefined ? "" : str(query.q, 0, 256).trim().toLowerCase();
  const group = query.group === undefined ? "" : str(query.group, 0, 128);
  const scope = "(? OR d.id IN (SELECT value FROM json_each(?)))";
  const scopeArgs: SQLInputValue[] = [
    Number(user.role === "admin" || user.device_scope === "*"),
    JSON.stringify(user.device_scope === "*" ? [] : user.device_scope),
  ];
  const conditions = [scope],
    args = [...scopeArgs];
  if (group === "__ungrouped__")
    conditions.push(
      "NOT EXISTS (SELECT 1 FROM device_group_members m WHERE m.device_id=d.id)",
    );
  else if (group) {
    conditions.push(
      "EXISTS (SELECT 1 FROM device_group_members m WHERE m.device_id=d.id AND m.group_id=?)",
    );
    args.push(group);
  }
  if (q) {
    // instr treats %, _ and backslashes literally; no LIKE wildcard surprises.
    conditions.push(`(instr(lower(d.name || ' ' || d.id || ' ' || coalesce(d.agent_version,'')),?)>0
      OR EXISTS (SELECT 1 FROM device_group_members m JOIN device_groups g ON g.id=m.group_id
        WHERE m.device_id=d.id AND instr(lower(g.name),?)>0)
      OR EXISTS (SELECT 1 FROM agent_network n, json_each(n.snapshot,'$.addresses') a
        WHERE n.device_id=d.id AND d.connection_kind='agent' AND instr(lower(json_extract(a.value,'$.address')),?)>0))`);
    args.push(q, q, q);
  }
  const where = conditions.join(" AND ");
  const total = Number(
    db
      .prepare(`SELECT count(*) AS n FROM devices d WHERE ${where}`)
      .get(...args)!.n,
  );
  const pages = Math.max(1, Math.ceil(total / limit));
  const page = Math.min(requested, pages);
  const ids = db
    .prepare(
      `SELECT d.id FROM devices d WHERE ${where} ORDER BY d.created_at,d.id LIMIT ? OFFSET ?`,
    )
    .all(...args, limit, (page - 1) * limit)
    .map((row) => String(row.id));
  const visible_total = Number(
    db
      .prepare(`SELECT count(*) AS n FROM devices d WHERE ${scope}`)
      .get(...scopeArgs)!.n,
  );
  // Facets cover the entire authorized scope, never just the current page/filter.
  const groups = db
    .prepare(
      `SELECT g.id,g.name FROM device_groups g WHERE EXISTS (
    SELECT 1 FROM device_group_members m JOIN devices d ON d.id=m.device_id
    WHERE m.group_id=g.id AND ${scope}) ORDER BY g.name,g.id`,
    )
    .all(...scopeArgs);
  return {
    ids,
    page: { number: page, limit, total, pages, visible_total, groups },
  };
}
