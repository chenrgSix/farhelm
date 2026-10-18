import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { once } from "node:events";
import { WebSocket } from "ws";
import { buildServer } from "../src/server.js";
import { hash, token } from "../src/util.js";
import { Store } from "../src/store.js";

const root = mkdtempSync(join(tmpdir(), "fleet-terminal-test-"));
execFileSync("bash", ["../../deploy/dev/generate-tls.sh", join(root, "tls")], {
  stdio: "ignore",
});
const ca = readFileSync(join(root, "tls/ca.crt"));
function client(
  url: string,
  options: ConstructorParameters<typeof WebSocket>[1] = {},
) {
  const ws = new WebSocket(url, { ca, ...options });
  const messages: any[] = [];
  ws.on("message", (raw) => messages.push(JSON.parse(raw.toString())));
  ws.on("error", () => {});
  const send = (type: string, body: unknown) =>
    ws.send(JSON.stringify({ v: 1, type, body }));
  async function wait(type: string) {
    const end = Date.now() + 4000;
    while (Date.now() < end) {
      const index = messages.findIndex((m) => m.type === type);
      if (index >= 0) return messages.splice(index, 1)[0].body;
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    throw Error("Missing " + type + ": " + JSON.stringify(messages));
  }
  return { ws, messages, send, wait };
}
async function fixture() {
  const s = await buildServer({
    dataDir: mkdtempSync(join(root, "data-")),
    tlsCert: join(root, "tls/server.crt"),
    tlsKey: join(root, "tls/server.key"),
    adminUsername: "admin",
    adminPassword: "terminal-test-password1",
  });
  await s.app.listen({ host: "127.0.0.1", port: 0 });
  const origin = `https://localhost:${(s.app.server.address() as any).port}`;
  const wsUrl = origin.replace("https:", "wss:");
  async function api(method: string, url: string, body?: any, auth?: string) {
    const r = await s.app.inject({
      method: method as any,
      url,
      payload: body,
      headers: auth ? { authorization: "Bearer " + auth } : {},
    });
    return { status: r.statusCode, body: r.json() };
  }
  async function login(username: string) {
    const r = await api("POST", "/api/v1/login", {
      username,
      password: "terminal-test-password1",
    });
    assert.equal(r.status, 200);
    return r.body.access_token as string;
  }
  const admin = await login("admin");
  // Protocol test double only. Real Rust PTY is exercised separately in Linux/browser tests.
  s.store.db
    .prepare(
      "INSERT INTO devices(id,public_key,name,created_at) VALUES('device','test-key','test',?)",
    )
    .run(Date.now());
  const access = token();
  s.store.db
    .prepare(
      "INSERT INTO device_tokens(token_hash,device_id,expires_at,scope) VALUES(?,'device',?,'agent-control-output')",
    )
    .run(hash(access), Date.now() + 60000);
  const agent = client(wsUrl + "/agent/ws", {
    headers: { authorization: "Bearer " + access },
  });
  await once(agent.ws, "open");
  agent.send("agent.hello", {
    agent_version: "terminal-test-double",
    capabilities: ["terminal.pty.v1"],
  });
  // Message ordering on this socket is preserved before creation via the HTTP API.
  for (let n = 0; n < 50; n++) {
    const r = await api("GET", "/api/v1/devices", undefined, admin);
    if (r.body.devices[0].control_online) break;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  async function create(auth = admin) {
    return api(
      "POST",
      "/api/v1/terminal-sessions",
      { v: 1, device_id: "device", cols: 80, rows: 24 },
      auth,
    );
  }
  const browsers: ReturnType<typeof client>[] = [];
  async function attach(created: any) {
    const browser = client(wsUrl + "/api/v1/terminal/ws", {
      headers: { origin },
    });
    browsers.push(browser);
    await once(browser.ws, "open");
    browser.send("terminal.attach", {
      session_id: created.session_id,
      ticket: created.ticket,
    });
    return browser;
  }
  async function open() {
    const r = await create();
    assert.equal(r.status, 200);
    const browser = await attach(r.body);
    const request = await agent.wait("terminal.open");
    assert.equal(request.session_id, r.body.session_id);
    agent.send("terminal.opened", { session_id: request.session_id });
    await browser.wait("terminal.ready");
    return { browser, id: request.session_id, ticket: r.body };
  }
  async function close() {
    for (const b of browsers) b.ws.terminate();
    agent.ws.terminate();
    await s.close();
  }
  return {
    ...s,
    origin,
    wsUrl,
    admin,
    api,
    login,
    agent,
    create,
    attach,
    open,
    close,
  };
}
test("terminal gateway: role/scope checks, origin, single-use ticket and user-session expiry", async () => {
  const f = await fixture();
  try {
    f.store.seedUser({
      username: "business",
      password: "terminal-test-password1",
      role: "business",
      deviceScope: "*",
    });
    f.store.seedUser({
      username: "other-ops",
      password: "terminal-test-password1",
      role: "ops",
      deviceScope: [],
    });
    assert.equal((await f.create(await f.login("business"))).status, 403);
    const outOfScope = await f.login("other-ops");
    assert.equal((await f.create(outOfScope)).status, 403);
    const denied = client(f.wsUrl + "/api/v1/terminal/ws", {
      headers: { origin: "https://evil.example" },
    });
    await assert.rejects(once(denied.ws, "open"), /403/);
    const { browser, id, ticket } = await f.open();
    const replay = await f.attach(ticket);
    await once(replay.ws, "close");
    assert.equal(browser.ws.readyState, WebSocket.OPEN);
    assert.equal(
      (
        await f.api(
          "GET",
          `/api/v1/terminal-sessions/${id}/recording`,
          undefined,
          outOfScope,
        )
      ).status,
      403,
    );
    f.store.db
      .prepare("UPDATE user_sessions SET expires_at=0 WHERE token_hash=?")
      .run(hash(f.admin));
    browser.send("terminal.input", {
      data: Buffer.from("must-not-run\n").toString("base64"),
    });
    await f.agent.wait("terminal.close");
    assert.equal(
      f.agent.messages.some((m) => m.type === "terminal.input"),
      false,
    );
    assert.equal(
      (
        f.store.db
          .prepare("SELECT audit_complete FROM terminal_sessions WHERE id=?")
          .get(id) as any
      ).audit_complete,
      0,
    );
  } finally {
    await f.close();
  }
});
test("terminal gateway commits output before display/ACK, never records raw input, closes on a sequence gap", async () => {
  const f = await fixture();
  try {
    const { browser, id } = await f.open();
    browser.send("terminal.input", {
      data: Buffer.from("hidden-password").toString("base64"),
    });
    await f.agent.wait("terminal.input");
    const data = Buffer.from("visible output 中文\r\n").toString("base64");
    f.agent.send("terminal.output", { session_id: id, seq: 1, data });
    assert.equal((await browser.wait("terminal.output")).data, data);
    const recording = await f.api(
      "GET",
      `/api/v1/terminal-sessions/${id}/recording`,
      undefined,
      f.admin,
    );
    assert.equal(recording.status, 200);
    assert.deepEqual(
      recording.body.events.map((e: any) => e.kind),
      ["open", "output"],
    );
    assert.equal(recording.body.events[1].data.data, data);
    assert.equal(
      JSON.stringify(recording.body).includes(
        Buffer.from("hidden-password").toString("base64"),
      ),
      false,
    );
    assert.equal((await f.agent.wait("terminal.ack")).seq, 1);
    f.agent.send("terminal.output", { session_id: id, seq: 3, data });
    await browser.wait("terminal.closed");
    await f.agent.wait("terminal.close");
    const row = f.store.db
      .prepare("SELECT * FROM terminal_sessions WHERE id=?")
      .get(id) as any;
    assert.equal(row.status, "INTERRUPTED");
    assert.equal(row.audit_complete, 0);
    assert.equal(row.output_seq, 1);
    assert.equal(
      f.agent.messages.some(
        (m) => m.type === "terminal.ack" && m.body.seq === 3,
      ),
      false,
    );
  } finally {
    await f.close();
  }
});
test("terminal recording failure stops the PTY without displaying or acknowledging unrecorded bytes", async () => {
  const f = await fixture();
  try {
    const { browser, id } = await f.open();
    f.store.db.exec(
      "CREATE TRIGGER fail_terminal_output BEFORE INSERT ON terminal_recordings WHEN NEW.kind='output' BEGIN SELECT RAISE(ABORT,'injected storage failure'); END",
    );
    f.agent.send("terminal.output", {
      session_id: id,
      seq: 1,
      data: Buffer.from("not durable").toString("base64"),
    });
    await browser.wait("terminal.closed");
    await f.agent.wait("terminal.close");
    assert.equal(
      browser.messages.some((m) => m.type === "terminal.output"),
      false,
    );
    assert.equal(
      f.agent.messages.some((m) => m.type === "terminal.ack"),
      false,
    );
    assert.equal(
      (
        f.store.db
          .prepare("SELECT output_bytes FROM terminal_sessions WHERE id=?")
          .get(id) as any
      ).output_bytes,
      0,
    );
  } finally {
    await f.close();
  }
});
test("intentional terminal close ends the session without claiming a complete recording; transport loss stays interrupted", async () => {
  const f = await fixture();
  try {
    for (const path of ["websocket", "api"]) {
      const { browser, id } = await f.open();
      if (path === "websocket") browser.send("terminal.close", {});
      else
        assert.equal(
          (
            await f.api(
              "POST",
              `/api/v1/terminal-sessions/${id}/close`,
              { v: 1 },
              f.admin,
            )
          ).status,
          200,
        );
      const closed = await browser.wait("terminal.closed");
      assert.equal(closed.reason, "USER_DISCONNECTED");
      assert.equal(closed.audit_complete, false);
      await f.agent.wait("terminal.close");
      const row = f.store.db
        .prepare("SELECT * FROM terminal_sessions WHERE id=?")
        .get(id) as any;
      assert.equal(row.status, "CLOSED");
      assert.equal(row.audit_complete, 0);
      assert.ok(row.ended_at);
      const recording = await f.api(
        "GET",
        `/api/v1/terminal-sessions/${id}/recording`,
        undefined,
        f.admin,
      );
      assert.deepEqual(recording.body.events.at(-1).data, {
        reason: "USER_DISCONNECTED",
        audit_complete: false,
      });
      // A late Agent reply and the unmount's HTTP close must not overwrite the result.
      f.agent.send("terminal.closed", {
        session_id: id,
        reason: "CONTROL_CLOSED",
      });
      await f.api(
        "POST",
        `/api/v1/terminal-sessions/${id}/close`,
        { v: 1 },
        f.admin,
      );
      assert.deepEqual(
        f.store.db
          .prepare("SELECT * FROM terminal_sessions WHERE id=?")
          .get(id),
        row,
      );
    }
    const lost = await f.open();
    lost.browser.ws.terminate();
    await f.agent.wait("terminal.close");
    const interrupted = f.store.db
      .prepare("SELECT * FROM terminal_sessions WHERE id=?")
      .get(lost.id) as any;
    assert.equal(interrupted.status, "INTERRUPTED");
    assert.equal(interrupted.reason, "BROWSER_DISCONNECTED");
    assert.equal(interrupted.audit_complete, 0);
    const normal = await f.open();
    f.agent.send("terminal.closed", {
      session_id: normal.id,
      reason: "SHELL_EXIT",
    });
    assert.equal(
      (await normal.browser.wait("terminal.closed")).audit_complete,
      true,
    );
    const ended = f.store.db
      .prepare("SELECT * FROM terminal_sessions WHERE id=?")
      .get(normal.id) as any;
    assert.equal(ended.status, "CLOSED");
    assert.equal(ended.audit_complete, 1);
  } finally {
    await f.close();
  }
});
test("startup reclassifies historical intentional closes without changing recording or audit evidence", () => {
  const dir = mkdtempSync(join(root, "historical-"));
  let store = new Store(dir);
  try {
    const actor = store.seedUser({
      username: "admin",
      password: "terminal-test-password1",
      role: "admin",
      deviceScope: "*",
    });
    store.db
      .prepare(
        "INSERT INTO devices(id,public_key,name,created_at) VALUES('device','key','test',1)",
      )
      .run();
    for (const reason of ["USER_DISCONNECTED", "BROWSER_DISCONNECTED"]) {
      store.db
        .prepare(
          "INSERT INTO terminal_sessions(id,device_id,actor_id,status,cols,rows,created_at,ended_at,reason,audit_complete) VALUES(?,'device',?,'INTERRUPTED',80,24,1,2,?,0)",
        )
        .run(reason, actor.id, reason);
      store.db
        .prepare(
          "INSERT INTO terminal_recordings(session_id,seq,at,kind,data) VALUES(?,1,2,'close',?)",
        )
        .run(reason, JSON.stringify({ reason, audit_complete: false }));
      store.audit("terminal.closed", actor.id, "device", null, {
        session_id: reason,
        reason,
        audit_complete: false,
      });
    }
    const before = store.db
      .prepare("SELECT * FROM terminal_sessions ORDER BY id")
      .all() as any[];
    const recordings = store.db
      .prepare("SELECT * FROM terminal_recordings ORDER BY session_id,seq")
      .all();
    const audit = store.db.prepare("SELECT * FROM audit ORDER BY id").all();
    for (let i = 0; i < 2; i++) {
      store.close();
      store = new Store(dir);
      assert.deepEqual(
        store.db
          .prepare("SELECT * FROM terminal_sessions ORDER BY id")
          .all()
          .map((row) => ({ ...row })),
        before.map((row) => ({
          ...row,
          status: row.reason === "USER_DISCONNECTED" ? "CLOSED" : "INTERRUPTED",
        })),
      );
      assert.deepEqual(
        store.db
          .prepare("SELECT * FROM terminal_recordings ORDER BY session_id,seq")
          .all(),
        recordings,
      );
      assert.deepEqual(
        store.db.prepare("SELECT * FROM audit ORDER BY id").all(),
        audit,
      );
    }
  } finally {
    store.close();
  }
});

test("management and personal password changes immediately revoke affected active terminals", async () => {
  for (const change of ["disable", "scope", "password"] as const) {
    const f = await fixture();
    try {
      const role = await f.api(
        "POST",
        "/api/v1/roles",
        {
          v: 1,
          name: "终端运维",
          description: "",
          permissions: ["devices.read", "terminal.connect"],
        },
        f.admin,
      );
      assert.equal(role.status, 200);
      const created = await f.api(
        "POST",
        "/api/v1/users",
        {
          v: 1,
          username: "group-operator",
          password: "terminal-test-password1",
          enabled: true,
          role_ids: [role.body.role.id],
          group_ids: [],
          device_scope: ["device"],
        },
        f.admin,
      );
      assert.equal(created.status, 200);
      const user = created.body.user;
      const auth = await f.login(user.username);
      const session = await f.create(auth);
      assert.equal(session.status, 200);
      const browser = await f.attach(session.body);
      const request = await f.agent.wait("terminal.open");
      f.agent.send("terminal.opened", { session_id: request.session_id });
      await browser.wait("terminal.ready");
      const r =
        change === "password"
          ? await f.api(
              "POST",
              "/api/v1/me/password",
              {
                v: 1,
                current_password: "terminal-test-password1",
                new_password: "changed-terminal-password1",
              },
              auth,
            )
          : change === "disable"
            ? await f.api(
                "PUT",
                "/api/v1/users/" + user.id,
                {
                  v: 1,
                  revision: user.revision,
                  username: user.username,
                  enabled: false,
                  role_ids: user.role_ids,
                  group_ids: [],
                  device_scope: [],
                },
                f.admin,
              )
            : await f.api(
                "PUT",
                "/api/v1/users/" + user.id,
                {
                  v: 1,
                  revision: user.revision,
                  username: user.username,
                  enabled: true,
                  role_ids: user.role_ids,
                  group_ids: [],
                  device_scope: [],
                },
                f.admin,
              );
      assert.equal(r.status, 200);
      assert.equal(
        (await f.agent.wait("terminal.close")).session_id,
        request.session_id,
      );
      await browser.wait("terminal.closed");
      const stored = f.store.db
        .prepare("SELECT status,reason FROM terminal_sessions WHERE id=?")
        .get(request.session_id) as any;
      assert.equal(stored.status, "INTERRUPTED");
      assert.equal(stored.reason, "AUTHORIZATION_EXPIRED");
      assert.equal((await f.create(auth)).status, 401);
    } finally {
      await f.close();
    }
  }
});

test("session lists, recordings and exports isolate owners unless cross-user auditing is explicitly granted", async () => {
  const f = await fixture();
  try {
    const db = f.store.db;
    const users = Object.fromEntries(
      (["alice", "bob", "business", "auditor", "outside"] as const).map(
        (username) => [
          username,
          f.store.seedUser({
            username,
            password: "terminal-test-password1",
            role:
              username === "business"
                ? "business"
                : ["auditor", "outside"].includes(username)
                  ? "auditor"
                  : "ops",
            deviceScope: username === "outside" ? [] : ["device"],
          }),
        ],
      ),
    );
    const auth: Record<string, string> = {};
    for (const name of Object.keys(users)) auth[name] = await f.login(name);
    const insert = db.prepare(
      "INSERT INTO terminal_sessions(id,device_id,actor_id,status,cols,rows,created_at,ended_at,transport,last_seq) VALUES(?,'device',?,'CLOSED',80,24,?,?,?,1)",
    );
    for (const [id, owner, at, transport] of [
      ["alice-web", "alice", 1, "web"],
      ["alice-ssh", "alice", 2, "ssh"],
      ["bob-web", "bob", 3, "web"],
      ["bob-ssh", "bob", 4, "ssh"],
      ["business-own", "business", 5, "web"],
    ] as const) {
      insert.run(id, users[owner].id, at, at + 1, transport);
      db.prepare(
        "INSERT INTO terminal_recordings(session_id,seq,at,kind,data) VALUES(?,1,?,'output',?)",
      ).run(
        id,
        at,
        JSON.stringify({
          data: Buffer.from(id + " private output").toString("base64"),
        }),
      );
    }
    const list = (token: string, query = "") =>
      f.api("GET", "/api/v1/terminal-sessions" + query, undefined, token);
    for (const name of ["alice", "bob", "business"]) {
      const result = await list(auth[name]);
      assert.equal(result.status, 200);
      assert.ok(result.body.sessions.length > 0);
      assert.ok(
        result.body.sessions.every((s: any) => s.actor_id === users[name].id),
      );
    }
    assert.equal((await list(f.admin)).body.sessions.length, 5);
    assert.equal((await list(auth.auditor)).body.sessions.length, 5);
    assert.equal((await list(auth.outside)).body.sessions.length, 0);
    // Owner filtering precedes limit/cursor/search/actor filters, for both transports.
    const first = await list(auth.alice, "?limit=1");
    assert.equal(first.body.sessions[0].id, "alice-ssh");
    const next = await list(
      auth.alice,
      "?limit=1&cursor=" + first.body.page.next_cursor,
    );
    assert.equal(next.body.sessions[0].id, "alice-web");
    assert.equal(next.body.page.has_more, false);
    for (const query of [
      "?actor_id=bob",
      "?q=bob",
      "?actor_id=" + users.bob.id,
    ])
      assert.deepEqual((await list(auth.alice, query)).body.sessions, []);
    for (const [method, suffix, body] of [
      ["GET", "recording", undefined],
      ["POST", "export", { v: 1 }],
    ] as const) {
      const path = "/api/v1/terminal-sessions/bob-web/" + suffix;
      for (const name of ["alice", "business", "outside"])
        assert.equal((await f.api(method, path, body, auth[name])).status, 403);
      for (const token of [auth.bob, auth.auditor, f.admin])
        assert.equal((await f.api(method, path, body, token)).status, 200);
    }
    const active = await f.create(auth.bob);
    assert.equal(active.status, 200);
    assert.equal(
      (
        await f.api(
          "GET",
          `/api/v1/terminal-sessions/${active.body.session_id}/recording`,
          undefined,
          auth.alice,
        )
      ).status,
      403,
    );
    for (const token of [auth.alice, auth.auditor])
      assert.equal(
        (
          await f.api(
            "POST",
            `/api/v1/terminal-sessions/${active.body.session_id}/close`,
            { v: 1 },
            token,
          )
        ).status,
        403,
      );
    assert.equal(
      (
        await f.api(
          "POST",
          `/api/v1/terminal-sessions/${active.body.session_id}/close`,
          { v: 1 },
          auth.bob,
        )
      ).status,
      200,
    );
    // Existing tokens and pagination cursors cannot retain a removed audit grant.
    const auditPage = await list(auth.auditor, "?limit=1");
    db.prepare("UPDATE access_roles SET permissions=? WHERE id='auditor'").run(
      JSON.stringify(["devices.read", "recordings.read"]),
    );
    assert.deepEqual((await list(auth.auditor)).body.sessions, []);
    assert.equal(
      (
        await list(
          auth.auditor,
          "?limit=1&cursor=" + auditPage.body.page.next_cursor,
        )
      ).status,
      400,
    );
    assert.equal(
      (
        await f.api(
          "GET",
          "/api/v1/terminal-sessions/bob-web/recording",
          undefined,
          auth.auditor,
        )
      ).status,
      403,
    );
  } finally {
    await f.close();
  }
});

test("logout revokes only the current token, its active terminal and pending tickets", async () => {
  const f = await fixture();
  try {
    const otherToken = await f.login("admin");
    const active = await f.open();
    const pending = await f.create();
    assert.equal(pending.status, 200);
    const other = await f.create(otherToken);
    assert.equal(other.status, 200);
    const otherBrowser = await f.attach(other.body);
    const opening = await f.agent.wait("terminal.open");
    assert.equal(opening.session_id, other.body.session_id);
    f.agent.send("terminal.opened", { session_id: opening.session_id });
    await otherBrowser.wait("terminal.ready");

    assert.equal((await f.api("POST", "/api/v1/logout", { v: 1 })).status, 401);
    assert.equal(
      (await f.api("POST", "/api/v1/logout", { v: 1 }, f.admin)).status,
      200,
    );
    assert.equal(
      (await active.browser.wait("terminal.closed")).reason,
      "USER_LOGOUT",
    );
    assert.equal((await f.agent.wait("terminal.close")).session_id, active.id);
    const denied = await f.attach(pending.body);
    await once(denied.ws, "close");
    assert.equal(
      (await f.api("GET", "/api/v1/me", undefined, f.admin)).status,
      401,
    );
    assert.equal((await f.create()).status, 401);
    assert.equal(
      (await f.api("POST", "/api/v1/logout", { v: 1 }, f.admin)).status,
      401,
    );
    assert.equal(
      (await f.api("GET", "/api/v1/me", undefined, otherToken)).status,
      200,
    );
    assert.equal(otherBrowser.ws.readyState, WebSocket.OPEN);
    otherBrowser.send("terminal.input", {
      data: Buffer.from("still-authorized\n").toString("base64"),
    });
    assert.equal(
      (await f.agent.wait("terminal.input")).session_id,
      opening.session_id,
    );
    for (const id of [active.id, pending.body.session_id]) {
      const row = f.store.db
        .prepare("SELECT ended_at,reason FROM terminal_sessions WHERE id=?")
        .get(id) as any;
      assert.ok(row.ended_at);
      assert.equal(row.reason, "USER_LOGOUT");
    }
    const audits = f.store.db
      .prepare(
        "SELECT actor_id,detail_json FROM audit WHERE action='user.logout'",
      )
      .all();
    assert.equal(audits.length, 1);
    assert.ok(audits[0].actor_id);
    assert.ok(!JSON.stringify(audits).includes(f.admin));
  } finally {
    await f.close();
  }
});
