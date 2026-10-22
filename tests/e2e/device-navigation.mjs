import assert from "node:assert/strict";
import { chromium, expect } from "@playwright/test";
import { createServer } from "node:http";
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { buildServer } from "../../apps/server/dist/server.js";

const root = resolve(import.meta.dirname, "../..");
const temp = mkdtempSync(join(tmpdir(), "farhelm-navigation-"));
const out = join(root, ".test-output");
mkdirSync(out, { recursive: true });
let server, web, browser;
try {
  execFileSync(
    "bash",
    [join(root, "deploy/dev/generate-tls.sh"), join(temp, "tls")],
    { stdio: "ignore" },
  );
  const password = "navigation-fixture-password1";
  server = await buildServer({
    dataDir: join(temp, "data"),
    tlsCert: join(temp, "tls/server.crt"),
    tlsKey: join(temp, "tls/server.key"),
    adminUsername: "admin",
    adminPassword: password,
    webDist: join(root, "apps/web/dist"),
  });
  const db = server.store.db;
  for (const [id, name] of [
    ["one", "一号服务器"],
    ["two", "二号服务器"],
  ]) {
    db.prepare(
      "INSERT INTO devices(id,public_key,name,created_at) VALUES(?,?,?,?)",
    ).run(id, id, name, Date.now());
    db.prepare(
      "INSERT INTO device_disks(device_id,next_at,snapshot_json,checked_at,last_attempt_at) VALUES(?,?,?,?,?)",
    ).run(
      id,
      Date.now() + 86400000,
      JSON.stringify({
        total_bytes: 100 * 1024 ** 3,
        used_bytes: 40 * 1024 ** 3,
        available_bytes: 55 * 1024 ** 3,
        filesystem_count: 1,
      }),
      Date.now(),
      Date.now(),
    );
  }
  const reader = server.store.seedUser({
    username: "reader",
    password,
    role: "ops",
    deviceScope: ["one"],
  });
  web = createServer(async (req, res) => {
    try {
      const chunks = [];
      for await (const c of req) chunks.push(c);
      const response = await server.app.inject({
        method: req.method,
        url: req.url,
        headers: req.headers,
        ...(chunks.length ? { payload: Buffer.concat(chunks) } : {}),
      });
      res.writeHead(response.statusCode, response.headers);
      res.end(response.rawPayload);
    } catch {
      res.writeHead(500);
      res.end();
    }
  });
  await new Promise((resolve) => web.listen(0, "127.0.0.1", resolve));
  const origin = `http://127.0.0.1:${web.address().port}`;
  browser = await chromium.launch({
    headless: true,
    ...(process.env.FLEET_CHROMIUM_BIN
      ? { executablePath: process.env.FLEET_CHROMIUM_BIN }
      : {}),
  });
  const context = await browser.newContext({
    viewport: { width: 1440, height: 1000 },
  });
  const page = await context.newPage(),
    errors = [],
    requests = [];
  page.on("pageerror", (e) => errors.push(e.message));
  page.on("request", (r) => {
    const p = new URL(r.url()).pathname;
    if (p.startsWith("/api/v1/")) requests.push(p.slice(7));
  });
  async function login(page, username) {
    await page.getByLabel("账号", { exact: true }).fill(username);
    await page.getByLabel("密码", { exact: true }).fill(password);
    await page.getByRole("button", { name: "登录 →", exact: true }).click();
  }
  await page.clock.install();
  await page.goto(origin);
  await login(page, "admin");
  await page
    .getByRole("button", { name: "查看设备详情：一号服务器", exact: true })
    .click();
  await expect(page).toHaveURL(origin + "/#/devices/one");
  await expect(page.getByRole("meter")).toBeVisible();
  requests.length = 0;
  await page.clock.runFor(10001);
  await expect
    .poll(() => requests.filter((p) => p === "/devices/one").length)
    .toBe(1);
  assert.deepEqual(requests, ["/me", "/devices/one"]);
  await page.getByRole("button", { name: "健康检查", exact: true }).click();
  await expect(
    page.getByRole("dialog", { name: "健康检查：一号服务器" }),
  ).toBeVisible();
  await page.getByRole("button", { name: "关闭健康检查", exact: true }).click();
  await page.getByRole("button", { name: "网络记录", exact: true }).click();
  await expect(
    page.getByRole("dialog", { name: "网络记录：一号服务器" }),
  ).toBeVisible();
  await page.getByRole("button", { name: "关闭网络记录", exact: true }).click();
  await page
    .getByRole("button", { name: "← 返回设备列表", exact: true })
    .click();
  await page
    .getByRole("button", { name: "查看设备详情：二号服务器", exact: true })
    .click();
  await expect(
    page.getByRole("heading", { name: "二号服务器", exact: true }),
  ).toBeVisible();
  await page.goBack();
  await expect(
    page.getByRole("heading", { name: "设备总览", exact: true }),
  ).toBeVisible();
  await page.goBack();
  await expect(
    page.getByRole("heading", { name: "一号服务器", exact: true }),
  ).toBeVisible();
  await page.goForward();
  await page.goForward();
  await expect(
    page.getByRole("heading", { name: "二号服务器", exact: true }),
  ).toBeVisible();
  requests.length = 0;
  await page.reload();
  await expect(page.getByRole("meter")).toBeVisible();
  assert.ok(
    !requests.includes("/devices") &&
      !requests.includes("/tasks") &&
      !requests.includes("/login"),
  );
  await page.screenshot({
    path: join(out, "device-navigation-desktop.png"),
    fullPage: true,
  });
  await page.setViewportSize({ width: 390, height: 844 });
  await page.screenshot({
    path: join(out, "device-navigation-mobile.png"),
    fullPage: true,
  });
  assert.ok(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth,
    ),
  );
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.getByRole("button", { name: /操作审计/ }).click();
  await expect(
    page.getByRole("heading", { name: "操作审计", exact: true }),
  ).toBeVisible();
  await page.waitForLoadState("networkidle");
  requests.length = 0;
  await page.clock.runFor(10001);
  await expect.poll(() => requests.some((p) => p === "/audit")).toBe(true);
  assert.ok(!requests.includes("/devices") && !requests.includes("/tasks"));
  const fresh = await browser.newContext();
  const direct = await fresh.newPage();
  await direct.goto(origin + "/#/devices/one");
  await login(direct, "reader");
  await expect(
    direct.getByRole("heading", { name: "一号服务器", exact: true }),
  ).toBeVisible();
  db.prepare("UPDATE users SET device_scope='[]' WHERE id=?").run(reader.id);
  await direct.getByRole("button", { name: "↻ 刷新", exact: true }).click();
  await expect(
    direct.getByRole("alert").filter({ hasText: "设备不存在或无权查看" }),
  ).toBeVisible();
  await expect(direct.getByRole("meter")).toHaveCount(0);
  await page.goto(origin + "/#/devices/missing");
  await expect(page.getByText(/DEVICE_NOT_FOUND/)).toBeVisible();
  await expect(page.getByRole("meter")).toHaveCount(0);
  assert.deepEqual(errors, []);
  writeFileSync(
    join(out, "device-navigation-e2e.json"),
    JSON.stringify(
      {
        passed: true,
        checks: [
          "detail timer fetches only me and selected device",
          "health and network shortcuts",
          "back/forward across devices",
          "reload restores detail without full list",
          "fresh login returns to direct link",
          "history polling skips device list",
          "scope removal and missing device hide details",
          "desktop/mobile no overflow or page errors",
        ],
      },
      null,
      2,
    ),
  );
  console.log(
    "PASS: page-scoped requests, deep links, reload, history navigation, shortcuts, permissions and responsive details",
  );
} finally {
  await browser?.close();
  if (web) await new Promise((resolve) => web.close(resolve));
  await server?.app.close();
  rmSync(temp, { recursive: true, force: true });
}
