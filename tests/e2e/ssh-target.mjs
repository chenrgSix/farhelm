import assert from "node:assert/strict";
import { startFrontendEntry } from "./platform-entry.mjs";
import { installOnSshDevice } from "./ssh-agent-install.mjs";
import { chromium } from "@playwright/test";
import { spawn, execFileSync } from "node:child_process";
import { once } from "node:events";
import { createServer } from "node:net";
import { mkdtempSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { buildServer } from "../../apps/server/dist/server.js";
import { assertValid } from "../contracts/validate.mjs";

const frontendMode = process.env.FLEET_TEST_FRONTEND_PROXY;
const backupMode = process.env.FLEET_TEST_BACKUP_SSH === "1";
const installMode = process.env.FLEET_TEST_SSH_AGENT_INSTALL === "1";
const evidencePrefix = frontendMode
  ? `platform-entry-${frontendMode}`
  : installMode
    ? "ssh-agent-install"
    : backupMode
      ? "agent-ssh-backup"
      : "dual-access";
const deviceName = backupMode
  ? "Linux with Agent backup"
  : "Linux without Agent";
const root = resolve(import.meta.dirname, "../..");
const temp = mkdtempSync(join(tmpdir(), "farhelm-ssh-target-e2e-"));
const out = join(root, ".test-output");
mkdirSync(out, { recursive: true });
const container = `farhelm-sshd-e2e-${process.pid}`;
const image = process.env.FLEET_SSH_TARGET_IMAGE || "farhelm-sshd-test:local";
const password = "isolated-ssh-target-e2e-password";
const tls = join(temp, "tls");
execFileSync("bash", [join(root, "deploy/dev/generate-tls.sh"), tls], {
  stdio: "ignore",
});
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
  `Port 22\nHostKey /fixture/host\nAuthorizedKeysFile /etc/ssh/authorized_keys\nStrictModes no\nPasswordAuthentication no\nKbdInteractiveAuthentication no\nPermitEmptyPasswords no\nPermitRootLogin no\nAllowUsers terminal\nUsePAM no\nSetEnv LANG=C.UTF-8 LC_ALL=C.UTF-8\nPrintMotd no\nAllowTcpForwarding no\nX11Forwarding no\nPermitUserEnvironment no\n`,
);
const privateKey = readFileSync(join(temp, "identity"), "utf8");
const trustedFingerprint = execFileSync(
  "ssh-keygen",
  ["-lf", join(temp, "host.pub"), "-E", "sha256"],
  { encoding: "utf8" },
).split(/\s+/)[1];
const probe = createServer();
await new Promise((r) => probe.listen(0, "127.0.0.1", r));
const webPort = probe.address().port;
await new Promise((r) => probe.close(r));
const origin = `http://127.0.0.1:${webPort}`;
let server, browser, vite, cli, frontend;
const steps = [];
async function until(fn, label, ms = 15000) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (await fn()) return;
    await new Promise((r) => setTimeout(r, 50));
  }
  throw Error("Timed out: " + label);
}
try {
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
      image,
    ],
    { stdio: "pipe" },
  );
  const targetPort = Number(
    execFileSync("docker", ["port", container, "22/tcp"], { encoding: "utf8" })
      .trim()
      .split(":")
      .at(-1),
  );
  assert.ok(targetPort);
  const apiProbe = createServer();
  await new Promise((r) => apiProbe.listen(0, "127.0.0.1", r));
  const apiPort = apiProbe.address().port;
  await new Promise((r) => apiProbe.close(r));
  server = await buildServer({
    dataDir: join(temp, "server"),
    tlsCert: join(tls, "server.crt"),
    tlsKey: join(tls, "server.key"),
    adminUsername: "admin",
    adminPassword: password,
    consoleOrigin: origin,
    ssh: { host: "127.0.0.1", port: 0 },
    ...(installMode
      ? {
          agentInstall: {
            distDir:
              process.env.FLEET_AGENT_DIST_DIR ?? join(root, ".dev/agent-dist"),
            publicUrl: `https://host.docker.internal:${apiPort}`,
            caCert: join(tls, "ca.crt"),
          },
        }
      : {}),
  });
  await server.app.listen({ host: "127.0.0.1", port: apiPort });
  const port = server.app.server.address().port;
  if (frontendMode)
    frontend = await startFrontendEntry({
      mode: frontendMode,
      root,
      temp,
      tls,
      apiPort: port,
    });
  if (backupMode)
    server.store.db
      .prepare(
        "INSERT INTO devices(id,public_key,name,created_at) VALUES('existing-agent','existing-agent-key',?,?)",
      )
      .run(deviceName, Date.now());
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
        FLEET_DEV_API_TARGET: `https://localhost:${port}`,
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
  }, "Vite ready");
  browser = await chromium.launch({
    headless: true,
    ...(process.env.FLEET_CHROMIUM_BIN
      ? { executablePath: process.env.FLEET_CHROMIUM_BIN }
      : {}),
  });
  const page = await browser.newPage({
    viewport: { width: 1440, height: 1050 },
  });
  const errors = [];
  page.on("pageerror", (e) => errors.push(e.message));
  await page.goto(origin);
  await page.getByLabel("账号", { exact: true }).fill("admin");
  await page.getByLabel("密码", { exact: true }).fill(password);
  const loginResponse = page.waitForResponse((r) =>
    r.url().endsWith("/api/v1/login"),
  );
  await page.getByRole("button", { name: "登录 →", exact: true }).click();
  const token = (await (await loginResponse).json()).access_token;
  const api = async (path) => {
    const r = await page.request.get(origin + "/api/v1" + path, {
      headers: { authorization: "Bearer " + token },
    });
    assert.equal(r.status(), 200);
    return r.json();
  };
  if (frontend) {
    await page.getByRole("button", { name: "系统设置", exact: false }).click();
    const form = page.locator(".settings-panel");
    assert.ok(
      await form
        .getByRole("button", { name: "使用当前网页地址并同步", exact: true })
        .isDisabled(),
    );
    await form
      .getByLabel("平台访问地址", { exact: true })
      .fill(frontend.origin + "/devices?filter=online#row");
    await form.getByText("将使用：", { exact: false }).waitFor();
    await form.getByRole("button", { name: "保存设置", exact: true }).click();
    await form.getByRole("status").waitFor();
    assert.equal((await api("/settings")).platform_server_url, frontend.origin);
    await page.screenshot({
      path: join(out, `${evidencePrefix}-settings.png`),
    });
    await page.getByRole("button", { name: "设备总览", exact: false }).click();
    steps.push(
      `${frontendMode}: HTTPS frontend serves the console, forwards authenticated API and Agent paths with TLS verification; pasted browser page URL saves only its origin`,
    );
  }
  if (backupMode) {
    await page
      .locator("tbody tr")
      .filter({ hasText: deviceName })
      .getByRole("button", { name: "接入配置", exact: true })
      .click();
    await page.getByLabel("启用备用 SSH", { exact: true }).check();
  } else {
    await page
      .getByRole("button", { name: "＋ 添加设备", exact: true })
      .click();
    await page.getByRole("button", { name: "SSH 接入", exact: true }).click();
  }
  const config = page.getByRole("dialog");
  if (!backupMode)
    await config.getByLabel("设备名称", { exact: true }).fill(deviceName);
  await config.getByLabel("SSH 地址", { exact: true }).fill("127.0.0.1");
  await config.getByLabel("SSH 端口", { exact: true }).fill(String(targetPort));
  await config.getByLabel("SSH 账号", { exact: true }).fill("terminal");
  await config.getByLabel("SSH 私钥", { exact: true }).fill(privateKey);
  await config
    .getByRole("button", { name: "获取主机指纹", exact: true })
    .click();
  await until(
    async () =>
      (await config.getByLabel("主机指纹", { exact: true }).inputValue()) ===
      trustedFingerprint,
    "actual SSH host fingerprint",
  );
  await config.getByLabel("已核对目标主机指纹", { exact: true }).check();
  await config.getByRole("button", { name: "保存配置", exact: true }).click();
  await config
    .getByText(
      backupMode
        ? "备用 SSH 已保存，连接时优先使用 Agent，不可用时尝试 SSH。"
        : "配置已保存，可测试连接或关闭面板进入终端。",
      { exact: true },
    )
    .waitFor();
  assert.equal(await config.locator("textarea").inputValue(), "");
  await config
    .getByRole("button", { name: "测试已保存连接", exact: true })
    .click();
  await config
    .getByText("连接成功：主机指纹及 SSH 密钥认证已通过。", { exact: true })
    .waitFor();
  assert.ok(
    await config
      .getByRole("button", { name: "保存配置", exact: true })
      .evaluate((el) => el.getBoundingClientRect().bottom <= innerHeight - 10),
  );
  await page.screenshot({
    path: join(out, `${evidencePrefix}-config-desktop.png`),
    fullPage: true,
  });
  await page.setViewportSize({ width: 390, height: 844 });
  assert.ok(
    await config.evaluate((el) => {
      const r = el.getBoundingClientRect();
      return (
        r.left >= 0 &&
        r.right <= innerWidth &&
        el.scrollWidth <= el.clientWidth + 1
      );
    }),
  );
  assert.ok(
    await config
      .getByRole("button", { name: "保存配置", exact: true })
      .evaluate((el) => el.getBoundingClientRect().bottom <= innerHeight - 5),
  );
  await page.screenshot({
    path: join(out, `${evidencePrefix}-config-mobile.png`),
    fullPage: true,
  });
  await config.getByRole("button", { name: "完成", exact: true }).click();
  await page.setViewportSize({ width: 1440, height: 1050 });
  const devices = assertValid(
    "devices-response",
    await api("/devices"),
  ).devices;
  assert.equal(devices.length, 1);
  const device = devices[0];
  assert.equal(device.connection_kind, backupMode ? "agent" : "ssh");
  assert.equal(device.ssh_configured, true);
  assert.equal(device.terminal_backend, "ssh");
  if (backupMode) assert.equal(device.id, "existing-agent");
  assert.equal(device.control_online, false);
  assertValid(
    "device-connection-response",
    await api(`/devices/${device.id}/connection`),
  );
  steps.push(
    backupMode
      ? "Browser: configure backup SSH on existing Agent ID without adding a device, verify host key and authentication; desktop/mobile form"
      : "Browser: create SSH-only device, verify host key, save private key, test auth; desktop/mobile form",
  );
  const row = page.locator("tbody tr").filter({ hasText: deviceName });
  await row.getByRole("button", { name: "连接终端", exact: true }).click();
  const terminal = page.getByRole("dialog");
  await terminal.getByText("已连接", { exact: true }).waitFor();
  await terminal.getByText("SSH 通道", { exact: true }).waitFor();
  await terminal.locator(".xterm-helper-textarea").focus();
  const text = async (value) =>
    page.waitForFunction(
      (v) =>
        Array.from(document.querySelectorAll(".xterm-rows")).some((e) =>
          e.textContent.includes(v),
        ),
      value,
    );
  await page.keyboard.type("stty -echo; printf '__SSH_TARGET_%s__\\n' READY\r");
  await text("__SSH_TARGET_READY__");
  await page.keyboard.type(
    'cd /tmp; printf \'__USER_%s__ __CWD_%s__\\n\' "$(id -un)" "$PWD"\r',
  );
  await text("__USER_terminal__ __CWD_/tmp__");
  await page.keyboard.type("printf '__WAIT_%s__\\n' BEGIN; sleep 30\r");
  await text("__WAIT_BEGIN__");
  await page.keyboard.press("Control+c");
  await page.keyboard.type("printf '__CTRL_%s__\\n' OK\r");
  await text("__CTRL_OK__");
  await page.setViewportSize({ width: 1100, height: 820 });
  await page.keyboard.type("stty size; printf '__SIZE_%s__\\n' OK\r");
  await text("__SIZE_OK__");
  await page.keyboard.type(
    "read -r -s -p 'secret:' secret; printf '\\n__HIDDEN_%s__\\n' OK\r",
  );
  await text("secret:");
  await page.keyboard.type("E2E_DO_NOT_RECORD_THIS_SECRET\r");
  await text("__HIDDEN_OK__");
  await page.keyboard.type("printf '__UTF8_%s__\\n' '中文'; exit\r");
  await text("__UTF8_中文__");
  await terminal.getByText("会话已结束", { exact: true }).waitFor();
  await page.screenshot({
    path: join(out, `${evidencePrefix}-web-terminal.png`),
    fullPage: true,
  });
  const sessions = (await api("/terminal-sessions")).sessions;
  const web = sessions.find((s) => s.transport === "web");
  assert.equal(web.backend, "ssh");
  assert.equal(web.device_id, device.id);
  assert.equal(web.audit_complete, 1);
  const recording = await api(`/terminal-sessions/${web.id}/recording`);
  const recorded = recording.events
    .filter((e) => e.kind === "output")
    .map((e) => Buffer.from(e.data.data, "base64").toString())
    .join("");
  assert.ok(recorded.includes("__UTF8_中文__"));
  assert.equal(recorded.includes("E2E_DO_NOT_RECORD_THIS_SECRET"), false);
  assert.ok(recording.events.some((e) => e.kind === "resize"));
  steps.push(
    "Real Linux sshd: web PTY, account/cwd, Ctrl-C, resize, UTF-8, no raw password recording, normal exit",
  );
  await terminal.getByRole("button", { name: "关闭终端", exact: true }).click();
  await page.getByRole("button", { name: "终端会话", exact: false }).click();
  await page
    .getByRole("button", { name: "查看回放", exact: true })
    .first()
    .click();
  await text("__UTF8_中文__");
  await page.screenshot({
    path: join(out, `${evidencePrefix}-replay.png`),
    fullPage: true,
  });
  steps.push("Browser replay displays saved SSH target output and duration");
  const gateway = server.ssh.info();
  const hostPublic = execFileSync(
    "ssh-keygen",
    ["-y", "-f", join(temp, "server/ssh_host_ed25519_key")],
    { encoding: "utf8" },
  ).trim();
  writeFileSync(
    join(temp, "known_hosts"),
    `[127.0.0.1]:${gateway.port} ${hostPublic}\n`,
  );
  writeFileSync(
    join(temp, "askpass"),
    "#!/bin/sh\nprintf '%s\\n' '" + password + "'\n",
    { mode: 0o700 },
  );
  cli = spawn(
    "ssh",
    [
      "-tt",
      "-p",
      String(gateway.port),
      "-l",
      "admin",
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
  let output = "";
  cli.stdout.on("data", (chunk) => {
    output += chunk.toString();
  });
  let stderr = "";
  cli.stderr.on("data", (chunk) => {
    stderr += chunk.toString();
  });
  await until(
    () =>
      output.includes(backupMode ? "备用 SSH · 按需连接" : "SSH · 按需连接"),
    "OpenSSH menu",
  );
  cli.stdin.write("1\r");
  await until(() => output.includes("$ "), "OpenSSH target shell");
  if (installMode)
    await installOnSshDevice({
      page,
      server,
      token,
      device,
      api,
      cli,
      output: () => output,
      until,
      container,
      temp,
      out,
      steps,
      frontend,
      expectedEntry: frontend?.origin,
      recordingId: web.id,
      recording,
      text,
    });
  cli.stdin.write(
    "stty -echo; printf '__OPENSSH_%s__\\n' \"$(id -un)\"; exit\r",
  );
  const [code] = await once(cli, "exit");
  assert.equal(code, 0, stderr);
  assert.ok(output.includes("__OPENSSH_terminal__"));
  const sshSession = (await api("/terminal-sessions")).sessions.find(
    (s) => s.transport === "ssh",
  );
  assert.equal(sshSession.backend, "ssh");
  assert.equal(sshSession.device_id, device.id);
  assert.equal(sshSession.audit_complete, 1);
  const sshRecording = await api(
    `/terminal-sessions/${sshSession.id}/recording`,
  );
  const sshText = sshRecording.events
    .filter((e) => e.kind === "output")
    .map((e) => Buffer.from(e.data.data, "base64").toString())
    .join("");
  assert.ok(sshText.includes("__OPENSSH_terminal__"));
  assert.equal(sshText.includes("可访问设备"), false);
  steps.push(
    "System OpenSSH -> platform device menu -> real Linux sshd, recorded with normal exit",
  );
  if (!installMode)
    assert.equal(
      server.store.db.prepare("SELECT COUNT(*) n FROM device_tokens").get().n,
      0,
      "No Agent authentication exists",
    );
  assert.equal(errors.length, 0, JSON.stringify(errors));
  assertValid("audit-response", await api("/audit"));
  writeFileSync(
    join(out, `${evidencePrefix}-e2e.json`),
    JSON.stringify({ ok: true, steps }, null, 2),
  );
  console.log(JSON.stringify({ ok: true, steps }, null, 2));
} finally {
  cli?.kill();
  await browser?.close();
  if (vite && vite.exitCode === null) {
    const exited = once(vite, "exit");
    vite.kill();
    await exited;
  }
  await frontend?.close();
  await server?.close();
  try {
    execFileSync("docker", ["rm", "-f", container], { stdio: "ignore" });
  } catch {}
}
