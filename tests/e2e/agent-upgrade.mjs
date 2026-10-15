import assert from "node:assert/strict";
import { chromium } from "@playwright/test";
import { spawn, execFileSync } from "node:child_process";
import {
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  readFileSync,
  copyFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { createHash } from "node:crypto";
import { createServer } from "node:net";
import { buildServer } from "../../apps/server/dist/server.js";
import { assertValid } from "../contracts/validate.mjs";
const root = resolve(import.meta.dirname, "../.."),
  temp = mkdtempSync(join(tmpdir(), "farhelm-upgrade-")),
  out = join(root, ".test-output"),
  dist = join(temp, "dist"),
  tls = join(temp, "tls");
mkdirSync(dist);
mkdirSync(out, { recursive: true });
execFileSync("bash", [join(root, "deploy/dev/generate-tls.sh"), tls], {
  stdio: "ignore",
});
const baseline =
    process.env.FLEET_AGENT_BASELINE_DIST_DIR ?? join(out, "upgrade-baseline"),
  target = process.env.FLEET_AGENT_DIST_DIR ?? join(root, ".dev/agent-dist");
function publish(from) {
  for (const arch of ["aarch64", "x86_64"])
    for (const ext of ["", ".json"])
      copyFileSync(
        join(from, `farhelm-agent-linux-${arch}${ext}`),
        join(dist, `farhelm-agent-linux-${arch}${ext}`),
      );
}
publish(baseline);
const containers = [],
  errors = [],
  steps = [];
let server, vite, browser;
async function run(command, args) {
  return new Promise((resolve, reject) => {
    const c = spawn(command, args, { stdio: ["ignore", "pipe", "pipe"] });
    let output = "";
    c.stdout.on("data", (d) => (output += d));
    c.stderr.on("data", (d) => (output += d));
    c.on("error", reject);
    c.on("exit", (code) => resolve({ code, output }));
  });
}
async function docker(args) {
  const r = await run("docker", args);
  assert.equal(r.code, 0, r.output);
  return r.output;
}
async function until(fn, label, ms = 45000) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (await fn()) return;
    await new Promise((r) => setTimeout(r, 200));
  }
  throw Error("Timed out: " + label);
}
async function port() {
  const s = createServer();
  await new Promise((r) => s.listen(0, "127.0.0.1", r));
  const p = s.address().port;
  await new Promise((r) => s.close(r));
  return p;
}
try {
  const apiPort = await port(),
    webPort = await port(),
    origin = `http://127.0.0.1:${webPort}`,
    password = "isolated-upgrade-test-password";
  server = await buildServer({
    dataDir: join(temp, "server"),
    tlsCert: join(tls, "server.crt"),
    tlsKey: join(tls, "server.key"),
    adminUsername: "admin",
    adminPassword: password,
    consoleOrigin: origin,
    agentInstall: {
      distDir: dist,
      publicUrl: `https://host.docker.internal:${apiPort}`,
      caCert: join(tls, "ca.crt"),
    },
  });
  await server.app.listen({ host: "127.0.0.1", port: apiPort });
  const login = (
    await server.app.inject({
      method: "POST",
      url: "/api/v1/login",
      payload: { username: "admin", password },
    })
  ).json();
  async function api(method, path, payload) {
    const r = await server.app.inject({
      method,
      url: "/api/v1" + path,
      payload,
      headers: { authorization: "Bearer " + login.access_token },
    });
    assert.equal(r.statusCode, 200, r.body);
    return r.json();
  }
  const snapshot = async () =>
    assertValid("agent-upgrades-response", await api("GET", "/agent-upgrades"));
  for (const [i, arch] of ["arm64", "amd64"].entries()) {
    const name = `farhelm-upgrade-e2e-${process.pid}-${arch}`;
    containers.push(name);
    await docker([
      "run",
      "--rm",
      "--init",
      "-d",
      "--platform",
      "linux/" + arch,
      "--name",
      name,
      "--mount",
      `type=bind,source=${temp},target=/fixture,readonly`,
      "farhelm-agent-build:" + arch,
      "sleep",
      "infinity",
    ]);
    const install = await api("POST", "/agent-installations", {
      v: 1,
      name: i === 0 ? "升级 ARM64" : "升级 x86_64",
      run_user: "farhelm",
      start_mode: "background",
      allow_sudo: false,
    });
    writeFileSync(join(temp, `install-${arch}.sh`), install.command, {
      mode: 0o600,
    });
    const installed = await docker([
      "exec",
      name,
      "bash",
      `/fixture/install-${arch}.sh`,
    ]);
    assert.ok(installed.includes("设备已注册并在线"));
  }
  await until(
    async () =>
      (await snapshot()).devices.length === 2 &&
      (await snapshot()).devices.every((d) => d.supported),
    "capable baseline Agents",
  );
  const initial = await snapshot(),
    arm = initial.devices.find((d) => d.arch === "aarch64"),
    amd = initial.devices.find((d) => d.arch === "x86_64");
  const fingerprints = [];
  for (const name of containers)
    fingerprints.push(
      await docker([
        "exec",
        name,
        "sha256sum",
        "/usr/local/bin/farhelm-agent",
        "/var/lib/farhelm-agent/identity.key",
        "/etc/farhelm-agent/agent.env",
      ]),
    );
  // Keep the AMD64 machine offline at submission; its cached capability permits queueing.
  await docker(["exec", containers[1], "pkill", "-TERM", "-u", "farhelm"]);
  await until(
    async () =>
      !(await snapshot()).devices.find((d) => d.device_id === amd.device_id)
        .online,
    "offline Agent",
  );
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
  browser = await chromium.launch({
    headless: true,
    ...(process.env.FLEET_CHROMIUM_BIN
      ? { executablePath: process.env.FLEET_CHROMIUM_BIN }
      : {}),
  });
  async function page() {
    const p = await browser.newPage({
      viewport: { width: 1440, height: 1000 },
    });
    p.on("pageerror", (e) => errors.push(String(e)));
    await p.goto(origin);
    await p.getByLabel("账号", { exact: true }).fill("admin");
    await p.getByLabel("密码", { exact: true }).fill(password);
    await p.getByRole("button", { name: "登录 →", exact: true }).click();
    await p.getByRole("heading", { name: "设备总览", exact: true }).waitFor();
    return p;
  }
  const terminalPage = await page();
  await terminalPage
    .locator("tbody tr")
    .filter({ hasText: "升级 ARM64" })
    .getByRole("button", { name: "连接终端", exact: true })
    .click();
  const terminal = terminalPage.getByRole("dialog");
  await terminal.getByText("已连接", { exact: true }).waitFor();
  const upgradePage = await page();
  await upgradePage
    .getByRole("button", { name: "Agent 升级", exact: false })
    .click();
  await upgradePage
    .getByRole("heading", { name: "批量升级 Agent", exact: true })
    .waitFor();
  async function uploadFromBrowser(binaryPath) {
    const manifest = JSON.parse(readFileSync(binaryPath + ".json", "utf8"));
    const panel = upgradePage.locator(".release-panel");
    await panel
      .getByLabel("版本清单（JSON）", { exact: true })
      .setInputFiles(binaryPath + ".json");
    await panel
      .getByLabel("Agent 安装包", { exact: true })
      .setInputFiles(binaryPath);
    const [response] = await Promise.all([
      upgradePage.waitForResponse(
        (r) =>
          r.request().method() === "PUT" &&
          r.url().endsWith("/agent-releases/" + manifest.sha256),
      ),
      panel.getByRole("button", { name: "上传安装包", exact: true }).click(),
    ]);
    assert.equal(response.status(), 200); // Chromium may evict bodies for large upload requests; verify persisted data and UI below.
    await until(
      async () =>
        (await api("GET", "/agent-releases")).releases.some(
          (r) => r.sha256 === manifest.sha256,
        ),
      "uploaded release catalog",
    );
    await until(
      async () =>
        (await panel.getByRole("status").textContent())?.includes(
          manifest.version + " · " + manifest.arch + " 已保存",
        ),
      "upload UI confirmation",
    );
    return manifest;
  }
  const armTarget = await uploadFromBrowser(
    join(target, "farhelm-agent-linux-aarch64"),
  );
  const amdTarget = await uploadFromBrowser(
    join(target, "farhelm-agent-linux-x86_64"),
  );
  assert.equal(armTarget.version, amdTarget.version);
  assert.notEqual(armTarget.sha256, arm.sha256);
  const catalog = assertValid(
    "agent-releases-response",
    await api("GET", "/agent-releases"),
  );
  assert.equal(catalog.releases.length, 4);
  assert.ok(
    catalog.releases
      .filter((r) => r.version === armTarget.version)
      .every((r) => r.source === "upload"),
  );
  await upgradePage
    .getByLabel("目标版本", { exact: true })
    .selectOption(armTarget.version);
  await upgradePage
    .getByLabel("全选当前筛选的可升级设备", { exact: true })
    .check();
  await upgradePage
    .getByRole("button", { name: "升级所选设备", exact: true })
    .click();
  await until(async () => {
    const s = await snapshot();
    return (
      s.jobs.find((j) => j.device_id === arm.device_id)?.status ===
        "WAITING_IDLE" &&
      s.jobs.find((j) => j.device_id === amd.device_id)?.status === "QUEUED"
    );
  }, "idle drain and offline queue");
  // Disabling a package after queuing must not break the offline device's pinned job.
  await upgradePage
    .getByRole("button", {
      name: `停用 ${amdTarget.version} x86_64`,
      exact: true,
    })
    .click();
  await until(
    async () =>
      (await api("GET", "/agent-releases")).releases.find(
        (r) => r.sha256 === amdTarget.sha256,
      )?.enabled === false,
    "disabled package",
  );
  const blocked = await server.app.inject({
    method: "POST",
    url: "/api/v1/terminal-sessions",
    payload: { v: 1, device_id: arm.device_id, cols: 80, rows: 24 },
    headers: { authorization: "Bearer " + login.access_token },
  });
  assert.equal(blocked.statusCode, 409);
  assert.equal(blocked.json().error, "AGENT_UPGRADE_IN_PROGRESS");
  const blockedExec = await server.app.inject({
    method: "POST",
    url: "/api/v1/commands",
    payload: {
      v: 1,
      device_id: arm.device_id,
      argv: ["/usr/bin/true"],
      cwd: "/",
      timeout_ms: 1000,
      max_output_bytes: 100,
      ttl_seconds: 60,
    },
    headers: {
      authorization: "Bearer " + login.access_token,
      "idempotency-key": "upgrade-guard",
    },
  });
  assert.equal(blockedExec.statusCode, 409);
  assert.equal(blockedExec.json().error, "AGENT_UPGRADE_IN_PROGRESS");
  await upgradePage
    .getByRole("button", { name: "刷新升级状态", exact: true })
    .click();
  await upgradePage.screenshot({
    path: join(out, "agent-upgrade-waiting.png"),
    fullPage: true,
  });
  await terminal.locator(".xterm-helper-textarea").focus();
  await terminalPage.keyboard.type("printf '__UPGRADE_%s__\\n' ALIVE; exit\r");
  await terminal.getByText("会话已结束", { exact: true }).waitFor();
  await docker([
    "exec",
    "-d",
    containers[1],
    "/usr/local/libexec/farhelm-agent-background",
  ]);
  await until(
    async () => {
      const s = await snapshot();
      return (
        s.jobs.length === 2 &&
        s.jobs.every((j) => j.status === "SUCCEEDED") &&
        s.devices.every(
          (d) =>
            d.online &&
            [armTarget, amdTarget].some(
              (r) =>
                r.arch === d.arch &&
                r.sha256 === d.sha256 &&
                r.version === d.version,
            ),
        )
      );
    },
    "ARM64 and AMD64 upgraded",
    90000,
  );
  await upgradePage
    .getByRole("button", {
      name: `启用 ${amdTarget.version} x86_64`,
      exact: true,
    })
    .click();
  await until(
    async () =>
      (await api("GET", "/agent-releases")).releases.find(
        (r) => r.sha256 === amdTarget.sha256,
      )?.enabled === true,
    "enabled package",
  );
  const sessions = (await api("GET", "/terminal-sessions")).sessions;
  assert.equal(sessions.length, 1);
  assert.equal(sessions[0].status, "CLOSED");
  const recording = await api(
    "GET",
    `/terminal-sessions/${sessions[0].id}/recording`,
  );
  assert.ok(
    recording.events
      .filter((e) => e.kind === "output")
      .map((e) => Buffer.from(e.data.data, "base64").toString())
      .join("")
      .includes("__UPGRADE_ALIVE__"),
  );
  for (const [i, name] of containers.entries()) {
    assert.equal(
      await docker([
        "exec",
        name,
        "sha256sum",
        "/usr/local/bin/farhelm-agent",
        "/var/lib/farhelm-agent/identity.key",
        "/etc/farhelm-agent/agent.env",
      ]),
      fingerprints[i],
    );
    const processes = await docker(["exec", name, "ps", "-eo", "uid,args"]);
    const workers = processes
      .split("\n")
      .filter(
        (line) =>
          line.includes("/var/lib/farhelm-agent/releases/") &&
          line.includes("--worker"),
      );
    assert.equal(workers.length, 1);
    assert.notEqual(workers[0].trim().split(/\s+/)[0], "0");
  }
  steps.push(
    "Real ARM64 and AMD64 Agents upgraded from a distinct baseline via one frontend batch; offline Agent queued; active PTY drained and recording preserved; new sessions/commands blocked; UID, identity, config and base binary preserved",
  );
  await docker(["exec", containers[0], "pkill", "-TERM", "-u", "farhelm"]);
  await until(
    async () =>
      !(await snapshot()).devices.find((d) => d.device_id === arm.device_id)
        .online,
    "upgraded worker stopped",
  );
  await docker([
    "exec",
    "-d",
    containers[0],
    "/usr/local/libexec/farhelm-agent-background",
  ]);
  await until(async () => {
    const s = await snapshot(),
      d = s.devices.find((d) => d.device_id === arm.device_id);
    return (
      d.online &&
      d.sha256 === s.releases.find((r) => r.arch === "aarch64").sha256
    );
  }, "durable release selection after restart");
  const fresh = `farhelm-upload-install-e2e-${process.pid}`;
  containers.push(fresh);
  await docker([
    "run",
    "--rm",
    "--init",
    "-d",
    "--platform",
    "linux/arm64",
    "--name",
    fresh,
    "--mount",
    `type=bind,source=${temp},target=/fixture,readonly`,
    "farhelm-agent-build:arm64",
    "sleep",
    "infinity",
  ]);
  const freshInstall = await api("POST", "/agent-installations", {
    v: 1,
    name: "上传包安装验证",
    run_user: "farhelm",
    start_mode: "background",
    allow_sudo: false,
  });
  writeFileSync(join(temp, "fresh.sh"), freshInstall.command, { mode: 0o600 });
  await docker(["exec", fresh, "bash", "/fixture/fresh.sh"]);
  await until(
    async () =>
      (await snapshot()).devices.some(
        (d) =>
          d.name === "上传包安装验证" &&
          d.sha256 === armTarget.sha256 &&
          d.online,
      ),
    "fresh install from uploaded package",
  );
  steps.push(
    "Browser uploaded both architecture packages and manifests; selected a retained version; disabling a release preserved an already queued offline upgrade; fresh installation used the uploaded package",
  );
  // A valid static ELF with matching build metadata but a worker that crashes must roll back.
  const targetVersion = JSON.parse(
    readFileSync(join(target, "farhelm-agent-linux-aarch64.json"), "utf8"),
  ).version;
  const versionParts = targetVersion.split(".").map(Number);
  const brokenVersion = `${versionParts[0]}.${versionParts[1]}.${versionParts[2] + 1}`;
  writeFileSync(
    join(temp, "broken.rs"),
    `fn main(){if std::env::args().any(|a|a=="--build-info"){println!("{{\\\"version\\\":\\\"${brokenVersion}\\\",\\\"arch\\\":\\\"aarch64\\\",\\\"upgrade_protocol\\\":1}}");}else{std::process::exit(42);}}`,
  );
  await docker([
    "exec",
    containers[0],
    "rustc",
    "--target",
    "aarch64-unknown-linux-musl",
    "/fixture/broken.rs",
    "-O",
    "-o",
    "/tmp/broken-agent",
  ]);
  await docker([
    "cp",
    containers[0] + ":/tmp/broken-agent",
    join(temp, "broken-agent"),
  ]);
  const bytes = readFileSync(join(temp, "broken-agent")),
    brokenHash = createHash("sha256").update(bytes).digest("hex");
  writeFileSync(
    join(temp, "broken-agent.json"),
    JSON.stringify({
      arch: "aarch64",
      version: brokenVersion,
      upgrade_protocol: 1,
      size: bytes.length,
      sha256: brokenHash,
    }),
  );
  await upgradePage
    .getByRole("button", { name: "刷新升级状态", exact: true })
    .click();
  await uploadFromBrowser(join(temp, "broken-agent"));
  await upgradePage
    .getByLabel("目标版本", { exact: true })
    .selectOption(brokenVersion);
  await upgradePage.getByLabel("选择 升级 ARM64", { exact: true }).check();
  await upgradePage
    .getByRole("button", { name: "升级所选设备", exact: true })
    .click();
  await until(
    async () => {
      const s = await snapshot();
      return (
        s.jobs.some(
          (j) =>
            j.sha256 === brokenHash &&
            j.status === "FAILED" &&
            j.reason === "TRIAL_FAILED",
        ) && s.devices.find((d) => d.device_id === arm.device_id).online
      );
    },
    "failed trial rolls back",
    90000,
  );
  const rolledBack = (await snapshot()).devices.find(
    (d) => d.device_id === arm.device_id,
  );
  assert.equal(
    rolledBack.sha256,
    JSON.parse(readFileSync(join(target, "farhelm-agent-linux-aarch64.json")))
      .sha256,
  );
  await upgradePage
    .getByRole("button", { name: "刷新升级状态", exact: true })
    .click();
  await upgradePage.screenshot({
    path: join(out, "agent-upgrade-desktop.png"),
    fullPage: true,
  });
  await upgradePage.setViewportSize({ width: 390, height: 844 });
  assert.ok(
    await upgradePage
      .locator(".upgrade-panel")
      .evaluate(
        (el) =>
          el.scrollWidth <= el.clientWidth + 1 &&
          document.documentElement.scrollWidth <= innerWidth,
      ),
  );
  await upgradePage.screenshot({
    path: join(out, "agent-upgrade-mobile.png"),
    fullPage: true,
  });
  assertValid("audit-response", await api("GET", "/audit"));
  assert.deepEqual(errors, []);
  steps.push(
    "Successful release survived a supervisor restart; deliberately crashing new release rolled back to the previous build and reported failure; desktop/mobile frontend and audit contracts verified",
  );
  writeFileSync(
    join(out, "agent-upgrade-e2e.json"),
    JSON.stringify(
      {
        ok: true,
        steps,
        limitation:
          "Docker background service lifecycle tested; real-host systemd boot not tested.",
      },
      null,
      2,
    ),
  );
  console.log("PASS", steps.join("\n"));
} catch (error) {
  for (const name of containers) {
    const logs = await run("docker", [
      "exec",
      name,
      "cat",
      "/var/log/farhelm-agent.log",
    ]);
    writeFileSync(join(out, name + ".log"), logs.output);
  }
  if (server)
    writeFileSync(
      join(out, "agent-upgrade-failed-jobs.json"),
      JSON.stringify(
        server.store.db.prepare("SELECT * FROM agent_upgrades").all(),
        null,
        2,
      ),
    );
  throw error;
} finally {
  await browser?.close();
  vite?.kill("SIGTERM");
  for (const name of containers) await run("docker", ["rm", "-f", name]);
  await server?.close();
}
