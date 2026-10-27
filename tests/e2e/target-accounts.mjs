// Real Linux Agent + sudo authentication; isolated container, credentials and database.
import assert from "node:assert/strict";
import { spawn, execFileSync } from "node:child_process";
import { once } from "node:events";
import { mkdtempSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { join, resolve } from "node:path";
import { createRequire } from "node:module";
import { createServer as netServer } from "node:net";
import { randomUUID } from "node:crypto";
import { Credentials } from "../../apps/server/dist/credentials.js";
import { AccountAuthorizations } from "../../apps/server/dist/account-authorizations.js";
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
const testPrivilegeSettings = process.env.FLEET_TEST_TERMINAL_SETTINGS === "1";
const testSudoCommands = process.env.FLEET_TEST_SUDO_COMMANDS === "1";
const sockets = [],
  clients = [];
let started = false;
const extraContainers = [];
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
function archivedAccount(data) {
  const id = randomUUID();
  const {
    name,
    username,
    method,
    allowed_users = [],
    allowed_groups = [],
    allowed_roles = [],
    sudo_password,
  } = data;
  server.store.db
    .prepare(
      "INSERT INTO target_accounts(id,device_id,name,username,method,revision,allowed_users,secrets) VALUES(?,?,?,?,?,1,?,?)",
    )
    .run(
      id,
      device.id,
      name,
      username,
      method,
      JSON.stringify(allowed_users),
      new Credentials(server.store.dataDir, false).seal(
        id,
        sudo_password ? { sudo_password } : {},
      ),
    );
  for (const group of allowed_groups)
    server.store.db
      .prepare("INSERT INTO target_account_groups VALUES(?,?)")
      .run(id, group);
  for (const role of allowed_roles)
    server.store.db
      .prepare("INSERT INTO target_account_roles VALUES(?,?)")
      .run(id, role);
  new AccountAuthorizations(server.store.db).replaceLegacy(device.id, id, {
    allowed_users,
    allowed_groups,
    allowed_roles,
  });
  return {
    id,
    device_id: device.id,
    name,
    username,
    method,
    revision: 1,
    allowed_users,
    allowed_groups,
    allowed_roles,
  };
}
let device;
async function open(accountId, auth = admin) {
  const created = await api(
    "POST",
    "/terminal-sessions",
    {
      v: 1,
      device_id: device.id,
      ...(accountId ? { account_id: accountId } : {}),
      cols: 80,
      rows: 24,
    },
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
    FLEET_TERMINAL_ALLOW_PRIVILEGE_ESCALATION: testPrivilegeSettings
      ? "0"
      : "1",
    FLEET_HEARTBEAT_MS: "200",
  };
  for (const [key, value] of Object.entries(env))
    args.push("-e", `${key}=${value}`);
  args.push(
    "--entrypoint",
    "bash",
    process.env.FLEET_AGENT_DOCKER_IMAGE ?? "farhelm-agent-dev:local",
    "-c",
    `set -eu; printf 'fleet:${secret}\\n' | chpasswd; printf 'Defaults:fleet use_pty\\nfleet ALL=(ALL:ALL) ALL\\n' > /etc/sudoers.d/fleet-local-dev; chmod 440 /etc/sudoers.d/fleet-local-dev; mkdir -p /state; chmod 700 /state; cp /tls/ca.crt /state/ca.crt; chown -R fleet /state; exec runuser -u fleet -- /agent --worker`,
  );
  await docker(args);
  started = true;
  await until(async () => {
    device = (await api("GET", "/devices")).devices[0];
    return device?.control_online;
  }, "real Agent enrollment");
  if (testPrivilegeSettings) {
    const settingPath = `/devices/${device.id}/terminal-privilege`;
    await until(
      async () => (await api("GET", settingPath)).enabled === false,
      "Agent reports initial env-disabled state",
    );
    const { chromium } = await import("@playwright/test");
    const settingsBrowser = await chromium.launch({
      headless: true,
      channel: process.env.FLEET_TEST_BROWSER_CHANNEL ?? "msedge",
    });
    try {
      const settingsPage = await settingsBrowser.newPage({
        viewport: { width: 1440, height: 1000 },
      });
      await settingsPage.goto(origin);
      await settingsPage.getByLabel("账号", { exact: true }).fill("admin");
      await settingsPage
        .getByLabel("密码", { exact: true })
        .fill("accounts-e2e-login1");
      await settingsPage
        .getByRole("button", { name: "登录 →", exact: true })
        .click();
      const row = settingsPage
        .locator("tbody tr")
        .filter({ hasText: "accounts-linux" });
      await row.getByRole("button", { name: /^更多操作/ }).click();
      await settingsPage
        .getByRole("menuitem", { name: "接入配置", exact: true })
        .click();
      const panel = settingsPage.getByRole("dialog");
      await panel
        .getByRole("button", { name: "默认登录账号", exact: true })
        .click();
      const setting = panel.getByRole("region", { name: "Agent 终端提权" });
      const checkbox = setting.getByRole("checkbox", {
        name: "允许终端使用该账号已有的 sudo 权限",
      });
      await checkbox.waitFor();
      await until(
        async () => await checkbox.isEnabled(),
        "editable privilege checkbox",
      );
      assert.equal(await checkbox.isChecked(), false);
      await checkbox.check();
      await setting
        .getByRole("button", { name: "保存提权设置", exact: true })
        .click();
      await until(
        async () =>
          (await setting.getByRole("status").textContent()).includes(
            "实际状态：已启用",
          ),
        "browser acknowledged enable",
      );
      mkdirSync(join(root, ".test-output"), { recursive: true });
      await settingsPage.screenshot({
        path: join(root, ".test-output/terminal-privilege-desktop.png"),
        fullPage: true,
      });
      await settingsPage.setViewportSize({ width: 390, height: 844 });
      await settingsPage.screenshot({
        path: join(root, ".test-output/terminal-privilege-mobile.png"),
        fullPage: true,
      });
    } finally {
      await settingsBrowser.close();
    }
    assert.equal((await api("GET", settingPath)).enabled, true);
    await docker(["restart", container]);
    await until(
      async () =>
        (await api("GET", "/devices")).devices.some(
          (d) => d.id === device.id && d.control_online,
        ),
      "Agent reconnects after restart",
    );
    await until(async () => {
      const state = await api("GET", settingPath);
      return state.online && state.enabled === true && state.revision === 1;
    }, "web-enabled setting survives Agent restart and env-disabled default");
  }
  const operatorId = (await api("GET", "/me")).id;
  await api("POST", "/access-authorizations/sudo", {
    v: 1,
    device_id: device.id,
    subject_type: "user",
    subject_id: operatorId,
    effect: "allow",
    revision: 0,
  });
  // The everyday flow requires no target account or account authorization.
  const ordinary = await open(undefined, admin);
  await ordinary.ready();
  ordinary.send("printf '__NORMAL_UID__'; id -u\r");
  await until(
    () => /__NORMAL_UID__[1-9][0-9]*/.test(ordinary.text()),
    "normal remains non-root",
  );
  ordinary.send("exit\r");
  await until(
    () => ordinary.messages.some((m) => m.type === "terminal.closed"),
    "normal closed",
  );
  const removed = await fetch(origin + "/api/v1/terminal-sessions", {
    method: "POST",
    headers: {
      authorization: "Bearer " + admin,
      "content-type": "application/json",
    },
    body: JSON.stringify({
      v: 1,
      device_id: device.id,
      cols: 80,
      rows: 24,
      connection_mode: "root",
    }),
  });
  assert.equal(removed.status, 400);
  assert.equal((await removed.json()).error, "ROOT_CONNECTION_MODE_REMOVED");
  // No stored password: ordinary connections still work and sudo follows Linux policy.
  const noPassword = await open();
  await noPassword.ready();
  assert.equal(
    noPassword.messages.find((m) => m.type === "terminal.ready").body.sudo_auto,
    undefined,
  );
  noPassword.send('sudo -n -k true; printf "__NO_PASSWORD_EXIT__%s\\n" "$?"\r');
  await until(
    () => noPassword.text().includes("__NO_PASSWORD_EXIT__1"),
    "sudo requires a password",
  );
  noPassword.send("exit\r");
  await until(
    () => noPassword.messages.some((m) => m.type === "terminal.closed"),
    "no-password ordinary session closed",
  );
  const configPath = `/devices/${device.id}/connection`;
  let config = await api("PUT", configPath, {
    v: 1,
    revision: 0,
    sudo_password: secret,
  });
  if (testSudoCommands) {
    const normal = await open(undefined, admin);
    await normal.ready();
    assert.equal(
      normal.messages.find((m) => m.type === "terminal.ready").body.sudo_auto,
      true,
    );
    const uid = (
      await docker(["exec", "--user", "fleet", container, "id", "-u"])
    ).trim();
    normal.send("printf '__NORMAL_UID__'; id -u\r");
    await until(
      () => normal.text().includes("__NORMAL_UID__" + uid),
      "ordinary shell retains non-root UID",
    );
    for (const [marker, command] of [
      ["__AUTO_UID__", "sudo -k id -u"],
      ["__AUTO_REPEAT__", "sudo -k id -u"],
      ["__AUTO_SU__", "sudo -k su - -c 'id -u'"],
      ["__AUTO_ENV__", "SUDO_ASKPASS=/bin/echo sudo -k id -u"],
    ]) {
      normal.send(`printf '${marker}'; ${command}\r`);
      await until(() => normal.text().includes(marker + "0"), marker, 30000);
    }
    // Direct askpass calls are not sudo, even with the legitimate executable and socket.
    normal.send(
      "sudo -u root -S -n -k true; printf '__STDIN_MODE_EXIT__%s\\n' \"$?\"\r",
    );
    await until(
      () => normal.text().includes("__STDIN_MODE_EXIT__1"),
      "explicit stdin sudo retains native behavior",
    );
    normal.send(
      "printf '__SUDO_ARGUMENT__'; sudo -k printf '%s' -S; printf '\\n'\r",
    );
    await until(
      () => normal.text().includes("__SUDO_ARGUMENT__-S"),
      "command arguments remain unchanged",
    );
    normal.send(
      'timeout 3 env FLEET_SUDO_ASKPASS_SOCKET="$FLEET_SUDO_COMMAND_SOCKET" /agent; printf \'__ASKPASS_REJECTED__%s\\n\' "$?"\r',
    );
    await until(
      () => normal.text().includes("__ASKPASS_REJECTED__1"),
      "forged askpass rejected",
    );
    assert.equal(normal.text().includes(secret), false);
    normal.send("exit\r");
    await until(
      () => normal.messages.some((m) => m.type === "terminal.closed"),
      "ordinary delegated shell closed",
    );
    // With only the default account, the platform SSH gateway connects directly
    // as the ordinary user and delegates sudo through the same Agent channel.
    const ssh = new Client();
    clients.push(ssh);
    ssh.on("error", () => {});
    const sshReady = once(ssh, "ready");
    ssh.connect({
      host: "127.0.0.1",
      port: server.ssh.info().port,
      username: `admin:${device.id}`,
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
    await sshReady;
    const channel = await new Promise((resolve, reject) =>
      ssh.shell({ term: "xterm", cols: 80, rows: 24 }, (error, stream) =>
        error ? reject(error) : resolve(stream),
      ),
    );
    let sshText = "";
    channel.on("data", (chunk) => (sshText += chunk.toString()));
    await until(
      () => sshText.includes("fleet@"),
      "SSH ordinary connection without account menu",
    );
    assert.equal(sshText.includes("输入账号编号"), false);
    assert.equal(sshText.includes("以 root 连接"), false);
    channel.write(
      "printf '__SSH_NORMAL_UID__'; id -u; printf '__SSH_AUTO_UID__'; sudo -k id -u\r",
    );
    await until(
      () => sshText.includes("__SSH_AUTO_UID__0"),
      "SSH ordinary sudo delegation",
    );
    assert.ok(sshText.includes("__SSH_NORMAL_UID__" + uid));
    assert.equal(sshText.includes(secret), false);
    channel.write("exit\r");
    await once(channel, "close");
    ssh.end();
    // No sudo role: no wrapper or credential, despite the same device/account.
    const ordinary = server.store.seedUser({
      username: "no-sudo-delegation",
      password: "accounts-e2e-login1",
      role: "ops",
      deviceScope: [device.id],
    });
    const ordinaryAuth = (
      await api(
        "POST",
        "/login",
        { username: ordinary.username, password: "accounts-e2e-login1" },
        "",
      )
    ).access_token;
    const noGrant = await open(undefined, ordinaryAuth);
    await noGrant.ready();
    assert.equal(
      noGrant.messages.find((m) => m.type === "terminal.ready").body.sudo_auto,
      undefined,
    );
    noGrant.send(
      "printf '__NO_SUDO_CREDENTIAL__'; test -z \"$FLEET_SUDO_COMMAND_SOCKET\"; printf '%s\\n' \"$?\"\r",
    );
    await until(
      () => noGrant.text().includes("__NO_SUDO_CREDENTIAL__0"),
      "no sudo role gets no credential channel",
    );
    noGrant.send("sudo -n -k true; printf '__NO_GRANT_EXIT__%s\\n' \"$?\"\r");
    await until(
      () => noGrant.text().includes("__NO_GRANT_EXIT__1"),
      "password-required account cannot sudo without a grant",
    );
    noGrant.send("exit\r");
    await until(
      () => noGrant.messages.some((m) => m.type === "terminal.closed"),
      "ordinary role shell closed",
    );
    const role = (
      await api("POST", "/roles", {
        v: 1,
        name: "普通终端 sudo",
        description: "",
        permissions: ["devices.read", "terminal.connect", "terminal.sudo"],
      })
    ).role;
    const group = (
      await api("POST", "/groups", {
        v: 1,
        name: "普通终端 sudo 组",
        description: "",
        role_ids: [role.id],
        member_ids: [ordinary.id],
        device_scope: [],
      })
    ).group;
    await api("POST", "/access-authorizations/sudo", {
      v: 1,
      device_id: device.id,
      subject_type: "group",
      subject_id: group.id,
      effect: "allow",
      revision: 0,
    });
    const grantedAuth = (
      await api(
        "POST",
        "/login",
        { username: ordinary.username, password: "accounts-e2e-login1" },
        "",
      )
    ).access_token;
    const inherited = await open(undefined, grantedAuth);
    await inherited.ready();
    assert.equal(
      inherited.messages.find((m) => m.type === "terminal.ready").body
        .sudo_auto,
      true,
    );
    inherited.send("printf '__INHERITED_AUTO__'; sudo -k id -u\r");
    await until(
      () => inherited.text().includes("__INHERITED_AUTO__0"),
      "group inherited sudo delegation",
    );
    await api("DELETE", `/groups/${group.id}`, {
      v: 1,
      revision: group.revision,
    });
    await until(
      () => inherited.messages.some((m) => m.type === "terminal.closed"),
      "revoking inherited sudo closes the delegated terminal",
    );
    config = await api("PUT", configPath, {
      v: 1,
      revision: config.revision,
      sudo_password: "wrong-normal-fixture-password",
    });
    const wrong = await open(undefined, admin);
    await wrong.ready();
    wrong.send("sudo -k true; printf '__WRONG_AUTO_EXIT__%s\\n' \"$?\"\r");
    await until(
      () => wrong.text().includes("__WRONG_AUTO_EXIT__1"),
      "wrong ordinary sudo credential rejected",
      30000,
    );
    assert.equal(wrong.text().includes("wrong-normal-fixture-password"), false);
    wrong.send("exit\r");
    await until(
      () => wrong.messages.some((m) => m.type === "terminal.closed"),
      "wrong credential shell closed",
    );
    config = await api("PUT", configPath, {
      v: 1,
      revision: config.revision,
      sudo_password: secret,
    });
  }
  await docker([
    "exec",
    "--user",
    "root",
    container,
    "bash",
    "-c",
    "printf 'Defaults:fleet use_pty\nfleet ALL=(ALL:ALL) NOPASSWD: ALL\n' > /etc/sudoers.d/fleet-local-dev",
  ]);
  config = await api("PUT", configPath, {
    v: 1,
    revision: config.revision,
    sudo_password: null,
  });
  const passwordless = await open();
  await passwordless.ready();
  assert.equal(
    passwordless.messages.find((m) => m.type === "terminal.ready").body
      .sudo_auto,
    undefined,
  );
  passwordless.send(
    "printf '__ORDINARY_NOPASSWD_UID__'; id -u; printf '__NOPASSWD_UID__'; sudo -n -k id -u\r",
  );
  await until(
    () => passwordless.text().includes("__NOPASSWD_UID__0"),
    "ordinary terminal passwordless sudo",
  );
  assert.match(passwordless.text(), /__ORDINARY_NOPASSWD_UID__[1-9][0-9]*/);
  passwordless.send("exit\r");
  await until(
    () => passwordless.messages.some((m) => m.type === "terminal.closed"),
    "passwordless closed",
  );
  {
    // Kernel enforcement applies even after target sudoers becomes NOPASSWD.
    await api("POST", "/access-authorizations/sudo", {
      v: 1,
      device_id: device.id,
      subject_type: "user",
      subject_id: operatorId,
      effect: "deny",
      revision: 1,
    });
    const denied = await open();
    await denied.ready();
    assert.equal(
      denied.messages.find((m) => m.type === "terminal.ready").body
        .sudo_allowed,
      false,
    );
    denied.send(
      "grep '^NoNewPrivs:' /proc/self/status; /usr/bin/sudo -n -k id -u; printf '__DENIED_SUDO_EXIT__%s\\n' \"$?\"\r",
    );
    await until(
      () => denied.text().includes("__DENIED_SUDO_EXIT__1"),
      "explicit deny blocks absolute-path NOPASSWD sudo",
    );
    assert.match(denied.text(), /NoNewPrivs:\s+1/);
    denied.send("exit\r");
    await until(
      () => denied.messages.some((m) => m.type === "terminal.closed"),
      "restricted web closed",
    );
    const deniedSsh = new Client();
    clients.push(deniedSsh);
    deniedSsh.on("error", () => {});
    const deniedReady = once(deniedSsh, "ready");
    deniedSsh.connect({
      host: "127.0.0.1",
      port: server.ssh.info().port,
      username: `admin:${device.id}`,
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
      deniedSsh.shell({ term: "xterm", cols: 80, rows: 24 }, (error, stream) =>
        error ? reject(error) : resolve(stream),
      ),
    );
    let deniedText = "";
    deniedChannel.on("data", (chunk) => (deniedText += chunk.toString()));
    await until(() => deniedText.includes("fleet@"), "restricted SSH ready");
    deniedChannel.write(
      "/usr/bin/sudo -n -k id -u; printf '__SSH_DENIED__%s\\n' \"$?\"\r",
    );
    await until(
      () => deniedText.includes("__SSH_DENIED__1"),
      "SSH deny blocks NOPASSWD sudo",
    );
    deniedChannel.end();
    deniedSsh.end();
    await until(
      () =>
        server.store.db
          .prepare(
            "SELECT count(*) AS n FROM terminal_sessions WHERE ended_at IS NULL",
          )
          .get().n === 0,
      "restricted SSH closed",
    );
    await api("POST", "/access-authorizations/sudo", {
      v: 1,
      device_id: device.id,
      subject_type: "user",
      subject_id: operatorId,
      effect: "allow",
      revision: 2,
    });
  }
  assert.equal(
    server.store.db.prepare("SELECT count(*) AS n FROM target_accounts").get()
      .n,
    0,
  );
  const passwordlessAccount = archivedAccount({
    name: "免密 root 示例",
    username: "root",
    method: "sudo",
  });
  async function rejectAccount(accountId, auth = admin) {
    const before = server.store.db
      .prepare("SELECT COUNT(*) AS n FROM terminal_sessions")
      .get().n;
    const response = await fetch(origin + "/api/v1/terminal-sessions", {
      method: "POST",
      headers: {
        authorization: "Bearer " + auth,
        "content-type": "application/json",
      },
      body: JSON.stringify({
        v: 1,
        device_id: device.id,
        account_id: accountId,
        cols: 80,
        rows: 24,
      }),
    });
    assert.equal(response.status, 400);
    assert.equal((await response.json()).error, "ACCOUNT_CONNECTION_REMOVED");
    assert.equal(
      server.store.db
        .prepare("SELECT COUNT(*) AS n FROM terminal_sessions")
        .get().n,
      before,
    );
  }
  await rejectAccount(passwordlessAccount.id);
  const archiveSnapshot = () =>
    JSON.stringify(
      server.store.db
        .prepare("SELECT * FROM target_accounts ORDER BY id")
        .all(),
    );
  const archivedBefore = archiveSnapshot();
  for (const path of [
    `/devices/${device.id}/accounts`,
    `/devices/${device.id}/accounts/${passwordlessAccount.id}`,
  ])
    for (const method of ["GET", "POST", "PUT", "DELETE"]) {
      const response = await fetch(origin + "/api/v1" + path, {
        method,
        headers: {
          authorization: "Bearer " + admin,
          "content-type": "application/json",
        },
        ...(method === "GET"
          ? {}
          : { body: JSON.stringify({ v: 1, revision: 1, name: "Overwrite" }) }),
      });
      assert.equal(response.status, 410);
      assert.equal(
        (await response.json()).error,
        "ACCOUNT_CONFIGURATION_REMOVED",
      );
    }
  assert.equal(archiveSnapshot(), archivedBefore);
  await docker([
    "exec",
    "--user",
    "root",
    container,
    "bash",
    "-c",
    "printf 'Defaults:fleet use_pty\nfleet ALL=(ALL:ALL) ALL\n' > /etc/sudoers.d/fleet-local-dev",
  ]);
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
  const account = archivedAccount({
    name: "root via sudo",
    username: "root",
    method: "sudo",
    allowed_groups: [targetGroup.id],
    allowed_roles: [targetRole.id],
    sudo_password: secret,
  });
  assertValid("target-account", account);
  const legacyBefore = server.store.db
    .prepare("SELECT * FROM target_accounts WHERE id=?")
    .get(account.id);
  await rejectAccount(account.id);
  assert.deepEqual(
    server.store.db
      .prepare("SELECT * FROM target_accounts WHERE id=?")
      .get(account.id),
    legacyBefore,
  );
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
      `/devices/${device.id}/login-accounts`,
      undefined,
      auth,
    );
    assert.equal(visible.accounts.length, 1, principal.username);
    await rejectAccount(account.id, auth);
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
    await until(
      () => text.includes("fleet@"),
      "SSH ordinary shell with legacy accounts present",
    );
    assert.doesNotMatch(text, /输入账号编号|高级账号|以 root 连接/);
    channel.write("printf '__SSH_UID__'; id -u\r");
    await until(
      () => /__SSH_UID__[1-9][0-9]*/.test(text),
      "SSH remains the ordinary Linux user",
    );
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
  const grant = randomUUID();
  server.store.db
    .prepare(
      "INSERT INTO account_authorizations(id,device_id,account_id,user_id) VALUES(?,?,?,?)",
    )
    .run(grant, device.id, account.id, restricted.id);
  const retiredGrant = await fetch(origin + "/api/v1/access-authorizations", {
    method: "POST",
    headers: {
      authorization: "Bearer " + admin,
      "content-type": "application/json",
    },
    body: JSON.stringify({
      v: 1,
      device_id: device.id,
      account_ids: [account.id],
      subject_type: "user",
      subject_id: restricted.id,
    }),
  });
  assert.equal(retiredGrant.status, 400);
  assert.equal(
    (await retiredGrant.json()).error,
    "ACCOUNT_AUTHORIZATION_REMOVED",
  );
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
    [],
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
  await rejectAccount(account.id, restrictedAuth);
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
  let restrictedError = "";
  restrictedChannel.stderr.on("data", (b) => (restrictedError += b.toString()));
  await once(restrictedChannel, "close");
  assert.match(restrictedError, /unavailable/);
  assert.doesNotMatch(restrictedText, /输入账号编号|root@|高级账号/);
  const retiredDelete = await fetch(
    origin + `/api/v1/access-authorizations/${grant}`,
    {
      method: "DELETE",
      headers: {
        authorization: "Bearer " + admin,
        "content-type": "application/json",
      },
      body: JSON.stringify({ v: 1, revision: 1 }),
    },
  );
  assert.equal(retiredDelete.status, 410);
  assert.ok(
    server.store.db
      .prepare("SELECT 1 FROM account_authorizations WHERE id=?")
      .get(grant),
  );
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
  await rejectAccount(defaultLogin.id, defaultAuth);
  const defaultSession = await open(undefined, defaultAuth);
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
  const revocable = await open();
  await revocable.ready();
  revocable.send("printf '__ORDINARY_PID__'; echo $$; sleep 300 & wait\r");
  await until(
    () => /__ORDINARY_PID__(\d+)/.test(revocable.text()),
    "ordinary process identity",
  );
  const shellPid = revocable.text().match(/__ORDINARY_PID__(\d+)/)[1];
  await api("POST", "/logout", { v: 1 });
  await until(
    () => revocable.messages.some((m) => m.type === "terminal.closed"),
    "ordinary session revocation",
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
    "ordinary shell termination",
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
    if (testSudoCommands) {
      const current = await api("GET", configPath);
      await api("PUT", configPath, {
        v: 1,
        revision: current.revision,
        sudo_password: secret,
      });
      const pending = page.waitForResponse(
        (r) =>
          r.url().endsWith("/api/v1/terminal-sessions") &&
          r.request().method() === "POST",
      );
      await row.getByRole("button", { name: "连接终端", exact: true }).click();
      const created = await (await pending).json();
      const normal = page.getByRole("dialog", { name: /^终端：/ });
      await normal.getByText("sudo 自动代填已启用", { exact: true }).waitFor();
      await normal.locator("textarea.xterm-helper-textarea").focus();
      await page.keyboard.type("printf '__BROWSER_AUTO_SUDO__'; sudo -k id -u");
      await page.keyboard.press("Enter");
      await until(
        () =>
          server.store.db
            .prepare(
              "SELECT data FROM terminal_recordings WHERE session_id=? AND kind='output'",
            )
            .all(created.session_id)
            .map((r) =>
              Buffer.from(JSON.parse(r.data).data, "base64").toString(),
            )
            .join("")
            .includes("__BROWSER_AUTO_SUDO__0"),
        "browser ordinary sudo password delegation",
      );
      await page.screenshot({
        path: join(root, ".test-output/normal-sudo-desktop.png"),
        fullPage: true,
      });
      await normal
        .getByRole("button", { name: "关闭终端", exact: true })
        .click();
      await until(
        () =>
          server.store.db
            .prepare("SELECT ended_at FROM terminal_sessions WHERE id=?")
            .get(created.session_id).ended_at,
        "browser ordinary terminal closed",
      );
    }
    await row.getByRole("button", { name: /^更多操作/ }).click();
    assert.equal(
      await page
        .getByRole("menuitem", { name: /高级账号|选择已有账号/ })
        .count(),
      0,
    );
    assert.equal(
      await page
        .getByRole("button", { name: "以 root 连接", exact: true })
        .count(),
      0,
    );
    await page.screenshot({
      path: join(root, ".test-output/ordinary-connection-menu.png"),
      fullPage: true,
    });
    await page.keyboard.press("Escape");
    const request = page.waitForRequest(
      (r) =>
        r.url().endsWith("/api/v1/terminal-sessions") && r.method() === "POST",
    );
    await row.getByRole("button", { name: "连接终端", exact: true }).click();
    assert.equal((await request).postDataJSON().account_id, undefined);
    const terminal = page.getByRole("dialog", { name: /^终端：/ });
    await terminal.getByText("已连接", { exact: true }).waitFor();
    await terminal.locator("textarea.xterm-helper-textarea").focus();
    await page.keyboard.type("printf '__BROWSER_ORDINARY__'; id -u");
    await page.keyboard.press("Enter");
    await page.waitForFunction(() =>
      /__BROWSER_ORDINARY__[1-9][0-9]*/.test(
        document.querySelector(".xterm-rows")?.textContent ?? "",
      ),
    );
    await terminal
      .getByRole("button", { name: "关闭终端", exact: true })
      .click();
    await page.getByRole("button", { name: /访问控制/ }).click();
    await page
      .getByRole("button", { name: "设备访问授权", exact: true })
      .click();
    const authorization = page.getByRole("region", {
      name: "设备访问授权",
      exact: true,
    });
    await authorization
      .getByRole("button", { name: "新增连接授权", exact: true })
      .click();
    await authorization
      .getByLabel("授权对象类型", { exact: true })
      .selectOption("user");
    await authorization
      .getByLabel("授权对象", { exact: true })
      .selectOption(restricted.id);
    await authorization
      .getByLabel("设备", { exact: true })
      .selectOption(device.id);
    assert.equal(
      await authorization.locator('input[type="checkbox"]').count(),
      0,
    );
    assert.equal(
      await page
        .getByText("高级授权（兼容现有账号规则）", { exact: true })
        .count(),
      0,
    );
    assert.equal(
      await authorization.getByText("root via sudo", { exact: true }).count(),
      0,
    );
    const savedAuthorization = page.waitForResponse(
      (r) =>
        r.url().endsWith("/api/v1/access-authorizations") &&
        r.request().method() === "POST",
    );
    await authorization
      .getByRole("button", { name: "保存连接授权", exact: true })
      .click();
    const savedResponse = await savedAuthorization;
    assert.equal(savedResponse.request().postDataJSON().account_ids, undefined);
    const ordinaryRule = (await savedResponse.json()).rule_ids[0];
    await page.getByRole("button", { name: "权限核对", exact: true }).click();
    await page
      .getByLabel("核对用户", { exact: true })
      .selectOption(restricted.id);
    await page.getByText("允许使用", { exact: true }).waitFor();
    assert.equal(
      await page.getByText("root via sudo", { exact: true }).count(),
      0,
    );
    await page.screenshot({
      path: join(root, ".test-output/ordinary-authorization-inspection.png"),
      fullPage: true,
    });
    const restoredAuth = (
      await api(
        "POST",
        "/login",
        { username: restricted.username, password: "accounts-e2e-login1" },
        "",
      )
    ).access_token;
    const grantedOrdinary = await open(undefined, restoredAuth);
    await grantedOrdinary.ready();
    grantedOrdinary.send("printf '__ORDINARY_GRANT_UID__'; id -u\r");
    await until(
      () => /__ORDINARY_GRANT_UID__[1-9][0-9]*/.test(grantedOrdinary.text()),
      "ordinary authorization from browser form",
    );
    await api("DELETE", `/access-authorizations/${ordinaryRule}`, {
      v: 1,
      revision: 1,
    });
    await until(
      () => grantedOrdinary.messages.some((m) => m.type === "terminal.closed"),
      "ordinary authorization revoke closes real terminal",
    );
    await api("POST", "/logout", { v: 1 }, restoredAuth);
    assert.deepEqual(errors, []);
  }
  if (testPrivilegeSettings) {
    const settingPath = `/devices/${device.id}/terminal-privilege`;
    const before = await api("GET", settingPath);
    await api("PUT", settingPath, {
      v: 1,
      revision: before.revision,
      enabled: false,
    });
    await until(async () => {
      const state = await api("GET", settingPath);
      return state.enabled === false && state.status === "applied";
    }, "actual runtime disable");
    const denied = await fetch(origin + "/api/v1/terminal-sessions", {
      method: "POST",
      headers: {
        authorization: "Bearer " + admin,
        "content-type": "application/json",
      },
      body: JSON.stringify({
        v: 1,
        device_id: device.id,
        cols: 80,
        rows: 24,
        account_id: account.id,
      }),
    });
    assert.equal(denied.status, 400);
    assert.equal((await denied.json()).error, "ACCOUNT_CONNECTION_REMOVED");
    if (testSudoCommands) {
      const disabled = await open(undefined, admin);
      await disabled.ready();
      assert.equal(
        disabled.messages.find((m) => m.type === "terminal.ready").body
          .sudo_auto,
        undefined,
      );
      disabled.send(
        "printf '__DISABLED_NNP__'; sed -n 's/^NoNewPrivs:[[:space:]]*//p' /proc/$$/status\r",
      );
      await until(
        () => disabled.text().includes("__DISABLED_NNP__1"),
        "disabled switch keeps no_new_privs enforcement",
      );
      disabled.send("exit\r");
      await until(
        () => disabled.messages.some((m) => m.type === "terminal.closed"),
        "disabled ordinary terminal closed",
      );
    }
    const after = await api("GET", settingPath);
    await api("PUT", settingPath, {
      v: 1,
      revision: after.revision,
      enabled: true,
    });
    await until(async () => {
      const state = await api("GET", settingPath);
      return state.enabled === true && state.status === "applied";
    }, "actual runtime re-enable");
  }
  if (testPrivilegeSettings) {
    const enrollment = (
      await api("POST", "/enrollment-tokens", { v: 1, ttl_seconds: 600 })
    ).enrollment_token;
    const hardened = container + "-blocked";
    extraContainers.push(hardened);
    const hardenedArgs = [
      "run",
      "--detach",
      "--name",
      hardened,
      "--user",
      "0",
      "--security-opt",
      "no-new-privileges=true",
      "--mount",
      `type=bind,source=${binary},target=/agent,readonly`,
      "--mount",
      `type=bind,source=${tls},target=/tls,readonly`,
    ];
    for (const [key, value] of Object.entries({
      ...env,
      FLEET_ENROLLMENT_TOKEN: enrollment,
      FLEET_DEVICE_NAME: "settings-system-blocked",
      FLEET_TERMINAL_ALLOW_PRIVILEGE_ESCALATION: "0",
    }))
      hardenedArgs.push("-e", `${key}=${value}`);
    hardenedArgs.push(
      "--entrypoint",
      "bash",
      process.env.FLEET_AGENT_DOCKER_IMAGE ?? "farhelm-agent-dev:local",
      "-c",
      "set -eu; mkdir -m 700 /state; cp /tls/ca.crt /state/ca.crt; chown -R fleet /state; exec runuser -u fleet -- /agent --worker",
    );
    await docker(hardenedArgs);
    let blockedDevice;
    await until(async () => {
      blockedDevice = (await api("GET", "/devices")).devices.find(
        (d) => d.name === "settings-system-blocked",
      );
      return blockedDevice?.control_online;
    }, "hardened Agent online");
    const blockedPath = `/devices/${blockedDevice.id}/terminal-privilege`;
    await until(
      async () => (await api("GET", blockedPath)).blocked === true,
      "Agent reports inherited no_new_privs",
    );
    const result = await fetch(origin + "/api/v1" + blockedPath, {
      method: "PUT",
      headers: {
        authorization: "Bearer " + admin,
        "content-type": "application/json",
      },
      body: JSON.stringify({ v: 1, revision: 0, enabled: true }),
    });
    assert.equal(result.status, 409);
    assert.equal(
      (await result.json()).error,
      "TERMINAL_PRIVILEGE_NO_NEW_PRIVS",
    );
    assert.equal((await api("GET", blockedPath)).enabled, false);
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
        webTerminalPrivilege: testPrivilegeSettings,
        normalTerminalSudo: testSudoCommands,
        ordinaryConnectionAndRemovedRootMode: true,
        passwordlessSudo: true,
        missingPasswordPreservesOrdinaryConnection: true,
        usePty: true,
        webProtocol: true,
        sshDeviceSelectionConnectsOrdinary: true,
        groupAndRoleAuthorization: true,
        inheritedRoleAuthorization: true,
        unifiedDefaultAccount: true,
        defaultRevocationWebAndSsh: true,
        newRuleWithoutLegacyDeviceScope: true,
        selectedAccountDoesNotGrantDefault: true,
        noAdvancedAccountMenu: !!browser,
        wrongPasswordRejected: true,
        ordinarySessionRevocation: true,
        explicitAccountApiRemoved: true,
        accountConfigurationApiRemoved: true,
        ordinaryAuthorizationBrowserFlow: !!browser,
        archivedAuthorizationsHidden: true,
        realBrowser: !!browser,
        passwordAbsentFromRecordingsAndAudit: true,
      },
      null,
      2,
    ),
  );
  console.log(
    "Target accounts E2E passed: ordinary web/SSH connections without account menus, sudo delegation, ordinary authorization UI and retired account API rejection; wrong sudo password rejected; recordings and audit contain no password.",
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
  for (const name of extraContainers)
    await docker(["rm", "--force", name]).catch(() => {});
  if (started) await docker(["rm", "--force", container]);
  await server.close();
}
