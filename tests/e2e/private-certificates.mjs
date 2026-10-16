// Offline private CA, generated Linux installer, unified web/API/Agent entry and real renewal timer.
import assert from "node:assert/strict";
import { spawn, execFileSync } from "node:child_process";
import { once } from "node:events";
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve, join } from "node:path";
import { createServer as tcpServer } from "node:net";
import { request } from "node:https";
import { createRequire } from "node:module";
import { buildServer } from "../../apps/server/dist/server.js";
const require = createRequire(import.meta.url);
const { WebSocket } = require("../../apps/server/node_modules/ws");
const root = resolve(import.meta.dirname, "../..");
const temp = mkdtempSync(join(tmpdir(), "farhelm-private-e2e-"));
const dataDir = join(temp, "server");
const initialize = () =>
  execFileSync(
    process.execPath,
    [join(root, "scripts/init-private-tls.mjs"), dataDir],
    { stdio: "pipe" },
  );
initialize();
const ca = readFileSync(join(dataDir, "bootstrap-tls/ca.crt"));
const initialCA = readFileSync(join(dataDir, "certificates/private-ca.json"));
initialize();
assert.deepEqual(
  readFileSync(join(dataDir, "certificates/private-ca.json")),
  initialCA,
);
const domain = "private.farhelm.internal",
  password = "isolated-private-certificate-password1";
const agent = `farhelm-private-agent-${process.pid}`;
let server, terminal;
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
  const apiPort = await freePort();
  const origin = `https://${domain}:${apiPort}`;
  const serverConfig = {
    dataDir,
    tlsCert: join(dataDir, "bootstrap-tls/server.crt"),
    tlsKey: join(dataDir, "bootstrap-tls/server.key"),
    webDist: join(root, "apps/web/dist"),
    adminUsername: "admin",
    adminPassword: password,
    testMode: true,
    certificateTest: { privateLeafLifetimeMs: 80000 },
    agentInstall: { distDir: join(root, ".dev/agent-dist"), publicUrl: origin },
  };
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
  const config = {
    v: 1,
    revision: 0,
    mode: "private",
    domain,
    email: "",
    enabled: false,
    tos_agreed: false,
  };
  await api("PUT", "/settings/certificate", config);
  await api("POST", "/settings/certificate/ca", { v: 1, revision: 1 });
  const issuerRoot = (await api("GET", "/settings/certificate/ca"))
    .certificate_pem;
  assert.equal(issuerRoot, ca.toString());
  await api("PUT", "/settings/certificate", {
    ...config,
    revision: 1,
    enabled: true,
  });
  let first;
  await until(async () => {
    const s = await api("GET", "/settings/certificate");
    if (s.status === "error") throw Error(JSON.stringify(s.last_error));
    if (s.status === "valid") {
      first = s.certificate;
      return true;
    }
  }, "private CA issuance");
  const lookup = (_name, _options, callback) =>
    callback(null, [{ address: "127.0.0.1", family: 4 }]);
  const health = () => https(origin + "/healthz", { ca: issuerRoot, lookup });
  assert.equal((await health()).fingerprint, first.fingerprint);
  assert.ok(
    (await https(origin, { ca: issuerRoot, lookup })).body.includes('id="app"'),
  );
  await assert.rejects(() =>
    https(origin + "/healthz", { lookup, ca: undefined }),
  );
  await https(`https://localhost:${apiPort}/healthz`);
  const installation = await api("POST", "/agent-installations", {
    v: 1,
    name: "private-renewal-agent",
    run_user: "farhelm",
    start_mode: "background",
  });
  writeFileSync(join(temp, "install.sh"), installation.command + "\n", {
    mode: 0o600,
  });
  await docker([
    "run",
    "--rm",
    "--init",
    "-d",
    "--name",
    agent,
    "--platform",
    "linux/arm64",
    "--add-host",
    `${domain}:host-gateway`,
    "--mount",
    `type=bind,source=${join(temp, "install.sh")},target=/install.sh,readonly`,
    "farhelm-agent-build:arm64",
    "sleep",
    "infinity",
  ]);
  await docker(["exec", agent, "bash", "/install.sh"]);
  assert.equal(
    await docker(["exec", agent, "cat", "/var/lib/farhelm-agent/ca.crt"]),
    issuerRoot,
  );
  console.log(
    "PASS: offline private issuance, unified HTTPS entry, generated installer automatically trusts CA",
  );
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
      { ca: issuerRoot, lookup, headers: { origin } },
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
  terminal = await open();
  terminal.input("printf '__BEFORE_%s__\\n' PRIVATE\r");
  await until(
    () => terminal.output().includes("__BEFORE_PRIVATE__"),
    "before renewal output",
  );
  console.log(
    "PASS: real Linux PTY active; waiting for automatic renewal timer",
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
  assert.equal(
    (await api("GET", "/settings/certificate/ca")).certificate_pem,
    issuerRoot,
  );
  assert.ok(renewed.expires_at > first.expires_at);
  terminal.input("printf '__AFTER_%s__\\n' PRIVATE; exit\r");
  await until(() => terminal.ended(), "PTY exit");
  assert.ok(terminal.output().includes("__AFTER_PRIVATE__"));
  assert.equal(terminal.ended().audit_complete, true);
  const log = await docker([
    "exec",
    agent,
    "cat",
    "/var/log/farhelm-agent.log",
  ]);
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
    recorded.includes("__BEFORE_PRIVATE__") &&
      recorded.includes("__AFTER_PRIVATE__"),
  );
  terminal.ws.close();
  terminal = undefined;
  server.testHooks.disconnectDevice(device.id);
  await until(
    async () =>
      (
        await docker(["exec", agent, "cat", "/var/log/farhelm-agent.log"])
      ).match(/control connected/g)?.length >= 2,
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
    join(root, ".test-output/private-certificates.json"),
    JSON.stringify(
      {
        passed: true,
        offline_issuance: true,
        bootstrap_same_ca: true,
        generated_installer: true,
        same_ca_after_renewal: true,
        automatic_renewal: true,
        agent_session_preserved: true,
        recording_complete: true,
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
  console.error(
    (
      await docker([
        "exec",
        agent,
        "tail",
        "-30",
        "/var/log/farhelm-agent.log",
      ]).catch(() => "")
    ).slice(-2000),
  );
  process.exitCode = 1;
} finally {
  terminal?.ws.terminate();
  await docker(["rm", "-f", agent]).catch(() => {});
  await server?.close();
}
