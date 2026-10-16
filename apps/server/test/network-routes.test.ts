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
