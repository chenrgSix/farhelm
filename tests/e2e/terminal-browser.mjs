import assert from "node:assert/strict";
import { chromium } from "@playwright/test";
import { readFileSync, mkdirSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";

const credentials = process.env.FLEET_CREDENTIALS_FILE
  ? JSON.parse(readFileSync(process.env.FLEET_CREDENTIALS_FILE, "utf8"))
  : {
      username: process.env.FLEET_ADMIN_USER,
      password: process.env.FLEET_ADMIN_PASSWORD,
    };
assert.ok(
  credentials.username && credentials.password,
  "Supply FLEET_CREDENTIALS_FILE or explicit administrator credentials for the local development instance",
);
const url = process.env.FLEET_CONSOLE_URL || "http://127.0.0.1:5173";
const testSudo = process.env.FLEET_TEST_TERMINAL_SUDO === "1";
const output = resolve(import.meta.dirname, "../../.test-output");
mkdirSync(output, { recursive: true });
const browser = await chromium.launch({
  headless: true,
  ...(process.env.FLEET_CHROMIUM_BIN
    ? { executablePath: process.env.FLEET_CHROMIUM_BIN }
    : {}),
});
try {
  const page = await browser.newPage({
    viewport: { width: 1440, height: 1000 },
  });
  const errors = [];
  page.on("pageerror", (e) => errors.push(e.message));
  await page.goto(url);
  await page.getByLabel("账号", { exact: true }).fill(credentials.username);
  await page.getByLabel("密码", { exact: true }).fill(credentials.password);
  await page.getByRole("button", { name: "登录 →", exact: true }).click();
  const row = page
    .locator("tbody tr")
    .filter({
      has: page.getByRole("button", { name: "连接终端", exact: true }),
    })
    .first();
  await row.getByRole("button", { name: "连接终端", exact: true }).click();
  const dialog = page.getByRole("dialog");
  await dialog.getByText("已连接", { exact: true }).waitFor();
  const keyboard = dialog.locator(".xterm-helper-textarea");
  const waitText = async (text) => {
    await page.waitForFunction(
      (text) =>
        Array.from(document.querySelectorAll(".xterm-rows")).some((e) =>
          e.textContent.includes(text),
        ),
      text,
    );
  };
  const waitPrompt = async (directory) => {
    await page.waitForFunction((directory) => {
      const lines = Array.from(document.querySelectorAll(".xterm-rows > div"))
        .map((e) => e.textContent.trim())
        .filter(Boolean);
      const last = lines.at(-1) || "";
      return /^[^@\s]+@[^:\s]+:/.test(last) && last.endsWith(`:${directory}$`);
    }, directory);
  };
  await waitPrompt("~");
  await keyboard.focus();
  await page.keyboard.type("stty -echo;printf '__BROWSER_%s__\\n' READY\r");
  await waitText("__BROWSER_READY__");
  const probe = `fleet-browser-write-${process.pid}.txt`;
  await page.keyboard.type(
    `touch ${probe} && printf 'file-write-check' > ${probe} && grep -q '^file-write-check$' ${probe} && rm ${probe} && printf '__FILE_WRITE_%s__\\n' OK\r`,
  );
  await waitText("__FILE_WRITE_OK__");
  if (testSudo) {
    await page.keyboard.type("sudo -i\r");
    await page.waitForFunction(() => {
      const lines = Array.from(document.querySelectorAll(".xterm-rows > div"))
        .map((e) => e.textContent.trim())
        .filter(Boolean);
      return /^root@[^:\s]+:.*#\s*$/.test(lines.at(-1) || "");
    });
    const rootProbe = `/root/.fleet-sudo-browser-${process.pid}`;
    await page.keyboard.type(
      `stty -echo;printf '__SUDO_UID_%s__\\n' "$(id -u)";touch ${rootProbe} && test -f ${rootProbe} && rm ${rootProbe} && printf '__SUDO_WRITE_%s__\\n' OK\r`,
    );
    await waitText("__SUDO_UID_0__");
    await waitText("__SUDO_WRITE_OK__");
    await page.keyboard.type("exit\r");
    await waitPrompt("~");
    await page.keyboard.type("printf '__RETURN_USER_%s__\\n' \"$(id -un)\"\r");
    await waitText("__RETURN_USER_fleet__");
  }
  await page.keyboard.type("cd /tm");
  await page.keyboard.press("Tab");
  await page.keyboard.press("Enter");
  await page.keyboard.type("pwd;printf '__CWD_%s__\\n' OK\r");
  await waitText("__CWD_OK__");
  assert.ok(
    (await dialog.locator(".xterm-rows").textContent()).includes("/tmp"),
  );
  await waitPrompt("/tmp");
  await page.keyboard.type("printf '__WAIT_%s__\\n' START;sleep 30\r");
  await waitText("__WAIT_START__");
  await page.keyboard.press("Control+c");
  await page.keyboard.type("printf '__CTRL_C_%s__\\n' OK\r");
  await waitText("__CTRL_C_OK__");
  await page.keyboard.type(
    "printf '\\344\\270\\255\\346\\226\\207\\n';printf '__UTF8_%s__\\n' OK\r",
  );
  await waitText("__UTF8_OK__");
  await waitText("中文");
  await page.keyboard.type("top\r");
  await waitText("Tasks:");
  await page.keyboard.press("q");
  // Wait until top returns control; sending the next command with q can let
  // top consume its first character in the same terminal read.
  await waitPrompt("/tmp");
  await page.keyboard.type("printf '__TOP_%s__\\n' OK\r");
  await waitText("__TOP_OK__");
  await page.setViewportSize({ width: 1100, height: 820 });
  await page.keyboard.type("stty size;printf '__RESIZE_%s__\\n' OK\r");
  await waitText("__RESIZE_OK__");
  await page.screenshot({
    path: resolve(output, "terminal-browser.png"),
    fullPage: true,
  });
  await page.keyboard.type("exit\r");
  await dialog.getByText("会话已结束", { exact: true }).waitFor();
  await dialog.getByRole("button", { name: "关闭终端", exact: true }).click();
  await page.getByRole("button", { name: "终端会话", exact: true }).click();
  const latest = page.locator("tbody tr").first();
  await latest.getByRole("button", { name: "查看回放", exact: true }).click();
  const replay = page.getByRole("dialog");
  await waitText("__CTRL_C_OK__");
  await waitText("中文");
  await replay.getByText("会话记录完整", { exact: true }).waitFor();
  const downloadEvent = page.waitForEvent("download");
  await replay.getByRole("button", { name: "导出记录", exact: true }).click();
  const download = await downloadEvent;
  const data = JSON.parse(readFileSync(await download.path(), "utf8"));
  assert.ok(data.events.some((e) => e.kind === "resize"));
  assert.ok(data.events.some((e) => e.kind === "output"));
  await page.screenshot({
    path: resolve(output, "terminal-replay.png"),
    fullPage: true,
  });
  await page.setViewportSize({ width: 390, height: 844 });
  await page.screenshot({
    path: resolve(output, "terminal-mobile.png"),
    fullPage: true,
  });
  assert.deepEqual(errors, []);
  writeFileSync(
    resolve(output, "terminal-browser.json"),
    JSON.stringify(
      {
        passed: true,
        browser: browser.version(),
        steps: [
          "login",
          "connect actual Linux PTY",
          "create, write, read and remove a file in the initial directory",
          "username/hostname prompt follows the current directory",
          ...(testSudo
            ? ["sudo -i reaches UID 0, writes /root and returns to fleet"]
            : []),
          "Tab completion and persistent cd/pwd",
          "Ctrl-C",
          "Chinese output",
          "interactive top",
          "viewport resize",
          "exit",
          "recording replay",
          "audited export",
          "mobile layout",
        ],
        pageErrors: errors,
      },
      null,
      2,
    ),
  );
  console.log(
    "PASS real browser terminal: connect -> cwd -> Ctrl-C -> UTF-8 -> resize -> exit -> replay -> export",
  );
} finally {
  await browser.close();
}
