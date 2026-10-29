import { after, test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { buildServer } from "../src/server.js";
import { assertValid } from "../../../tests/contracts/validate.mjs";
const root = mkdtempSync(join(tmpdir(), "farhelm-forwarding-policy-"));
after(() => rmSync(root, { recursive: true, force: true }));
execFileSync("bash", ["../../deploy/dev/generate-tls.sh", join(root, "tls")], {
  stdio: "ignore",
});
test("device forwarding is default-off, admin-only, strict, atomic, revisioned and persistent", async () => {
  const password = "forwarding-policy-password1";
  const config = {
    dataDir: join(root, "data"),
    tlsCert: join(root, "tls/server.crt"),
    tlsKey: join(root, "tls/server.key"),
    adminUsername: "admin",
    adminPassword: password,
  };
  let s = await buildServer(config),
    auth = "";
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
  const path = "/devices/one/forwarding",
    read = () => api("GET", path),
    save = (enabled: any, revision: number) =>
      api("PUT", path, { v: 1, revision, enabled });
  try {
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
    // Simulate a database from before the policy was added: existing devices must stay off.
    s.store.db.exec("DROP TABLE device_forwarding");
    await s.close();
    s = await buildServer(config);
    auth = (await api("POST", "/login", { username: "admin", password }, ""))
      .body.access_token;
    s.store.seedUser({
      username: "ops",
      password,
      role: "ops",
      deviceScope: "*",
    });
    const ops = (await api("POST", "/login", { username: "ops", password }, ""))
      .body.access_token;
    for (const method of ["GET", "PUT"]) {
      const body =
        method === "PUT" ? { v: 1, revision: 0, enabled: true } : undefined;
      assert.equal((await api(method, path, body, ops)).status, 403);
      assert.equal((await api(method, path, body, "")).status, 401);
      for (const id of ["missing", "revoked"])
        assert.equal(
          (await api(method, `/devices/${id}/forwarding`, body)).status,
          404,
        );
    }
    const initial = (await read()).body;
    assertValid("device-forwarding", initial);
    assert.deepEqual(initial, {
      v: 1,
      device_id: "one",
      enabled: false,
      revision: 0,
      updated_at: null,
    });
    assert.equal(
      (await api("GET", "/devices/two/forwarding")).body.enabled,
      false,
    );
    for (const enabled of [0, 1, "true", "false", null, undefined, {}, []])
      assert.equal((await save(enabled, 0)).status, 400);
    assert.equal(
      (await api("PUT", path, { v: 1, revision: 0, enabled: true, ssh: {} }))
        .status,
      400,
    );
    for (const revision of [-1, 0.5, "0", Number.MAX_SAFE_INTEGER])
      assert.equal((await save(true, revision as any)).status, 400);
    const first = await save(true, 0);
    assert.equal(first.status, 200);
    assertValid("device-forwarding", first.body);
    assert.equal(first.body.enabled, true);
    assert.equal(first.body.revision, 1);
    assert.deepEqual((await save(true, 1)).body, first.body);
    assert.equal((await save(false, 0)).status, 409);
    assert.equal(
      (await api("GET", "/devices/two/forwarding")).body.enabled,
      false,
    );
    const audit = s.store.audit;
    s.store.audit = function (action, ...args) {
      if (action === "device.forwarding_updated")
        throw new Error("audit failed");
      return audit.call(this, action, ...args);
    };
    assert.equal((await save(false, 1)).status, 500);
    s.store.audit = audit;
    assert.deepEqual((await read()).body, first.body);
    const races = await Promise.all([save(false, 1), save(false, 1)]);
    assert.deepEqual(races.map((r) => r.status).sort(), [200, 409]);
    assert.equal((await read()).body.revision, 2);
    assert.equal((await save(true, 0)).status, 409);
    const saved = (await save(true, 2)).body;
    assertValid("audit-response", (await api("GET", "/audit")).body);
    assert.equal(
      s.store.db
        .prepare(
          "SELECT count(*) AS n FROM audit WHERE action='device.forwarding_updated'",
        )
        .get()!.n,
      3,
    );
    await s.close();
    s = await buildServer(config);
    assert.deepEqual((await read()).body, saved);
    assert.equal(
      (await api("GET", "/devices/two/forwarding")).body.enabled,
      false,
    );
  } finally {
    await s.close();
  }
});
