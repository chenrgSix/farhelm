// Real ACME HTTP-01 / TLS-ALPN-01, renewal and Linux Agent PTY, using an isolated Pebble CA.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { spawn, execFileSync } from "node:child_process";
import { once } from "node:events";
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve, join } from "node:path";
import { createServer as tcpServer } from "node:net";
import { request } from "node:https";
import { connect as tlsConnect, checkServerIdentity } from "node:tls";
import { createRequire } from "node:module";
import { buildServer } from "../../apps/server/dist/server.js";
const require = createRequire(import.meta.url);
const { Client: SSHClient } = require("../../apps/server/node_modules/ssh2");
const { WebSocket } = require("../../apps/server/node_modules/ws");
const root = resolve(import.meta.dirname, "../..");
if (!process.env.FLEET_ACME_TEST_CHILD) {
  const dir = mkdtempSync(join(tmpdir(), "farhelm-acme-"));
  execFileSync(
    "bash",
    [join(root, "deploy/dev/generate-tls.sh"), join(dir, "tls")],
    { stdio: "ignore" },
  );
  const child = spawn(process.execPath, [import.meta.filename], {
    stdio: "inherit",
    env: {
      ...process.env,
      FLEET_ACME_TEST_CHILD: dir,
      NODE_EXTRA_CA_CERTS: join(dir, "tls/ca.crt"),
      NO_PROXY: "localhost,127.0.0.1",
      no_proxy: "localhost,127.0.0.1",
    },
  });
  const [code] = await once(child, "exit");
  process.exit(code ?? 1);
}
const temp = process.env.FLEET_ACME_TEST_CHILD;
const ca = readFileSync(join(temp, "tls/ca.crt"));
const challengeType = process.env.FLEET_TEST_ACME_CHALLENGE ?? "http-01";
const tlsChallenge = challengeType === "tls-alpn-01";
assert.ok(["http-01", "tls-alpn-01"].includes(challengeType));
let occupiedHTTP;
const ipv6 = process.env.FLEET_TEST_ACME_IP === "6";
const ipMode = ipv6 || process.env.FLEET_TEST_ACME_IP === "1";
// Routed only within a disposable Docker network, never to this real public IP.
const domain = ipv6
    ? "2600:ffff:fa::14"
    : ipMode
      ? "11.222.33.14"
      : "fleet.example.com",
  password = "isolated-acme-test-password";
const pebble = `farhelm-acme-ca-${process.pid}`,
  agent = `farhelm-acme-agent-${process.pid}`;
const network = `farhelm-acme-ip-${process.pid}`,
  relay = `${network}-relay`;
let server, terminal, sshClient;
async function docker(args) {
  return new Promise((resolve, reject) => {
    const p = spawn("docker", args, { stdio: ["ignore", "pipe", "pipe"] });
    let output = "";
    p.stdout.on("data", (d) => (output += d));
    p.stderr.on("data", (d) => (output += d));
    p.on("error", reject);
    p.on("exit", (code) =>
      code === 0 ? resolve(output) : reject(Error(output)),
    );
  });
}
async function freePort() {
  const s = tcpServer();
  await new Promise((r) => s.listen(0, "127.0.0.1", r));
  const port = s.address().port;
  await new Promise((r) => s.close(r));
  return port;
}
async function until(fn, label, ms = 30000) {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    if (await fn()) return;
    await new Promise((r) => setTimeout(r, 200));
  }
  throw Error("Timed out: " + label);
}
function https(url, options = {}) {
  return new Promise((resolve, reject) => {
    const r = request(url, { ca, agent: false, ...options }, (res) => {
      const fingerprint = res.socket.getPeerX509Certificate()?.fingerprint256;
      let body = "";
      res.on("data", (b) => (body += b));
      res.on("end", () =>
        res.statusCode === 200
          ? resolve({ body, fingerprint })
          : reject(Error(`HTTP ${res.statusCode}: ${body}`)),
      );
    });
    r.setTimeout(5000, () => r.destroy(Error("HTTPS timeout")));
    r.on("error", reject);
    r.end();
  });
}
try {
  const caPort = await freePort(),
    managementPort = await freePort(),
    apiPort = await freePort(),
    challengePort = await freePort();
  if (ipMode) {
    await docker([
      "network",
      "create",
      "--internal",
      "--subnet",
      "11.222.33.0/24",
      ...(ipv6 ? ["--ipv6", "--subnet", "2600:ffff:fa::/64"] : []),
      network,
    ]);
    writeFileSync(
      join(temp, "relay.cjs"),
      `
      const net = require('node:net');
      for (const [port, target] of [${tlsChallenge ? `[443, ${apiPort}]` : `[80, ${challengePort}]`}, [${apiPort}, ${apiPort}]]) {
        net.createServer(client => {
          const upstream = net.connect(target, 'host.docker.internal');
          client.on('error', () => upstream.destroy());
          upstream.on('error', () => client.destroy());
          client.on('close', () => upstream.destroy());
          upstream.on('close', () => client.destroy());
          client.pipe(upstream).pipe(client);
        }).listen(port, '::');
      }
    `,
    );
    await docker([
      "run",
      "--rm",
      "-d",
      "--name",
      relay,
      "--add-host",
      "host.docker.internal:host-gateway",
      "--mount",
      `type=bind,source=${temp},target=/fixture,readonly`,
      "node:24-bookworm",
      "node",
      "/fixture/relay.cjs",
    ]);
    await docker([
      "network",
      "connect",
      ipv6 ? "--ip6" : "--ip",
      domain,
      network,
      relay,
    ]);
  }
  writeFileSync(
    join(temp, "pebble.json"),
    JSON.stringify({
      pebble: {
        listenAddress: "0.0.0.0:14000",
        managementListenAddress: "0.0.0.0:15000",
        certificate: "/fixture/tls/server.crt",
        privateKey: "/fixture/tls/server.key",
        httpPort: ipMode ? 80 : challengePort,
        tlsPort: ipMode ? 443 : apiPort,
        externalAccountBindingRequired: false,
        retryAfter: { authz: 1, order: 1 },
        profiles: {
          default: {
            description: "Default fixture",
            validityPeriod: ipMode ? 3600 : 80,
          },
          shortlived: {
            description: "IP shortlived fixture",
            validityPeriod: 80,
          },
        },
      },
    }),
  );
  await docker([
    "run",
    "--rm",
    "-d",
    "--name",
    pebble,
    ...(!ipMode ? ["--add-host", `${domain}:host-gateway`] : []),
    "-p",
    `127.0.0.1:${caPort}:14000`,
    "-p",
    `127.0.0.1:${managementPort}:15000`,
    "-e",
    "PEBBLE_VA_NOSLEEP=1",
    "-e",
    "PEBBLE_WFE_NONCEREJECT=0",
    "-e",
    "PEBBLE_AUTHZREUSE=0",
    "--mount",
    `type=bind,source=${temp},target=/fixture,readonly`,
    "ghcr.io/letsencrypt/pebble:2.8.0",
    "-config",
    "/fixture/pebble.json",
  ]);
  if (ipMode) await docker(["network", "connect", network, pebble]);
  await until(async () => {
    try {
      await https(`https://localhost:${caPort}/dir`);
      return true;
    } catch {
      return false;
    }
  }, "Pebble startup");
  const issuerRoot = (
    await https(`https://localhost:${managementPort}/roots/0`)
  ).body;
  writeFileSync(join(temp, "issuer.crt"), issuerRoot);
  const serverConfig = {
    dataDir: join(temp, "server"),
    tlsCert: join(temp, "tls/server.crt"),
    tlsKey: join(temp, "tls/server.key"),
    webDist: join(root, "apps/web/dist"),
    adminUsername: "admin",
    adminPassword: password,
    testMode: true,
    ssh: { host: "127.0.0.1", port: 0 },
    acme: {
      httpHost: "127.0.0.1",
      httpPort: challengePort,
      testDirectoryUrl: `https://localhost:${caPort}/dir`,
    },
  };
  if (tlsChallenge) {
    occupiedHTTP = tcpServer((socket) => socket.destroy());
    await new Promise((r) =>
      occupiedHTTP.listen(challengePort, "127.0.0.1", r),
    );
  }
  server = await buildServer(serverConfig);
  await server.app.listen({ host: "127.0.0.1", port: apiPort });
  let token;
  async function api(method, path, payload) {
    const r = await server.app.inject({
      method,
      url: "/api/v1" + path,
      payload,
      headers: token ? { authorization: `Bearer ${token}` } : {},
    });
    assert.equal(r.statusCode, 200, r.body);
    return r.json();
  }
  token = (await api("POST", "/login", { username: "admin", password }))
    .access_token;
  await api("PUT", "/settings/certificate", {
    v: 1,
    revision: 0,
    domain,
    email: "ops@example.com",
    enabled: true,
    tos_agreed: true,
    challenge_type: challengeType,
  });
  let first;
  await until(async () => {
    const s = await api("GET", "/settings/certificate");
    if (s.status === "error") throw Error(JSON.stringify(s.last_error));
    if (s.status === "valid") {
      assert.equal(s.challenge_type, challengeType);
      assert.equal(s.challenge_ready, true);
      assert.equal(s.challenge_port, tlsChallenge ? apiPort : challengePort);
      first = s.certificate;
      return true;
    }
  }, `${challengeType} issuance`);
  console.log(`PASS: real ACME ${challengeType} issuance and hot activation`);
  assert.ok(
    first.expires_at - first.valid_from <= 90_000,
    "shortlived profile was selected",
  );
  const origin = `https://${ipv6 ? `[${domain}]` : domain}:${apiPort}`;
  const transport = ipMode
    ? {
        // Route locally while keeping normal CA and IP SAN verification; no SNI.
        createConnection: (options) =>
          tlsConnect({
            ...options,
            host: "127.0.0.1",
            servername: "",
            checkServerIdentity: (_name, cert) =>
              checkServerIdentity(domain, cert),
          }),
      }
    : {};
  const lookup = (_name, _options, callback) =>
    callback(null, [{ address: "127.0.0.1", family: 4 }]);
  const health = () =>
    https(origin + "/healthz", { ca: issuerRoot, lookup, ...transport });
  assert.equal((await health()).fingerprint, first.fingerprint);
  assert.ok(
    (
      await https(origin, { ca: issuerRoot, lookup, ...transport })
    ).body.includes('id="app"'),
  );
  // Initialization SNI stays reachable while the administrator switches to the public domain.
  await https(`https://localhost:${apiPort}/healthz`);
  const enrollment = (
    await api("POST", "/enrollment-tokens", { v: 1, ttl_seconds: 600 })
  ).enrollment_token;
  const state = join(temp, "agent");
  mkdirSync(state, { mode: 0o700 });
  writeFileSync(
    join(temp, "agent.env"),
    [
      `FLEET_SERVER_URL=${origin}`,
      "FLEET_CA_CERT=/issuer.crt",
      "FLEET_STATE_DIR=/state",
      `FLEET_ENROLLMENT_TOKEN=${enrollment}`,
      "FLEET_DEVICE_NAME=acme-renewal-agent",
      "FLEET_EXECUTION_BACKEND=same-uid",
      "FLEET_HEARTBEAT_MS=500",
    ].join("\n"),
    { mode: 0o600 },
  );
  await docker([
    "run",
    "--rm",
    "--init",
    "-d",
    "--name",
    agent,
    "--platform",
    "linux/arm64",
    ...(ipMode ? ["--network", network] : []),
    "--entrypoint",
    "/agent",
    "--user",
    `${process.getuid()}:${process.getgid()}`,
    ...(!ipMode ? ["--add-host", `${domain}:host-gateway`] : []),
    "--env-file",
    join(temp, "agent.env"),
    "--mount",
    `type=bind,source=${state},target=/state`,
    "--mount",
    `type=bind,source=${join(temp, "issuer.crt")},target=/issuer.crt,readonly`,
    "--mount",
    `type=bind,source=${join(root, ".dev/agent-dist/farhelm-agent-linux-aarch64")},target=/agent,readonly`,
    process.env.FLEET_TEST_AGENT_IMAGE ?? "farhelm-agent-build:arm64",
  ]);
  let device;
  await until(async () => {
    device = (await api("GET", "/devices")).devices[0];
    return device?.control_online;
  }, "real Linux Agent online");
  const open = async () => {
    const created = await api("POST", "/terminal-sessions", {
      v: 1,
      device_id: device.id,
      cols: 80,
      rows: 24,
    });
    const ws = new WebSocket(
      origin.replace("https:", "wss:") + "/api/v1/terminal/ws",
      { ca: issuerRoot, lookup, ...transport, headers: { origin } },
    );
    let output = "",
      ready = false,
      ended;
    ws.on("message", (raw) => {
      const m = JSON.parse(raw);
      if (m.type === "terminal.output")
        output += Buffer.from(m.body.data, "base64").toString();
      if (m.type === "terminal.ready") ready = true;
      if (m.type === "terminal.closed") ended = m.body;
    });
    await once(ws, "open");
    ws.send(
      JSON.stringify({
        v: 1,
        type: "terminal.attach",
        body: { session_id: created.session_id, ticket: created.ticket },
      }),
    );
    await until(() => ready, "PTY ready");
    return {
      ws,
      id: created.session_id,
      output: () => output,
      ended: () => ended,
      input: (text) =>
        ws.send(
          JSON.stringify({
            v: 1,
            type: "terminal.input",
            body: { data: Buffer.from(text).toString("base64") },
          }),
        ),
    };
  };
  sshClient = new SSHClient();
  const sshReady = once(sshClient, "ready");
  sshClient.connect({
    host: "127.0.0.1",
    port: server.ssh.info().port,
    username: `admin:${device.id}`,
    password,
    hostVerifier: (raw) =>
      `SHA256:${createHash("sha256").update(raw).digest("base64").replace(/=+$/, "")}` ===
      server.ssh.info().fingerprint,
  });
  await sshReady;
  const sshChannel = await new Promise((resolve, reject) =>
    sshClient.shell({ cols: 80, rows: 24 }, (error, channel) =>
      error ? reject(error) : resolve(channel),
    ),
  );
  let sshOutput = "",
    sshClosed = false;
  sshChannel.on("data", (data) => {
    sshOutput += data.toString();
  });
  sshChannel.on("close", () => {
    sshClosed = true;
  });
  sshChannel.write("printf '__SSH_BEFORE_%s__\\n' ACME\r");
  await until(() => sshOutput.includes("__SSH_BEFORE_ACME__"), "SSH PTY ready");
  const sshSessionId = server.store.db
    .prepare(
      "SELECT id FROM terminal_sessions WHERE transport='ssh' ORDER BY created_at DESC LIMIT 1",
    )
    .get().id;
  terminal = await open();
  terminal.input("printf '__BEFORE_%s__\\n' ACME\r");
  await until(
    () => terminal.output().includes("__BEFORE_ACME__"),
    "before renewal output",
  );
  console.log(
    "PASS: real Linux PTY active; waiting for automatic renewal timer",
  );
  // Continuous PTY output straddles the actual timer-driven certificate swap.
  terminal.input(
    "for i in $(seq 1 75); do printf '__TICK_%s__\\n' \"$i\"; sleep 1; done\r",
  );
  let renewed;
  await until(
    async () => {
      const s = await api("GET", "/settings/certificate");
      if (s.status === "error") throw Error(JSON.stringify(s.last_error));
      if (s.certificate.fingerprint !== first.fingerprint) {
        renewed = s.certificate;
        return true;
      }
    },
    "automatic renewal",
    75000,
  );
  assert.equal((await health()).fingerprint, renewed.fingerprint);
  assert.ok(renewed.expires_at > first.expires_at);
  assert.equal(sshClosed, false);
  sshChannel.write("printf '__SSH_AFTER_%s__\\n' ACME; exit\r");
  await until(() => sshClosed, "SSH normal exit after renewal");
  assert.ok(sshOutput.includes("__SSH_AFTER_ACME__"));
  await until(
    () =>
      server.store.db
        .prepare("SELECT audit_complete FROM terminal_sessions WHERE id=?")
        .get(sshSessionId).audit_complete === 1,
    "SSH recording flushed",
  );
  const sshRecording = await api(
    "GET",
    `/terminal-sessions/${sshSessionId}/recording`,
  );
  assert.equal(sshRecording.session.status, "CLOSED");
  assert.equal(sshRecording.session.audit_complete, 1);
  const sshRecorded = sshRecording.events
    .filter((e) => e.kind === "output")
    .map((e) => Buffer.from(e.data.data, "base64").toString())
    .join("");
  assert.ok(
    sshRecorded.includes("__SSH_BEFORE_ACME__") &&
      sshRecorded.includes("__SSH_AFTER_ACME__"),
  );
  sshClient.end();
  sshClient = undefined;
  assert.equal(terminal.ws.readyState, WebSocket.OPEN);
  assert.equal(terminal.ended(), undefined);
  terminal.input("\x03");
  terminal.input("printf '__AFTER_%s__\\n' ACME; exit\r");
  await until(() => terminal.ended(), "PTY exit");
  assert.ok(terminal.output().includes("__AFTER_ACME__"));
  assert.equal(terminal.ended().audit_complete, true);
  const log = await docker(["logs", agent]);
  assert.equal((log.match(/control connected/g) ?? []).length, 1);
  const recording = await api(
    "GET",
    `/terminal-sessions/${terminal.id}/recording`,
  );
  assert.equal(recording.session.audit_complete, 1);
  const recorded = recording.events
    .filter((event) => event.kind === "output")
    .map((event) => Buffer.from(event.data.data, "base64").toString())
    .join("");
  assert.ok(
    recorded.includes("__BEFORE_ACME__") && recorded.includes("__AFTER_ACME__"),
  );
  const ticks = [...recorded.matchAll(/__TICK_(\d+)__/g)].map((m) =>
    Number(m[1]),
  );
  assert.ok(ticks.length >= 2);
  assert.deepEqual(
    ticks,
    Array.from({ length: ticks.length }, (_, i) => i + 1),
  );
  terminal.ws.close();
  terminal = undefined;
  server.testHooks.disconnectDevice(device.id);
  await until(
    async () =>
      (await docker(["logs", agent])).match(/control connected/g)?.length >= 2,
    "Agent reconnect with new certificate",
  );
  terminal = await open();
  terminal.input("printf '__NEW_%s__\\n' TLS; exit\r");
  await until(() => terminal.ended(), "new TLS PTY exit");
  assert.ok(terminal.output().includes("__NEW_TLS__"));
  terminal.ws.close();
  terminal = undefined;
  await server.close();
  server = await buildServer(serverConfig);
  await server.app.listen({ host: "127.0.0.1", port: apiPort });
  assert.equal((await health()).fingerprint, renewed.fingerprint);
  mkdirSync(join(root, ".test-output"), { recursive: true });
  writeFileSync(
    join(
      root,
      ipv6
        ? `.test-output/acme${tlsChallenge ? "-tls" : ""}-ipv6.json`
        : ipMode
          ? `.test-output/acme${tlsChallenge ? "-tls" : ""}-ip.json`
          : `.test-output/acme${tlsChallenge ? "-tls" : ""}.json`,
    ),
    JSON.stringify(
      {
        passed: true,
        http01: !tlsChallenge,
        tls_alpn01: tlsChallenge,
        http_port_occupied: tlsChallenge,
        ip_identifier: ipMode,
        ipv6,
        shortlived_profile: ipMode,
        continuous_output_ticks: ticks.length,
        automatic_renewal: true,
        agent_session_preserved: true,
        recording_complete: true,
        ssh_session_preserved: true,
        ssh_recording_complete: true,
        new_tls_reconnect: true,
        restart_persistence: true,
        first: first.fingerprint,
        renewed: renewed.fingerprint,
      },
      null,
      2,
    ),
  );
  console.log(
    "PASS: automatic renewal, existing PTY and recording, fresh TLS/Agent reconnect, persisted certificate after restart",
  );
} catch (error) {
  console.error(error);
  console.error((await docker(["logs", pebble]).catch(() => "")).slice(-5000));
  console.error((await docker(["logs", agent]).catch(() => "")).slice(-1500));
  process.exitCode = 1;
} finally {
  if (occupiedHTTP) await new Promise((r) => occupiedHTTP.close(r));
  terminal?.ws.terminate();
  sshClient?.destroy();
  await docker(["rm", "-f", agent]).catch(() => {});
  await server?.close();
  await docker(["rm", "-f", pebble]).catch(() => {});
  if (ipMode) {
    await docker(["rm", "-f", relay]).catch(() => {});
    await docker(["network", "rm", network]).catch(() => {});
  }
}
