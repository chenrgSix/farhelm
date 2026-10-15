import assert from "node:assert/strict";
import { chromium, expect as baseExpect } from "@playwright/test";
import { execFileSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { assertValid } from "../contracts/validate.mjs";
const expect = baseExpect.configure({ timeout: 20000 });
const credentials = process.env.FLEET_CREDENTIALS_FILE
  ? JSON.parse(readFileSync(process.env.FLEET_CREDENTIALS_FILE, "utf8"))
  : {
      username: process.env.FLEET_ADMIN_USER,
      password: process.env.FLEET_ADMIN_PASSWORD,
    };
assert.ok(
  credentials.username && credentials.password,
  "Supply explicit local administrator credentials",
);
const url = process.env.FLEET_CONSOLE_URL || "https://localhost:5173";
const container = process.env.FLEET_HEALTH_CONTAINER || "farhelm-agent";
const marker = `fleet-health-browser-${process.pid}`;
const control = `/home/fleet/.${marker}.json`;
const output = resolve(import.meta.dirname, "../../.test-output");
mkdirSync(output, { recursive: true });
const python = `
import http.server, json, os, pathlib, sys, threading
class Handler(http.server.BaseHTTPRequestHandler):
    def do_GET(self):
        body=b'ready'
        self.send_response(200)
        self.send_header('Content-Length',str(len(body)))
        self.end_headers()
        self.wfile.write(body)
    def log_message(self,*args): pass
server=http.server.ThreadingHTTPServer(('127.0.0.1',0),Handler)
control=pathlib.Path(sys.argv[1])
control.write_text(json.dumps({'pid':os.getpid(),'port':server.server_address[1]}))
timer=threading.Timer(180,server.shutdown)
timer.daemon=True
timer.start()
try: server.serve_forever()
finally: server.server_close();control.unlink(missing_ok=True)
`;
const docker = (...args) =>
  execFileSync("docker", args, {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });
let browser, page, auth, deviceId;
const errors = [];
try {
  docker(
    "exec",
    "--detach",
    "--user",
    "fleet",
    container,
    "python3",
    "-c",
    python,
    control,
  );
  let fixture;
  for (let i = 0; i < 50; i++) {
    try {
      fixture = JSON.parse(docker("exec", container, "cat", control));
      break;
    } catch {
      await new Promise((r) => setTimeout(r, 100));
    }
  }
  assert.ok(fixture?.port, "Temporary Agent-local HTTP fixture did not start");
  browser = await chromium.launch({
    headless: true,
    ...(process.env.FLEET_CHROMIUM_BIN
      ? { executablePath: process.env.FLEET_CHROMIUM_BIN }
      : {}),
  });
  page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
  page.on("pageerror", (e) => errors.push(e.message));
  await page.goto(url);
  await page.getByLabel("账号", { exact: true }).fill(credentials.username);
  await page.getByLabel("密码", { exact: true }).fill(credentials.password);
  const login = page.waitForResponse(
    (r) => new URL(r.url()).pathname === "/api/v1/login",
  );
  await page.getByRole("button", { name: "登录 →", exact: true }).click();
  auth = (await (await login).json()).access_token;
  const row = page
    .locator("tbody tr")
    .filter({ hasText: process.env.FLEET_HEALTH_DEVICE || "local-linux" })
    .first();
  await row.getByRole("button", { name: "健康检查", exact: true }).click();
  const dialog = page.getByRole("dialog", { name: /^健康检查：/ });
  await dialog.getByRole("button", { name: "添加检查", exact: true }).waitFor();
  const originalCount = await dialog.locator(".check-card").count();
  assert.ok(originalCount < 8, "Health test needs one free check slot");
  await dialog.getByRole("button", { name: "添加检查", exact: true }).click();
  const card = dialog.locator(".check-card").last();
  await card.getByLabel("检查名称", { exact: true }).fill(marker);
  await card
    .getByLabel("检查地址", { exact: true })
    .fill(`http://127.0.0.1:${fixture.port}/healthz`);
  await card.getByLabel("响应包含文本（可选）", { exact: true }).fill("ready");
  await card.getByLabel("检查周期（秒）", { exact: true }).fill("5");
  await card.getByLabel("超时（毫秒）", { exact: true }).fill("1000");
  await card.getByLabel("连续失败阈值", { exact: true }).fill("2");
  async function save() {
    const pending = page.waitForResponse(
      (r) =>
        new URL(r.url()).pathname.endsWith("/health-checks") &&
        r.request().method() === "PUT",
    );
    await dialog.getByRole("button", { name: "保存配置", exact: true }).click();
    const response = await pending;
    assert.equal(response.status(), 200);
    deviceId = new URL(response.url()).pathname.split("/")[4];
    const data = await response.json();
    assertValid("device-health-response", data);
    return data;
  }
  await save();
  await expect(card.locator(".check-result strong")).toHaveText("健康");
  await expect(card).toContainText("检查通过");
  await page.screenshot({
    path: resolve(output, "health-checks.png"),
    fullPage: true,
  });
  await dialog
    .getByRole("button", { name: "关闭健康检查", exact: true })
    .click();
  if (originalCount === 0)
    await expect(row.locator("td").nth(3)).toContainText("健康");
  await row.getByRole("button", { name: "健康检查", exact: true }).click();
  await expect(card.getByLabel("检查名称", { exact: true })).toHaveValue(
    marker,
  );
  // A changed expected status makes the real HTTP service fail the check.
  await card.getByLabel("预期状态码", { exact: true }).fill("201");
  await save();
  await expect(card).toContainText("HTTP 状态码不符合预期");
  await dialog.getByRole("button", { name: "立即探测", exact: true }).click();
  await expect(card.locator(".check-result strong")).toHaveText("异常");
  await card.getByLabel("预期状态码", { exact: true }).fill("200");
  await save();
  await expect(card.locator(".check-result strong")).toHaveText("健康");
  await card.getByLabel("检查类型", { exact: true }).selectOption("tcp");
  await card.getByLabel("目标端口", { exact: true }).fill(String(fixture.port));
  await save();
  await expect(card.locator(".check-result strong")).toHaveText("健康");
  await card.getByLabel("检查类型", { exact: true }).selectOption("systemd");
  await card
    .getByLabel("服务单元", { exact: true })
    .fill("fleet-health-test.service");
  await save();
  await expect(card).toContainText("当前设备无法使用 systemd 检查");
  await expect(card.locator(".check-result strong")).toHaveText("未知");
  await card.getByLabel("启用检查", { exact: true }).uncheck();
  await save();
  await expect(card.locator(".check-result strong")).toHaveText("已停用");
  await page.setViewportSize({ width: 390, height: 844 });
  await page.screenshot({
    path: resolve(output, "health-checks-mobile.png"),
    fullPage: true,
  });
  assert.equal(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth,
    ),
    true,
  );
  await card.getByRole("button", { name: "删除检查", exact: true }).click();
  await save();
  await expect(dialog.locator(".check-card")).toHaveCount(originalCount);
  const auditResponse = await page.request.get(`${url}/api/v1/audit`, {
    headers: { authorization: `Bearer ${auth}` },
  });
  assertValid("audit-response", await auditResponse.json());
  assert.deepEqual(errors, []);
  writeFileSync(
    resolve(output, "health-browser.json"),
    JSON.stringify(
      {
        passed: true,
        actualRust: true,
        browser: browser.version(),
        steps: [
          "front-end configuration persists and reaches a real Agent-local HTTP service",
          "HTTP status/body checks, failure threshold, immediate probe and recovery",
          "TCP probe",
          "systemd unavailable remains unknown",
          "disable and delete",
          "device business-health summary",
          "audit contract",
          "mobile layout",
        ],
        pageErrors: errors,
      },
      null,
      2,
    ),
  );
  console.log(
    "PASS health browser: configure -> actual Rust HTTP/TCP -> fail/recover -> disable/delete -> mobile",
  );
} catch (error) {
  if (page)
    await page
      .screenshot({
        path: resolve(output, "health-failure.png"),
        fullPage: true,
      })
      .catch(() => {});
  throw error;
} finally {
  if (page && auth && deviceId) {
    const endpoint = `${url}/api/v1/devices/${deviceId}/health-checks`;
    const response = await page.request.get(endpoint, {
      headers: { authorization: `Bearer ${auth}` },
    });
    if (response.ok()) {
      const current = await response.json();
      const checks = current.checks
        .filter((c) => c.name !== marker)
        .map(({ result: _result, ...c }) => c);
      if (checks.length !== current.checks.length) {
        const cleanup = await page.request.put(endpoint, {
          headers: { authorization: `Bearer ${auth}` },
          data: { v: 1, revision: current.revision, checks },
        });
        assert.ok(cleanup.ok(), "Could not remove this test's health check");
      }
    }
  }
  await browser?.close();
  try {
    docker(
      "exec",
      container,
      "python3",
      "-c",
      "import json,os,signal,sys;from pathlib import Path;p=Path(sys.argv[1]);d=json.loads(p.read_text());os.kill(d['pid'],signal.SIGTERM);p.unlink(missing_ok=True)",
      control,
    );
  } catch {
    /* Fixture also expires automatically after three minutes. */
  }
}
