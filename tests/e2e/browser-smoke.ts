import { chromium } from "@playwright/test";
import { buildServer } from "../../apps/server/src/server.ts";
import { spawn, execFileSync, type ChildProcess } from "node:child_process";
import { mkdtempSync, readFileSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import https from "node:https";
const root = path.resolve(import.meta.dirname, "../..");
const temp = mkdtempSync(path.join(tmpdir(), "fleet-browser-"));
const tls = path.join(temp, "tls");
execFileSync("bash", [path.join(root, "deploy/dev/generate-tls.sh"), tls]);
const ca = readFileSync(path.join(tls, "ca.crt"));
const password = "local-browser-test-password-unique";
const server = await buildServer({
  dataDir: path.join(temp, "server"),
  tlsCert: path.join(tls, "server.crt"),
  tlsKey: path.join(tls, "server.key"),
  adminUsername: "browser-admin",
  adminPassword: password,
  webDist: path.join(root, "apps/web/dist"),
});
await server.app.listen({ host: "127.0.0.1", port: 0 });
const port = (server.app.server.address() as any).port;
function api(route: string, body: any, token?: string): Promise<any> {
  return new Promise((resolve, reject) => {
    const data = Buffer.from(JSON.stringify(body));
    const r = https.request(
      {
        hostname: "localhost",
        port,
        path: route,
        method: "POST",
        ca,
        headers: {
          "content-type": "application/json",
          "content-length": String(data.length),
          ...(token ? { authorization: `Bearer ${token}` } : {}),
        },
      },
      (res) => {
        const a: Buffer[] = [];
        res.on("data", (b) => a.push(b));
        res.on("end", () => {
          if ((res.statusCode ?? 500) >= 400)
            reject(Error(Buffer.concat(a).toString()));
          else resolve(JSON.parse(Buffer.concat(a).toString()));
        });
      },
    );
    r.on("error", reject);
    r.end(data);
  });
}
const login = await api("/api/v1/login", {
  username: "browser-admin",
  password,
});
const enroll = await api(
  "/api/v1/enrollment-tokens",
  { v: 1, ttl_seconds: 600 },
  login.access_token,
);
const children: ChildProcess[] = [];
let browser: any;
try {
  const agent = spawn(path.join(root, "agent/target/debug/fleet-agent"), [], {
    env: {
      ...process.env,
      FLEET_SERVER_URL: `https://localhost:${port}`,
      FLEET_CA_CERT: path.join(tls, "ca.crt"),
      FLEET_STATE_DIR: path.join(temp, "agent"),
      FLEET_ENROLLMENT_TOKEN: enroll.enrollment_token,
      FLEET_DEVICE_NAME: "frontend-linux",
      FLEET_EXECUTION_BACKEND: "same-uid",
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  children.push(agent);
  // UI is loopback HTTP only, upstream HTTPS validates the generated CA.
  const vite = spawn(
    process.execPath,
    [
      path.join(root, "apps/web/node_modules/vite/bin/vite.js"),
      "--host",
      "127.0.0.1",
      "--port",
      "5177",
      "--strictPort",
    ],
    {
      cwd: path.join(root, "apps/web"),
      env: {
        ...process.env,
        NODE_EXTRA_CA_CERTS: path.join(tls, "ca.crt"),
        FLEET_DEV_API_TARGET: `https://localhost:${port}`,
      },
      stdio: ["ignore", "pipe", "pipe"],
    },
  );
  children.push(vite);
  let ready = false;
  for (let n = 0; n < 100; n++) {
    try {
      const r = await fetch("http://127.0.0.1:5177");
      if (r.ok) {
        ready = true;
        break;
      }
    } catch {}
    await new Promise((r) => setTimeout(r, 100));
  }
  if (!ready) throw Error("Vite not ready");
  browser = await chromium.launch({
    executablePath: process.env.FLEET_CHROMIUM_BIN || "/usr/bin/chromium",
    headless: true,
    args: ["--disable-dev-shm-usage"],
  });
  const page = await browser.newPage({
    viewport: { width: 1440, height: 1000 },
  });
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(String(e)));
  await page.goto("http://127.0.0.1:5177");
  await page.getByLabel("账号", { exact: true }).fill("browser-admin");
  await page.getByLabel("密码", { exact: true }).fill(password);
  await page.getByRole("button", { name: "登录 →", exact: true }).click();
  await page.getByText("frontend-linux", { exact: true }).waitFor();
  mkdirSync(path.join(root, "docs/screenshots"), { recursive: true });
  await page.screenshot({
    path: path.join(root, "docs/screenshots/devices.png"),
    fullPage: true,
  });
  await page.getByRole("button", { name: "执行", exact: true }).click();
  await page
    .getByLabel("程序与参数 · JSON 数组", { exact: true })
    .fill('["/bin/echo","browser verified Rust execution"]');
  await page
    .getByRole("button", { name: "确认创建并执行", exact: true })
    .click();
  await page.getByRole("heading", { name: /任务详情/ }).waitFor();
  await page.getByLabel("关闭命令表单", { exact: true }).click();
  for (let n = 0; n < 30; n++) {
    const button = page
      .locator(".output-section")
      .first()
      .getByRole("button", { name: "读取输出 · 留痕", exact: true });
    if (await button.isEnabled()) {
      await button.click();
      break;
    }
    await page.getByRole("button", { name: "↻ 刷新", exact: true }).click();
    await page.waitForTimeout(300);
  }
  await page
    .locator('[data-stream="stdout"]')
    .filter({ hasText: "browser verified Rust execution" })
    .waitFor();
  await page.screenshot({
    path: path.join(root, "docs/screenshots/task-result.png"),
    fullPage: true,
  });
  await page.getByRole("button", { name: "操作审计", exact: true }).click();
  await page.getByRole("button", { name: "↻ 刷新", exact: true }).click();
  await page.getByText("output.viewed", { exact: true }).first().waitFor();
  await page.screenshot({
    path: path.join(root, "docs/screenshots/audit.png"),
    fullPage: true,
  });
  await page.setViewportSize({ width: 390, height: 844 });
  await page.screenshot({
    path: path.join(root, "docs/screenshots/mobile.png"),
    fullPage: true,
  });
  await page.getByLabel("退出登录", { exact: true }).click();
  await page
    .getByRole("heading", { name: "登录控制台", exact: true })
    .waitFor();
  if (errors.length) throw Error(`Browser errors: ${errors.join("\n")}`);
  writeFileSync(
    path.join(root, ".test-output/browser-smoke.json"),
    JSON.stringify(
      {
        passed: true,
        browser: "Chromium " + browser.version(),
        actualRust: true,
        steps: [
          "login",
          "real device heartbeat",
          "UI creates Exec",
          "verified stdout SHA",
          "audit output.viewed",
          "mobile layout",
          "logout",
        ],
        pageErrors: errors,
      },
      null,
      2,
    ),
  );
  console.log(
    "PASS real Chromium: login -> real Rust Agent Exec -> verified output -> audit -> mobile -> logout",
  );
} finally {
  if (browser) await browser.close();
  for (const c of children) {
    c.kill("SIGTERM");
    await Promise.race([
      new Promise((r) => c.once("exit", r)),
      new Promise((r) => setTimeout(r, 3000)),
    ]);
    if (c.exitCode === null && c.signalCode === null) c.kill("SIGKILL");
  }
  await server.close();
}
