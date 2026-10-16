// Real old Agent upgrade + browser CA rollout + live PTY cutover and persistent trust.
// The existing local CA is used only as a trusted bootstrap; no system trust changes.
import assert from "node:assert/strict";
import { chromium } from "@playwright/test";
import { spawn } from "node:child_process";
import { once } from "node:events";
import {
  mkdtempSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
  copyFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { resolve, join } from "node:path";
import { randomUUID } from "node:crypto";
import { request } from "node:https";
import { createRequire } from "node:module";
import { buildServer } from "../../apps/server/dist/server.js";
import { assertValid } from "../contracts/validate.mjs";
const require = createRequire(import.meta.url),
  { WebSocket } = require("../../apps/server/node_modules/ws");
const root = resolve(import.meta.dirname, "../.."),
  temp = mkdtempSync(join(tmpdir(), "farhelm-ca-e2e-")),
  dist = join(temp, "dist");
mkdirSync(dist);
const baseline =
  process.env.FLEET_AGENT_BASELINE_DIST_DIR ??
  join(root, ".test-output/ca-baseline");
const target =
  process.env.FLEET_AGENT_DIST_DIR ?? join(root, ".dev/agent-dist");
const tls = process.env.FLEET_TEST_TLS_DIR ?? join(root, ".dev/tls");
const oldCA = readFileSync(join(tls, "ca.crt"), "utf8");
function publish(from) {
  for (const arch of ["aarch64", "x86_64"])
    for (const ext of ["", ".json"])
      copyFileSync(
        join(from, `farhelm-agent-linux-${arch}${ext}`),
        join(dist, `farhelm-agent-linux-${arch}${ext}`),
      );
}
publish(baseline);
assert.equal(
  JSON.parse(readFileSync(join(dist, "farhelm-agent-linux-aarch64.json")))
    .version,
  "0.2.3",
);
const container = `farhelm-ca-sync-${process.pid}`,
  password = "isolated-ca-sync-password1";
let server, browser, terminal;
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
async function until(fn, label, ms = 45000) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (await fn()) return;
    await new Promise((r) => setTimeout(r, 200));
  }
  throw Error("Timed out: " + label);
}
function https(url, ca) {
  return new Promise((resolve, reject) => {
    const r = request(url, { ca, agent: false }, (res) => {
      const fingerprint = res.socket.getPeerX509Certificate()?.fingerprint256;
      res.resume();
      res.on("end", () =>
        res.statusCode === 200
          ? resolve(fingerprint)
          : reject(Error("HTTPS " + res.statusCode)),
      );
    });
    r.on("error", reject);
    r.setTimeout(5000, () => r.destroy(Error("HTTPS timeout")));
    r.end();
  });
}
try {
  const config = {
    dataDir: join(temp, "server"),
    tlsCert: join(tls, "server.crt"),
    tlsKey: join(tls, "server.key"),
    webDist: join(root, "apps/web/dist"),
    adminUsername: "admin",
    adminPassword: password,
    testMode: true,
    agentInstall: { distDir: dist, caCert: join(tls, "ca.crt") },
  };
  server = await buildServer(config);
  await server.app.listen({ host: "127.0.0.1", port: 0 });
  const port = server.app.server.address().port,
    origin = `https://localhost:${port}`,
    agentOrigin = `https://host.docker.internal:${port}`;
  let token;
  async function api(method, path, payload, expected = 200) {
    const r = await server.app.inject({
      method,
      url: "/api/v1" + path,
      payload,
      headers: token ? { authorization: `Bearer ${token}` } : {},
    });
    assert.equal(r.statusCode, expected, r.body);
    return r.json();
  }
  token = (await api("POST", "/login", { username: "admin", password }))
    .access_token;
  await api("PUT", "/settings", {
    v: 1,
    revision: 0,
    platform_server_url: agentOrigin,
  });
  const installation = await api("POST", "/agent-installations", {
    v: 1,
    name: "CA rollout Linux",
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
    container,
    "--platform",
    "linux/arm64",
    "--mount",
    `type=bind,source=${join(temp, "install.sh")},target=/install.sh,readonly`,
    "farhelm-agent-build:arm64",
    "sleep",
    "infinity",
  ]);
  await docker(["exec", container, "bash", "/install.sh"]);
  let device;
  await until(async () => {
    device = (await api("GET", "/devices")).devices[0];
    return device?.control_online;
  }, "old Agent online");
  assert.equal(device.agent_version, "0.2.3");
  browser = await chromium.launch({ headless: true });
  const page = await browser.newPage({
      viewport: { width: 1440, height: 1100 },
    }),
    errors = [];
  page.on("pageerror", (e) => errors.push(e.message));
  await page.goto(origin);
  await page.getByLabel("账号", { exact: true }).fill("admin");
  await page.getByLabel("密码", { exact: true }).fill(password);
  await page.getByRole("button", { name: "登录 →", exact: true }).click();
  await page.getByRole("button", { name: "系统设置", exact: true }).click();
  await page.locator('[name="certificate-mode"]').selectOption("private");
  await page
    .locator('[name="certificate-domain"]')
    .fill("host.docker.internal");
  await page.getByRole("button", { name: "保存证书设置", exact: true }).click();
  await page.getByRole("button", { name: "创建内网 CA", exact: true }).click();
  await page
    .getByText("需先升级 Agent 至 0.2.4 或更高版本", { exact: true })
    .waitFor();
  assert.equal(
    await page.locator('[name="certificate-enabled"]').isDisabled(),
    true,
  );
  const settings = await api("GET", "/settings/certificate");
  assert.equal(
    (
      await api(
        "PUT",
        "/settings/certificate",
        {
          v: 1,
          revision: settings.revision,
          mode: "private",
          domain: "host.docker.internal",
          email: "",
          enabled: true,
          tos_agreed: false,
        },
        409,
      )
    ).error,
    "AGENT_CA_SYNC_INCOMPLETE",
  );
  console.log(
    "PASS: real old Agent shown as unsupported; browser and API prevent premature cutover",
  );
  publish(target);
  const release = (await api("GET", "/agent-releases")).releases.find(
    (r) => r.arch === "aarch64" && r.version === "0.2.4",
  );
  assert.ok(release);
  await api("POST", "/agent-upgrades", {
    v: 1,
    request_id: randomUUID(),
    concurrency: 1,
    targets: [{ device_id: device.id, sha256: release.sha256 }],
  });
  await until(
    async () => {
      const u = await api("GET", "/agent-upgrades");
      if (u.jobs[0]?.status === "FAILED") throw Error(u.jobs[0].reason);
      return u.jobs[0]?.status === "SUCCEEDED" && u.devices[0]?.online;
    },
    "existing Agent upgraded to 0.2.4",
    90000,
  );
  assert.equal((await api("GET", "/devices")).devices.length, 1);
  const ca = (await api("GET", "/settings/certificate/ca")).certificate_pem;
  async function open() {
    const created = await api("POST", "/terminal-sessions", {
      v: 1,
      device_id: device.id,
      cols: 80,
      rows: 24,
    });
    const ws = new WebSocket(
      origin.replace("https:", "wss:") + "/api/v1/terminal/ws",
      { ca: oldCA, headers: { origin } },
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
  }
  terminal = await open();
  terminal.input("printf '__BEFORE_%s__\\n' CA\r");
  await until(
    () => terminal.output().includes("__BEFORE_CA__"),
    "initial PTY output",
  );
  const connections = async () =>
    (
      (
        await docker(["exec", container, "cat", "/var/log/farhelm-agent.log"])
      ).match(/control connected/g) ?? []
    ).length;
  const before = await connections();
  const response = page.waitForResponse(
    (r) =>
      r.request().method() === "POST" &&
      r.url().endsWith("/settings/certificate/agent-sync"),
  );
  await page
    .getByRole("button", { name: "同步 CA 到已有 Agent / 重试", exact: true })
    .click();
  assert.equal((await response).status(), 200);
  await page
    .getByTestId("ca-sync-summary")
    .filter({ hasText: "所有已有 Agent 均已就绪" })
    .waitFor();
  const sync = assertValid(
    "agent-ca-sync",
    await api("GET", "/settings/certificate/agent-sync"),
  );
  assert.equal(sync.all_ready, true);
  const saved = JSON.parse(
    await docker([
      "exec",
      container,
      "cat",
      "/var/lib/farhelm-agent/platform-trust.json",
    ]),
  );
  assert.deepEqual(saved.roots, [ca]);
  assert.equal(
    (
      await docker([
        "exec",
        container,
        "stat",
        "-c",
        "%a:%U",
        "/var/lib/farhelm-agent/platform-trust.json",
      ])
    ).trim(),
    "600:farhelm",
  );
  assert.equal(
    await docker(["exec", container, "cat", "/var/lib/farhelm-agent/ca.crt"]),
    oldCA,
  );
  assert.equal(
    await connections(),
    before,
    "CA sync does not restart the Agent",
  );
  const out = join(root, ".test-output");
  mkdirSync(out, { recursive: true });
  await page.getByTestId("ca-sync-summary").scrollIntoViewIfNeeded();
  await page.screenshot({
    path: join(out, "agent-ca-sync-ready.png"),
    fullPage: true,
  });
  await page.setViewportSize({ width: 390, height: 844 });
  assert.equal(
    await page.evaluate(
      () => document.documentElement.scrollWidth > innerWidth,
    ),
    false,
  );
  await page.screenshot({
    path: join(out, "agent-ca-sync-mobile.png"),
    fullPage: true,
  });
  await page.setViewportSize({ width: 1440, height: 1100 });
  await page.locator('[name="certificate-enabled"]').check();
  await page.getByRole("button", { name: "保存证书设置", exact: true }).click();
  await page.getByText("证书有效", { exact: true }).waitFor();
  const active = (await api("GET", "/settings/certificate")).certificate;
  assert.equal(await https(agentOrigin + "/healthz", ca), active.fingerprint);
  await assert.rejects(() => https(agentOrigin + "/healthz", oldCA));
  terminal.input("printf '__AFTER_%s__\\n' CA; exit\r");
  await until(() => terminal.ended(), "PTY exit");
  assert.equal(terminal.ended().audit_complete, true);
  assert.ok(terminal.output().includes("__AFTER_CA__"));
  assert.equal(
    await connections(),
    before,
    "certificate switch preserves the existing control connection",
  );
  const recording = await api(
    "GET",
    `/terminal-sessions/${terminal.id}/recording`,
  );
  assert.equal(recording.session.audit_complete, 1);
  const output = recording.events
    .filter((e) => e.kind === "output")
    .map((e) => Buffer.from(e.data.data, "base64").toString())
    .join("");
  assert.ok(
    output.includes("__BEFORE_CA__") && output.includes("__AFTER_CA__"),
  );
  terminal.ws.close();
  terminal = undefined;
  console.log(
    "PASS: browser one-click CA sync, private 0600 persistence, live certificate cutover preserves PTY and recording",
  );
  server.testHooks.disconnectDevice(device.id);
  await until(
    async () => (await connections()) > before,
    "fresh TLS reconnect",
  );
  terminal = await open();
  terminal.input("printf '__RECONNECTED_%s__\\n' CA; exit\r");
  await until(() => terminal.ended(), "fresh TLS PTY");
  assert.ok(terminal.output().includes("__RECONNECTED_CA__"));
  terminal.ws.close();
  terminal = undefined;
  await docker(["exec", container, "pkill", "-TERM", "-u", "farhelm"]);
  await until(
    async () => !(await api("GET", "/devices")).devices[0].control_online,
    "Agent stopped",
  );
  await docker([
    "exec",
    "-d",
    container,
    "/usr/local/libexec/farhelm-agent-background",
  ]);
  await until(
    async () => (await api("GET", "/devices")).devices[0].control_online,
    "Agent restarted with persisted CA",
  );
  assert.equal(
    (await api("GET", "/settings/certificate/agent-sync")).all_ready,
    true,
  );
  assert.equal((await api("GET", "/devices")).devices[0].id, device.id);
  await server.close();
  server = await buildServer(config);
  await server.app.listen({ host: "127.0.0.1", port });
  assert.equal(await https(agentOrigin + "/healthz", ca), active.fingerprint);
  await until(
    async () => (await api("GET", "/devices")).devices[0].control_online,
    "server restart",
  );
  assert.equal(
    (await api("GET", "/settings/certificate/agent-sync")).all_ready,
    true,
  );
  assert.deepEqual(errors, []);
  writeFileSync(
    join(out, "agent-ca-sync.json"),
    JSON.stringify(
      {
        passed: true,
        legacy_upgrade: true,
        browser_sync: true,
        activation_guard: true,
        old_ca_preserved: true,
        pty_preserved: true,
        recording_complete: true,
        new_tls_reconnect: true,
        agent_restart_persistence: true,
        server_restart_persistence: true,
        mobile_no_overflow: true,
      },
      null,
      2,
    ),
  );
  console.log(
    "PASS: new CA TLS reconnect, Agent process restart and server restart preserve trust and device identity",
  );
} catch (e) {
  console.error(e);
  console.error(
    (
      await docker([
        "exec",
        container,
        "tail",
        "-30",
        "/var/log/farhelm-agent.log",
      ]).catch(() => "")
    ).slice(-3000),
  );
  process.exitCode = 1;
} finally {
  terminal?.ws.terminate();
  await browser?.close();
  await docker(["rm", "-f", container]).catch(() => {});
  await server?.close();
}
