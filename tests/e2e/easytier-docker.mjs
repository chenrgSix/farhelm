// Isolated Linux collectors + a separate real EasyTier container. Never changes
// the host's VPN, Docker socket permissions, users or existing containers.
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdtempSync, writeFileSync, mkdirSync, copyFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve, join } from "node:path";
const exec = promisify(execFile);
const root = resolve(import.meta.dirname, "../..");
const temp = mkdtempSync(join(tmpdir(), "farhelm-et-docker-"));
const prefix = `farhelm-et-${process.pid}`,
  network = `${prefix}-net`;
const hub = `${prefix}-hub`,
  left = `${prefix}-left`,
  right = `${prefix}-right`;
const collector = `${prefix}-collector`,
  isolated = `${prefix}-isolated`;
const image = "farhelm-easytier-docker-test:local";
const containers = [];
let createdNetwork = false;
async function docker(...args) {
  return (
    await exec("docker", args, { timeout: 60000, maxBuffer: 4 * 1024 * 1024 })
  ).stdout.trim();
}
async function until(fn, label) {
  const end = Date.now() + 60000;
  while (Date.now() < end) {
    if (await fn()) return;
    await new Promise((r) => setTimeout(r, 500));
  }
  throw Error("Timed out: " + label);
}
async function start(name, args = []) {
  await docker("run", "-d", "--rm", "--init", "--name", name, ...args, image);
  containers.push(name);
}
async function et(name, ip, peer, relay = false) {
  await docker(
    "exec",
    "-d",
    name,
    "sh",
    "-c",
    'echo $$ > /tmp/et.pid; exec easytier-core "$@" > /tmp/et.log 2>&1',
    "sh",
    "-i",
    ip,
    "--network-name",
    prefix,
    "--network-secret",
    "isolated-test-only",
    "--rpc-portal",
    "127.0.0.1:15889",
    "--disable-ipv6",
    ...(peer ? ["-p", `tcp://${peer}:11010`] : []),
    ...(relay ? ["--disable-p2p"] : []),
  );
}
const defaults = {
  FLEET_EASYTIER_CLI: "/opt/custom-et/cli",
  FLEET_EASYTIER_RPC: "127.0.0.1:15889",
  FLEET_EASYTIER_CONTAINER: left,
};
async function observe(language, env = {}, name = collector) {
  const variables = { ...defaults, ...env };
  const args = Object.entries(variables).flatMap(([key, value]) => [
    "-e",
    `${key}=${value}`,
  ]);
  const command =
    language === "node"
      ? ["node", "/fixture/observe.mjs"]
      : ["/fixture/easytier-observe"];
  return JSON.parse(
    await docker("exec", ...args, name, ...command, "10.144.88.2"),
  );
}
async function expectBoth(state, env = {}, name = collector) {
  for (const language of ["node", "rust"]) {
    const actual = await observe(language, env, name);
    assert.equal(actual.state, state, `${language}: ${JSON.stringify(actual)}`);
  }
}
try {
  copyFileSync(
    process.env.FLEET_EASYTIER_PROBE_BIN ??
      join(root, ".dev/easytier-verification/easytier-observe"),
    join(temp, "easytier-observe"),
  );
  writeFileSync(
    join(temp, "observe.mjs"),
    'import { observeEasyTier } from "/workspace/apps/server/dist/easytier.js"; console.log(JSON.stringify(await observeEasyTier(process.argv[2])));\n',
  );
  const endpoint =
    process.env.DOCKER_HOST ||
    (await docker(
      "context",
      "inspect",
      "--format",
      "{{.Endpoints.docker.Host}}",
    ));
  assert.ok(
    endpoint.startsWith("unix://"),
    "isolated test requires an explicitly local Docker socket",
  );
  await docker("network", "create", network);
  createdNetwork = true;
  for (const name of [hub, left, right])
    await start(name, [
      "--network",
      network,
      "--cap-add",
      "NET_ADMIN",
      "--device",
      "/dev/net/tun",
    ]);
  const hubIP = await docker(
    "inspect",
    "--format",
    "{{range .NetworkSettings.Networks}}{{.IPAddress}}{{end}}",
    hub,
  );
  await et(hub, "10.144.88.3");
  await et(left, "10.144.88.1", hubIP);
  await et(right, "10.144.88.2", hubIP);
  await docker(
    "exec",
    left,
    "sh",
    "-c",
    "mkdir -p /opt/custom-et; printf '#!/bin/sh\nid -u > /tmp/collector-uid\nexec /usr/local/bin/easytier-cli \"$@\"\n' > /opt/custom-et/cli; chmod 755 /opt/custom-et/cli",
  );
  // Grant socket access only to these disposable test collectors via a group.
  // The production collector never grants this access or changes its identity.
  const socketMount = [
    "--mount",
    `type=bind,source=${endpoint.slice(7)},target=/var/run/docker.sock`,
  ];
  const socketGid = await docker(
    "run",
    "--rm",
    ...socketMount,
    "--entrypoint",
    "stat",
    image,
    "-c",
    "%g",
    "/var/run/docker.sock",
  );
  for (const [name, net] of [
    [collector, `container:${left}`],
    [isolated, network],
  ]) {
    await start(name, [
      "--network",
      net,
      "--user",
      "501:20",
      "--group-add",
      socketGid,
      "--security-opt",
      "no-new-privileges:true",
      ...socketMount,
      "--mount",
      `type=bind,source=${temp},target=/fixture,readonly`,
      "--mount",
      `type=bind,source=${join(root, "apps/server")},target=/workspace/apps/server,readonly`,
    ]);
  }
  await until(
    async () => (await observe("node")).state === "p2p",
    "real EasyTier P2P",
  );
  await expectBoth("p2p");
  assert.equal(await docker("exec", left, "cat", "/tmp/collector-uid"), "501");
  await expectBoth("p2p", {
    FLEET_EASYTIER_CONTAINER: "",
    FLEET_EASYTIER_CLI: "/usr/local/bin/easytier-cli",
  });
  await expectBoth("unknown", {}, isolated);
  await expectBoth("unknown", { FLEET_EASYTIER_CONTAINER: right });
  await expectBoth("unknown", { FLEET_EASYTIER_RPC: "127.0.0.1:15999" });
  // A valid EasyTier route table does not override the OS's selected egress.
  await docker(
    "exec",
    left,
    "ip",
    "route",
    "replace",
    "10.144.88.2/32",
    "via",
    hubIP,
    "dev",
    "eth0",
  );
  await expectBoth("unknown");
  await docker("exec", left, "ip", "route", "del", "10.144.88.2/32");
  await expectBoth("p2p");
  await docker(
    "exec",
    "--user",
    "0",
    collector,
    "sh",
    "-c",
    "touch /tmp/denied.sock; chmod 600 /tmp/denied.sock",
  );
  await expectBoth("unknown", { DOCKER_HOST: "unix:///tmp/denied.sock" });
  assert.equal(await docker("exec", collector, "id", "-u"), "501");
  // Container-side timeout must kill the actual hanging CLI, not just docker exec.
  await docker(
    "exec",
    left,
    "sh",
    "-c",
    "printf '#!/bin/sh\necho $$ > /tmp/hang.pid\nexec sleep 30\n' > /opt/custom-et/hang; chmod 755 /opt/custom-et/hang",
  );
  for (const language of ["node", "rust"]) {
    const start = Date.now();
    assert.equal(
      (await observe(language, { FLEET_EASYTIER_CLI: "/opt/custom-et/hang" }))
        .state,
      "unknown",
    );
    assert.ok(
      Date.now() - start < 10000,
      "hanging collector has a bounded duration",
    );
    await until(async () => {
      try {
        await docker(
          "exec",
          left,
          "sh",
          "-c",
          "test ! -e /proc/$(cat /tmp/hang.pid)",
        );
        return true;
      } catch {
        return false;
      }
    }, "timed out CLI is terminated and reaped");
  }
  await docker("exec", right, "sh", "-c", 'kill "$(cat /tmp/et.pid)"');
  await et(right, "10.144.88.2", hubIP, true);
  await until(
    async () => (await observe("node")).state === "relay",
    "real EasyTier relay",
  );
  await expectBoth("relay");
  mkdirSync(join(root, ".test-output"), { recursive: true });
  writeFileSync(
    join(root, ".test-output/easytier-docker.json"),
    JSON.stringify(
      {
        passed: true,
        realEasyTier: "2.6.4",
        collectors: ["TypeScript", "Rust"],
        uid: 501,
        customCliAndRpc: true,
        separateSharedNamespaceContainer: true,
        p2pAndRelay: true,
        wrongNamespaceUnknown: true,
        wrongEgressUnknown: true,
        deniedSocketNoElevation: true,
        innerTimeoutKillsProcess: true,
      },
      null,
      2,
    ) + "\n",
  );
  console.log(
    "EasyTier Docker integration passed: real P2P/relay, both collectors, UID preserved, wrong namespace/egress rejected, denied socket and timeout handled.",
  );
} catch (error) {
  for (const name of [left, right]) {
    if (containers.includes(name))
      console.error(
        name,
        await docker("exec", name, "tail", "-15", "/tmp/et.log").catch(
          () => "unavailable",
        ),
      );
  }
  throw error;
} finally {
  for (const name of containers.reverse())
    await docker("rm", "-f", name).catch(() => {});
  if (createdNetwork) await docker("network", "rm", network).catch(() => {});
}
