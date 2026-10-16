// Real CLI and browser exercise. TLS validation is also covered by server tests;
// the isolated browser accepts only this test context's temporary self-signed cert.
import assert from "node:assert/strict";
import { spawn, execFileSync, execFile } from "node:child_process";
import { promisify } from "node:util";
import { once } from "node:events";
import { createServer } from "node:net";
import { request as http } from "node:http";
import { request as https } from "node:https";
import { mkdtempSync, readFileSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { chromium } from "@playwright/test";
const root = resolve(import.meta.dirname, "../..");
const temp = mkdtempSync(join(tmpdir(), "fh-ui-deploy-"));
const dataDir = join(temp, "data"),
  out = join(root, ".test-output");
mkdirSync(out, { recursive: true });
const password = "isolated-deployment-ui-password";
async function port() {
  const s = createServer();
  await new Promise((r) => s.listen(0, "127.0.0.1", r));
  const p = s.address().port;
  await new Promise((r) => s.close(r));
  return p;
}
const webPort = await port(),
  sshPort = await port();
const plain = `http://127.0.0.1:${webPort}`,
  secure = `https://127.0.0.1:${webPort}`;
execFileSync(
  "openssl",
  [
    "req",
    "-x509",
    "-newkey",
    "rsa:2048",
    "-nodes",
    "-keyout",
    temp + "/key",
    "-out",
    temp + "/cert",
    "-days",
    "1",
    "-subj",
    "/CN=localhost",
    "-addext",
    "basicConstraints=critical,CA:FALSE",
    "-addext",
    "subjectAltName=IP:127.0.0.1,DNS:localhost",
  ],
  { stdio: "ignore" },
);
const env = Object.fromEntries(
  Object.entries(process.env).filter(
    ([k]) => !k.startsWith("FLEET_") && k !== "NODE_EXTRA_CA_CERTS",
  ),
);
Object.assign(env, {
  FLEET_HOST: "127.0.0.1",
  FLEET_PORT: String(webPort),
  FLEET_SSH_PORT: String(sshPort),
  FLEET_DEVICE_ACCESS: "ssh-only",
  FLEET_WEB_ENABLED: "1",
  FLEET_WEB_PROTOCOL: "http",
  FLEET_DATA_DIR: dataDir,
  FLEET_WEB_DIST: join(root, "apps/web/dist"),
  FLEET_TLS_CERT: temp + "/cert",
  FLEET_TLS_KEY: temp + "/key",
  FLEET_ADMIN_USER: "admin",
  FLEET_ADMIN_PASSWORD: password,
});
let child,
  browser,
  output = "",
  token = "";
const steps = [];
function start() {
  child = spawn(process.execPath, ["apps/server/dist/index.js"], {
    cwd: root,
    env,
    stdio: ["ignore", "pipe", "pipe"],
  });
  child.stdout.on("data", (c) => (output += c));
  child.stderr.on("data", (c) => (output += c));
}
async function until(fn) {
  for (let i = 0; i < 150; i++) {
    assert.equal(child.exitCode, null, output);
    try {
      if (await fn()) return;
    } catch {}
    await new Promise((r) => setTimeout(r, 100));
  }
  throw Error("Readiness timed out");
}
async function api(protocol, path, method = "GET", body) {
  return new Promise((resolve, reject) => {
    const req = (protocol === "https" ? https : http)(
      {
        hostname: "127.0.0.1",
        port: webPort,
        path: "/api/v1" + path,
        method,
        agent: false,
        ca: readFileSync(temp + "/cert"),
        headers: {
          authorization: "Bearer " + token,
          ...(body ? { "content-type": "application/json" } : {}),
        },
      },
      (res) => {
        let data = "";
        res.on("data", (c) => (data += c));
        res.on("end", () =>
          resolve({ status: res.statusCode, body: JSON.parse(data) }),
        );
      },
    );
    req.on("error", reject);
    req.setTimeout(1000, () => req.destroy());
    req.end(body ? JSON.stringify(body) : undefined);
  });
}
async function ready(protocol, state) {
  await until(async () => {
    const r = await api(protocol, "/settings/deployment");
    return r.status === 200 && r.body.state === state;
  });
}
try {
  start();
  await until(async () => {
    const r = await api("http", "/login", "POST", {
      username: "admin",
      password,
    });
    if (r.status === 200) token = r.body.access_token;
    return !!token;
  });
  const key = readFileSync(dataDir + "/ssh_host_ed25519_key");
  browser = await chromium.launch({
    executablePath: process.env.FLEET_CHROMIUM_BIN,
    headless: true,
  });
  const context = await browser.newContext({
    ignoreHTTPSErrors: true,
    viewport: { width: 1360, height: 1100 },
  });
  const page = await context.newPage();
  const errors = [];
  page.on("pageerror", (e) => errors.push(e.message));
  async function login(origin) {
    await page.goto(origin);
    await page.locator('input[name="username"]').fill("admin");
    await page.locator('input[name="password"]').fill(password);
    await page.getByRole("button", { name: "登录 →", exact: true }).click();
    await page.locator("nav").getByRole("button", { name: "系统设置" }).click();
    await page
      .getByRole("region", { name: "平台运行方式" })
      .getByRole("button", { name: "刷新运行设置" })
      .waitFor();
  }
  const panel = page.getByRole("region", { name: "平台运行方式" });
  async function confirm() {
    await panel.getByRole("button", { name: /确认保留此配置/ }).click();
    await panel.getByText("配置已生效并保存，平台重启后继续使用。").waitFor();
  }
  await login(plain);
  await panel
    .getByLabel("设备接入方式", { exact: true })
    .selectOption("agent-ssh");
  await panel.getByText(/Agent 接入需要 HTTPS/).waitFor();
  await panel.getByLabel("网页协议", { exact: true }).selectOption("https");
  await panel.getByRole("button", { name: "保存并应用" }).click();
  await ready("https", "awaiting_confirmation");
  await login(secure);
  await confirm();
  assert.equal(
    (await api("https", "/me")).body.runtime.device_access,
    "agent-ssh",
  );
  steps.push("Browser enabled Agent + HTTPS and confirmed over new entry");
  await panel
    .getByLabel("设备接入方式", { exact: true })
    .selectOption("ssh-only");
  await panel.getByLabel("网页协议", { exact: true }).selectOption("http");
  await panel.getByRole("button", { name: "保存并应用" }).click();
  await ready("http", "awaiting_confirmation");
  await login(plain);
  await confirm();
  steps.push("Browser switched back to SSH + HTTP");
  await panel.getByLabel("网页管理", { exact: true }).selectOption("false");
  await panel.getByRole("checkbox").check();
  await panel.getByRole("button", { name: "保存并应用" }).click();
  await until(async () => {
    const s = JSON.parse(readFileSync(dataDir + "/deployment.json"));
    return s.state === "idle" && s.settings.web_enabled === false;
  });
  assert.equal(
    JSON.parse(readFileSync(dataDir + "/deployment.json")).settings.web_enabled,
    false,
  );
  await promisify(execFile)(
    process.execPath,
    ["apps/server/dist/enable-web.js", "--data-dir", dataDir],
    { cwd: root },
  );
  await ready("http", "awaiting_confirmation");
  await login(plain);
  await confirm();
  steps.push(
    "Browser disabled web; local recovery command restored web and browser confirmed",
  );
  await page.screenshot({
    path: join(out, "deployment-settings.png"),
    fullPage: true,
  });
  child.kill("SIGTERM");
  await once(child, "exit");
  start();
  await ready("http", "idle");
  assert.deepEqual(readFileSync(dataDir + "/ssh_host_ed25519_key"), key);
  assert.equal(
    (await api("http", "/me")).body.runtime.device_access,
    "ssh-only",
  );
  assert.deepEqual(errors, []);
  steps.push(
    "Restart retained HTTP settings, administrator session and SSH host key",
  );
  writeFileSync(
    join(out, "deployment-settings.json"),
    JSON.stringify({ ok: true, steps }, null, 2),
  );
  console.log(JSON.stringify({ ok: true, steps }));
} catch (error) {
  writeFileSync(join(out, "deployment-settings-server.log"), output);
  throw error;
} finally {
  await browser?.close();
  if (child?.exitCode === null) {
    child.kill("SIGTERM");
    await once(child, "exit");
  }
}
