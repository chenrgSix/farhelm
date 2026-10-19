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
import {
  AccountAuthorizations,
  defaultAccountId,
} from "../src/account-authorizations.js";
import { assertValid } from "../../../tests/contracts/validate.mjs";

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

test("target account ACL, sudo permission, private credential delivery and revocation share the terminal path", async () => {
  const f = await fixture();
  try {
    const opsUser = f.store.seedUser({
      username: "account-ops",
      password: "terminal-test-password1",
      role: "ops",
      deviceScope: ["device"],
    });
    const ops = await f.login("account-ops");
    const password = "sudo-public-fixture-!中文$'";
    const saved = await f.api(
      "POST",
      "/api/v1/devices/device/accounts",
      {
        v: 1,
        name: "Root account",
        username: "root",
        method: "sudo",
        allowed_users: [opsUser.id],
        sudo_password: password,
      },
      f.admin,
    );
    assert.equal(saved.status, 200, JSON.stringify(saved));
    const account = saved.body.account;
    assert.equal(JSON.stringify(saved).includes(password), false);
    assert.equal(
      (await f.api("GET", "/api/v1/devices/device/accounts", undefined, ops))
        .body.accounts.length,
      0,
      "ordinary terminal access grants no sudo access",
    );
    const create = (auth = f.admin) =>
      f.api(
        "POST",
        "/api/v1/terminal-sessions",
        {
          v: 1,
          device_id: "device",
          account_id: account.id,
          cols: 80,
          rows: 24,
        },
        auth,
      );
    assert.equal((await create(ops)).status, 403);
    const role = f.store.db
      .prepare("SELECT permissions FROM access_roles WHERE id='ops'")
      .get()!;
    f.store.db
      .prepare("UPDATE access_roles SET permissions=? WHERE id='ops'")
      .run(
        JSON.stringify([
          ...JSON.parse(role.permissions as string),
          "terminal.sudo",
        ]),
      );
    assert.equal(
      (await f.api("GET", "/api/v1/devices/device/accounts", undefined, ops))
        .body.accounts.length,
      1,
    );
    assert.equal(
      (await create(ops)).body.error,
      "SUDO_NOT_SUPPORTED_UPDATE_AGENT",
    );
    f.agent.send("agent.heartbeat", {
      agent_version: "test-sudo",
      capabilities: ["terminal.pty.v1", "terminal.sudo.v1"],
    });
    await new Promise((resolve) => setTimeout(resolve, 30));
    const created = await create(ops);
    assert.equal(created.status, 200, JSON.stringify(created));
    assert.equal(JSON.stringify(created).includes(password), false);
    const browser = await f.attach(created.body);
    const request = await f.agent.wait("terminal.sudo.open");
    assert.equal(request.sudo_password, password);
    assert.equal(request.username, "root");
    assert.equal(
      f.agent.messages.some((m) => m.type === "terminal.input"),
      false,
      "password is never injected as terminal input",
    );
    f.agent.send("terminal.opened", { session_id: request.session_id });
    assert.deepEqual(await browser.wait("terminal.ready"), {
      backend: "agent",
      elevated: true,
      username: "root",
    });
    assert.equal(JSON.stringify(browser.messages).includes(password), false);
    const db = f.store.db;
    assert.equal(
      JSON.stringify(db.prepare("SELECT * FROM audit").all()).includes(
        password,
      ),
      false,
    );
    assert.equal(
      JSON.stringify(
        db.prepare("SELECT * FROM terminal_recordings").all(),
      ).includes(password),
      false,
    );
    assert.equal(
      JSON.stringify(
        db.prepare("SELECT * FROM target_accounts").all(),
      ).includes(password),
      false,
    );
    assert.equal(
      (
        await f.api(
          "PUT",
          `/api/v1/devices/device/accounts/${account.id}`,
          { ...account, v: 1 },
          f.admin,
        )
      ).status,
      400,
    );
    const edit = {
      v: 1,
      revision: account.revision,
      name: account.name,
      username: "root",
      method: "sudo",
      allowed_users: [opsUser.id],
    };
    assert.equal(
      (
        await f.api(
          "PUT",
          `/api/v1/devices/device/accounts/${account.id}`,
          edit,
          f.admin,
        )
      ).body.error,
      "CONNECTION_HAS_ACTIVE_SESSIONS",
    );
    f.store.db
      .prepare("UPDATE access_roles SET permissions=? WHERE id='ops'")
      .run(role.permissions);
    assert.equal(
      (await browser.wait("terminal.closed")).reason,
      "AUTHORIZATION_EXPIRED",
    );
    const updated = await f.api(
      "PUT",
      `/api/v1/devices/device/accounts/${account.id}`,
      edit,
      f.admin,
    );
    assert.equal(updated.status, 200, JSON.stringify(updated));
    assert.equal(
      (
        await f.api(
          "PUT",
          `/api/v1/devices/device/accounts/${account.id}`,
          edit,
          f.admin,
        )
      ).body.error,
      "TARGET_ACCOUNT_CHANGED_RELOAD",
    );
    f.store.db
      .prepare(
        "INSERT INTO devices(id,public_key,name,created_at) VALUES('other','other-key','other',1)",
      )
      .run();
    assert.equal(
      (
        await f.api(
          "POST",
          "/api/v1/terminal-sessions",
          {
            v: 1,
            device_id: "other",
            account_id: account.id,
            cols: 80,
            rows: 24,
          },
          f.admin,
        )
      ).status,
      403,
    );
    assert.equal(
      (
        await f.api(
          "POST",
          "/api/v1/terminal-sessions",
          { v: 1, device_id: "device", elevated: true, cols: 80, rows: 24 },
          ops,
        )
      ).status,
      400,
      "there is no ACL bypass through a raw elevation flag",
    );
  } finally {
    await f.close();
  }
});

test("target account grants combine users, groups and direct or inherited roles without bypassing permissions or scope", async () => {
  const f = await fixture();
  try {
    const db = f.store.db;
    const seed = (username: string, scope: string[] = ["device"]) =>
      f.store.seedUser({
        username,
        password: "terminal-test-password1",
        role: "ops",
        deviceScope: scope,
      });
    const direct = seed("grant-direct"),
      member = seed("grant-member"),
      roleUser = seed("grant-role"),
      inherited = seed("grant-inherited"),
      outsider = seed("grant-outsider"),
      noSudo = seed("grant-no-sudo"),
      noScope = seed("grant-no-scope", []);
    const role = (
      await f.api(
        "POST",
        "/api/v1/roles",
        {
          v: 1,
          name: "Target role",
          description: "",
          permissions: ["devices.read", "terminal.connect", "terminal.sudo"],
        },
        f.admin,
      )
    ).body.role;
    const otherRole = (
      await f.api(
        "POST",
        "/api/v1/roles",
        {
          v: 1,
          name: "Unrelated privilege",
          description: "",
          permissions: ["devices.read", "terminal.connect", "terminal.sudo"],
        },
        f.admin,
      )
    ).body.role;
    for (const u of [direct, member, roleUser, inherited, noScope])
      db.prepare("INSERT INTO user_roles(user_id,role_id) VALUES(?,?)").run(
        u.id,
        u === roleUser ? role.id : otherRole.id,
      );
    db.prepare("INSERT INTO user_roles(user_id,role_id) VALUES(?,?)").run(
      outsider.id,
      otherRole.id,
    );
    const group = (
      await f.api(
        "POST",
        "/api/v1/groups",
        {
          v: 1,
          name: "Allowed group",
          description: "",
          role_ids: [],
          member_ids: [member.id, noSudo.id, noScope.id],
          device_scope: [],
        },
        f.admin,
      )
    ).body.group;
    const inheritance = (
      await f.api(
        "POST",
        "/api/v1/groups",
        {
          v: 1,
          name: "Inheritance group",
          description: "",
          role_ids: [role.id],
          member_ids: [inherited.id],
          device_scope: [],
        },
        f.admin,
      )
    ).body.group;
    const body = {
      v: 1,
      name: "Shared root",
      username: "root",
      method: "sudo",
      allowed_users: [direct.id],
      allowed_groups: [group.id],
      allowed_roles: [role.id],
      sudo_password: "fixture-password9",
    };
    const saved = await f.api(
      "POST",
      "/api/v1/devices/device/accounts",
      body,
      f.admin,
    );
    assert.equal(saved.status, 200, JSON.stringify(saved));
    const account = saved.body.account;
    assert.deepEqual(account.allowed_groups, [group.id]);
    assert.deepEqual(account.allowed_roles, [role.id]);
    const snapshot = (
      await f.api("GET", "/api/v1/devices/device/accounts", undefined, f.admin)
    ).body;
    assert.ok(snapshot.groups.some((g: any) => g.id === group.id));
    assert.ok(snapshot.roles.some((r: any) => r.id === role.id));
    const blocked = (
      await f.api(
        "GET",
        `/api/v1/access-authorizations/effective/${noScope.id}`,
        undefined,
        f.admin,
      )
    ).body;
    assertValid("effective-authorization-response", blocked);
    assert.equal(blocked.accounts[0].allowed, false);
    assert.ok(blocked.accounts[0].missing.includes("原设备范围"));
    for (const u of [
      direct,
      member,
      roleUser,
      inherited,
      outsider,
      noSudo,
      noScope,
    ]) {
      const auth = await f.login(u.username);
      const listed = await f.api(
        "GET",
        "/api/v1/devices/device/accounts",
        undefined,
        auth,
      );
      const created = await f.api(
        "POST",
        "/api/v1/terminal-sessions",
        {
          v: 1,
          device_id: "device",
          account_id: account.id,
          cols: 80,
          rows: 24,
        },
        auth,
      );
      if ([direct, member, roleUser, inherited].includes(u)) {
        assert.equal(listed.body.accounts.length, 1, u.username);
        assert.equal(
          created.body.error,
          "SUDO_NOT_SUPPORTED_UPDATE_AGENT",
          u.username,
        );
        assert.equal(
          listed.body.groups,
          undefined,
          "non-admins cannot list platform groups",
        );
        assert.equal(
          listed.body.roles,
          undefined,
          "non-admins cannot list platform roles",
        );
      } else {
        assert.equal(created.status, 403, u.username);
        if (u !== noScope)
          assert.deepEqual(listed.body.accounts, [], u.username);
      }
    }
    for (const [field, values, code] of [
      ["allowed_groups", [group.id, group.id], "INVALID_ACCOUNT_GROUPS"],
      ["allowed_groups", ["missing-group"], "INVALID_ACCOUNT_GROUPS"],
      ["allowed_groups", null, "INVALID_ACCOUNT_GROUPS"],
      ["allowed_roles", ["missing-role"], "INVALID_ACCOUNT_ROLES"],
      ["allowed_roles", [role.id, role.id], "INVALID_ACCOUNT_ROLES"],
    ] as const) {
      const bad = await f.api(
        "POST",
        "/api/v1/devices/device/accounts",
        { ...body, [field]: values },
        f.admin,
      );
      assert.equal(bad.body.error, code);
    }
    const legacyEdit = await f.api(
      "PUT",
      `/api/v1/devices/device/accounts/${account.id}`,
      {
        v: 1,
        revision: account.revision,
        name: account.name,
        username: "root",
        method: "sudo",
        allowed_users: [direct.id],
      },
      f.admin,
    );
    assert.equal(legacyEdit.status, 200, JSON.stringify(legacyEdit));
    assert.deepEqual(legacyEdit.body.account.allowed_groups, [group.id]);
    assert.deepEqual(legacyEdit.body.account.allowed_roles, [role.id]);
    // Reopening the database must preserve both existing user grants and the new relations.
    const reopened = new Store(f.store.dataDir);
    assert.equal(
      reopened.db
        .prepare("SELECT COUNT(*) AS n FROM target_account_groups")
        .get()!.n,
      1,
    );
    assert.equal(
      reopened.db
        .prepare("SELECT COUNT(*) AS n FROM target_account_roles")
        .get()!.n,
      1,
    );
    reopened.close();
    assert.equal(
      (
        await f.api(
          "DELETE",
          `/api/v1/groups/${group.id}`,
          { v: 1, revision: group.revision },
          f.admin,
        )
      ).status,
      200,
    );
    db.prepare("DELETE FROM user_roles WHERE role_id=?").run(role.id);
    db.prepare("DELETE FROM group_roles WHERE role_id=?").run(role.id);
    assert.equal(
      (
        await f.api(
          "DELETE",
          `/api/v1/roles/${role.id}`,
          { v: 1, revision: role.revision },
          f.admin,
        )
      ).status,
      200,
    );
    const after = (
      await f.api("GET", "/api/v1/devices/device/accounts", undefined, f.admin)
    ).body.accounts[0];
    assert.deepEqual(after.allowed_groups, []);
    assert.deepEqual(after.allowed_roles, []);
    assert.deepEqual(after.allowed_users, [direct.id]);
    assert.ok(inheritance.id);
  } finally {
    await f.close();
  }
});

for (const kind of ["group", "inherited-role"] as const) {
  test(`revoking a target account ${kind} grant closes its active terminal and invalidates pending tickets`, async () => {
    const f = await fixture();
    try {
      const user = f.store.seedUser({
        username: "revocable-member",
        password: "terminal-test-password1",
        role: "ops",
        deviceScope: ["device"],
      });
      const role = (
        await f.api(
          "POST",
          "/api/v1/roles",
          {
            v: 1,
            name: "Privileged member",
            description: "",
            permissions: ["devices.read", "terminal.connect", "terminal.sudo"],
          },
          f.admin,
        )
      ).body.role;
      const group = (
        await f.api(
          "POST",
          "/api/v1/groups",
          {
            v: 1,
            name: "Revocable group",
            description: "",
            role_ids: [role.id],
            member_ids: [user.id],
            device_scope: [],
          },
          f.admin,
        )
      ).body.group;
      const account = (
        await f.api(
          "POST",
          "/api/v1/devices/device/accounts",
          {
            v: 1,
            name: "Revocable root",
            username: "root",
            method: "sudo",
            allowed_users: [],
            allowed_groups: kind === "group" ? [group.id] : [],
            allowed_roles: kind === "inherited-role" ? [role.id] : [],
            sudo_password: "fixture-password9",
          },
          f.admin,
        )
      ).body.account;
      f.agent.send("agent.heartbeat", {
        agent_version: "test-sudo",
        capabilities: ["terminal.pty.v1", "terminal.sudo.v1"],
      });
      await new Promise((resolve) => setTimeout(resolve, 30));
      const auth = await f.login(user.username);
      const create = () =>
        f.api(
          "POST",
          "/api/v1/terminal-sessions",
          {
            v: 1,
            device_id: "device",
            account_id: account.id,
            cols: 80,
            rows: 24,
          },
          auth,
        );
      const active = await create();
      assert.equal(active.status, 200, JSON.stringify(active));
      const browser = await f.attach(active.body);
      const opening = await f.agent.wait("terminal.sudo.open");
      f.agent.send("terminal.opened", { session_id: opening.session_id });
      await browser.wait("terminal.ready");
      const pending = await create();
      assert.equal(pending.status, 200);
      const updated = await f.api(
        "PUT",
        `/api/v1/groups/${group.id}`,
        {
          v: 1,
          revision: group.revision,
          name: group.name,
          description: "",
          role_ids: kind === "inherited-role" ? [] : [role.id],
          member_ids: kind === "group" ? [] : [user.id],
          device_scope: [],
        },
        f.admin,
      );
      assert.equal(updated.status, 200, JSON.stringify(updated));
      await browser.wait("terminal.closed");
      assert.ok(
        f.store.db
          .prepare("SELECT ended_at FROM terminal_sessions WHERE id=?")
          .get(pending.body.session_id)!.ended_at,
      );
      const denied = await f.attach(pending.body);
      await once(denied.ws, "close");
      assert.equal((await create()).status, 401, "old login is invalidated");
      const fresh = await f.login(user.username);
      assert.deepEqual(
        (
          await f.api(
            "GET",
            "/api/v1/devices/device/accounts",
            undefined,
            fresh,
          )
        ).body.accounts,
        [],
      );
      assert.equal(
        (
          await f.api(
            "POST",
            "/api/v1/terminal-sessions",
            {
              v: 1,
              device_id: "device",
              account_id: account.id,
              cols: 80,
              rows: 24,
            },
            fresh,
          )
        ).status,
        403,
      );
    } finally {
      await f.close();
    }
  });
}

test("unified default-account authorization is enforced for omitted and explicit account IDs and revokes active sessions", async () => {
  const f = await fixture();
  try {
    const u = f.store.seedUser({
      username: "default-user",
      password: "terminal-test-password1",
      role: "ops",
      deviceScope: ["device"],
    });
    const auth = await f.login(u.username);
    const listed = await f.api(
      "GET",
      "/api/v1/devices/device/login-accounts",
      undefined,
      auth,
    );
    assertValid("login-accounts-response", listed.body);
    assert.equal(listed.body.accounts.length, 1);
    assert.equal(listed.body.accounts[0].id, defaultAccountId("device"));
    const created = await f.create(auth);
    assert.equal(created.status, 200);
    const browser = await f.attach(created.body);
    const opening = await f.agent.wait("terminal.open");
    f.agent.send("terminal.opened", { session_id: opening.session_id });
    await browser.wait("terminal.ready");
    const snapshot = await f.api(
      "GET",
      "/api/v1/access-authorizations",
      undefined,
      f.admin,
    );
    assertValid("access-authorizations-response", snapshot.body);
    const rule = snapshot.body.rules.find(
      (r: any) =>
        r.account_id === defaultAccountId("device") &&
        r.subject_type === "device_scope",
    );
    assert.ok(rule);
    assert.equal(
      (
        await f.api(
          "DELETE",
          `/api/v1/access-authorizations/${rule.id}`,
          { v: 1, revision: rule.revision },
          f.admin,
        )
      ).status,
      200,
    );
    assert.equal(
      (await browser.wait("terminal.closed")).reason,
      "AUTHORIZATION_EXPIRED",
    );
    assert.equal(
      (await f.create(auth)).status,
      403,
      "omitted account cannot bypass default policy",
    );
    assert.equal(
      (
        await f.api(
          "POST",
          "/api/v1/terminal-sessions",
          {
            v: 1,
            device_id: "device",
            account_id: defaultAccountId("device"),
            cols: 80,
            rows: 24,
          },
          auth,
        )
      ).status,
      403,
    );
    assert.deepEqual(
      (
        await f.api(
          "GET",
          "/api/v1/devices/device/login-accounts",
          undefined,
          auth,
        )
      ).body.accounts,
      [],
    );
    const reopened = new Store(f.store.dataDir);
    new AccountAuthorizations(reopened.db).ensureDefault("device");
    assert.equal(
      reopened.db
        .prepare(
          "SELECT COUNT(*) AS n FROM account_authorizations WHERE account_id IS NULL AND device_id='device'",
        )
        .get()!.n,
      0,
      "removed inheritance is never restored on restart",
    );
    reopened.close();
    const restore = await f.api(
      "POST",
      "/api/v1/access-authorizations",
      {
        v: 1,
        device_id: "device",
        account_ids: [defaultAccountId("device")],
        subject_type: "device_scope",
        subject_id: null,
      },
      f.admin,
    );
    assert.equal(restore.status, 200, JSON.stringify(restore));
    assert.equal(
      (
        await f.api(
          "GET",
          "/api/v1/devices/device/login-accounts",
          undefined,
          auth,
        )
      ).body.accounts.length,
      1,
    );
  } finally {
    await f.close();
  }
});

test("new access rules grant only the selected login account, expose effective sources and preserve rules during credential edits", async () => {
  const f = await fixture();
  try {
    const db = f.store.db;
    const u = f.store.seedUser({
      username: "new-rule-user",
      password: "terminal-test-password1",
      role: "ops",
      deviceScope: [],
    });
    const perms = JSON.parse(
      db.prepare("SELECT permissions FROM access_roles WHERE id='ops'").get()!
        .permissions as string,
    );
    db.prepare("UPDATE access_roles SET permissions=? WHERE id='ops'").run(
      JSON.stringify([...perms, "terminal.sudo"]),
    );
    const auth = await f.login(u.username);
    const saved = await f.api(
      "POST",
      "/api/v1/devices/device/accounts",
      {
        v: 1,
        name: "Rule root",
        username: "root",
        method: "sudo",
        sudo_password: "fixture-password9",
      },
      f.admin,
    );
    assert.equal(saved.status, 200, JSON.stringify(saved));
    const account = saved.body.account;
    const payload = {
      v: 1,
      device_id: "device",
      account_ids: [account.id],
      subject_type: "role",
      subject_id: "ops",
    };
    assertValid("access-authorization-create", payload);
    assert.equal(
      (await f.api("POST", "/api/v1/access-authorizations", payload, auth))
        .status,
      403,
      "only admins configure rules",
    );
    for (const invalid of [
      { ...payload, account_ids: [account.id, account.id] },
      { ...payload, subject_id: "missing-role" },
      { ...payload, subject_type: "device_scope", subject_id: null },
    ])
      assert.equal(
        (await f.api("POST", "/api/v1/access-authorizations", invalid, f.admin))
          .status,
        400,
      );
    db.prepare(
      "INSERT INTO devices(id,public_key,name,created_at) VALUES('cross-device','cross-key','cross',1)",
    ).run();
    assert.equal(
      (
        await f.api(
          "POST",
          "/api/v1/access-authorizations",
          { ...payload, device_id: "cross-device" },
          f.admin,
        )
      ).body.error,
      "INVALID_AUTHORIZATION_ACCOUNTS",
    );
    db.exec(
      "CREATE TRIGGER fail_authorization_audit BEFORE INSERT ON audit WHEN NEW.action='access.authorization_created' BEGIN SELECT RAISE(ABORT,'test audit failure'); END",
    );
    assert.equal(
      (await f.api("POST", "/api/v1/access-authorizations", payload, f.admin))
        .status,
      500,
    );
    assert.equal(
      db
        .prepare(
          "SELECT COUNT(*) AS n FROM account_authorizations WHERE account_id=?",
        )
        .get(account.id)!.n,
      0,
      "failed audit rolls back the grant",
    );
    assert.deepEqual(
      f.store.user(db.prepare("SELECT * FROM users WHERE id=?").get(u.id))
        .device_scope,
      [],
    );
    db.exec("DROP TRIGGER fail_authorization_audit");
    const granted = await f.api(
      "POST",
      "/api/v1/access-authorizations",
      payload,
      f.admin,
    );
    assert.equal(granted.status, 200, JSON.stringify(granted));
    const repeated = await f.api(
      "POST",
      "/api/v1/access-authorizations",
      payload,
      f.admin,
    );
    assert.deepEqual(
      repeated.body.rule_ids,
      granted.body.rule_ids,
      "retry cannot duplicate the same grant",
    );
    const listed = await f.api(
      "GET",
      "/api/v1/devices/device/login-accounts",
      undefined,
      auth,
    );
    assert.deepEqual(
      listed.body.accounts.map((a: any) => a.id),
      [account.id],
      "new resource scope must not activate legacy default inheritance",
    );
    assert.equal((await f.create(auth)).status, 403);
    const effective = await f.api(
      "GET",
      `/api/v1/access-authorizations/effective/${u.id}`,
      undefined,
      f.admin,
    );
    assertValid("effective-authorization-response", effective.body);
    assert.equal(effective.body.accounts.length, 1);
    assert.equal(effective.body.accounts[0].allowed, true);
    assert.ok(effective.body.accounts[0].reasons.length);
    assert.equal(
      (
        await f.api(
          "GET",
          `/api/v1/access-authorizations/effective/${u.id}`,
          undefined,
          auth,
        )
      ).status,
      403,
    );
    const edit = await f.api(
      "PUT",
      `/api/v1/devices/device/accounts/${account.id}`,
      {
        v: 1,
        revision: account.revision,
        name: "Renamed root",
        username: "root",
        method: "sudo",
      },
      f.admin,
    );
    assert.equal(edit.status, 200, JSON.stringify(edit));
    assert.equal(
      db
        .prepare("SELECT legacy_scope FROM account_authorizations WHERE id=?")
        .get(granted.body.rule_ids[0])!.legacy_scope,
      0,
      "credential-only edits preserve rule semantics and IDs",
    );
    const legacyCompatible = await f.api(
      "PUT",
      `/api/v1/devices/device/accounts/${account.id}`,
      {
        v: 1,
        revision: edit.body.account.revision,
        name: "Renamed again",
        username: "root",
        method: "sudo",
        allowed_users: [],
        allowed_groups: [],
        allowed_roles: ["ops"],
      },
      f.admin,
    );
    assert.equal(
      legacyCompatible.status,
      200,
      JSON.stringify(legacyCompatible),
    );
    assert.equal(
      db
        .prepare("SELECT legacy_scope FROM account_authorizations WHERE id=?")
        .get(granted.body.rule_ids[0])!.legacy_scope,
      0,
      "unchanged explicit ACL from old clients also preserves rule IDs and resource scope",
    );
    f.agent.send("agent.heartbeat", {
      agent_version: "test-sudo",
      capabilities: ["terminal.pty.v1", "terminal.sudo.v1"],
    });
    await new Promise((resolve) => setTimeout(resolve, 30));
    const create = () =>
      f.api(
        "POST",
        "/api/v1/terminal-sessions",
        {
          v: 1,
          device_id: "device",
          account_id: account.id,
          cols: 80,
          rows: 24,
        },
        auth,
      );
    const active = await create();
    assert.equal(active.status, 200, JSON.stringify(active));
    const browser = await f.attach(active.body);
    const opening = await f.agent.wait("terminal.sudo.open");
    f.agent.send("terminal.opened", { session_id: opening.session_id });
    await browser.wait("terminal.ready");
    const pending = await create();
    assert.equal(pending.status, 200);
    assert.equal(
      (
        await f.api(
          "DELETE",
          `/api/v1/access-authorizations/${granted.body.rule_ids[0]}`,
          { v: 1, revision: 1 },
          f.admin,
        )
      ).status,
      200,
    );
    await browser.wait("terminal.closed");
    assert.ok(
      db
        .prepare("SELECT ended_at FROM terminal_sessions WHERE id=?")
        .get(pending.body.session_id)!.ended_at,
    );
    assert.equal((await create()).status, 403);
    assert.deepEqual(
      f.store.user(db.prepare("SELECT * FROM users WHERE id=?").get(u.id))
        .device_scope,
      [],
    );
    for (const audit of (
      await f.api("GET", "/api/v1/audit", undefined, f.admin)
    ).body.audit)
      assertValid("audit", audit);
  } finally {
    await f.close();
  }
});

test("authorization migration keeps credentials and legacy scope intersections and is idempotent", async () => {
  const f = await fixture();
  let reopened: Store | undefined;
  try {
    const db = f.store.db;
    const user = f.store.seedUser({
      username: "legacy-allowed",
      password: "terminal-test-password1",
      role: "ops",
      deviceScope: ["device"],
    });
    const outside = f.store.seedUser({
      username: "legacy-outside",
      password: "terminal-test-password1",
      role: "ops",
      deviceScope: [],
    });
    const account = (
      await f.api(
        "POST",
        "/api/v1/devices/device/accounts",
        {
          v: 1,
          name: "Legacy sudo",
          username: "root",
          method: "sudo",
          allowed_users: [user.id, outside.id],
          allowed_roles: ["ops"],
          sudo_password: "fixture-password9",
        },
        f.admin,
      )
    ).body.account;
    const ciphertext = db
      .prepare("SELECT secrets FROM target_accounts WHERE id=?")
      .get(account.id)!.secrets;
    db.exec(
      "DELETE FROM account_authorizations;DELETE FROM default_account_policies;DELETE FROM meta WHERE key='account_authorizations_v1'",
    );
    reopened = new Store(f.store.dataDir);
    const policy = new AccountAuthorizations(reopened.db);
    assert.equal(
      reopened.db
        .prepare("SELECT secrets FROM target_accounts WHERE id=?")
        .get(account.id)!.secrets,
      ciphertext,
    );
    assert.equal(policy.allowed(user, "device", account.id), true);
    assert.equal(
      policy.allowed(outside, "device", account.id),
      false,
      "old account ACL cannot grant new device scope",
    );
    assert.equal(policy.allowed(user, "device", null), true);
    assert.equal(policy.allowed(outside, "device", null), false);
    const count = reopened.db
      .prepare("SELECT COUNT(*) AS n FROM account_authorizations")
      .get()!.n;
    reopened.close();
    reopened = new Store(f.store.dataDir);
    assert.equal(
      reopened.db
        .prepare("SELECT COUNT(*) AS n FROM account_authorizations")
        .get()!.n,
      count,
    );
  } finally {
    reopened?.close();
    await f.close();
  }
});

test("new user, group and inherited-role rules supply resource scope without changing legacy device grants", async () => {
  const f = await fixture();
  try {
    const db = f.store.db;
    const seed = (username: string) =>
      f.store.seedUser({
        username,
        password: "terminal-test-password1",
        role: "ops",
        deviceScope: [],
      });
    const single = seed("explicit-user"),
      member = seed("explicit-group"),
      direct = seed("explicit-role"),
      inherited = seed("explicit-inherited");
    const role = (
      await f.api(
        "POST",
        "/api/v1/roles",
        {
          v: 1,
          name: "Rule privilege",
          description: "",
          permissions: ["devices.read", "terminal.connect", "terminal.sudo"],
        },
        f.admin,
      )
    ).body.role;
    for (const u of [single, direct])
      db.prepare("INSERT INTO user_roles(user_id,role_id) VALUES(?,?)").run(
        u.id,
        role.id,
      );
    const group = (
      await f.api(
        "POST",
        "/api/v1/groups",
        {
          v: 1,
          name: "Explicit group",
          description: "",
          role_ids: [role.id],
          member_ids: [member.id, inherited.id],
          device_scope: [],
        },
        f.admin,
      )
    ).body.group;
    for (const [kind, id, members] of [
      ["user", single.id, [single]],
      ["group", group.id, [member, inherited]],
      ["role", role.id, [single, member, direct, inherited]],
    ] as const) {
      const account = (
        await f.api(
          "POST",
          "/api/v1/devices/device/accounts",
          {
            v: 1,
            name: `Rule ${kind}`,
            username: "root",
            method: "sudo",
            sudo_password: "fixture-password9",
          },
          f.admin,
        )
      ).body.account;
      assert.equal(
        (
          await f.api(
            "POST",
            "/api/v1/access-authorizations",
            {
              v: 1,
              device_id: "device",
              account_ids: [account.id],
              subject_type: kind,
              subject_id: id,
            },
            f.admin,
          )
        ).status,
        200,
      );
      for (const u of members) {
        const auth = await f.login(u.username);
        const listed = (
          await f.api(
            "GET",
            "/api/v1/devices/device/login-accounts",
            undefined,
            auth,
          )
        ).body.accounts;
        assert.ok(listed.some((a: any) => a.id === account.id));
        assert.equal(
          listed.some((a: any) => a.is_default),
          false,
        );
        assert.equal(
          (
            await f.api(
              "POST",
              "/api/v1/terminal-sessions",
              {
                v: 1,
                device_id: "device",
                account_id: account.id,
                cols: 80,
                rows: 24,
              },
              auth,
            )
          ).body.error,
          "SUDO_NOT_SUPPORTED_UPDATE_AGENT",
        );
      }
    }
    for (const u of [single, member, direct, inherited])
      assert.equal(
        db.prepare("SELECT device_scope FROM users WHERE id=?").get(u.id)!
          .device_scope,
        "[]",
      );
  } finally {
    await f.close();
  }
});

test("explicit default root grants require privilege permission while existing default authorization is preserved", async () => {
  const f = await fixture();
  try {
    const legacy = f.store.seedUser({
      username: "existing-default-root",
      password: "terminal-test-password1",
      role: "ops",
      deviceScope: ["device"],
    });
    const fresh = f.store.seedUser({
      username: "new-default-root",
      password: "terminal-test-password1",
      role: "ops",
      deviceScope: [],
    });
    // Only the configured identity is read here; the fake Agent handles the terminal protocol.
    f.store.db
      .prepare(
        "INSERT INTO device_connections(device_id,config_json,secrets,revision,updated_at,actor_id) VALUES(?,?,?,1,1,(SELECT id FROM users WHERE username='admin'))",
      )
      .run(
        "device",
        JSON.stringify({ username: "root" }),
        "unused-test-credential",
      );
    const auth = await f.login(legacy.username);
    const ticket = await f.create(auth);
    assert.equal(
      ticket.status,
      200,
      "existing Linux access does not gain a new privilege requirement",
    );
    const added = await f.api(
      "POST",
      "/api/v1/access-authorizations",
      {
        v: 1,
        device_id: "device",
        account_ids: [defaultAccountId("device")],
        subject_type: "user",
        subject_id: fresh.id,
      },
      f.admin,
    );
    assert.equal(added.status, 200);
    const freshAuth = await f.login(fresh.username);
    assert.equal(
      (await f.create(freshAuth)).body.error,
      "SUDO_PERMISSION_REQUIRED",
    );
    const effective = (
      await f.api(
        "GET",
        `/api/v1/access-authorizations/effective/${fresh.id}`,
        undefined,
        f.admin,
      )
    ).body.accounts;
    assert.equal(effective[0].allowed, false);
    assert.ok(effective[0].missing.includes("sudo／特权账号权限"));
  } finally {
    await f.close();
  }
});

test("simple root mode preserves default authorization, requires sudo permission and supports passwordless agents", async () => {
  const f = await fixture();
  try {
    const user = f.store.seedUser({
      username: "simple-root",
      password: "terminal-test-password1",
      role: "ops",
      deviceScope: ["device"],
    });
    const auth = await f.login("simple-root");
    const create = (mode: unknown = "root", extra = {}) =>
      f.api(
        "POST",
        "/api/v1/terminal-sessions",
        {
          v: 1,
          device_id: "device",
          cols: 80,
          rows: 24,
          connection_mode: mode,
          ...extra,
        },
        auth,
      );
    assert.equal((await create()).body.error, "SUDO_PERMISSION_REQUIRED");
    assert.equal((await create("shell")).status, 400);
    assert.equal(
      (await create("normal", { account_id: defaultAccountId("device") }))
        .status,
      400,
    );
    const permissions = f.store.db
      .prepare("SELECT permissions FROM access_roles WHERE id='ops'")
      .get()!.permissions as string;
    f.store.db
      .prepare("UPDATE access_roles SET permissions=? WHERE id='ops'")
      .run(JSON.stringify([...JSON.parse(permissions), "terminal.sudo"]));
    f.agent.send("agent.heartbeat", {
      agent_version: "password-only",
      capabilities: ["terminal.pty.v1", "terminal.sudo.v1"],
    });
    await new Promise((r) => setTimeout(r, 30));
    assert.equal((await create()).body.error, "SUDO_PASSWORD_REQUIRED");
    f.agent.send("agent.heartbeat", {
      agent_version: "nopasswd",
      capabilities: [
        "terminal.pty.v1",
        "terminal.sudo.v1",
        "terminal.sudo.nopasswd.v1",
      ],
    });
    await new Promise((r) => setTimeout(r, 30));
    const normal = await create("normal");
    assert.equal(normal.status, 200);
    await f.attach(normal.body);
    assert.equal(
      (await f.agent.wait("terminal.open")).session_id,
      normal.body.session_id,
    );
    const created = await create();
    assert.equal(created.status, 200, JSON.stringify(created));
    const browser = await f.attach(created.body);
    const request = await f.agent.wait("terminal.sudo.open");
    assert.equal(request.sudo_password, "");
    assert.equal(request.username, "root");
    assertValid("terminal-envelope", {
      v: 1,
      type: "terminal.sudo.open",
      body: request,
    });
    f.agent.send("terminal.opened", { session_id: request.session_id });
    assert.deepEqual(await browser.wait("terminal.ready"), {
      backend: "agent",
      elevated: true,
      username: "root",
    });
    const rules = new AccountAuthorizations(f.store.db);
    rules.ensureDefault("device");
    f.store.db
      .prepare(
        "DELETE FROM account_authorizations WHERE device_id='device' AND account_id IS NULL",
      )
      .run();
    assert.equal(
      (await create()).status,
      403,
      "root mode cannot bypass a revoked default grant",
    );
    assert.equal(
      (await browser.wait("terminal.closed")).reason,
      "AUTHORIZATION_EXPIRED",
    );
    assert.equal(
      f.store.db.prepare("SELECT count(*) AS n FROM target_accounts").get()!.n,
      0,
      "no extra root account is required",
    );
  } finally {
    await f.close();
  }
});
