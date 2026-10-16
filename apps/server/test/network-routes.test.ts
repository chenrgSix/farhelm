import test from "node:test";
import assert from "node:assert/strict";
import {
  privateIP,
  validatePolicy,
  registerNetworkRoutes,
} from "../src/network-routes.js";
import { parseEasyTier } from "../src/easytier.js";
import { Store } from "../src/store.js";
import Fastify from "fastify";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
const policy = {
  mode: "private_only",
  agent: { vpn_url: "https://10.144.1.1:8443", public_url: null },
  ssh: null,
};
test("private routes reject DNS and public addresses, URL credentials and forbidden fallback", () => {
  for (const ip of [
    "10.1.2.3",
    "172.16.0.1",
    "192.168.2.1",
    "100.64.1.1",
    "fd00::1",
  ])
    assert.ok(privateIP(ip));
  for (const ip of [
    "8.8.8.8",
    "example.com",
    "172.32.1.1",
    "::ffff:8.8.8.8",
    "169.254.169.254",
  ])
    assert.ok(!privateIP(ip));
  assert.deepEqual(validatePolicy(policy), policy);
  for (const vpn_url of [
    "https://vpn.example.com",
    "https://8.8.8.8",
    "https://user@10.1.2.3",
    "http://10.1.2.3",
    "https://10.1.2.3/path",
  ])
    assert.throws(() =>
      validatePolicy({ ...policy, agent: { vpn_url, public_url: null } }),
    );
  assert.throws(() =>
    validatePolicy({
      ...policy,
      agent: { ...policy.agent, public_url: "https://example.com" },
    }),
  );
  assert.throws(() =>
    validatePolicy({
      ...policy,
      ssh: {
        vpn_host: "10.1.2.4",
        vpn_port: 22,
        public_host: "example.com",
        public_port: 22,
      },
    }),
  );
});
test("TLS hostnames require a private pinned IP and cannot override literal URL IPs", () => {
  const p = {
    mode: "vpn_preferred",
    agent: {
      vpn_url: "https://fleet.example.com",
      vpn_ip: "10.1.2.3",
      public_url: "https://fleet.example.com",
    },
    ssh: null,
  };
  assert.deepEqual(validatePolicy(p), p);
  for (const vpn_ip of ["8.8.8.8", "vpn.example.com", "::ffff:10.1.2.3"]) {
    assert.throws(() =>
      validatePolicy({ ...p, agent: { ...p.agent, vpn_ip } }),
    );
  }
  assert.throws(() =>
    validatePolicy({
      ...p,
      agent: { ...p.agent, vpn_url: "https://10.1.2.4" },
    }),
  );
});
test("EasyTier state requires the actual egress interface and unambiguous destination routing", () => {
  const rows = [
    { ipv4: "10.1.1.1/24", path_len: 0 },
    {
      ipv4: "10.1.1.2/24",
      path_len: 1,
      path_len_lat_first: 1,
      next_hop_lat: 2.5,
    },
  ];
  assert.equal(parseEasyTier(rows, "10.1.1.2", ["10.1.1.1"]).state, "p2p");
  assert.equal(
    parseEasyTier(rows, "10.1.1.2", ["192.168.1.1"]).state,
    "unknown",
  );
  rows[1]!.path_len_lat_first = 2;
  assert.equal(parseEasyTier(rows, "10.1.1.2", ["10.1.1.1"]).state, "unknown");
  rows[1]!.path_len = 2;
  assert.equal(parseEasyTier(rows, "10.1.1.2", ["10.1.1.1"]).state, "relay");
  assert.equal(parseEasyTier(rows, "10.2.0.8", ["10.1.1.1"]).state, "unknown");
});
test("policy application is tied to a fresh authenticated connection, exact revision and approved endpoint", async () => {
  const store = new Store(mkdtempSync(join(tmpdir(), "farhelm-route-policy-")));
  store.db
    .prepare(
      "INSERT INTO devices(id,public_key,name,created_at) VALUES('d','key','device',1)",
    )
    .run();
  let session = "first",
    online = true;
  const app = Fastify();
  const routes = registerNetworkRoutes(app, {
    store,
    admin: () => {
      throw Error("unused");
    },
    reader: () => {
      throw Error("unused");
    },
    requireScope() {},
    requireDevice: () => ({ connection_kind: "agent" }),
    agent: () =>
      online
        ? { supported: true, connectionId: session, send: () => true }
        : undefined,
  });
  try {
    assert.equal(routes.allowed("d"), true);
    store.db
      .prepare("INSERT INTO device_network_routes VALUES(?,?,?,?)")
      .run("d", 1, JSON.stringify(policy), Date.now());
    assert.equal(routes.allowed("d"), false);
    const report = {
      revision: 1,
      channel: "vpn",
      endpoint: policy.agent.vpn_url,
      reason: null,
      easytier: { state: "unknown", latency_ms: null },
    };
    routes.receive("d", report);
    assert.equal(routes.allowed("d"), true);
    session = "reconnected";
    assert.equal(routes.allowed("d"), false);
    routes.receive("d", { ...report, revision: 0 });
    assert.equal(routes.allowed("d"), false);
    assert.throws(() =>
      routes.receive("d", {
        ...report,
        channel: "public",
        endpoint: "https://example.com",
      }),
    );
    routes.receive("d", report);
    assert.equal(routes.allowed("d"), true);
    online = false;
    assert.equal(routes.allowed("d"), false);
    assert.equal(routes.snapshot("d").agent?.connected, false);
  } finally {
    await app.close();
    store.close();
  }
});

async function globalFixture(agentEnabled = true, directory?: string) {
  const dir = directory ?? mkdtempSync(join(tmpdir(), "farhelm-global-route-")),
    store = new Store(dir),
    app = Fastify();
  const row = store.db
    .prepare("SELECT * FROM users WHERE username='admin'")
    .get();
  const admin = row
    ? store.user(row)
    : store.seedUser({
        username: "admin",
        password: "network-tests1",
        role: "admin",
        deviceScope: "*",
      });
  const sent: { id: string; type: string; body: any }[] = [];
  const get = (id: string) => {
    const row = store.db.prepare("SELECT * FROM devices WHERE id=?").get(id);
    if (!row) throw Error("missing device");
    return row;
  };
  const routes = registerNetworkRoutes(app, {
    store,
    agentEnabled,
    admin(req) {
      if (req.headers.authorization !== "admin")
        throw Object.assign(Error("forbidden"), { statusCode: 403 });
      return admin;
    },
    reader: () => admin,
    requireScope(_u, id) {
      if (id === "denied")
        throw Object.assign(Error("scope"), { statusCode: 403 });
    },
    requireDevice: get,
    agent(id) {
      return {
        supported: true,
        connectionId: id,
        send(type, body) {
          sent.push({ id, type, body });
          return true;
        },
      };
    },
  });
  const api = (
    method: "GET" | "PUT",
    path: string,
    body?: any,
    auth = "admin",
  ) =>
    app.inject({
      method,
      url: "/api/v1" + path,
      payload: body,
      headers: { authorization: auth },
    });
  function device(id: string, kind = "agent", sshHost?: string) {
    store.db
      .prepare(
        "INSERT INTO devices(id,public_key,name,created_at,connection_kind) VALUES(?,?,?,?,?)",
      )
      .run(id, id, id, 1, kind);
    if (sshHost)
      store.db
        .prepare(
          "INSERT INTO device_connections(device_id,revision,config_json,secrets,updated_at,actor_id) VALUES(?,1,?,'unused',1,?)",
        )
        .run(
          id,
          JSON.stringify({
            host: sshHost,
            port: 2222,
            username: "root",
            fingerprint: "fingerprint",
          }),
          admin.id,
        );
  }
  return {
    dir,
    store,
    app,
    routes,
    api,
    device,
    sent,
    admin,
    close: async () => {
      await app.close();
      store.close();
    },
  };
}
const commonSettings = {
  enabled: true,
  mode: "vpn_preferred",
  agent: {
    vpn_url: "https://fleet.example.com",
    vpn_ip: "10.1.1.1",
    public_url: "https://fleet.example.com",
  },
};
test("one global save reaches all Agents and future devices; device IP cannot override platform or mode", async () => {
  const f = await globalFixture();
  try {
    f.device("one");
    f.device("two");
    f.device("denied");
    assert.equal(
      (await f.api("GET", "/settings/network", undefined, "ops")).statusCode,
      403,
    );
    assert.equal(
      (
        await f.api(
          "PUT",
          "/settings/network",
          { v: 1, revision: 0, settings: commonSettings },
          "ops",
        )
      ).statusCode,
      403,
    );
    assert.equal(
      (await f.api("GET", "/devices/denied/network-route")).statusCode,
      403,
    );
    const save = await f.api("PUT", "/settings/network", {
      v: 1,
      revision: 0,
      settings: commonSettings,
    });
    assert.equal(save.statusCode, 200, save.body);
    assert.equal(save.json().device_count, 3);
    for (const id of ["one", "two"]) {
      assert.deepEqual(
        f.routes.current(id).policy?.agent,
        commonSettings.agent,
      );
      assert.ok(
        f.sent.some(
          (s) => s.id === id && s.body.policy.agent.vpn_ip === "10.1.1.1",
        ),
      );
    }
    f.device("new");
    assert.deepEqual(
      f.routes.current("new").policy?.agent,
      commonSettings.agent,
    );
    const changed = await f.api("PUT", "/devices/one/network-route", {
      v: 1,
      revision: 0,
      vpn_ip: "10.1.1.99",
      ssh_port: null,
    });
    assert.equal(changed.statusCode, 200, changed.body);
    assert.equal(changed.json().addresses.vpn_ip, "10.1.1.99");
    assert.equal(changed.json().policy.agent.vpn_ip, "10.1.1.1");
    assert.equal(changed.json().source, "platform");
    assert.equal(
      (
        await f.api("PUT", "/devices/one/network-route", {
          v: 1,
          revision: 1,
          policy: null,
        })
      ).statusCode,
      400,
    );
    assert.equal(
      (
        await f.api("PUT", "/settings/network", {
          v: 1,
          revision: 0,
          settings: commonSettings,
        })
      ).statusCode,
      409,
    );
    assert.equal(
      (
        await f.api("PUT", "/devices/one/network-route", {
          v: 1,
          revision: 0,
          vpn_ip: "10.1.1.98",
          ssh_port: null,
        })
      ).statusCode,
      409,
    );
    f.store.db.exec(
      "CREATE TRIGGER fail_network_audit BEFORE INSERT ON audit WHEN NEW.action='network.platform_settings_updated' BEGIN SELECT RAISE(ABORT,'fail'); END;",
    );
    const failed = await f.api("PUT", "/settings/network", {
      v: 1,
      revision: 1,
      settings: { ...commonSettings, enabled: false },
    });
    assert.equal(failed.statusCode, 500);
    assert.equal(f.routes.current("one").policy?.mode, "vpn_preferred");
    assert.equal((await f.api("GET", "/settings/network")).json().revision, 1);
    f.store.db.exec("DROP TRIGGER fail_network_audit");
  } finally {
    await f.close();
  }
  const reopened = await globalFixture(true, f.dir);
  try {
    assert.equal(
      (await reopened.api("GET", "/settings/network")).json().revision,
      1,
    );
    assert.equal(reopened.routes.snapshot("one").addresses.vpn_ip, "10.1.1.99");
    assert.equal(
      reopened.routes.current("one").policy?.agent?.vpn_ip,
      "10.1.1.1",
    );
  } finally {
    await reopened.close();
  }
});
test("SSH-only settings need no HTTPS; missing machine IP never leaks through private-only mode", async () => {
  const f = await globalFixture(false);
  try {
    f.device("ssh", "ssh", "public.example.com");
    f.device("agent-with-ssh", "agent", "public.example.com");
    const settings = { enabled: true, mode: "vpn_preferred", agent: null };
    assert.equal(
      (await f.api("PUT", "/settings/network", { v: 1, revision: 0, settings }))
        .statusCode,
      200,
    );
    assert.equal(
      (await f.api("GET", "/settings/network")).json().pending_agents,
      0,
    );
    assert.equal(f.routes.snapshot("agent-with-ssh").blocked_reason, null);
    let p = f.routes.current("ssh").policy!;
    assert.equal(p.agent, null);
    assert.equal(p.ssh?.vpn_host, null);
    assert.equal(p.ssh?.public_host, "public.example.com");
    assert.equal(
      (
        await f.api("PUT", "/devices/ssh/network-route", {
          v: 1,
          revision: 0,
          vpn_ip: "10.1.1.2",
          ssh_port: 22,
        })
      ).statusCode,
      200,
    );
    p = f.routes.current("ssh").policy!;
    assert.equal(p.ssh?.vpn_host, "10.1.1.2");
    assert.equal(p.ssh?.vpn_port, 22);
    assert.equal(p.ssh?.public_port, 2222);
    assert.equal(
      (
        await f.api("PUT", "/settings/network", {
          v: 1,
          revision: 1,
          settings: { ...settings, mode: "private_only" },
        })
      ).statusCode,
      200,
    );
    assert.equal(
      (
        await f.api("PUT", "/devices/ssh/network-route", {
          v: 1,
          revision: 1,
          vpn_ip: null,
          ssh_port: null,
        })
      ).statusCode,
      200,
    );
    assert.equal(
      f.routes.snapshot("agent-with-ssh").blocked_reason,
      "SSH_VPN_IP_REQUIRED",
    );
    p = f.routes.current("ssh").policy!;
    assert.equal(p.ssh?.vpn_host, null);
    assert.equal(p.ssh?.public_host, null);
    assert.equal(
      f.routes.snapshot("ssh").blocked_reason,
      "SSH_VPN_IP_REQUIRED",
    );
    f.store.db
      .prepare(
        "UPDATE device_connections SET revision=revision+1,config_json=? WHERE device_id='ssh'",
      )
      .run(JSON.stringify({ host: "10.1.1.3", port: 22 }));
    assert.equal(f.routes.current("ssh").policy?.ssh?.vpn_host, "10.1.1.3");
  } finally {
    await f.close();
  }
});
test("old per-device policies remain until explicit global adoption, migrating machine IP but not platform IP", async () => {
  let f = await globalFixture();
  f.device("old", "agent", "public.example.com");
  const legacy = {
    mode: "private_only",
    agent: { vpn_url: "https://10.5.5.1", public_url: null },
    ssh: {
      vpn_host: "10.5.5.2",
      vpn_port: 22,
      public_host: null,
      public_port: null,
    },
  };
  f.store.db
    .prepare("INSERT INTO device_network_routes VALUES('old',7,?,1)")
    .run(JSON.stringify(legacy));
  f.store.db.exec(
    "DELETE FROM meta WHERE key='platform_network_addresses_v1'; DROP TABLE device_network_addresses;",
  );
  const dir = f.dir;
  await f.close();
  f = await globalFixture(true, dir);
  try {
    assert.deepEqual(f.routes.current("old"), { revision: 7, policy: legacy });
    const s = f.routes.snapshot("old");
    assert.equal(s.source, "legacy");
    assert.equal(s.addresses.vpn_ip, "10.5.5.2");
    assert.equal(
      (await f.api("GET", "/settings/network")).json().legacy_devices,
      1,
    );
    const clear = await f.api("PUT", "/devices/old/network-route", {
      v: 1,
      revision: s.address_revision,
      vpn_ip: null,
      ssh_port: null,
    });
    assert.equal(clear.statusCode, 200);
    assert.equal(clear.json().policy.ssh.vpn_host, null);
    assert.equal(clear.json().blocked_reason, "SSH_VPN_IP_REQUIRED");
    const restore = await f.api("PUT", "/devices/old/network-route", {
      v: 1,
      revision: clear.json().address_revision,
      vpn_ip: "10.5.5.2",
      ssh_port: 22,
    });
    assert.equal(restore.statusCode, 200);
    assert.equal(restore.json().policy.mode, "private_only");
    assert.deepEqual(restore.json().policy.agent, legacy.agent);
    assert.equal(
      (
        await f.api("PUT", "/settings/network", {
          v: 1,
          revision: 0,
          settings: commonSettings,
        })
      ).statusCode,
      200,
    );
    assert.equal(f.routes.current("old").revision, 10);
    assert.equal(f.routes.current("old").policy?.agent?.vpn_ip, "10.1.1.1");
    assert.equal(f.routes.current("old").policy?.ssh?.vpn_host, "10.5.5.2");
    assert.equal(f.routes.snapshot("old").source, "platform");
  } finally {
    await f.close();
  }
});
