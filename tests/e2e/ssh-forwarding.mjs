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
      socket.on("close", () => channel.destroy());
      channel.on("close", () => socket.destroy());
      channel.pipe(socket).pipe(channel);
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
  for (const jump of [false, true]) {
    const probe = createServer();
    await new Promise((r) => probe.listen(0, "127.0.0.1", r));
    const port = probe.address().port;
    await new Promise((r) => probe.close(r));
    const args = [
      "-F",
      config,
      "-N",
      "-o",
      "ExitOnForwardFailure=yes",
      "-L",
      `127.0.0.1:${port}:127.0.0.1:${jump ? echo.address().port : 14333}`,
    ];
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
      server.store.db
        .prepare("UPDATE users SET device_scope='[]' WHERE username='operator'")
        .run();
      await closed;
      steps.push(
        "device scope revocation terminates the existing ProxyJump connection",
      );
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
