import assert from "node:assert/strict";
import { chromium } from "@playwright/test";
import { spawn, execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { createServer } from "node:net";
import { buildServer } from "../../apps/server/dist/server.js";
import { assertValid } from "../contracts/validate.mjs";

const root = resolve(import.meta.dirname, "../..");
const temp = mkdtempSync(join(tmpdir(), "farhelm-agent-install-e2e-"));
const out = join(root, ".test-output");
mkdirSync(out, { recursive: true });
const tls = join(temp, "tls");
execFileSync("bash", [join(root, "deploy/dev/generate-tls.sh"), tls], {
  stdio: "ignore",
});
const password = "isolated-agent-install-password";
const containers = [];
let server, vite, browser;
const errors = [],
  steps = [];
async function run(command, args) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { stdio: ["ignore", "pipe", "pipe"] });
    let output = "";
    child.stdout.on("data", (data) => {
      output += data;
    });
    child.stderr.on("data", (data) => {
      output += data;
    });
    child.on("error", reject);
    child.on("exit", (code) => resolve({ code, output }));
  });
}
async function until(fn, label, ms = 20000) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (await fn()) return;
    await new Promise((r) => setTimeout(r, 100));
  }
  throw Error("Timed out: " + label);
}
try {
  const probe = createServer();
  await new Promise((r) => probe.listen(0, "127.0.0.1", r));
  const webPort = probe.address().port;
  await new Promise((r) => probe.close(r));
  server = await buildServer({
    dataDir: join(temp, "server"),
    tlsCert: join(tls, "server.crt"),
    tlsKey: join(tls, "server.key"),
    adminUsername: "admin",
    adminPassword: password,
    consoleOrigin: `http://127.0.0.1:${webPort}`,
    agentInstall: {
      distDir:
        process.env.FLEET_AGENT_DIST_DIR ?? join(root, ".dev/agent-dist"),
      publicUrl: "https://localhost:8443",
      caCert: join(tls, "ca.crt"),
    },
  });
  await server.app.listen({ host: "127.0.0.1", port: 0 });
  const port = server.app.server.address().port;
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
  const origin = `http://127.0.0.1:${webPort}`;
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
    viewport: { width: 1440, height: 1000 },
  });
  page.on("pageerror", (e) => errors.push(String(e)));
  await page.goto(origin);
  await page.getByLabel("账号", { exact: true }).fill("admin");
  await page.getByLabel("密码", { exact: true }).fill(password);
  await page.getByRole("button", { name: "登录 →", exact: true }).click();
  await page.getByRole("heading", { name: "设备总览", exact: true }).waitFor();
  const login = (
    await server.app.inject({
      method: "POST",
      url: "/api/v1/login",
      payload: { username: "admin", password },
    })
  ).json();
  async function api(method, path, body) {
    const r = await server.app.inject({
      method,
      url: "/api/v1" + path,
      payload: body,
      headers: { authorization: "Bearer " + login.access_token },
    });
    assert.equal(r.statusCode, 200);
    return r.json();
  }
  assertValid(
    "agent-install-options",
    await api("GET", "/agent-install/options"),
  );
  for (const [index, arch] of ["arm64", "amd64"].entries()) {
    const container = `farhelm-install-e2e-${process.pid}-${arch}`;
    containers.push(container);
    const started = await run("docker", [
      "run",
      "--rm",
      "--init",
      "--detach",
      "--platform",
      "linux/" + arch,
      "--name",
      container,
      "--mount",
      `type=bind,source=${temp},target=/fixture,readonly`,
      "farhelm-agent-build:" + arch,
      "sleep",
      "infinity",
    ]);
    assert.equal(started.code, 0, started.output);
    let command;
    if (index === 0) {
      await page
        .getByRole("button", { name: "＋ 添加设备", exact: true })
        .click();
      await page
        .getByRole("button", { name: "Agent 接入", exact: true })
        .click();
      const form = page.getByRole("dialog");
      await form.getByLabel("设备名称", { exact: true }).fill("安装验证 ARM64");
      await form
        .getByLabel("平台地址", { exact: true })
        .fill(`https://host.docker.internal:${port}`);
      await page.screenshot({
        path: join(out, "agent-install-form-desktop.png"),
        fullPage: true,
      });
      await page.setViewportSize({ width: 390, height: 844 });
      assert.ok(
        await form.evaluate((el) => {
          const r = el.getBoundingClientRect();
          return (
            r.left >= 0 &&
            r.right <= innerWidth &&
            r.bottom <= innerHeight &&
            el.scrollWidth <= el.clientWidth + 1
          );
        }),
      );
      await page.screenshot({
        path: join(out, "agent-install-form-mobile.png"),
        fullPage: true,
      });
      await form
        .getByRole("button", { name: "生成安装命令", exact: true })
        .click();
      await form.getByLabel("安装命令", { exact: true }).waitFor();
      command = await form.getByLabel("安装命令", { exact: true }).inputValue();
      await page.screenshot({
        path: join(out, "agent-install-command-mobile.png"),
        fullPage: true,
      });
    } else {
      const created = assertValid(
        "agent-install-response",
        await api("POST", "/agent-installations", {
          v: 1,
          name: "安装验证 x86_64",
          server_url: `https://host.docker.internal:${port}`,
          run_user: "farhelm",
          start_mode: "background",
          allow_sudo: false,
        }),
      );
      command = created.command;
    }
    const script = join(temp, `bootstrap-${arch}.sh`);
    writeFileSync(script, command, { mode: 0o600 });
    const installed = await run("docker", [
      "exec",
      container,
      "bash",
      `/fixture/bootstrap-${arch}.sh`,
    ]);
    writeFileSync(join(out, `agent-install-${arch}.log`), installed.output);
    assert.equal(installed.code, 0, installed.output);
    assert.ok(installed.output.includes("设备已注册并在线"));
    const permissions = await run("docker", [
      "exec",
      container,
      "bash",
      "-c",
      'test "$(id -u farhelm)" != 0 && ! grep -q FLEET_ENROLLMENT_TOKEN /etc/farhelm-agent/agent.env && test "$(stat -c %a /etc/farhelm-agent/agent.env)" = 600 && test "$(stat -c %a /var/lib/farhelm-agent)" = 700 && test "$(stat -c %U /var/lib/farhelm-agent/identity.key)" = farhelm && ! readelf -l /usr/local/bin/farhelm-agent | grep -q INTERP',
    ]);
    assert.equal(permissions.code, 0, permissions.output);
    const newToken = await api("POST", "/agent-installations", {
      v: 1,
      name: "must-not-duplicate",
      server_url: `https://host.docker.internal:${port}`,
    });
    writeFileSync(join(temp, `repeat-${arch}.sh`), newToken.command, {
      mode: 0o600,
    });
    const repeated = await run("docker", [
      "exec",
      container,
      "bash",
      `/fixture/repeat-${arch}.sh`,
    ]);
    assert.notEqual(repeated.code, 0);
    assert.ok(repeated.output.includes("检测到已有安装"));
    assert.equal((await api("GET", "/devices")).devices.length, index + 1);
    steps.push(
      `${arch}: copy-generated command installed static Linux Agent, registered, connected, used non-root UID, cleared one-time credential, rejected overwrite`,
    );
    if (index === 0) {
      const form = page.getByRole("dialog");
      await form
        .getByText("设备已注册并在线，可以关闭窗口后连接终端。", {
          exact: true,
        })
        .waitFor();
      await form.getByRole("button", { name: "完成", exact: true }).click();
      await page.setViewportSize({ width: 1440, height: 1000 });
      await page
        .locator("tbody tr")
        .filter({ hasText: "安装验证 ARM64" })
        .getByRole("button", { name: "连接终端", exact: true })
        .click();
      const terminal = page.getByRole("dialog");
      await terminal.getByText("已连接", { exact: true }).waitFor();
      await terminal.locator(".xterm-helper-textarea").focus();
      await page.keyboard.type(
        "printf '__INSTALL_%s__ UID=%s\\n' OK \"$(id -u)\"; exit\r",
      );
      await terminal.getByText("会话已结束", { exact: true }).waitFor();
      const sessions = (await api("GET", "/terminal-sessions")).sessions;
      assert.equal(sessions.length, 1);
      const recording = await api(
        "GET",
        `/terminal-sessions/${sessions[0].id}/recording`,
      );
      const output = recording.events
        .filter((e) => e.kind === "output")
        .map((e) => Buffer.from(e.data.data, "base64").toString())
        .join("");
      assert.ok(output.includes("__INSTALL_OK__"));
      assert.equal(sessions[0].backend, "agent");
      assert.equal(sessions[0].audit_complete, 1);
      await page.screenshot({
        path: join(out, "agent-install-terminal.png"),
        fullPage: true,
      });
      await terminal
        .getByRole("button", { name: "关闭终端", exact: true })
        .click();
      await page
        .getByRole("button", { name: "＋ 添加设备", exact: true })
        .click();
      await page.getByRole("button", { name: "SSH 接入", exact: true }).click();
      await page
        .getByRole("dialog")
        .getByLabel("SSH 地址", { exact: true })
        .waitFor();
      await page
        .getByRole("button", { name: "关闭接入配置", exact: true })
        .click();
      steps.push(
        "Browser: matching modal forms, mobile layout, generation, live registration progress, installed Agent terminal and durable recording",
      );
    }
  }
  assert.deepEqual(errors, []);
  writeFileSync(
    join(out, "agent-install-e2e.json"),
    JSON.stringify(
      {
        ok: true,
        steps,
        limitation:
          "Docker background mode verified; no real host boot/systemd lifecycle test.",
      },
      null,
      2,
    ),
  );
  console.log("PASS", steps.join("\n"));
} finally {
  await browser?.close();
  vite?.kill("SIGTERM");
  for (const container of containers)
    await run("docker", ["rm", "--force", container]);
  await server?.close();
}
