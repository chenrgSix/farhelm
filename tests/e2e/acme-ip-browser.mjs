// Isolated settings UI, real API, trusted bootstrap TLS; no production CA orders.
import { chromium } from "@playwright/test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { buildServer } from "../../apps/server/dist/server.js";
const root = resolve(import.meta.dirname, "../..");
const tls = process.env.FLEET_TEST_TLS_DIR ?? join(root, ".dev/tls");
const server = await buildServer({
  dataDir: mkdtempSync(join(tmpdir(), "farhelm-ip-browser-")),
  tlsCert: join(tls, "server.crt"),
  tlsKey: join(tls, "server.key"),
  webDist: join(root, "apps/web/dist"),
  adminUsername: "admin",
  adminPassword: "isolated-ip-browser-password1",
  acme: { httpHost: "127.0.0.1", httpPort: 0 },
});
let browser;
try {
  await server.app.listen({ host: "127.0.0.1", port: 0 });
  browser = await chromium.launch({
    headless: true,
    channel: process.env.FLEET_TEST_BROWSER_CHANNEL,
  });
  const page = await browser.newPage({
    viewport: { width: 1440, height: 1050 },
  });
  const errors = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.goto(`https://localhost:${server.app.server.address().port}/`);
  await page.getByLabel("账号", { exact: true }).fill("admin");
  await page
    .getByLabel("密码", { exact: true })
    .fill("isolated-ip-browser-password1");
  await page.getByRole("button", { name: "登录 →", exact: true }).click();
  await page.getByRole("button", { name: "系统设置", exact: true }).click();
  const host = page.getByRole("textbox", {
    name: "平台域名或公网 IP",
    exact: true,
  });
  await page
    .getByRole("combobox", { name: "验证方式", exact: true })
    .selectOption("tls-alpn-01");
  await page
    .getByTestId("challenge-hint")
    .filter({ hasText: "公网 443" })
    .waitFor();
  await host.fill("8.8.8.8");
  await page
    .getByRole("textbox", { name: "联系邮箱", exact: true })
    .fill("ops@example.com");
  await page.getByRole("button", { name: "保存证书设置", exact: true }).click();
  await page
    .getByText("已保存，自动申请已关闭，当前证书继续保留。", { exact: true })
    .waitFor();
  assert.equal(
    server.store.db
      .prepare("SELECT domain FROM certificate_settings WHERE id=1")
      .get().domain,
    "8.8.8.8",
  );
  await host.fill("2606:4700:4700:0:0:0:0:1111");
  await page.getByRole("button", { name: "保存证书设置", exact: true }).click();
  await page.waitForFunction(
    () =>
      document.querySelector('[name="certificate-domain"]').value ===
      "2606:4700:4700::1111",
  );
  assert.equal(
    server.store.db
      .prepare("SELECT domain FROM certificate_settings WHERE id=1")
      .get().domain,
    "2606:4700:4700::1111",
  );
  await host.fill("192.168.1.10");
  await page.getByRole("button", { name: "保存证书设置", exact: true }).click();
  await page
    .getByRole("alert")
    .filter({ hasText: "内网、回环及保留地址" })
    .waitFor();
  assert.equal(
    server.store.db
      .prepare("SELECT domain FROM certificate_settings WHERE id=1")
      .get().domain,
    "2606:4700:4700::1111",
  );
  await host.fill("2606:4700:4700::1111");
  await page
    .getByRole("button", { name: "重新加载证书配置", exact: true })
    .click();
  await page
    .locator('[aria-labelledby="certificate-title"]')
    .getByRole("alert")
    .waitFor({ state: "hidden" });
  assert.equal(
    await page.locator('[name="certificate-challenge"]').inputValue(),
    "tls-alpn-01",
  );
  assert.equal(
    server.store.db
      .prepare("SELECT challenge_type FROM certificate_settings WHERE id=1")
      .get().challenge_type,
    "tls-alpn-01",
  );
  const out = join(root, ".test-output");
  mkdirSync(out, { recursive: true });
  await page
    .locator('[aria-labelledby="certificate-title"]')
    .screenshot({ path: join(out, "acme-ip-settings-desktop.png") });
  await page.setViewportSize({ width: 390, height: 844 });
  await page
    .locator('[aria-labelledby="certificate-title"]')
    .screenshot({ path: join(out, "acme-ip-settings-mobile.png") });
  assert.equal(
    await page.evaluate(
      () => document.documentElement.scrollWidth > innerWidth,
    ),
    false,
  );
  assert.deepEqual(errors, []);
  const result = {
    passed: true,
    trusted_bootstrap: true,
    ipv4_saved: true,
    tls_challenge_persisted: true,
    ipv6_normalized: true,
    private_ip_rejected: true,
    mobile_no_overflow: true,
  };
  writeFileSync(
    join(out, "acme-ip-browser.json"),
    JSON.stringify(result, null, 2),
  );
  console.log(result);
} finally {
  await browser?.close();
  await server.close();
}
