// Explicit live-development check: renew the real certificate while a real Agent PTY is open.
import assert from "node:assert/strict";
import { chromium } from "@playwright/test";
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { resolve, join } from "node:path";
import { request } from "node:https";
import { X509Certificate } from "node:crypto";
import { renewTls } from "../../scripts/dev-tls.mjs";
assert.equal(
  process.env.FLEET_TEST_RENEW_TLS,
  "1",
  "Set FLEET_TEST_RENEW_TLS=1 to authorize this live certificate rotation test",
);
assert.ok(process.env.FLEET_CREDENTIALS_FILE, "Supply FLEET_CREDENTIALS_FILE");
const root = resolve(import.meta.dirname, "../.."),
  tls = resolve(process.env.FLEET_TLS_DIR || join(root, ".dev/tls"));
const origin =
  process.env.FLEET_CONSOLE_URL || "https://host.docker.internal:5173";
const backend = process.env.FLEET_BACKEND_URL || "https://localhost:8443";
const credentials = JSON.parse(
  readFileSync(process.env.FLEET_CREDENTIALS_FILE),
);
const ca = readFileSync(join(tls, "ca.crt")),
  before = new X509Certificate(readFileSync(join(tls, "server.crt")));
const output = join(root, ".test-output");
mkdirSync(output, { recursive: true });
const health = (url) =>
  new Promise((resolve, reject) => {
    const req = request(url + "/healthz", { ca, agent: false }, (res) => {
      const fingerprint = res.socket.getPeerX509Certificate().fingerprint256;
      res.resume();
      res.on("end", () =>
        res.statusCode === 200
          ? resolve(fingerprint)
          : reject(Error("Health failed")),
      );
    });
    req.setTimeout(5000, () => req.destroy(Error("TLS timeout")));
    req.on("error", reject);
    req.end();
  });
async function until(fn, label) {
  for (let i = 0; i < 60; i++) {
    if (await fn()) return;
    await new Promise((r) => setTimeout(r, 500));
  }
  throw Error(label);
}
const browser = await chromium.launch({ headless: true });
let second;
async function login(page) {
  await page.goto(origin);
  await page.getByLabel("账号", { exact: true }).fill(credentials.username);
  await page.getByLabel("密码", { exact: true }).fill(credentials.password);
  await page.getByRole("button", { name: "登录 →", exact: true }).click();
}
async function openTerminal(page) {
  const row = page
    .locator("tbody tr")
    .filter({ hasText: process.env.FLEET_DEVICE_NAME || "local-linux" });
  await row.getByRole("button", { name: "连接终端", exact: true }).click();
  const dialog = page.getByRole("dialog");
  await dialog.getByText("已连接", { exact: true }).waitFor();
  await dialog.locator(".xterm-helper-textarea").focus();
  return dialog;
}
async function hasOutput(page, marker) {
  await page.waitForFunction(
    (marker) =>
      [...document.querySelectorAll(".xterm-rows")].some((e) =>
        e.textContent.includes(marker),
      ),
    marker,
  );
}
try {
  const page = await browser.newPage({
    viewport: { width: 1440, height: 1000 },
  });
  await login(page);
  const dialog = await openTerminal(page);
  await page.keyboard.type("printf '__BEFORE_%s__\\n' RENEWAL\r");
  await hasOutput(page, "__BEFORE_RENEWAL__");
  const result = await renewTls(tls, { force: true });
  assert.equal(result.status, "renewed");
  const after = new X509Certificate(readFileSync(join(tls, "server.crt")));
  assert.notEqual(after.fingerprint256, before.fingerprint256);
  assert.deepEqual(readFileSync(join(tls, "ca.crt")), ca);
  await until(
    async () => (await health(origin)) === after.fingerprint256,
    "Frontend did not hot-reload renewed certificate",
  );
  await until(
    async () => (await health(backend)) === after.fingerprint256,
    "Backend did not hot-reload renewed certificate",
  );
  await page.keyboard.type("printf '__AFTER_%s__\\n' RENEWAL\r");
  await hasOutput(page, "__AFTER_RENEWAL__");
  await dialog.getByText("已连接", { exact: true }).waitFor();
  await page.screenshot({
    path: join(output, "tls-renewal-active-terminal.png"),
    fullPage: true,
  });
  await page.keyboard.type("exit\r");
  await dialog.getByText("会话已结束", { exact: true }).waitFor();
  await dialog.getByRole("button", { name: "关闭终端", exact: true }).click();
  await page.getByRole("button", { name: "终端会话", exact: true }).click();
  await page
    .locator("tbody tr")
    .first()
    .getByRole("button", { name: "查看回放", exact: true })
    .click();
  await hasOutput(page, "__BEFORE_RENEWAL__");
  await hasOutput(page, "__AFTER_RENEWAL__");
  await page
    .getByRole("dialog")
    .getByText("会话记录完整", { exact: true })
    .waitFor();
  // A fresh browser process has no reused TLS sockets or leaf trust; validate the stable root.
  second = await chromium.launch({ headless: true });
  const fresh = await second.newPage();
  await login(fresh);
  const newDialog = await openTerminal(fresh);
  await fresh.keyboard.type("printf '__NEW_%s__\\n' TLS; exit\r");
  await newDialog.getByText("会话已结束", { exact: true }).waitFor();
  await hasOutput(fresh, "__NEW_TLS__");
  const report = {
    passed: true,
    origin,
    root_unchanged: true,
    before: before.fingerprint256,
    after: after.fingerprint256,
    expires: after.validTo,
    frontend_hot_reload: true,
    backend_hot_reload: true,
    active_agent_terminal_preserved: true,
    complete_recording: true,
    new_browser_and_agent_terminal: true,
  };
  writeFileSync(
    join(output, "tls-renewal-browser.json"),
    JSON.stringify(report, null, 2) + "\n",
  );
  console.log(JSON.stringify(report, null, 2));
} finally {
  await second?.close();
  await browser.close();
}
