// Uses an already trusted local bootstrap certificate; never disables browser TLS verification.
import { chromium } from "@playwright/test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { X509Certificate } from "node:crypto";
import { buildServer } from "../../apps/server/dist/server.js";
const root = resolve(import.meta.dirname, "../..");
const temp = mkdtempSync(join(tmpdir(), "farhelm-private-browser-"));
const tls = process.env.FLEET_TEST_TLS_DIR ?? join(root, ".dev/tls");
const password = "isolated-private-browser-password1";
const server = await buildServer({
  dataDir: temp,
  tlsCert: join(tls, "server.crt"),
  tlsKey: join(tls, "server.key"),
  webDist: join(root, "apps/web/dist"),
  adminUsername: "admin",
  adminPassword: password,
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
  page.on("pageerror", (e) => errors.push(e.message));
  const port = server.app.server.address().port;
  await page.goto(`https://localhost:${port}/`);
  await page.getByLabel("账号", { exact: true }).fill("admin");
  await page.getByLabel("密码", { exact: true }).fill(password);
  await page.getByRole("button", { name: "登录 →", exact: true }).click();
  await page.getByRole("button", { name: "系统设置", exact: true }).click();
  await page.locator('[name="certificate-mode"]').selectOption("private");
  await page
    .locator('[name="certificate-domain"]')
    .fill("private.browser.internal");
  await page
    .locator('[name="certificate-additional-domains"]')
    .fill("123.88.4.44\n192.168.1.5");
  await page.getByRole("button", { name: "保存证书设置", exact: true }).click();
  const create = page.getByRole("button", { name: "创建内网 CA", exact: true });
  await create.click();
  const downloadEvent = page.waitForEvent("download");
  await page.getByRole("button", { name: "下载 CA 证书", exact: true }).click();
  const download = await downloadEvent;
  const path = await download.path();
  const ca = readFileSync(path, "utf8");
  assert.equal(
    new X509Certificate(ca).fingerprint256,
    await page.getByTestId("ca-fingerprint").innerText(),
  );
  assert.ok(!ca.includes("PRIVATE KEY"));
  await page.locator('[name="certificate-enabled"]').check();
  await page.getByRole("button", { name: "保存证书设置", exact: true }).click();
  await page.getByText("证书有效", { exact: true }).waitFor();
  const active = JSON.parse(
    readFileSync(join(temp, "certificates/active.json"), "utf8"),
  );
  const leaf = new X509Certificate(active.cert);
  assert.ok(leaf.checkHost("private.browser.internal"));
  assert.ok(leaf.checkIP("123.88.4.44"));
  assert.ok(leaf.checkIP("192.168.1.5"));
  assert.match(
    await page.getByTestId("certificate-names").innerText(),
    /123\.88\.4\.44/,
  );
  assert.match(
    await page.getByTestId("certificate-names").innerText(),
    /192\.168\.1\.5/,
  );
  assert.ok(leaf.verify(new X509Certificate(ca).publicKey));
  assert.equal(
    await page.locator('[name="certificate-additional-domains"]').inputValue(),
    "123.88.4.44\n192.168.1.5",
  );
  assert.match(
    await page.getByTestId("certificate-expiry").innerText(),
    /20\d{2}/,
  );
  await Promise.all([
    page.waitForResponse(
      (response) =>
        response.url().endsWith("/api/v1/settings/certificate") &&
        response.request().method() === "GET",
    ),
    page.getByRole("button", { name: "重新加载证书配置", exact: true }).click(),
  ]);
  await page
    .getByRole("heading", { name: "HTTPS 证书", exact: true })
    .scrollIntoViewIfNeeded();
  const out = join(root, ".test-output");
  mkdirSync(out, { recursive: true });
  await page.screenshot({
    path: join(out, "private-certificates-desktop.png"),
    fullPage: true,
  });
  await page
    .locator(".certificate-panel")
    .screenshot({ path: join(out, "private-certificates-panel.png") });
  await page.setViewportSize({ width: 390, height: 844 });
  await page
    .locator('[name="certificate-additional-domains"]')
    .scrollIntoViewIfNeeded();
  await page.screenshot({
    path: join(out, "private-certificates-mobile.png"),
    fullPage: false,
  });
  assert.equal(
    await page.evaluate(
      () => document.documentElement.scrollWidth > innerWidth,
    ),
    false,
  );
  assert.deepEqual(errors, []);
  const result = {
    passed: true,
    trusted_bootstrap_browser: true,
    real_settings_api: true,
    ca_download_fingerprint: true,
    private_issuance: true,
    multiple_addresses_same_ca: true,
    bootstrap_preserved: true,
    mobile_no_overflow: true,
  };
  writeFileSync(
    join(out, "private-certificates-browser.json"),
    JSON.stringify(result, null, 2),
  );
  console.log(JSON.stringify(result));
} finally {
  await browser?.close();
  await server.close();
}
