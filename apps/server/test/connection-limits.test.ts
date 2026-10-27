import { after, test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { buildServer } from "../src/server.js";
import { assertValid } from "../../../tests/contracts/validate.mjs";
const root = mkdtempSync(join(tmpdir(), "farhelm-limits-"));
after(() => rmSync(root, { recursive: true, force: true }));
execFileSync("bash", ["../../deploy/dev/generate-tls.sh", join(root, "tls")], {
  stdio: "ignore",
});
test("connection limits are admin-only, strictly bounded, optimistic, atomic and persistent without changing network settings", async () => {
  const config = {
    dataDir: join(root, "data"),
    tlsCert: join(root, "tls/server.crt"),
    tlsKey: join(root, "tls/server.key"),
    adminUsername: "admin",
    adminPassword: "limit-tests-password1",
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
    auth = (
      await api(
        "POST",
        "/login",
        { username: "admin", password: "limit-tests-password1" },
        "",
      )
    ).body.access_token;
    s.store.seedUser({
      username: "ops",
      password: "limit-tests-password1",
      role: "ops",
      deviceScope: "*",
    });
    const ops = (
      await api(
        "POST",
        "/login",
        { username: "ops", password: "limit-tests-password1" },
        "",
      )
    ).body.access_token;
    assert.equal(
      (await api("GET", "/settings/connections", undefined, ops)).status,
      403,
    );
    const initial = (await api("GET", "/settings/connections")).body;
    assertValid("connection-limits", initial);
    assert.deepEqual(
      [
        initial.per_user,
        initial.per_device,
        initial.terminal_total,
        initial.ssh_total,
        initial.ssh_per_ip,
      ],
      [4, 4, 32, 64, 16],
    );
    const { updated_at, ...input } = initial;
    const network = JSON.stringify(
      s.store.db.prepare("SELECT * FROM system_settings").all(),
    );
    for (const change of [
      { per_user: 0 },
      { per_device: 129 },
      { ssh_total: 1025 },
      { ssh_per_ip: 1.5 },
      { terminal_total: "64" },
      { per_user: null },
      { unexpected: 1 },
    ])
      assert.equal(
        (await api("PUT", "/settings/connections", { ...input, ...change }))
          .status,
        400,
      );
    assert.equal(
      (await api("PUT", "/settings/connections", input, ops)).status,
      403,
    );
    const draft = {
      ...input,
      per_user: 6,
      per_device: 8,
      terminal_total: 64,
      ssh_total: 128,
      ssh_per_ip: 64,
    };
    const audit = s.store.audit;
    s.store.audit = function (action, ...args) {
      if (action === "settings.connections_updated")
        throw new Error("audit disk full");
      return audit.call(this, action, ...args);
    };
    assert.equal(
      (await api("PUT", "/settings/connections", draft)).status,
      500,
    );
    s.store.audit = audit;
    assert.equal((await api("GET", "/settings/connections")).body.revision, 0);
    const saved = await api("PUT", "/settings/connections", draft);
    assert.equal(saved.status, 200);
    assertValid("connection-limits", saved.body);
    assert.equal(
      (await api("PUT", "/settings/connections", draft)).status,
      409,
    );
    assert.equal(
      JSON.stringify(s.store.db.prepare("SELECT * FROM system_settings").all()),
      network,
    );
    assertValid("audit-response", (await api("GET", "/audit")).body);
    await s.close();
    s = await buildServer(config);
    assert.deepEqual(
      (await api("GET", "/settings/connections")).body,
      saved.body,
    );
  } finally {
    await s.close();
  }
});

test("device terminal overrides inherit dynamically, isolate devices, reset without ABA, persist and roll back with audit failure", async () => {
  const config = {
    dataDir: join(root, "device-data"),
    tlsCert: join(root, "tls/server.crt"),
    tlsKey: join(root, "tls/server.key"),
    adminUsername: "admin",
    adminPassword: "limit-tests-password1",
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
  const path = "/devices/one/terminal-limit",
    read = () => api("GET", path),
    save = (limit: any, revision: number) =>
      api("PUT", path, { v: 1, revision, limit });
  const global = async (per_device: number) => {
    const { updated_at, ...current } = (
      await api("GET", "/settings/connections")
    ).body;
    assert.equal(
      (await api("PUT", "/settings/connections", { ...current, per_device }))
        .status,
      200,
    );
  };
  try {
    auth = (
      await api(
        "POST",
        "/login",
        { username: "admin", password: "limit-tests-password1" },
        "",
      )
    ).body.access_token;
    for (const [id, kind] of [
      ["one", "agent"],
      ["two", "ssh"],
      ["revoked", "agent"],
    ])
      s.store.db
        .prepare(
          "INSERT INTO devices(id,public_key,name,created_at,connection_kind) VALUES(?,?,?,1,?)",
        )
        .run(id, id, id, kind);
    s.store.db.exec("UPDATE devices SET revoked_at=1 WHERE id='revoked'");
    s.store.seedUser({
      username: "operator",
      password: "limit-tests-password1",
      role: "ops",
      deviceScope: "*",
    });
    const ops = (
      await api(
        "POST",
        "/login",
        { username: "operator", password: "limit-tests-password1" },
        "",
      )
    ).body.access_token;
    for (const method of ["GET", "PUT"])
      assert.equal(
        (
          await api(
            method,
            path,
            method === "PUT" ? { v: 1, revision: 0, limit: 6 } : undefined,
            ops,
          )
        ).status,
        403,
      );
    for (const id of ["missing", "revoked"])
      assert.equal(
        (await api("GET", `/devices/${id}/terminal-limit`)).status,
        404,
      );
    const initial = (await read()).body;
    assertValid("device-terminal-limit", initial);
    assert.deepEqual(
      [
        initial.limit,
        initial.global_limit,
        initial.effective_limit,
        initial.source,
        initial.revision,
      ],
      [null, 4, 4, "global", 0],
    );
    assert.equal(
      s.store.db
        .prepare("SELECT count(*) AS n FROM device_terminal_limits")
        .get()!.n,
      0,
      "old and new devices inherit without adding rows",
    );
    for (const limit of [0, 129, 2.5, "6", false, undefined])
      assert.equal((await save(limit, 0)).status, 400);
    assert.equal(
      (
        await api("PUT", path, {
          v: 1,
          revision: 0,
          limit: 6,
          ssh: { port: 22 },
        })
      ).status,
      400,
    );
    const network = JSON.stringify(
      s.store.db.prepare("SELECT * FROM system_settings").all(),
    );
    const first = await save(6, 0);
    assert.equal(first.status, 200);
    assertValid("device-terminal-limit", first.body);
    assert.equal(first.body.effective_limit, 6);
    await global(2);
    assert.equal((await read()).body.effective_limit, 6);
    const other = (await api("GET", "/devices/two/terminal-limit")).body;
    assert.equal(other.effective_limit, 2);
    assert.equal(other.limit, null);
    assert.equal((await save(5, 0)).status, 409);
    const audit = s.store.audit;
    s.store.audit = function (action, ...args) {
      if (action === "device.terminal_limit_updated")
        throw new Error("audit failed");
      return audit.call(this, action, ...args);
    };
    assert.equal((await save(null, 1)).status, 500);
    s.store.audit = audit;
    assert.equal((await read()).body.limit, 6);
    assert.equal((await read()).body.revision, 1);
    const reset = await save(null, 1);
    assert.equal(reset.status, 200);
    assert.deepEqual(
      [reset.body.limit, reset.body.effective_limit, reset.body.revision],
      [null, 2, 2],
    );
    await global(3);
    assert.equal((await read()).body.effective_limit, 3);
    assert.equal(
      (await save(6, 0)).status,
      409,
      "reset retains the revision rather than allowing an old draft to recreate the row",
    );
    const race = await Promise.all([save(7, 2), save(8, 2)]);
    assert.deepEqual(race.map((r) => r.status).sort(), [200, 409]);
    const saved = (await read()).body;
    assertValid("audit-response", (await api("GET", "/audit")).body);
    assert.equal(
      JSON.stringify(s.store.db.prepare("SELECT * FROM system_settings").all()),
      network,
    );
    await s.close();
    s = await buildServer(config);
    assert.deepEqual((await read()).body, saved);
    assert.equal(
      (await api("GET", "/devices/two/terminal-limit")).body.effective_limit,
      3,
    );
  } finally {
    await s.close();
  }
});
