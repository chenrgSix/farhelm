// Real Linux Agent + sudo authentication; isolated container, credentials and database.
import assert from "node:assert/strict";
import { spawn, execFileSync } from "node:child_process";
import { once } from "node:events";
import { mkdtempSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { join, resolve } from "node:path";
import { createRequire } from "node:module";
import { createServer as netServer } from "node:net";
import { buildServer } from "../../apps/server/dist/server.js";
import { assertValid } from "../contracts/validate.mjs";
const require = createRequire(import.meta.url);
const { WebSocket } = require("../../apps/server/node_modules/ws");
const { Client } = require("../../apps/server/node_modules/ssh2");
const root = resolve(import.meta.dirname, "../..");
const temp = mkdtempSync("/tmp/farhelm-accounts-");
const tls = join(temp, "tls"),
  container = `farhelm-accounts-${process.pid}`;
execFileSync("bash", [join(root, "deploy/dev/generate-tls.sh"), tls], {
  stdio: "ignore",
});
const ca = readFileSync(join(tls, "ca.crt"));
const probe = netServer();
await new Promise((resolve) => probe.listen(0, "127.0.0.1", resolve));
const webPort = probe.address().port;
await new Promise((resolve) => probe.close(resolve));
const origin = `http://127.0.0.1:${webPort}`;
const server = await buildServer({
  dataDir: join(temp, "server"),
  tlsCert: join(tls, "server.crt"),
  tlsKey: join(tls, "server.key"),
  adminUsername: "admin",
  adminPassword: "accounts-e2e-login1",
  ssh: { host: "127.0.0.1", port: 0 },
  webDist: join(root, "apps/web/dist"),
  separateListeners: true,
  webProtocol: "http",
  consoleOrigin: origin,
});
await server.app.listen({ host: "127.0.0.1", port: 0 });
await server.configureWeb(
  { host: "127.0.0.1", port: webPort, enabled: true, protocol: "http" },
  origin,
);
const port = server.app.server.address().port;
const secret = "Public-fixture-sudo9!";
const sockets = [],
  clients = [];
let started = false;
let browser;
async function docker(args) {
  return new Promise((resolve, reject) => {
    const p = spawn("docker", args, { stdio: ["ignore", "pipe", "pipe"] });
    let out = "";
    p.stdout.on("data", (b) => (out += b));
    p.stderr.on("data", (b) => (out += b));
    p.on("error", reject);
    p.on("exit", (code) => (code === 0 ? resolve(out) : reject(Error(out))));
  });
}
async function until(fn, label, timeout = 15000) {
  const end = Date.now() + timeout;
  while (Date.now() < end) {
    if (await fn()) return;
    await new Promise((r) => setTimeout(r, 30));
  }
  throw Error("Timed out: " + label);
}
let admin;
async function api(method, path, payload, auth = admin) {
  const r = await fetch(origin + "/api/v1" + path, {
    method,
    body: payload === undefined ? undefined : JSON.stringify(payload),
    headers: {
      ...(auth ? { authorization: "Bearer " + auth } : {}),
      ...(payload === undefined ? {} : { "content-type": "application/json" }),
    },
  });
  const data = await r.json();
  assert.equal(r.status, 200, JSON.stringify(data));
  return data;
}
let device;
async function open(accountId, auth = admin) {
  const created = await api(
    "POST",
    "/terminal-sessions",
    { v: 1, device_id: device.id, account_id: accountId, cols: 80, rows: 24 },
    auth,
  );
  const ws = new WebSocket(
    origin.replace("http:", "ws:") + "/api/v1/terminal/ws",
    { ca, headers: { origin } },
  );
  sockets.push(ws);
  const messages = [];
  let output = "";
  ws.on("message", (raw) => {
    const m = JSON.parse(raw);
    assertValid("terminal-envelope", m);
    messages.push(m);
    if (m.type === "terminal.output")
      output += Buffer.from(m.body.data, "base64").toString();
  });
  ws.on("error", () => {});
  await once(ws, "open");
  ws.send(
    JSON.stringify({
      v: 1,
      type: "terminal.attach",
      body: { session_id: created.session_id, ticket: created.ticket },
    }),
  );
  const send = (text) =>
    ws.send(
      JSON.stringify({
        v: 1,
        type: "terminal.input",
        body: { data: Buffer.from(text).toString("base64") },
      }),
    );
  return {
    ws,
    created,
    messages,
    send,
    text: () => output,
    async ready() {
      await until(
        () =>
          messages.some(
            (m) => m.type === "terminal.ready" || m.type === "terminal.closed",
          ),
        "sudo handshake",
      );
      assert.ok(
        messages.some((m) => m.type === "terminal.ready"),
        JSON.stringify(messages),
      );
    },
  };
}
try {
  admin = (
    await api("POST", "/login", {
      username: "admin",
      password: "accounts-e2e-login1",
    })
  ).access_token;
  const enrollment = (
    await api("POST", "/enrollment-tokens", { v: 1, ttl_seconds: 600 })
  ).enrollment_token;
  const binary =
    process.env.FLEET_AGENT_BIN ??
    join(root, ".dev/linux-target/debug/farhelm-agent");
  const args = [
    "run",
    "--detach",
    "--name",
    container,
    "--user",
    "0",
    "--mount",
    `type=bind,source=${binary},target=/agent,readonly`,
    "--mount",
    `type=bind,source=${tls},target=/tls,readonly`,
  ];
  const env = {
    FLEET_SERVER_URL: `https://host.docker.internal:${port}`,
    FLEET_CA_CERT: "/state/ca.crt",
    FLEET_STATE_DIR: "/state",
    FLEET_ENROLLMENT_TOKEN: enrollment,
    FLEET_DEVICE_NAME: "accounts-linux",
    FLEET_EXECUTION_BACKEND: "same-uid",
    FLEET_TERMINAL_ALLOW_PRIVILEGE_ESCALATION: "1",
    FLEET_HEARTBEAT_MS: "200",
  };
  for (const [key, value] of Object.entries(env))
    args.push("-e", `${key}=${value}`);
  args.push(
    "--entrypoint",
    "bash",
    process.env.FLEET_AGENT_DOCKER_IMAGE ?? "farhelm-agent-dev:local",
    "-c",
    `set -eu; printf 'fleet:${secret}\\n' | chpasswd; printf 'Defaults:fleet use_pty\\nfleet ALL=(ALL:ALL) ALL\\n' > /etc/sudoers.d/fleet-local-dev; chmod 440 /etc/sudoers.d/fleet-local-dev; mkdir -m 700 /state; cp /tls/ca.crt /state/ca.crt; chown -R fleet /state; exec runuser -u fleet -- /agent --worker`,
  );
  await docker(args);
  started = true;
  await until(async () => {
    device = (await api("GET", "/devices")).devices[0];
    return device?.control_online;
  }, "real Agent enrollment");
  const principals = ["group-member", "direct-role", "inherited-role"].map(
    (username) =>
      server.store.seedUser({
        username,
        password: "accounts-e2e-login1",
        role: "ops",
        deviceScope: [device.id],
      }),
  );
  const targetRole = (
    await api("POST", "/roles", {
      v: 1,
      name: "目标账号运维角色",
      description: "",
      permissions: ["devices.read", "terminal.connect", "terminal.sudo"],
    })
  ).role;
  const sourceRole = (
    await api("POST", "/roles", {
      v: 1,
      name: "源账号权限",
      description: "",
      permissions: ["devices.read", "terminal.connect", "terminal.sudo"],
    })
  ).role;
  const targetGroup = (
    await api("POST", "/groups", {
      v: 1,
      name: "目标账号运维组",
      description: "",
      role_ids: [sourceRole.id],
      member_ids: [principals[0].id],
      device_scope: [],
    })
  ).group;
  await api("POST", "/groups", {
    v: 1,
    name: "角色继承组",
    description: "",
    role_ids: [targetRole.id],
    member_ids: [principals[2].id],
    device_scope: [],
  });
  server.store.db
    .prepare("INSERT INTO user_roles(user_id,role_id) VALUES(?,?)")
    .run(principals[1].id, targetRole.id);
  const account = (
    await api("POST", `/devices/${device.id}/accounts`, {
      v: 1,
      name: "root via sudo",
      username: "root",
      method: "sudo",
      allowed_users: [],
      allowed_groups: [targetGroup.id],
      allowed_roles: [targetRole.id],
      sudo_password: secret,
    })
  ).account;
  assertValid("target-account", account);
  const session = await open(account.id);
  await session.ready();
  assert.deepEqual(
    session.messages.find((m) => m.type === "terminal.ready").body,
    { backend: "agent", elevated: true, username: "root" },
  );
  session.send("printf '__UID__'; id -u; printf '__USER__'; whoami\r");
  await until(
    () =>
      session.text().includes("__UID__0") &&
      session.text().includes("__USER__root"),
    "actual root identity",
  );
  session.send("exit\r");
  await until(
    () => session.messages.some((m) => m.type === "terminal.closed"),
    "root shell exit",
  );
  assert.equal(
    session.messages.find((m) => m.type === "terminal.closed").body.reason,
    "SHELL_EXIT",
  );
  const recording = await api(
    "GET",
    `/terminal-sessions/${session.created.session_id}/recording?after=0`,
  );
  assert.equal(JSON.stringify(recording).includes(secret), false);
  assert.equal(session.text().includes(secret), false);
  const update = {
    v: 1,
    revision: account.revision,
    name: account.name,
    username: "root",
    method: "sudo",
    allowed_users: [],
    sudo_password: "wrong-fixture-password",
  };
  const bad = (
    await api("PUT", `/devices/${device.id}/accounts/${account.id}`, update)
  ).account;
  const rejected = await open(account.id);
  await until(
    () => rejected.messages.some((m) => m.type === "terminal.closed"),
    "wrong password rejection",
    20000,
  );
  assert.equal(
    rejected.messages.some((m) => m.type === "terminal.ready"),
    false,
  );
  assert.equal(
    rejected.messages.find((m) => m.type === "terminal.closed").body.reason,
    "SUDO_AUTH_FAILED",
  );
  await api("PUT", `/devices/${device.id}/accounts/${account.id}`, {
    ...update,
    revision: bad.revision,
    sudo_password: secret,
  });
  for (const principal of principals) {
    const auth = (
      await api(
        "POST",
        "/login",
        { username: principal.username, password: "accounts-e2e-login1" },
        "",
      )
    ).access_token;
    const visible = await api(
      "GET",
      `/devices/${device.id}/accounts`,
      undefined,
      auth,
    );
    assert.equal(visible.accounts.length, 1, principal.username);
    const granted = await open(account.id, auth);
    await granted.ready();
    granted.send("printf '__GRANT_UID__'; id -u\r");
    await until(
      () => granted.text().includes("__GRANT_UID__0"),
      principal.username + " web root shell",
    );
    granted.send("exit\r");
    await until(
      () => granted.messages.some((m) => m.type === "terminal.closed"),
      "granted shell exit",
    );
    await api("POST", "/logout", { v: 1 }, auth);
  }
  for (const principal of principals) {
    const ssh = new Client();
    clients.push(ssh);
    ssh.on("error", () => {});
    const ready = once(ssh, "ready");
    ssh.connect({
      host: "127.0.0.1",
      port: server.ssh.info().port,
      username: principal.username,
      password: "accounts-e2e-login1",
      hostVerifier: (raw) =>
        "SHA256:" +
          require("node:crypto")
            .createHash("sha256")
            .update(raw)
            .digest("base64")
            .replace(/=+$/, "") ===
        server.ssh.info().fingerprint,
    });
    await ready;
    const channel = await new Promise((resolve, reject) =>
      ssh.shell({ term: "xterm", cols: 80, rows: 24 }, (e, c) =>
        e ? reject(e) : resolve(c),
      ),
    );
    let text = "";
    channel.on("data", (b) => (text += b.toString()));
    await until(() => text.includes("输入设备编号"), "SSH device menu");
    channel.write("1\r");
    await until(() => text.includes("输入账号编号"), "SSH account menu");
    channel.write("2\r");
    await until(() => text.includes("root@"), "SSH sudo shell");
    channel.write("printf '__SSH_UID__'; id -u\r");
    await until(() => text.includes("__SSH_UID__0"), "SSH real root identity");
    assert.equal(text.includes(secret), false);
    channel.write("exit\r");
    await once(channel, "close");
    ssh.end();
  }
  // New resource grants work without legacy device scope and never grant the default account.
  const restricted = server.store.seedUser({
    username: "rule-only-user",
    password: "accounts-e2e-login1",
    role: "ops",
    deviceScope: [],
  });
  server.store.db
    .prepare("INSERT INTO user_roles(user_id,role_id) VALUES(?,?)")
    .run(restricted.id, targetRole.id);
  const grant = (
    await api("POST", "/access-authorizations", {
      v: 1,
      device_id: device.id,
      account_ids: [account.id],
      subject_type: "user",
      subject_id: restricted.id,
    })
  ).rule_ids[0];
  const restrictedAuth = (
    await api(
      "POST",
      "/login",
      { username: restricted.username, password: "accounts-e2e-login1" },
      "",
    )
  ).access_token;
  const unified = await api(
    "GET",
    `/devices/${device.id}/login-accounts`,
    undefined,
    restrictedAuth,
  );
  assert.deepEqual(
    unified.accounts.map((a) => a.id),
    [account.id],
  );
  const implicit = await fetch(origin + "/api/v1/terminal-sessions", {
    method: "POST",
    headers: {
      authorization: "Bearer " + restrictedAuth,
      "content-type": "application/json",
    },
    body: JSON.stringify({ v: 1, device_id: device.id, cols: 80, rows: 24 }),
  });
  assert.equal(
    implicit.status,
    403,
    "omitting account_id cannot access default account",
  );
  const restrictedWeb = await open(account.id, restrictedAuth);
  await restrictedWeb.ready();
  restrictedWeb.send("printf '__RULE_UID__'; id -u\r");
  await until(
    () => restrictedWeb.text().includes("__RULE_UID__0"),
    "new access rule real root shell",
  );
  restrictedWeb.send("exit\r");
  await until(
    () => restrictedWeb.messages.some((m) => m.type === "terminal.closed"),
    "rule shell exit",
  );
  const restrictedSsh = new Client();
  clients.push(restrictedSsh);
  restrictedSsh.on("error", () => {});
  const restrictedReady = once(restrictedSsh, "ready");
  restrictedSsh.connect({
    host: "127.0.0.1",
    port: server.ssh.info().port,
    username: restricted.username + ":" + device.id,
    password: "accounts-e2e-login1",
    hostVerifier: (raw) =>
      "SHA256:" +
        require("node:crypto")
          .createHash("sha256")
          .update(raw)
          .digest("base64")
          .replace(/=+$/, "") ===
      server.ssh.info().fingerprint,
  });
  await restrictedReady;
  const restrictedChannel = await new Promise((resolve, reject) =>
    restrictedSsh.shell({ term: "xterm", cols: 80, rows: 24 }, (e, c) =>
      e ? reject(e) : resolve(c),
    ),
  );
  let restrictedText = "";
  restrictedChannel.on("data", (b) => (restrictedText += b.toString()));
  await until(
    () => restrictedText.includes("root@"),
    "SSH automatically selects the sole authorized account",
  );
  restrictedChannel.write("printf '__RULE_SSH_UID__'; id -u\r");
  await until(
    () => restrictedText.includes("__RULE_SSH_UID__0"),
    "SSH new rule actual root identity",
  );
  const restrictedClosed = once(restrictedChannel, "close");
  await api("DELETE", `/access-authorizations/${grant}`, { v: 1, revision: 1 });
  await restrictedClosed;
  restrictedSsh.end();
  await api("POST", "/logout", { v: 1 }, restrictedAuth);
  // Existing default access remains until its visible compatibility rule is explicitly removed.
  const defaultOnly = server.store.seedUser({
    username: "default-only-user",
    password: "accounts-e2e-login1",
    role: "ops",
    deviceScope: [device.id],
  });
  const defaultAuth = (
    await api(
      "POST",
      "/login",
      { username: defaultOnly.username, password: "accounts-e2e-login1" },
      "",
    )
  ).access_token;
  const defaultLogin = (
    await api(
      "GET",
      `/devices/${device.id}/login-accounts`,
      undefined,
      defaultAuth,
    )
  ).accounts.find((a) => a.is_default);
  assert.ok(defaultLogin);
  const defaultSession = await open(defaultLogin.id, defaultAuth);
  await defaultSession.ready();
  defaultSession.send("printf '__DEFAULT_UID__'; id -u\r");
  await until(
    () => /__DEFAULT_UID__(\d+)/.test(defaultSession.text()),
    "default real Agent account",
  );
  assert.notEqual(defaultSession.text().match(/__DEFAULT_UID__(\d+)/)[1], "0");
  const compatibility = (await api("GET", "/access-authorizations")).rules.find(
    (r) =>
      r.account_id === defaultLogin.id && r.subject_type === "device_scope",
  );
  await api("DELETE", `/access-authorizations/${compatibility.id}`, {
    v: 1,
    revision: compatibility.revision,
  });
  await until(
    () => defaultSession.messages.some((m) => m.type === "terminal.closed"),
    "default authorization revokes live terminal",
  );
  assert.deepEqual(
    (
      await api(
        "GET",
        `/devices/${device.id}/login-accounts`,
        undefined,
        defaultAuth,
      )
    ).accounts,
    [],
  );
  const deniedDefault = await fetch(origin + "/api/v1/terminal-sessions", {
    method: "POST",
    headers: {
      authorization: "Bearer " + defaultAuth,
      "content-type": "application/json",
    },
    body: JSON.stringify({
      v: 1,
      device_id: device.id,
      account_id: defaultLogin.id,
      cols: 80,
      rows: 24,
    }),
  });
  assert.equal(deniedDefault.status, 403);
  const deniedSsh = new Client();
  clients.push(deniedSsh);
  deniedSsh.on("error", () => {});
  const deniedReady = once(deniedSsh, "ready");
  deniedSsh.connect({
    host: "127.0.0.1",
    port: server.ssh.info().port,
    username: defaultOnly.username + ":" + device.id,
    password: "accounts-e2e-login1",
    hostVerifier: (raw) =>
      "SHA256:" +
        require("node:crypto")
          .createHash("sha256")
          .update(raw)
          .digest("base64")
          .replace(/=+$/, "") ===
      server.ssh.info().fingerprint,
  });
  await deniedReady;
  const deniedChannel = await new Promise((resolve, reject) =>
    deniedSsh.shell({ term: "xterm", cols: 80, rows: 24 }, (e, c) =>
      e ? reject(e) : resolve(c),
    ),
  );
  let deniedText = "";
  deniedChannel.stderr.on("data", (b) => (deniedText += b.toString()));
  deniedChannel.resume();
  let deniedTimeout;
  try {
    await Promise.race([
      once(deniedChannel, "close"),
      new Promise((_, reject) => {
        deniedTimeout = setTimeout(
          () => reject(Error("SSH denied channel did not close")),
          15000,
        );
      }),
    ]);
  } finally {
    clearTimeout(deniedTimeout);
  }

  assert.ok(deniedText.includes("unavailable"));
  deniedSsh.end();
  await api("POST", "/access-authorizations", {
    v: 1,
    device_id: device.id,
    account_ids: [defaultLogin.id],
    subject_type: "device_scope",
    subject_id: null,
  });
  await api("POST", "/logout", { v: 1 }, defaultAuth);
  const revocable = await open(account.id);
  await revocable.ready();
  revocable.send("printf '__ROOT_PID__'; echo $$; sleep 300 & wait\r");
  await until(
    () => /__ROOT_PID__(\d+)/.test(revocable.text()),
    "root process identity",
  );
  const shellPid = revocable.text().match(/__ROOT_PID__(\d+)/)[1];
  await api("POST", "/logout", { v: 1 });
  await until(
    () => revocable.messages.some((m) => m.type === "terminal.closed"),
    "root session revocation",
  );
  assert.equal(
    revocable.messages.find((m) => m.type === "terminal.closed").body.reason,
    "USER_LOGOUT",
  );
  await until(
    async () =>
      (await docker([
        "exec",
        container,
        "sh",
        "-c",
        `if test -d /proc/${shellPid}; then printf alive; fi`,
      ])) === "",
    "privileged shell termination",
  );
  admin = (
    await api(
      "POST",
      "/login",
      { username: "admin", password: "accounts-e2e-login1" },
      "",
    )
  ).access_token;
  mkdirSync(join(root, ".test-output"), { recursive: true });
  if (process.env.FLEET_TEST_BROWSER_CHANNEL) {
    const { chromium } = await import("@playwright/test");
    browser = await chromium.launch({
      headless: true,
      channel: process.env.FLEET_TEST_BROWSER_CHANNEL,
    });
    const page = await browser.newPage({
      viewport: { width: 1440, height: 1000 },
    });
    const errors = [];
    page.on("pageerror", (e) => errors.push(String(e)));
    await page.goto(origin);
    await page.getByLabel("账号", { exact: true }).fill("admin");
    await page.getByLabel("密码", { exact: true }).fill("accounts-e2e-login1");
    await page.getByRole("button", { name: "登录 →", exact: true }).click();
    await page
      .getByRole("heading", { name: "设备总览", exact: true })
      .waitFor();
    const row = page.locator("tbody tr").filter({ hasText: "accounts-linux" });
    await row.getByRole("button", { name: /^更多操作/ }).click();
    await page.getByRole("menuitem", { name: "登录账号", exact: true }).click();
    const management = page.getByRole("dialog", { name: /登录账号管理/ });
    await management
      .getByRole("button", { name: "新增登录账号", exact: true })
      .click();
    await management
      .getByLabel("账号名称", { exact: true })
      .fill("浏览器 root");
    await management
      .getByLabel("源账号的 sudo 密码", { exact: true })
      .fill(secret);
    await management
      .getByRole("button", { name: "保存登录账号", exact: true })
      .click();
    await management.getByRole("status").waitFor();
    assert.equal(
      await management.locator("form").count(),
      0,
      "secret form is closed and cleared after save",
    );
    const configured = (
      await api("GET", `/devices/${device.id}/accounts`)
    ).accounts.find((a) => a.name === "浏览器 root");
    assert.deepEqual(configured.allowed_groups, []);
    await management
      .getByRole("button", { name: "管理访问授权", exact: true })
      .click();
    await page
      .getByRole("heading", { name: "访问控制", exact: true })
      .waitFor();
    for (const [kind, id] of [
      ["group", targetGroup.id],
      ["role", targetRole.id],
    ]) {
      await page
        .getByRole("button", { name: "新增访问授权", exact: true })
        .click();
      const form = page.locator("form.authorization-form");
      await form.getByLabel("授权对象类型", { exact: true }).selectOption(kind);
      await form.getByLabel("授权对象", { exact: true }).selectOption(id);
      await form.getByRole("checkbox", { name: /浏览器 root/ }).check();
      await form
        .getByRole("button", { name: "保存访问授权", exact: true })
        .click();
      await form.waitFor({ state: "detached" });
    }
    const granted = (
      await api("GET", `/devices/${device.id}/accounts`)
    ).accounts.find((a) => a.id === configured.id);
    assert.deepEqual(granted.allowed_groups, [targetGroup.id]);
    assert.deepEqual(granted.allowed_roles, [targetRole.id]);
    await page.screenshot({
      path: join(root, ".test-output/target-accounts-desktop.png"),
      fullPage: true,
    });
    await page.setViewportSize({ width: 390, height: 844 });
    assert.ok(
      await page.locator("section.authorizations-panel").evaluate((el) => {
        const r = el.getBoundingClientRect();
        return r.left >= 0 && r.right <= innerWidth;
      }),
    );
    await page.screenshot({
      path: join(root, ".test-output/target-accounts-mobile.png"),
      fullPage: true,
    });
    await page.setViewportSize({ width: 1440, height: 1000 });
    await page.getByRole("button", { name: "权限核对", exact: true }).click();
    await page
      .getByLabel("核对用户", { exact: true })
      .selectOption(principals[1].id);
    await page
      .locator("section.authorizations-panel")
      .getByText("浏览器 root", { exact: true })
      .waitFor();
    await page.screenshot({
      path: join(root, ".test-output/access-effective-desktop.png"),
      fullPage: true,
    });
    await page.getByRole("button", { name: "设备总览", exact: true }).click();
    await row.getByRole("button", { name: /^更多操作/ }).click();
    await page.getByRole("menuitem", { name: "登录账号", exact: true }).click();
    const refreshedManagement = page.getByRole("dialog", {
      name: /登录账号管理/,
    });
    await refreshedManagement
      .locator(".account-row")
      .filter({ hasText: "浏览器 root" })
      .getByRole("button", { name: "编辑", exact: true })
      .click();
    assert.equal(
      await refreshedManagement
        .getByLabel("源账号的 sudo 密码", { exact: true })
        .inputValue(),
      "",
    );
    assert.equal(
      await refreshedManagement.getByRole("checkbox").count(),
      0,
      "credential form contains no access-grant controls",
    );
    await refreshedManagement
      .getByRole("button", { name: "关闭账号窗口", exact: true })
      .click();
    await row.getByRole("button", { name: "连接终端", exact: true }).click();
    const picker = page.getByRole("dialog", { name: /选择登录账号/ });
    const createdPromise = page.waitForResponse(
      (r) =>
        r.url().endsWith("/api/v1/terminal-sessions") &&
        r.request().method() === "POST",
    );
    await picker
      .locator(".account-row")
      .filter({ hasText: "浏览器 root" })
      .getByRole("button", { name: "连接", exact: true })
      .click();
    const created = await (await createdPromise).json();
    const terminal = page.getByRole("dialog", { name: /^终端：/ });
    await terminal.getByText("已连接 · root", { exact: true }).waitFor();
    await terminal.locator("textarea.xterm-helper-textarea").focus();
    await page.keyboard.type("printf '__BROWSER_UID__'; id -u");
    await page.keyboard.press("Enter");
    await until(
      () =>
        server.store.db
          .prepare(
            "SELECT data FROM terminal_recordings WHERE session_id=? AND kind='output'",
          )
          .all(created.session_id)
          .map((r) => Buffer.from(JSON.parse(r.data).data, "base64").toString())
          .join("")
          .includes("__BROWSER_UID__0"),
      "real browser root command",
    );
    await terminal
      .getByRole("button", { name: "关闭终端", exact: true })
      .click();
    await until(
      () =>
        server.store.db
          .prepare("SELECT ended_at FROM terminal_sessions WHERE id=?")
          .get(created.session_id).ended_at,
      "browser terminal close",
    );
    assert.deepEqual(errors, []);
  }
  const audit = await api("GET", "/audit");
  for (const entry of audit.audit ?? []) assertValid("audit", entry);
  assert.equal(
    JSON.stringify(
      server.store.db.prepare("SELECT * FROM audit").all(),
    ).includes(secret),
    false,
  );
  assert.equal(
    JSON.stringify(
      server.store.db.prepare("SELECT * FROM terminal_recordings").all(),
    ).includes(secret),
    false,
  );
  mkdirSync(join(root, ".test-output"), { recursive: true });
  writeFileSync(
    join(root, ".test-output/target-accounts-e2e.json"),
    JSON.stringify(
      {
        passed: true,
        realLinux: true,
        realSudo: true,
        usePty: true,
        webProtocol: true,
        sshDeviceAndAccountMenu: true,
        groupAndRoleAuthorization: true,
        inheritedRoleAuthorization: true,
        unifiedDefaultAccount: true,
        defaultRevocationWebAndSsh: true,
        newRuleWithoutLegacyDeviceScope: true,
        selectedAccountDoesNotGrantDefault: true,
        effectiveAuthorizationView: !!browser,
        wrongPasswordRejected: true,
        rootSessionRevocation: true,
        realBrowser: !!browser,
        passwordAbsentFromRecordingsAndAudit: true,
      },
      null,
      2,
    ),
  );
  console.log(
    "Target accounts E2E passed: actual root shell via browser protocol and SSH menus; wrong password rejected; recordings and audit contain no password.",
  );
} catch (error) {
  if (started)
    console.error(
      await docker(["logs", container]).catch(() => "Agent log unavailable"),
    );
  throw error;
} finally {
  await browser?.close();
  for (const ws of sockets) ws.terminate();
  for (const client of clients) client.destroy();
  if (started) await docker(["rm", "--force", container]);
  await server.close();
}
