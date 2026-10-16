// Real CLI process + system OpenSSH + isolated Linux sshd. No HTTPS certificates or Agent.
import assert from "node:assert/strict";
import { spawn, execFileSync } from "node:child_process";
import { once } from "node:events";
import { createServer } from "node:net";
import { request } from "node:http";
import {
  mkdtempSync,
  readFileSync,
  writeFileSync,
  mkdirSync,
  statSync,
  existsSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { createRequire } from "node:module";
const require = createRequire(import.meta.url);
const ssh2 = require("../../apps/server/node_modules/ssh2");
const root = resolve(import.meta.dirname, "../.."),
  temp = mkdtempSync(join(tmpdir(), "fh-only-"));
const dataDir = join(temp, "server"),
  socketPath = join(dataDir, "admin.sock"),
  out = join(root, ".test-output");
const password = "isolated-ssh-only-test-password",
  container = `farhelm-ssh-only-${process.pid}`;
const steps = [],
  clients = [];
let processServer,
  serverOutput = "",
  token = "",
  fingerprint,
  gatewayPort;
const env = Object.fromEntries(
  Object.entries(process.env).filter(
    ([key]) => !key.startsWith("FLEET_") && key !== "NODE_EXTRA_CA_CERTS",
  ),
);
async function until(fn, label, ms = 15000) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (await fn()) return;
    await new Promise((r) => setTimeout(r, 50));
  }
  throw Error("Timed out: " + label);
}
async function reserve() {
  const s = createServer((c) => c.destroy());
  await new Promise((r) => s.listen(0, "127.0.0.1", r));
  return s;
}
const unusedHttps = await reserve(),
  sshProbe = await reserve();
gatewayPort = sshProbe.address().port;
await new Promise((r) => sshProbe.close(r));
Object.assign(env, {
  FLEET_MODE: "ssh-only",
  FLEET_HOST: "127.0.0.1",
  FLEET_PORT: String(unusedHttps.address().port),
  FLEET_SSH_PORT: String(gatewayPort),
  FLEET_DATA_DIR: dataDir,
  FLEET_ADMIN_USER: "admin",
  FLEET_ADMIN_PASSWORD: password,
  // These deliberately broken full-mode settings must be entirely ignored.
  FLEET_TLS_CERT: "/missing/unused.crt",
  FLEET_TLS_KEY: "/missing/unused.key",
  FLEET_CA_CERT: "/missing/unused-ca.crt",
  FLEET_WEB_DIST: "/missing/web",
  FLEET_ACME_ENABLED: "1",
});
function startChild() {
  return spawn(process.execPath, ["apps/server/dist/index.js"], {
    cwd: root,
    env,
    stdio: ["ignore", "pipe", "pipe"],
  });
}
async function http(method, path, body, auth = token) {
  return new Promise((resolve, reject) => {
    const bytes =
      body === undefined ? undefined : Buffer.from(JSON.stringify(body));
    const r = request(
      {
        socketPath,
        method,
        path: "/api/v1" + path,
        headers: {
          ...(auth ? { authorization: "Bearer " + auth } : {}),
          ...(bytes
            ? {
                "content-type": "application/json",
                "content-length": bytes.length,
              }
            : {}),
        },
      },
      (res) => {
        let text = "";
        res.on("data", (d) => (text += d));
        res.on("end", () =>
          resolve({ status: res.statusCode, body: JSON.parse(text) }),
        );
      },
    );
    r.on("error", reject);
    r.setTimeout(3000, () => r.destroy(Error("local management timeout")));
    r.end(bytes);
  });
}
async function api(method, path, body) {
  const r = await http(method, path, body);
  assert.equal(r.status, 200, JSON.stringify(r.body));
  return r.body;
}
async function start() {
  serverOutput = "";
  processServer = startChild();
  processServer.stdout.on("data", (d) => (serverOutput += d));
  processServer.stderr.on("data", (d) => (serverOutput += d));
  await until(async () => {
    assert.equal(processServer.exitCode, null, serverOutput);
    try {
      return (
        (await http("POST", "/login", { username: "admin", password }, ""))
          .status === 200
      );
    } catch {
      return false;
    }
  }, "SSH-only server startup");
  token = (await api("POST", "/login", { username: "admin", password }))
    .access_token;
  const info = await api("GET", "/ssh");
  assert.equal(info.port, gatewayPort);
  assert.equal(info.enabled, true);
  if (fingerprint) assert.equal(info.fingerprint, fingerprint);
  fingerprint = info.fingerprint;
  assert.equal(statSync(socketPath).mode & 0o777, 0o600);
  assert.equal(statSync(dataDir).mode & 0o777, 0o700);
  assert.equal(existsSync(join(dataDir, "certificates")), false);
  assert.ok(serverOutput.includes("HTTPS disabled"));
  assert.equal((await http("GET", "/devices", undefined, "")).status, 401);
  assert.equal((await http("GET", "/settings/certificate")).status, 404);
}
async function stop(signal = "SIGTERM") {
  if (
    processServer &&
    processServer.exitCode === null &&
    processServer.signalCode === null
  ) {
    const done = once(processServer, "exit");
    processServer.kill(signal);
    await done;
  }
}
function cli(username) {
  const c = spawn(
    "ssh",
    [
      "-tt",
      "-p",
      String(gatewayPort),
      "-l",
      username,
      "-o",
      "StrictHostKeyChecking=yes",
      "-o",
      "UserKnownHostsFile=" + join(temp, "known_hosts"),
      "-o",
      "PreferredAuthentications=password",
      "-o",
      "PubkeyAuthentication=no",
      "-o",
      "NumberOfPasswordPrompts=1",
      "127.0.0.1",
    ],
    {
      env: {
        ...process.env,
        SSH_ASKPASS: join(temp, "askpass"),
        SSH_ASKPASS_REQUIRE: "force",
        DISPLAY: ":0",
      },
      stdio: ["pipe", "pipe", "pipe"],
    },
  );
  clients.push(c);
  let output = "",
    error = "";
  c.stdout.on("data", (d) => (output += d));
  c.stderr.on("data", (d) => (error += d));
  const exited = once(c, "exit");
  return {
    c,
    output: () => output,
    error: () => error,
    exited,
    text: async (s) => until(() => output.includes(s), s),
    input: (s) => c.stdin.write(s),
  };
}
async function denied(username, pass = password) {
  const c = new ssh2.Client();
  c.on("error", () => {});
  const ready = once(c, "ready");
  c.connect({
    host: "127.0.0.1",
    port: gatewayPort,
    username,
    password: pass,
    readyTimeout: 5000,
    hostHash: "sha256",
    hostVerifier: (hash) =>
      "SHA256:" +
        Buffer.from(hash, "hex").toString("base64").replace(/=+$/, "") ===
      fingerprint,
  });
  try {
    await assert.rejects(ready, /authentication/);
  } finally {
    c.destroy();
  }
}
async function recording(id) {
  let after = 0,
    events = [],
    session;
  for (;;) {
    const r = await api(
      "GET",
      `/terminal-sessions/${id}/recording?after=${after}`,
    );
    session = r.session;
    events.push(...r.events);
    if (r.events.length < 128) return { session, events };
    after = r.next;
  }
}
const recordedText = (r) =>
  r.events
    .filter((e) => e.kind === "output")
    .map((e) => Buffer.from(e.data.data, "base64").toString())
    .join("");
try {
  for (const key of ["host", "identity"])
    execFileSync(
      "ssh-keygen",
      ["-q", "-t", "ed25519", "-N", "", "-f", join(temp, key)],
      { stdio: "ignore" },
    );
  writeFileSync(
    join(temp, "authorized_keys"),
    readFileSync(join(temp, "identity.pub")),
  );
  writeFileSync(
    join(temp, "sshd_config"),
    "Port 22\nHostKey /fixture/host\nAuthorizedKeysFile /etc/ssh/authorized_keys\nStrictModes no\nPasswordAuthentication no\nKbdInteractiveAuthentication no\nPermitEmptyPasswords no\nPermitRootLogin no\nAllowUsers terminal\nUsePAM no\nSetEnv LANG=C.UTF-8 LC_ALL=C.UTF-8\nPrintMotd no\nAllowTcpForwarding no\nX11Forwarding no\nPermitUserEnvironment no\n",
  );
  execFileSync(
    "docker",
    [
      "run",
      "--rm",
      "-d",
      "--name",
      container,
      "--publish",
      "127.0.0.1::22",
      "--mount",
      `type=bind,source=${temp},target=/fixture,readonly`,
      "--mount",
      `type=bind,source=${temp}/authorized_keys,target=/etc/ssh/authorized_keys,readonly`,
      process.env.FLEET_SSH_TARGET_IMAGE || "farhelm-sshd-test:local",
    ],
    { stdio: "pipe" },
  );
  const targetPort = Number(
    execFileSync("docker", ["port", container, "22/tcp"], { encoding: "utf8" })
      .trim()
      .split(":")
      .at(-1),
  );
  await start();
  steps.push(
    "Actual server CLI starts without TLS/CA files, HTTPS/ACME ports or Agent; management is Unix-only and still requires authentication",
  );
  const keyPath = join(dataDir, "ssh_host_ed25519_key"),
    hostKey = readFileSync(keyPath);
  assert.equal(statSync(keyPath).mode & 0o777, 0o600);
  const hostPublic = execFileSync("ssh-keygen", ["-y", "-f", keyPath], {
    encoding: "utf8",
  }).trim();
  writeFileSync(
    join(temp, "known_hosts"),
    `[127.0.0.1]:${gatewayPort} ${hostPublic}\n`,
  );
  writeFileSync(
    join(temp, "askpass"),
    "#!/bin/sh\nprintf '%s\\n' '" + password + "'\n",
    { mode: 0o700 },
  );
  const targetFingerprint = execFileSync(
    "ssh-keygen",
    ["-lf", join(temp, "host.pub"), "-E", "sha256"],
    { encoding: "utf8" },
  ).split(/\s+/)[1];
  const create = async (name) =>
    api("POST", "/ssh-devices", {
      v: 1,
      name,
      ssh: {
        host: "127.0.0.1",
        port: targetPort,
        username: "terminal",
        fingerprint: targetFingerprint,
      },
      private_key: readFileSync(join(temp, "identity"), "utf8"),
    });
  const device = await create("allowed-linux"),
    other = await create("restricted-linux");
  const member = (
    await api("POST", "/users", {
      v: 1,
      username: "groupops",
      password,
      enabled: true,
      role_ids: [],
      group_ids: [],
      device_scope: [],
    })
  ).user;
  const group = (
    await api("POST", "/groups", {
      v: 1,
      name: "SSH operators",
      description: "",
      role_ids: ["ops"],
      member_ids: [member.id],
      device_scope: [device.device_id],
    })
  ).group;
  await api("POST", "/users", {
    v: 1,
    username: "business",
    password,
    enabled: true,
    role_ids: ["business"],
    group_ids: [],
    device_scope: "*",
  });
  await denied("admin:" + device.device_id, "incorrect-password");
  await denied("business:" + device.device_id);
  await denied("groupops:" + other.device_id);
  const menu = cli("groupops");
  await menu.text("输入设备编号");
  assert.ok(menu.output().includes("allowed-linux"));
  assert.ok(!menu.output().includes("restricted-linux"));
  menu.input("1\r");
  await menu.text("$ ");
  menu.input("stty -echo; printf '__SSH_ONLY_%s__\\n' READY\r");
  await menu.text("__SSH_ONLY_READY__");
  const duplicate = startChild();
  let duplicateOutput = "";
  duplicate.stderr.on("data", (d) => (duplicateOutput += d));
  duplicate.stdout.resume();
  const [duplicateCode] = await once(duplicate, "exit");
  assert.notEqual(duplicateCode, 0);
  assert.match(duplicateOutput, /already in use/);
  menu.input("printf '__AFTER_DUPLICATE_%s__\\n' OK\r");
  await menu.text("__AFTER_DUPLICATE_OK__");
  menu.input(
    "read -r -s -p 'secret:' secret; printf '\\n__HIDDEN_%s__\\n' OK\r",
  );
  await menu.text("secret:");
  menu.input("E2E_SSH_ONLY_NOT_RECORDED\r");
  await menu.text("__HIDDEN_OK__");
  menu.input(
    "printf '__SSH_ONLY_UTF8_%s__\\n' 中文; printf '__SSH_ONLY_USER_%s__\\n' \"$(id -un)\"; exit\r",
  );
  assert.equal((await menu.exited)[0], 0, menu.error());
  assert.ok(menu.output().includes("__SSH_ONLY_USER_terminal__"));
  const first = (await api("GET", "/terminal-sessions")).sessions[0];
  assert.equal(first.transport, "ssh");
  assert.equal(first.backend, "ssh");
  assert.equal(first.status, "CLOSED");
  assert.equal(first.audit_complete, 1);
  const firstRecording = await recording(first.id),
    text = recordedText(firstRecording);
  assert.ok(text.includes("__SSH_ONLY_UTF8_中文__"));
  assert.ok(text.includes("__AFTER_DUPLICATE_OK__"));
  assert.ok(!text.includes("E2E_SSH_ONLY_NOT_RECORDED"));
  assert.ok(!text.includes("输入设备编号"));
  steps.push(
    "System OpenSSH -> permission-filtered device menu -> real Linux sshd; UTF-8, hidden input privacy, normal exit and complete recording; duplicate server startup cannot interrupt the session",
  );
  const active = cli("groupops:" + device.device_id);
  await active.text("$ ");
  active.input("stty -echo; printf '__REVOCATION_%s__\\n' READY\r");
  await active.text("__REVOCATION_READY__");
  await api("PUT", "/groups/" + group.id, {
    v: 1,
    revision: group.revision,
    name: group.name,
    description: "",
    role_ids: ["ops"],
    member_ids: [member.id],
    device_scope: [],
  });
  assert.notEqual((await active.exited)[0], 0);
  await denied("groupops:" + device.device_id);
  const revoked = (await api("GET", "/terminal-sessions")).sessions.find(
    (s) => s.id !== first.id,
  );
  assert.equal(revoked.reason, "AUTHORIZATION_EXPIRED");
  steps.push(
    "Wrong passwords, roles and device scopes denied; removing inherited user-group scope terminates an active session",
  );
  await stop();
  await start();
  assert.deepEqual(readFileSync(keyPath), hostKey);
  const after = cli("admin:" + device.device_id);
  await after.text("$ ");
  after.input("stty -echo; printf '__RESTART_%s__\\n' OK; exit\r");
  assert.equal((await after.exited)[0], 0, after.error());
  assert.ok(after.output().includes("__RESTART_OK__"));
  assert.equal(recordedText(await recording(first.id)), text);
  steps.push(
    "Graceful restart preserves SSH host key, strict known_hosts verification, device credentials, permissions and historical recordings",
  );
  await stop("SIGKILL");
  assert.ok(existsSync(socketPath));
  await start();
  assert.deepEqual(readFileSync(keyPath), hostKey);
  assert.equal((await api("GET", "/devices")).devices.length, 2);
  const audit = await api("GET", "/audit");
  assert.ok(JSON.stringify(audit).includes("authorization.denied"));
  steps.push(
    "Crash restart removes only its stale Unix socket and preserves the SSH host identity; no HTTPS certificate is created",
  );
  mkdirSync(out, { recursive: true });
  const result = {
    passed: true,
    steps,
    host_fingerprint: fingerprint,
    recording_session: first.id,
    https_certificates_required: false,
    agent_required: false,
    strict_host_key_verification: true,
    local_admin_authenticated: true,
  };
  writeFileSync(
    join(out, "ssh-only-e2e.json"),
    JSON.stringify(result, null, 2),
  );
  console.log(JSON.stringify(result, null, 2));
} finally {
  for (const c of clients)
    if (c.exitCode === null && c.signalCode === null) c.kill();
  await stop();
  await new Promise((r) => unusedHttps.close(r));
  try {
    execFileSync("docker", ["rm", "-f", container], { stdio: "ignore" });
  } catch {}
}
