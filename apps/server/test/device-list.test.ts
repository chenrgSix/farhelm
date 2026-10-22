import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { assertValid } from "../../../tests/contracts/validate.mjs";
import { buildServer } from "../src/server.js";

test("device list batches reads, preserves route/SSH projections and immediately applies scope and configuration changes", async () => {
  const root = mkdtempSync(join(tmpdir(), "farhelm-device-list-"));
  execFileSync(
    "bash",
    ["../../deploy/dev/generate-tls.sh", join(root, "tls")],
    { stdio: "ignore" },
  );
  const server = await buildServer({
    dataDir: join(root, "data"),
    tlsCert: join(root, "tls/server.crt"),
    tlsKey: join(root, "tls/server.key"),
    adminUsername: "admin",
    adminPassword: "list-test-password1",
  });
  try {
    const db = server.store.db;
    const reader = server.store.seedUser({
      username: "reader",
      password: "list-test-password1",
      role: "ops",
      deviceScope: ["device-0"],
    });
    server.store.transaction(() => {
      const insert = db.prepare(
        "INSERT INTO devices(id,public_key,name,created_at) VALUES(?,?,?,?)",
      );
      for (let i = 0; i < 500; i++)
        insert.run(`device-${i}`, `key-${i}`, `Device ${i}`, i);
      db.prepare(
        "INSERT INTO device_connections(device_id,revision,config_json,secrets,updated_at,actor_id,last_checked_at,last_error) VALUES('device-0',1,?,'never-expose-this',1,?,123,NULL)",
      ).run(JSON.stringify({ host: "192.168.1.10", port: 22 }), reader.id);
      db.prepare(
        "INSERT INTO device_groups(id,name,description,created_at,updated_at) VALUES('group','Test group','',1,1)",
      ).run();
      db.prepare(
        "INSERT INTO device_group_members VALUES('device-0','group')",
      ).run();
      db.prepare("INSERT INTO agent_network VALUES('device-0',?,123)").run(
        JSON.stringify({ addresses: [{ address: "192.168.1.10" }] }),
      );
    });
    async function login(username: string) {
      const response = await server.app.inject({
        method: "POST",
        url: "/api/v1/login",
        payload: { username, password: "list-test-password1" },
      });
      assert.equal(response.statusCode, 200);
      return { authorization: "Bearer " + response.json().access_token };
    }
    const admin = await login("admin"),
      limited = await login("reader");
    const original = db.prepare;
    let queries = 0;
    db.prepare = function (...args) {
      queries++;
      return original.apply(this, args);
    };
    let response;
    try {
      response = await server.app.inject({
        url: "/api/v1/devices",
        headers: admin,
      });
    } finally {
      db.prepare = original;
    }
    assert.equal(response.statusCode, 200);
    assert.equal(response.json().devices.length, 500);
    assert.ok(
      queries < 30,
      `Expected bounded batched SQL reads; got ${queries}`,
    );
    assert.ok(!response.body.includes("never-expose-this"));
    const full = response.json().devices;
    async function page(query: string, headers = admin) {
      const r = await server.app.inject({
        url: `/api/v1/devices?${query}`,
        headers,
      });
      assert.equal(r.statusCode, 200, r.body);
      assertValid("devices-response", r.json());
      return r.json();
    }
    const firstPage = await page("page=1&limit=50");
    assert.deepEqual(firstPage.devices, full.slice(0, 50));
    assert.deepEqual(firstPage.page, {
      number: 1,
      limit: 50,
      total: 500,
      pages: 10,
      visible_total: 500,
      groups: [{ id: "group", name: "Test group" }],
    });
    const secondPage = await page("page=2&limit=50");
    assert.deepEqual(secondPage.devices, full.slice(50, 100));
    assert.deepEqual(
      (await page("page=999&limit=50")).devices,
      full.slice(450),
    );
    assert.equal((await page("q=no-such-device&page=99")).page.number, 1);
    assert.equal((await page("q=no-such-device")).page.total, 0);
    for (const q of ["DEVICE-0", "192.168.1.10", "test group"])
      assert.deepEqual(
        (await page(`q=${encodeURIComponent(q)}`)).devices.map(
          (d: any) => d.id,
        ),
        ["device-0"],
      );
    assert.equal((await page("q=%25")).page.total, 0);
    assert.equal((await page("q=%27%20OR%201%3D1--")).page.total, 0);
    assert.equal((await page("group=group&q=device-1")).page.total, 0);
    assert.equal((await page("group=__ungrouped__")).page.total, 499);
    assert.equal((await page("group=missing")).page.total, 0);
    const scopedPage = await page("page=2&limit=25", limited);
    assert.equal(scopedPage.page.visible_total, 1);
    assert.equal(scopedPage.page.total, 1);
    assert.equal(scopedPage.page.number, 1);
    assert.deepEqual(
      scopedPage.devices.map((d: any) => d.id),
      ["device-0"],
    );
    assert.equal((await page("q=device-1", limited)).page.total, 0);
    for (const invalid of [
      "page=0",
      "page=-1",
      "page=1.5",
      "page=9007199254740992",
      "limit=101",
      "limit=0",
      "page=1&page=2",
      "q=" + "x".repeat(257),
      "group=" + "x".repeat(129),
      "unknown=1",
    ])
      assert.equal(
        (
          await server.app.inject({
            url: `/api/v1/devices?${invalid}`,
            headers: admin,
          })
        ).statusCode,
        400,
        invalid,
      );
    async function options(query = "", headers = admin) {
      const r = await server.app.inject({
        url: `/api/v1/device-options${query ? "?" + query : ""}`,
        headers,
      });
      assert.equal(r.statusCode, 200, r.body);
      assertValid("device-options-response", r.json());
      for (const item of r.json().devices)
        assert.deepEqual(Object.keys(item).sort(), [
          "connection_kind",
          "id",
          "name",
          "revoked_at",
        ]);
      return r.json();
    }
    assert.equal((await options()).devices.length, 50);
    assert.deepEqual(
      (await options("page=2&limit=25")).devices.map((d: any) => d.id),
      full.slice(25, 50).map((d: any) => d.id),
    );
    assert.deepEqual(
      (await options("q=192.168.1.10")).devices.map((d: any) => d.id),
      ["device-0"],
    );
    assert.equal((await options("group=__ungrouped__")).page.total, 499);
    const chosen = encodeURIComponent(
      JSON.stringify(["device-0", "device-1", "missing"]),
    );
    assert.deepEqual(
      (await options(`ids=${chosen}`, limited)).devices.map((d: any) => d.id),
      ["device-0"],
    );
    assert.equal((await options("ids=[]")).page.total, 0);
    for (const invalid of [
      "purpose=invalid",
      "ids=oops",
      "ids={}",
      "ids=" + encodeURIComponent(JSON.stringify(Array(51).fill("device-0"))),
      "ids=%5B1%5D",
      "page=0",
      "limit=101",
      "purpose=exec&purpose=read",
    ])
      assert.equal(
        (
          await server.app.inject({
            url: `/api/v1/device-options?${invalid}`,
            headers: admin,
          })
        ).statusCode,
        400,
        invalid,
      );
    assert.equal(
      (await server.app.inject({ url: "/api/v1/device-options" })).statusCode,
      401,
    );
    const first = response.json().devices[0];
    assert.equal(first.terminal_backend, "ssh");
    assert.equal(first.ssh_status, "connected");
    assert.equal(first.business_healthy, null);
    assert.deepEqual(first.ip_addresses, ["192.168.1.10"]);
    assert.deepEqual(first.device_groups, [
      { id: "group", name: "Test group" },
    ]);
    const detail = await server.app.inject({
      url: "/api/v1/devices/device-0",
      headers: limited,
    });
    assert.equal(detail.statusCode, 200);
    assertValid("device", detail.json());
    assert.deepEqual(detail.json(), first);
    assert.equal(
      (
        await server.app.inject({
          url: "/api/v1/devices/device-1",
          headers: limited,
        })
      ).statusCode,
      403,
    );
    assert.equal(
      (
        await server.app.inject({
          url: "/api/v1/devices/missing",
          headers: admin,
        })
      ).statusCode,
      404,
    );
    assert.equal(
      (await server.app.inject({ url: "/api/v1/devices/device-0" })).statusCode,
      401,
    );
    const route = await server.app.inject({
      url: "/api/v1/devices/device-0/network-route",
      headers: limited,
    });
    const { v, device_id, ...snapshot } = route.json();
    assert.deepEqual(first.network_route, snapshot);
    assert.deepEqual(
      (await server.app.inject({ url: "/api/v1/devices", headers: limited }))
        .json()
        .devices.map((d: any) => d.id),
      ["device-0"],
    );
    db.prepare("UPDATE users SET device_scope='[\"device-1\"]' WHERE id=?").run(
      reader.id,
    );
    assert.deepEqual(
      (await server.app.inject({ url: "/api/v1/devices", headers: limited }))
        .json()
        .devices.map((d: any) => d.id),
      ["device-1"],
    );
    assert.equal(
      (
        await server.app.inject({
          url: "/api/v1/devices/device-0",
          headers: limited,
        })
      ).statusCode,
      403,
    );
    const newScope = await page("page=1", limited);
    assert.equal(newScope.page.total, 1);
    assert.deepEqual(newScope.page.groups, []);
    assert.deepEqual(
      (await options(`ids=${chosen}`, limited)).devices.map((d: any) => d.id),
      ["device-1"],
    );
    assert.deepEqual((await options("page=1", limited)).page.groups, []);

    assert.deepEqual(
      newScope.devices.map((d: any) => d.id),
      ["device-1"],
    );
    db.prepare("UPDATE devices SET created_at=1").run();
    const tied = (
      await server.app.inject({ url: "/api/v1/devices", headers: admin })
    ).json().devices;
    assert.deepEqual(
      (await page("page=2&limit=100")).devices,
      tied.slice(100, 200),
    );
    db.prepare("UPDATE devices SET name='literal_%' WHERE id='device-1'").run();
    assert.equal((await page("q=literal_%25")).page.total, 1);
    db.prepare(
      "UPDATE devices SET agent_version='UniqueVersion' WHERE id='device-1'",
    ).run();
    assert.equal((await page("q=uniqueversion")).page.total, 1);

    db.prepare(
      "UPDATE device_connections SET config_json='{}' WHERE device_id='device-0'",
    ).run();
    db.prepare("UPDATE devices SET revoked_at=1 WHERE id='device-0'").run();
    const updated = (
      await server.app.inject({ url: "/api/v1/devices", headers: admin })
    ).json().devices[0];
    assert.equal(updated.ssh_configured, false);
    assert.equal(updated.terminal_backend, null);
    assert.equal(updated.control_online, false);
    db.prepare(
      "UPDATE devices SET connection_kind='ssh' WHERE id='device-1'",
    ).run();
    const execChoices = await options(
      `purpose=exec&ids=${encodeURIComponent(JSON.stringify(["device-0", "device-1", "device-2"]))}`,
    );
    assert.deepEqual(
      execChoices.devices.map((d: any) => d.id),
      ["device-2"],
    );
    assert.equal((await options(`ids=${chosen}`)).devices.length, 2);
  } finally {
    await server.app.close();
    rmSync(root, { recursive: true, force: true });
  }
});
