import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { buildServer } from "../src/server.js";
import { assertValid } from "../../../tests/contracts/validate.mjs";

test("task summary aggregates all visible tasks and enforces owner, scope and API-token permissions", async () => {
  const root = mkdtempSync(join(tmpdir(), "farhelm-task-summary-"));
  execFileSync(
    "bash",
    ["../../deploy/dev/generate-tls.sh", join(root, "tls")],
    { stdio: "ignore" },
  );
  const password = "summary-test-password1";
  const server = await buildServer({
    dataDir: join(root, "data"),
    tlsCert: join(root, "tls/server.crt"),
    tlsKey: join(root, "tls/server.key"),
    adminUsername: "admin",
    adminPassword: password,
  });
  try {
    const db = server.store.db;
    const admin = db
      .prepare("SELECT id FROM users WHERE username='admin'")
      .get()!.id;
    const ops = server.store.seedUser({
      username: "ops",
      password,
      role: "ops",
      deviceScope: ["visible"],
    });
    server.store.seedUser({
      username: "auditor",
      password,
      role: "auditor",
      deviceScope: ["visible"],
    });
    server.store.seedUser({
      username: "empty",
      password,
      role: "ops",
      deviceScope: [],
    });
    for (const id of ["visible", "outside"])
      db.prepare(
        "INSERT INTO devices(id,public_key,name,created_at) VALUES(?,?,?,0)",
      ).run(id, id, id);
    const insert = db.prepare(
      "INSERT INTO tasks(id,device_id,actor_id,task_json,payload_hash,status,created_at,updated_at) VALUES(?,?,?,'{}',?,?,?,0)",
    );
    server.store.transaction(() => {
      for (let i = 0; i < 600; i++)
        insert.run(
          `done-${i}`,
          "visible",
          admin,
          `hash-${i}`,
          "SUCCEEDED",
          i + 1000,
        );
      for (const [i, status] of [
        "QUEUED",
        "SENT",
        "ACCEPTED",
        "RUNNING",
        "UNKNOWN",
      ].entries())
        insert.run(`own-${i}`, "visible", ops.id, `own-${i}`, status, i);
      insert.run("other", "visible", admin, "other", "RUNNING", 6);
      insert.run("hidden", "outside", ops.id, "hidden", "UNKNOWN", 7);
    });
    async function login(username: string) {
      const r = await server.app.inject({
        method: "POST",
        url: "/api/v1/login",
        payload: { username, password },
      });
      assert.equal(r.statusCode, 200);
      return r.json().access_token;
    }
    async function summary(
      token: string,
      expected: { active: number; unknown: number },
    ) {
      const r = await server.app.inject({
        url: "/api/v1/tasks/summary",
        headers: { authorization: `Bearer ${token}` },
      });
      assert.equal(r.statusCode, 200, r.body);
      assertValid("task-summary-response", r.json());
      assert.deepEqual(r.json(), { v: 1, ...expected });
      assert.ok(r.body.length < 100, "summary must not contain task payloads");
    }
    const adminToken = await login("admin"),
      opsToken = await login("ops"),
      auditToken = await login("auditor"),
      emptyToken = await login("empty");
    await summary(adminToken, { active: 5, unknown: 2 });
    await summary(opsToken, { active: 4, unknown: 1 });
    await summary(auditToken, { active: 5, unknown: 1 });
    await summary(emptyToken, { active: 0, unknown: 0 });
    assert.equal(
      (await server.app.inject({ url: "/api/v1/tasks/summary" })).statusCode,
      401,
    );
    assert.equal(
      (
        await server.app.inject({
          url: "/api/v1/tasks/summary?device_id=outside",
          headers: { authorization: `Bearer ${opsToken}` },
        })
      ).statusCode,
      400,
    );
    async function token(permissions: string[]) {
      const r = await server.app.inject({
        method: "POST",
        url: "/api/v1/api-tokens",
        headers: { authorization: `Bearer ${adminToken}` },
        payload: {
          v: 1,
          name: "summary",
          permissions,
          device_scope: ["visible"],
          expires_at: Date.now() + 3600000,
        },
      });
      assert.equal(r.statusCode, 200, r.body);
      return r.json().secret;
    }
    await summary(await token(["tasks.read", "tasks.read_all"]), {
      active: 5,
      unknown: 1,
    });
    await summary(await token(["tasks.read"]), { active: 1, unknown: 0 });
    assert.equal(
      (
        await server.app.inject({
          url: "/api/v1/tasks/summary",
          headers: { authorization: `Bearer ${await token(["devices.read"])}` },
        })
      ).statusCode,
      403,
    );
    db.prepare("UPDATE users SET device_scope='[\"outside\"]' WHERE id=?").run(
      ops.id,
    );
    await summary(opsToken, { active: 0, unknown: 1 });
    db.prepare("UPDATE tasks SET status='SUCCEEDED' WHERE id='hidden'").run();
    await summary(opsToken, { active: 0, unknown: 0 });
  } finally {
    await server.close();
    rmSync(root, { recursive: true, force: true });
  }
});
