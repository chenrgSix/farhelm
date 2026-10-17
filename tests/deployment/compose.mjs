// Real image/systemd deployment, SSH target, web WSS and SSH gateway recordings.
// Every Compose project, fixture container and volume is private to this run.
import assert from "node:assert/strict";
import { spawn, execFileSync } from "node:child_process";
import { once } from "node:events";
import { mkdtempSync, readFileSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { createRequire } from "node:module";
import { createServer } from "node:net";
import https from "node:https";
import http from "node:http";
const require = createRequire(import.meta.url);
const { Client } = require("../../apps/server/node_modules/ssh2");
const { WebSocket } = require("../../apps/server/node_modules/ws");
const root = resolve(import.meta.dirname, "../..");
const temp = mkdtempSync(join(tmpdir(), "fh-compose-"));
const project = `farhelm-deployment-${process.pid}`;
const agentContainer = `${project}-agent`;
const native = process.env.FARHELM_TEST_NATIVE_CONTAINER;
const plain = process.env.FARHELM_TEST_HTTP === "1";
const target = `${project}-target`,
  network = native ? `${project}-net` : `${project}_default`;
let serverContainer,
  ca,
  token = "",
  sshClient,
  ws;
async function docker(args, env = process.env) {
  return await new Promise((resolve, reject) => {
    const child = spawn("docker", args, {
      cwd: root,
      env,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let output = "";
    child.stdout.on("data", (data) => (output += data));
    child.stderr.on("data", (data) => (output += data));
    child.on("error", reject);
    child.on("exit", (code) =>
      code === 0 ? resolve(output.trim()) : reject(Error(output)),
    );
  });
}
async function freePort() {
  const s = createServer();
  await new Promise((r) => s.listen(0, "127.0.0.1", r));
  const port = s.address().port;
  await new Promise((r) => s.close(r));
  return port;
}
async function until(check, label, ms = 20000) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (await check()) return;
    await new Promise((r) => setTimeout(r, 100));
  }
  throw Error(`Timed out: ${label}`);
}
let webPort = await freePort(),
  sshPort = await freePort();
writeFileSync(join(temp, "empty.env"), "");
const env = {
  ...process.env,
  FARHELM_PUBLIC_HOST: "127.0.0.1",
  FARHELM_WEB_PORT: String(webPort),
  FARHELM_AGENT_PORT: String(await freePort()),
  FARHELM_SSH_PORT: String(sshPort),
  FARHELM_BIND_ADDRESS: "127.0.0.1",
  FLEET_ADMIN_USER: "admin",
  FLEET_ADMIN_PASSWORD: "",
  FLEET_DEVICE_ACCESS: plain ? "ssh-only" : "agent-ssh",
  FLEET_WEB_PROTOCOL: plain ? "http" : "https",
};
const compose = (...args) =>
  docker(
    [
      "compose",
      "-p",
      project,
      "--env-file",
      join(temp, "empty.env"),
      "-f",
      "deploy/compose.yml",
      ...args,
    ],
    env,
  );
const readData = (path) =>
  docker(["exec", serverContainer, "cat", `/var/lib/farhelm/${path}`]);
let origin;
async function request(method, path, payload, auth = token) {
  return await new Promise((resolve, reject) => {
    const body = payload === undefined ? undefined : JSON.stringify(payload);
    const req = (plain ? http : https).request(
      origin + path,
      {
        method,
        ca,
        agent: false,
        headers: {
          ...(auth ? { authorization: `Bearer ${auth}` } : {}),
          ...(body
            ? {
                "content-type": "application/json",
                "content-length": Buffer.byteLength(body),
              }
            : {}),
        },
      },
      (res) => {
        let text = "";
        res.on("data", (d) => (text += d));
        res.on("end", () => resolve({ status: res.statusCode, text }));
      },
    );
    req.on("error", reject);
    req.setTimeout(5000, () => req.destroy(Error("request timeout")));
    req.end(body);
  });
}
async function api(method, path, body) {
  const r = await request(method, "/api/v1" + path, body);
  assert.equal(r.status, 200, r.text);
  return JSON.parse(r.text);
}
function recordedText(r) {
  return r.events
    .filter((e) => e.kind === "output")
    .map((e) => Buffer.from(e.data.data, "base64").toString())
    .join("");
}
try {
  if (native) {
    serverContainer = native;
    webPort = Number(
      (await docker(["port", native, "8443/tcp"])).split(":").at(-1),
    );
    sshPort = Number(
      (await docker(["port", native, "2222/tcp"])).split(":").at(-1),
    );
    await docker(["network", "create", network]);
    await docker(["network", "connect", network, native]);
  } else {
    await compose("up", "-d", "--build", "--wait", "--wait-timeout", "90");
    serverContainer = await compose("ps", "-q", "server");
  }
  origin = `${plain ? "http" : "https"}://127.0.0.1:${webPort}`;
  if (!plain) ca = await readData("ca.crt");
  const credentials = JSON.parse(await readData("bootstrap-admin.json"));
  const caIdentity = plain
    ? null
    : await readData("certificates/private-ca.json");
  const hostKey = await readData("ssh_host_ed25519_key");
  token = (await api("POST", "/login", credentials)).access_token;
  assert.equal(
    (await request("GET", "/api/v1/devices", undefined, "")).status,
    401,
  );
  const page = await request("GET", "/");
  assert.equal(page.status, 200);
  assert.match(page.text, /id="app"/);
  const asset = page.text.match(/src="([^"]+\.js)"/)[1];
  assert.equal((await request("GET", asset)).status, 200);
  const fingerprint = (await api("GET", "/ssh")).fingerprint;
  if (!native) {
    const info = JSON.parse(await docker(["inspect", serverContainer]))[0];
    assert.equal(info.Config.User, "node");
    assert.equal(info.HostConfig.ReadonlyRootfs, true);
    assert.equal(info.HostConfig.RestartPolicy.Name, "unless-stopped");
    assert.equal(info.State.Health.Status, "healthy");
  }
  for (const key of ["host", "identity"])
    execFileSync("ssh-keygen", [
      "-q",
      "-t",
      "ed25519",
      "-N",
      "",
      "-f",
      join(temp, key),
    ]);
  writeFileSync(
    join(temp, "authorized_keys"),
    readFileSync(join(temp, "identity.pub")),
  );
  writeFileSync(
    join(temp, "sshd_config"),
    "Port 22\nHostKey /fixture/host\nAuthorizedKeysFile /etc/ssh/authorized_keys\nStrictModes no\nPasswordAuthentication no\nKbdInteractiveAuthentication no\nPermitRootLogin no\nAllowUsers terminal\nUsePAM no\nPrintMotd no\n",
  );
  const targetFingerprint = execFileSync(
    "ssh-keygen",
    ["-lf", join(temp, "host.pub"), "-E", "sha256"],
    { encoding: "utf8" },
  ).split(/\s+/)[1];
  await docker([
    "run",
    "-d",
    "--name",
    target,
    "--network",
    network,
    "--network-alias",
    "target",
    "--mount",
    `type=bind,source=${temp},target=/fixture,readonly`,
    "--mount",
    `type=bind,source=${temp}/authorized_keys,target=/etc/ssh/authorized_keys,readonly`,
    process.env.FLEET_SSH_TARGET_IMAGE || "farhelm-sshd-test:local",
  ]);
  const device = await api("POST", "/ssh-devices", {
    v: 1,
    name: "deployment-target",
    ssh: {
      host: "target",
      port: 22,
      username: "terminal",
      fingerprint: targetFingerprint,
    },
    private_key: readFileSync(join(temp, "identity"), "utf8"),
  });
  await until(
    async () =>
      (
        await api("POST", `/devices/${device.device_id}/connection/test`, {
          v: 1,
          revision: 1,
        })
      ).ok,
    "target SSH readiness",
  );
  const created = await api("POST", "/terminal-sessions", {
    v: 1,
    device_id: device.device_id,
    cols: 80,
    rows: 24,
  });
  ws = new WebSocket(origin.replace(/^http/, "ws") + "/api/v1/terminal/ws", {
    ca,
    origin,
  });
  let output = "",
    ready = false,
    ended = false;
  ws.on("message", (d) => {
    const message = JSON.parse(d);
    if (message.type === "terminal.ready") ready = true;
    if (message.type === "terminal.output")
      output += Buffer.from(message.body.data, "base64");
    if (message.type === "terminal.closed") ended = message.body;
  });
  await once(ws, "open");
  ws.send(
    JSON.stringify({
      v: 1,
      type: "terminal.attach",
      body: { session_id: created.session_id, ticket: created.ticket },
    }),
  );
  await until(() => {
    assert.ok(!ended, JSON.stringify(ended));
    return ready;
  }, "web terminal ready");
  ws.send(
    JSON.stringify({
      v: 1,
      type: "terminal.input",
      body: {
        data: Buffer.from("printf '__DEPLOY_WEB_%s__\\n' OK; exit\r").toString(
          "base64",
        ),
      },
    }),
  );
  await until(
    () => output.includes("__DEPLOY_WEB_OK__"),
    "web terminal output",
  );
  await until(
    async () =>
      (await api("GET", "/terminal-sessions")).sessions.find(
        (s) => s.id === created.session_id,
      )?.status === "CLOSED",
    "web terminal closed",
  );
  const webRecording = await api(
    "GET",
    `/terminal-sessions/${created.session_id}/recording`,
  );
  assert.match(recordedText(webRecording), /__DEPLOY_WEB_OK__/);
  sshClient = new Client();
  sshClient.connect({
    host: "127.0.0.1",
    port: sshPort,
    username: `${credentials.username}:${device.device_id}`,
    password: credentials.password,
    hostHash: "sha256",
    hostVerifier: (value) =>
      "SHA256:" +
        Buffer.from(value, "hex").toString("base64").replace(/=+$/, "") ===
      fingerprint,
  });
  await once(sshClient, "ready");
  const channel = await new Promise((resolve, reject) =>
    sshClient.shell({ term: "xterm", cols: 80, rows: 24 }, (error, stream) =>
      error ? reject(error) : resolve(stream),
    ),
  );
  let sshOutput = "";
  channel.on("data", (data) => (sshOutput += data));
  await until(() => sshOutput.includes("$"), "SSH target prompt");
  channel.write("printf '__DEPLOY_SSH_%s__\\n' OK; exit\r");
  await once(channel, "close");
  sshClient.end();
  assert.match(sshOutput, /__DEPLOY_SSH_OK__/);
  const sessions = (await api("GET", "/terminal-sessions")).sessions;
  const sshSession = sessions.find((s) => s.transport === "ssh");
  assert.equal(sshSession.status, "CLOSED");
  assert.equal(sshSession.audit_complete, 1);
  assert.match(
    recordedText(
      await api("GET", `/terminal-sessions/${sshSession.id}/recording`),
    ),
    /__DEPLOY_SSH_OK__/,
  );
  console.log(
    `PASS ${native ? "systemd" : plain ? "Compose HTTP" : "Compose HTTPS"}: web assets, login, authenticated API, WSS/WS terminal, SSH gateway and both recordings`,
  );
  if (!plain && process.env.FARHELM_TEST_AGENT_BIN) {
    const enrollment = (
      await api("POST", "/enrollment-tokens", { v: 1, ttl_seconds: 600 })
    ).enrollment_token;
    writeFileSync(join(temp, "ca.crt"), ca);
    await docker([
      "run",
      "-d",
      "--name",
      agentContainer,
      "--network",
      `container:${serverContainer}`,
      "--user",
      "terminal",
      "--workdir",
      "/home/terminal",
      "--mount",
      `type=bind,source=${resolve(process.env.FARHELM_TEST_AGENT_BIN)},target=/agent,readonly`,
      "--mount",
      `type=bind,source=${temp}/ca.crt,target=/ca.crt,readonly`,
      "--env",
      "FLEET_SERVER_URL=https://127.0.0.1:8444",
      "--env",
      "FLEET_CA_CERT=/ca.crt",
      "--env",
      "FLEET_STATE_DIR=/home/terminal/agent-state",
      "--env",
      `FLEET_ENROLLMENT_TOKEN=${enrollment}`,
      "--env",
      "FLEET_DEVICE_NAME=deployment-agent",
      "--env",
      "FLEET_EXECUTION_BACKEND=same-uid",
      "--env",
      "FLEET_HEARTBEAT_MS=500",
      process.env.FLEET_SSH_TARGET_IMAGE || "farhelm-sshd-test:local",
      "/agent",
    ]);
    let agentDevice;
    await until(async () => {
      agentDevice = (await api("GET", "/devices")).devices.find(
        (d) => d.name === "deployment-agent" && d.control_online,
      );
      return !!agentDevice;
    }, "real Agent online with installed CA");
    const terminal = await api("POST", "/terminal-sessions", {
      v: 1,
      device_id: agentDevice.id,
      cols: 80,
      rows: 24,
    });
    ws = new WebSocket(origin.replace(/^http/, "ws") + "/api/v1/terminal/ws", {
      ca,
      origin,
    });
    let agentReady = false,
      agentOutput = "";
    ws.on("message", (bytes) => {
      const m = JSON.parse(bytes);
      if (m.type === "terminal.ready") agentReady = true;
      if (m.type === "terminal.output")
        agentOutput += Buffer.from(m.body.data, "base64").toString();
    });
    await once(ws, "open");
    ws.send(
      JSON.stringify({
        v: 1,
        type: "terminal.attach",
        body: { session_id: terminal.session_id, ticket: terminal.ticket },
      }),
    );
    await until(() => agentReady, "Agent PTY ready");
    ws.send(
      JSON.stringify({
        v: 1,
        type: "terminal.input",
        body: {
          data: Buffer.from(
            "printf '__DEPLOY_AGENT_%s__\\n' OK; exit\r",
          ).toString("base64"),
        },
      }),
    );
    await until(
      () => agentOutput.includes("__DEPLOY_AGENT_OK__"),
      "Agent command output",
    );
    await until(
      async () =>
        (await api("GET", "/terminal-sessions")).sessions.find(
          (s) => s.id === terminal.session_id,
        )?.status === "CLOSED",
      "Agent PTY closed",
    );
    assert.match(
      recordedText(
        await api("GET", `/terminal-sessions/${terminal.session_id}/recording`),
      ),
      /__DEPLOY_AGENT_OK__/,
    );
    sessions.push({ id: terminal.session_id });
    await docker(["rm", "-f", agentContainer]);
    console.log(
      "PASS: real Linux Agent trusted the installed CA, connected, executed a PTY command and recorded it",
    );
  }
  if (native) {
    await docker(["restart", native]);
    webPort = Number(
      (await docker(["port", native, "8443/tcp"])).split(":").at(-1),
    );
    origin = `https://127.0.0.1:${webPort}`;
  } else
    await compose(
      "up",
      "-d",
      "--force-recreate",
      "--wait",
      "--wait-timeout",
      "90",
    );
  if (!native) serverContainer = await compose("ps", "-q", "server");
  await until(
    async () => {
      try {
        return (await request("GET", "/healthz")).status === 200;
      } catch {
        return false;
      }
    },
    "restart health",
    30000,
  );
  token = (await api("POST", "/login", credentials)).access_token;
  assert.equal(await readData("ssh_host_ed25519_key"), hostKey);
  if (!plain)
    assert.equal(await readData("certificates/private-ca.json"), caIdentity);
  assert.equal((await api("GET", "/ssh")).fingerprint, fingerprint);
  assert.ok(
    (await api("GET", "/devices")).devices.some(
      (d) => d.id === device.device_id,
    ),
  );
  for (const session of sessions) {
    const recording = await api(
      "GET",
      `/terminal-sessions/${session.id}/recording`,
    );
    assert.match(recordedText(recording), /__DEPLOY_(WEB|SSH|AGENT)_OK__/);
  }
  if (native) {
    assert.equal(
      await docker(["exec", native, "systemctl", "is-enabled", "farhelm"]),
      "enabled",
    );
    assert.equal(
      await docker(["exec", native, "systemctl", "is-active", "farhelm"]),
      "active",
    );
    await docker([
      "exec",
      native,
      "systemd-analyze",
      "verify",
      "/etc/systemd/system/farhelm.service",
    ]);
  }
  assert.ok(
    !(await docker(["logs", serverContainer])).includes(credentials.password),
  );
  console.log(
    "PASS: restart/recreate retained administrator, device, CA, SSH host key and historical recordings",
  );
} finally {
  await docker(["rm", "-f", agentContainer]).catch(() => {});
  ws?.terminate();
  sshClient?.destroy();
  await docker(["rm", "-f", target]).catch(() => {});
  if (native) {
    await docker(["network", "disconnect", network, native]).catch(() => {});
    await docker(["network", "rm", network]).catch(() => {});
  } else await compose("down", "-v", "--remove-orphans").catch(() => {});
  rmSync(temp, { recursive: true, force: true });
}
