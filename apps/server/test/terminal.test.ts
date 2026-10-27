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
import {
  seedLegacyAccount,
  seedLegacyGrant,
} from "./legacy-account-fixture.js";
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
    capabilities: ["terminal.pty.v1", "terminal.policy.v1"],
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

test("terminal command recorder shares durable output transaction, strips metadata and never saves password input", async () => {
  const f = await fixture();
  try {
    const { browser, id } = await f.open();
    const mark = (value: string) => `\x1b]777;farhelm;${id};${value}\x07`;
    const content = Buffer.from(
      mark("R;bash") +
        "prompt> read -s hidden\r\n" +
        mark("C;" + Buffer.from("read -s hidden").toString("base64")),
    );
    let seq = 0;
    for (const part of [content.subarray(0, 13), content.subarray(13)]) {
      f.agent.send("terminal.output", {
        session_id: id,
        seq: ++seq,
        data: part.toString("base64"),
      });
      await f.agent.wait("terminal.ack");
    }
    browser.send("terminal.input", {
      data: Buffer.from("private-hidden-value\r").toString("base64"),
    });
    await f.agent.wait("terminal.input");
    const finish =
      mark("E;0") +
      mark(
        "C;" +
          Buffer.from("curl --password private-argument-value").toString(
            "base64",
          ),
      ) +
      mark("E;1");
    f.agent.send("terminal.output", {
      session_id: id,
      seq: ++seq,
      data: Buffer.from(finish).toString("base64"),
    });
    await f.agent.wait("terminal.ack");
    const rows = f.store.db
      .prepare("SELECT * FROM terminal_commands WHERE session_id=? ORDER BY id")
      .all(id) as any[];
    assert.equal(rows.length, 2);
    assert.equal(rows[0].command, "read -s hidden");
    assert.equal(rows[0].exit_code, 0);
    assert.equal(rows[1].redacted, 1);
    assert.equal(rows[1].exit_code, 1);
    const recordings = f.store.db
      .prepare("SELECT * FROM terminal_recordings WHERE session_id=?")
      .all(id) as any[];
    const decoded = recordings
      .filter((r) => r.kind === "output")
      .map((r) => Buffer.from(JSON.parse(r.data).data, "base64").toString())
      .join("");
    assert.equal(decoded, "prompt> read -s hidden\r\n");
    assert.ok(!JSON.stringify(rows).includes("private-"));
    assert.ok(recordings.some((r) => r.seq === rows[0].recording_seq));
    const response = await f.api(
      "GET",
      `/api/v1/devices/device/terminal-commands?from=${Date.now() - 60000}&to=${Date.now() + 1000}`,
      undefined,
      f.admin,
    );
    assert.equal(response.status, 200);
    assertValid("terminal-commands-response", response.body);
  } finally {
    await f.close();
  }
});
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

test("retired account requests never create sessions or disclose secrets, while legacy history remains readable", async () => {
  const f = await fixture();
  try {
    const user = f.store.seedUser({
      username: "legacy-user",
      password: "terminal-test-password1",
      role: "ops",
      deviceScope: [],
    });
    const auth = await f.login(user.username);
    const password = "legacy-private-fixture";
    const account = seedLegacyAccount(f.store, "device", {
      name: "Legacy root",
      username: "root",
      method: "sudo",
      sudo_password: password,
    });
    seedLegacyGrant(f.store, "device", account.id, user.id);
    const db = f.store.db;
    new AccountAuthorizations(db).ensureDefault("device");
    // Closed evidence from an older version must retain its original identity.
    const at = Date.now() - 1000;
    const metadata = {
      account_id: account.id,
      username: "root",
      method: "sudo",
      elevated: true,
    };
    db.prepare(
      "INSERT INTO terminal_sessions(id,device_id,actor_id,status,cols,rows,created_at,ended_at,transport,last_seq) VALUES('legacy-session','device',?,'CLOSED',80,24,?,?,'web',1)",
    ).run(user.id, at, at + 1);
    db.prepare(
      "INSERT INTO terminal_recordings(session_id,seq,at,kind,data) VALUES('legacy-session',1,?,'open',?)",
    ).run(at, JSON.stringify(metadata));
    db.prepare(
      "INSERT INTO terminal_commands(session_id,device_id,actor_id,started_at,command,redacted,recording_seq) VALUES('legacy-session','device',?,?,'echo historical-marker',0,1)",
    ).run(user.id, at);
    const snapshot = () =>
      JSON.stringify(
        [
          "target_accounts",
          "account_authorizations",
          "terminal_sessions",
          "terminal_recordings",
          "terminal_commands",
        ].map((table) =>
          db.prepare(`SELECT * FROM ${table} ORDER BY rowid`).all(),
        ),
      );
    const before = snapshot();
    for (const credential of [f.admin, auth]) {
      for (const accountId of [
        account.id,
        defaultAccountId("device"),
        "missing",
        "",
        null,
        123,
      ]) {
        for (const mode of [undefined, "normal"]) {
          const response = await f.api(
            "POST",
            "/api/v1/terminal-sessions",
            {
              v: 1,
              device_id: "device",
              cols: 80,
              rows: 24,
              account_id: accountId,
              ...(mode ? { connection_mode: mode } : {}),
            },
            credential,
          );
          assert.equal(response.status, 400);
          assert.equal(response.body.error, "ACCOUNT_CONNECTION_REMOVED");
          assert.equal(JSON.stringify(response).includes(password), false);
        }
      }
    }
    assert.equal(snapshot(), before);
    assert.ok(
      !f.agent.messages.some((m) =>
        ["terminal.open", "terminal.sudo.open"].includes(m.type),
      ),
    );
    assert.deepEqual(
      (
        await f.api(
          "GET",
          "/api/v1/devices/device/login-accounts",
          undefined,
          f.admin,
        )
      ).body.accounts.map((a: any) => a.id),
      [defaultAccountId("device")],
    );
    const recording = await f.api(
      "GET",
      "/api/v1/terminal-sessions/legacy-session/recording",
      undefined,
      auth,
    );
    assert.equal(recording.status, 200);
    assert.deepEqual(recording.body.events[0].data, metadata);
    assert.equal(
      (
        await f.api(
          "POST",
          "/api/v1/terminal-sessions/legacy-session/export",
          { v: 1 },
          auth,
        )
      ).status,
      200,
    );
    const history = await f.api(
      "GET",
      `/api/v1/devices/device/terminal-commands?from=${at - 1}&to=${at + 100}&q=HISTORICAL`,
      undefined,
      auth,
    );
    assert.equal(history.status, 200, JSON.stringify(history));
    assert.equal(history.body.commands[0].session_id, "legacy-session");
    assert.equal(history.body.commands[0].recording_seq, 1);
    assert.equal(snapshot(), before);
    assert.equal(
      (await f.create(auth)).status,
      403,
      "archived authorization retains historical device scope without granting ordinary connection",
    );
    const ordinary = await f.open();
    assert.ok(ordinary.id);
    assert.ok(!f.agent.messages.some((m) => m.type === "terminal.sudo.open"));
    assert.equal(
      JSON.stringify(db.prepare("SELECT * FROM audit").all()).includes(
        password,
      ),
      false,
    );
  } finally {
    await f.close();
  }
});

test("retired configuration and authorization APIs cannot expose or mutate archived accounts", async () => {
  const f = await fixture();
  try {
    const user = f.store.seedUser({
      username: "config-ops",
      password: "terminal-test-password1",
      role: "ops",
      deviceScope: ["device"],
    });
    const auth = await f.login(user.username);
    const account = seedLegacyAccount(f.store, "device", {
      name: "Archived root",
      username: "root",
      method: "sudo",
      sudo_password: "private-archived-secret",
      allowed_roles: ["ops"],
    });
    new AccountAuthorizations(f.store.db).ensureDefault("device");
    const snapshot = () =>
      JSON.stringify(
        [
          "target_accounts",
          "account_authorizations",
          "target_account_groups",
          "target_account_roles",
        ].map((t) =>
          f.store.db.prepare(`SELECT * FROM ${t} ORDER BY rowid`).all(),
        ),
      );
    const before = snapshot();
    for (const path of [
      "/api/v1/devices/device/accounts",
      `/api/v1/devices/device/accounts/${account.id}`,
    ]) {
      for (const method of ["GET", "POST", "PUT", "DELETE"]) {
        const r = await f.api(
          method,
          path,
          method === "GET"
            ? undefined
            : {
                v: 1,
                revision: 1,
                name: "Overwrite",
                username: "root",
                method: "sudo",
                sudo_password: "replacement-secret",
              },
          f.admin,
        );
        assert.equal(r.status, 410);
        assert.equal(r.body.error, "ACCOUNT_CONFIGURATION_REMOVED");
        assert.equal(JSON.stringify(r).includes("Archived root"), false);
        assert.equal(JSON.stringify(r).includes("secret"), false);
      }
    }
    assert.equal(
      (await f.api("GET", "/api/v1/devices/device/accounts")).status,
      401,
    );
    assert.equal(
      (await f.api("POST", "/api/v1/devices/device/accounts", { v: 1 }, auth))
        .status,
      403,
    );
    const rejected = await f.api(
      "POST",
      "/api/v1/access-authorizations",
      {
        v: 1,
        device_id: "device",
        account_ids: [account.id],
        subject_type: "user",
        subject_id: user.id,
      },
      f.admin,
    );
    assert.equal(rejected.status, 400);
    assert.equal(rejected.body.error, "ACCOUNT_AUTHORIZATION_REMOVED");
    const retiredRule = f.store.db
      .prepare("SELECT id FROM account_authorizations WHERE account_id=?")
      .get(account.id)!;
    const removed = await f.api(
      "DELETE",
      `/api/v1/access-authorizations/${retiredRule.id}`,
      { v: 1, revision: 1 },
      f.admin,
    );
    assert.equal(removed.status, 410);
    const visible = await f.api(
      "GET",
      "/api/v1/access-authorizations",
      undefined,
      f.admin,
    );
    assertValid("access-authorizations-response", visible.body);
    assert.ok(
      visible.body.accounts.every(
        (a: any) => a.is_default && a.method === "default",
      ),
    );
    assert.ok(
      visible.body.rules.every(
        (r: any) => r.account_id === defaultAccountId("device"),
      ),
    );
    const effective = await f.api(
      "GET",
      `/api/v1/access-authorizations/effective/${user.id}`,
      undefined,
      f.admin,
    );
    assertValid("effective-authorization-response", effective.body);
    assert.ok(
      effective.body.accounts.every(
        (a: any) => a.is_default && a.method === "default",
      ),
    );
    assert.equal(snapshot(), before);
  } finally {
    await f.close();
  }
});

for (const kind of ["group", "inherited-role"] as const) {
  test(`revoking a default account ${kind} grant closes its active terminal and invalidates pending tickets`, async () => {
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
      new AccountAuthorizations(f.store.db).ensureDefault("device");
      f.store.db
        .prepare(
          "DELETE FROM account_authorizations WHERE device_id='device' AND account_id IS NULL",
        )
        .run();
      const granted = await f.api(
        "POST",
        "/api/v1/access-authorizations",
        {
          v: 1,
          device_id: "device",
          account_ids: [defaultAccountId("device")],
          subject_type: kind === "group" ? "group" : "role",
          subject_id: kind === "group" ? group.id : role.id,
        },
        f.admin,
      );
      assert.equal(granted.status, 200);
      const auth = await f.login(user.username);
      const create = () =>
        f.api(
          "POST",
          "/api/v1/terminal-sessions",
          {
            v: 1,
            device_id: "device",
            cols: 80,
            rows: 24,
          },
          auth,
        );
      const active = await create();
      assert.equal(active.status, 200, JSON.stringify(active));
      const browser = await f.attach(active.body);
      const opening = await f.agent.wait("terminal.open");
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
            "/api/v1/devices/device/login-accounts",
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

test("default authorization controls ordinary connections and revokes sessions; explicit IDs are retired", async () => {
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
      400,
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

test("ordinary grants are idempotent and revoke active sessions and unused tickets without accepting archived IDs", async () => {
  const f = await fixture();
  try {
    const user = f.store.seedUser({
      username: "ordinary-rule",
      password: "terminal-test-password1",
      role: "ops",
      deviceScope: [],
    });
    const auth = await f.login(user.username);
    assert.equal((await f.create(auth)).status, 403);
    const payload = {
      v: 1,
      device_id: "device",
      subject_type: "user",
      subject_id: user.id,
    };
    assertValid("access-authorization-create", payload);
    const granted = await f.api(
      "POST",
      "/api/v1/access-authorizations",
      payload,
      f.admin,
    );
    assert.equal(granted.status, 200);
    assert.deepEqual(
      (await f.api("POST", "/api/v1/access-authorizations", payload, f.admin))
        .body.rule_ids,
      granted.body.rule_ids,
    );
    assert.deepEqual(
      (
        await f.api(
          "POST",
          "/api/v1/access-authorizations",
          { ...payload, account_ids: [defaultAccountId("device")] },
          f.admin,
        )
      ).body.rule_ids,
      granted.body.rule_ids,
    );
    for (const bad of [
      [],
      [defaultAccountId("device"), defaultAccountId("device")],
      null,
    ])
      assert.equal(
        (
          await f.api(
            "POST",
            "/api/v1/access-authorizations",
            { ...payload, account_ids: bad },
            f.admin,
          )
        ).status,
        400,
      );
    const effective = await f.api(
      "GET",
      `/api/v1/access-authorizations/effective/${user.id}`,
      undefined,
      f.admin,
    );
    assert.equal(effective.body.accounts.length, 1);
    assert.equal(effective.body.accounts[0].allowed, true);
    assert.equal(
      (
        await f.api(
          "GET",
          `/api/v1/access-authorizations/effective/${user.id}`,
          undefined,
          auth,
        )
      ).status,
      403,
    );
    const active = await f.create(auth);
    const browser = await f.attach(active.body);
    const opening = await f.agent.wait("terminal.open");
    f.agent.send("terminal.opened", { session_id: opening.session_id });
    await browser.wait("terminal.ready");
    const pending = await f.create(auth);
    assert.equal(pending.status, 200);
    const ruleId = granted.body.rule_ids[0];
    assert.equal(
      (
        await f.api(
          "DELETE",
          `/api/v1/access-authorizations/${ruleId}`,
          { v: 1, revision: 2 },
          f.admin,
        )
      ).status,
      409,
    );
    assert.equal(
      (
        await f.api(
          "DELETE",
          `/api/v1/access-authorizations/${ruleId}`,
          { v: 1, revision: 1 },
          f.admin,
        )
      ).status,
      200,
    );
    await browser.wait("terminal.closed");
    assert.ok(
      f.store.db
        .prepare("SELECT ended_at FROM terminal_sessions WHERE id=?")
        .get(pending.body.session_id)!.ended_at,
    );
    const denied = await f.attach(pending.body);
    await once(denied.ws, "close");
    assert.equal((await f.create(auth)).status, 403);
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
    const account = seedLegacyAccount(f.store, "device", {
      name: "Legacy sudo",
      username: "root",
      method: "sudo",
      allowed_users: [user.id, outside.id],
      allowed_roles: ["ops"],
      sudo_password: "fixture-password9",
    });
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
      assert.equal(
        (
          await f.api(
            "POST",
            "/api/v1/access-authorizations",
            {
              v: 1,
              device_id: "device",
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
        assert.deepEqual(
          listed.map((a: any) => a.id),
          [defaultAccountId("device")],
        );
        assert.equal(
          listed.some((a: any) => a.is_default),
          true,
        );
        const created = await f.create(auth);
        assert.equal(created.status, 200);
        await f.api(
          "POST",
          `/api/v1/terminal-sessions/${created.body.session_id}/close`,
          { v: 1 },
          auth,
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

test("root backup SSH configuration does not require sudo for the Agent ordinary identity", async () => {
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
    assert.equal((await f.create(freshAuth)).status, 200);
    const effective = (
      await f.api(
        "GET",
        `/api/v1/access-authorizations/effective/${fresh.id}`,
        undefined,
        f.admin,
      )
    ).body.accounts;
    assert.equal(effective[0].allowed, true);
    assert.equal(effective[0].sudo_allowed, false);
  } finally {
    await f.close();
  }
});

test("removed root mode is rejected without opening a session; normal clients and default authorization remain compatible", async () => {
  const f = await fixture();
  try {
    f.store.seedUser({
      username: "ordinary-ops",
      password: "terminal-test-password1",
      role: "ops",
      deviceScope: ["device"],
    });
    const auth = await f.login("ordinary-ops");
    const create = (mode: unknown, user = auth, extra = {}) =>
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
        user,
      );
    // Reject the removed mode even for administrators and when a root account exists.
    seedLegacyAccount(f.store, "device", {
      name: "Existing root",
      username: "root",
      method: "sudo",
    });
    for (const user of [auth, f.admin]) {
      const rejected = await create("root", user);
      assert.equal(rejected.status, 400);
      assert.equal(rejected.body.error, "ROOT_CONNECTION_MODE_REMOVED");
    }
    assert.equal((await create("shell")).body.error, "INVALID_CONNECTION_MODE");
    assert.equal(
      (await create("normal", auth, { account_id: defaultAccountId("device") }))
        .body.error,
      "ACCOUNT_CONNECTION_REMOVED",
    );
    assert.equal(
      f.store.db.prepare("SELECT count(*) AS n FROM terminal_sessions").get()!
        .n,
      0,
    );
    const normal = await create("normal");
    assert.equal(normal.status, 200);
    const browser = await f.attach(normal.body);
    const request = await f.agent.wait("terminal.open");
    assert.equal(request.session_id, normal.body.session_id);
    assert.equal(request.sudo_password, undefined);
    assert.equal(request.sudo_auto_password, undefined);
    f.agent.send("terminal.opened", { session_id: request.session_id });
    assert.deepEqual(await browser.wait("terminal.ready"), {
      backend: "agent",
      sudo_allowed: false,
      sudo_enforced: true,
    });
    const rules = new AccountAuthorizations(f.store.db);
    rules.ensureDefault("device");
    f.store.db
      .prepare(
        "DELETE FROM account_authorizations WHERE device_id='device' AND account_id IS NULL",
      )
      .run();
    assert.equal((await create("normal")).status, 403);
    assert.equal(
      (await browser.wait("terminal.closed")).reason,
      "AUTHORIZATION_EXPIRED",
    );
  } finally {
    await f.close();
  }
});

test("legacy passwordless accounts stay stored but cannot open terminals regardless of Agent capabilities", async () => {
  const f = await fixture();
  try {
    const account = seedLegacyAccount(f.store, "device", {
      name: "Passwordless root",
      username: "root",
      method: "sudo",
    });
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
        f.admin,
      );
    f.agent.send("agent.heartbeat", {
      agent_version: "password-only",
      capabilities: [
        "terminal.pty.v1",
        "terminal.policy.v1",
        "terminal.sudo.v1",
      ],
    });
    await new Promise((r) => setTimeout(r, 30));
    assert.equal((await create()).body.error, "ACCOUNT_CONNECTION_REMOVED");
    f.agent.send("agent.heartbeat", {
      agent_version: "nopasswd",
      capabilities: [
        "terminal.pty.v1",
        "terminal.policy.v1",
        "terminal.sudo.v1",
        "terminal.sudo.nopasswd.v1",
      ],
    });
    await new Promise((r) => setTimeout(r, 30));
    assert.equal((await create()).body.error, "ACCOUNT_CONNECTION_REMOVED");
    assert.equal(
      f.store.db.prepare("SELECT COUNT(*) AS n FROM terminal_sessions").get()!
        .n,
      0,
    );
    assert.ok(!f.agent.messages.some((m) => m.type === "terminal.sudo.open"));
  } finally {
    await f.close();
  }
});

test("normal sudo delegation uses the existing role and switch, never reaches the browser, and closes on permission or credential changes", async () => {
  const f = await fixture();
  try {
    f.store.seedUser({
      username: "auto-sudo-ops",
      password: "terminal-test-password1",
      role: "ops",
      deviceScope: ["device"],
    });
    const ops = await f.login("auto-sudo-ops");
    const password = "public-auto-sudo-fixture9!";
    const config = await f.api(
      "PUT",
      "/api/v1/devices/device/connection",
      { v: 1, revision: 0, sudo_password: password },
      f.admin,
    );
    assert.equal(config.status, 200);
    const capabilities = [
      "terminal.pty.v1",
      "terminal.policy.v1",
      "terminal.sudo.v1",
      "terminal.config.v1",
      "terminal.sudo.command.v1",
    ];
    f.agent.send("agent.heartbeat", {
      agent_version: "sudo-commands",
      capabilities,
    });
    f.agent.send("agent.terminal.status", {
      revision: 0,
      enabled: true,
      request_revision: null,
      blocked: false,
      reason: null,
    });
    for (let n = 0; n < 100; n++) {
      if (
        (
          await f.api(
            "GET",
            "/api/v1/devices/device/terminal-privilege",
            undefined,
            f.admin,
          )
        ).body.enabled === true
      )
        break;
      await new Promise((r) => setTimeout(r, 10));
    }
    const plain = await f.create(ops);
    const plainBrowser = await f.attach(plain.body);
    const plainRequest = await f.agent.wait("terminal.open");
    assert.equal(
      plainRequest.sudo_auto_password,
      undefined,
      "ordinary role receives no credential",
    );
    f.agent.send("terminal.opened", { session_id: plainRequest.session_id });
    assert.equal(
      (await plainBrowser.wait("terminal.ready")).sudo_auto,
      undefined,
    );
    plainBrowser.ws.close();
    await f.agent.wait("terminal.close");
    f.agent.send("agent.heartbeat", {
      agent_version: "legacy-agent",
      capabilities: capabilities.filter(
        (c) => c !== "terminal.sudo.command.v1",
      ),
    });
    await new Promise((r) => setTimeout(r, 30));
    const legacy = await f.create();
    const legacyBrowser = await f.attach(legacy.body);
    const legacyRequest = await f.agent.wait("terminal.open");
    assert.equal(
      legacyRequest.sudo_auto_password,
      undefined,
      "old Agents never receive a new credential field",
    );
    f.agent.send("terminal.opened", { session_id: legacyRequest.session_id });
    await legacyBrowser.wait("terminal.ready");
    legacyBrowser.ws.close();
    await f.agent.wait("terminal.close");
    f.agent.send("agent.heartbeat", {
      agent_version: "sudo-commands",
      capabilities,
    });
    await new Promise((r) => setTimeout(r, 30));
    const permissions = JSON.parse(
      f.store.db
        .prepare("SELECT permissions FROM access_roles WHERE id='ops'")
        .get()!.permissions as string,
    );
    f.store.db
      .prepare("UPDATE access_roles SET permissions=? WHERE id='ops'")
      .run(JSON.stringify([...permissions, "terminal.sudo"]));
    const open = async (auth = f.admin) => {
      const created = await f.create(auth);
      assert.equal(created.status, 200);
      assert.equal(JSON.stringify(created).includes(password), false);
      const browser = await f.attach(created.body);
      const request = await f.agent.wait("terminal.open");
      assert.equal(request.sudo_auto_password, password);
      assert.equal(request.sudo_password, undefined);
      assertValid("terminal-envelope", {
        v: 1,
        type: "terminal.open",
        body: request,
      });
      f.agent.send("terminal.opened", { session_id: request.session_id });
      const ready = await browser.wait("terminal.ready");
      assert.equal(ready.sudo_auto, true);
      assert.equal(ready.elevated, undefined);
      assert.equal(JSON.stringify(ready).includes(password), false);
      return browser;
    };
    for (const [name, role] of [
      ["auto-sudo-ops", "ops"],
      ["admin", "admin"],
    ])
      f.store.db
        .prepare(
          "INSERT INTO device_sudo_rules(id,device_id,user_id,effect,origin,legacy_role_ids) VALUES(?,'device',(SELECT id FROM users WHERE username=?),'allow','legacy',?)",
        )
        .run(name, name, JSON.stringify([role]));
    const delegated = await open(ops);
    f.store.db
      .prepare("UPDATE access_roles SET permissions=? WHERE id='ops'")
      .run(JSON.stringify(permissions));
    assert.equal(
      (await delegated.wait("terminal.closed")).reason,
      "AUTHORIZATION_EXPIRED",
    );
    const credentialSession = await open();
    const updated = await f.api(
      "PUT",
      "/api/v1/devices/device/connection",
      {
        v: 1,
        revision: config.body.revision,
        sudo_password: "replacement-fixture9!",
      },
      f.admin,
    );
    assert.equal(
      updated.status,
      409,
      "live credentials cannot be overwritten through the UI",
    );
    const connection = f.store.db
      .prepare("SELECT * FROM device_connections WHERE device_id='device'")
      .get()!;
    f.store.db
      .prepare(
        "UPDATE device_connections SET secrets=? WHERE device_id='device'",
      )
      .run("invalid sealed credential");
    assert.equal(
      (await credentialSession.wait("terminal.closed")).reason,
      "AUTHORIZATION_EXPIRED",
    );
    f.store.db
      .prepare(
        "UPDATE device_connections SET secrets=? WHERE device_id='device'",
      )
      .run(connection.secrets);
    // A supported but disabled Agent must still receive an ordinary frame only.
    f.agent.send("agent.terminal.status", {
      revision: 0,
      enabled: false,
      request_revision: null,
      blocked: false,
      reason: null,
    });
    await new Promise((r) => setTimeout(r, 30));
    const disabled = await f.create();
    await f.attach(disabled.body);
    assert.equal(
      (await f.agent.wait("terminal.open")).sudo_auto_password,
      undefined,
    );
    for (const table of ["audit", "terminal_recordings"])
      assert.equal(
        JSON.stringify(
          f.store.db.prepare("SELECT * FROM " + table).all(),
        ).includes(password),
        false,
      );
  } finally {
    await f.close();
  }
});

test("web terminal privilege settings require admin, report real state, gate sudo and persist confirmed revisions", async () => {
  const f = await fixture();
  const path = "/api/v1/devices/device/terminal-privilege";
  const read = () => f.api("GET", path, undefined, f.admin);
  const save = (revision: number, enabled: boolean, auth = f.admin) =>
    f.api("PUT", path, { v: 1, revision, enabled }, auth);
  async function observed(expected: Record<string, unknown>) {
    for (let i = 0; i < 100; i++) {
      const result = await read();
      if (Object.entries(expected).every(([k, v]) => result.body[k] === v)) {
        assertValid("terminal-privilege-response", result.body);
        return result.body;
      }
      await new Promise((r) => setTimeout(r, 10));
    }
    assert.fail("Setting did not reach " + JSON.stringify(expected));
  }
  try {
    assert.equal((await read()).body.supported, false);
    assert.equal(
      (await save(0, true)).body.error,
      "TERMINAL_PRIVILEGE_NOT_SUPPORTED_UPDATE_AGENT",
    );
    f.store.seedUser({
      username: "privilege-ops",
      password: "terminal-test-password1",
      role: "ops",
      deviceScope: ["device"],
    });
    const ops = await f.login("privilege-ops");
    assert.equal((await f.api("GET", path, undefined, ops)).status, 403);
    assert.equal((await save(0, true, ops)).status, 403);
    f.agent.send("agent.heartbeat", {
      agent_version: "settings-agent",
      capabilities: [
        "terminal.pty.v1",
        "terminal.policy.v1",
        "terminal.sudo.v1",
        "terminal.sudo.nopasswd.v1",
        "terminal.config.v1",
      ],
    });
    f.agent.send("agent.terminal.status", {
      revision: 0,
      enabled: false,
      request_revision: null,
      blocked: false,
      reason: null,
    });
    await observed({ enabled: false, status: "applied", revision: 0 });
    const account = seedLegacyAccount(f.store, "device", {
      name: "Existing sudo account",
      username: "root",
      method: "sudo",
    });
    const openManaged = () =>
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
        f.admin,
      );
    assert.equal(
      (await openManaged()).body.error,
      "ACCOUNT_CONNECTION_REMOVED",
    );
    const originalAudit = f.store.audit.bind(f.store);
    f.store.audit = (...args: Parameters<Store["audit"]>) => {
      if (args[0] === "terminal.privilege_requested")
        throw new Error("audit unavailable");
      return originalAudit(...args);
    };
    try {
      assert.equal((await save(0, true)).status, 500);
      assert.equal((await read()).body.revision, 0);
      assert.equal(
        f.agent.messages.some(
          (message) => message.type === "agent.terminal.config",
        ),
        false,
        "failed audit cannot publish a setting",
      );
    } finally {
      f.store.audit = originalAudit;
    }
    assert.equal((await save(0, true)).body.status, "pending");
    assertValid("envelope", {
      v: 1,
      type: "agent.terminal.config",
      body: await f.agent.wait("agent.terminal.config"),
    });
    await observed({
      enabled: false,
      desired_enabled: true,
      status: "pending",
    });
    assert.equal(
      (await save(0, false)).body.error,
      "TERMINAL_PRIVILEGE_CHANGED_RELOAD",
    );
    f.agent.send("agent.terminal.status", {
      revision: 1,
      enabled: true,
      request_revision: 1,
      blocked: false,
      reason: null,
    });
    await observed({ enabled: true, status: "applied" });
    const opening = await f.create();
    assert.equal(opening.status, 200);
    assert.equal(
      (await save(1, false)).body.error,
      "CONNECTION_HAS_ACTIVE_SESSIONS",
    );
    await f.api(
      "POST",
      `/api/v1/terminal-sessions/${opening.body.session_id}/close`,
      { v: 1 },
      f.admin,
    );
    assert.equal((await save(1, false)).body.status, "pending");
    await f.agent.wait("agent.terminal.config");
    assert.equal(
      (await openManaged()).body.error,
      "ACCOUNT_CONNECTION_REMOVED",
      "retired accounts remain blocked regardless of the privilege switch",
    );
    f.agent.send("agent.terminal.status", {
      revision: 1,
      enabled: true,
      request_revision: 2,
      blocked: false,
      reason: "PERSIST_FAILED",
    });
    await observed({
      enabled: true,
      status: "failed",
      reason: "PERSIST_FAILED",
    });
    assert.equal((await save(2, false)).body.status, "pending");
    await f.agent.wait("agent.terminal.config");
    f.agent.send("agent.terminal.status", {
      revision: 3,
      enabled: false,
      request_revision: 3,
      blocked: false,
      reason: null,
    });
    await observed({ enabled: false, status: "applied", revision: 3 });
    f.agent.send("agent.terminal.status", {
      revision: 1,
      enabled: true,
      request_revision: 1,
      blocked: false,
      reason: null,
    });
    await new Promise((r) => setTimeout(r, 30));
    await observed({ enabled: false, revision: 3 });
    assertValid(
      "audit-response",
      (await f.api("GET", "/api/v1/audit", undefined, f.admin)).body,
    );
    // A freshly reconnected Agent may have restored an older journal. Reconcile
    // the actual report instead of showing a stale previously confirmed value.
    f.agent.send("agent.terminal.status", {
      revision: 0,
      enabled: true,
      request_revision: null,
      blocked: false,
      reason: null,
    });
    await observed({ enabled: true, status: "pending", revision: 3 });
    await f.agent.wait("agent.terminal.config");
    f.agent.send("agent.terminal.status", {
      revision: 3,
      enabled: false,
      request_revision: 3,
      blocked: false,
      reason: null,
    });
    await observed({ enabled: false, status: "applied" });
    f.agent.send("agent.terminal.status", {
      revision: 3,
      enabled: false,
      request_revision: null,
      blocked: true,
      reason: null,
    });
    await observed({ blocked: true });
    assert.equal(
      (await save(3, true)).body.error,
      "TERMINAL_PRIVILEGE_NO_NEW_PRIVS",
    );
    f.agent.ws.terminate();
    await observed({ online: false });
    assert.equal((await save(3, true)).body.error, "DEVICE_OFFLINE");
    const reopened = new Store(f.store.dataDir);
    assert.equal(
      reopened.db
        .prepare(
          "SELECT observed_enabled FROM agent_terminal_privilege WHERE device_id='device'",
        )
        .get()!.observed_enabled,
      0,
    );
    reopened.db.close();
  } finally {
    await f.close();
  }
});

test("device sudo rules control passwordless and manual sudo sessions and revoke active sessions and tickets without deleting recordings", async () => {
  const f = await fixture();
  try {
    const me = (await f.api("GET", "/api/v1/me", undefined, f.admin)).body;
    const policy = async (effect: string, revision: number) =>
      f.api(
        "POST",
        "/api/v1/access-authorizations/sudo",
        {
          v: 1,
          device_id: "device",
          subject_type: "user",
          subject_id: me.id,
          effect,
          revision,
        },
        f.admin,
      );
    const restricted = await f.create();
    const browser = await f.attach(restricted.body);
    let request = await f.agent.wait("terminal.open");
    assert.equal(request.allow_sudo, false);
    f.agent.send("terminal.opened", { session_id: request.session_id });
    assert.equal((await browser.wait("terminal.ready")).sudo_allowed, false);
    assert.equal((await policy("allow", 0)).status, 200);
    assert.equal(
      (await browser.wait("terminal.closed")).reason,
      "AUTHORIZATION_EXPIRED",
    );
    const permitted = await f.create();
    const pending = await f.create();
    const grantedBrowser = await f.attach(permitted.body);
    request = await f.agent.wait("terminal.open");
    assert.equal(request.allow_sudo, true);
    assert.equal(request.sudo_auto_password, undefined);
    f.agent.send("terminal.opened", { session_id: request.session_id });
    assert.equal(
      (await grantedBrowser.wait("terminal.ready")).sudo_allowed,
      true,
    );
    assert.equal((await policy("deny", 1)).status, 200);
    assert.equal(
      (await grantedBrowser.wait("terminal.closed")).reason,
      "AUTHORIZATION_EXPIRED",
    );
    const stale = await f.attach(pending.body);
    const [code] = await once(stale.ws, "close");
    assert.equal(code, 4003);
    assert.equal(
      (
        await f.api(
          "GET",
          `/api/v1/terminal-sessions/${permitted.body.session_id}/recording`,
          undefined,
          f.admin,
        )
      ).status,
      200,
    );
    f.agent.send("agent.heartbeat", {
      agent_version: "old",
      capabilities: ["terminal.pty.v1"],
    });
    await new Promise((r) => setTimeout(r, 30));
    assert.equal(
      (await f.create()).body.error,
      "TERMINAL_POLICY_NOT_SUPPORTED_UPDATE_AGENT",
    );
  } finally {
    await f.close();
  }
});

test("configurable terminal limits count pending tickets across logins, allow a fifth terminal and recover slots after close or failed audit", async () => {
  const f = await fixture();
  try {
    const read = () =>
      f.api("GET", "/api/v1/settings/connections", undefined, f.admin);
    const save = async (changes: any) => {
      const { updated_at, ...current } = (await read()).body;
      const r = await f.api(
        "PUT",
        "/api/v1/settings/connections",
        { ...current, ...changes },
        f.admin,
      );
      assert.equal(r.status, 200);
    };
    await save({ per_user: 6, per_device: 6, terminal_total: 8 });
    const auth2 = await f.login("admin");
    const opened = [];
    for (let n = 0; n < 6; n++) {
      const r = await f.create(n % 2 ? auth2 : f.admin);
      assert.equal(r.status, 200);
      opened.push(r.body);
    }
    assert.equal((await f.create()).body.error, "DEVICE_TERMINAL_LIMIT");
    const browser = await f.attach(opened[0]);
    const request = await f.agent.wait("terminal.open");
    assert.equal(request.max_sessions, 6);
    f.agent.send("terminal.opened", { session_id: request.session_id });
    await browser.wait("terminal.ready");
    await save({ per_device: 8 });
    assert.equal((await f.create()).body.error, "USER_CONNECTION_LIMIT");
    await save({ per_user: 1 });
    assert.equal(
      browser.ws.readyState,
      WebSocket.OPEN,
      "lowering limits preserves live sessions",
    );
    for (const row of opened)
      assert.equal(
        (
          await f.api(
            "POST",
            `/api/v1/terminal-sessions/${row.session_id}/close`,
            { v: 1 },
            f.admin,
          )
        ).status,
        200,
      );
    const audit = f.store.audit;
    f.store.audit = function (action, ...args) {
      if (action === "terminal.created") throw new Error("audit failed");
      return audit.call(this, action, ...args);
    };
    assert.equal((await f.create()).status, 500);
    f.store.audit = audit;
    assert.equal(
      (await f.create()).status,
      200,
      "failed audit releases the admission slot",
    );
  } finally {
    await f.close();
  }
});
