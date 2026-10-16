// Isolated browser/API authorization test with recorded-session fixtures, no live PTY.
import assert from "node:assert/strict";
import { chromium, expect } from "@playwright/test";
import {
  mkdtempSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
  rmSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { buildServer } from "../../apps/server/dist/server.js";
const root = resolve(import.meta.dirname, "../..");
const tls = process.env.FLEET_TEST_TLS_DIR ?? join(root, ".dev/tls");
const dir = mkdtempSync(join(tmpdir(), "farhelm-session-visibility-"));
const password = "isolated-session-password1";
const server = await buildServer({
  dataDir: dir,
  tlsCert: join(tls, "server.crt"),
  tlsKey: join(tls, "server.key"),
  webDist: join(root, "apps/web/dist"),
  adminUsername: "admin",
  adminPassword: password,
});
let browser;
try {
  const db = server.store.db;
  for (const id of ["shared", "hidden"])
    db.prepare(
      "INSERT INTO devices(id,public_key,name,created_at) VALUES(?,?,?,1)",
    ).run(id, id, id);
  const alice = server.store.seedUser({
    username: "alice",
    password,
    role: "ops",
    deviceScope: ["shared"],
  });
  const bob = server.store.seedUser({
    username: "bob",
    password,
    role: "ops",
    deviceScope: "*",
  });
  server.store.seedUser({
    username: "auditor",
    password,
    role: "auditor",
    deviceScope: ["shared"],
  });
  for (const [id, actor, device, transport] of [
    ["alice-web-session", alice.id, "shared", "web"],
    ["alice-ssh-session", alice.id, "shared", "ssh"],
    ["bob-web-session", bob.id, "shared", "web"],
    ["bob-ssh-session", bob.id, "shared", "ssh"],
    ["hidden-session", bob.id, "hidden", "ssh"],
  ]) {
    db.prepare(
      "INSERT INTO terminal_sessions(id,device_id,actor_id,status,cols,rows,created_at,ended_at,transport,backend,last_seq,audit_complete) VALUES(?,?,?,'CLOSED',80,24,1000,2000,?,?,1,1)",
    ).run(id, device, actor, transport, transport === "ssh" ? "ssh" : "agent");
    db.prepare(
      "INSERT INTO terminal_recordings(session_id,seq,at,kind,data) VALUES(?,1,1000,'output',?)",
    ).run(
      id,
      JSON.stringify({
        data: Buffer.from(id + " PRIVATE OUTPUT\r\n").toString("base64"),
      }),
    );
  }
  for (const actor of [alice, bob]) {
    for (let n = 0; n < 2; n++) {
      const id = actor.username + "-task-" + n;
      const task = {
        task_id: id,
        device_id: "shared",
        actor_id: actor.id,
        action: "exec",
        argv: ["echo", actor.username + " private task"],
        cwd: "/tmp",
        created_at: 1000 + n,
        expires_at: 3000,
        timeout_ms: 1000,
        max_output_bytes: 1000,
        payload_hash: "a".repeat(64),
      };
      db.prepare(
        "INSERT INTO tasks(id,device_id,actor_id,task_json,payload_hash,status,created_at,updated_at) VALUES(?,'shared',?,?,?,'SUCCEEDED',?,?)",
      ).run(
        id,
        actor.id,
        JSON.stringify(task),
        task.payload_hash,
        task.created_at,
        task.created_at,
      );
      server.store.audit("task.created", actor.id, "shared", id, {
        action: "AGENT_EXEC",
        argv: task.argv,
        cwd: task.cwd,
        role: "ops",
        authorized: true,
        payload_hash: task.payload_hash,
      });
    }
  }
  await server.app.listen({ host: "127.0.0.1", port: 0 });
  const origin = `https://localhost:${server.app.server.address().port}`;
  browser = await chromium.launch({
    headless: true,
    channel: process.env.FLEET_TEST_BROWSER_CHANNEL,
  });
  const contexts = [];
  async function login(username) {
    const context = await browser.newContext({
      viewport: { width: 1440, height: 1050 },
    });
    contexts.push(context);
    const page = await context.newPage();
    await page.goto(origin);
    await page.getByLabel("账号", { exact: true }).fill(username);
    await page.getByLabel("密码", { exact: true }).fill(password);
    const response = page.waitForResponse(
      (r) =>
        r.url().endsWith("/api/v1/login") && r.request().method() === "POST",
    );
    await page.getByRole("button", { name: "登录 →", exact: true }).click();
    const auth = (await (await response).json()).access_token;
    await page.getByRole("button", { name: "终端会话", exact: true }).click();
    return { page, context, auth };
  }
  const own = await login("alice");
  await expect(own.page.locator("tbody tr")).toHaveCount(2);
  await expect(
    own.page.getByText("仅展示本人在授权设备上的会话与录制", { exact: true }),
  ).toBeVisible();
  await expect(own.page.locator("tbody")).not.toContainText(bob.id);
  for (const suffix of ["recording", "export"]) {
    const status = await own.page.evaluate(
      async ({ suffix, auth }) => {
        const response = await fetch(
          `/api/v1/terminal-sessions/bob-web-session/${suffix}`,
          {
            method: suffix === "recording" ? "GET" : "POST",
            headers: {
              authorization: "Bearer " + auth,
              "content-type": "application/json",
            },
            ...(suffix === "export" ? { body: JSON.stringify({ v: 1 }) } : {}),
          },
        );
        return response.status;
      },
      { suffix, auth: own.auth },
    );
    assert.equal(status, 403);
  }
  const recording = own.page.waitForResponse(
    (r) => r.url().includes("/alice-") && r.url().includes("/recording?"),
  );
  await own.page
    .getByRole("button", { name: "查看回放", exact: true })
    .first()
    .click();
  assert.equal((await recording).status(), 200);
  const dialog = own.page.getByRole("dialog");
  await expect(
    dialog.getByRole("button", { name: "导出记录", exact: true }),
  ).toBeEnabled();
  const download = own.page.waitForEvent("download");
  await dialog.getByRole("button", { name: "导出记录", exact: true }).click();
  const exported = JSON.parse(
    readFileSync(await (await download).path(), "utf8"),
  );
  assert.equal(exported.session.actor_id, alice.id);
  assert.ok(
    exported.events.some(
      (e) =>
        e.kind === "output" &&
        Buffer.from(e.data.data, "base64").toString().includes("alice-"),
    ),
  );
  await dialog.getByRole("button", { name: "关闭终端", exact: true }).click();
  const out = join(root, ".test-output");
  mkdirSync(out, { recursive: true });
  await own.page.screenshot({
    path: join(out, "session-visibility-owner.png"),
    fullPage: true,
  });
  await own.page.getByRole("button", { name: "任务中心", exact: true }).click();
  await expect(own.page.locator("tbody tr")).toHaveCount(2);
  await expect(own.page.locator("tbody")).not.toContainText("bob private task");
  for (const path of ["/tasks/bob-task-0", "/tasks/bob-task-0/output/stdout"]) {
    const status = await own.page.evaluate(
      async ({ path, auth }) =>
        (
          await fetch("/api/v1" + path, {
            headers: { authorization: "Bearer " + auth },
          })
        ).status,
      { path, auth: own.auth },
    );
    assert.equal(status, 403);
  }
  await own.page.getByRole("button", { name: "操作审计", exact: true }).click();
  await expect(
    own.page.getByText("仅展示本人的操作审计", { exact: true }),
  ).toBeVisible();
  const ownAudit = await own.page.evaluate(
    async (auth) =>
      (
        await fetch("/api/v1/audit", {
          headers: { authorization: "Bearer " + auth },
        })
      ).json(),
    own.auth,
  );
  assert.ok(ownAudit.audit.length > 0);
  assert.ok(ownAudit.audit.every((e) => e.actor_id === alice.id));
  const other = await login("bob");
  await expect(other.page.locator("tbody tr")).toHaveCount(3);
  await expect(other.page.locator("tbody")).not.toContainText(alice.id);
  const auditor = await login("auditor");
  await expect(auditor.page.locator("tbody tr")).toHaveCount(4);
  await expect(
    auditor.page.getByText("可查看授权设备上所有用户的会话与录制", {
      exact: true,
    }),
  ).toBeVisible();
  await auditor.page
    .getByRole("button", { name: "任务中心", exact: true })
    .click();
  await expect(auditor.page.locator("tbody tr")).toHaveCount(4);
  await auditor.page
    .getByRole("button", { name: "操作审计", exact: true })
    .click();
  const audit = await auditor.page.evaluate(
    async (auth) =>
      (
        await fetch("/api/v1/audit", {
          headers: { authorization: "Bearer " + auth },
        })
      ).json(),
    auditor.auth,
  );
  assert.ok(audit.audit.some((e) => e.actor_id === alice.id));
  assert.ok(audit.audit.some((e) => e.actor_id === bob.id));
  const admin = await login("admin");
  await expect(admin.page.locator("tbody tr")).toHaveCount(5);
  const report = {
    passed: true,
    trusted_https: true,
    same_device_owners_isolated: true,
    own_tasks_and_audit_only: true,
    other_task_details_and_output_denied: true,
    explicit_task_and_audit_review: true,
    web_and_ssh_history: true,
    direct_recording_and_export_denied: true,
    own_playback_and_export: true,
    auditor_device_scope_enforced: true,
    administrator_all_sessions: true,
    session_source: "isolated recorded-session fixtures",
  };
  writeFileSync(
    join(out, "session-visibility.json"),
    JSON.stringify(report, null, 2) + "\n",
  );
  console.log(report);
  for (const c of contexts) await c.close();
} finally {
  await browser?.close();
  await server.close();
  rmSync(dir, { recursive: true, force: true });
}
