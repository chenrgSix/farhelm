import { after, test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { createServer } from "node:net";
import { buildServer } from "../src/server.js";
import { sourcePolicy, sourceAllowed } from "../src/tcp-mapping-policy.js";
import { assertValid } from "../../../tests/contracts/validate.mjs";
const root = mkdtempSync(join(tmpdir(), "farhelm-mappings-"));
after(() => rmSync(root, { recursive: true, force: true }));
execFileSync("bash", ["../../deploy/dev/generate-tls.sh", join(root, "tls")], {
  stdio: "ignore",
});
async function freePort() {
  const server = createServer();
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as any).port;
  await new Promise<void>((resolve) => server.close(() => resolve()));
  return port;
}
test("source allowlist checks IPv4, IPv6, mapped IPv4 and exact CIDR boundaries", () => {
  const list = sourcePolicy(["192.168.1.0/24", "2001:db8:1::/64", "::1"]);
  for (const address of [
    "192.168.1.0",
    "192.168.1.255",
    "::ffff:192.168.1.20",
    "::ffff:c0a8:114",
    "2001:db8:1::abcd",
    "::1",
  ])
    assert.equal(sourceAllowed(list, address), true, address);
  for (const address of [
    "192.168.2.1",
    "192.168.0.255",
    "2001:db8:2::1",
    "127.0.0.1",
    "bad",
    "",
  ])
    assert.equal(sourceAllowed(list, address), false, address);
  for (const input of [
    [],
    ["example.com"],
    ["127.0.0.1/33"],
    ["::1/129"],
    ["::1/-1"],
    ["127.0.0.1/"],
    ["127.0.0.1/0/1"],
    ["fe80::1%lo0"],
    ["*"],
    [null],
    Array(65).fill("::1"),
  ])
    assert.throws(() => sourcePolicy(input));
});
test(
  "web mappings enforce admin, device switch, strict input, revisions, atomic audit, listener conflicts and restart recovery",
  { timeout: 20000 },
  async () => {
    const password = "mapping-api-password1",
      config = {
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
      payload?: any,
      token = auth,
    ) => {
      const response = await s.app.inject({
        method: method as any,
        url: "/api/v1" + path,
        headers: token ? { authorization: "Bearer " + token } : {},
        payload,
      });
      return { status: response.statusCode, body: response.json() };
    };
    const path = "/devices/one/tcp-mappings";
    const port = await freePort(),
      body = {
        v: 1,
        name: "db",
        enabled: false,
        listen_host: "127.0.0.1",
        listen_port: port,
        target_host: "database.internal",
        target_port: 1433,
        source_cidrs: ["127.0.0.1"],
      };
    try {
      await s.app.listen({ host: "127.0.0.1", port: 0 });
      s.store.db
        .prepare(
          "INSERT INTO devices(id,public_key,name,created_at,connection_kind) VALUES('one','one','one',1,'agent'),('two','two','two',1,'ssh')",
        )
        .run();
      auth = (await api("POST", "/login", { username: "admin", password })).body
        .access_token;
      s.store.seedUser({
        username: "ops",
        password,
        role: "ops",
        deviceScope: "*",
      });
      const ops = (await api("POST", "/login", { username: "ops", password }))
        .body.access_token;
      assert.equal((await api("GET", path, undefined, "")).status, 401);
      assert.equal(
        (await api("POST", path, { ...body, enabled: true })).status,
        403,
      );
      assert.equal(
        (await api("GET", "/devices/missing/tcp-mappings")).status,
        404,
      );
      for (const change of [
        { source_cidrs: [] },
        { source_cidrs: ["host"] },
        { listen_host: "localhost" },
        { listen_port: 22 },
        { listen_port: 0 },
        { target_port: 0 },
        { target_host: "bad host" },
        { enabled: "true" },
        { owner_id: "ops" },
        { name: "\n" },
      ])
        assert.equal(
          (await api("POST", path, { ...body, ...change })).status,
          400,
        );
      const created = await api("POST", path, body);
      assert.equal(created.status, 200);
      assertValid("tcp-mapping-response", created.body);
      const id = created.body.mapping.id,
        item = path + "/" + id;
      for (const [method, url, payload] of [
        ["GET", path, undefined],
        ["POST", path, body],
        ["PUT", item, { ...body, revision: 1 }],
        ["DELETE", item, { v: 1, revision: 1 }],
      ] as const)
        assert.equal((await api(method, url, payload, ops)).status, 403);
      assert.equal(
        (
          await api("PUT", `/devices/two/tcp-mappings/${id}`, {
            ...body,
            revision: 1,
          })
        ).status,
        404,
      );
      assert.equal(
        (await api("PUT", item, { ...body, revision: 0 })).status,
        400,
      );
      assert.equal(
        (
          await api("PUT", "/devices/one/forwarding", {
            v: 1,
            revision: 0,
            enabled: true,
          })
        ).status,
        200,
      );
      const audit = s.store.audit;
      s.store.audit = function (action, ...args) {
        if (action === "mapping.updated") throw new Error("audit failed");
        return audit.call(this, action, ...args);
      };
      assert.equal(
        (await api("PUT", item, { ...body, enabled: true, revision: 1 }))
          .status,
        500,
      );
      s.store.audit = audit;
      assert.deepEqual(
        (await api("GET", path)).body.mappings[0],
        created.body.mapping,
      );
      const enabled = await api("PUT", item, {
        ...body,
        enabled: true,
        revision: 1,
      });
      assert.equal(enabled.status, 200, JSON.stringify(enabled.body));
      assert.equal(enabled.body.mapping.status, "listening");
      assert.equal(
        (await api("PUT", item, { ...body, revision: 1 })).status,
        409,
      );
      assert.equal(
        (await api("POST", path, { ...body, enabled: true })).body.error,
        "MAPPING_PORT_IN_USE",
      );
      const revision = enabled.body.mapping.revision;
      const race = await Promise.all([
        api("PUT", item, { ...body, enabled: true, revision, name: "first" }),
        api("PUT", item, { ...body, enabled: true, revision, name: "second" }),
      ]);
      assert.deepEqual(race.map((r) => r.status).sort(), [200, 409]);
      const saved = (await api("GET", path)).body.mappings[0];
      assertValid("tcp-mapping-list", (await api("GET", path)).body);
      assertValid("audit-response", (await api("GET", "/audit")).body);
      await s.close();
      s = await buildServer(config);
      await s.app.listen({ host: "127.0.0.1", port: 0 });
      for (
        let i = 0;
        i < 100 &&
        (await api("GET", path)).body.mappings[0].status !== "listening";
        i++
      )
        await new Promise((r) => setTimeout(r, 10));
      assert.deepEqual((await api("GET", path)).body.mappings[0], saved);
      assert.equal(
        (await api("DELETE", item, { v: 1, revision: 1 })).status,
        409,
      );
      assert.equal(
        (await api("DELETE", item, { v: 1, revision: saved.revision })).status,
        200,
      );
      assert.deepEqual((await api("GET", path)).body.mappings, []);
      assertValid("audit-response", (await api("GET", "/audit")).body);
    } finally {
      await s.close();
    }
  },
);
