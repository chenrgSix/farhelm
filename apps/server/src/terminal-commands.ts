import type { DatabaseSync, SQLInputValue } from "node:sqlite";
import type { User } from "./types.js";
import { canReadOtherRecordings } from "./permissions.js";
import { fail, hash, integer, keys, object, str } from "./util.js";

export const COMMAND_WINDOW_MS = 7 * 24 * 60 * 60 * 1000;
type CommandEvent =
  | { kind: "output"; data: Buffer }
  | { kind: "ready"; shell: string }
  | { kind: "command"; command: string; redacted: boolean }
  | { kind: "end"; code: number };

export function commandText(text: string) {
  // Omit the whole submitted line rather than guess quoting/argument boundaries.
  // Password prompts and REPL input never reach this function in the first place.
  const sensitive =
    /password|passwd|passphrase|secret|token|credential|api[_-]?key|authorization|sshpass|chpasswd|<<|:\/\/[^\s/:]+:[^\s@]+@|\s--?(?:pass|passin|passout|pw)\b|\b(?:mysql|mariadb)\b[^\n]*\s-p\S*|\b(?:docker|podman)\s+login\b[^\n]*\s-p\S*|\bredis-cli\b[^\n]*\s-a\S*|\bcurl\b[^\n]*\s(?:-u\S*|--user(?:=|\s)|--proxy-user(?:=|\s))/i;
  if (Buffer.byteLength(text) > 8192 || sensitive.test(text))
    return { command: "[敏感或过长命令已隐藏]", redacted: true };
  return {
    command: text.replace(/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/g, "�"),
    redacted: false,
  };
}

/** Strip shell metadata before both recording and display, even across frames. */
export class CommandStream {
  private pending = Buffer.alloc(0);
  private readonly prefix: Buffer;
  constructor(sessionId: string) {
    this.prefix = Buffer.from(`\x1b]777;farhelm;${sessionId};`);
  }
  push(chunk: Buffer): CommandEvent[] {
    let data = Buffer.concat([this.pending, chunk]);
    this.pending = Buffer.alloc(0);
    const events: CommandEvent[] = [];
    while (data.length) {
      const start = data.indexOf(this.prefix);
      if (start < 0) {
        let keep = Math.min(data.length, this.prefix.length - 1);
        while (
          keep &&
          !data.subarray(-keep).equals(this.prefix.subarray(0, keep))
        )
          keep--;
        if (data.length > keep)
          events.push({
            kind: "output",
            data: data.subarray(0, data.length - keep),
          });
        this.pending = keep
          ? Buffer.from(data.subarray(-keep))
          : Buffer.alloc(0);
        break;
      }
      if (start) events.push({ kind: "output", data: data.subarray(0, start) });
      data = data.subarray(start);
      const end = data.indexOf(7, this.prefix.length);
      if (end < 0) {
        if (data.length > 32768) throw new Error("Command metadata limit");
        this.pending = Buffer.from(data);
        break;
      }
      const value = data.subarray(this.prefix.length, end).toString("utf8");
      data = data.subarray(end + 1);
      if (/^R;(bash|zsh)$/.test(value))
        events.push({ kind: "ready", shell: value.slice(2) });
      else if (/^E;\d{1,3}$/.test(value) && Number(value.slice(2)) <= 255)
        events.push({ kind: "end", code: Number(value.slice(2)) });
      else if (value === "X;limit")
        events.push({
          kind: "command",
          command: "[敏感或过长命令已隐藏]",
          redacted: true,
        });
      else if (value.startsWith("C;") && value.length <= 22000) {
        const encoded = value.slice(2),
          decoded = Buffer.from(encoded, "base64");
        if (decoded.length && decoded.toString("base64") === encoded)
          events.push({
            kind: "command",
            ...commandText(decoded.toString("utf8")),
          });
      }
    }
    return events;
  }
}

export function commandHistory(
  db: DatabaseSync,
  user: User,
  deviceId: string,
  raw: unknown,
) {
  const query = object(raw);
  keys(query, ["from", "to", "q", "actor", "cursor", "limit"]);
  const timestamp = (key: string) => {
    if (typeof query[key] !== "string" || !/^\d{1,16}$/.test(query[key]))
      fail(400, "COMMAND_TIME_REQUIRED");
    return integer(Number(query[key]), 0, Number.MAX_SAFE_INTEGER);
  };
  const from = timestamp("from"),
    to = timestamp("to");
  if (from >= to || to - from > COMMAND_WINDOW_MS)
    fail(400, "COMMAND_TIME_WINDOW_MAX_7_DAYS");
  const q = query.q === undefined ? "" : str(query.q, 1, 256).trim();
  const actor =
    query.actor === undefined ? "" : str(query.actor, 1, 128).trim();
  const limit =
    query.limit === undefined ? 50 : integer(Number(query.limit), 1, 100);
  const filter = hash(
    JSON.stringify({
      deviceId,
      from,
      to,
      q,
      actor,
      user: user.id,
      all: canReadOtherRecordings(user),
    }),
  );
  const conditions = ["c.device_id=?", "c.started_at>=?", "c.started_at<=?"];
  const values: SQLInputValue[] = [deviceId, from, to];
  if (!canReadOtherRecordings(user)) {
    conditions.push("c.actor_id=?");
    values.push(user.id);
  }
  const like = (value: string) => `%${value.replace(/[\\%_]/g, "\\$&")}%`;
  if (q) {
    conditions.push("c.command LIKE ? ESCAPE '\\'");
    values.push(like(q));
  }
  if (actor) {
    conditions.push("(c.actor_id=? OR u.username LIKE ? ESCAPE '\\')");
    values.push(actor, like(actor));
  }
  if (query.cursor !== undefined) {
    let cursor: any;
    try {
      cursor = JSON.parse(
        Buffer.from(str(query.cursor, 1, 1024), "base64url").toString(),
      );
    } catch {
      fail(400, "INVALID_COMMAND_CURSOR");
    }
    if (
      !cursor ||
      cursor.filter !== filter ||
      !Number.isSafeInteger(cursor.at) ||
      !Number.isSafeInteger(cursor.id) ||
      cursor.id < 1 ||
      cursor.at < from ||
      cursor.at > to
    )
      fail(400, "INVALID_COMMAND_CURSOR");
    conditions.push("(c.started_at<? OR (c.started_at=? AND c.id<?))");
    values.push(cursor.at, cursor.at, cursor.id);
  }
  const rows = db
    .prepare(
      `SELECT c.*,u.username AS actor_username,s.transport,s.backend,s.status AS session_status FROM terminal_commands c JOIN terminal_sessions s ON s.id=c.session_id JOIN users u ON u.id=c.actor_id WHERE ${conditions.join(" AND ")} ORDER BY c.started_at DESC,c.id DESC LIMIT ?`,
    )
    .all(...values, limit + 1) as any[];
  const hasMore = rows.length > limit;
  const commands = rows.slice(0, limit);
  const last = commands.at(-1);
  return {
    v: 1,
    commands,
    page: {
      has_more: hasMore,
      next_cursor: hasMore
        ? Buffer.from(
            JSON.stringify({ filter, at: last.started_at, id: last.id }),
          ).toString("base64url")
        : null,
    },
  };
}
