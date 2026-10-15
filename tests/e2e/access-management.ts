import assert from "node:assert/strict";
import { chromium, expect, type Page } from "@playwright/test";
import { buildServer } from "../../apps/server/src/server.ts";
import { token, hash } from "../../apps/server/src/util.ts";
import { WebSocket } from "../../apps/server/node_modules/ws/wrapper.mjs";
import { once } from "node:events";
import { spawn, execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
const root = resolve(import.meta.dirname, "../.."),
  temp = mkdtempSync(join(tmpdir(), "farhelm-access-browser-")),
  tls = join(temp, "tls"),
  output = join(root, ".test-output");
mkdirSync(output, { recursive: true });
execFileSync("bash", [join(root, "deploy/dev/generate-tls.sh"), tls], {
  stdio: "ignore",
});
const password = "access-browser-password";
const server = await buildServer({
  dataDir: join(temp, "server"),
  tlsCert: join(tls, "server.crt"),
  tlsKey: join(tls, "server.key"),
  adminUsername: "admin",
  adminPassword: password,
  consoleOrigin: "http://127.0.0.1:5186",
});
await server.app.listen({ host: "127.0.0.1", port: 0 });
const port = (server.app.server.address() as any).port;
for (const id of ["one", "two"])
  server.store.db
    .prepare(
      "INSERT INTO devices(id,public_key,name,created_at) VALUES(?,?,?,?)",
    )
    .run(id, id, id === "one" ? "生产 Linux" : "默认 Linux", Date.now());
// Protocol double exercises the real UI/API/WSS authorization path; Rust PTY has a separate browser test.
const access = token();
server.store.db
  .prepare(
    "INSERT INTO device_tokens(token_hash,device_id,expires_at,scope) VALUES(?,'one',?,'agent-control-output')",
  )
  .run(hash(access), Date.now() + 600000);
const agent = new WebSocket(`wss://localhost:${port}/agent/ws`, {
  ca: readFileSync(join(tls, "ca.crt")),
  headers: { authorization: "Bearer " + access },
});
const send = (type: string, body: any) =>
  agent.send(JSON.stringify({ v: 1, type, body }));
const closed: string[] = [];
agent.on("message", (raw) => {
  const m = JSON.parse(String(raw));
  if (m.type === "terminal.open") {
    send("terminal.opened", { session_id: m.body.session_id });
    send("terminal.output", {
      session_id: m.body.session_id,
      seq: 1,
      data: Buffer.from("ACCESS_BROWSER_READY\r\n").toString("base64"),
    });
  }
  if (m.type === "terminal.close") closed.push(m.body.session_id);
});
await once(agent, "open");
send("agent.hello", {
  agent_version: "access-browser-test-double",
  capabilities: ["terminal.pty.v1"],
});
const vite = spawn(
  process.execPath,
  [
    join(root, "apps/web/node_modules/vite/bin/vite.js"),
    "--host",
    "127.0.0.1",
    "--port",
    "5186",
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
let browser: any;
const errors: string[] = [];
async function login(page: Page, username: string, pw = password) {
  await page.goto("http://127.0.0.1:5186");
  await page.getByLabel("账号", { exact: true }).fill(username);
  await page.getByLabel("密码", { exact: true }).fill(pw);
  await page.getByRole("button", { name: "登录 →", exact: true }).click();
  await page.getByRole("button", { name: "设备总览", exact: true }).waitFor();
}
async function save(page: Page) {
  const dialog = page.getByRole("dialog");
  await dialog.getByRole("button", { name: "保存", exact: true }).click();
  await expect(dialog).toHaveCount(0);
  await expect(page.getByRole("status")).toContainText("已保存");
}
try {
  await expect
    .poll(
      async () => {
        try {
          return (await fetch("http://127.0.0.1:5186")).status;
        } catch {
          return 0;
        }
      },
      { timeout: 15000 },
    )
    .toBe(200);
  browser = await chromium.launch({ headless: true });
  const adminContext = await browser.newContext({
    viewport: { width: 1440, height: 1000 },
  });
  const admin = await adminContext.newPage();
  admin.on("pageerror", (e) => errors.push(e.message));
  await login(admin, "admin");
  await admin.getByRole("button", { name: "用户与权限", exact: true }).click();
  await admin.getByRole("tab", { name: /设备组/ }).click();
  await expect(
    admin.getByText("没有匹配的设备组", { exact: true }),
  ).toBeVisible();
  await admin.getByRole("button", { name: "创建设备组", exact: true }).click();
  await admin.getByLabel("设备组名称", { exact: true }).fill("生产组");
  await admin.getByLabel("组内设备 生产 Linux", { exact: true }).check();
  await save(admin);
  await admin.getByRole("tab", { name: /角色/ }).click();
  await admin.getByRole("button", { name: "创建角色", exact: true }).click();
  await admin.getByLabel("角色名称", { exact: true }).fill("终端专员");
  await admin.locator('input[value="terminal.connect"]').check();
  await save(admin);
  await admin.getByRole("tab", { name: /用户组/ }).click();
  await admin.getByRole("button", { name: "创建用户组", exact: true }).click();
  await admin.getByLabel("用户组名称", { exact: true }).fill("运维组");
  await admin.getByLabel("分配角色 终端专员", { exact: true }).check();
  await admin.getByLabel("批量选择设备组 生产组", { exact: true }).check();
  await save(admin);
  await admin.getByRole("tab", { name: /^用户 \d/ }).click();
  await admin.getByRole("button", { name: "创建用户", exact: true }).click();
  await admin.getByLabel("账号", { exact: true }).fill("operator");
  await admin.getByLabel("初始密码", { exact: true }).fill(password);
  await admin.getByLabel("加入用户组 运维组", { exact: true }).check();
  await save(admin);
  await expect(
    admin.getByRole("row").filter({ hasText: "operator" }),
  ).toContainText("1 台设备");
  await admin.screenshot({
    path: join(output, "access-users.png"),
    fullPage: true,
  });
  const userContext = await browser.newContext({
    viewport: { width: 1280, height: 850 },
  });
  const user = await userContext.newPage();
  user.on("pageerror", (e) => errors.push(e.message));
  await login(user, "operator");
  await expect(user.getByText("生产 Linux", { exact: true })).toBeVisible();
  await expect(user.getByText("默认 Linux", { exact: true })).toHaveCount(0);
  for (const name of ["用户与权限", "任务中心", "操作审计", "终端会话"])
    await expect(user.getByRole("button", { name, exact: true })).toHaveCount(
      0,
    );
  await user.getByRole("button", { name: "连接终端", exact: true }).click();
  await expect(
    user.getByRole("dialog").getByText("已连接", { exact: true }),
  ).toBeVisible();
  await expect(user.locator(".xterm-rows")).toContainText(
    "ACCESS_BROWSER_READY",
  );
  await admin.getByRole("tab", { name: /设备组/ }).click();
  await admin
    .getByRole("button", { name: "编辑设备组 生产组", exact: true })
    .click();
  await admin.getByLabel("组内设备 生产 Linux", { exact: true }).uncheck();
  await save(admin);
  assert.equal(closed.length, 0);
  assert.equal(
    (
      server.store.db
        .prepare(
          "SELECT COUNT(*) AS n FROM terminal_sessions WHERE status='OPEN'",
        )
        .get() as any
    ).n,
    1,
  );
  await admin.getByRole("tab", { name: /用户组/ }).click();
  await admin
    .getByRole("button", { name: "编辑用户组 运维组", exact: true })
    .click();
  await admin.getByLabel("授权设备 生产 Linux", { exact: true }).uncheck();
  await save(admin);
  await expect.poll(() => closed.length).toBe(1);
  await expect(
    user.getByRole("button", { name: "登录 →", exact: true }),
  ).toBeVisible({ timeout: 15000 });
  await login(user, "operator");
  await expect(user.getByText("生产 Linux", { exact: true })).toHaveCount(0);
  await admin.getByRole("tab", { name: /用户组/ }).click();
  await admin
    .getByRole("button", { name: "编辑用户组 运维组", exact: true })
    .click();
  await admin.getByLabel("授权设备 生产 Linux", { exact: true }).check();
  await admin.getByLabel("授权设备 默认 Linux", { exact: true }).check();
  await save(admin);
  // Refresh confirms inherited group grants without leaving an old login authorized.
  await user.reload();
  await login(user, "operator");
  await expect(user.getByText("默认 Linux", { exact: true })).toBeVisible();
  await expect(user.getByText("生产 Linux", { exact: true })).toBeVisible();
  await admin.getByRole("tab", { name: /^用户 \d/ }).click();
  await admin
    .getByRole("button", { name: "编辑用户 operator", exact: true })
    .click();
  await admin.screenshot({
    path: join(output, "access-user-form.png"),
    fullPage: true,
  });
  await admin.getByRole("button", { name: "关闭表单", exact: true }).click();
  await admin.setViewportSize({ width: 390, height: 844 });
  await admin.getByRole("tab", { name: /设备组/ }).click();
  await admin
    .getByRole("button", { name: "编辑设备组 生产组", exact: true })
    .click();
  await expect(admin.getByRole("dialog")).toBeVisible();
  assert.ok(
    await admin.evaluate(
      () => document.documentElement.scrollWidth <= window.innerWidth,
    ),
  );
  await admin.screenshot({
    path: join(output, "access-mobile-form.png"),
    fullPage: true,
  });
  assert.deepEqual(errors, []);
  const evidence = {
    ok: true,
    checks: [
      "UI creates custom role, user group, device group and account",
      "New and existing devices can be ungrouped",
      "Inherited grant restricts device list and UI operations",
      "Changing device tags leaves authorization and terminals intact; removing user-group scope closes terminals and revokes login",
      "Group grant update takes effect after login",
      "Mobile form stays within viewport",
    ],
    terminal_backend: "protocol test double",
  };
  writeFileSync(
    join(output, "access-browser.json"),
    JSON.stringify(evidence, null, 2),
  );
  console.log(JSON.stringify(evidence));
} finally {
  await browser?.close();
  vite.kill("SIGTERM");
  agent.terminate();
  await server.close();
}
