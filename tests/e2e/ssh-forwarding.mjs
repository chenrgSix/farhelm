// Real Linux Agent + system OpenSSH, with isolated TCP/SSH destination fixtures.
import assert from "node:assert/strict";
import { randomBytes, generateKeyPairSync } from "node:crypto";
import { createServer, connect } from "node:net";
import { once } from "node:events";
import { spawn, execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { createRequire } from "node:module";
import { buildServer } from "../../apps/server/dist/server.js";
const require = createRequire(import.meta.url),
  ssh2 = require("../../apps/server/node_modules/ssh2");
const root = resolve(import.meta.dirname, "../.."),
  temp = mkdtempSync(join(tmpdir(), "farhelm-forward-e2e-"));
const binary = process.env.FLEET_AGENT_BIN;
assert.ok(binary, "Set FLEET_AGENT_BIN to a newly built Linux Agent");
const image = process.env.FLEET_AGENT_DOCKER_IMAGE || "farhelm-agent-dev:local";
const password = "isolated-forward-test1",
  container = `farhelm-forward-e2e-${process.pid}`;
execFileSync(
  "bash",
  [join(root, "deploy/dev/generate-tls.sh"), join(temp, "tls")],
  { stdio: "ignore" },
);
const server = await buildServer({
  dataDir: join(temp, "server"),
  tlsCert: join(temp, "tls/server.crt"),
  tlsKey: join(temp, "tls/server.key"),
  adminUsername: "admin",
  adminPassword: password,
  ssh: { host: "127.0.0.1", port: 0 },
});
await server.app.listen({ host: "0.0.0.0", port: 0 });
const sockets = new Set(),
  children = [],
  targets = new Set(),
  steps = [];
const echo = createServer({ allowHalfOpen: true }, (socket) => {
  sockets.add(socket);
  socket.on("error", () => {});
  socket.on("close", () => sockets.delete(socket));
  const chunks = [];
  socket.on("data", (data) => chunks.push(data));
  socket.on("end", () => socket.end(Buffer.concat(chunks)));
});
await new Promise((r) => echo.listen(0, "0.0.0.0", r));
const targetKey = generateKeyPairSync("rsa", {
  modulusLength: 2048,
  privateKeyEncoding: { type: "pkcs1", format: "pem" },
  publicKeyEncoding: { type: "spki", format: "pem" },
}).privateKey;
const target = new ssh2.Server({ hostKeys: [targetKey] }, (client) => {
  targets.add(client);
  client.on("error", () => {});
  client.on("close", () => targets.delete(client));
  client.on("authentication", (ctx) =>
    ctx.method === "password" && ctx.password === password
      ? ctx.accept()
      : ctx.reject(["password"]),
  );
  client.on("tcpip", (accept, reject, info) => {
    const socket = connect({
      host: info.destIP,
      port: info.destPort,
      allowHalfOpen: true,
    });
    sockets.add(socket);
    socket.on("close", () => sockets.delete(socket));
    socket.once("error", () => reject());
    socket.on("connect", () => {
      socket.removeAllListeners("error");
      const channel = accept();
      socket.on("error", () => channel.destroy());
      channel.on("error", () => socket.destroy());
      socket.on("close", () => {
        if (!socket.readableEnded || !socket.writableFinished)
          channel.destroy();
      });
      channel.on("close", () => socket.destroy());
      // A TCP close can precede draining the SSH write window. Preserve buffered replies.
      let outputEnded = false;
      socket.on("end", () =>
        channel.write(Buffer.alloc(0), () => {
          outputEnded = true;
          channel.eof();
          if (channel.readableEnded) channel.end();
        }),
      );
      channel.on("end", () => {
        if (outputEnded) channel.end();
      });
      channel.pipe(socket).pipe(channel, { end: false });
    });
  });
});
await new Promise((r) => target.listen(0, "0.0.0.0", r));
let admin,
  agentLog = "",
  device;
async function api(method, url, payload, auth = admin) {
  const result = await server.app.inject({
    method,
    url: "/api/v1" + url,
    payload,
    headers: auth ? { authorization: "Bearer " + auth } : {},
  });
  assert.equal(result.statusCode, 200, result.body);
  return result.json();
}
async function until(fn, label, timeout = 15000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    if (await fn()) return;
    await new Promise((r) => setTimeout(r, 50));
  }
  throw new Error(`Timed out: ${label}\n${agentLog.slice(-3000)}`);
}
async function roundtrip(port) {
  let socket;
  await until(async () => {
    const candidate = connect({ host: "127.0.0.1", port, allowHalfOpen: true });
    try {
      await once(candidate, "connect");
      socket = candidate;
      return true;
    } catch {
      candidate.destroy();
      return false;
    }
  }, "OpenSSH listener");
  const data = randomBytes(512 * 1024),
    chunks = [],
    ended = once(socket, "end", { signal: AbortSignal.timeout(15000) });
  socket.on("data", (bytes) => chunks.push(bytes));
  socket.end(data);
  await ended;
  assert.equal(Buffer.concat(chunks).length, data.length);
  assert.ok(Buffer.concat(chunks).equals(data));
  socket.destroy();
}
async function freePort() {
  const probe = createServer();
  await new Promise((r) => probe.listen(0, "127.0.0.1", r));
  const { port } = probe.address();
  await new Promise((r) => probe.close(r));
  return port;
}
const failures = [
  { port: 14334, reason: "TARGET_CONNECT_REFUSED" },
  { port: 14335, reason: "TARGET_CONNECT_TIMEOUT" },
];
async function checkFailure(localPort, kind, failure) {
  const socket = connect(localPort, "127.0.0.1");
  socket.on("error", () => {});
  socket.resume();
  try {
    let event;
    await until(
      () => {
        event = server.store.db
          .prepare(
            "SELECT actor_username,detail_json FROM audit WHERE action=? AND json_extract(detail_json,'$.port')=? ORDER BY id DESC LIMIT 1",
          )
          .get(kind + ".forward_closed", failure.port);
        return event;
      },
      kind + " " + failure.reason,
    );
    const detail = JSON.parse(event.detail_json);
    assert.equal(detail.reason, failure.reason);
    assert.equal(detail.opened, false);
    assert.equal(event.actor_username, kind === "ssh" ? "operator" : null);
  } finally {
    socket.destroy();
  }
}
try {
  admin = (await api("POST", "/login", { username: "admin", password }))
    .access_token;
  const enrollment = (
    await api("POST", "/enrollment-tokens", { v: 1, ttl_seconds: 600 })
  ).enrollment_token;
  mkdirSync(join(temp, "agent"), { mode: 0o700 });
  writeFileSync(
    join(temp, "echo.py"),
    `import socket, threading
server = socket.socket()
server.bind(("127.0.0.1", 14333))
server.listen(32)
# A bound but non-listening socket refuses connections. A full backlog drops SYNs.
refused = socket.socket()
refused.bind(("127.0.0.1", 14334))
stalled = socket.socket()
stalled.bind(("127.0.0.1", 14335))
stalled.listen(0)
filler = socket.create_connection(stalled.getsockname())
def handle(client):
    with client:
        data = bytearray()
        while True:
            chunk = client.recv(8192)
            if not chunk: break
            data.extend(chunk)
        client.sendall(data)
while True:
    client, _ = server.accept()
    threading.Thread(target=handle, args=(client,), daemon=True).start()
`,
  );
  const agent = spawn(
    "docker",
    [
      "run",
      "--rm",
      "--name",
      container,
      "--user",
      `${process.getuid()}:${process.getgid()}`,
      "--entrypoint",
      "/bin/bash",
      "--mount",
      `type=bind,source=${resolve(binary)},target=/agent,readonly`,
      "--mount",
      `type=bind,source=${join(temp, "agent")},target=/state`,
      "--mount",
      `type=bind,source=${join(temp, "tls/ca.crt")},target=/ca.crt,readonly`,
      "--mount",
      `type=bind,source=${join(temp, "echo.py")},target=/echo.py,readonly`,
      "-e",
      `FLEET_SERVER_URL=https://host.docker.internal:${server.app.server.address().port}`,
      "-e",
      "FLEET_CA_CERT=/ca.crt",
      "-e",
      "FLEET_STATE_DIR=/state",
      "-e",
      `FLEET_ENROLLMENT_TOKEN=${enrollment}`,
      "-e",
      "FLEET_DEVICE_NAME=forward-e2e",
      "-e",
      "FLEET_EXECUTION_BACKEND=same-uid",
      "-e",
      "FLEET_HEARTBEAT_MS=500",
      image,
      "-c",
      "python3 /echo.py & exec /agent",
    ],
    { stdio: ["ignore", "pipe", "pipe"] },
  );
  agent.stdout.on("data", (data) => (agentLog += data));
  agent.stderr.on("data", (data) => (agentLog += data));
  await until(
    async () => {
      device = (await api("GET", "/devices")).devices.find(
        (d) => d.name === "forward-e2e",
      );
      return device?.control_online;
    },
    "Rust Agent online",
    45000,
  );
  const initialPolicy = await api("GET", `/devices/${device.id}/forwarding`);
  assert.equal(initialPolicy.enabled, false);
  await api("PUT", `/devices/${device.id}/forwarding`, {
    v: 1,
    revision: initialPolicy.revision,
    enabled: true,
  });
  steps.push(
    "device forwarding defaults off and is explicitly enabled by an admin",
  );
  const mappingPort = await freePort();
  const mappingConfig = {
    v: 1,
    name: "raw Agent mapping",
    enabled: true,
    listen_host: "127.0.0.1",
    listen_port: mappingPort,
    target_host: "127.0.0.1",
    target_port: 14333,
    source_cidrs: ["127.0.0.1/32"],
  };
  let mapping = (
    await api("POST", `/devices/${device.id}/tcp-mappings`, mappingConfig)
  ).mapping;
  await roundtrip(mappingPort);
  const mapped = connect({ host: "127.0.0.1", port: mappingPort });
  mapped.on("error", () => {});
  mapped.resume();
  await once(mapped, "connect");
  await until(
    () =>
      server.store.db
        .prepare(
          "SELECT COUNT(*) AS n FROM audit WHERE action='mapping.forward_opened'",
        )
        .get().n === 2,
    "mapped connection opened",
  );
  const mapClosed = once(mapped, "close", {
    signal: AbortSignal.timeout(5000),
  });
  mapping = (
    await api("PUT", `/devices/${device.id}/tcp-mappings/${mapping.id}`, {
      ...mappingConfig,
      enabled: false,
      revision: mapping.revision,
    })
  ).mapping;
  await mapClosed;
  assert.equal(mapping.status, "disabled");
  await api("DELETE", `/devices/${device.id}/tcp-mappings/${mapping.id}`, {
    v: 1,
    revision: mapping.revision,
  });
  steps.push(
    "web-configured raw TCP mapping through real Linux Agent, 512 KiB binary, half-close and disable disconnect; no SSH client login",
  );
  for (const failure of failures) {
    const path = `/devices/${device.id}/tcp-mappings`;
    const { mapping: testMapping } = await api("POST", path, {
      ...mappingConfig,
      target_port: failure.port,
    });
    await checkFailure(mappingPort, "mapping", failure);
    await api("DELETE", path + "/" + testMapping.id, {
      v: 1,
      revision: testMapping.revision,
    });
  }
  steps.push(
    "web mappings distinguish target TCP refusal and timeout in the audit",
  );
  server.store.seedUser({
    username: "operator",
    password,
    role: "ops",
    deviceScope: [device.id],
  });
  const known = join(temp, "known_hosts"),
    config = join(temp, "ssh_config"),
    askpass = join(temp, "askpass");
  const gatewayKey = ssh2.utils.parseKey(
      readFileSync(join(temp, "server/ssh_host_ed25519_key")),
    ),
    targetParsed = ssh2.utils.parseKey(targetKey);
  writeFileSync(
    known,
    `[127.0.0.1]:${server.ssh.info().port} ${gatewayKey.type} ${gatewayKey.getPublicSSH().toString("base64")}\n[host.docker.internal]:${target.address().port} ${targetParsed.type} ${targetParsed.getPublicSSH().toString("base64")}\n`,
  );
  writeFileSync(askpass, `#!/bin/sh\nprintf '%s\\n' '${password}'\n`, {
    mode: 0o700,
  });
  writeFileSync(
    config,
    `Host *\n  StrictHostKeyChecking yes\n  UserKnownHostsFile ${known}\n  PreferredAuthentications password\n  PubkeyAuthentication no\n  ServerAliveInterval 2\n  ServerAliveCountMax 3\n`,
  );
  for (const mode of ["local", "policy", "scope"]) {
    const jump = mode !== "local";
    const port = await freePort();
    const args = [
      "-F",
      config,
      "-N",
      "-o",
      "ExitOnForwardFailure=yes",
      "-L",
      `127.0.0.1:${port}:127.0.0.1:${jump ? echo.address().port : 14333}`,
    ];
    const failurePorts = [];
    if (!jump) {
      for (const failure of failures) {
        const localPort = await freePort();
        failurePorts.push(localPort);
        args.push("-L", `127.0.0.1:${localPort}:127.0.0.1:${failure.port}`);
      }
    }
    if (jump)
      args.push(
        "-J",
        `operator:${device.id}@127.0.0.1:${server.ssh.info().port}`,
        "-p",
        String(target.address().port),
        "terminal@host.docker.internal",
      );
    else
      args.push(
        "-p",
        String(server.ssh.info().port),
        "-l",
        `operator:${device.id}`,
        "127.0.0.1",
      );
    const child = spawn("ssh", args, {
      env: {
        ...process.env,
        SSH_ASKPASS: askpass,
        SSH_ASKPASS_REQUIRE: "force",
        DISPLAY: "farhelm-forward-e2e",
      },
      stdio: ["ignore", "pipe", "pipe"],
    });
    children.push(child);
    let log = "";
    child.stderr.on("data", (data) => (log += data));
    if (!jump) {
      await new Promise((r) => setTimeout(r, 31000));
      assert.equal(child.exitCode, null, log);
    }
    await roundtrip(port);
    if (!jump) {
      for (const [i, failure] of failures.entries())
        await checkFailure(failurePorts[i], "ssh", failure);
      steps.push(
        "OpenSSH -L distinguishes target TCP refusal and timeout in the audit",
      );
    }
    console.log(
      jump ? "ProxyJump roundtrip passed" : "Agent loopback roundtrip passed",
    );
    steps.push(
      jump
        ? "system OpenSSH -J with -L through real Linux Agent, 512 KiB binary and half-close"
        : "system OpenSSH -N -L idle for 31 seconds before use, 512 KiB binary and half-close",
    );
    if (jump) {
      const closed =
        child.exitCode !== null || child.signalCode !== null
          ? Promise.resolve()
          : once(child, "exit", { signal: AbortSignal.timeout(5000) });
      if (mode === "policy") {
        const policy = await api("GET", `/devices/${device.id}/forwarding`);
        await api("PUT", `/devices/${device.id}/forwarding`, {
          v: 1,
          revision: policy.revision,
          enabled: false,
        });
      } else {
        server.store.db
          .prepare(
            "UPDATE users SET device_scope='[]' WHERE username='operator'",
          )
          .run();
      }
      await closed;
      steps.push(
        mode === "policy"
          ? "disabling device forwarding terminates the existing ProxyJump connection"
          : "device scope revocation terminates the existing ProxyJump connection",
      );
      if (mode === "policy") {
        const policy = await api("GET", `/devices/${device.id}/forwarding`);
        await api("PUT", `/devices/${device.id}/forwarding`, {
          v: 1,
          revision: policy.revision,
          enabled: true,
        });
      }
    } else {
      const closed =
        child.exitCode !== null || child.signalCode !== null
          ? Promise.resolve()
          : once(child, "exit", { signal: AbortSignal.timeout(5000) });
      child.kill("SIGTERM");
      await closed;
    }
  }
  const audit = server.store.db
    .prepare("SELECT detail_json FROM audit WHERE action='ssh.forward_closed'")
    .all();
  assert.ok(audit.length >= 2);
  assert.ok(
    audit.every((row) => JSON.parse(row.detail_json).backend === "agent"),
  );
  mkdirSync(join(root, ".test-output"), { recursive: true });
  writeFileSync(
    join(root, ".test-output/ssh-forwarding-e2e.json"),
    JSON.stringify({ ok: true, steps }, null, 2),
  );
  console.log(JSON.stringify({ ok: true, steps }, null, 2));
} finally {
  for (const child of children) child.kill("SIGTERM");
  try {
    execFileSync("docker", ["rm", "-f", container], { stdio: "ignore" });
  } catch {}
  await server.close();
  for (const client of targets) client.end();
  for (const socket of sockets) socket.destroy();
  await Promise.all([
    new Promise((r) => target.close(r)),
    new Promise((r) => echo.close(r)),
  ]);
}
