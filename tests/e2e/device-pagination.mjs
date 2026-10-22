import assert from "node:assert/strict";
import { chromium, expect } from "@playwright/test";
import { createServer } from "node:http";
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { buildServer } from "../../apps/server/dist/server.js";

const root = resolve(import.meta.dirname, "../..");
const temp = mkdtempSync(join(tmpdir(), "farhelm-pagination-"));
const out = join(root, ".test-output");
mkdirSync(out, { recursive: true });
let server, web, browser;
try {
  execFileSync(
    "bash",
    [join(root, "deploy/dev/generate-tls.sh"), join(temp, "tls")],
    { stdio: "ignore" },
  );
  const password = "pagination-fixture-password1";
  server = await buildServer({
    dataDir: join(temp, "data"),
    tlsCert: join(temp, "tls/server.crt"),
    tlsKey: join(temp, "tls/server.key"),
    adminUsername: "admin",
    adminPassword: password,
    webDist: join(root, "apps/web/dist"),
  });
  const db = server.store.db;
  for (let i = 0; i < 120; i++) {
    const id = `device-${String(i).padStart(3, "0")}`,
      name = `服务器-${String(i).padStart(3, "0")}`;
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
    deviceScope: ["device-000"],
  });
  db.prepare(
    "INSERT INTO device_groups(id,name,description,created_at,updated_at) VALUES('tail','末页设备','',1,1),('batch','跨页标签','',1,1)",
  ).run();
  db.prepare(
    "INSERT INTO device_group_members VALUES('device-119','tail')",
  ).run();
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
    if (p.startsWith("/api/v1/"))
      requests.push(p.slice(7) + new URL(r.url()).search);
  });
  async function login(page, username) {
    await page.getByLabel("账号", { exact: true }).fill(username);
    await page.getByLabel("密码", { exact: true }).fill(password);
    await page.getByRole("button", { name: "登录 →", exact: true }).click();
  }
  await page.clock.install();
  await page.goto(origin);
  await login(page, "admin");
  await expect(page.locator("tbody tr")).toHaveCount(50);
  assert.ok(
    !requests.includes("/devices") && !requests.includes("/device-groups"),
  );
  await expect(page.getByLabel("按设备组筛选")).toContainText("末页设备");
  const paging = page.getByLabel("设备分页", { exact: true });
  const row = (i) =>
    page.getByLabel(`选择设备 服务器-${String(i).padStart(3, "0")}`, {
      exact: true,
    });
  const current = () => page.locator('thead [aria-label="选择当前页设备"]');
  const selected = (n) =>
    expect(page.locator(".selected-count")).toContainText(`已选 ${n} 台`);
  await row(0).check();
  await paging.getByRole("button", { name: "下一页", exact: true }).click();
  await row(50).check();
  await selected(2);
  await expect(page.locator(".selected-count")).toContainText("1 台不在当前页");
  await page.getByLabel("筛选当前列表", { exact: true }).fill("服务器-119");
  await page.clock.runFor(301);
  await expect(page.locator("tbody tr")).toHaveCount(1);
  await row(119).check();
  await selected(3);
  await page.getByLabel("筛选当前列表", { exact: true }).fill("");
  await page.clock.runFor(301);
  await expect(page.locator("tbody tr")).toHaveCount(50);
  await current().check();
  await selected(52);
  await current().uncheck();
  await selected(2);
  await row(0).check();
  await page.getByRole("button", { name: "添加标签", exact: true }).click();
  await expect(page.getByRole("dialog")).toContainText(
    "对跨页已选的全部 3 台设备",
  );
  await page.getByLabel("批量标签 跨页标签", { exact: true }).check();
  await page.getByRole("button", { name: "确认添加", exact: true }).click();
  await expect(page.getByRole("dialog")).toHaveCount(0);
  assert.deepEqual(
    db
      .prepare(
        "SELECT device_id FROM device_group_members WHERE group_id='batch' ORDER BY device_id",
      )
      .all()
      .map((r) => r.device_id),
    ["device-000", "device-050", "device-119"],
  );
  await selected(3);
  await page.waitForLoadState("networkidle");
  requests.length = 0;
  await page.clock.runFor(10001);
  await expect
    .poll(() => requests.some((p) => p.startsWith("/devices?page=1&limit=50")))
    .toBe(true);
  assert.ok(
    !requests.includes("/devices") && !requests.includes("/device-groups"),
  );
  await selected(3);
  await paging.getByRole("button", { name: "下一页", exact: true }).click();
  await page
    .getByRole("button", { name: "查看设备详情：服务器-050", exact: true })
    .click();
  await expect(page.getByRole("meter")).toBeVisible();
  await page
    .getByRole("button", { name: "← 返回设备列表", exact: true })
    .click();
  await expect(page.locator(".table-footer")).toContainText("第 2 / 3 页");
  await expect(row(50)).toBeChecked();
  await page.getByLabel("按设备组筛选").selectOption("tail");
  await expect(page.locator("tbody tr")).toHaveCount(1);
  await expect(page.locator(".table-footer")).toContainText("第 1 / 1 页");
  await selected(3);
  await page.screenshot({
    path: join(out, "device-pagination-desktop.png"),
    fullPage: true,
  });
  await page.setViewportSize({ width: 390, height: 844 });
  await expect(page.locator(".mobile-device-selection input")).toBeChecked();
  await page.screenshot({
    path: join(out, "device-pagination-mobile.png"),
    fullPage: true,
  });
  assert.ok(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth,
    ),
  );
  await page.getByRole("button", { name: "清空选择", exact: true }).click();
  await expect(row(119)).not.toBeChecked();
  const fresh = await browser.newContext();
  const limited = await fresh.newPage();
  await limited.goto(origin);
  await login(limited, "reader");
  await expect(limited.locator("tbody tr")).toHaveCount(1);
  await expect(limited.getByLabel("按设备组筛选")).not.toContainText(
    "末页设备",
  );
  await expect(limited.locator(".table-footer")).toContainText("共 1 台");
  await expect(
    limited.getByRole("button", { name: "管理设备组", exact: true }),
  ).toHaveCount(0);
  await page.setViewportSize({ width: 1440, height: 1000 });
  requests.length = 0;
  await page.getByRole("button", { name: "管理设备组", exact: true }).click();
  await page.getByLabel("编辑设备组 末页设备", { exact: true }).click();
  const members = page.getByRole("group", { name: "组内设备", exact: true });
  await expect(members).toContainText("已选 1 台");
  assert.ok(!requests.some((p) => p.startsWith("/device-options")));
  await members
    .getByRole("button", { name: "选择组内设备", exact: true })
    .click();
  await members.getByLabel("组内设备 服务器-000", { exact: true }).check();
  await members.getByRole("button", { name: "下一页", exact: true }).click();
  await members.getByLabel("组内设备 服务器-025", { exact: true }).check();
  await expect(members).toContainText("已选 3 台");
  await members.getByLabel("仅看已选组内设备", { exact: true }).check();
  await expect(
    members.getByLabel("移除已选 服务器-119", { exact: true }),
  ).toBeChecked();
  await page.getByRole("button", { name: "保存设备组", exact: true }).click();
  await expect(
    page.getByRole("heading", { name: "设备组管理", exact: true }),
  ).toBeVisible();
  assert.deepEqual(
    db
      .prepare(
        "SELECT device_id FROM device_group_members WHERE group_id='tail' ORDER BY device_id",
      )
      .all()
      .map((r) => r.device_id),
    ["device-000", "device-025", "device-119"],
  );
  await page
    .getByRole("button", { name: "关闭设备组窗口", exact: true })
    .click();
  await page.getByRole("button", { name: /操作审计/ }).click();
  await expect(
    page.getByRole("heading", { name: "操作审计", exact: true }),
  ).toBeVisible();
  await page.waitForLoadState("networkidle");
  requests.length = 0;
  const history = page.getByRole("group", { name: "历史设备", exact: true });
  await history
    .getByRole("button", { name: "选择历史设备", exact: true })
    .click();
  await history.getByRole("button", { name: "下一页", exact: true }).click();
  await history.getByLabel("历史设备 服务器-025", { exact: true }).check();
  await page.getByRole("button", { name: "查询历史", exact: true }).click();
  await expect
    .poll(() =>
      requests.some(
        (p) => p.startsWith("/audit?") && p.includes("device_id=device-025"),
      ),
    )
    .toBe(true);
  await page.getByRole("button", { name: /任务中心/ }).click();
  await page.getByRole("button", { name: /新建命令任务/ }).click();
  const exec = page.getByRole("group", { name: "目标设备", exact: true });
  await exec.getByRole("button", { name: "选择目标设备", exact: true }).click();
  await exec.getByRole("button", { name: "下一页", exact: true }).click();
  await exec.getByLabel("目标设备 服务器-025", { exact: true }).check();
  await expect(exec).toContainText("服务器-025");
  await expect(
    page.getByRole("button", { name: "确认创建并执行", exact: true }),
  ).toBeEnabled();
  assert.ok(
    requests.some(
      (p) => p.startsWith("/device-options?") && p.includes("purpose=exec"),
    ),
  );
  assert.ok(!requests.includes("/devices"));
  await page.getByLabel("关闭命令表单", { exact: true }).click();
  await page.getByRole("button", { name: /API Token/ }).click();
  await page.getByRole("button", { name: "创建 Token", exact: true }).click();
  await page
    .getByPlaceholder("例如：每日巡检", { exact: true })
    .fill("分页权限测试");
  const grants = page.getByRole("group", { name: "授权设备", exact: true });
  await grants
    .getByRole("button", { name: "选择授权设备", exact: true })
    .click();
  await grants.getByLabel("授权设备 服务器-000", { exact: true }).check();
  await grants.getByRole("button", { name: "下一页", exact: true }).click();
  await grants.getByLabel("授权设备 服务器-025", { exact: true }).check();
  await grants.getByLabel("授权设备分组", { exact: true }).selectOption("tail");
  await grants.getByLabel("授权设备 服务器-119", { exact: true }).check();
  await grants.getByLabel("仅看已选授权设备", { exact: true }).check();
  await grants.getByLabel("移除已选 服务器-025", { exact: true }).click();
  await expect(
    grants.getByLabel("移除已选 服务器-025", { exact: true }),
  ).toHaveCount(0);
  await expect(grants).toContainText("已选 2 台");
  await expect(grants.locator(".picker-options input")).toHaveCount(2);
  await grants.scrollIntoViewIfNeeded();
  await page.screenshot({
    path: join(out, "device-picker-desktop.png"),
    fullPage: true,
  });
  await page.setViewportSize({ width: 390, height: 844 });
  await grants.evaluate((element) =>
    element.scrollIntoView({ block: "center" }),
  );
  await page.screenshot({
    path: join(out, "device-picker-mobile.png"),
    fullPage: true,
  });
  assert.ok(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth,
    ),
  );
  await page.getByRole("button", { name: "创建", exact: true }).click();
  await expect(
    page.getByRole("heading", {
      name: "Token 已创建：分页权限测试",
      exact: true,
    }),
  ).toBeVisible();
  const saved = db
    .prepare("SELECT device_scope FROM api_tokens WHERE name='分页权限测试'")
    .get();
  assert.deepEqual(JSON.parse(saved.device_scope).sort(), [
    "device-000",
    "device-119",
  ]);
  await page.getByRole("button", { name: "已保存，关闭", exact: true }).click();
  assert.ok(!requests.includes("/devices"));
  assert.deepEqual(errors, []);
  writeFileSync(
    join(out, "device-pagination-e2e.json"),
    JSON.stringify(
      {
        passed: true,
        devices: 120,
        checks: [
          "bounded page requests and polling",
          "scope-safe totals and facets",
          "current-page select/deselect",
          "cross-page/filter/refresh selection",
          "real batch changes exactly three devices",
          "detail return preserves page",
          "desktop and mobile pagination",
          "lazy lightweight history and execution choices",
          "group edit preserves off-page members",
          "API token persists exact cross-page selection after individual removal",
          "desktop and mobile device pickers",
        ],
      },
      null,
      2,
    ),
  );
  console.log(
    "PASS: 120-device pagination, filters, scoped facets, cross-page selection, actual batch writes, detail navigation and responsive layouts",
  );
} finally {
  await browser?.close();
  if (web) await new Promise((resolve) => web.close(resolve));
  await server?.app.close();
  rmSync(temp, { recursive: true, force: true });
}
