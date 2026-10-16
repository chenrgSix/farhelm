import assert from "node:assert/strict";
import { chromium } from "@playwright/test";
import { spawn, execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { createServer, connect } from "node:net";
import { createServer as createHttpsServer } from "node:https";
import { buildServer } from "../../apps/server/dist/server.js";
import { assertValid } from "../contracts/validate.mjs";

const root = resolve(import.meta.dirname, "../.."),
  temp = mkdtempSync(join(tmpdir(), "farhelm-network-")),
  out = join(root, ".test-output");
mkdirSync(out, { recursive: true });
const tls = join(temp, "tls"),
  container = `farhelm-network-${process.pid}`;
execFileSync("bash", [join(root, "deploy/dev/generate-tls.sh"), tls], {
  stdio: "ignore",
});
const errors = [],
  steps = [],
  peers = new Set(),
  targets = [];
let server,
  proxy,
  vite,
  browser,
  blocked = false;
async function port() {
  const s = createServer();
  await new Promise((r) => s.listen(0, "127.0.0.1", r));
  const p = s.address().port;
  await new Promise((r) => s.close(r));
  return p;
}
async function until(fn, label, ms = 60000) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (await fn()) return;
    await new Promise((r) => setTimeout(r, 200));
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
    p.on("exit", (code) =>
      code === 0 ? resolve(output) : reject(Error(output)),
    );
  });
}
try {
  const apiPort = await port(),
    publicPort = await port(),
    webPort = await port(),
    origin = `http://127.0.0.1:${webPort}`,
    password = "isolated-network-test-password1";
  proxy = createServer((client) => {
    peers.add(client);
    client.on("error", () => {});
    client.on("close", () => peers.delete(client));
    if (blocked) {
      client.on("data", () => {});
      return;
    }
    const upstream = connect(apiPort, "127.0.0.1");
    peers.add(upstream);
    upstream.on("error", () => {
      if (!blocked) client.destroy();
    });
    upstream.on("close", () => {
      peers.delete(upstream);
      if (!blocked) client.destroy();
    });
    client.on("data", (data) => {
      if (!blocked && !upstream.destroyed) upstream.write(data);
    });
    upstream.on("data", (data) => {
      if (!blocked && !client.destroyed) client.write(data);
    });
    client.on("close", () => upstream.destroy());
  });
  await new Promise((r) => proxy.listen(publicPort, "0.0.0.0", r));
  server = await buildServer({
    dataDir: join(temp, "server"),
    tlsCert: join(tls, "server.crt"),
    tlsKey: join(tls, "server.key"),
    adminUsername: "admin",
    adminPassword: password,
    consoleOrigin: origin,
    agentInstall: {
      distDir: join(root, ".dev/agent-dist"),
      publicUrl: `https://host.docker.internal:${publicPort}`,
      caCert: join(tls, "ca.crt"),
    },
  });
  await server.app.listen({ host: "127.0.0.1", port: apiPort });
  const auth = (
    await server.app.inject({
      method: "POST",
      url: "/api/v1/login",
      payload: { username: "admin", password },
    })
  ).json().access_token;
  async function api(method, path, payload) {
    const r = await server.app.inject({
      method,
      url: "/api/v1" + path,
      payload,
      headers: { authorization: "Bearer " + auth },
    });
    assert.equal(r.statusCode, 200, r.body);
    return r.json();
  }
  await docker([
    "run",
    "--rm",
    "--init",
    "-d",
    "--platform",
    "linux/arm64",
    "--name",
    container,
    "--mount",
    `type=bind,source=${temp},target=/fixture,readonly`,
    "farhelm-agent-build:arm64",
    "sleep",
    "infinity",
  ]);
  const install = await api("POST", "/agent-installations", {
    v: 1,
    name: "网络验证 Linux",
    run_user: "farhelm",
    start_mode: "background",
    allow_sudo: false,
  });
  writeFileSync(join(temp, "install.sh"), install.command, { mode: 0o600 });
  await docker(["exec", container, "bash", "/fixture/install.sh"]);
  const id = (await api("GET", "/devices")).devices[0].id;
  const snapshot = async () =>
    assertValid(
      "device-network-response",
      await api("GET", `/devices/${id}/network`),
    );
  await until(
    async () => (await snapshot()).snapshot?.addresses.length > 0,
    "real local IP report",
  );
  const initial = await snapshot();
  assert.equal(initial.events.length, 0);
  const actual = (await docker(["exec", container, "hostname", "-I"]))
    .trim()
    .split(/\s+/);
  assert.ok(initial.snapshot.addresses.some((a) => actual.includes(a.address)));
  steps.push("real Linux interface IP agrees with container hostname -I");
  vite = spawn(
    process.execPath,
    [
      join(root, "apps/web/node_modules/vite/bin/vite.js"),
      "--host",
      "127.0.0.1",
      "--port",
      String(webPort),
      "--strictPort",
    ],
    {
      cwd: join(root, "apps/web"),
      env: {
        ...process.env,
        NODE_EXTRA_CA_CERTS: join(tls, "ca.crt"),
        FLEET_DEV_API_TARGET: `https://localhost:${apiPort}`,
      },
      stdio: "ignore",
    },
  );
  await until(async () => {
    try {
      return (await fetch(origin)).ok;
    } catch {
      return false;
    }
  }, "Vite");
  browser = await chromium.launch({ headless: true });
  const page = await browser.newPage({
    viewport: { width: 1440, height: 1000 },
  });
  page.on("pageerror", (e) => errors.push(String(e)));
  await page.goto(origin);
  await page.getByLabel("账号", { exact: true }).fill("admin");
  await page.getByLabel("密码", { exact: true }).fill(password);
  await page.getByRole("button", { name: "登录 →", exact: true }).click();
  await page.getByRole("button", { name: /^更多操作：/ }).click();
  await page.getByRole("menuitem", { name: "网络记录", exact: true }).click();
  const dialog = page.getByRole("dialog");
  for (let i = 0; i < 2; i++) {
    const target =
      i === 0
        ? createServer((socket) => socket.destroy())
        : createHttpsServer(
            {
              key: readFileSync(join(tls, "server.key")),
              cert: readFileSync(join(tls, "server.crt")),
            },
            (_req, res) => {
              res.writeHead(503);
              res.end();
            },
          );
    await new Promise((r) => target.listen(0, "127.0.0.1", r));
    targets.push({
      server: target,
      port: target.address().port,
      scheme: i === 0 ? "tcp" : "https",
    });
  }
  const probes = async () =>
    assertValid(
      "network-probes-response",
      await api("GET", `/devices/${id}/network-probes`),
    );
  const probePanel = dialog.getByRole("region", {
    name: "网络连通性探测",
    exact: true,
  });
  await probePanel.getByLabel("启用网络探测", { exact: true }).check();
  for (let i = 0; i < 2; i++) {
    await probePanel
      .getByRole("button", { name: "添加探测地址", exact: true })
      .click();
    await probePanel
      .getByLabel(`探测地址 ${i + 1}`, { exact: true })
      .fill(`${targets[i].scheme}://host.docker.internal:${targets[i].port}`);
  }
  await probePanel.getByLabel("探测间隔（秒）", { exact: true }).fill("5");
  await probePanel.getByLabel("单次超时（毫秒）", { exact: true }).fill("500");
  await probePanel.getByLabel("连续失败次数", { exact: true }).fill("2");
  await probePanel
    .getByRole("button", { name: "保存探测配置", exact: true })
    .click();
  await until(async () => {
    const s = await probes();
    return (
      s.applied_revision === 1 &&
      s.result_fresh &&
      s.result?.status === "healthy"
    );
  }, "frontend configuration applied and independent probes healthy");
  const localProbe = async () =>
    JSON.parse(
      await docker([
        "exec",
        container,
        "python3",
        "-c",
        "import sqlite3; c=sqlite3.connect('/var/lib/farhelm-agent/journal.sqlite3'); print(c.execute(\"SELECT value FROM metadata WHERE key='network_probe_latest'\").fetchone()[0])",
      ]),
    );
  steps.push(
    "frontend configured independent TCP and HTTPS targets (503 counts as reachable), interval, timeout and failure threshold; Agent persisted and acknowledged configuration",
  );
  // Blackhole both directions without sending FIN/RST. The Agent must notice missing Pongs.
  const cut = Date.now();
  blocked = true;
  const local = async () =>
    JSON.parse(
      await docker([
        "exec",
        container,
        "python3",
        "-c",
        "import sqlite3,json; c=sqlite3.connect('/var/lib/farhelm-agent/journal.sqlite3'); print(c.execute(\"SELECT value FROM metadata WHERE key='network_state'\").fetchone()[0])",
      ]),
    );
  await until(
    async () => !!(await local()).pending,
    "local durable outage despite silent packet loss",
    30000,
  );
  const pending = (await local()).pending;
  assert.equal(pending.reason, "connection_lost");
  assert.ok(pending.detected_at >= cut);
  assert.ok(pending.detected_at <= cut + 25000);
  assert.equal((await snapshot()).events.length, 0);
  assert.equal((await snapshot()).device_online, false);
  steps.push(
    "silent loss detected locally within 25 seconds; platform offline before buffered report arrives",
  );
  await until(
    async () => (await localProbe()).status === "platform_unreachable",
    "only platform unavailable while targets remain reachable",
  );
  assert.equal((await probes()).result_fresh, false);
  await new Promise((r) => targets[0].server.close(r));
  await until(
    async () => (await localProbe()).status === "partial_unreachable",
    "partial target failure while platform offline",
  );
  await new Promise((r) => targets[1].server.close(r));
  await until(
    async () => (await localProbe()).status === "suspected_offline",
    "all targets failed after configured threshold",
  );
  assert.ok((await localProbe()).consecutive_failures >= 2);
  const offlineSeq = (await localProbe()).seq;
  const beforeUpdate = await probes();
  const pendingConfig = await api("PUT", `/devices/${id}/network-probes`, {
    v: 1,
    config: { ...beforeUpdate.config, interval_secs: 7 },
  });
  assert.equal(pendingConfig.config.revision, 2);
  assert.equal(pendingConfig.applied_revision, 1);
  steps.push(
    "independent probes distinguish platform-only, partial and all-target failure during a silent outage; offline config waits for reconnection",
  );
  // Restart while disconnected. The original detection must survive; no new outage duplicates.
  await docker(["exec", container, "pkill", "-TERM", "-u", "farhelm"]);
  await docker([
    "exec",
    "-d",
    container,
    "/usr/local/libexec/farhelm-agent-background",
  ]);
  await until(
    async () => (await local()).pending?.event_id === pending.event_id,
    "outage persisted across restart",
  );
  await until(async () => {
    const p = await localProbe();
    return (
      p.seq > offlineSeq && p.revision === 1 && p.status === "suspected_offline"
    );
  }, "saved probes keep running after an offline process restart");
  const restoredAt = Date.now();
  blocked = false;
  for (const peer of peers) peer.destroy();
  await until(
    async () => (await snapshot()).events.length === 1,
    "offline event replay",
  );
  const recovered = (await snapshot()).events[0];
  assert.equal(recovered.event_id, pending.event_id);
  assert.equal(recovered.detected_at, pending.detected_at);
  assert.ok(recovered.recovered_at >= restoredAt);
  assert.ok(recovered.recovered_at > recovered.detected_at);
  await until(
    async () =>
      (
        await docker([
          "exec",
          container,
          "python3",
          "-c",
          "import sqlite3; c=sqlite3.connect('/var/lib/farhelm-agent/journal.sqlite3'); print(c.execute('SELECT COUNT(*) FROM network_events WHERE acked=0').fetchone()[0])",
        ])
      ).trim() === "0",
    "durable server ACK",
  );
  steps.push(
    "restart while offline retains original detection; recovery replays exactly once and ACKs durably",
  );
  await until(async () => {
    const p = await probes();
    return (
      p.applied_revision === 2 &&
      p.result_fresh &&
      p.result?.status === "targets_unreachable"
    );
  }, "platform recovered while targets remain down");
  for (const target of targets)
    await new Promise((r) => target.server.listen(target.port, "127.0.0.1", r));
  await until(async () => {
    const p = await probes();
    return p.result_fresh && p.result?.status === "healthy";
  }, "all connectivity restored");
  await until(async () => {
    const states = (await probes()).events.map((e) => e.status);
    return [
      "platform_unreachable",
      "partial_unreachable",
      "suspected_offline",
      "targets_unreachable",
      "healthy",
    ].every((x) => states.includes(x));
  }, "offline classification evidence replayed");
  steps.push(
    "offline restart retains probes; reconnect applies queued config; old-revision evidence replays and restored platform is never misclassified as whole-device offline",
  );
  // Restart while previously connected is explicitly labelled as an unknown process gap.
  await docker(["exec", container, "pkill", "-TERM", "-u", "farhelm"]);
  await docker([
    "exec",
    "-d",
    container,
    "/usr/local/libexec/farhelm-agent-background",
  ]);
  await until(
    async () => (await snapshot()).events.length === 2,
    "process interruption event",
  );
  assert.equal((await snapshot()).events[0].reason, "agent_restart");
  // A repeated report after an ACK was lost must not append a second event.
  await docker([
    "exec",
    container,
    "python3",
    "-c",
    "import sqlite3; c=sqlite3.connect('/var/lib/farhelm-agent/journal.sqlite3'); c.execute('UPDATE network_events SET acked=0'); c.commit()",
  ]);
  await until(
    async () =>
      (
        await docker([
          "exec",
          container,
          "python3",
          "-c",
          "import sqlite3; c=sqlite3.connect('/var/lib/farhelm-agent/journal.sqlite3'); print(c.execute('SELECT COUNT(*) FROM network_events WHERE acked=0').fetchone()[0])",
        ])
      ).trim() === "0",
    "duplicate replay acknowledgement",
  );
  assert.equal((await snapshot()).events.length, 2);
  steps.push(
    "process restart distinguished from outage; lost-ACK replay creates no duplicate",
  );
  const settings = await api("GET", "/settings");
  const updated = await api("PUT", "/settings", {
    v: 1,
    revision: settings.revision,
    platform_server_url: `https://host.docker.internal:${apiPort}`,
  });
  await until(
    async () =>
      (await api("GET", "/settings/agent-sync")).devices.some(
        (d) =>
          d.device_id === id &&
          d.revision === updated.revision &&
          d.status === "applied",
      ),
    "planned address switch",
  );
  assert.equal((await snapshot()).events.length, 2);
  steps.push(
    "planned platform address change completes without a false outage",
  );
  await dialog.getByText("与平台断连", { exact: true }).waitFor();
  await dialog.getByText("Agent 进程中断", { exact: true }).waitFor();
  assert.ok(
    (await dialog.textContent()).includes(
      initial.snapshot.addresses[0].address,
    ),
  );
  await page.screenshot({
    path: join(out, "agent-network-desktop.png"),
    fullPage: true,
  });
  await page.setViewportSize({ width: 390, height: 844 });
  await page.screenshot({
    path: join(out, "agent-network-mobile.png"),
    fullPage: true,
  });
  assert.equal(
    await page.evaluate(
      () => document.documentElement.scrollWidth > innerWidth,
    ),
    false,
  );
  await probePanel.locator(".probe-config > summary").click();
  await probePanel
    .getByLabel("探测间隔（秒）", { exact: true })
    .scrollIntoViewIfNeeded();
  assert.equal(
    await probePanel.getByLabel("探测间隔（秒）", { exact: true }).inputValue(),
    "7",
  );
  await page.screenshot({
    path: join(out, "network-probes-config-mobile.png"),
    fullPage: true,
  });
  await page.setViewportSize({ width: 1440, height: 1000 });
  await probePanel.locator(".probe-config").scrollIntoViewIfNeeded();
  await page.screenshot({
    path: join(out, "network-probes-config-desktop.png"),
    fullPage: true,
  });
  assert.deepEqual(errors, []);
  steps.push(
    "desktop/mobile browser displays real IP and both recorded event types without page overflow",
  );
  const result = {
    ok: true,
    steps,
    events: (await snapshot()).events,
    probe_events: (await probes()).events,
    errors,
  };
  const audit = await api("GET", "/audit");
  assertValid("audit-response", audit);
  writeFileSync(
    join(out, "agent-network-e2e.json"),
    JSON.stringify(result, null, 2),
  );
  console.log(JSON.stringify(result));
} finally {
  await browser?.close();
  vite?.kill("SIGTERM");
  await docker(["rm", "-f", container]).catch(() => {});
  for (const peer of peers) peer.destroy();
  for (const target of targets)
    if (target.server.listening)
      await new Promise((r) => target.server.close(r));
  if (proxy) await new Promise((r) => proxy.close(r));
  await server?.close();
}
