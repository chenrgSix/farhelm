import { after, test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Store } from "../src/store.js";
import { READ_PERMISSIONS, rolePermissions } from "../src/permissions.js";

const root = mkdtempSync(join(tmpdir(), "farhelm-default-roles-"));
after(() => rmSync(root, { recursive: true, force: true }));
const password = "default-role-test1";
const roles = (store: Store) =>
  store.db.prepare("SELECT * FROM access_roles ORDER BY id").all() as any[];

test("fresh installations have exactly two immutable defaults; private legacy seeding explicitly creates custom roles", () => {
  const dir = mkdtempSync(join(root, "fresh-"));
  let store = new Store(dir);
  try {
    assert.deepEqual(
      roles(store).map((r) => [r.id, r.name, r.builtin]),
      [
        ["admin", "管理员", 1],
        ["business", "普通用户", 1],
      ],
    );
    assert.deepEqual(JSON.parse(roles(store)[1].permissions), READ_PERMISSIONS);
    store.close();
    store = new Store(dir);
    assert.equal(roles(store).length, 2);
    const user = store.seedUser({
      username: "operator",
      password,
      role: "ops",
      deviceScope: ["one"],
    });
    assert.deepEqual(user.permissions, rolePermissions("ops"));
    assert.equal(roles(store).find((r) => r.id === "ops").builtin, 0);
    assert.equal(
      roles(store).some((r) => r.id === "auditor"),
      false,
    );
    store.db
      .prepare(
        "UPDATE access_roles SET permissions='[\"devices.read\"]' WHERE id='ops'",
      )
      .run();
    store.close();
    store = new Store(dir);
    assert.deepEqual(
      store.user(
        store.db.prepare("SELECT * FROM users WHERE id=?").get(user.id),
      ).permissions,
      ["devices.read"],
    );
  } finally {
    store.close();
  }
});

test("migration preserves direct and inherited permissions, disabled users, scopes, tokens and audit history; later custom edits survive restart", () => {
  const dir = mkdtempSync(join(root, "upgrade-"));
  let store = new Store(dir);
  try {
    const admin = store.seedUser({
      username: "admin",
      password,
      role: "admin",
      deviceScope: "*",
    });
    const operator = store.seedUser({
      username: "operator",
      password,
      role: "ops",
      deviceScope: ["one"],
    });
    const auditor = store.seedUser({
      username: "auditor",
      password,
      role: "auditor",
      deviceScope: [],
    });
    const reader = store.seedUser({
      username: "reader",
      password,
      role: "business",
      deviceScope: ["two"],
    });
    const disabled = store.seedUser({
      username: "disabled",
      password,
      role: "ops",
      deviceScope: "*",
    });
    store.db.prepare("UPDATE users SET enabled=0 WHERE id=?").run(disabled.id);
    store.db.exec(
      "INSERT INTO access_groups(id,name,description,device_scope,created_at,updated_at) VALUES('audit-group','审计组','','[\"one\",\"two\"]',1,1)",
    );
    store.db.exec(
      "INSERT INTO group_roles(group_id,role_id) VALUES('audit-group','auditor')",
    );
    for (const user of [auditor, operator])
      store.db
        .prepare(
          "INSERT INTO group_members(group_id,user_id) VALUES('audit-group',?)",
        )
        .run(user.id);
    store.db.prepare("DELETE FROM user_roles WHERE user_id=?").run(auditor.id);
    store.db
      .prepare(
        "INSERT INTO api_tokens(id,owner_id,name,token_hash,prefix,permissions,device_scope,expires_at,created_at,updated_at) VALUES('token',?,'token','hash','prefix','[\"devices.read\"]','[\"one\"]',9999999999999,1,1)",
      )
      .run(operator.id);
    // Recreate the pre-migration built-in metadata without touching grants.
    store.db.exec(
      "UPDATE access_roles SET builtin=1 WHERE id IN ('ops','auditor'); UPDATE access_roles SET name='业务人员' WHERE id='business'; DELETE FROM meta WHERE key='default_roles_v2'",
    );
    const ids = [admin, operator, auditor, reader, disabled].map((u) => u.id);
    const effective = () =>
      ids.map((id) => {
        const { role_names, ...user } = store.user(
          store.db.prepare("SELECT * FROM users WHERE id=?").get(id),
        );
        return user;
      });
    const before = effective();
    const tables = [
      "users",
      "user_roles",
      "group_roles",
      "group_members",
      "access_groups",
      "api_tokens",
      "audit",
    ];
    const records = () =>
      tables.map((table) =>
        store.db.prepare(`SELECT * FROM ${table} ORDER BY rowid`).all(),
      );
    const original = records();
    const originalRoles = roles(store);
    store.close();
    store = new Store(dir);
    assert.deepEqual(effective(), before);
    assert.deepEqual(records(), original);
    assert.deepEqual(
      roles(store)
        .filter((r) => r.builtin)
        .map((r) => r.name),
      ["管理员", "普通用户"],
    );
    for (const id of ["ops", "auditor"]) {
      const previous = originalRoles.find((r) => r.id === id);
      assert.deepEqual(
        { ...roles(store).find((r) => r.id === id) },
        { ...previous, builtin: 0, revision: previous.revision + 1 },
      );
    }
    const migrated = roles(store);
    store.close();
    store = new Store(dir);
    assert.deepEqual(roles(store), migrated);
    store.db.exec(
      "UPDATE access_roles SET permissions='[\"devices.read\"]' WHERE id='auditor'; DELETE FROM group_roles WHERE group_id='audit-group'",
    );
    store.close();
    store = new Store(dir);
    assert.deepEqual(
      JSON.parse(roles(store).find((r) => r.id === "auditor").permissions),
      ["devices.read"],
    );
    assert.equal(store.db.prepare("SELECT * FROM group_roles").all().length, 0);
    assert.deepEqual(
      store.user(
        store.db.prepare("SELECT * FROM users WHERE id=?").get(auditor.id),
      ).permissions,
      [],
    );
  } finally {
    store.close();
  }
});

test("migration retains assignments to empty groups and leaves colliding custom names untouched", () => {
  const dir = mkdtempSync(join(root, "collision-"));
  let store = new Store(dir);
  try {
    store.db.exec(
      "UPDATE access_roles SET name='业务人员' WHERE id='business'; DELETE FROM meta WHERE key='default_roles_v2'",
    );
    const insert = store.db.prepare(
      "INSERT INTO access_roles(id,name,description,permissions,builtin,created_at,updated_at) VALUES(?,?,'','[\"devices.read\"]',?,1,1)",
    );
    insert.run("custom", "普通用户", 0);
    insert.run("custom2", "普通用户（内置 1）", 0);
    insert.run("ops", "运维人员", 1);
    insert.run("auditor", "审计员", 1);
    store.db.exec(
      "INSERT INTO access_groups(id,name,description,device_scope,created_at,updated_at) VALUES('empty','空组','','[]',1,1); INSERT INTO group_roles(group_id,role_id) VALUES('empty','ops')",
    );
    store.close();
    store = new Store(dir);
    assert.equal(
      roles(store).find((r) => r.id === "business").name,
      "普通用户（内置 2）",
    );
    assert.equal(roles(store).find((r) => r.id === "custom").name, "普通用户");
    assert.equal(
      roles(store).find((r) => r.id === "custom2").name,
      "普通用户（内置 1）",
    );
    assert.equal(roles(store).find((r) => r.id === "ops").builtin, 0);
    assert.equal(
      roles(store).some((r) => r.id === "auditor"),
      false,
    );
    assert.equal(
      store.db.prepare("SELECT * FROM group_roles WHERE role_id='ops'").all()
        .length,
      1,
    );
  } finally {
    store.close();
  }
});
