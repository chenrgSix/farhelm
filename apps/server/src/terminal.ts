import type { FastifyInstance, FastifyRequest } from "fastify";
import { randomUUID } from "node:crypto";
import { WebSocket } from "ws";
import type { Store } from "./store.js";
import type { User } from "./types.js";
import type { TargetTerminal } from "./ssh-target.js";
import {
  fail,
  hash,
  token,
  object,
  keys,
  str,
  integer,
  version,
  type RateLimiter,
} from "./util.js";

export interface TerminalPeer {
  send(type: string, body: Record<string, any>): boolean;
  close(): void;
  terminate(): void;
}
interface Session {
  id: string;
  deviceId: string;
  actorId: string;
  userSession: string;
  ticketHash: string | null;
  expires: number;
  created: number;
  socket?: WebSocket;
  peer?: TerminalPeer;
  ready: boolean;
  backend: "agent" | "ssh";
  target?: TargetTerminal;
}
interface Dependencies {
  store: Store;
  operator(req: FastifyRequest): User;
  userAuth(req: FastifyRequest): User;
  requireScope(user: User, id: string): void;
  inScope(user: User, id: string): boolean;
  availableStorage(): void;
  connections: {
    kind(id: string): "agent" | "ssh";
    open(
      id: string,
      cols: number,
      rows: number,
      receive: (type: string, body: Record<string, any>) => void,
    ): TargetTerminal;
  };
  agent(
    id: string,
  ):
    | { send(type: string, body: unknown): boolean; terminal: boolean }
    | undefined;
  rate: RateLimiter;
  consoleOrigin?: string;
}
const MAX_BYTES = 8 * 1024 * 1024;
const MAX_CHUNK = 8192;
function bytes(value: unknown) {
  const encoded = str(value, 1, Math.ceil(MAX_CHUNK / 3) * 4);
  const decoded = Buffer.from(encoded, "base64");
  if (
    !decoded.length ||
    decoded.length > MAX_CHUNK ||
    decoded.toString("base64") !== encoded
  )
    fail(400, "INVALID_TERMINAL_DATA");
  return decoded;
}
export function registerTerminals(app: FastifyInstance, d: Dependencies) {
  const { store, rate } = d,
    db = store.db;
  const sessions = new Map<string, Session>();
  // A server restart cannot resume an unaudited shell. Never reopen it automatically.
  store.transaction(() => {
    for (const row of db
      .prepare("SELECT * FROM terminal_sessions WHERE ended_at IS NULL")
      .all() as any[]) {
      db.prepare(
        "UPDATE terminal_sessions SET status='INTERRUPTED',ended_at=?,reason='SERVER_RESTART',audit_complete=0 WHERE id=?",
      ).run(Date.now(), row.id);
      store.audit("terminal.closed", row.actor_id, row.device_id, null, {
        session_id: row.id,
        reason: "SERVER_RESTART",
        audit_complete: false,
      });
    }
  });
  function record(id: string, kind: string, data: unknown) {
    const row = db
      .prepare("SELECT last_seq FROM terminal_sessions WHERE id=?")
      .get(id) as any;
    if (row.last_seq >= 100000 && kind !== "close")
      fail(413, "TERMINAL_EVENT_LIMIT");
    const seq = row.last_seq + 1;
    db.prepare(
      "INSERT INTO terminal_recordings(session_id,seq,at,kind,data) VALUES(?,?,?,?,?)",
    ).run(id, seq, Date.now(), kind, JSON.stringify(data));
    db.prepare("UPDATE terminal_sessions SET last_seq=? WHERE id=?").run(
      seq,
      id,
    );
  }
  function authorized(
    s: Pick<Session, "deviceId" | "userSession" | "actorId">,
  ) {
    const row = db
      .prepare(
        "SELECT u.* FROM user_sessions t JOIN users u ON u.id=t.user_id JOIN devices d ON d.id=? WHERE t.token_hash=? AND u.id=? AND t.expires_at>? AND d.revoked_at IS NULL",
      )
      .get(s.deviceId, s.userSession, s.actorId, Date.now());
    if (!row) return false;
    const user = store.user(row);
    return (
      (user.role === "admin" || user.role === "ops") &&
      d.inScope(user, s.deviceId)
    );
  }
  function sendClient(s: Session, type: string, body: Record<string, any>) {
    if (s.peer) return s.peer.send(type, body);
    if (!s.socket || s.socket.readyState !== WebSocket.OPEN) return false;
    if (s.socket.bufferedAmount > 262144) return false;
    s.socket.send(JSON.stringify({ v: 1, type, body }));
    return true;
  }
  function end(s: Session, reason: string, complete = false) {
    if (!sessions.delete(s.id)) return;
    // Stop further input first, even if final audit storage itself has failed.
    if (s.backend === "ssh") s.target?.close();
    else d.agent(s.deviceId)?.send("terminal.close", { session_id: s.id });
    let persisted = false;
    try {
      store.transaction(() => {
        record(s.id, "close", { reason, audit_complete: complete });
        db.prepare(
          "UPDATE terminal_sessions SET status=?,ended_at=?,reason=?,audit_complete=? WHERE id=?",
        ).run(
          complete || reason === "USER_DISCONNECTED" ? "CLOSED" : "INTERRUPTED",
          Date.now(),
          reason,
          Number(complete),
          s.id,
        );
        store.audit("terminal.closed", s.actorId, s.deviceId, null, {
          session_id: s.id,
          reason,
          audit_complete: complete,
        });
      });
      persisted = true;
    } finally {
      sendClient(s, "terminal.closed", {
        reason: persisted ? reason : "AUDIT_STORAGE_FAILURE",
        audit_complete: persisted && complete,
      });
      s.socket?.close(1000, "Terminal ended");
      s.peer?.close();
    }
  }
  function safeEnd(s: Session, reason: string) {
    try {
      end(s, reason);
    } catch {
      s.socket?.terminate();
      s.peer?.terminate();
    }
  }
  function lookup(req: FastifyRequest) {
    const user = d.userAuth(req);
    const id = str((req.params as any).id, 1, 128);
    const row = db
      .prepare("SELECT * FROM terminal_sessions WHERE id=?")
      .get(id) as any;
    if (!row) fail(404, "TERMINAL_NOT_FOUND");
    d.requireScope(user, row.device_id);
    return { row, user };
  }
  function create(
    user: User,
    userSession: string,
    deviceId: string,
    cols: number,
    rows: number,
    transport: "web" | "ssh",
  ) {
    integer(cols, 20, 500);
    integer(rows, 5, 200);
    if (user.role !== "admin" && user.role !== "ops")
      fail(403, "EXEC_ROLE_REQUIRED");
    d.requireScope(user, deviceId);
    rate.check("terminal-create:" + user.id, 20);
    if (!authorized({ deviceId, actorId: user.id, userSession }))
      fail(403, "TERMINAL_NOT_AUTHORIZED");
    const backend = d.connections.kind(deviceId);
    if (backend === "agent") {
      const agent = d.agent(deviceId);
      if (!agent) fail(409, "DEVICE_OFFLINE");
      if (!agent.terminal) fail(409, "TERMINAL_NOT_SUPPORTED_UPDATE_AGENT");
    }
    if (
      sessions.size >= 32 ||
      [...sessions.values()].filter((s) => s.deviceId === deviceId).length >=
        4 ||
      [...sessions.values()].filter((s) => s.actorId === user.id).length >= 4
    )
      fail(429, "TERMINAL_SESSION_LIMIT");
    d.availableStorage();
    const id = randomUUID(),
      ticket = token(),
      now = Date.now();
    store.transaction(() => {
      db.prepare(
        "INSERT INTO terminal_sessions(id,device_id,actor_id,status,cols,rows,created_at,transport,backend) VALUES(?,?,?,'OPENING',?,?,?,?,?)",
      ).run(id, deviceId, user.id, cols, rows, now, transport, backend);
      record(id, "open", { cols, rows });
      store.audit("terminal.created", user.id, deviceId, null, {
        session_id: id,
      });
    });
    const session: Session = {
      id,
      deviceId,
      actorId: user.id,
      userSession,
      ticketHash: hash(ticket),
      expires: now + 30000,
      created: now,
      ready: false,
      backend,
    };
    sessions.set(id, session);
    return { session, ticket };
  }
  app.post("/api/v1/terminal-sessions", async (req) => {
    const user = d.operator(req),
      b = object(req.body);
    version(b);
    keys(b, ["v", "device_id", "cols", "rows"]);
    const deviceId = str(b.device_id, 1, 128),
      cols = integer(b.cols, 20, 500),
      rows = integer(b.rows, 5, 200);
    const { session, ticket } = create(
      user,
      hash(req.headers.authorization!.slice(7)),
      deviceId,
      cols,
      rows,
      "web",
    );
    return {
      v: 1,
      session_id: session.id,
      ticket,
      expires_at: session.expires,
    };
  });
  app.get("/api/v1/terminal-sessions", async (req) => {
    const user = d.userAuth(req);
    return {
      v: 1,
      sessions: (
        db
          .prepare(
            "SELECT * FROM terminal_sessions ORDER BY created_at DESC LIMIT 500",
          )
          .all() as any[]
      ).filter((s) => d.inScope(user, s.device_id)),
    };
  });
  app.post("/api/v1/terminal-sessions/:id/close", async (req) => {
    const { row, user } = lookup(req),
      b = object(req.body);
    version(b);
    keys(b, ["v"]);
    if (user.role !== "admin" && user.id !== row.actor_id)
      fail(403, "TERMINAL_OWNER_REQUIRED");
    const s = sessions.get(row.id);
    if (s) end(s, "USER_DISCONNECTED");
    return { v: 1, ok: true };
  });
  app.get("/api/v1/terminal-sessions/:id/recording", async (req) => {
    const { row, user } = lookup(req),
      q = object(req.query);
    keys(q, ["after"]);
    const after =
      q.after === undefined
        ? 0
        : integer(Number(q.after), 0, Number.MAX_SAFE_INTEGER);
    store.audit("terminal.recording_viewed", user.id, row.device_id, null, {
      session_id: row.id,
      after,
    });
    const events = (
      db
        .prepare(
          "SELECT seq,at,kind,data FROM terminal_recordings WHERE session_id=? AND seq>? ORDER BY seq LIMIT 128",
        )
        .all(row.id, after) as any[]
    ).map((e) => ({ ...e, data: JSON.parse(e.data) }));
    return { v: 1, session: row, events, next: events.at(-1)?.seq ?? after };
  });
  app.post("/api/v1/terminal-sessions/:id/export", async (req) => {
    const { row, user } = lookup(req),
      b = object(req.body);
    version(b);
    keys(b, ["v"]);
    store.audit("terminal.recording_exported", user.id, row.device_id, null, {
      session_id: row.id,
      last_seq: row.last_seq,
    });
    return { v: 1, ok: true };
  });
  function input(s: Session, type: string, b: Record<string, any>) {
    if (!sessions.has(s.id) || !s.ready || !authorized(s))
      fail(403, "TERMINAL_NOT_AUTHORIZED");
    rate.check("terminal-input:" + s.id, 12000);
    if (type === "terminal.input") {
      keys(b, ["data"]);
      bytes(b.data);
      // Never record raw keystrokes: PTY echo determines what appears in output.
      if (!sendTarget(s, "terminal.input", { data: b.data }))
        safeEnd(s, "DEVICE_OFFLINE");
    } else if (type === "terminal.resize") {
      keys(b, ["cols", "rows"]);
      const size = {
        cols: integer(b.cols, 20, 500),
        rows: integer(b.rows, 5, 200),
      };
      d.availableStorage();
      store.transaction(() => record(s.id, "resize", size));
      if (!sendTarget(s, "terminal.resize", size)) safeEnd(s, "DEVICE_OFFLINE");
    } else if (type === "terminal.close") {
      keys(b, []);
      end(s, "USER_DISCONNECTED");
    } else fail(400, "UNKNOWN_TERMINAL_MESSAGE");
  }
  function sendTarget(s: Session, type: string, body: Record<string, any>) {
    return s.backend === "ssh"
      ? s.target?.send(type, body)
      : d.agent(s.deviceId)?.send(type, { session_id: s.id, ...body });
  }
  function openTarget(s: Session, cols: number, rows: number) {
    if (s.backend === "ssh") {
      try {
        s.target = d.connections.open(s.deviceId, cols, rows, (type, body) =>
          receive(s.deviceId, type, { ...body, session_id: s.id }, "ssh"),
        );
      } catch {
        safeEnd(s, "SSH_CONNECT_FAILED");
      }
      return;
    }
    if (
      !d
        .agent(s.deviceId)
        ?.send("terminal.open", { session_id: s.id, cols, rows })
    )
      safeEnd(s, "DEVICE_OFFLINE");
  }
  app.get(
    "/api/v1/terminal/ws",
    {
      websocket: true,
      preValidation: async (req) => {
        if (Object.keys(req.query as object).length)
          fail(400, "WS_QUERY_NOT_ALLOWED");
        const origin = req.headers.origin;
        if (
          !origin ||
          !["https://" + req.headers.host, d.consoleOrigin].includes(origin)
        )
          fail(403, "TERMINAL_ORIGIN_DENIED");
      },
    },
    (socket) => {
      let session: Session | undefined;
      const timeout = setTimeout(
        () => socket.close(4003, "Attach timeout"),
        5000,
      );
      timeout.unref();
      socket.on("error", () => {});
      socket.on("close", () => {
        clearTimeout(timeout);
        if (session) safeEnd(session, "BROWSER_DISCONNECTED");
      });
      socket.on("message", (data, binary) => {
        try {
          if (binary) fail(400, "JSON_TEXT_REQUIRED");
          const env = object(JSON.parse(data.toString()));
          keys(env, ["v", "type", "body"]);
          version(env);
          const b = object(env.body);
          if (!session) {
            if (env.type !== "terminal.attach") fail(401, "ATTACH_REQUIRED");
            keys(b, ["session_id", "ticket"]);
            const s = sessions.get(str(b.session_id, 1, 128));
            if (
              !s ||
              s.socket ||
              !s.ticketHash ||
              s.expires <= Date.now() ||
              hash(str(b.ticket, 43, 43)) !== s.ticketHash ||
              !authorized(s)
            )
              fail(401, "TERMINAL_TICKET_INVALID");
            session = s;
            s.ticketHash = null;
            s.socket = socket;
            clearTimeout(timeout);
            const row = db
              .prepare("SELECT cols,rows FROM terminal_sessions WHERE id=?")
              .get(s.id) as any;
            openTarget(s, row.cols, row.rows);
            return;
          }
          input(session, env.type, b);
        } catch {
          if (session) safeEnd(session, "TERMINAL_INPUT_OR_STORAGE_FAILURE");
          socket.close(4003, "Terminal request rejected");
        }
      });
    },
  );
  function receive(
    deviceId: string,
    type: string,
    b: Record<string, any>,
    backend: "agent" | "ssh",
  ) {
    const s = sessions.get(str(b.session_id, 1, 128));
    if (!s || s.deviceId !== deviceId || s.backend !== backend) return; // Late frames or wrong backend.
    try {
      if (!authorized(s)) return end(s, "AUTHORIZATION_EXPIRED");
      if (type === "terminal.opened") {
        keys(b, ["session_id"]);
        if (s.ready) fail(409, "TERMINAL_ALREADY_OPEN");
        store.transaction(() => {
          db.prepare(
            "UPDATE terminal_sessions SET status='OPEN' WHERE id=?",
          ).run(s.id);
          store.audit("terminal.opened", s.actorId, s.deviceId, null, {
            session_id: s.id,
          });
        });
        s.ready = true;
        if (!sendClient(s, "terminal.ready", {}))
          end(s, s.peer ? "SSH_UNAVAILABLE" : "BROWSER_UNAVAILABLE");
      } else if (type === "terminal.output") {
        keys(b, ["session_id", "seq", "data"]);
        if (!s.ready) fail(409, "TERMINAL_NOT_OPEN");
        const seq = integer(b.seq, 1, Number.MAX_SAFE_INTEGER),
          chunk = bytes(b.data);
        d.availableStorage();
        store.transaction(() => {
          const row = db
            .prepare(
              "SELECT output_seq,output_bytes FROM terminal_sessions WHERE id=?",
            )
            .get(s.id) as any;
          if (seq !== row.output_seq + 1) fail(409, "TERMINAL_OUTPUT_GAP");
          if (row.output_bytes + chunk.length > MAX_BYTES)
            fail(413, "TERMINAL_RECORDING_LIMIT");
          record(s.id, "output", { data: b.data });
          db.prepare(
            "UPDATE terminal_sessions SET output_seq=?,output_bytes=output_bytes+? WHERE id=?",
          ).run(seq, chunk.length, s.id);
        });
        // SQLite FULL commit precedes both display and Agent ACK.
        if (!sendClient(s, "terminal.output", { data: b.data }))
          return end(s, s.peer ? "SSH_BACKPRESSURE" : "BROWSER_BACKPRESSURE");
        if (
          s.backend === "agent" &&
          !d.agent(deviceId)?.send("terminal.ack", { session_id: s.id, seq })
        )
          end(s, "DEVICE_OFFLINE");
      } else if (type === "terminal.closed") {
        keys(b, ["session_id", "reason"]);
        const reason = str(b.reason, 1, 128);
        end(s, reason, reason === "SHELL_EXIT");
      } else fail(400, "UNKNOWN_TERMINAL_MESSAGE");
    } catch {
      safeEnd(s, "TERMINAL_RECORDING_FAILURE");
    }
  }
  return {
    openSsh(
      user: User,
      userSession: string,
      deviceId: string,
      cols: number,
      rows: number,
      peer: TerminalPeer,
    ) {
      const { session: s } = create(
        user,
        userSession,
        deviceId,
        cols,
        rows,
        "ssh",
      );
      s.ticketHash = null;
      s.peer = peer;
      openTarget(s, cols, rows);
      return {
        input(type: string, body: Record<string, any>) {
          try {
            input(s, type, body);
          } catch {
            safeEnd(s, "TERMINAL_INPUT_OR_STORAGE_FAILURE");
          }
        },
        disconnect() {
          safeEnd(s, "SSH_DISCONNECTED");
        },
      };
    },
    receive(deviceId: string, type: string, b: Record<string, any>) {
      receive(deviceId, type, b, "agent");
    },
    disconnect(deviceId: string) {
      for (const s of [...sessions.values()])
        if (s.deviceId === deviceId && s.backend === "agent")
          safeEnd(s, "AGENT_DISCONNECTED");
    },
    revoke(deviceId: string) {
      for (const s of [...sessions.values()])
        if (s.deviceId === deviceId) safeEnd(s, "AUTHORIZATION_EXPIRED");
    },
    tick() {
      for (const s of [...sessions.values()]) {
        if (!authorized(s)) safeEnd(s, "AUTHORIZATION_EXPIRED");
        else if (
          (!s.ready && Date.now() > s.expires) ||
          Date.now() - s.created > 3600000
        )
          safeEnd(s, "SESSION_EXPIRED");
      }
    },
    close() {
      for (const s of [...sessions.values()]) safeEnd(s, "SERVER_SHUTDOWN");
    },
  };
}
