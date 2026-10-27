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
