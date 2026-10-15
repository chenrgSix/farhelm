import { checkSsh } from "./ssh-client.mjs";
import assert from "node:assert/strict";
import { spawn, execFileSync } from "node:child_process";
import { once } from "node:events";
import {
  mkdtempSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
  existsSync,
  appendFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { createRequire } from "node:module";
import { buildServer } from "../../apps/server/dist/server.js";
import { assertValid } from "../contracts/validate.mjs";
const require = createRequire(import.meta.url);
const { WebSocket } = require("../../apps/server/node_modules/ws");
const root = resolve(import.meta.dirname, "../..");
const temp = mkdtempSync(join(tmpdir(), "fleet-pty-e2e-"));
const tls = join(temp, "tls");
execFileSync("bash", [join(root, "deploy/dev/generate-tls.sh"), tls], {
  stdio: "ignore",
});
// Docker clients reach the host by this DNS name; trust remains explicit.
writeFileSync(
  join(tls, "extensions.cnf"),
  readFileSync(join(tls, "extensions.cnf"), "utf8").replace(
    "DNS:localhost",
    "DNS:localhost,DNS:host.docker.internal",
  ),
);
execFileSync(
  "openssl",
  [
    "x509",
    "-req",
    "-in",
    join(tls, "server.csr"),
    "-CA",
    join(tls, "ca.crt"),
    "-CAkey",
    join(tls, "ca.key"),
    "-CAserial",
    join(tls, "ca.srl"),
    "-out",
    join(tls, "server.crt"),
    "-days",
    "1",
    "-sha256",
    "-extfile",
    join(tls, "extensions.cnf"),
  ],
  { stdio: "ignore" },
);
const ca = readFileSync(join(tls, "ca.crt"));
const server = await buildServer({
  dataDir: join(temp, "server"),
  tlsCert: join(tls, "server.crt"),
  tlsKey: join(tls, "server.key"),
  adminUsername: "admin",
  adminPassword: "isolated-terminal-e2e-password",
  deviceTokenTtlMs: 2500,
  ssh: { host: "127.0.0.1", port: 0 },
});
await server.app.listen({ host: "127.0.0.1", port: 0 });
const port = server.app.server.address().port;
const origin = `https://localhost:${port}`;
const docker = process.env.FLEET_AGENT_DOCKER_IMAGE;
const name = `linux-fleet-pty-e2e-${process.pid}`;
const state = join(temp, "agent");
mkdirSync(state, { mode: 0o700 });
mkdirSync(join(root, ".test-output"), { recursive: true });
const log = join(root, ".test-output/terminal-agent.log");
writeFileSync(log, "");
let child;
const browsers = [];
const steps = [];
const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
async function until(fn, label, timeout = 10000) {
  const end = Date.now() + timeout;
  while (Date.now() < end) {
    if (await fn()) return;
    await pause(30);
  }
  throw Error("Timed out: " + label);
}
async function api(method, url, payload, auth) {
  const r = await server.app.inject({
    method,
    url,
    payload,
    headers: auth ? { authorization: "Bearer " + auth } : {},
  });
  assert.equal(r.statusCode, 200, r.body);
  return r.json();
}
async function open(auth) {
  const created = await api(
    "POST",
    "/api/v1/terminal-sessions",
    { v: 1, device_id: device.id, cols: 80, rows: 24 },
    auth,
  );
  const ws = new WebSocket(
    origin.replace("https:", "wss:") + "/api/v1/terminal/ws",
    { ca, headers: { origin } },
  );
  const chunks = [];
  let ready = false;
  let ended;
  ws.on("error", () => {});
  ws.on("message", (raw) => {
    const m = JSON.parse(raw);
    assertValid("envelope", m);
    if (m.type === "terminal.output")
      chunks.push(Buffer.from(m.body.data, "base64"));
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
  const send = (type, body) => ws.send(JSON.stringify({ v: 1, type, body }));
  const input = (text) =>
    send("terminal.input", { data: Buffer.from(text).toString("base64") });
  const text = () => Buffer.concat(chunks).toString();
  const wait = (needle) =>
    until(() => text().includes(needle), needle + ": " + text().slice(-400));
  await until(() => ready, "PTY ready");
  const result = {
    ws,
    id: created.session_id,
    input,
    send,
    text,
    wait,
    ended: () => ended,
  };
  browsers.push(result);
  return result;
}
let device;
try {
  const admin = (
    await api("POST", "/api/v1/login", {
      username: "admin",
      password: "isolated-terminal-e2e-password",
    })
  ).access_token;
  const enrollment = (
    await api(
      "POST",
      "/api/v1/enrollment-tokens",
      { v: 1, ttl_seconds: 600 },
      admin,
    )
  ).enrollment_token;
  const binary =
    process.env.FLEET_AGENT_BIN || join(root, "agent/target/debug/fleet-agent");
  assert.ok(existsSync(binary), "Build the actual Rust agent first");
  const env = {
    FLEET_SERVER_URL: docker ? `https://host.docker.internal:${port}` : origin,
    FLEET_CA_CERT: docker ? "/ca.crt" : join(tls, "ca.crt"),
    FLEET_STATE_DIR: docker ? "/state" : state,
    FLEET_ENROLLMENT_TOKEN: enrollment,
    FLEET_DEVICE_NAME: "real-pty-linux",
    FLEET_EXECUTION_BACKEND: "same-uid",
    FLEET_HEARTBEAT_MS: "200",
  };
  if (docker) {
    const args = [
      "run",
      "--rm",
      "--name",
      name,
      "--user",
      `${process.getuid()}:${process.getgid()}`,
      "--mount",
      `type=bind,source=${state},target=/state`,
      "--mount",
      `type=bind,source=${join(tls, "ca.crt")},target=/ca.crt,readonly`,
      "--mount",
      `type=bind,source=${binary},target=/agent,readonly`,
    ];
    for (const [key, value] of Object.entries(env))
      args.push("--env", `${key}=${value}`);
    child = spawn("docker", [...args, docker, "/agent"], {
      stdio: ["ignore", "pipe", "pipe"],
    });
  } else
    child = spawn(binary, [], {
      env: { ...process.env, ...env },
      stdio: ["ignore", "pipe", "pipe"],
    });
  child.stdout.on("data", (bytes) => appendFileSync(log, bytes));
  child.stderr.on("data", (bytes) => appendFileSync(log, bytes));
  await until(async () => {
    device = (await api("GET", "/api/v1/devices", undefined, admin)).devices[0];
    return device?.control_online;
  }, "actual Rust agent online");
  server.store.seedUser({
    username: "operator",
    password: "isolated-terminal-e2e-password",
    role: "ops",
    deviceScope: [device.id],
  });
  const ops = (
    await api("POST", "/api/v1/login", {
      username: "operator",
      password: "isolated-terminal-e2e-password",
    })
  ).access_token;
  const a = await open(admin),
    b = await open(ops);
  a.input("stty -echo;printf '\\136READY_A\\136\\n'\r");
  b.input("stty -echo;printf '\\136READY_B\\136\\n'\r");
  await Promise.all([a.wait("^READY_A^"), b.wait("^READY_B^")]);
  a.send("terminal.resize", { cols: 110, rows: 32 });
  a.input(
    "test -t 0 && printf 'REAL_TTY\\n';stty size;cd /tmp;printf '\\136SIZE_END\\136\\n'\r",
  );
  await a.wait("^SIZE_END^");
  assert.ok(a.text().includes("32 110\r\n"));
  assert.ok(a.text().includes("REAL_TTY\r\n"));
  a.input(
    "pwd;printf '\\344\\270\\255%.0s' {1..2000};printf '\\136UNICODE_END\\136\\n'\r",
  );
  b.input("cd /;pwd;printf '\\136OTHER_END\\136\\n'\r");
  await Promise.all([a.wait("^UNICODE_END^"), b.wait("^OTHER_END^")]);
  assert.ok(a.text().includes("/tmp\r\n"));
  assert.ok(a.text().includes("中".repeat(2000)));
  assert.ok(b.text().includes("/\r\n"));
  steps.push(
    "two users have independent real Linux PTYs; persistent cwd, resize and cross-frame UTF-8",
  );
  a.input("printf '\\136WAIT\\136\\n';sleep 30\r");
  await a.wait("^WAIT^");
  a.input("\x03");
  a.input("printf '\\136CTRL_C_OK\\136\\n'\r");
  await a.wait("^CTRL_C_OK^");
  steps.push(
    "Ctrl-C interrupts the foreground process and the shell remains usable",
  );
  a.input(
    "read -s -p 'Password: ' fleet_secret;printf '\\n\\136PASSWORD_END\\136\\n'\r",
  );
  await a.wait("Password: ");
  a.input("secret-that-must-not-be-recorded\r");
  await a.wait("^PASSWORD_END^");
  await pause(3500);
  a.input("printf '\\136RENEWED\\136\\n'\r");
  await a.wait("^RENEWED^");
  assert.equal(
    (readFileSync(log, "utf8").match(/control connected/g) || []).length,
    1,
  );
  steps.push(
    "short device tokens renew in place without disconnecting the terminal",
  );
  a.input("exit\r");
  await until(() => a.ended(), "normal shell exit");
  assert.equal(a.ended().audit_complete, true);
  b.ws.terminate();
  await until(
    async () =>
      (
        await api("GET", "/api/v1/terminal-sessions", undefined, admin)
      ).sessions.find((s) => s.id === b.id)?.status === "INTERRUPTED",
    "browser loss closes PTY",
  );
  const events = [];
  let after = 0;
  for (;;) {
    const r = await api(
      "GET",
      `/api/v1/terminal-sessions/${a.id}/recording?after=${after}`,
      undefined,
      admin,
    );
    events.push(...r.events);
    if (!r.events.length) break;
    after = r.next;
  }
  const recorded = Buffer.concat(
    events
      .filter((e) => e.kind === "output")
      .map((e) => Buffer.from(e.data.data, "base64")),
  ).toString();
  assert.ok(recorded.includes("中".repeat(2000)));
  assert.equal(recorded.includes("secret-that-must-not-be-recorded"), false);
  assert.ok(events.some((e) => e.kind === "resize"));
  assert.notEqual(
    (
      await api("GET", "/api/v1/terminal-sessions", undefined, admin)
    ).sessions.find((s) => s.id === a.id).actor_id,
    (
      await api("GET", "/api/v1/terminal-sessions", undefined, admin)
    ).sessions.find((s) => s.id === b.id).actor_id,
  );
  steps.push(
    "durable recordings preserve output/timing/resize; hidden password input is absent; normal exit vs interruption is explicit",
  );
  await checkSsh({ server, deviceId: device.id, temp, until, steps });
  assertValid(
    "audit-response",
    await api("GET", "/api/v1/audit", undefined, admin),
  );
  writeFileSync(
    join(root, ".test-output/terminal-e2e.json"),
    JSON.stringify(
      { passed: true, actualRust: true, docker: !!docker, steps },
      null,
      2,
    ),
  );
  console.log(
    "PASS actual Rust terminal E2E:\n" +
      steps.map((step) => "- " + step).join("\n"),
  );
} finally {
  for (const b of browsers) b.ws.terminate();
  if (docker) {
    try {
      execFileSync("docker", ["rm", "--force", name], { stdio: "ignore" });
    } catch {}
  } else child?.kill("SIGTERM");
  await server.close();
}
