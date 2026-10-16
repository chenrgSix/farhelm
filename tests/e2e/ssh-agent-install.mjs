import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { assertValid } from "../contracts/validate.mjs";

// Called with a live OpenSSH -> platform -> target session, on an isolated fixture only.
export async function installOnSshDevice(c) {
  const {
    page,
    server,
    token,
    device,
    api,
    cli,
    output,
    until,
    container,
    temp,
    out,
    steps,
    recordingId,
    recording,
    text,
  } = c;
  const db = server.store.db;
  async function post(path, body, auth = token) {
    const r = await server.app.inject({
      method: "POST",
      url: "/api/v1" + path,
      payload: body,
      headers: { authorization: "Bearer " + auth },
    });
    assert.equal(r.statusCode, 200, r.body);
    return r.json();
  }
  async function run(args) {
    const child = spawn("docker", args, { stdio: ["ignore", "pipe", "pipe"] });
    let output = "";
    for (const stream of [child.stdout, child.stderr])
      stream.on("data", (data) => {
        output += data.toString();
      });
    return new Promise((resolve, reject) => {
      child.on("error", reject);
      child.on("exit", (code) => resolve({ code, output }));
    });
  }
  const beforeConnection = db
    .prepare("SELECT * FROM device_connections WHERE device_id=?")
    .get(device.id);
  db.prepare(
    "INSERT INTO device_groups(id,name,description,created_at,updated_at) VALUES('production','Production','',1,1)",
  ).run();
  db.prepare(
    "INSERT INTO device_group_members(device_id,group_id) VALUES(?,'production')",
  ).run(device.id);
  server.store.seedUser({
    username: "scoped",
    password: "scoped-install-test-password1",
    role: "ops",
    deviceScope: [],
  });
  const userId = db
    .prepare("SELECT id FROM users WHERE username='scoped'")
    .get().id;
  db.prepare(
    "INSERT INTO access_groups(id,name,description,device_scope,created_at,updated_at) VALUES('operations','Operations','',?,1,1)",
  ).run(JSON.stringify([device.id]));
  db.prepare("INSERT INTO group_roles VALUES('operations','ops')").run();
  db.prepare("INSERT INTO group_members VALUES('operations',?)").run(userId);
  const scoped = await post("/login", {
    username: "scoped",
    password: "scoped-install-test-password1",
  });
  const scopedDevices = async () =>
    (
      await server.app.inject({
        method: "GET",
        url: "/api/v1/devices",
        headers: { authorization: "Bearer " + scoped.access_token },
      })
    ).json().devices;
  assert.equal((await scopedDevices())[0].id, device.id);
  const originalUser = db.prepare("SELECT * FROM users WHERE id=?").get(userId);
  const expired = await post("/agent-installations", {
    v: 1,
    device_id: device.id,
  });
  db.prepare(
    "UPDATE enrollment_tokens SET expires_at=1 WHERE target_device_id=?",
  ).run(device.id);
  writeFileSync(join(temp, "expired-command.sh"), expired.command + "\n", {
    mode: 0o600,
  });
  assert.notEqual(
    (
      await run([
        "exec",
        "--user",
        "root",
        container,
        "bash",
        "/fixture/expired-command.sh",
      ])
    ).code,
    0,
  );
  assert.equal((await api("/devices")).devices[0].connection_kind, "ssh");
  cli.stdin.write("stty -echo; printf '__FAILED_INSTALL_%s__\\n' SSH_OK\r");
  await until(
    () => output().includes("__FAILED_INSTALL_SSH_OK__"),
    "SSH after failed installation",
  );
  steps.push(
    "Expired installation command fails before modifying target; existing SSH session remains usable",
  );

  await page.getByRole("button", { name: "关闭终端", exact: true }).click();
  await page.getByRole("button", { name: "设备总览", exact: false }).click();
  const row = page.locator("tbody tr").filter({ hasText: device.name });
  await row.getByRole("button", { name: /^更多操作：/ }).click();
  await page.getByRole("menuitem", { name: "安装 Agent", exact: true }).click();
  const panel = page.getByRole("dialog");
  assert.equal(
    await panel.getByLabel("设备名称", { exact: true }).inputValue(),
    device.name,
  );
  assert.ok(
    (await panel
      .getByLabel("设备名称", { exact: true })
      .getAttribute("readonly")) !== null,
  );
  await panel.getByLabel(/^启动方式/).selectOption("background");
  await page.setViewportSize({ width: 390, height: 844 });
  await panel
    .getByRole("button", { name: "生成安装命令", exact: true })
    .scrollIntoViewIfNeeded();
  assert.ok(
    await panel.evaluate(
      (el) =>
        el.scrollWidth <= el.clientWidth + 1 &&
        el.getBoundingClientRect().right <= innerWidth,
    ),
  );
  await page.screenshot({ path: join(out, "ssh-agent-install-mobile.png") });
  await page.setViewportSize({ width: 1440, height: 1050 });
  const issued = page.waitForResponse(
    (r) =>
      r.url().endsWith("/api/v1/agent-installations") &&
      r.request().method() === "POST",
  );
  await panel
    .getByRole("button", { name: "生成安装命令", exact: true })
    .click();
  const response = await issued;
  const request = assertValid(
    "agent-install-request",
    response.request().postDataJSON(),
  );
  assert.equal(request.device_id, device.id);
  assert.equal(request.name, undefined);
  const installation = assertValid(
    "agent-install-response",
    await response.json(),
  );
  if (c.expectedEntry) assert.equal(installation.server_url, c.expectedEntry);
  writeFileSync(join(temp, "install-command.sh"), installation.command + "\n", {
    mode: 0o600,
  });
  const installed = await run([
    "exec",
    "--user",
    "root",
    container,
    "bash",
    "/fixture/install-command.sh",
  ]);
  assert.equal(installed.code, 0, installed.output);
  await panel
    .getByRole("status")
    .filter({ hasText: "Agent 已上线" })
    .waitFor({ timeout: 20000 });
  await page.screenshot({
    path: join(out, "ssh-agent-install-online.png"),
    mask: [panel.locator("textarea")],
  });
  await panel.getByRole("button", { name: "完成", exact: true }).click();
  const devices = (await api("/devices")).devices;
  assert.equal(devices.length, 1);
  assert.equal(devices[0].id, device.id);
  assert.equal(devices[0].name, device.name);
  assert.equal(devices[0].connection_kind, "agent");
  assert.equal(devices[0].ssh_configured, true);
  assert.equal(devices[0].terminal_backend, "agent");
  assert.deepEqual(devices[0].device_groups, [
    { id: "production", name: "Production" },
  ]);
  assert.deepEqual(
    db
      .prepare("SELECT * FROM device_connections WHERE device_id=?")
      .get(device.id),
    beforeConnection,
  );
  assert.deepEqual(
    db.prepare("SELECT * FROM users WHERE id=?").get(userId),
    originalUser,
  );
  assert.equal((await scopedDevices())[0].id, device.id);
  assert.deepEqual(
    await api(`/terminal-sessions/${recordingId}/recording`),
    recording,
  );
  cli.stdin.write("printf '__ORIGINAL_SESSION_%s__\\n' STILL_SSH\r");
  await until(
    () => output().includes("__ORIGINAL_SESSION_STILL_SSH__"),
    "existing SSH session survives Agent promotion",
  );
  steps.push(
    "Browser button generates a command bound to the original ID; real Rust Agent installs and promotes it, preserving SSH credentials, group tag, user-group access and old recording; active SSH is uninterrupted",
  );

  async function terminalCheck(backend, marker, username) {
    await row.getByRole("button", { name: "连接终端", exact: true }).click();
    const terminal = page.getByRole("dialog");
    await terminal.getByText("已连接", { exact: true }).waitFor();
    await terminal
      .getByText(backend === "agent" ? "Agent 通道" : "SSH 通道", {
        exact: true,
      })
      .waitFor();
    await terminal.locator(".xterm-helper-textarea").focus();
    await page.keyboard.type(
      `stty -echo; printf '__${marker}_%s__\\n' "$(id -un)"; exit\r`,
    );
    await text(`__${marker}_${username}__`);
    await terminal.getByText("会话已结束", { exact: true }).waitFor();
    const session = (await api("/terminal-sessions")).sessions.find(
      (s) => s.transport === "web",
    );
    assert.equal(session.backend, backend);
    assert.equal(session.device_id, device.id);
    assert.equal(session.audit_complete, 1);
    const records = await api(`/terminal-sessions/${session.id}/recording`);
    assert.ok(
      records.events
        .filter((e) => e.kind === "output")
        .map((e) => Buffer.from(e.data.data, "base64").toString())
        .join("")
        .includes(`__${marker}_${username}__`),
    );
    await page.screenshot({
      path: join(out, `ssh-agent-install-${backend}-terminal.png`),
    });
    await terminal
      .getByRole("button", { name: "关闭终端", exact: true })
      .click();
  }
  await terminalCheck("agent", "ADOPTED_AGENT", "farhelm");
  if (c.frontend)
    await c.frontend.terminal(device.id, token, "agent", "farhelm");
  const stopped = await run([
    "exec",
    "--user",
    "root",
    container,
    "pkill",
    "-x",
    "farhelm-agent",
  ]);
  assert.equal(stopped.code, 0, stopped.output);
  await until(
    async () => (await api("/devices")).devices[0].terminal_backend === "ssh",
    "Agent loss falls back to SSH",
  );
  await terminalCheck("ssh", "FALLBACK_SSH", "terminal");
  if (c.frontend) {
    await c.frontend.terminal(device.id, token, "ssh", "terminal");
    steps.push(
      "HTTPS frontend: authenticated terminal creation, public Origin WebSocket validation and recordings work through the same public entry for both Agent and SSH backends",
    );
  }
  steps.push(
    "New web terminals prefer the real Agent and record its PTY; stopping Agent causes new terminals to use the same device's original SSH with recording",
  );
}
