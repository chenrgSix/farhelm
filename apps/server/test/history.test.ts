import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { buildServer } from "../src/server.js";
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
  ) {
    const body = {
      task_id: id,
      device_id: device,
      actor_id: admin,
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
      admin,
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
    cleanup: async () => {
      await server.close();
      rmSync(root, { recursive: true, force: true });
    },
  };
}

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
