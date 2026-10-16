import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdtempSync, readFileSync, rmSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve, extname } from "node:path";
import { execFileSync } from "node:child_process";
import { chromium, expect } from "@playwright/test";
import { buildServer } from "../../apps/server/src/server.js";

const root = resolve(import.meta.dirname, "../..");
const temp = mkdtempSync(join(tmpdir(), "farhelm-frontend-"));
execFileSync(
  "bash",
  [join(root, "deploy/dev/generate-tls.sh"), join(temp, "tls")],
  { stdio: "ignore" },
);
const server = await buildServer({
  dataDir: join(temp, "data"),
  tlsCert: join(temp, "tls/server.crt"),
  tlsKey: join(temp, "tls/server.key"),
  adminUsername: "ui-review",
  adminPassword: "isolated-ui-test-password",
});
const db = server.store.db;
const actor = (
  db.prepare("SELECT id FROM users WHERE username='ui-review'").get() as any
).id;
const baseTime = Date.now() - 86_400_000;
server.store.transaction(() => {
  for (const id of ["production", "staging"])
    db.prepare(
      "INSERT INTO devices(id,public_key,name,created_at) VALUES(?,?,?,?)",
    ).run(id, id, id === "production" ? "生产 Linux" : "测试 Linux", baseTime);
  for (let i = 0; i < 605; i++) {
    const id = `task-${String(i).padStart(4, "0")}`,
      device = i % 2 ? "staging" : "production",
      created = baseTime + i * 1000;
    const task = {
      task_id: id,
      device_id: device,
      actor_id: actor,
      action: "exec",
      argv: ["/bin/echo", i === 0 ? "older-than-500" : `command-${i}`],
      cwd: "/tmp",
      created_at: created,
      expires_at: created + 1000,
      timeout_ms: 1000,
      max_output_bytes: 1000,
      payload_hash: "a".repeat(64),
    };
    db.prepare(
      "INSERT INTO tasks(id,device_id,actor_id,task_json,payload_hash,status,created_at,updated_at) VALUES(?,?,?,?,?,'SUCCEEDED',?,?)",
    ).run(
      id,
      device,
      actor,
      JSON.stringify(task),
      task.payload_hash,
      created,
      created,
    );
    db.prepare(
      "INSERT INTO terminal_sessions(id,device_id,actor_id,status,cols,rows,created_at,ended_at) VALUES(?,?,?,'CLOSED',80,24,?,?)",
    ).run(
      `session-${String(i).padStart(4, "0")}`,
      device,
      actor,
      created,
      created + 1000,
    );
  }
  for (let i = 0; i < 1105; i++)
    db.prepare(
      "INSERT INTO audit(at,actor_id,device_id,task_id,action,detail_json) VALUES(?,?,?,?,'task.cancel_requested','{}')",
    ).run(
      baseTime + i,
      actor,
      "production",
      i === 0 ? "older-than-1000" : null,
    );
});

// Serve only an isolated fixture over loopback HTTP. API calls exercise the real
// Fastify handlers; no existing instance, account, device or Agent is contacted.
const dist = join(root, "apps/web/dist");
const web = createServer(async (request, reply) => {
  try {
    const url = new URL(request.url!, "http://127.0.0.1");
    if (url.pathname.startsWith("/api/")) {
      const chunks: Buffer[] = [];
      for await (const chunk of request) chunks.push(Buffer.from(chunk));
      const payload = Buffer.concat(chunks);
      const result = await server.app.inject({
        method: request.method as any,
        url: request.url,
        headers: request.headers,
        ...(payload.length ? { payload } : {}),
      });
      reply.writeHead(result.statusCode, result.headers);
      reply.end(result.rawPayload);
      return;
    }
    const file = resolve(
      dist,
      "." +
        decodeURIComponent(url.pathname === "/" ? "/index.html" : url.pathname),
    );
    if (!file.startsWith(dist + "/")) {
      reply.writeHead(404).end();
      return;
    }
    const mime: Record<string, string> = {
      ".html": "text/html",
      ".js": "text/javascript",
      ".css": "text/css",
    };
    reply.setHeader(
      "content-type",
      mime[extname(file)] ?? "application/octet-stream",
    );
    reply.end(readFileSync(file));
  } catch {
    reply.writeHead(500).end();
  }
});
await new Promise<void>((done) => web.listen(0, "127.0.0.1", done));
const origin = `http://127.0.0.1:${(web.address() as any).port}`;
const evidence = join(root, ".test-output/frontend-optimization");
mkdirSync(evidence, { recursive: true });
let browser: Awaited<ReturnType<typeof chromium.launch>> | undefined;
try {
  browser = await chromium.launch({
    headless: true,
    ...(process.env.FLEET_CHROMIUM_BIN
      ? { executablePath: process.env.FLEET_CHROMIUM_BIN }
      : {}),
  });
  const page = await browser.newPage({
    viewport: { width: 1440, height: 1000 },
  });
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(String(error)));
  await page.goto(origin);
  await page.getByLabel("账号", { exact: true }).fill("ui-review");
  await page
    .getByLabel("密码", { exact: true })
    .fill("isolated-ui-test-password");
  await page.getByRole("button", { name: "登录 →", exact: true }).click();
  const row = page
    .locator(".device-table tbody tr")
    .filter({ hasText: "生产 Linux" });
  await expect(row).toBeVisible();
  await expect(row.getByRole("button")).toHaveCount(2);
  await page.screenshot({
    path: join(evidence, "devices-desktop.png"),
    fullPage: true,
  });
  await page.setViewportSize({ width: 390, height: 844 });
  assert.equal(
    await page
      .locator(".device-table")
      .evaluate((table) => table.scrollWidth <= table.clientWidth + 1),
    true,
  );
  await row.getByRole("button", { name: /^更多操作：/ }).click();
  const menu = page.getByRole("menu");
  await expect(
    menu.getByRole("menuitem", { name: "接入配置", exact: true }),
  ).toBeFocused();
  const box = (await menu.boundingBox())!;
  assert.ok(
    box.x >= 0 &&
      box.x + box.width <= 390 &&
      box.y >= 0 &&
      box.y + box.height <= 844,
  );
  await page.screenshot({
    path: join(evidence, "devices-mobile-menu.png"),
  });
  await page.keyboard.press("Escape");
  await expect(row.getByRole("button", { name: /^更多操作：/ })).toBeFocused();
  await page.setViewportSize({ width: 1440, height: 1000 });

  await page.route("**/api/v1/tasks", (route) =>
    route.fulfill({
      status: 503,
      contentType: "application/json",
      body: JSON.stringify({ error: "isolated-test-failure" }),
    }),
  );
  await page.getByRole("button", { name: "↻ 刷新", exact: true }).click();
  await expect(page.getByRole("alert")).toContainText("任务概况刷新失败");
  await row.getByRole("button", { name: /^更多操作：/ }).click();
  await expect(
    page.getByRole("menuitem", { name: "接入配置", exact: true }),
  ).toBeEnabled();
  await page.keyboard.press("Escape");
  await page.unroute("**/api/v1/tasks");

  await page.getByRole("button", { name: "任务中心", exact: false }).click();
  await expect(page.locator(".task-link")).toHaveCount(50);
  const first = (await page.locator(".task-link").first().textContent())!;
  await page.getByRole("button", { name: "下一页", exact: true }).click();
  await expect(page.getByRole("status")).toContainText("第 2 页");
  await expect(page.locator(".task-link").first()).not.toHaveText(first);
  const second = (await page.locator(".task-link").first().textContent())!;
  await page.getByRole("button", { name: "↻ 刷新", exact: true }).click();
  await expect(page.locator(".task-link").first()).toHaveText(second);
  await page.getByRole("button", { name: "上一页", exact: true }).click();
  await expect(page.locator(".task-link").first()).toHaveText(first);
  await page.getByLabel("关键词", { exact: true }).fill("older-than-500");
  await page.getByLabel("操作人账号或 ID", { exact: true }).fill("ui-review");
  await page.getByRole("button", { name: "查询历史", exact: true }).click();
  await expect(page.locator(".task-link")).toHaveCount(1);
  await expect(page.locator(".task-link")).toContainText("task-0000");
  await expect(
    page.getByRole("button", { name: "下一页", exact: true }),
  ).toBeDisabled();
  await page.screenshot({
    path: join(evidence, "old-task-query.png"),
    fullPage: true,
  });

  await page.getByRole("button", { name: "操作审计", exact: true }).click();
  await page.getByLabel("关键词", { exact: true }).fill("older-than-1000");
  await page.getByRole("button", { name: "查询历史", exact: true }).click();
  await expect(page.locator("tbody tr")).toHaveCount(1);
  await expect(page.locator("tbody tr")).toContainText("older-than-1");
  await page.screenshot({
    path: join(evidence, "old-audit-query.png"),
    fullPage: true,
  });
  await page.getByRole("button", { name: "终端会话", exact: true }).click();
  await page.getByLabel("关键词", { exact: true }).fill("session-0000");
  await page.getByRole("button", { name: "查询历史", exact: true }).click();
  await expect(page.locator("tbody tr")).toHaveCount(1);
  await expect(page.locator("tbody tr")).toContainText("session-0000");
  assert.deepEqual(errors, []);
  console.log(
    "PASS: device menu/mobile layout, isolated refresh failure, task/audit/session history queries, cursor navigation and refresh; real API handlers, temporary database, no Agent execution.",
  );
  console.log(`Screenshots: ${evidence}`);
} finally {
  await browser?.close();
  await new Promise<void>((done, reject) =>
    web.close((error) => (error ? reject(error) : done())),
  );
  await server.close();
  rmSync(temp, { recursive: true, force: true });
}
