// Real OpenSSH + Linux Agent PTY recovery through a deliberately interrupted TCP relay.
import assert from "node:assert/strict";
import { spawn, execFileSync } from "node:child_process";
import { once } from "node:events";
import { mkdtempSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import net from "node:net";
import { buildServer } from "../../apps/server/dist/server.js";
const root = resolve(import.meta.dirname, "../.."),
  temp = mkdtempSync(join(tmpdir(), "farhelm-reconnect-")),
  tls = join(temp, "tls");
const container = `farhelm-reconnect-${process.pid}`,
  password = "reconnect-e2e-password1";
const pause = (ms) => new Promise((r) => setTimeout(r, ms));
async function until(fn, label, timeout = 20000) {
  const end = Date.now() + timeout;
  while (Date.now() < end) {
    if (await fn()) return;
    await pause(40);
  }
  throw Error("Timed out: " + label);
}
async function docker(args) {
  return new Promise((resolve, reject) => {
    const p = spawn("docker", args, { stdio: ["ignore", "pipe", "pipe"] });
    let output = "";
    p.stdout.on("data", (d) => (output += d));
    p.stderr.on("data", (d) => (output += d));
    p.on("error", reject);
    p.on("close", (code) =>
      code === 0 ? resolve(output) : reject(Error(output)),
    );
  });
}
execFileSync("bash", [join(root, "deploy/dev/generate-tls.sh"), tls], {
  stdio: "ignore",
});
const server = await buildServer({
  dataDir: join(temp, "server"),
  tlsCert: join(tls, "server.crt"),
  tlsKey: join(tls, "server.key"),
  adminUsername: "admin",
  adminPassword: password,
  ssh: { host: "127.0.0.1", port: 0 },
});
await server.app.listen({ host: "127.0.0.1", port: 0 });
const port = server.app.server.address().port;
let blocked = false,
  admin,
  device,
  started = false;
const connections = new Set(),
  clients = [],
  checks = [];
const relay = net.createServer((client) => {
  client.on("error", () => {});
  if (blocked) return client.destroy();
  const target = net.connect(port, "127.0.0.1");
  target.on("error", () => client.destroy());
  connections.add(client);
  connections.add(target);
  client.on("close", () => {
    connections.delete(client);
    target.destroy();
  });
  target.on("close", () => {
    connections.delete(target);
    client.destroy();
  });
  client.pipe(target).pipe(client);
});
relay.listen(0, "0.0.0.0");
await once(relay, "listening");
const relayPort = relay.address().port;
function cut() {
  blocked = true;
  for (const socket of connections) socket.destroy();
}
async function api(method, path, payload) {
  const r = await server.app.inject({
    method,
    url: "/api/v1" + path,
    payload,
    headers: admin ? { authorization: "Bearer " + admin } : {},
  });
  assert.equal(r.statusCode, 200, r.body);
  return r.json();
}
const sessionRows = () =>
  server.store.db
    .prepare("SELECT * FROM terminal_sessions ORDER BY rowid DESC")
    .all();
const reason = (id) => sessionRows().find((row) => row.id === id)?.reason;
function openSsh() {
  const sshPort = server.ssh.info().port;
  const known = join(temp, "known_hosts"),
    askpass = join(temp, "askpass");
  const pub = execFileSync(
    "ssh-keygen",
    ["-y", "-f", join(temp, "server/ssh_host_ed25519_key")],
    { encoding: "utf8" },
  ).trim();
  writeFileSync(known, `[127.0.0.1]:${sshPort} ${pub}\n`);
  writeFileSync(askpass, `#!/bin/sh\nprintf '%s\\n' '${password}'\n`, {
    mode: 0o700,
  });
  const proc = spawn(
    "ssh",
    [
      "-F",
      "/dev/null",
      "-tt",
      "-o",
      "StrictHostKeyChecking=yes",
      "-o",
      `UserKnownHostsFile=${known}`,
      "-o",
      "PreferredAuthentications=password",
      "-o",
      "PubkeyAuthentication=no",
      "-p",
      String(sshPort),
      "-l",
      `admin:${device.id}`,
      "127.0.0.1",
    ],
    {
      env: {
        ...process.env,
        SSH_ASKPASS: askpass,
        SSH_ASKPASS_REQUIRE: "force",
        DISPLAY: ":0",
      },
      stdio: ["pipe", "pipe", "pipe"],
    },
  );
  const client = {
    proc,
    out: "",
    err: "",
    closed: false,
    send: (text) => proc.stdin.write(text + "\n"),
  };
  proc.stdin.on("error", () => {});
  proc.stdout.on("data", (d) => (client.out += d));
  proc.stderr.on("data", (d) => (client.err += d));
  proc.on("close", () => (client.closed = true));
  clients.push(client);
  return client;
}
try {
  admin = (await api("POST", "/login", { username: "admin", password }))
    .access_token;
  const token = (
    await api("POST", "/enrollment-tokens", { v: 1, ttl_seconds: 600 })
  ).enrollment_token;
  const binary = process.env.FLEET_AGENT_BIN;
  assert.ok(binary, "FLEET_AGENT_BIN is required");
  const args = [
    "run",
    "--rm",
    "-d",
    "--name",
    container,
    "--user",
    "0",
    "--entrypoint",
    "bash",
    "--mount",
    `type=bind,source=${binary},target=/agent,readonly`,
    "--mount",
    `type=bind,source=${tls}/ca.crt,target=/ca.crt,readonly`,
  ];
  for (const [key, value] of Object.entries({
    HOME: "/home/fleet",
    FLEET_SERVER_URL: `https://host.docker.internal:${relayPort}`,
    FLEET_CA_CERT: "/ca.crt",
    FLEET_STATE_DIR: "/state",
    FLEET_ENROLLMENT_TOKEN: token,
    FLEET_DEVICE_NAME: "reconnect-linux",
    FLEET_EXECUTION_BACKEND: "same-uid",
    FLEET_TERMINAL_ALLOW_PRIVILEGE_ESCALATION: "0",
    FLEET_HEARTBEAT_MS: "200",
  }))
    args.push("--env", `${key}=${value}`);
  args.push(
    process.env.FLEET_AGENT_DOCKER_IMAGE ?? "farhelm-agent-dev:local",
    "-c",
    "mkdir -p /state && chmod 700 /state && chown fleet /state && exec runuser -u fleet -- /agent",
  );
  await docker(args);
  started = true;
  await until(async () => {
    device = (await api("GET", "/devices")).devices[0];
    return device?.control_online;
  }, "Agent connected");
  const c = openSsh();
  await until(() => c.out.includes("$"), "OpenSSH PTY prompt");
  c.send(
    String.raw`stty -echo; cd /tmp; resume_var=preserved; printf '\136BASE\136%s\n' "$$"`,
  );
  await until(() => /\^BASE\^\d+/.test(c.out), "shell PID");
  const pid = c.out.match(/\^BASE\^(\d+)/)[1],
    id = String(sessionRows()[0].id);
  c.send(
    String.raw`printf '\136START\136\n'; sleep 3; printf '\136DONE\136\n'`,
  );
  await until(() => c.out.includes("^START^"), "foreground command running");
  const cutAt = Date.now();
  cut();
  await until(() => c.err.includes("重连"), "SSH reconnect notice");
  assert.equal(c.closed, false);
  c.send("echo OFFLINE_KEY_MUST_NOT_EXECUTE");
  await pause(25000);
  assert.equal(c.closed, false, c.err);
  assert.equal(sessionRows()[0].status, "OPEN");
  blocked = false;
  await until(
    () => c.err.includes("已恢复"),
    "original OpenSSH resumed",
    30000,
  );
  await until(
    () => c.out.includes("^DONE^"),
    "foreground command completed across outage",
  );
  assert.equal(c.closed, false, c.err);
  c.send(
    String.raw`printf '\136AFTER\136%s:%s:%s\n' "$$" "$PWD" "$resume_var"`,
  );
  await until(
    () => c.out.includes(`^AFTER^${pid}:/tmp:preserved`),
    "same PID, cwd and variable",
  );
  assert.equal(c.out.includes("OFFLINE_KEY_MUST_NOT_EXECUTE"), false);
  assert.equal(c.out.split("^DONE^").length - 1, 1);
  const audits = server.store.db
    .prepare(
      "SELECT action,detail_json FROM audit WHERE action LIKE 'terminal.%' ORDER BY id",
    )
    .all()
    .filter((a) => JSON.parse(a.detail_json).session_id === id);
  assert.deepEqual(
    audits
      .filter((a) =>
        ["terminal.reconnecting", "terminal.resumed"].includes(a.action),
      )
      .map((a) => a.action),
    ["terminal.reconnecting", "terminal.resumed"],
  );
  assert.equal(
    audits.some((a) => a.action === "terminal.closed"),
    false,
  );
  checks.push(
    `25s outage recovered in ${Date.now() - cutAt}ms; original OpenSSH connection, PID, cwd, variables and foreground command preserved; offline input discarded`,
  );
  console.log(checks.at(-1));
  // Silent packet loss: no FIN/RST. Cover both idle heartbeat detection and
  // a foreground command whose output acknowledgement cannot get back.
  for (const pendingOutput of [false, true]) {
    if (pendingOutput) {
      c.send(
        String.raw`printf '\136ACK_START\136\n'; sleep 1; printf '\136ACK_DONE\136\n'`,
      );
      await until(
        () => c.out.includes("^ACK_START^"),
        "command before ACK loss",
      );
    }
    const reconnects = c.err.split("重连").length,
      resumes = c.err.split("已恢复").length;
    // Only disrupt the original transport. The Agent may already have opened
    // a healthy replacement by the time OpenSSH delivers the reconnect notice.
    const interrupted = [...connections];
    for (const socket of interrupted) socket.pause();
    await until(
      () => c.err.split("重连").length > reconnects,
      "detect silent loss",
      30000,
    );
    for (const socket of interrupted) socket.destroy();
    await until(
      () => c.err.split("已恢复").length > resumes,
      "resume after silent loss",
      15000,
    );
    c.send(
      String.raw`printf '\136SILENT` +
        Number(pendingOutput) +
        String.raw`\136%s\n' "$$"`,
    );
    await until(
      () => c.out.includes(`^SILENT${Number(pendingOutput)}^${pid}`),
      "same shell after silent loss",
    );
    if (pendingOutput) assert.equal(c.out.split("^ACK_DONE^").length - 1, 1);
    checks.push(
      pendingOutput
        ? "Lost output ACK triggers transport recovery; pending output is recorded and displayed once"
        : "Silent packet loss detected by heartbeat and original shell resumed",
    );
    console.log(checks.at(-1));
  }
  cut();
  await until(() => c.closed, "60 second reconnect deadline", 70000);
  assert.equal(reason(id), "AGENT_RECONNECT_TIMEOUT");
  blocked = false;
  await until(
    async () => (await api("GET", "/devices")).devices[0]?.control_online,
    "Agent reconnects after timeout",
    30000,
  );
  assert.equal(
    await docker([
      "exec",
      container,
      "sh",
      "-c",
      `test ! -e /proc/${pid} && echo gone`,
    ]),
    "gone\n",
  );
  checks.push(
    "Outage beyond 60s closes OpenSSH, kills retained PTY and audits AGENT_RECONNECT_TIMEOUT",
  );
  console.log(checks.at(-1));
  const restarted = openSsh();
  await until(() => restarted.out.includes("$"), "second PTY");
  const restartedId = String(sessionRows()[0].id);
  await docker(["restart", container]);
  await until(() => restarted.closed, "Agent restart closes old shell");
  assert.equal(reason(restartedId), "AGENT_RESTARTED");
  checks.push(
    "Agent process restart is distinguished from network loss and never creates a replacement shell",
  );
  mkdirSync(join(root, ".test-output"), { recursive: true });
  writeFileSync(
    process.env.FLEET_TEST_REPORT_FILE ??
      join(root, ".test-output/terminal-reconnect-e2e.json"),
    JSON.stringify({ at: new Date().toISOString(), checks }, null, 2) + "\n",
  );
  console.log(JSON.stringify({ checks }, null, 2));
} finally {
  for (const client of clients) {
    client.proc.kill();
    if (client.err) console.log("OpenSSH:", client.err);
  }
  if (started) {
    console.log(
      await docker(["logs", "--tail", "15", container]).catch(String),
    );
    await docker(["rm", "-f", container]).catch(() => {});
  }
  for (const socket of connections) socket.destroy();
  relay.close();
  await server.close();
}
