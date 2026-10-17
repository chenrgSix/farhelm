// Isolated HTTP management + real Linux Agent, HTTPS renewal, web/SSH PTYs and recordings.
// Reuses a released Agent binary and an existing Linux image; no Rust build cache.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import {
  mkdtempSync,
  readFileSync,
  writeFileSync,
  rmSync,
  existsSync,
} from "node:fs";
import { resolve, join } from "node:path";
import { createServer } from "node:net";
import { createRequire } from "node:module";
import http from "node:http";
import https from "node:https";
import { initialize } from "../../deploy/server/bootstrap.mjs";
import { DeploymentController } from "../../apps/server/dist/deployment-settings.js";
import { Store } from "../../apps/server/dist/store.js";
import { PrivateAuthority } from "../../apps/server/dist/private-ca.js";
import { certificateInfo } from "../../apps/server/dist/certificate-files.js";
import { buildServer } from "../../apps/server/dist/server.js";
const require = createRequire(import.meta.url);
const { WebSocket } = require("../../apps/server/node_modules/ws");
const { Client } = require("../../apps/server/node_modules/ssh2");
const root = resolve(import.meta.dirname, "../..");
const temp = mkdtempSync("/tmp/fh-split-");
const data = join(temp, "data");
const container = `farhelm-split-${process.pid}`;
const password = "isolated-split-test1";
const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
async function freePort() {
  const server = createServer();
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  const port = server.address().port;
  await new Promise((r) => server.close(r));
  return port;
}
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
async function until(fn, label, ms = 20000) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (await fn()) return;
    await wait(100);
  }
  throw Error("Timed out: " + label);
}
const webPort = await freePort(),
  agentPort = await freePort(),
  sshPort = await freePort();
const agentUrl = `https://host.docker.internal:${agentPort}`;
let protocol = "http",
  token = "",
  ca,
  running,
  controller,
  ssh,
  shell;
const webSockets = [];
const base = () => `${protocol}://host.docker.internal:${webPort}`;
const env = {
  FLEET_DATA_DIR: data,
  FLEET_HOST: "127.0.0.1",
  FLEET_PORT: String(webPort),
  FLEET_AGENT_PORT: String(agentPort),
  FLEET_SSH_PORT: String(sshPort),
  FLEET_SSH_HOST: "127.0.0.1",
  FLEET_DEVICE_ACCESS: "agent-ssh",
  FLEET_WEB_PROTOCOL: "http",
  FLEET_WEB_ENABLED: "1",
  FLEET_WEB_DIST: join(root, "apps/web/dist"),
  FARHELM_PUBLIC_HOST: "host.docker.internal",
  FLEET_ADMIN_USER: "admin",
  FLEET_ADMIN_PASSWORD: password,
};
async function request(url, method = "GET", payload, auth = token) {
  return new Promise((resolve, reject) => {
    const req = (url.startsWith("https:") ? https : http).request(
      url,
      {
        method,
        ca,
        agent: false,
        lookup: (_host, _opts, cb) =>
          cb(null, [{ address: "127.0.0.1", family: 4 }]),
        headers: {
          ...(payload ? { "content-type": "application/json" } : {}),
          ...(auth ? { authorization: `Bearer ${auth}` } : {}),
        },
      },
      (res) => {
        const fingerprint =
          res.socket.getPeerX509Certificate?.()?.fingerprint256;
        let body = "";
        res.on("data", (d) => (body += d));
        res.on("end", () =>
          resolve({
            status: res.statusCode,
            body,
            headers: res.headers,
            fingerprint,
          }),
        );
      },
    );
    req.setTimeout(5000, () => req.destroy(Error("request timeout")));
    req.on("error", reject);
    req.end(payload ? JSON.stringify(payload) : undefined);
  });
}
async function api(path, method = "GET", payload, auth = token) {
  const r = await request(base() + "/api/v1" + path, method, payload, auth);
  assert.equal(r.status, 200, r.body);
  return JSON.parse(r.body);
}
function recorded(recording) {
  return recording.events
    .filter((e) => e.kind === "output")
    .map((e) => Buffer.from(e.data.data, "base64").toString())
    .join("");
}
try {
  const installed = await initialize(env);
  assert.equal(installed.agent_url, agentUrl);
  assert.equal(installed.url, base());
  ca = readFileSync(join(data, "ca.crt"));
  writeFileSync(join(temp, "ca.crt"), ca, { mode: 0o644 });
  // Only this isolated fixture uses 80-second leaves, so the real renewal timer runs.
  const fixtureStore = new Store(data);
  try {
    const bundle = {
      ...(await new PrivateAuthority(fixtureStore).issue(
        "host.docker.internal",
        80000,
      )),
      domain: "host.docker.internal",
      mode: "private",
    };
    writeFileSync(
      join(data, "certificates/active.json"),
      JSON.stringify(bundle),
      { mode: 0o600 },
    );
    fixtureStore.db
      .prepare("UPDATE certificate_settings SET next_attempt_at=? WHERE id=1")
      .run(certificateInfo(bundle.cert).renew_at);
  } finally {
    fixtureStore.close();
  }
  controller = new DeploymentController(
    env,
    async (config) =>
      (running = await buildServer({
        ...config,
        logger: false,
        testMode: true,
        certificateTest: { privateLeafLifetimeMs: 80000 },
      })),
  );
  await controller.start();
  const core = running;
  token = (await api("/login", "POST", { username: "admin", password }, ""))
    .access_token;
  assert.equal(
    (await request(base() + "/api/v1/devices", "GET", undefined, "")).status,
    401,
  );
  assert.equal((await request(agentUrl + "/api/v1/devices")).status, 404);
  assert.equal(
    (await request(base() + "/api/agent/challenge", "POST", {})).status,
    403,
  );
  assert.equal((await api("/settings")).agent_https_port, agentPort);
  assert.match((await request(base() + "/")).body, /id="app"/);
  let cert = await api("/settings/certificate");
  const first = cert.certificate.fingerprint;
  const enrollment = (
    await api("/enrollment-tokens", "POST", { v: 1, ttl_seconds: 600 })
  ).enrollment_token;
  const binary = resolve(
    process.env.FARHELM_TEST_AGENT_BIN ??
      join(root, ".dev/agent-dist/farhelm-agent-linux-aarch64"),
  );
  await docker([
    "run",
    "-d",
    "--name",
    container,
    "--user",
    "fleet",
    "--workdir",
    "/home/fleet",
    "--entrypoint",
    "/agent",
    "--mount",
    `type=bind,source=${binary},target=/agent,readonly`,
    "--mount",
    `type=bind,source=${temp}/ca.crt,target=/ca.crt,readonly`,
    "--env",
    `FLEET_SERVER_URL=${agentUrl}`,
    "--env",
    "FLEET_CA_CERT=/ca.crt",
    "--env",
    "FLEET_STATE_DIR=/home/fleet/split-agent",
    "--env",
    `FLEET_ENROLLMENT_TOKEN=${enrollment}`,
    "--env",
    "FLEET_DEVICE_NAME=split-agent",
    "--env",
    "FLEET_EXECUTION_BACKEND=same-uid",
    "--env",
    "FLEET_HEARTBEAT_MS=500",
    process.env.FARHELM_TEST_AGENT_IMAGE ?? "farhelm-agent-dev:local",
  ]);
  let device;
  await until(async () => {
    device = (await api("/devices")).devices.find(
      (d) => d.name === "split-agent",
    );
    return device?.control_online;
  }, "real Agent online");
  assert.equal((await api("/settings/deployment")).agents_on_web, 0);
  async function openTerminal() {
    const created = await api("/terminal-sessions", "POST", {
      v: 1,
      device_id: device.id,
      cols: 80,
      rows: 24,
    });
    const ws = new WebSocket(
      base().replace(/^http/, "ws") + "/api/v1/terminal/ws",
      {
        ca,
        origin: base(),
        lookup: (_host, _opts, cb) =>
          cb(null, [{ address: "127.0.0.1", family: 4 }]),
      },
    );
    webSockets.push(ws);
    const state = {
      id: created.session_id,
      output: "",
      ready: false,
      ended: null,
      ws,
      input: (text) =>
        ws.send(
          JSON.stringify({
            v: 1,
            type: "terminal.input",
            body: { data: Buffer.from(text).toString("base64") },
          }),
        ),
    };
    ws.on("error", () => {});
    ws.on("message", (raw) => {
      const m = JSON.parse(raw);
      if (m.type === "terminal.ready") state.ready = true;
      if (m.type === "terminal.output")
        state.output += Buffer.from(m.body.data, "base64").toString();
      if (m.type === "terminal.closed") state.ended = m.body;
    });
    await once(ws, "open");
    ws.send(
      JSON.stringify({
        v: 1,
        type: "terminal.attach",
        body: { session_id: created.session_id, ticket: created.ticket },
      }),
    );
    await until(() => state.ready, "web PTY ready");
    return state;
  }
  const terminal = await openTerminal();
  const fingerprint = (await api("/ssh")).fingerprint;
  ssh = new Client();
  ssh.connect({
    host: "127.0.0.1",
    port: sshPort,
    username: `admin:${device.id}`,
    password,
    hostHash: "sha256",
    hostVerifier: (h) =>
      "SHA256:" +
        Buffer.from(h, "hex").toString("base64").replace(/=+$/, "") ===
      fingerprint,
  });
  await once(ssh, "ready");
  shell = await new Promise((resolve, reject) =>
    ssh.shell({ term: "xterm", cols: 80, rows: 24 }, (e, c) =>
      e ? reject(e) : resolve(c),
    ),
  );
  let sshOutput = "";
  shell.on("data", (d) => (sshOutput += d.toString()));
  const markers = [];
  async function alive(marker) {
    assert.equal(running, core);
    assert.equal(terminal.ws.readyState, WebSocket.OPEN);
    terminal.input(`printf '__WEB_%s__\\n' ${marker}\r`);
    shell.write(`printf '__SSH_%s__\\n' ${marker}\r`);
    await until(
      () =>
        terminal.output.includes(`__WEB_${marker}__`) &&
        sshOutput.includes(`__SSH_${marker}__`),
      marker,
    );
    assert.ok(
      (await api("/devices")).devices.find((d) => d.id === device.id)
        .control_online,
    );
    markers.push(marker);
  }
  await alive("HTTP_START");
  console.log(
    "PASS HTTP web + HTTPS Agent: real Linux web/SSH terminals active; waiting for the automatic renewal timer",
  );
  await until(
    async () => {
      cert = await api("/settings/certificate");
      return cert.certificate.fingerprint !== first;
    },
    "automatic certificate renewal while management uses HTTP",
    75000,
  );
  assert.equal(
    (await request(agentUrl + "/healthz")).fingerprint,
    cert.certificate.fingerprint,
  );
  await alive("HTTP_AUTO_RENEW");
  async function switchWeb(next) {
    const state = await api("/settings/deployment");
    await api("/settings/deployment", "PUT", {
      v: 1,
      revision: state.revision,
      settings: { ...state.settings, web_protocol: next },
      entry_origin: base(),
      confirm_web_disable: false,
    });
    protocol = next;
    await until(async () => {
      try {
        return (
          (await api("/settings/deployment")).state === "awaiting_confirmation"
        );
      } catch {
        return false;
      }
    }, "protocol switch");
    const changed = await api("/settings/deployment");
    await api("/settings/deployment/confirm", "POST", {
      v: 1,
      revision: changed.revision,
    });
  }
  console.log(
    "PASS automatic renewal while web uses HTTP; Agent and both terminals remain connected",
  );
  await switchWeb("https");
  await alive("HTTPS_SWITCH");
  const fresh = await openTerminal();
  fresh.input("printf '__FRESH_%s__\\n' HTTPS; exit\r");
  await until(() => fresh.ended, "fresh WSS exit");
  assert.ok(fresh.output.includes("__FRESH_HTTPS__"));
  const previous = cert.certificate.fingerprint;
  await until(
    async () => {
      cert = await api("/settings/certificate");
      return cert.certificate.fingerprint !== previous;
    },
    "automatically renew both HTTPS listeners",
    75000,
  );
  assert.equal(
    (await request(base() + "/healthz")).fingerprint,
    cert.certificate.fingerprint,
  );
  assert.equal(
    (await request(agentUrl + "/healthz")).fingerprint,
    cert.certificate.fingerprint,
  );
  await alive("HTTPS_RENEW");
  await switchWeb("http");
  await alive("HTTP_RETURN");
  assert.equal(
    (await request(base() + "/healthz")).headers["strict-transport-security"],
    undefined,
  );
  assert.equal(
    (await api("/settings/certificate/ca")).certificate_pem,
    ca.toString(),
  );
  assert.equal((await api("/ssh")).fingerprint, fingerprint);
  const logs = await docker(["logs", container]);
  assert.equal(
    (logs.match(/control connected/g) ?? []).length,
    1,
    "Agent must not reconnect during switches/renewals",
  );
  terminal.input("exit\r");
  shell.write("exit\r");
  await until(() => terminal.ended, "web terminal end");
  let sessions;
  await until(async () => {
    sessions = (await api("/terminal-sessions")).sessions;
    return sessions.length === 3 && sessions.every((s) => s.ended_at);
  }, "all terminals closed");
  for (const session of sessions) {
    const recording = await api(`/terminal-sessions/${session.id}/recording`);
    assert.equal(recording.session.audit_complete, 1);
    assert.equal(recording.session.status, "CLOSED");
    const output = recorded(recording);
    if (session.id === terminal.id)
      for (const m of markers) assert.ok(output.includes(`__WEB_${m}__`));
    if (session.transport === "ssh")
      for (const m of markers) assert.ok(output.includes(`__SSH_${m}__`));
  }
  console.log(
    "PASS automatic CA renewal, HTTP/HTTPS switches, fresh WSS, unchanged Agent/SSH connections, complete recordings and CA/host-key persistence",
  );
  await new Promise((resolve, reject) => {
    const child = spawn(
      process.execPath,
      [join(root, "deploy/server/healthcheck.mjs")],
      { env: { ...process.env, ...env }, stdio: "pipe" },
    );
    child.on("error", reject);
    child.on("exit", (code) =>
      code === 0 ? resolve() : reject(Error("Health check failed: " + code)),
    );
  });
  if (process.env.FARHELM_TEST_BROWSER_HOLD === "1") {
    writeFileSync(
      join(root, ".test-output/split-browser.json"),
      JSON.stringify({ url: base(), temp, username: "admin", password }) + "\n",
      { mode: 0o600 },
    );
    console.log(
      `Browser fixture ready at ${base()}; create ${temp}/done to finish`,
    );
    await until(
      () => existsSync(join(temp, "done")),
      "browser verification",
      300000,
    );
  }
} finally {
  for (const ws of webSockets) ws.terminate();
  ssh?.destroy();
  await controller?.stop();
  await docker(["rm", "-f", container]).catch(() => {});
  rmSync(temp, { recursive: true, force: true });
  rmSync(join(root, ".test-output/split-browser.json"), { force: true });
}
