import { after, test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { execFile, execFileSync } from "node:child_process";
import { promisify } from "node:util";
import { once } from "node:events";
import { createServer } from "node:http";
import { gunzipSync } from "node:zlib";
import { WebSocket } from "ws";
import { buildServer } from "../src/server.js";
import { hash, token } from "../src/util.js";
import { assertValid } from "../../../tests/contracts/validate.mjs";

const run = promisify(execFile);
const root = mkdtempSync(join(tmpdir(), "farhelm-api-token-test-"));
execFileSync("bash", ["../../deploy/dev/generate-tls.sh", join(root, "tls")], {
  stdio: "ignore",
});
after(() => rmSync(root, { recursive: true, force: true }));
const ca = readFileSync(join(root, "tls/ca.crt"));
const password = "token-test-password1";
async function fixture() {
  const config = {
    dataDir: mkdtempSync(join(root, "data-")),
    tlsCert: join(root, "tls/server.crt"),
    tlsKey: join(root, "tls/server.key"),
    adminUsername: "admin",
    adminPassword: password,
  };
  let s = await buildServer(config);
  let admin = "";
  async function api(
    method: string,
    path: string,
    body?: any,
    auth = admin,
    key?: string,
  ) {
    const response = await s.app.inject({
      method: method as any,
      url: "/api/v1" + path,
      payload: body,
      headers: {
        ...(auth ? { authorization: "Bearer " + auth } : {}),
        ...(key ? { "idempotency-key": key } : {}),
      },
    });
    return {
      status: response.statusCode,
      body: response.headers["content-type"]?.includes("application/json")
        ? response.json()
        : response.rawPayload,
    };
  }
  const login = async (username: string) =>
    (await api("POST", "/login", { username, password }, "")).body.access_token;
  admin = await login("admin");
  const owner = (await api("GET", "/me")).body;
  for (const id of ["one", "two"])
    s.store.db
      .prepare(
        "INSERT INTO devices(id,public_key,name,created_at) VALUES(?,?,?,?)",
      )
      .run(id, id, "Linux-" + id, Date.now());
  const input = (extra: any = {}) => ({
    v: 1,
    name: "巡检",
    permissions: ["devices.read"],
    device_scope: ["one"],
    expires_at: Date.now() + 3600000,
    ...extra,
  });
  async function create(extra: any = {}) {
    const r = await api("POST", "/api-tokens", input(extra));
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assertValid("api-token-response", r.body);
    return r.body as { secret: string; token: any };
  }
  return {
    get store() {
      return s.store;
    },
    get app() {
      return s.app;
    },
    config,
    admin,
    owner,
    api,
    login,
    input,
    create,
    close: () => s.close(),
    restart: async () => {
      await s.close();
      s = await buildServer(config);
    },
  };
}
const command = (device = "one") => ({
  v: 1,
  device_id: device,
  argv: ["/usr/bin/printf", "token-test"],
  cwd: "/tmp",
  timeout_ms: 30000,
  max_output_bytes: 4096,
  ttl_seconds: 300,
});

test("API tokens: admin management, secret hashing, persistence, expiry, revocation and strict validation", async () => {
  const f = await fixture();
  try {
    f.store.seedUser({
      username: "ops",
      password,
      role: "ops",
      deviceScope: "*",
    });
    const ops = await f.login("ops");
    assert.equal(
      (await f.api("GET", "/api-tokens", undefined, "")).status,
      401,
    );
    assert.equal(
      (await f.api("GET", "/api-tokens", undefined, ops)).status,
      403,
    );
    assert.equal(
      (await f.api("POST", "/api-tokens", f.input(), ops)).status,
      403,
    );
    for (const bad of [
      { permissions: ["admin"] },
      { permissions: [] },
      { permissions: ["devices.read", "devices.read"] },
      { permissions: ["tasks.read_all"] },
      { device_scope: ["missing"] },
      { device_scope: ["one", "one"] },
      { expires_at: null },
      { expires_at: Date.now() - 1 },
      { expires_at: Date.now() + 367 * 86400000 },
      { owner_id: "other" },
    ])
      assert.equal(
        (await f.api("POST", "/api-tokens", f.input(bad))).status,
        400,
      );
    const grant = await f.create();
    const stored = f.store.db
      .prepare("SELECT * FROM api_tokens WHERE id=?")
      .get(grant.token.id) as any;
    assert.equal(stored.token_hash, hash(grant.secret));
    assert.equal(JSON.stringify(stored).includes(grant.secret), false);
    const listed = await f.api("GET", "/api-tokens");
    assertValid("api-tokens-response", listed.body);
    assert.equal(JSON.stringify(listed.body).includes("token_hash"), false);
    assert.equal(JSON.stringify(listed.body).includes(grant.secret), false);
    assert.deepEqual(
      (
        await f.api("GET", "/devices", undefined, grant.secret)
      ).body.devices.map((d: any) => d.id),
      ["one"],
    );
    const me = await f.api("GET", "/me", undefined, grant.secret);
    assertValid("me-response", me.body);
    assert.equal(me.body.id, f.owner.id);
    assert.equal(me.body.api_token_id, grant.token.id);
    assert.notEqual(me.body.role, "admin");
    await f.restart();
    assert.equal(
      (await f.api("GET", "/devices", undefined, grant.secret)).status,
      200,
    );
    assert.equal(
      (
        await f.api(
          "POST",
          `/api-tokens/${grant.token.id}/revoke`,
          { v: 1 },
          ops,
        )
      ).status,
      403,
    );
    assert.equal(
      (await f.api("POST", `/api-tokens/${grant.token.id}/revoke`, { v: 1 }))
        .status,
      200,
    );
    assert.equal(
      (await f.api("POST", `/api-tokens/${grant.token.id}/revoke`, { v: 1 }))
        .status,
      200,
    );
    assert.equal(
      (await f.api("GET", "/devices", undefined, grant.secret)).status,
      401,
    );
    assert.equal(
      (
        await f.api(
          "PUT",
          `/api-tokens/${grant.token.id}`,
          f.input({ revision: 1 }),
        )
      ).status,
      409,
    );
    const expired = await f.create();
    f.store.db
      .prepare("UPDATE api_tokens SET expires_at=0 WHERE id=?")
      .run(expired.token.id);
    assert.equal(
      (await f.api("GET", "/me", undefined, expired.secret)).status,
      401,
    );
    const audit = (await f.api("GET", "/audit")).body;
    assertValid("audit-response", audit);
    assert.equal(JSON.stringify(audit).includes(grant.secret), false);
    assert.ok(
      audit.audit.some(
        (a: any) =>
          a.action === "api_token.request" &&
          a.detail.status_code === 401 &&
          a.context.api_token_id === grant.token.id,
      ),
    );
  } finally {
    await f.close();
  }
});

test("API tokens: scopes, read-only permissions, shared task audit and no admin/session credential escalation", async () => {
  const f = await fixture();
  try {
    const readonly = await f.create();
    for (const path of [
      "/access",
      "/api-tokens",
      "/settings",
      "/devices/two/network",
      "/devices/two/health-checks",
      "/devices/two/network-route",
      "/devices/two/network-probes",
    ])
      assert.equal(
        (await f.api("GET", path, undefined, readonly.secret)).status,
        403,
        path,
      );
    for (const [path, body] of [
      ["/api-tokens", f.input()],
      ["/login", { username: "admin", password }],
      ["/logout", { v: 1 }],
      [
        "/me/password",
        { v: 1, current_password: password, new_password: "changed1234" },
      ],
      ["/enrollment-tokens", { v: 1 }],
      ["/commands", command()],
      ["/terminal-sessions", { v: 1, device_id: "one", cols: 80, rows: 24 }],
      ["/terminal-sessions/fake/close", { v: 1 }],
    ] as const)
      assert.equal(
        (await f.api("POST", path, body, readonly.secret, "read-denied"))
          .status,
        403,
        path,
      );
    const permissions = [
      "devices.read",
      "tasks.execute",
      "tasks.read",
      "audit.read",
      "health.manage",
      "network.manage",
    ];
    const grant = await f.create({ permissions });
    const created = await f.api(
      "POST",
      "/commands",
      command(),
      grant.secret,
      "once",
    );
    assert.equal(created.status, 200);
    assertValid("command-response", created.body);
    assert.equal(
      (await f.api("POST", "/commands", command(), grant.secret, "once")).body
        .task_id,
      created.body.task_id,
    );
    assert.equal(
      (await f.api("POST", "/commands", command("two"), grant.secret, "other"))
        .status,
      403,
    );
    assert.equal(
      (
        await f.api(
          "PUT",
          "/devices/one/health-checks",
          { v: 1, revision: 0, checks: [] },
          grant.secret,
        )
      ).status,
      200,
    );
    assert.equal(
      (
        await f.api(
          "PUT",
          "/devices/two/health-checks",
          { v: 1, revision: 0, checks: [] },
          grant.secret,
        )
      ).status,
      403,
    );
    const outside = await f.api(
      "POST",
      "/commands",
      command("two"),
      f.admin,
      "outside",
    );
    assert.equal(
      (
        await f.api(
          "GET",
          "/tasks/" + outside.body.task_id,
          undefined,
          grant.secret,
        )
      ).status,
      403,
    );
    assert.equal(
      (
        await f.api(
          "GET",
          "/tasks/" + outside.body.task_id + "/output/stdout",
          undefined,
          grant.secret,
        )
      ).status,
      403,
    );
    const other = f.store.seedUser({
      username: "other",
      password,
      role: "ops",
      deviceScope: "*",
    });
    const otherTask = await f.api(
      "POST",
      "/commands",
      command(),
      await f.login(other.username),
      "other-task",
    );
    assert.equal(
      (
        await f.api(
          "GET",
          "/tasks/" + otherTask.body.task_id,
          undefined,
          grant.secret,
        )
      ).status,
      403,
    );
    assert.deepEqual(
      (
        await f.api("GET", "/tasks?limit=1", undefined, grant.secret)
      ).body.tasks.map((t: any) => t.task_id),
      [created.body.task_id],
    );
    const history = (await f.api("GET", "/audit", undefined, grant.secret)).body
      .audit;
    assert.ok(history.length);
    assert.ok(
      history.every(
        (a: any) => a.device_id === "one" && a.actor_id === f.owner.id,
      ),
    );
    const entry = history.find((a: any) => a.action === "task.created");
    assert.equal(entry.context.source, "api");
    assert.equal(entry.context.api_token_id, grant.token.id);
    assert.equal(entry.actor_username, "admin");
    const updated = await f.api(
      "PUT",
      "/api-tokens/" + grant.token.id,
      f.input({
        permissions: [...permissions, "tasks.read_all", "audit.read_all"],
        revision: 0,
      }),
    );
    assert.equal(updated.status, 200);
    assert.equal(
      (
        await f.api(
          "GET",
          "/tasks/" + otherTask.body.task_id,
          undefined,
          grant.secret,
        )
      ).status,
      200,
    );
    assert.equal(
      (
        await f.api(
          "POST",
          "/tasks/" + otherTask.body.task_id + "/cancel",
          { v: 1 },
          grant.secret,
        )
      ).status,
      403,
    );
    assert.equal(
      (
        await f.api(
          "PUT",
          "/api-tokens/" + grant.token.id,
          f.input({ revision: 0 }),
        )
      ).status,
      409,
    );
    assert.equal(
      (
        await f.api(
          "PUT",
          "/api-tokens/" + grant.token.id,
          f.input({ device_scope: [], revision: 1 }),
        )
      ).status,
      200,
    );
    assert.deepEqual(
      (await f.api("GET", "/devices", undefined, grant.secret)).body.devices,
      [],
    );
    assertValid("audit-response", (await f.api("GET", "/audit")).body);
  } finally {
    await f.close();
  }
});

test("API tokens: owner roles, groups, device grants, disabled accounts and forced password changes are checked live", async () => {
  const f = await fixture();
  try {
    const grant = await f.create({
      permissions: ["devices.read", "tasks.execute"],
      device_scope: "*",
    });
    const db = f.store.db;
    db.prepare("DELETE FROM user_roles WHERE user_id=?").run(f.owner.id);
    db.prepare(
      "INSERT INTO user_roles(user_id,role_id) VALUES(?,'business')",
    ).run(f.owner.id);
    db.prepare("UPDATE users SET device_scope='[\"two\"]' WHERE id=?").run(
      f.owner.id,
    );
    assert.deepEqual(
      (
        await f.api("GET", "/devices", undefined, grant.secret)
      ).body.devices.map((d: any) => d.id),
      ["two"],
    );
    assert.equal(
      (await f.api("POST", "/commands", command("two"), grant.secret, "denied"))
        .status,
      403,
    );
    db.prepare(
      "INSERT INTO access_groups(id,name,description,device_scope,created_at,updated_at) VALUES('group','group','','[\"one\"]',1,1)",
    ).run();
    db.prepare(
      "INSERT INTO group_members(group_id,user_id) VALUES('group',?)",
    ).run(f.owner.id);
    db.prepare(
      "INSERT INTO access_roles(id,name,description,permissions,builtin,created_at,updated_at) VALUES('operator','运维','','[\"devices.read\",\"tasks.read\",\"tasks.execute\"]',0,1,1)",
    ).run();
    db.prepare(
      "INSERT INTO group_roles(group_id,role_id) VALUES('group','operator')",
    ).run();
    assert.equal(
      (await f.api("POST", "/commands", command(), grant.secret, "allowed"))
        .status,
      200,
    );
    db.prepare("DELETE FROM group_members WHERE user_id=?").run(f.owner.id);
    assert.equal(
      (
        await f.api(
          "POST",
          "/commands",
          command(),
          grant.secret,
          "denied-again",
        )
      ).status,
      403,
    );
    db.prepare("UPDATE users SET enabled=0 WHERE id=?").run(f.owner.id);
    assert.equal(
      (await f.api("GET", "/me", undefined, grant.secret)).status,
      401,
    );
    db.prepare(
      "UPDATE users SET enabled=1,must_change_password=1 WHERE id=?",
    ).run(f.owner.id);
    assert.equal(
      (await f.api("GET", "/me", undefined, grant.secret)).status,
      401,
    );
    db.prepare("UPDATE users SET must_change_password=0 WHERE id=?").run(
      f.owner.id,
    );
    assert.equal(
      (await f.api("GET", "/me", undefined, grant.secret)).status,
      200,
    );
  } finally {
    await f.close();
  }
});

test("API tokens: API document resolves references, Skill archive and actual Python client work over trusted HTTPS", async () => {
  const f = await fixture();
  try {
    const grant = await f.create({
      permissions: ["devices.read", "tasks.execute", "tasks.read"],
    });
    const spec = await f.api("GET", "/openapi.json", undefined, grant.secret);
    assert.equal(spec.status, 200, JSON.stringify(spec.body));
    assert.equal(spec.body.openapi, "3.1.0");
    assert.deepEqual(
      spec.body.components.schemas["terminal-create"].properties.connection_mode
        .enum,
      ["normal"],
    );
    assert.equal(
      spec.body.components.schemas["terminal-create"].properties.connection_mode
        .deprecated,
      true,
    );
    assert.equal(
      spec.body.components.schemas["terminal-create"].properties.account_id,
      undefined,
    );
    assert.equal(
      spec.body.components.schemas["terminal-create"].additionalProperties,
      false,
    );
    function refs(value: any) {
      if (!value || typeof value !== "object") return;
      if (value.$ref) {
        assert.ok(value.$ref.startsWith("#/"), value.$ref);
        let target = spec.body;
        for (const part of value.$ref.slice(2).split("/"))
          target = target?.[part];
        assert.ok(target, value.$ref);
      }
      for (const child of Object.values(value)) refs(child);
    }
    refs(spec.body);
    const archive = await f.api("GET", "/api-skill");
    assert.equal(archive.status, 200);
    const tar = gunzipSync(archive.body);
    assert.ok(tar.includes(Buffer.from("farhelm-api/scripts/farhelm.py")));
    const archivePath = join(root, "skill.tar.gz");
    writeFileSync(archivePath, archive.body);
    assert.equal(
      execFileSync("tar", ["-tzf", archivePath], { encoding: "utf8" })
        .trim()
        .split("\n").length,
      3,
    );
    await f.app.listen({ host: "127.0.0.1", port: 0 });
    const url = `https://localhost:${(f.app.server.address() as any).port}`;
    const tokenFile = join(root, "token");
    writeFileSync(tokenFile, grant.secret, { mode: 0o600 });
    const env = {
      ...process.env,
      FARHELM_URL: url,
      FARHELM_API_TOKEN: "",
      FARHELM_API_TOKEN_FILE: tokenFile,
      FARHELM_CA_FILE: join(root, "tls/ca.crt"),
    };
    const script = resolve("../../skills/farhelm-api/scripts/farhelm.py");
    const invoke = (args: string[]) =>
      run("python3", [script, ...args], { env, timeout: 15000 });
    const me = JSON.parse((await invoke(["me"])).stdout);
    assert.equal(me.api_token_id, grant.token.id);
    assert.equal(
      JSON.parse((await invoke(["devices"])).stdout).devices.length,
      1,
    );
    const task = JSON.parse(
      (
        await invoke([
          "exec",
          "one",
          "--cwd",
          "/tmp",
          "--idempotency-key",
          "python-once",
          "--",
          "/usr/bin/printf",
          "hello world",
        ])
      ).stdout,
    );
    assert.equal(
      JSON.parse(
        (await invoke(["wait", task.task_id, "--seconds", "1"])).stdout,
      ).task_id,
      task.task_id,
    );
    assert.equal(
      JSON.parse((await invoke(["list", "tasks", "--limit", "1"])).stdout).tasks
        .length,
      1,
    );
    await assert.rejects(
      invoke(["request", "GET", "//example.com"]),
      (e: any) => !e.stderr.includes(grant.secret) && /相对 API/.test(e.stderr),
    );
  } finally {
    await f.close();
  }
});

test("API tokens: cross-user recording access requires explicit permission and keeps the device boundary", async () => {
  const f = await fixture();
  try {
    const other = f.store.seedUser({
      username: "other-admin",
      password,
      role: "admin",
      deviceScope: "*",
    });
    const otherLogin = await f.login(other.username);
    for (const [id, device, actor] of [
      ["own", "one", f.owner.id],
      ["other", "one", other.id],
      ["outside", "two", f.owner.id],
    ])
      f.store.db
        .prepare(
          "INSERT INTO terminal_sessions(id,device_id,actor_id,status,cols,rows,created_at,ended_at) VALUES(?,?,?,'CLOSED',80,24,1,2)",
        )
        .run(id!, device!, actor!);
    const grant = await f.create({
      permissions: ["recordings.read", "terminal.connect"],
    });
    assert.deepEqual(
      (
        await f.api("GET", "/terminal-sessions", undefined, grant.secret)
      ).body.sessions.map((s: any) => s.id),
      ["own"],
    );
    for (const id of ["other", "outside"]) {
      assert.equal(
        (
          await f.api(
            "GET",
            `/terminal-sessions/${id}/recording`,
            undefined,
            grant.secret,
          )
        ).status,
        403,
      );
      assert.equal(
        (
          await f.api(
            "POST",
            `/terminal-sessions/${id}/export`,
            { v: 1 },
            grant.secret,
          )
        ).status,
        403,
      );
    }
    assert.equal(
      (
        await f.api(
          "PUT",
          `/api-tokens/${grant.token.id}`,
          f.input({ revision: 0 }),
          otherLogin,
        )
      ).status,
      403,
    );
    assert.equal(
      (
        await f.api(
          "PUT",
          `/api-tokens/${grant.token.id}`,
          f.input({
            revision: 0,
            permissions: [
              "recordings.read",
              "recordings.read_all",
              "terminal.connect",
            ],
          }),
        )
      ).status,
      200,
    );
    assert.equal(
      (
        await f.api(
          "GET",
          "/terminal-sessions/other/recording",
          undefined,
          grant.secret,
        )
      ).status,
      200,
    );
    assert.equal(
      (
        await f.api(
          "POST",
          "/terminal-sessions/other/close",
          { v: 1 },
          grant.secret,
        )
      ).status,
      403,
    );
    assert.equal(
      (
        await f.api(
          "GET",
          "/terminal-sessions/outside/recording",
          undefined,
          grant.secret,
        )
      ).status,
      403,
    );
    assert.equal(
      (
        await f.api(
          "POST",
          `/api-tokens/${grant.token.id}/revoke`,
          { v: 1 },
          otherLogin,
        )
      ).status,
      200,
    );
    const record = (await f.api("GET", "/audit")).body.audit.find(
      (a: any) => a.action === "api_token.revoked",
    );
    assert.equal(record.actor_id, other.id);
    assert.equal(record.detail.owner_id, f.owner.id);
  } finally {
    await f.close();
  }
});

test("API tokens: audit storage failures roll back grants and revocation and prevent read response disclosure", async () => {
  const f = await fixture();
  try {
    const grant = await f.create();
    f.store.db.exec(
      "CREATE TRIGGER fail_token_audit BEFORE INSERT ON audit WHEN NEW.action LIKE 'api_token.%' BEGIN SELECT RAISE(ABORT,'test storage failure'); END;",
    );
    assert.equal((await f.api("POST", "/api-tokens", f.input())).status, 500);
    assert.equal(
      (f.store.db.prepare("SELECT count(*) AS n FROM api_tokens").get() as any)
        .n,
      1,
    );
    assert.equal(
      (await f.api("POST", `/api-tokens/${grant.token.id}/revoke`, { v: 1 }))
        .status,
      500,
    );
    assert.equal(
      (
        f.store.db
          .prepare("SELECT revoked_at FROM api_tokens WHERE id=?")
          .get(grant.token.id) as any
      ).revoked_at,
      null,
    );
    const read = await f.api("GET", "/devices", undefined, grant.secret);
    assert.equal(read.status, 503);
    assert.deepEqual(read.body, { v: 1, error: "AUDIT_STORAGE_FAILURE" });
    f.store.db.exec("DROP TRIGGER fail_token_audit");
    assert.equal(
      (await f.api("GET", "/devices", undefined, grant.secret)).status,
      200,
    );
  } finally {
    await f.close();
  }
});

test("API tokens: malformed JSON and deployment-mode rejections retain token identity in audit", async () => {
  const f = await fixture();
  try {
    const grant = await f.create({ permissions: ["tasks.execute"] });
    const malformed = await f.app.inject({
      method: "POST",
      url: "/api/v1/commands",
      headers: {
        authorization: "Bearer " + grant.secret,
        "content-type": "application/json",
      },
      payload: "{",
    });
    assert.equal(malformed.statusCode, 400);
    let rows = (await f.api("GET", "/audit")).body.audit;
    assert.ok(
      rows.some(
        (a: any) =>
          a.action === "api_token.request" &&
          a.detail.status_code === 400 &&
          a.context.api_token_id === grant.token.id,
      ),
    );
    const isolated = await buildServer({
      dataDir: mkdtempSync(join(root, "http-")),
      deviceAccess: "ssh-only",
      webEnabled: true,
      webProtocol: "http",
      adminUsername: "admin",
      adminPassword: password,
    });
    try {
      const login = (
        await isolated.app.inject({
          method: "POST",
          url: "/api/v1/login",
          payload: { username: "admin", password },
        })
      ).json();
      const headers = { authorization: "Bearer " + login.access_token };
      const created = (
        await isolated.app.inject({
          method: "POST",
          url: "/api/v1/api-tokens",
          headers,
          payload: f.input({
            permissions: ["tasks.execute"],
            device_scope: [],
          }),
        })
      ).json();
      const rejected = await isolated.app.inject({
        method: "POST",
        url: "/api/v1/commands",
        headers: { authorization: "Bearer " + created.secret },
        payload: command(),
      });
      assert.equal(rejected.statusCode, 403);
      assert.equal(rejected.json().error, "AGENT_ACCESS_DISABLED");
      rows = (
        await isolated.app.inject({
          method: "GET",
          url: "/api/v1/audit",
          headers,
        })
      ).json().audit;
      assert.ok(
        rows.some(
          (a: any) =>
            a.action === "api_token.request" &&
            a.detail.status_code === 403 &&
            a.context.api_token_id === created.token.id,
        ),
      );
      assert.ok(
        rows.some(
          (a: any) =>
            a.action === "authorization.denied" &&
            a.actor_id === login.user.id &&
            a.context.source === "api",
        ),
      );
    } finally {
      await isolated.close();
    }
  } finally {
    await f.close();
  }
});

test("API Skill client: redirects never forward credentials and uncertain writes are never automatically retried", async () => {
  let reachedTarget = 0,
    writes = 0;
  const http = createServer((req, res) => {
    if (req.url === "/api/v1/me") {
      res.writeHead(302, { location: "/target" });
      res.end();
    } else if (req.url === "/target") {
      reachedTarget++;
      res.end("unexpected");
    } else {
      writes++;
      req.socket.destroy();
    }
  });
  await new Promise<void>((resolve) => http.listen(0, "127.0.0.1", resolve));
  try {
    const secret = "fh_api_" + "a".repeat(43);
    const env = {
      ...process.env,
      FARHELM_URL: `http://127.0.0.1:${(http.address() as any).port}`,
      FARHELM_API_TOKEN_FILE: "",
      FARHELM_API_TOKEN: secret,
      FARHELM_CA_FILE: "",
    };
    const script = resolve("../../skills/farhelm-api/scripts/farhelm.py");
    await assert.rejects(
      run("python3", [script, "me"], { env }),
      (e: any) => /重定向/.test(e.stderr) && !e.stderr.includes(secret),
    );
    assert.equal(reachedTarget, 0);
    await assert.rejects(
      run(
        "python3",
        [
          script,
          "exec",
          "one",
          "--cwd",
          "/tmp",
          "--idempotency-key",
          "single-attempt",
          "--",
          "/usr/bin/uptime",
        ],
        { env },
      ),
      (e: any) => !e.stderr.includes(secret),
    );
    assert.equal(writes, 1);
  } finally {
    await new Promise<void>((resolve) => http.close(() => resolve()));
  }
});

function socket(url: string, headers: Record<string, string>) {
  const ws = new WebSocket(url, { ca, headers });
  const messages: any[] = [];
  ws.on("error", () => {});
  ws.on("message", (raw) => messages.push(JSON.parse(raw.toString())));
  const send = (type: string, body: unknown) =>
    ws.send(JSON.stringify({ v: 1, type, body }));
  async function wait(type: string) {
    const end = Date.now() + 4000;
    while (Date.now() < end) {
      const index = messages.findIndex((m) => m.type === type);
      if (index >= 0) return messages.splice(index, 1)[0].body;
      await new Promise((r) => setTimeout(r, 10));
    }
    throw Error("Missing " + type);
  }
  return { ws, send, wait, messages };
}
test("API tokens: terminal tickets, recorded output, immediate revocation and expiry preserve authorization", async () => {
  const f = await fixture();
  const sockets: WebSocket[] = [];
  try {
    await f.app.listen({ host: "127.0.0.1", port: 0 });
    const origin = `https://localhost:${(f.app.server.address() as any).port}`,
      wsUrl = origin.replace("https:", "wss:");
    const agentToken = token();
    f.store.db
      .prepare(
        "INSERT INTO device_tokens(token_hash,device_id,expires_at,scope) VALUES(?,'one',?,'agent-control-output')",
      )
      .run(hash(agentToken), Date.now() + 60000);
    const agent = socket(wsUrl + "/agent/ws", {
      authorization: "Bearer " + agentToken,
    });
    sockets.push(agent.ws);
    await once(agent.ws, "open");
    agent.send("agent.hello", {
      agent_version: "token-protocol-test",
      capabilities: ["terminal.pty.v1"],
    });
    for (let n = 0; n < 50; n++) {
      if (
        (await f.api("GET", "/devices")).body.devices.find(
          (d: any) => d.id === "one",
        ).control_online
      )
        break;
      await new Promise((r) => setTimeout(r, 10));
    }
    const grant = await f.create({
      permissions: ["terminal.connect", "recordings.read"],
    });
    const body = { v: 1, device_id: "one", cols: 80, rows: 24 };
    const removed = await f.api(
      "POST",
      "/terminal-sessions",
      { ...body, account_id: "legacy" },
      grant.secret,
    );
    assert.equal(removed.status, 400);
    assert.equal(removed.body.error, "ACCOUNT_CONNECTION_REMOVED");
    const created = await f.api(
      "POST",
      "/terminal-sessions",
      body,
      grant.secret,
    );
    assert.equal(created.status, 200);
    const client = socket(wsUrl + "/api/v1/terminal/ws", { origin });
    sockets.push(client.ws);
    await once(client.ws, "open");
    client.send("terminal.attach", {
      session_id: created.body.session_id,
      ticket: created.body.ticket,
    });
    const id = (await agent.wait("terminal.open")).session_id;
    agent.send("terminal.opened", { session_id: id });
    await client.wait("terminal.ready");
    const data = Buffer.from("token recording\r\n").toString("base64");
    agent.send("terminal.output", { session_id: id, seq: 1, data });
    assert.equal((await client.wait("terminal.output")).data, data);
    const recorded = await f.api(
      "GET",
      `/terminal-sessions/${id}/recording`,
      undefined,
      grant.secret,
    );
    assert.ok(
      recorded.body.events.some(
        (e: any) => e.kind === "output" && e.data.data === data,
      ),
    );
    const unused = await f.api(
      "POST",
      "/terminal-sessions",
      body,
      grant.secret,
    );
    assert.equal(
      (await f.api("POST", `/api-tokens/${grant.token.id}/revoke`, { v: 1 }))
        .status,
      200,
    );
    await agent.wait("terminal.close");
    await client.wait("terminal.closed");
    const replay = socket(wsUrl + "/api/v1/terminal/ws", { origin });
    sockets.push(replay.ws);
    await once(replay.ws, "open");
    replay.send("terminal.attach", {
      session_id: unused.body.session_id,
      ticket: unused.body.ticket,
    });
    await once(replay.ws, "close");
    assert.equal(
      (
        await f.api(
          "GET",
          `/terminal-sessions/${id}/recording`,
          undefined,
          grant.secret,
        )
      ).status,
      401,
    );
    assert.ok(
      (
        await f.api("GET", `/terminal-sessions/${id}/recording`)
      ).body.events.some((e: any) => e.kind === "output"),
    );
    const expiring = await f.create({ permissions: ["terminal.connect"] });
    const pending = await f.api(
      "POST",
      "/terminal-sessions",
      body,
      expiring.secret,
    );
    f.store.db
      .prepare("UPDATE api_tokens SET expires_at=0 WHERE id=?")
      .run(expiring.token.id);
    const stale = socket(wsUrl + "/api/v1/terminal/ws", { origin });
    sockets.push(stale.ws);
    await once(stale.ws, "open");
    stale.send("terminal.attach", {
      session_id: pending.body.session_id,
      ticket: pending.body.ticket,
    });
    await once(stale.ws, "close");
  } finally {
    for (const ws of sockets) ws.terminate();
    await f.close();
  }
});

test("API tokens: lightweight device options stay scoped and execution choices need explicit permission", async () => {
  const f = await fixture();
  try {
    const grant = await f.create();
    const r = await f.api("GET", "/device-options", undefined, grant.secret);
    assert.equal(r.status, 200);
    assertValid("device-options-response", r.body);
    assert.deepEqual(
      r.body.devices.map((d: any) => d.id),
      ["one"],
    );
    const lookup = await f.api(
      "GET",
      "/device-options?ids=" +
        encodeURIComponent(JSON.stringify(["one", "two"])),
      undefined,
      grant.secret,
    );
    assert.deepEqual(
      lookup.body.devices.map((d: any) => d.id),
      ["one"],
    );
    assert.equal(
      (
        await f.api(
          "GET",
          "/device-options?purpose=exec",
          undefined,
          grant.secret,
        )
      ).status,
      403,
    );
    const exec = await f.create({
      permissions: ["devices.read", "tasks.execute"],
    });
    assert.equal(
      (
        await f.api(
          "GET",
          "/device-options?purpose=exec",
          undefined,
          exec.secret,
        )
      ).body.devices.length,
      1,
    );
    assert.equal(
      (await f.api("POST", `/api-tokens/${grant.token.id}/revoke`, { v: 1 }))
        .status,
      200,
    );
    assert.equal(
      (await f.api("GET", "/device-options", undefined, grant.secret)).status,
      401,
    );
  } finally {
    await f.close();
  }
});
