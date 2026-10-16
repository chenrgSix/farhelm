import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { DatabaseSync } from "node:sqlite";
import { buildServer } from "../src/server.js";
import { Store } from "../src/store.js";
import { passwordHash } from "../src/util.js";
import { assertValid } from "../../../tests/contracts/validate.mjs";

const root = mkdtempSync(join(tmpdir(), "farhelm-access-test-"));
execFileSync("bash", ["../../deploy/dev/generate-tls.sh", join(root, "tls")], {
  stdio: "ignore",
});
const password = "access-test-password1";
async function fixture() {
  const s = await buildServer({
    dataDir: mkdtempSync(join(root, "data-")),
    tlsCert: join(root, "tls/server.crt"),
    tlsKey: join(root, "tls/server.key"),
    adminUsername: "admin",
    adminPassword: password,
  });
  let admin = "";
  async function api(method: string, url: string, body?: any, auth = admin) {
    const r = await s.app.inject({
      method: method as any,
      url: "/api/v1" + url,
      payload: body,
      headers: auth ? { authorization: "Bearer " + auth } : {},
    });
    return { status: r.statusCode, body: r.json() };
  }
  async function login(username: string, pw = password) {
    return api("POST", "/login", { username, password: pw }, "");
  }
  admin = (await login("admin")).body.access_token;
  function device(id: string, kind = "agent") {
    s.store.db
      .prepare(
        "INSERT INTO devices(id,public_key,name,created_at,connection_kind) VALUES(?,?,?,?,?)",
      )
      .run(id, id, id, Date.now(), kind);
  }
  async function all() {
    const r = await api("GET", "/access");
    assert.equal(r.status, 200);
    assertValid("access-management-response", r.body);
    return r.body;
  }
  async function user(username: string, overrides = {}) {
    const r = await api("POST", "/users", {
      v: 1,
      username,
      password,
      enabled: true,
      role_ids: [],
      group_ids: [],
      device_scope: [],
      ...overrides,
    });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assertValid("access-user-response", r.body);
    return r.body.user;
  }
  function userBody(u: any, changes = {}) {
    return {
      v: 1,
      revision: u.revision,
      username: u.username,
      enabled: u.enabled,
      role_ids: u.role_ids,
      group_ids: u.group_ids,
      device_scope: u.device_scope,
      ...changes,
    };
  }
  return {
    ...s,
    api,
    login,
    device,
    all,
    user,
    userBody,
    get admin() {
      return admin;
    },
  };
}
test("legacy migration preserves accounts and device scope; existing devices stay ungrouped; migrations do not restore removed roles", () => {
  const dir = mkdtempSync(join(root, "legacy-")),
    db = new DatabaseSync(join(dir, "fleet.sqlite"));
  db.exec(
    readFileSync(
      new URL("../migrations/001_initial.sql", import.meta.url),
      "utf8",
    ),
  );
  db.prepare(
    "INSERT INTO users(id,username,password_hash,role,device_scope,created_at) VALUES('legacy','legacy',?,'ops','[\"old\"]',1)",
  ).run(passwordHash(password));
  db.prepare(
    "INSERT INTO devices(id,public_key,name,created_at) VALUES('old','old','old',1)",
  ).run();
  db.close();
  let store = new Store(dir);
  assert.equal(
    store.user(store.db.prepare("SELECT * FROM users WHERE id='legacy'").get())
      .role,
    "ops",
  );
  assert.deepEqual(
    store.user(store.db.prepare("SELECT * FROM users WHERE id='legacy'").get())
      .device_scope,
    ["old"],
  );
  assert.equal(
    store.db
      .prepare(
        "SELECT group_id FROM device_group_members WHERE device_id='old'",
      )
      .get(),
    undefined,
  );
  store.db.prepare("DELETE FROM user_roles WHERE user_id='legacy'").run();
  store.close();
  store = new Store(dir);
  assert.deepEqual(
    store.user(store.db.prepare("SELECT * FROM users WHERE id='legacy'").get())
      .permissions,
    [],
  );
  store.close();
});
test("device groups are optional overlapping tags; changing tags never changes explicit or user-group authorization", async () => {
  const f = await fixture();
  try {
    f.device("one");
    f.device("two", "ssh");
    assert.deepEqual((await f.all()).device_groups, []);
    const first = (
      await f.api("POST", "/device-groups", {
        v: 1,
        name: "生产",
        description: "",
        device_ids: ["one"],
      })
    ).body.device_group;
    const second = (
      await f.api("POST", "/device-groups", {
        v: 1,
        name: "华东",
        description: "",
        device_ids: ["one"],
      })
    ).body.device_group;
    const empty = (
      await f.api("POST", "/device-groups", {
        v: 1,
        name: "空标签",
        description: "",
        device_ids: [],
      })
    ).body.device_group;
    assert.deepEqual(empty.device_ids, []);
    const role = (
      await f.api("POST", "/roles", {
        v: 1,
        name: "终端专员",
        description: "",
        permissions: ["devices.read", "terminal.connect"],
      })
    ).body.role;
    const u = await f.user("operator");
    const group = (
      await f.api("POST", "/groups", {
        v: 1,
        name: "运维组",
        description: "",
        role_ids: [role.id],
        member_ids: [u.id],
        device_scope: ["one"],
      })
    ).body.group;
    const auth = (await f.login("operator")).body.access_token;
    const me = await f.api("GET", "/me", undefined, auth);
    assertValid("me-response", me.body);
    assert.deepEqual(me.body.device_scope, ["one"]);
    let devices = (await f.api("GET", "/devices", undefined, auth)).body
      .devices;
    assert.equal(devices.length, 1);
    assert.equal(devices[0].device_groups.length, 2);
    assertValid("device", devices[0]);
    for (const url of ["/tasks", "/audit", "/terminal-sessions", "/access"])
      assert.equal((await f.api("GET", url, undefined, auth)).status, 403, url);
    assert.equal((await f.api("POST", "/commands", {}, auth)).status, 403);
    assert.equal(
      (
        await f.api(
          "POST",
          "/terminal-sessions",
          { v: 1, device_id: "two", cols: 80, rows: 24 },
          auth,
        )
      ).status,
      403,
    );
    assert.equal(
      (
        await f.api("PUT", "/device-groups/" + first.id, {
          v: 1,
          revision: first.revision,
          name: first.name,
          description: "",
          device_ids: ["two"],
        })
      ).status,
      200,
    );
    assert.equal(
      (
        await f.api("DELETE", "/device-groups/" + second.id, {
          v: 1,
          revision: second.revision,
        })
      ).status,
      200,
    );
    assert.deepEqual(
      (await f.api("GET", "/me", undefined, auth)).body.device_scope,
      ["one"],
    );
    devices = (await f.api("GET", "/devices", undefined, auth)).body.devices;
    assert.deepEqual(devices[0].device_groups, []);
    f.device("new-agent");
    f.device("new-ssh", "ssh");
    assert.equal(
      (
        f.store.db
          .prepare(
            "SELECT COUNT(*) AS n FROM device_group_members WHERE device_id IN ('new-agent','new-ssh')",
          )
          .get() as any
      ).n,
      0,
    );
    assert.deepEqual(
      (await f.api("GET", "/me", undefined, auth)).body.device_scope,
      ["one"],
    );
    assert.equal(
      (
        await f.api("PUT", "/groups/" + group.id, {
          v: 1,
          revision: group.revision,
          name: group.name,
          description: "",
          role_ids: [role.id],
          member_ids: [u.id],
          device_scope: [],
        })
      ).status,
      200,
    );
    assert.equal((await f.api("GET", "/me", undefined, auth)).status, 401);
    assert.deepEqual(
      (
        await f.api(
          "GET",
          "/me",
          undefined,
          (await f.login("operator")).body.access_token,
        )
      ).body.device_scope,
      [],
    );
    const audit = (await f.api("GET", "/audit")).body;
    for (const a of audit.audit) assertValid("audit", a);
  } finally {
    await f.close();
  }
});
test("admin-only management, password reset, disabled users, immutable builtins, stale writes and self-lockout protection", async () => {
  const f = await fixture();
  try {
    const u = await f.user("reader", {
      role_ids: ["business"],
      device_scope: "*",
    });
    let auth = (await f.login("reader")).body.access_token;
    for (const [method, url] of [
      ["POST", "/users"],
      ["PUT", "/users/" + u.id],
      ["POST", "/users/" + u.id + "/password"],
      ["POST", "/roles"],
      ["PUT", "/roles/ops"],
      ["DELETE", "/roles/ops"],
      ["POST", "/groups"],
      ["PUT", "/groups/x"],
      ["DELETE", "/groups/x"],
      ["POST", "/device-groups"],
      ["PUT", "/device-groups/unknown"],
      ["DELETE", "/device-groups/unknown"],
    ]) {
      assert.equal(
        (await f.api(method!, url!, {}, auth)).status,
        403,
        method + url,
      );
      assert.equal((await f.api(method!, url!, {}, "")).status, 401);
    }
    assert.equal(
      (
        await f.api("POST", "/users", {
          ...f.userBody(u),
          revision: undefined,
          username: "READER",
          password,
        })
      ).status,
      409,
    );
    assert.equal(
      (
        await f.api(
          "PUT",
          "/users/" + u.id,
          f.userBody(u, { role_ids: ["unknown"] }),
        )
      ).status,
      400,
    );
    assert.equal(
      (
        await f.api("POST", "/roles", {
          v: 1,
          name: "bad",
          description: "",
          permissions: ["admin"],
        })
      ).body.error,
      "INVALID_PERMISSION",
    );
    assert.equal(
      (
        await f.api("PUT", "/roles/ops", {
          v: 1,
          revision: 0,
          name: "ops",
          description: "",
          permissions: [],
        })
      ).body.error,
      "BUILTIN_ROLE_READ_ONLY",
    );
    const reset = await f.api("POST", `/users/${u.id}/password`, {
      v: 1,
      revision: u.revision,
      password: "new-access-password1",
    });
    assert.equal(reset.status, 200);
    assert.equal((await f.login("reader")).status, 401);
    assert.equal((await f.api("GET", "/me", undefined, auth)).status, 401);
    auth = (await f.login("reader", "new-access-password1")).body.access_token;
    assert.equal(
      (await f.api("PUT", "/users/" + u.id, f.userBody(u))).body.error,
      "ACCESS_REVISION_CONFLICT",
    );
    let all = await f.all();
    let current = all.users.find((x: any) => x.id === u.id);
    assert.equal(
      (
        await f.api(
          "PUT",
          "/users/" + u.id,
          f.userBody(current, { enabled: false }),
        )
      ).status,
      200,
    );
    assert.equal((await f.login("reader", "new-access-password1")).status, 401);
    assert.equal((await f.api("GET", "/me", undefined, auth)).status, 401);
    all = await f.all();
    const self = all.users.find((x: any) => x.username === "admin");
    assert.equal(
      (
        await f.api(
          "PUT",
          "/users/" + self.id,
          f.userBody(self, { role_ids: [] }),
        )
      ).body.error,
      "LAST_ADMIN_REQUIRED",
    );
    await f.user("second-admin", { role_ids: ["admin"] });
    assert.equal(
      (
        await f.api(
          "PUT",
          "/users/" + self.id,
          f.userBody(self, { enabled: false }),
        )
      ).body.error,
      "SELF_ADMIN_REQUIRED",
    );
    assert.equal((await f.api("GET", "/me")).status, 200);
    const response = JSON.stringify(await f.all());
    const audit = JSON.stringify(
      f.store.db.prepare("SELECT detail_json FROM audit").all(),
    );
    for (const text of [response, audit]) {
      assert.ok(!text.includes(password));
      assert.ok(!text.includes("new-access-password1"));
      assert.ok(!text.includes("password_hash"));
    }
  } finally {
    await f.close();
  }
});
test("group changes bump member revisions, role changes revoke sessions and in-use roles cannot be deleted", async () => {
  const f = await fixture();
  try {
    f.device("a");
    f.device("b");
    const u = await f.user("group-user", { device_scope: ["a"] });
    const role = (
      await f.api("POST", "/roles", {
        v: 1,
        name: "只读设备",
        description: "",
        permissions: ["devices.read"],
      })
    ).body.role;
    const group = (
      await f.api("POST", "/groups", {
        v: 1,
        name: "业务组",
        description: "",
        role_ids: [role.id],
        member_ids: [u.id],
        device_scope: ["b"],
      })
    ).body.group;
    let auth = (await f.login(u.username)).body.access_token;
    assert.deepEqual(
      (await f.api("GET", "/me", undefined, auth)).body.device_scope,
      ["a", "b"],
    );
    assert.equal(
      (await f.api("PUT", "/users/" + u.id, f.userBody(u))).body.error,
      "ACCESS_REVISION_CONFLICT",
    );
    assert.equal(
      (
        await f.api("DELETE", "/roles/" + role.id, {
          v: 1,
          revision: role.revision,
        })
      ).body.error,
      "ROLE_IN_USE",
    );
    assert.equal(
      (
        await f.api("PUT", "/roles/" + role.id, {
          v: 1,
          revision: role.revision,
          name: role.name,
          description: "",
          permissions: ["devices.read", "audit.read"],
        })
      ).status,
      200,
    );
    assert.equal((await f.api("GET", "/me", undefined, auth)).status, 401);
    let all = await f.all();
    const current = all.users.find((x: any) => x.id === u.id);
    assert.equal(
      (
        await f.api(
          "PUT",
          "/users/" + u.id,
          f.userBody(current, { group_ids: [] }),
        )
      ).status,
      200,
    );
    assert.equal(
      (
        await f.api("PUT", "/groups/" + group.id, {
          v: 1,
          revision: group.revision,
          name: group.name,
          description: "",
          role_ids: [role.id],
          member_ids: [u.id],
          device_scope: ["b"],
        })
      ).body.error,
      "ACCESS_REVISION_CONFLICT",
    );
    assert.deepEqual(
      (
        await f.api(
          "GET",
          "/me",
          undefined,
          (await f.login(u.username)).body.access_token,
        )
      ).body.permissions,
      [],
    );
  } finally {
    await f.close();
  }
});

test("management audit failure rolls back the grant and token revocation; inherited administrators cannot lock themselves out", async () => {
  const f = await fixture();
  try {
    const u = await f.user("rollback-user", {
      role_ids: ["business"],
      device_scope: "*",
    });
    const auth = (await f.login(u.username)).body.access_token;
    f.store.db.exec(
      "CREATE TRIGGER fail_access_audit BEFORE INSERT ON audit WHEN NEW.action='access.user_updated' BEGIN SELECT RAISE(ABORT,'test audit failure'); END",
    );
    assert.equal(
      (await f.api("PUT", "/users/" + u.id, f.userBody(u, { enabled: false })))
        .status,
      500,
    );
    assert.equal((await f.api("GET", "/me", undefined, auth)).status, 200);
    assert.equal(
      (await f.all()).users.find((x: any) => x.id === u.id).revision,
      u.revision,
    );
    f.store.db.exec("DROP TRIGGER fail_access_audit");
    const member = await f.user("group-admin");
    const group = (
      await f.api("POST", "/groups", {
        v: 1,
        name: "管理组",
        description: "",
        role_ids: ["admin"],
        member_ids: [member.id],
        device_scope: [],
      })
    ).body.group;
    const groupAuth = (await f.login(member.username)).body.access_token;
    assert.equal(
      (await f.api("GET", "/access", undefined, groupAuth)).status,
      200,
    );
    assert.equal(
      (
        await f.api(
          "DELETE",
          "/groups/" + group.id,
          { v: 1, revision: group.revision },
          groupAuth,
        )
      ).body.error,
      "SELF_ADMIN_REQUIRED",
    );
    assert.equal(
      (await f.api("GET", "/me", undefined, groupAuth)).body.role,
      "admin",
    );
  } finally {
    await f.close();
  }
});

test("bootstrap environment cannot resurrect renamed or disabled accounts after restart", async () => {
  const dir = mkdtempSync(join(root, "bootstrap-restart-"));
  const config = {
    dataDir: dir,
    tlsCert: join(root, "tls/server.crt"),
    tlsKey: join(root, "tls/server.key"),
    adminUsername: "original-admin",
    adminPassword: password,
  };
  let s = await buildServer(config);
  s.store.db
    .prepare(
      "UPDATE users SET username='renamed-admin' WHERE username='original-admin'",
    )
    .run();
  await s.close();
  s = await buildServer(config);
  try {
    assert.equal(
      (s.store.db.prepare("SELECT COUNT(*) AS n FROM users").get() as any).n,
      1,
    );
    assert.equal(
      s.store.db
        .prepare("SELECT id FROM users WHERE username='original-admin'")
        .get(),
      undefined,
    );
    s.store.db
      .prepare("UPDATE users SET username='original-admin',enabled=0")
      .run();
  } finally {
    await s.close();
  }
  s = await buildServer(config);
  try {
    const response = await s.app.inject({
      method: "POST",
      url: "/api/v1/login",
      payload: { username: "original-admin", password },
    });
    assert.equal(response.statusCode, 401);
    assert.equal(
      (
        s.store.db
          .prepare("SELECT enabled FROM users WHERE username='original-admin'")
          .get() as any
      ).enabled,
      0,
    );
  } finally {
    await s.close();
  }
});

test("batch tags are admin-only, atomic and idempotent, preserve other tags and sessions, and invalidate stale group edits", async () => {
  const f = await fixture();
  try {
    f.device("one");
    f.device("two");
    f.device("three");
    const make = async (name: string, device_ids: string[]) => {
      const r = await f.api("POST", "/device-groups", {
        v: 1,
        name,
        description: "",
        device_ids,
      });
      assert.equal(r.status, 200);
      return r.body.device_group;
    };
    const group = await make("生产", ["one"]),
      other = await make("地区", ["one", "three"]);
    const u = await f.user("tag-reader", {
        role_ids: ["business"],
        device_scope: ["one"],
      }),
      auth = (await f.login(u.username)).body.access_token;
    const body = {
      v: 1,
      operation: "add",
      device_ids: ["one", "two"],
      group_ids: [group.id, other.id],
    };
    for (const token of [auth, ""]) {
      assert.equal(
        (await f.api("GET", "/device-groups", undefined, token)).status,
        token ? 403 : 401,
      );
      assert.equal(
        (await f.api("POST", "/device-groups/batch", body, token)).status,
        token ? 403 : 401,
      );
    }
    const result = await f.api("POST", "/device-groups/batch", body);
    assert.equal(result.status, 200);
    assert.equal(result.body.changed_count, 2);
    assertValid("device-tags-batch-response", result.body);
    assert.equal(
      (await f.api("POST", "/device-groups/batch", body)).body.changed_count,
      0,
    );
    const list = await f.api("GET", "/device-groups");
    assertValid("device-groups-response", list.body);
    assert.deepEqual(
      list.body.device_groups.find((g: any) => g.id === other.id).device_ids,
      ["one", "three", "two"],
    );
    assert.equal(
      (
        await f.api("PUT", "/device-groups/" + group.id, {
          v: 1,
          revision: group.revision,
          name: group.name,
          description: "",
          device_ids: ["one"],
        })
      ).body.error,
      "ACCESS_REVISION_CONFLICT",
    );
    assert.equal(
      (
        await f.api("POST", "/device-groups/batch", {
          ...body,
          operation: "remove",
          group_ids: [group.id],
        })
      ).body.changed_count,
      2,
    );
    assert.equal(
      (
        await f.api("POST", "/device-groups/batch", {
          ...body,
          device_ids: ["one", "missing"],
        })
      ).status,
      400,
    );
    assert.equal(
      (
        await f.api("POST", "/device-groups/batch", {
          ...body,
          group_ids: [group.id, "missing"],
        })
      ).status,
      400,
    );
    const current = (await f.api("GET", "/device-groups")).body.device_groups;
    assert.deepEqual(
      current.find((g: any) => g.id === group.id).device_ids,
      [],
    );
    assert.deepEqual(current.find((g: any) => g.id === other.id).device_ids, [
      "one",
      "three",
      "two",
    ]);
    assert.deepEqual(
      (await f.api("GET", "/me", undefined, auth)).body.device_scope,
      ["one"],
    );
    f.store.db.exec(
      "CREATE TRIGGER fail_tag_audit BEFORE INSERT ON audit WHEN NEW.action='access.device_tags_updated' BEGIN SELECT RAISE(ABORT,'test audit failure'); END",
    );
    assert.equal(
      (await f.api("POST", "/device-groups/batch", body)).status,
      500,
    );
    assert.deepEqual(
      (await f.api("GET", "/device-groups")).body.device_groups.find(
        (g: any) => g.id === group.id,
      ).device_ids,
      [],
    );
    f.store.db.exec("DROP TRIGGER fail_tag_audit");
    for (const a of (await f.api("GET", "/audit")).body.audit)
      assertValid("audit", a);
  } finally {
    await f.close();
  }
});

test("batch group size limits leave no partial tag changes", async () => {
  const f = await fixture();
  try {
    for (let i = 0; i < 1001; i++) f.device("limit-" + i);
    const ids = Array.from({ length: 1000 }, (_, i) => "limit-" + i);
    const full = (
      await f.api("POST", "/device-groups", {
        v: 1,
        name: "满组",
        description: "",
        device_ids: ids,
      })
    ).body.device_group;
    const empty = (
      await f.api("POST", "/device-groups", {
        v: 1,
        name: "空组",
        description: "",
        device_ids: [],
      })
    ).body.device_group;
    const r = await f.api("POST", "/device-groups/batch", {
      v: 1,
      operation: "add",
      device_ids: ["limit-1000"],
      group_ids: [empty.id, full.id],
    });
    assert.equal(r.status, 409);
    assert.equal(r.body.error, "DEVICE_GROUP_SIZE_LIMIT");
    const list = (await f.api("GET", "/device-groups")).body.device_groups;
    assert.equal(
      list.find((g: any) => g.id === full.id).device_ids.length,
      1000,
    );
    assert.deepEqual(list.find((g: any) => g.id === empty.id).device_ids, []);
  } finally {
    await f.close();
  }
});

test("users without device permissions change only their own password, revoke all own tokens and preserve grants", async () => {
  const f = await fixture();
  try {
    const u = await f.user("self-service");
    const first = (await f.login(u.username)).body.access_token;
    const second = (await f.login(u.username)).body.access_token;
    const body = {
      v: 1,
      current_password: password,
      new_password: "updated-personal-password1",
    };
    assertValid("password-change", body);
    assert.equal((await f.api("POST", "/me/password", body, "")).status, 401);
    assert.equal(
      (
        await f.api(
          "POST",
          "/me/password",
          { ...body, user_id: "admin" },
          first,
        )
      ).status,
      400,
    );
    assert.equal(
      (
        await f.api(
          "POST",
          "/me/password",
          { ...body, new_password: "short" },
          first,
        )
      ).status,
      400,
    );
    assert.equal(
      (
        await f.api(
          "POST",
          `/users/${u.id}/password`,
          { v: 1, revision: 0, password: body.new_password },
          first,
        )
      ).status,
      403,
    );
    const bad = await f.api(
      "POST",
      "/me/password",
      { ...body, current_password: "wrong" },
      first,
    );
    assert.equal(bad.status, 400);
    assert.equal(bad.body.error, "CURRENT_PASSWORD_INCORRECT");
    assert.equal((await f.api("GET", "/me", undefined, first)).status, 200);
    assert.equal(
      (
        await f.api(
          "POST",
          "/me/password",
          { ...body, new_password: password },
          first,
        )
      ).body.error,
      "PASSWORD_UNCHANGED",
    );
    const changed = await f.api("POST", "/me/password", body, first);
    assert.equal(changed.status, 200);
    assert.deepEqual(changed.body, { v: 1, ok: true });
    for (const auth of [first, second])
      assert.equal((await f.api("GET", "/me", undefined, auth)).status, 401);
    assert.equal((await f.login(u.username)).status, 401);
    assert.equal((await f.login(u.username, body.new_password)).status, 200);
    assert.equal((await f.api("GET", "/me")).status, 200);
    const updated = (await f.all()).users.find((x: any) => x.id === u.id);
    assert.deepEqual(updated, { ...u, revision: u.revision + 1 });
    const stale = await f.api("POST", `/users/${u.id}/password`, {
      v: 1,
      revision: u.revision,
      password: "stale-admin-password1",
    });
    assert.equal(stale.status, 409);
    const events = (await f.api("GET", "/audit")).body.audit;
    for (const event of events) assertValid("audit", event);
    const self = events.find(
      (x: any) => x.action === "access.password_changed",
    );
    assert.equal(self.actor_id, u.id);
    assert.equal(self.detail.target_id, u.id);
    assert.ok(
      events.some((x: any) => x.action === "user.password_change_failed"),
    );
    const output = JSON.stringify(events);
    for (const secret of [password, body.new_password, "password_hash"])
      assert.ok(!output.includes(secret));
  } finally {
    await f.close();
  }
});
test("personal password attempts are limited by account across login sessions", async () => {
  const f = await fixture();
  try {
    const u = await f.user("limited");
    const tokens = [
      (await f.login(u.username)).body.access_token,
      (await f.login(u.username)).body.access_token,
    ];
    for (let i = 0; i < 6; i++) {
      const r = await f.api(
        "POST",
        "/me/password",
        {
          v: 1,
          current_password: "wrong",
          new_password: "new-personal-password1",
        },
        tokens[i % 2],
      );
      assert.equal(r.status, i < 5 ? 400 : 429);
    }
    assert.equal((await f.login(u.username)).status, 200);
  } finally {
    await f.close();
  }
});
test("administrators can change their own password; audit failure rolls back password and revocation", async () => {
  const f = await fixture();
  try {
    const body = {
      v: 1,
      current_password: password,
      new_password: "updated-admin-password1",
    };
    f.store.db.exec(
      "CREATE TRIGGER fail_password_audit BEFORE INSERT ON audit WHEN NEW.action='access.password_changed' BEGIN SELECT RAISE(ABORT,'test audit failure'); END",
    );
    assert.equal((await f.api("POST", "/me/password", body)).status, 500);
    assert.equal((await f.api("GET", "/me")).status, 200);
    assert.equal((await f.login("admin")).status, 200);
    assert.equal((await f.login("admin", body.new_password)).status, 401);
    f.store.db.exec("DROP TRIGGER fail_password_audit");
    assert.equal((await f.api("POST", "/me/password", body)).status, 200);
    assert.equal((await f.api("GET", "/me")).status, 401);
    const updated = await f.login("admin", body.new_password);
    assert.equal(updated.status, 200);
    assert.equal(updated.body.user.role, "admin");
  } finally {
    await f.close();
  }
});

test("all account password setters enforce eight characters plus letters and digits; legacy passwords still authenticate", async () => {
  const f = await fixture();
  try {
    const u = await f.user("password-policy", { password: "abcd1234" });
    let auth = (await f.login(u.username, "abcd1234")).body.access_token;
    for (const invalid of [
      "abc1234",
      "abcdefgh",
      "12345678",
      "abcdefgh!",
      "1234567!",
      "A1".repeat(513),
    ]) {
      const create = await f.api("POST", "/users", {
        v: 1,
        username: "invalid-policy",
        password: invalid,
        enabled: true,
        role_ids: [],
        group_ids: [],
        device_scope: [],
      });
      const reset = await f.api("POST", `/users/${u.id}/password`, {
        v: 1,
        revision: 0,
        password: invalid,
      });
      const change = await f.api(
        "POST",
        "/me/password",
        { v: 1, current_password: "abcd1234", new_password: invalid },
        auth,
      );
      for (const r of [create, reset, change]) {
        assert.equal(r.status, 400);
        assert.equal(r.body.error, "INVALID_PASSWORD_POLICY");
      }
    }
    assert.equal((await f.api("GET", "/me", undefined, auth)).status, 200);
    assert.equal(
      (
        await f.api("POST", `/users/${u.id}/password`, {
          v: 1,
          revision: 0,
          password: "ABCDEFG1",
        })
      ).status,
      200,
    );
    auth = (await f.login(u.username, "ABCDEFG1")).body.access_token;
    assert.equal(
      (
        await f.api(
          "POST",
          "/me/password",
          { v: 1, current_password: "ABCDEFG1", new_password: "a123456!" },
          auth,
        )
      ).status,
      200,
    );
    assert.equal((await f.login(u.username, "a123456!")).status, 200);
    // Simulate an account persisted before the new composition policy.
    f.store.db
      .prepare("UPDATE users SET password_hash=? WHERE id=?")
      .run(passwordHash("legacy-password"), u.id);
    const legacy = await f.login(u.username, "legacy-password");
    assert.equal(legacy.status, 200);
    assert.equal(
      (
        await f.api(
          "POST",
          "/me/password",
          {
            v: 1,
            current_password: "legacy-password",
            new_password: "abcd1234",
          },
          legacy.body.access_token,
        )
      ).status,
      200,
    );
  } finally {
    await f.close();
  }
});
