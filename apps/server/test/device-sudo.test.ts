import { after, test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { Store } from "../src/store.js";
import { deviceSudo, migrateDeviceSudo } from "../src/device-sudo.js";
import { AccountAuthorizations } from "../src/account-authorizations.js";
import { ApiTokens } from "../src/api-tokens.js";
import { buildServer } from "../src/server.js";
import { assertValid } from "../../../tests/contracts/validate.mjs";
const root = mkdtempSync(join(tmpdir(), "farhelm-device-sudo-"));
after(() => rmSync(root, { recursive: true, force: true }));
const password = "device-sudo-test1";
const fresh = () => new Store(mkdtempSync(join(root, "db-")));
const current = (s: Store, id: string) =>
  s.user(s.db.prepare("SELECT * FROM users WHERE id=?").get(id));
const device = (s: Store, id: string) =>
  s.db
    .prepare(
      "INSERT INTO devices(id,public_key,name,created_at) VALUES(?,?,?,1)",
    )
    .run(id, id, id);
const rule = (
  s: Store,
  id: string,
  dev: string,
  column: string,
  subject: string,
  effect = "allow",
) =>
  s.db
    .prepare(
      `INSERT INTO device_sudo_rules(id,device_id,${column},effect) VALUES(?,?,?,?)`,
    )
    .run(id, dev, subject, effect);

test("sudo migration keeps only previous user/device intersections, sources and disabled accounts, without restoring deleted grants", () => {
  const dir = mkdtempSync(join(root, "migration-"));
  let s = new Store(dir);
  try {
    for (const id of ["one", "two", "revoked"]) device(s, id);
    s.db.exec("UPDATE devices SET revoked_at=1 WHERE id='revoked'");
    const admin = s.seedUser({
      username: "admin",
      password,
      role: "admin",
      deviceScope: "*",
    });
    const ops = s.seedUser({
      username: "ops",
      password,
      role: "ops",
      deviceScope: ["one"],
    });
    const disabled = s.seedUser({
      username: "disabled",
      password,
      role: "ops",
      deviceScope: ["two"],
    });
    const plain = s.seedUser({
      username: "plain",
      password,
      role: "business",
      deviceScope: "*",
    });
    s.db
      .exec(`INSERT INTO access_roles(id,name,description,permissions,created_at,updated_at) VALUES('sudo-role','old sudo','','["devices.read","terminal.connect","terminal.sudo"]',1,1);
      INSERT INTO access_groups(id,name,description,device_scope,created_at,updated_at) VALUES('team','team','','["one"]',1,1);
      INSERT INTO group_roles VALUES('team','sudo-role')`);
    s.db.prepare("INSERT INTO group_members VALUES('team',?)").run(ops.id);
    s.db
      .prepare("INSERT INTO user_roles VALUES(?,'sudo-role')")
      .run(disabled.id);
    s.db.prepare("UPDATE users SET enabled=0 WHERE id=?").run(disabled.id);
    const policy = new AccountAuthorizations(s.db);
    for (const id of ["one", "two"]) policy.ensureDefault(id);
    const before = [
      "users",
      "account_authorizations",
      "user_roles",
      "group_roles",
      "group_members",
      "audit",
    ].map((t) => s.db.prepare(`SELECT * FROM ${t}`).all());
    s.db.exec("DELETE FROM meta WHERE key='device_sudo_v1'");
    s.close();
    s = new Store(dir);
    assert.deepEqual(
      [
        "users",
        "account_authorizations",
        "user_roles",
        "group_roles",
        "group_members",
        "audit",
      ].map((t) => s.db.prepare(`SELECT * FROM ${t}`).all()),
      before,
    );
    const rows = s.db
      .prepare(
        "SELECT user_id,device_id FROM device_sudo_rules ORDER BY user_id,device_id",
      )
      .all();
    assert.equal(rows.length, 4);
    assert.ok(
      !rows.some((r) => r.user_id === plain.id || r.device_id === "revoked"),
    );
    assert.equal(deviceSudo(s.db, current(s, ops.id), "one").allowed, true);
    assert.equal(deviceSudo(s.db, current(s, ops.id), "two").allowed, false);
    s.db.prepare("DELETE FROM group_members WHERE user_id=?").run(ops.id);
    assert.equal(deviceSudo(s.db, current(s, ops.id), "one").allowed, false);
    s.db.prepare("DELETE FROM device_sudo_rules WHERE user_id=?").run(admin.id);
    migrateDeviceSudo(s.db, (row) => s.user(row));
    s.close();
    s = new Store(dir);
    assert.equal(deviceSudo(s.db, current(s, admin.id), "one").allowed, false);
    device(s, "new-server");
    assert.equal(
      deviceSudo(s.db, current(s, disabled.id), "new-server").allowed,
      false,
    );
  } finally {
    s.close();
  }
});

test("personal deny overrides group and role allows; sudo cannot create ordinary access or bypass an API token ceiling", () => {
  const s = fresh();
  try {
    device(s, "one");
    device(s, "two");
    const user = s.seedUser({
      username: "operator",
      password,
      role: "ops",
      deviceScope: ["one"],
    });
    const u = () => current(s, user.id);
    assert.equal(deviceSudo(s.db, u(), "one").allowed, false);
    rule(s, "role", "one", "role_id", "ops");
    assert.equal(deviceSudo(s.db, u(), "one").allowed, true);
    rule(s, "deny", "one", "user_id", user.id, "deny");
    assert.equal(deviceSudo(s.db, u(), "one").reason, "USER_DENIED");
    s.db.exec("UPDATE device_sudo_rules SET effect='allow' WHERE id='deny'");
    assert.equal(deviceSudo(s.db, u(), "one").reason, "USER_ALLOWED");
    rule(s, "no-scope", "two", "user_id", user.id);
    assert.deepEqual(u().device_scope, ["one"]);
    assert.equal(
      deviceSudo(
        s.db,
        { ...u(), api_token_id: "token", permissions: ["terminal.connect"] },
        "one",
      ).reason,
      "TOKEN_DENIED",
    );
    assert.equal(
      deviceSudo(
        s.db,
        {
          ...u(),
          api_token_id: "token",
          permissions: ["terminal.connect", "terminal.sudo"],
        },
        "one",
      ).allowed,
      true,
    );
    s.db
      .prepare("DELETE FROM device_sudo_rules WHERE id IN ('role','deny')")
      .run();
    assert.equal(deviceSudo(s.db, u(), "one").allowed, false);
  } finally {
    s.close();
  }
});

test("sudo configuration is admin-only, revisioned, audited, separate from ordinary scope and survives restart", async () => {
  execFileSync(
    "bash",
    ["../../deploy/dev/generate-tls.sh", join(root, "tls")],
    { stdio: "ignore" },
  );
  const config = {
    dataDir: mkdtempSync(join(root, "api-")),
    tlsCert: join(root, "tls/server.crt"),
    tlsKey: join(root, "tls/server.key"),
    adminUsername: "admin",
    adminPassword: password,
  };
  let s = await buildServer(config);
  let auth = "";
  const api = async (
    method: string,
    path: string,
    body?: any,
    token = auth,
  ) => {
    const r = await s.app.inject({
      method: method as any,
      url: "/api/v1" + path,
      payload: body,
      headers: token ? { authorization: "Bearer " + token } : {},
    });
    return { status: r.statusCode, body: r.json() };
  };
  try {
    auth = (await api("POST", "/login", { username: "admin", password }, ""))
      .body.access_token;
    device(s.store, "one");
    device(s.store, "two");
    const user = s.store.seedUser({
      username: "operator",
      password,
      role: "ops",
      deviceScope: [],
    });
    const ops = (
      await api("POST", "/login", { username: "operator", password }, "")
    ).body.access_token;
    const payload = {
      v: 1,
      device_id: "one",
      subject_type: "user",
      subject_id: user.id,
      effect: "allow",
      revision: 0,
    };
    assert.equal(
      (await api("POST", "/access-authorizations/sudo", payload, ops)).status,
      403,
    );
    assert.equal(
      (
        await api("POST", "/access-authorizations/sudo", {
          ...payload,
          subject_type: "role",
          subject_id: "ops",
          effect: "deny",
        })
      ).status,
      400,
    );
    const saved = await api("POST", "/access-authorizations/sudo", payload);
    assert.equal(saved.status, 200);
    assertValid("device-sudo-rule", saved.body.rule);
    assert.equal(
      (await api("POST", "/access-authorizations/sudo", payload)).status,
      409,
    );
    const effective = (
      await api("GET", `/access-authorizations/effective/${user.id}`)
    ).body;
    assertValid("effective-authorization-response", effective);
    assert.equal(effective.accounts[0].allowed, false);
    assert.equal(effective.accounts[0].sudo_allowed, false);
    assert.deepEqual(current(s.store, user.id).device_scope, []);
    const list = (await api("GET", "/access-authorizations")).body;
    assertValid("access-authorizations-response", list);
    assert.equal(list.sudo_rules.length, 1);
    const audits = (await api("GET", "/audit")).body;
    assertValid("audit-response", audits);
    await s.close();
    s = await buildServer(config);
    assert.equal(
      deviceSudo(s.store.db, current(s.store, user.id), "one").allowed,
      true,
    );
    assert.equal(
      (
        await api(
          "DELETE",
          "/access-authorizations/sudo/" + saved.body.rule.id,
          { v: 1, revision: 9 },
        )
      ).status,
      409,
    );
    assert.equal(
      (
        await api(
          "DELETE",
          "/access-authorizations/sudo/" + saved.body.rule.id,
          { v: 1, revision: 1 },
        )
      ).status,
      200,
    );
    assert.equal(
      deviceSudo(s.store.db, current(s.store, user.id), "one").allowed,
      false,
    );
  } finally {
    await s.close();
  }
});

test("API token sudo ceilings follow current device rules without inheriting administrator bypass", () => {
  const s = fresh();
  try {
    device(s, "one");
    device(s, "two");
    const admin = s.seedUser({
      username: "owner",
      password,
      role: "admin",
      deviceScope: "*",
    });
    rule(s, "one-sudo", "one", "user_id", admin.id);
    s.db
      .prepare(
        "INSERT INTO api_tokens(id,owner_id,name,token_hash,prefix,permissions,device_scope,expires_at,created_at,updated_at) VALUES('token',?,'token','token-hash','prefix','[\"devices.read\",\"terminal.connect\",\"terminal.sudo\"]','\"*\"',9999999999999,1,1)",
      )
      .run(admin.id);
    const tokens = new ApiTokens(s);
    let principal = tokens.resolve("token-hash")!;
    assert.equal(principal.role, "ops");
    assert.equal(deviceSudo(s.db, principal, "one").allowed, true);
    assert.equal(deviceSudo(s.db, principal, "two").allowed, false);
    s.db.exec("UPDATE device_sudo_rules SET effect='deny' WHERE id='one-sudo'");
    principal = tokens.resolve("token-hash")!;
    assert.equal(principal.permissions!.includes("terminal.sudo"), false);
    assert.equal(deviceSudo(s.db, principal, "one").allowed, false);
  } finally {
    s.close();
  }
});
