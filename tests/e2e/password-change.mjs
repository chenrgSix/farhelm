// Isolated browser/API/SSH integration. Agent is a protocol double, not a Linux PTY.
import assert from "node:assert/strict";
import { chromium, expect } from "@playwright/test";
import { mkdtempSync, readFileSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { once } from "node:events";
import { createRequire } from "node:module";
import { buildServer } from "../../apps/server/dist/server.js";
import { hash, token } from "../../apps/server/dist/util.js";
const require = createRequire(import.meta.url),
  { Client } = require("../../apps/server/node_modules/ssh2"),
  { WebSocket } = require("../../apps/server/node_modules/ws");
const root = resolve(import.meta.dirname, "../.."),
  tls = process.env.FLEET_TEST_TLS_DIR ?? join(root, ".dev/tls"),
  out = join(root, ".test-output");
const oldPassword = "personal-browser-old-password",
  newPassword = "personal-browser-new-password";
const server = await buildServer({
  dataDir: mkdtempSync(join(tmpdir(), "farhelm-password-")),
  tlsCert: join(tls, "server.crt"),
  tlsKey: join(tls, "server.key"),
  webDist: join(root, "apps/web/dist"),
  adminUsername: "admin",
  adminPassword: oldPassword,
  ssh: { host: "127.0.0.1", port: 0 },
});
let browser, agent, ssh;
const clients = [];
try {
  await server.app.listen({ host: "127.0.0.1", port: 0 });
  const port = server.app.server.address().port,
    origin = `https://localhost:${port}`;
  const admin = (
    await server.app.inject({
      method: "POST",
      url: "/api/v1/login",
      payload: { username: "admin", password: oldPassword },
    })
  ).json().access_token;
  const api = async (method, path, body, auth = admin) =>
    server.app.inject({
      method,
      url: "/api/v1" + path,
      payload: body,
      headers: { authorization: "Bearer " + auth },
    });
  const user = server.store.seedUser({
    username: "operator",
    password: oldPassword,
    role: "ops",
    deviceScope: ["one"],
  });
  const blank = await api("POST", "/users", {
    v: 1,
    username: "no-roles",
    password: oldPassword,
    enabled: true,
    role_ids: [],
    group_ids: [],
    device_scope: [],
  });
  assert.equal(blank.statusCode, 200);
  server.store.db
    .prepare(
      "INSERT INTO devices(id,public_key,name,created_at) VALUES('one','test','Password test device',?)",
    )
    .run(Date.now());
  const access = token();
  server.store.db
    .prepare(
      "INSERT INTO device_tokens(token_hash,device_id,expires_at,scope) VALUES(?,'one',?,'agent-control-output')",
    )
    .run(hash(access), Date.now() + 600000);
  agent = new WebSocket(`wss://localhost:${port}/agent/ws`, {
    ca: readFileSync(join(tls, "ca.crt")),
    headers: { authorization: "Bearer " + access },
  });
  const send = (type, body) => agent.send(JSON.stringify({ v: 1, type, body }));
  agent.on("message", (raw) => {
    const m = JSON.parse(String(raw));
    if (m.type === "terminal.open") {
      send("terminal.opened", { session_id: m.body.session_id });
      send("terminal.output", {
        session_id: m.body.session_id,
        seq: 1,
        data: Buffer.from("PASSWORD_CHANGE_SESSION_READY\r\n").toString(
          "base64",
        ),
      });
    }
  });
  await once(agent, "open");
  send("agent.hello", {
    agent_version: "password-protocol-test",
    capabilities: ["terminal.pty.v1"],
  });
  await expect
    .poll(
      async () =>
        (await api("GET", "/devices")).json().devices[0].control_online,
    )
    .toBe(true);
  const sshInfo = (await api("GET", "/ssh")).json();
  async function connectSSH(password) {
    const c = new Client();
    clients.push(c);
    await new Promise((resolve, reject) => {
      c.once("ready", resolve);
      c.once("error", reject);
      c.connect({
        host: "127.0.0.1",
        port: sshInfo.port,
        username: "operator:one",
        password,
        hostHash: "sha256",
        hostVerifier: (key) =>
          "SHA256:" +
            Buffer.from(key, "hex").toString("base64").replace(/=+$/, "") ===
          sshInfo.fingerprint,
        readyTimeout: 5000,
      });
    });
    return c;
  }
  browser = await chromium.launch({
    headless: true,
    channel: process.env.FLEET_TEST_BROWSER_CHANNEL,
  });
  const context = await browser.newContext({
      viewport: { width: 1440, height: 1050 },
    }),
    page = await context.newPage(),
    second = await context.newPage();
  const errors = [];
  for (const p of [page, second])
    p.on("pageerror", (e) => errors.push(e.message));
  async function login(p, username, password) {
    await p.goto(origin);
    await p.getByLabel("账号", { exact: true }).fill(username);
    await p.getByLabel("密码", { exact: true }).fill(password);
    await p.getByRole("button", { name: "登录 →", exact: true }).click();
  }
  await login(page, "operator", oldPassword);
  await expect(
    page.getByRole("button", { name: "修改密码", exact: true }),
  ).toBeVisible();
  await login(second, "operator", oldPassword);
  await second.getByRole("button", { name: "连接终端", exact: true }).click();
  await expect(
    second.getByRole("dialog").getByText("已连接", { exact: true }),
  ).toBeVisible();
  ssh = await connectSSH(oldPassword);
  let sshOutput = "";
  const stream = await new Promise((resolve, reject) =>
    ssh.shell({ term: "xterm-256color" }, (e, s) =>
      e ? reject(e) : resolve(s),
    ),
  );
  stream.on("data", (d) => (sshOutput += d));
  await expect.poll(() => sshOutput).toContain("PASSWORD_CHANGE_SESSION_READY");
  const sshClosed = once(ssh, "close");
  await page.getByRole("button", { name: "修改密码", exact: true }).click();
  const dialog = page.getByRole("dialog");
  await expect(dialog.getByLabel("当前密码", { exact: true })).toBeFocused();
  await dialog.getByLabel("当前密码", { exact: true }).fill("wrong");
  await dialog.getByLabel("新密码", { exact: true }).fill(newPassword);
  await dialog
    .getByLabel("确认新密码", { exact: true })
    .fill(newPassword + "-typo");
  await expect(
    dialog.getByRole("button", { name: "确认修改", exact: true }),
  ).toBeDisabled();
  await dialog.getByLabel("确认新密码", { exact: true }).fill(newPassword);
  await dialog.getByRole("button", { name: "确认修改", exact: true }).click();
  await expect(dialog.getByRole("alert")).toContainText("当前密码不正确");
  await dialog.getByLabel("当前密码", { exact: true }).fill(oldPassword);
  mkdirSync(out, { recursive: true });
  await dialog.screenshot({ path: join(out, "password-change-desktop.png") });
  await dialog.getByRole("button", { name: "确认修改", exact: true }).click();
  await expect(page.getByRole("status")).toContainText("密码修改成功");
  await sshClosed;
  const sessions = server.store.db
    .prepare("SELECT id,status,reason FROM terminal_sessions WHERE actor_id=?")
    .all(user.id);
  assert.equal(sessions.length, 2);
  for (const s of sessions) {
    assert.equal(s.status, "INTERRUPTED");
    assert.equal(s.reason, "AUTHORIZATION_EXPIRED");
    const rec = (
      await api("GET", `/terminal-sessions/${s.id}/recording`)
    ).json();
    assert.ok(
      rec.events.some(
        (e) =>
          e.kind === "output" &&
          Buffer.from(e.data.data, "base64")
            .toString()
            .includes("PASSWORD_CHANGE_SESSION_READY"),
      ),
    );
  }
  assert.equal(
    server.store.db
      .prepare("SELECT count(*) n FROM user_sessions WHERE user_id=?")
      .get(user.id).n,
    0,
  );
  await login(page, "operator", oldPassword);
  await expect(page.getByRole("alert")).toContainText("凭据错误");
  await login(page, "operator", newPassword);
  await expect(
    page.getByRole("button", { name: "修改密码", exact: true }),
  ).toBeVisible();
  await assert.rejects(connectSSH(oldPassword));
  const fresh = await connectSSH(newPassword);
  fresh.end();
  assert.equal((await api("GET", "/me")).statusCode, 200);
  const mobile = await browser.newPage({
    viewport: { width: 390, height: 844 },
  });
  mobile.on("pageerror", (e) => errors.push(e.message));
  await login(mobile, "no-roles", oldPassword);
  await expect(
    mobile.getByText(
      "当前账号尚未分配操作权限，请联系管理员配置角色和设备范围。",
    ),
  ).toBeVisible();
  await mobile.getByRole("button", { name: "修改密码", exact: true }).click();
  await expect(mobile.getByRole("dialog")).toBeVisible();
  assert.equal(
    await mobile.evaluate(
      () => document.documentElement.scrollWidth > innerWidth,
    ),
    false,
  );
  await mobile
    .getByRole("dialog")
    .screenshot({ path: join(out, "password-change-mobile.png") });
  await mobile.keyboard.press("Escape");
  await expect(mobile.getByRole("dialog")).toHaveCount(0);
  await expect(
    mobile.getByRole("button", { name: "修改密码", exact: true }),
  ).toBeFocused();
  assert.deepEqual(errors, []);
  const result = {
    passed: true,
    trusted_https: true,
    wrong_password_preserves_login: true,
    confirmation_validation: true,
    new_password_web_and_ssh_login: true,
    old_password_rejected: true,
    own_web_and_ssh_terminals_revoked: true,
    recorded_output_preserved: true,
    other_user_session_preserved: true,
    no_role_account_entry: true,
    mobile_no_overflow: true,
    native_dialog_focus_and_escape: true,
    agent: "protocol double",
  };
  writeFileSync(
    join(out, "password-change.json"),
    JSON.stringify(result, null, 2) + "\n",
  );
  console.log(result);
} finally {
  for (const c of clients) c.end();
  await browser?.close();
  agent?.terminate();
  await server.close();
}
