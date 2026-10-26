import { test } from "node:test";
import assert from "node:assert/strict";
import {
  createEasyTierObserver,
  easyTierConfig,
  parseEasyTier,
} from "../src/easytier.js";

const table = [
  { ipv4: "10.1.1.1/24", path_len: 0 },
  {
    ipv4: "10.1.1.2/24",
    path_len: 1,
    path_len_lat_first: 1,
    next_hop_lat: 2.5,
  },
];
function fixture(
  overrides: {
    env?: NodeJS.ProcessEnv;
    boot?: string;
    net?: string;
    iface?: string;
    denied?: boolean;
  } = {},
) {
  const calls: [string, string[]][] = [];
  const env = overrides.env ?? {
    FLEET_EASYTIER_CONTAINER: "vpn-1",
    FLEET_EASYTIER_CLI: "/opt/easy tier/cli",
    FLEET_EASYTIER_RPC: "[::1]:15889",
  };
  const observe = createEasyTierObserver({
    env: () => env,
    platform: "linux",
    uid: 1001,
    gid: 1002,
    namespace: async () => ({ boot: "local-boot", net: "net:[123]" }),
    interfaces: () => ({
      tun0: [
        {
          address: "10.1.1.1",
          family: "IPv4",
          netmask: "255.255.255.0",
          cidr: "10.1.1.1/24",
          internal: false,
          mac: "00:00:00:00:00:00",
        },
      ],
    }),
    run: async (program, args) => {
      calls.push([program, args]);
      if (overrides.denied)
        throw Object.assign(new Error("denied"), {
          code: "EACCES",
          path: program,
        });
      if (program === "ip")
        return JSON.stringify([{ dev: overrides.iface ?? "tun0" }]);
      if (program === "docker" && args[8] === "cat")
        return overrides.boot ?? "local-boot\n";
      if (program === "docker" && args[8] === "readlink")
        return overrides.net ?? "net:[123]\n";
      return JSON.stringify(table);
    },
  });
  return { observe, calls, env };
}
test("EasyTier configuration accepts executable paths and RPC endpoints, rejecting shell commands and Docker options", () => {
  assert.deepEqual(easyTierConfig({}), {
    cli: "easytier-cli",
    rpc: "127.0.0.1:15888",
    container: undefined,
  });
  for (const rpc of ["127.0.0.1:15888", "[::1]:15889", "easy-tier.local:1234"])
    assert.doesNotThrow(() =>
      easyTierConfig({
        FLEET_EASYTIER_CLI: "/opt/easy tier/cli",
        FLEET_EASYTIER_RPC: rpc,
        FLEET_EASYTIER_CONTAINER: "vpn-1.test",
      }),
    );
  for (const cli of [
    "sudo easytier-cli",
    "./cli",
    "-bad",
    "/bin/cli\n",
    "/bin/cli\0",
  ])
    assert.throws(() => easyTierConfig({ FLEET_EASYTIER_CLI: cli }));
  for (const rpc of [
    "localhost",
    "http://localhost:80",
    "host:0",
    "host:65536",
    "[bad]:80",
    "host:80/",
    "a b:80",
    "host:-1",
  ])
    assert.throws(() => easyTierConfig({ FLEET_EASYTIER_RPC: rpc }));
  for (const container of ["--privileged", "a b", "a;id", "/vpn", "a\n"])
    assert.throws(() =>
      easyTierConfig({ FLEET_EASYTIER_CONTAINER: container }),
    );
});
test("Docker collection uses the collector UID/GID, fixed argv and an inner timeout, and checks the local egress", async () => {
  const f = fixture();
  assert.deepEqual(await f.observe("10.1.1.2"), {
    state: "p2p",
    latency_ms: 2.5,
  });
  assert.deepEqual(f.calls, [
    [
      "docker",
      [
        "exec",
        "--user",
        "1001:1002",
        "vpn-1",
        "timeout",
        "-s",
        "KILL",
        "2",
        "cat",
        "/proc/sys/kernel/random/boot_id",
      ],
    ],
    [
      "docker",
      [
        "exec",
        "--user",
        "1001:1002",
        "vpn-1",
        "timeout",
        "-s",
        "KILL",
        "2",
        "readlink",
        "/proc/self/ns/net",
      ],
    ],
    [
      "docker",
      [
        "exec",
        "--user",
        "1001:1002",
        "vpn-1",
        "timeout",
        "-s",
        "KILL",
        "2",
        "/opt/easy tier/cli",
        "--rpc-portal",
        "[::1]:15889",
        "--output",
        "json",
        "route",
      ],
    ],
    ["ip", ["-j", "route", "get", "10.1.1.2"]],
  ]);
  assert.equal(
    (await fixture({ iface: "eth0" }).observe("10.1.1.2")).state,
    "unknown",
  );
});
test("different container namespaces, remote kernels and denied Docker access stay unknown without fallback or privilege requests", async () => {
  for (const overrides of [
    { net: "net:[999]" },
    { boot: "remote-boot" },
    { denied: true },
  ]) {
    const f = fixture(overrides);
    assert.equal((await f.observe("10.1.1.2")).state, "unknown");
    assert.ok(
      f.calls.every(
        ([program, args]) => program === "docker" && !args.includes("route"),
      ),
    );
  }
});
test("native configuration and cache separate CLI paths, RPC endpoints and containers", async () => {
  const f = fixture({
    env: {
      FLEET_EASYTIER_CLI: "/opt/cli",
      FLEET_EASYTIER_RPC: "localhost:15889",
    },
  });
  assert.equal((await f.observe("10.1.1.2")).state, "p2p");
  assert.deepEqual(f.calls[0], [
    "/opt/cli",
    ["--rpc-portal", "localhost:15889", "--output", "json", "route"],
  ]);
  await f.observe("10.1.1.2");
  assert.equal(f.calls.filter(([p]) => p === "/opt/cli").length, 1);
  f.env.FLEET_EASYTIER_RPC = "localhost:15890";
  await f.observe("10.1.1.2");
  assert.equal(f.calls.filter(([p]) => p === "/opt/cli").length, 2);
  f.env.FLEET_EASYTIER_CLI = "/other/cli";
  await f.observe("10.1.1.2");
  assert.ok(f.calls.some(([p]) => p === "/other/cli"));
  f.env.FLEET_EASYTIER_CONTAINER = "vpn-2";
  await f.observe("10.1.1.2");
  assert.ok(f.calls.some(([p, args]) => p === "docker" && args[3] === "vpn-2"));
});
test("invalid config, unavailable routing and missing collectors never assert a path", async () => {
  const invalid = fixture({
    env: { FLEET_EASYTIER_CONTAINER: "--privileged" },
  });
  assert.equal((await invalid.observe("10.1.1.2")).state, "unknown");
  assert.equal(invalid.calls.length, 0);
  for (const container of ["", "vpn"]) {
    const observe = createEasyTierObserver({
      platform: "linux",
      uid: 1001,
      gid: 1002,
      env: () => ({
        FLEET_EASYTIER_CLI: "/custom/cli",
        FLEET_EASYTIER_CONTAINER: container,
      }),
      namespace: async () => ({ boot: "boot", net: "net:[1]" }),
      run: async (program) => {
        throw Object.assign(new Error("missing"), {
          code: "ENOENT",
          path: program,
        });
      },
    });
    assert.equal((await observe("10.1.1.2")).state, "not_detected");
    assert.equal((await observe("example.org")).state, "unknown");
  }
  const noRoute = createEasyTierObserver({
    platform: "linux",
    run: async (p) => (p === "ip" ? "[]" : JSON.stringify(table)),
  });
  assert.equal((await noRoute("10.1.1.2")).state, "unknown");
  const macDocker = createEasyTierObserver({
    platform: "darwin",
    env: () => ({ FLEET_EASYTIER_CONTAINER: "vpn" }),
    run: async () => {
      assert.fail("no Docker exec without Linux namespace evidence");
    },
  });
  assert.equal((await macDocker("10.1.1.2")).state, "unknown");
});

test("multiple local EasyTier entries cannot prove which instance owns the egress", () => {
  assert.equal(
    parseEasyTier(
      [...table, { ipv4: "10.9.9.1/24", path_len: 0 }],
      "10.1.1.2",
      ["10.1.1.1"],
    ).state,
    "unknown",
  );
});
