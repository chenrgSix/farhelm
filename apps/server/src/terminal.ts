import type { FastifyInstance, FastifyRequest } from "fastify";
import { randomUUID } from "node:crypto";
import { WebSocket } from "ws";
import {
  hasPermission,
  canReadOtherRecordings,
  type Permission,
} from "./permissions.js";
import type { Store } from "./store.js";
import { historyPage } from "./history.js";
import { CommandStream, commandHistory } from "./terminal-commands.js";
import type { User } from "./types.js";
import type { TargetTerminal } from "./ssh-target.js";
import type { registerTargetAccounts } from "./target-accounts.js";
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
  commands: CommandStream;
  commandCapture?: boolean;
  commandId?: number;
  commandCount?: number;
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
  sudoAuto?: boolean;
  sudoCredentialHash?: string;
  target?: TargetTerminal;
}
interface Dependencies {
  accounts?: ReturnType<typeof registerTargetAccounts>;
  store: Store;
  operator(req: FastifyRequest): User;
  userAuth(req: FastifyRequest): User;
  credentialUser(tokenHash: string): User | undefined;
  requireScope(user: User, id: string): void;
  inScope(user: User, id: string): boolean;
  availableStorage(): void;
  requireAvailable?(id: string): void;
  requireConnect?(): void;
  route?(id: string, backend: "agent" | "ssh"): unknown;
  connections: {
    sudoPassword?(id: string): string | undefined;
    kind(id: string): "agent" | "ssh";
    hasSsh(id: string): boolean;
    canSsh?(id: string): boolean;
    open(
      id: string,
      cols: number,
      rows: number,
      receive: (type: string, body: Record<string, any>) => void,
      commandToken?: string,
    ): TargetTerminal;
  };
  agent(id: string):
    | {
        send(type: string, body: unknown): boolean;
        terminal: boolean;
        sudo?: boolean;
        sudoNopasswd?: boolean;
        sudoCommands?: boolean;
        sudoEnabled?: boolean;
      }
    | undefined;
  rate: RateLimiter;
  consoleOrigin?: string;
  consoleProtocol?: "http" | "https";
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
export function terminalBackend(
  kind: "agent" | "ssh",
  agentTerminal: boolean,
  sshAvailable: boolean,
): "agent" | "ssh" | null {
  if (kind === "agent" && agentTerminal) return "agent";
  return sshAvailable ? "ssh" : null;
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
      db.prepare(
        "UPDATE terminal_commands SET ended_at=? WHERE session_id=? AND ended_at IS NULL",
      ).run(Date.now(), row.id);
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
    s: Pick<Session, "deviceId" | "userSession" | "actorId"> & {
      sudoAuto?: boolean;
      sudoCredentialHash?: string;
    },
  ) {
    const user = d.credentialUser(s.userSession);
    if (
      !user ||
      user.id !== s.actorId ||
      !db
        .prepare("SELECT id FROM devices WHERE id=? AND revoked_at IS NULL")
        .get(s.deviceId)
    )
      return false;
    try {
      d.accounts?.requireDefault(user, s.deviceId);
    } catch {
      return false;
    }
    if (s.sudoAuto) {
      try {
        const password = d.connections.sudoPassword?.(s.deviceId);
        if (
          !password ||
          hash(password) !== s.sudoCredentialHash ||
          d.agent(s.deviceId)?.sudoCommands !== true ||
          d.agent(s.deviceId)?.sudoEnabled !== true
        )
          return false;
      } catch {
        return false;
      }
    }
    return (
      !user.must_change_password &&
      hasPermission(user, "terminal.connect") &&
      (!s.sudoAuto || hasPermission(user, "terminal.sudo")) &&
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
        db.prepare(
          "UPDATE terminal_commands SET ended_at=? WHERE session_id=? AND ended_at IS NULL",
        ).run(Date.now(), s.id);
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
  function lookup(req: FastifyRequest, permission?: Permission) {
    const user = d.userAuth(req);
    if (permission && !hasPermission(user, permission))
      fail(403, "PERMISSION_DENIED");
    const id = str((req.params as any).id, 1, 128);
    const row = db
      .prepare("SELECT * FROM terminal_sessions WHERE id=?")
      .get(id) as any;
    if (!row) fail(404, "TERMINAL_NOT_FOUND");
    d.requireScope(user, row.device_id);
    if (
      permission === "recordings.read" &&
      row.actor_id !== user.id &&
      !canReadOtherRecordings(user)
    )
      fail(403, "PERMISSION_DENIED");
    return { row, user };
  }
  function backend(deviceId: string): "agent" | "ssh" | null {
    const kind = d.connections.kind(deviceId);
    return terminalBackend(
      kind,
      kind === "agent" && !!d.agent(deviceId)?.terminal,
      d.connections.canSsh?.(deviceId) ??
        (kind === "ssh" || d.connections.hasSsh(deviceId)),
    );
  }
  function create(
    user: User,
    userSession: string,
    deviceId: string,
    cols: number,
    rows: number,
    transport: "web" | "ssh",
  ) {
    d.requireConnect?.();
    integer(cols, 20, 500);
    integer(rows, 5, 200);
    if (!hasPermission(user, "terminal.connect"))
      fail(403, "EXEC_ROLE_REQUIRED");
    d.requireScope(user, deviceId);
    rate.check("terminal-create:" + user.id, 20);
    d.accounts?.requireDefault(user, deviceId);
    if (!authorized({ deviceId, actorId: user.id, userSession }))
      fail(403, "TERMINAL_NOT_AUTHORIZED");
    const selectedBackend = backend(deviceId);
    if (selectedBackend === "agent") d.requireAvailable?.(deviceId);
    if (!selectedBackend) {
      const agent = d.agent(deviceId);
      if (!agent) fail(409, "DEVICE_OFFLINE");
      fail(409, "TERMINAL_NOT_SUPPORTED_UPDATE_AGENT");
    }
    const sudoAutoPassword =
      selectedBackend === "agent" &&
      hasPermission(user, "terminal.sudo") &&
      d.agent(deviceId)?.sudoCommands &&
      d.agent(deviceId)?.sudoEnabled === true
        ? d.connections.sudoPassword?.(deviceId)
        : undefined;
    const sudoAuto = !!sudoAutoPassword;
    if (sudoAutoPassword && /[\r\n\0]/.test(sudoAutoPassword))
      fail(409, "INVALID_SUDO_PASSWORD");
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
      ).run(id, deviceId, user.id, cols, rows, now, transport, selectedBackend);
      record(id, "open", {
        cols,
        rows,
        ...(sudoAuto ? { sudo_auto: true } : {}),
      });
      store.audit("terminal.created", user.id, deviceId, null, {
        session_id: id,
        ...(sudoAuto ? { sudo_auto: true } : {}),
      });
    });
    const session: Session = {
      commands: new CommandStream(id),
      id,
      deviceId,
      actorId: user.id,
      userSession,
      ticketHash: hash(ticket),
      expires: now + 30000,
      created: now,
      ready: false,
      backend: selectedBackend,
      sudoAuto,
      sudoCredentialHash: sudoAutoPassword ? hash(sudoAutoPassword) : undefined,
    };
    sessions.set(id, session);
    return { session, ticket };
  }
  app.post("/api/v1/terminal-sessions", async (req) => {
    const user = d.operator(req),
      b = object(req.body);
    version(b);
    keys(b, [
      "v",
      "device_id",
      "cols",
      "rows",
      "account_id",
      "connection_mode",
    ]);
    // Old clients may still send normal. Never silently turn a removed root
    // request into a different identity or select a managed account implicitly.
    if (b.connection_mode === "root") fail(400, "ROOT_CONNECTION_MODE_REMOVED");
    if (b.connection_mode !== undefined && b.connection_mode !== "normal")
      fail(400, "INVALID_CONNECTION_MODE");
    if (Object.hasOwn(b, "account_id")) fail(400, "ACCOUNT_CONNECTION_REMOVED");
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
  app.get("/api/v1/devices/:id/terminal-commands", async (req) => {
    const user = d.userAuth(req);
    if (!hasPermission(user, "recordings.read")) fail(403, "PERMISSION_DENIED");
    const id = str((req.params as any).id, 1, 128);
    d.requireScope(user, id);
    if (!db.prepare("SELECT id FROM devices WHERE id=?").get(id))
      fail(404, "DEVICE_NOT_FOUND");
    return commandHistory(db, user, id, req.query);
  });
  app.get("/api/v1/terminal-sessions/:id", async (req) => {
    const { row } = lookup(req, "recordings.read");
    return { v: 1, session: row };
  });
  app.get("/api/v1/terminal-sessions", async (req) => {
    const user = d.userAuth(req);
    if (!hasPermission(user, "recordings.read")) fail(403, "PERMISSION_DENIED");
    const { rows, page } = historyPage(db, user, "sessions", req.query);
    return {
      v: 1,
      sessions: rows.map(({ actor_name, device_label, ...row }) => ({
        ...row,
        actor_username: actor_name,
        device_name: device_label,
      })),
      page,
    };
  });
  app.post("/api/v1/terminal-sessions/:id/close", async (req) => {
    const { row, user } = lookup(req, "terminal.connect"),
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
    const { row, user } = lookup(req, "recordings.read"),
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
    const { row, user } = lookup(req, "recordings.read"),
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
    if (!authorized(s)) return safeEnd(s, "AUTHORIZATION_EXPIRED");
    if (s.backend === "ssh") {
      try {
        s.target = d.connections.open(
          s.deviceId,
          cols,
          rows,
          (type, body) =>
            receive(s.deviceId, type, { ...body, session_id: s.id }, "ssh"),
          s.id,
        );
      } catch {
        safeEnd(s, "SSH_CONNECT_FAILED");
      }
      return;
    }
    if (
      !d.agent(s.deviceId)?.send("terminal.open", {
        session_id: s.id,
        cols,
        rows,
        ...(s.sudoAuto
          ? { sudo_auto_password: d.connections.sudoPassword?.(s.deviceId) }
          : {}),
      })
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
          ![
            `${d.consoleProtocol ?? req.protocol}://${req.headers.host}`,
            d.consoleOrigin,
          ].includes(origin)
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
            network_route: d.route?.(s.deviceId, s.backend) ?? null,
            session_id: s.id,
            ...(s.sudoAuto ? { sudo_auto: true } : {}),
          });
        });
        s.ready = true;
        if (
          !sendClient(s, "terminal.ready", {
            backend: s.backend,
            ...(s.sudoAuto ? { sudo_auto: true } : {}),
          })
        )
          end(s, s.peer ? "SSH_UNAVAILABLE" : "BROWSER_UNAVAILABLE");
      } else if (type === "terminal.output") {
        keys(b, ["session_id", "seq", "data"]);
        if (!s.ready) fail(409, "TERMINAL_NOT_OPEN");
        const seq = integer(b.seq, 1, Number.MAX_SAFE_INTEGER),
          chunk = bytes(b.data);
        const events = s.commands.push(chunk);
        const visible: Buffer[] = [];
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
          for (const event of events) {
            if (event.kind === "output") {
              for (
                let offset = 0;
                offset < event.data.length;
                offset += MAX_CHUNK
              ) {
                const part = event.data.subarray(offset, offset + MAX_CHUNK);
                record(s.id, "output", { data: part.toString("base64") });
                visible.push(part);
              }
            } else if (event.kind === "ready") {
              s.commandCapture = true;
              db.prepare(
                "INSERT OR IGNORE INTO terminal_command_capture(session_id,shell) VALUES(?,?)",
              ).run(s.id, event.shell);
            } else if (event.kind === "command" && s.commandCapture) {
              if ((s.commandCount ?? 0) >= 5000)
                fail(413, "TERMINAL_COMMAND_LIMIT");
              if (s.commandId)
                db.prepare(
                  "UPDATE terminal_commands SET ended_at=? WHERE id=? AND ended_at IS NULL",
                ).run(Date.now(), s.commandId);
              const anchor = (
                db
                  .prepare("SELECT last_seq FROM terminal_sessions WHERE id=?")
                  .get(s.id) as any
              ).last_seq;
              const inserted = db
                .prepare(
                  "INSERT INTO terminal_commands(session_id,device_id,actor_id,started_at,command,redacted,recording_seq) VALUES(?,?,?,?,?,?,?)",
                )
                .run(
                  s.id,
                  s.deviceId,
                  s.actorId,
                  Date.now(),
                  event.command,
                  Number(event.redacted),
                  anchor,
                );
              s.commandId = Number(inserted.lastInsertRowid);
              s.commandCount = (s.commandCount ?? 0) + 1;
            } else if (event.kind === "end" && s.commandId) {
              db.prepare(
                "UPDATE terminal_commands SET ended_at=?,exit_code=? WHERE id=? AND ended_at IS NULL",
              ).run(Date.now(), event.code, s.commandId);
              s.commandId = undefined;
            }
          }
          db.prepare(
            "UPDATE terminal_sessions SET output_seq=?,output_bytes=output_bytes+? WHERE id=?",
          ).run(seq, chunk.length, s.id);
        });
        // SQLite FULL commit precedes both display and Agent ACK.
        for (const part of visible)
          if (
            !sendClient(s, "terminal.output", { data: part.toString("base64") })
          )
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
    backend,
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
    revokeUserSession(sessionHash: string) {
      for (const s of [...sessions.values()])
        if (s.userSession === sessionHash) safeEnd(s, "USER_LOGOUT");
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
