import assert from "node:assert/strict";
import { chromium } from "@playwright/test";
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { resolve } from "node:path";
import { createRequire } from "node:module";
import { createHash } from "node:crypto";
import { once } from "node:events";
import { assertValid } from "../contracts/validate.mjs";
const require = createRequire(import.meta.url);
const { Client } = require("../../apps/server/node_modules/ssh2");
const credentials = process.env.FLEET_CREDENTIALS_FILE
  ? JSON.parse(readFileSync(process.env.FLEET_CREDENTIALS_FILE, "utf8"))
  : {
      username: process.env.FLEET_ADMIN_USER,
      password: process.env.FLEET_ADMIN_PASSWORD,
    };
assert.ok(
  credentials.username && credentials.password,
  "Supply explicit local credentials",
);
const url = process.env.FLEET_CONSOLE_URL || "https://localhost:5173";
const browser = await chromium.launch({
  headless: true,
  ...(process.env.FLEET_CHROMIUM_BIN
    ? { executablePath: process.env.FLEET_CHROMIUM_BIN }
    : {}),
});
const client = new Client();
client.on("error", () => {});
const output = resolve(import.meta.dirname, "../../.test-output");
mkdirSync(output, { recursive: true });
try {
  const context = await browser.newContext({
    viewport: { width: 1440, height: 1000 },
    permissions: ["clipboard-read", "clipboard-write"],
  });
  const page = await context.newPage();
  const errors = [];
  page.on("pageerror", (e) => errors.push(e.message));
  await page.goto(url);
  await page.getByLabel("账号", { exact: true }).fill(credentials.username);
  await page.getByLabel("密码", { exact: true }).fill(credentials.password);
  const loginResponse = page.waitForResponse(
    (r) => r.url().endsWith("/api/v1/login") && r.request().method() === "POST",
  );
  await page.getByRole("button", { name: "登录 →", exact: true }).click();
  const token = (await (await loginResponse).json()).access_token;
  const api = async (path) => {
    const response = await page.request.get(url + "/api/v1" + path, {
      headers: { authorization: "Bearer " + token },
    });
    assert.equal(response.status(), 200);
    return response.json();
  };
  const gateway = assertValid("ssh-info-response", await api("/ssh"));
  assert.equal(gateway.enabled, true);
  const devices = (await api("/devices")).devices;
  const device = devices.find((d) => d.control_online && !d.revoked_at);
  assert.ok(device, "Online local Agent required");
  const row = page
    .locator("tbody tr")
    .filter({ has: page.getByText(device.name, { exact: true }) })
    .first();
  await row.getByRole("button", { name: /^更多操作：/ }).click();
  await page.getByRole("menuitem", { name: "SSH 连接", exact: true }).click();
  const dialog = page.getByRole("dialog");
  await dialog.getByText(gateway.fingerprint, { exact: true }).waitFor();
  const command = await dialog.locator("pre").innerText();
  assert.ok(command.includes(device.id));
  assert.ok(command.includes(String(gateway.port)));
  await dialog
    .getByRole("button", { name: "复制连接命令", exact: true })
    .click();
  await dialog.getByRole("button", { name: "已复制", exact: true }).waitFor();
  assert.equal(
    await page.evaluate(() => navigator.clipboard.readText()),
    command,
  );
  await page.screenshot({
    path: resolve(output, "ssh-connect-desktop.png"),
    fullPage: true,
  });
  await page.setViewportSize({ width: 390, height: 844 });
  assert.ok(
    await dialog.evaluate((el) => {
      const r = el.getBoundingClientRect();
      return (
        r.left >= 0 &&
        r.right <= innerWidth &&
        el.scrollWidth <= el.clientWidth + 1
      );
    }),
  );
  await page.screenshot({
    path: resolve(output, "ssh-connect-mobile.png"),
    fullPage: true,
  });
  await dialog
    .getByRole("button", { name: "关闭 SSH 连接说明", exact: true })
    .click();
  await page.setViewportSize({ width: 1440, height: 1000 });
  const ready = once(client, "ready");
  client.connect({
    host:
      process.env.FLEET_SSH_TEST_HOST || gateway.host || new URL(url).hostname,
    port: gateway.port,
    username: credentials.username + ":" + device.id,
    password: credentials.password,
    hostVerifier: (key) =>
      "SHA256:" +
        createHash("sha256").update(key).digest("base64").replace(/=+$/, "") ===
      gateway.fingerprint,
  });
  await ready;
  const stream = await new Promise((resolve, reject) =>
    client.shell({ rows: 24, cols: 80 }, (err, stream) =>
      err ? reject(err) : resolve(stream),
    ),
  );
  stream.setEncoding("utf8");
  let text = "";
  stream.on("data", (data) => {
    text += data;
  });
  const until = async (fn) => {
    for (let n = 0; n < 200; n++) {
      if (await fn()) return;
      await new Promise((r) => setTimeout(r, 25));
    }
    throw Error("Timed out waiting for SSH/browser state");
  };
  await until(() => text.includes("$ "));
  stream.write("printf '\\136SSH_BROWSER_OK\\136\\n'\r");
  await until(() => text.includes("^SSH_BROWSER_OK^"));
  const session = (await api("/terminal-sessions")).sessions.find(
    (s) => s.transport === "ssh" && !s.ended_at && s.device_id === device.id,
  );
  assert.ok(session);
  await page.getByRole("button", { name: "终端会话", exact: false }).click();
  const sessionRow = page
    .locator("tbody tr")
    .filter({ hasText: session.id.slice(0, 12) });
  await sessionRow.getByText("SSH", { exact: true }).waitFor();
  const before = await sessionRow.locator(".session-duration").innerText();
  await page.waitForTimeout(1100);
  assert.notEqual(
    await sessionRow.locator(".session-duration").innerText(),
    before,
  );
  const closed = new Promise((resolve) => stream.once("close", resolve));
  await sessionRow
    .getByRole("button", { name: "结束会话", exact: true })
    .click();
  await closed;
  await sessionRow.getByText("已结束", { exact: true }).waitFor();
  await sessionRow
    .getByRole("button", { name: "查看回放", exact: true })
    .click();
  await page
    .getByRole("dialog")
    .getByText("录制时长", { exact: false })
    .waitFor();
  const recording = await api(`/terminal-sessions/${session.id}/recording`);
  const recorded = Buffer.concat(
    recording.events
      .filter((e) => e.kind === "output")
      .map((e) => Buffer.from(e.data.data, "base64")),
  ).toString();
  assert.ok(recorded.includes("^SSH_BROWSER_OK^"));
  assert.equal(recording.session.reason, "USER_DISCONNECTED");
  assert.equal(recording.session.transport, "ssh");
  assert.equal(recording.session.audit_complete, 0);
  await page.screenshot({
    path: resolve(output, "ssh-session-replay.png"),
    fullPage: true,
  });
  assert.deepEqual(errors, []);
  writeFileSync(
    resolve(output, "ssh-browser.json"),
    JSON.stringify(
      {
        passed: true,
        checks: [
          "visible endpoint and pinned fingerprint",
          "copy command",
          "mobile layout",
          "real Agent SSH shell",
          "shared session source/duration",
          "browser closes SSH session",
          "recording and replay",
        ],
      },
      null,
      2,
    ),
  );
  console.log(
    "PASS SSH browser flow: copy, mobile, real Agent, session duration, web close and replay",
  );
} finally {
  client.destroy();
  await browser.close();
}
