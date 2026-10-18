import assert from "node:assert/strict";
import { chromium } from "@playwright/test";
import { join } from "node:path";

export async function verifySshWeb({
  port,
  password,
  deviceId,
  api,
  recording,
  out,
}) {
  const browser = await chromium.launch({
    headless: true,
    args: [
      "--no-proxy-server",
      "--host-resolver-rules=MAP farhelm-http.test 127.0.0.1",
    ],
    ...(process.env.FLEET_CHROMIUM_BIN
      ? { executablePath: process.env.FLEET_CHROMIUM_BIN }
      : {}),
  });
  const page = await browser.newPage({
      viewport: { width: 1440, height: 1000 },
    }),
    errors = [];
  page.on("pageerror", (e) => errors.push(e.message));
  page.setDefaultTimeout(15000);
  const origin = `http://farhelm-http.test:${port}`;
  const nav = (name) =>
    page
      .getByRole("navigation")
      .getByRole("button", { name, exact: false })
      .click();
  const login = async (username) => {
    await page.getByLabel("账号", { exact: true }).fill(username);
    await page.getByLabel("密码", { exact: true }).fill(password);
    await page.getByRole("button", { name: "登录 →", exact: true }).click();
    await page.getByRole("navigation").waitFor();
  };
  const save = async () => {
    await page
      .getByRole("dialog")
      .getByRole("button", { name: "保存", exact: true })
      .click();
    await page.getByRole("dialog").waitFor({ state: "hidden" });
  };
  try {
    await page.goto(origin);
    assert.equal(await page.evaluate(() => isSecureContext), false);
    await login("admin");
    await nav("系统设置");
    await page.getByText("HTTP 无需 HTTPS 证书", { exact: false }).waitFor();
    assert.equal(
      await page.getByText("Agent 接入设置", { exact: true }).count(),
      0,
    );
    await page.screenshot({
      path: join(out, "ssh-http-settings.png"),
      fullPage: true,
    });
    await nav("设备总览");
    const row = page
      .locator("tbody tr")
      .filter({ has: page.getByText("allowed-linux", { exact: true }) });
    await row.getByRole("button", { name: /更多操作/ }).click();
    await page.getByRole("menuitem", { name: "接入配置", exact: true }).click();
    await page.getByLabel("SSH 账号", { exact: true }).waitFor();
    await page.getByRole("button", { name: "保存配置", exact: true }).click();
    await page.getByText("配置已保存", { exact: false }).waitFor();
    await page
      .getByRole("button", { name: "关闭接入配置", exact: true })
      .click();
    assert.equal(
      (await api("GET", `/devices/${deviceId}/connection`)).revision,
      2,
    );
    await row.getByRole("button", { name: /更多操作/ }).click();
    await page.getByRole("menuitem", { name: "SSH 连接", exact: true }).click();
    await page
      .getByRole("button", { name: "复制连接命令", exact: true })
      .click();
    await page.getByRole("button", { name: "已复制", exact: true }).waitFor();
    await page
      .getByRole("button", { name: "关闭 SSH 连接说明", exact: true })
      .click();
    await nav("用户与权限");
    await page.getByRole("tab", { name: /角色/ }).click();
    await page.getByRole("button", { name: "创建角色", exact: true }).click();
    await page.getByLabel("角色名称", { exact: true }).fill("HTTP 运维");
    for (const value of ["devices.read", "terminal.connect", "recordings.read"])
      await page.getByRole("dialog").locator(`input[value="${value}"]`).check();
    await save();
    await page.getByRole("tab", { name: /用户组/ }).click();
    await page.getByRole("button", { name: "创建用户组", exact: true }).click();
    await page.getByLabel("用户组名称", { exact: true }).fill("HTTP 运维组");
    await page.getByLabel("分配角色 HTTP 运维", { exact: true }).check();
    await page.getByLabel("授权设备 allowed-linux", { exact: true }).check();
    await save();
    await page.getByRole("tab", { name: /^用户\s/ }).click();
    await page.getByRole("button", { name: "创建用户", exact: true }).click();
    await page
      .getByRole("dialog")
      .getByLabel("账号", { exact: true })
      .fill("httpops");
    await page.getByLabel("初始密码", { exact: true }).fill(password);
    // This scenario exercises access grants with a ready-to-use account.
    await page.getByLabel(/首次登录时强制修改密码/).uncheck();
    await page.getByLabel("加入用户组 HTTP 运维组", { exact: true }).check();
    await save();
    await page.screenshot({
      path: join(out, "ssh-http-access.png"),
      fullPage: true,
    });
    await page.getByRole("button", { name: "退出登录", exact: true }).click();
    const responsePromise = page.waitForResponse(
      (r) =>
        r.url().endsWith("/api/v1/login") && r.request().method() === "POST",
    );
    await login("httpops");
    const userToken = (await (await responsePromise).json()).access_token;
    assert.equal(
      await page.evaluate(
        async (token) =>
          (
            await fetch("/api/v1/access", {
              headers: { authorization: "Bearer " + token },
            })
          ).status,
        userToken,
      ),
      403,
    );
    assert.equal(
      await page.getByText("restricted-linux", { exact: true }).count(),
      0,
    );
    const userRow = page
      .locator("tbody tr")
      .filter({ has: page.getByText("allowed-linux", { exact: true }) });
    await userRow
      .getByRole("button", { name: "连接终端", exact: true })
      .click();
    const dialog = page.getByRole("dialog");
    await dialog.getByText("已连接", { exact: true }).waitFor();
    const keyboard = dialog.locator(".xterm-helper-textarea");
    await keyboard.fill("printf '__HTTP_BROWSER_%s__\\n' OK; exit");
    await keyboard.press("Enter");
    await dialog.getByText("会话已结束", { exact: true }).waitFor();
    const session = (await api("GET", "/terminal-sessions")).sessions.find(
      (s) => s.transport === "web" && s.device_id === deviceId,
    );
    assert.ok(session);
    assert.equal(session.backend, "ssh");
    assert.equal(session.audit_complete, 1);
    const record = await recording(session.id);
    assert.ok(
      record.events
        .filter((e) => e.kind === "output")
        .map((e) => Buffer.from(e.data.data, "base64").toString())
        .join("")
        .includes("__HTTP_BROWSER_OK__"),
    );
    await page.getByRole("button", { name: "关闭终端", exact: true }).click();
    await nav("终端会话");
    await page
      .locator("tbody tr")
      .filter({ hasText: session.id.slice(0, 12) })
      .getByRole("button", { name: "查看回放", exact: true })
      .click();
    await page
      .getByRole("dialog")
      .getByText("录制时长", { exact: false })
      .waitFor();
    await page.screenshot({
      path: join(out, "ssh-http-recording.png"),
      fullPage: true,
    });
    assert.deepEqual(errors, []);
  } catch (error) {
    await page
      .screenshot({ path: join(out, "ssh-http-failure.png"), fullPage: true })
      .catch(() => {});
    throw error;
  } finally {
    await browser.close();
  }
}
