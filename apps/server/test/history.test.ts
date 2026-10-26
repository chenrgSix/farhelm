import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { buildServer } from "../src/server.js";
import { auditContext } from "../src/audit-context.js";
import { assertValid } from "../../../tests/contracts/validate.mjs";

async function fixture() {
  const root = mkdtempSync(join(tmpdir(), "farhelm-history-"));
  execFileSync(
    "bash",
    ["../../deploy/dev/generate-tls.sh", join(root, "tls")],
    { stdio: "ignore" },
  );
  const password = "history-test-password1";
  const server = await buildServer({
    dataDir: join(root, "data"),
    tlsCert: join(root, "tls/server.crt"),
    tlsKey: join(root, "tls/server.key"),
    adminUsername: "admin",
    adminPassword: password,
  });
  const db = server.store.db;
  const admin = (
    db.prepare("SELECT id FROM users WHERE username='admin'").get() as any
  ).id;
  const reader = server.store.seedUser({
    username: "reader",
    password,
    role: "auditor",
    deviceScope: ["visible"],
  });
  const empty = server.store.seedUser({
    username: "empty",
    password,
    role: "business",
    deviceScope: [],
  });
  for (const id of ["visible", "outside"])
    db.prepare(
      "INSERT INTO devices(id,public_key,name,created_at) VALUES(?,?,?,0)",
    ).run(id, id, id === "visible" ? "生产设备" : "其他设备");
  function task(
    id: string,
    at: number,
    device = "visible",
    argv = ["/bin/echo", "recent"],
    actor = admin,
  ) {
    const body = {
      task_id: id,
      device_id: device,
      actor_id: actor,
      action: "exec",
      argv,
      cwd: "/tmp",
      created_at: at,
      expires_at: at + 1000,
      timeout_ms: 1000,
      max_output_bytes: 1000,
      payload_hash: "a".repeat(64),
    };
    db.prepare(
      "INSERT INTO tasks(id,device_id,actor_id,task_json,payload_hash,status,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?)",
    ).run(
      id,
      device,
      actor,
      JSON.stringify(body),
      body.payload_hash,
      "SUCCEEDED",
      at,
      at,
    );
  }
  server.store.transaction(() => {
    for (let i = 0; i < 605; i++) {
      const id = String(i).padStart(4, "0");
      task(
        `task-${id}`,
        100000 + Math.floor(i / 3),
        i % 2 ? "outside" : "visible",
        ["/bin/echo", i === 0 ? "older-than-500 100%_literal" : "recent"],
      );
      db.prepare(
        "INSERT INTO terminal_sessions(id,device_id,actor_id,status,cols,rows,created_at,ended_at) VALUES(?,?,?,'CLOSED',80,24,?,?)",
      ).run(
        `session-${id}`,
        i < 3 ? "visible" : "outside",
        admin,
        100000 + i,
        101000 + i,
      );
    }
    for (let i = 0; i < 1105; i++)
      db.prepare(
        "INSERT INTO audit(at,actor_id,device_id,task_id,action,detail_json) VALUES(?,?,?,?,?,'{}')",
      ).run(
        200000 + i,
        admin,
        i % 2 ? "outside" : "visible",
        i === 0 ? "old-audit-task" : null,
        i === 0 ? "task.cancel_requested" : "device.revoked",
      );
    server.store.audit("task.cancel_requested", reader.id, "outside", null);
  });
  async function login(username: string) {
    const result = await server.app.inject({
      method: "POST",
      url: "/api/v1/login",
      payload: { username, password },
    });
    assert.equal(result.statusCode, 200);
    return result.json().access_token;
  }
  const adminToken = await login("admin"),
    readerToken = await login("reader"),
    emptyToken = await login("empty");
  async function get(path: string, token = adminToken) {
    const result = await server.app.inject({
      method: "GET",
      url: "/api/v1" + path,
      headers: { authorization: `Bearer ${token}` },
    });
    return { status: result.statusCode, body: result.json() };
  }
  return {
    ...server,
    db,
    task,
    get,
    reader,
    readerToken,
    emptyToken,
    adminToken,
    login,
    cleanup: async () => {
      await server.close();
      rmSync(root, { recursive: true, force: true });
    },
  };
}

test("single-device commands require <=7 days, enforce ownership/scope, literal fuzzy search and stable bounded pagination", async () => {
  const f = await fixture();
  try {
    const admin = (
      f.db.prepare("SELECT id FROM users WHERE username='admin'").get() as any
    ).id;
    for (let i = 0; i < 121; i++)
      f.db
        .prepare(
          "INSERT INTO terminal_commands(session_id,device_id,actor_id,started_at,command,recording_seq) VALUES('session-0000','visible',?,?,?,1)",
        )
        .run(
          admin,
          100000 + Math.floor(i / 3),
          i === 0 ? "docker ps 100%_literal" : "systemctl STATUS app",
        );
    const path = "/devices/visible/terminal-commands";
    for (const query of [
      "",
      "?from=0",
      "?to=604800000",
      "?from=0&to=604800001",
      "?from=10&to=10",
      "?from=20&to=10",
      "?from=NaN&to=10",
      "?from=0&to=604800000&limit=101",
    ])
      assert.equal((await f.get(path + query)).status, 400, query);
    const base = path + "?from=0&to=604800000";
    let result = await f.get(base, f.readerToken);
    assert.equal(result.status, 200);
    assertValid("terminal-commands-response", result.body);
    assert.equal(result.body.commands.length, 50);
    const cursor = result.body.page.next_cursor;
    const ids: number[] = [];
    while (true) {
      ids.push(...result.body.commands.map((r: any) => r.id));
      if (!result.body.page.has_more) break;
      result = await f.get(
        base + "&cursor=" + result.body.page.next_cursor,
        f.readerToken,
      );
      assert.equal(result.status, 200);
    }
    assert.equal(ids.length, 121);
    assert.equal(new Set(ids).size, 121);
    assert.equal(
      (await f.get(base + "&q=" + encodeURIComponent("100%_"))).body.commands
        .length,
      1,
    );
    assert.equal(
      (await f.get(base + "&q=SyStEmCtL&limit=100")).body.commands.length,
      100,
    );
    assert.equal((await f.get(base + "&actor=admi")).body.commands.length, 50);
    assert.equal((await f.get(base + "&actor=reader")).body.commands.length, 0);
    assert.equal(
      (await f.get(base + "&q=changed&cursor=" + cursor, f.readerToken)).status,
      400,
    );
    assert.equal((await f.get(base, f.emptyToken)).status, 403);
    assert.equal(
      (
        await f.get(
          "/devices/outside/terminal-commands?from=0&to=604800000",
          f.readerToken,
        )
      ).status,
      403,
    );
    const own = f.store.seedUser({
      username: "own-commands",
      password: "history-test-password1",
      role: "ops",
      deviceScope: ["visible"],
    });
    const ownToken = await f.login("own-commands");
    assert.equal((await f.get(base, ownToken)).body.commands.length, 0);
    f.db
      .prepare(
        "INSERT INTO terminal_sessions(id,device_id,actor_id,status,cols,rows,created_at) VALUES('own-session','visible',?,'OPEN',80,24,100000)",
      )
      .run(own.id);
    f.db
      .prepare(
        "INSERT INTO terminal_commands(session_id,device_id,actor_id,started_at,command,recording_seq) VALUES('own-session','visible',?,100000,'pwd',1)",
      )
      .run(own.id);
    assert.equal((await f.get(base, ownToken)).body.commands.length, 1);
    assert.equal(
      (await f.get("/terminal-sessions/session-0000", ownToken)).status,
      403,
    );
    assert.equal(
      (await f.get("/terminal-sessions/own-session", ownToken)).status,
      200,
    );
    assert.equal(
      (await f.get("/terminal-sessions/session-0000", f.readerToken)).status,
      200,
    );
    assert.equal(
      (await f.get(path + "?from=200000&to=200001")).body.commands.length,
      0,
    );
  } finally {
    await f.cleanup();
  }
});

test("task cursors traverse beyond 500 records with stable ties and concurrent inserts", async () => {
  const f = await fixture();
  try {
    const expected = (
      f.db
        .prepare("SELECT id FROM tasks ORDER BY created_at DESC,id DESC")
        .all() as any[]
    ).map((r) => r.id);
    assert.equal((await f.get("/tasks")).body.tasks.length, 500);
    let result = await f.get("/tasks?limit=100");
    const ids: string[] = [];
    let first = true;
    while (true) {
      assert.equal(result.status, 200);
      assertValid("tasks-response", result.body);
      ids.push(...result.body.tasks.map((task: any) => task.task_id));
      if (first) {
        f.task("new-task", 999999);
        first = false;
      }
      if (!result.body.page.has_more) break;
      result = await f.get(
        `/tasks?limit=100&cursor=${encodeURIComponent(result.body.page.next_cursor)}`,
      );
    }
    assert.deepEqual(ids, expected);
    assert.equal(new Set(ids).size, 605);
    const old = await f.get(
      "/tasks?limit=50&q=older-than-500&device_id=visible&actor_id=admin&status=SUCCEEDED&from=100000&to=100000",
    );
    assert.equal(old.status, 200);
    assert.deepEqual(
      old.body.tasks.map((r: any) => r.task_id),
      ["task-0000"],
    );
    assert.equal(old.body.page.next_cursor, null);
    assert.equal(
      (await f.get("/tasks?limit=50&q=100%25_literal")).body.tasks.length,
      1,
    );
  } finally {
    await f.cleanup();
  }
});

test("audit and session queries filter before pagination and preserve authorization", async () => {
  const f = await fixture();
  try {
    const old = await f.get(
      "/audit?limit=50&q=old-audit-task&action=task.cancel_requested&from=200000&to=200000",
    );
    assert.equal(old.status, 200);
    assertValid("audit-response", old.body);
    assert.equal(old.body.audit.length, 1);
    assert.equal(old.body.audit[0].action, "task.cancel_requested");
    for (const [path, field] of [
      ["tasks", "tasks"],
      ["terminal-sessions", "sessions"],
      ["audit", "audit"],
    ]) {
      const result = await f.get(
        `/${path}?limit=100&device_id=outside&actor_id=admin`,
        f.readerToken,
      );
      assert.equal(result.status, 200);
      assert.equal(result.body[field].length, 0, path);
    }
    const sessions = await f.get("/terminal-sessions", f.readerToken);
    assert.equal(
      sessions.body.sessions.length,
      3,
      "Visible sessions must not be excluded by newer out-of-scope rows",
    );
    const audit = await f.get(
      "/audit?limit=100&action=task.cancel_requested&actor_id=reader&device_id=outside",
      f.readerToken,
    );
    assert.equal(
      audit.body.audit.length,
      1,
      "Users retain access to their own audit events",
    );
    assert.equal(
      (await f.get("/tasks?limit=50", f.emptyToken)).body.tasks.length,
      0,
    );
    assert.equal(
      (await f.get("/terminal-sessions?limit=50", f.emptyToken)).body.sessions
        .length,
      0,
    );
    const first = await f.get(
      "/terminal-sessions?limit=2&status=CLOSED",
      f.readerToken,
    );
    const next = await f.get(
      `/terminal-sessions?limit=2&status=CLOSED&cursor=${first.body.page.next_cursor}`,
      f.readerToken,
    );
    assert.equal(next.body.sessions.length, 1);
    assert.equal(next.body.page.has_more, false);
  } finally {
    await f.cleanup();
  }
});

test("history rejects malformed filters and cursors from other queries or users", async () => {
  const f = await fixture();
  try {
    for (const path of [
      "/tasks?limit=0",
      "/tasks?limit=101",
      "/tasks?limit=1.5",
      "/tasks?from=-1",
      "/tasks?from=20&to=10",
      "/tasks?status=HACK",
      "/audit?status=OPEN",
      "/tasks?action=exec",
      "/tasks?cursor=not-json",
      "/tasks?cursor=!!!!",
      "/tasks?unknown=1",
      "/tasks?limit=1&limit=2",
    ]) {
      const result = await f.get(path);
      assert.equal(
        result.status,
        400,
        `${path}: ${JSON.stringify(result.body)}`,
      );
    }
    const first = await f.get("/tasks?limit=2");
    const cursor = first.body.page.next_cursor;
    for (const [path, token] of [
      [`/tasks?limit=2&status=SUCCEEDED&cursor=${cursor}`, undefined],
      [`/tasks?limit=2&cursor=${cursor}`, f.readerToken],
      [`/audit?limit=2&cursor=${cursor}`, undefined],
    ] as const)
      assert.equal((await f.get(path, token)).status, 400);
    assert.equal(
      (await f.get("/tasks?limit=50&q=%27%20OR%201%3D1--")).body.tasks.length,
      0,
    );
  } finally {
    await f.cleanup();
  }
});

test("ordinary users only read their own tasks and audit; read-all grants remain scoped and do not permit cancellation", async () => {
  const f = await fixture();
  try {
    const owner = f.store.seedUser({
      username: "owner",
      password: "history-test-password1",
      role: "ops",
      deviceScope: ["visible"],
    });
    const auth = await f.login("owner");
    f.task("own-older", 10, "visible", ["echo", "own-only"], owner.id);
    f.task("own-newer", 11, "visible", ["echo", "own-only"], owner.id);
    f.task("own-outside", 12, "outside", ["echo", "hidden"], owner.id);
    f.store.audit("user.login", owner.id, null, null);
    f.store.audit("task.cancel_requested", owner.id, "outside", "own-outside");
    const first = await f.get("/tasks?limit=1", auth);
    assert.equal(first.body.tasks[0].task_id, "own-newer");
    const next = await f.get(
      "/tasks?limit=1&cursor=" + first.body.page.next_cursor,
      auth,
    );
    assert.equal(next.body.tasks[0].task_id, "own-older");
    assert.equal(next.body.page.has_more, false);
    for (const query of ["?actor_id=admin", "?q=recent"])
      assert.deepEqual((await f.get("/tasks" + query, auth)).body.tasks, []);
    assert.equal((await f.get("/tasks/task-0000", auth)).status, 403);
    assert.equal(
      (await f.get("/tasks/task-0000/output/stdout", auth)).status,
      403,
    );
    assert.equal((await f.get("/tasks/own-older", auth)).status, 200);
    assert.equal(
      (await f.get("/tasks/own-older/output/stdout", auth)).status,
      404,
    );
    assert.equal((await f.get("/tasks/own-outside", auth)).status, 403);
    const audit = await f.get("/audit?limit=100", auth);
    assert.ok(audit.body.audit.length > 0);
    assert.ok(audit.body.audit.every((r: any) => r.actor_id === owner.id));
    assert.ok(audit.body.audit.some((r: any) => r.device_id === "outside"));
    assert.deepEqual(
      (await f.get("/audit?actor_id=admin", auth)).body.audit,
      [],
    );
    // A role may audit other users' tasks without acquiring permission to cancel them.
    const permissions = [
      "devices.read",
      "tasks.read",
      "tasks.execute",
      "tasks.read_all",
      "audit.read",
      "audit.read_all",
    ];
    f.db
      .prepare("UPDATE access_roles SET permissions=? WHERE id='ops'")
      .run(JSON.stringify(permissions));
    assert.equal((await f.get("/tasks/task-0000", auth)).status, 200);
    assert.equal((await f.get("/tasks/task-0001", auth)).status, 403);
    assert.equal(
      (await f.get("/tasks/task-0000/output/stdout", auth)).status,
      404,
    );
    const cancel = await f.app.inject({
      method: "POST",
      url: "/api/v1/tasks/task-0000/cancel",
      headers: { authorization: "Bearer " + auth },
      payload: { v: 1 },
    });
    assert.equal(cancel.statusCode, 403);
    assert.equal(cancel.json().error, "TASK_OWNER_REQUIRED");
    assert.ok(
      (await f.get("/audit?actor_id=admin", auth)).body.audit.length > 0,
    );
    assert.deepEqual(
      (await f.get("/audit?action=user.login&actor_id=admin", auth)).body.audit,
      [],
    );
    // Device-global auditing explicitly includes platform-level events.
    f.db
      .prepare("UPDATE users SET device_scope='\"*\"' WHERE id=?")
      .run(owner.id);
    assert.ok(
      (await f.get("/audit?action=user.login&actor_id=admin", auth)).body.audit
        .length > 0,
    );
    const broad = await f.get("/tasks?limit=1", auth);
    const broadAudit = await f.get("/audit?limit=1", auth);
    f.db
      .prepare("UPDATE access_roles SET permissions=? WHERE id='ops'")
      .run(JSON.stringify(permissions.filter((p) => !p.endsWith(".read_all"))));
    assert.equal(
      (
        await f.get(
          "/tasks?limit=1&cursor=" + broad.body.page.next_cursor,
          auth,
        )
      ).status,
      400,
    );
    assert.equal(
      (
        await f.get(
          "/audit?limit=1&cursor=" + broadAudit.body.page.next_cursor,
          auth,
        )
      ).status,
      400,
    );
    assert.equal((await f.get("/tasks/task-0000", auth)).status, 403);
  } finally {
    await f.cleanup();
  }
});

test("audit displays recorded identities, retains legacy evidence and captures bounded request context without secrets", async () => {
  const f = await fixture();
  try {
    const login = await f.app.inject({
      method: "POST",
      url: "/api/v1/login?password=DO_NOT_LOG_QUERY",
      remoteAddress: "203.0.113.8",
      headers: {
        "user-agent": "Audit test browser",
        "x-forwarded-for": "198.51.100.9",
      },
      payload: { username: "admin", password: "history-test-password1" },
    });
    assert.equal(login.statusCode, 200);
    const logged = (await f.get("/audit?action=user.login&actor_id=admin")).body
      .audit[0];
    assert.equal(logged.actor_username, "admin");
    assert.equal(logged.context.source, "http");
    assert.equal(logged.context.remote_address, "203.0.113.8");
    assert.equal(logged.context.route, "/api/v1/login");
    assert.equal(logged.context.method, "POST");
    assert.equal(logged.context.user_agent, "Audit test browser");
    assert.ok(logged.context.request_id);
    assert.ok(!JSON.stringify(logged).includes("history-test-password1"));
    assert.ok(!JSON.stringify(logged).includes("DO_NOT_LOG_QUERY"));
    assert.ok(!JSON.stringify(logged).includes(login.json().access_token));
    await Promise.all(
      ["admin", "reader"].map((username, index) =>
        f.app.inject({
          method: "POST",
          url: "/api/v1/login",
          remoteAddress: `203.0.113.${20 + index}`,
          headers: { "user-agent": `parallel-${username}` },
          payload: { username, password: "history-test-password1" },
        }),
      ),
    );
    for (const [index, username] of ["admin", "reader"].entries()) {
      const entry = (
        await f.get("/audit?action=user.login&actor_id=" + username)
      ).body.audit[0];
      assert.equal(entry.context.remote_address, `203.0.113.${20 + index}`);
      assert.equal(entry.context.user_agent, `parallel-${username}`);
    }
    const created = await f.app.inject({
      method: "POST",
      url: "/api/v1/roles",
      headers: { authorization: "Bearer " + f.adminToken },
      payload: {
        v: 1,
        name: "审计角色名称",
        description: "可核对的修改",
        permissions: ["devices.read"],
      },
    });
    assert.equal(created.statusCode, 200);
    const event = (await f.get("/audit?action=access.role_created")).body
      .audit[0];
    assert.equal(event.target_name, "审计角色名称");
    assert.equal(event.detail.changes.description, "可核对的修改");
    const adminId = logged.actor_id;
    auditContext.run({ source: "http", user_agent: undefined }, () =>
      f.store.audit("user.login", adminId, null, null),
    );
    const noAgent = (await f.get("/audit?action=user.login")).body.audit[0];
    assert.deepEqual(noAgent.context, { source: "http" });
    f.store.audit("device.revoked", adminId, "visible", null);
    const recorded = f.db
      .prepare("SELECT * FROM audit ORDER BY id DESC LIMIT 1")
      .get() as any;
    f.db
      .prepare(
        "INSERT INTO audit(at,actor_id,device_id,task_id,action,detail_json) VALUES(1,?,'visible',NULL,'device.revoked','{}')",
      )
      .run(adminId);
    const legacyId = f.db.prepare("SELECT max(id) id FROM audit").get()!.id;
    f.db
      .prepare("UPDATE users SET username='renamed-admin' WHERE id=?")
      .run(adminId);
    f.db
      .prepare("UPDATE devices SET name='新设备名称' WHERE id='visible'")
      .run();
    const response = await f.get("/audit?action=device.revoked&limit=100");
    assertValid("audit-response", response.body);
    const snapshot = response.body.audit.find((a: any) => a.id === recorded.id);
    const legacy = response.body.audit.find((a: any) => a.id === legacyId);
    assert.equal(snapshot.actor_username, "admin");
    assert.equal(snapshot.device_name, "生产设备");
    assert.equal(legacy.actor_username, "renamed-admin");
    assert.equal(legacy.device_name, "新设备名称");
    assert.equal(legacy.context, null);
    assert.deepEqual(
      f.db.prepare("SELECT * FROM audit WHERE id=?").get(recorded.id),
      recorded,
    );
    assert.ok(
      (await f.get("/audit?actor_id=admin")).body.audit.some(
        (a: any) => a.id === recorded.id,
      ),
    );
    const task = (await f.get("/tasks/task-0000")).body;
    assert.equal(task.actor_username, "renamed-admin");
    assert.equal(task.actor_id, adminId);
    assertValid(
      "task-detail",
      Object.fromEntries(Object.entries(task).filter(([k]) => k !== "v")),
    );
  } finally {
    await f.cleanup();
  }
});
