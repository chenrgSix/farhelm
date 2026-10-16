import assert from "node:assert/strict";
import { chromium, expect } from "@playwright/test";
import { buildServer } from "../../apps/server/src/server.ts";
import { hash } from "../../apps/server/src/util.ts";
import { spawn, execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
const root = resolve(import.meta.dirname, "../.."),
  temp = mkdtempSync(join(tmpdir(), "farhelm-upgrade-groups-")),
  tls = join(temp, "tls"),
  dist = join(temp, "dist"),
  output = join(root, ".test-output");
mkdirSync(output, { recursive: true });
mkdirSync(dist);
execFileSync("bash", [join(root, "deploy/dev/generate-tls.sh"), tls], {
  stdio: "ignore",
});
// Header-only package fixture is never executed: all devices are isolated offline fixtures.
const bytes = Buffer.alloc(128);
Buffer.from("7f454c460201", "hex").copy(bytes);
bytes.writeUInt16LE(183, 18);
const sha256 = hash(bytes);
writeFileSync(join(dist, "farhelm-agent-linux-aarch64"), bytes);
writeFileSync(
  join(dist, "farhelm-agent-linux-aarch64.json"),
  JSON.stringify({
    arch: "aarch64",
    version: "0.2.1",
    sha256,
    size: bytes.length,
    upgrade_protocol: 1,
  }),
);
const password = "upgrade-groups-browser-password1";
const server = await buildServer({
  dataDir: join(temp, "server"),
  tlsCert: join(tls, "server.crt"),
  tlsKey: join(tls, "server.key"),
  adminUsername: "admin",
  adminPassword: password,
  consoleOrigin: "http://127.0.0.1:5187",
  agentInstall: { distDir: dist, publicUrl: "https://localhost:8443" },
});
await server.app.listen({ host: "127.0.0.1", port: 0 });
const port = (server.app.server.address() as any).port;
const devices = [
  ["one", "生产 Linux"],
  ["two", "地区 Linux"],
  ["untagged", "无标签 Linux"],
  ["legacy", "旧版 Linux"],
  ["current", "已更新 Linux"],
  ["newer", "更高版本 Linux"],
  ["missing", "缺包 Linux"],
  ["ssh", "SSH Linux"],
];
for (const [id, name] of devices) {
  const version = id === "newer" ? "0.3.0" : "0.2.0";
  server.store.db
    .prepare(
      "INSERT INTO devices(id,public_key,name,created_at,connection_kind,agent_version) VALUES(?,?,?,1,?,?)",
    )
    .run(id!, id!, name!, id === "ssh" ? "ssh" : "agent", version);
  if (id !== "legacy" && id !== "ssh")
    server.store.db
      .prepare(
        "INSERT INTO agent_runtime(device_id,arch,sha256,version,upgrade_supported,updated_at) VALUES(?,?,?,?,1,1)",
      )
      .run(
        id!,
        id === "missing" ? "x86_64" : "aarch64",
        id === "current" ? sha256 : "a".repeat(64),
        version,
      );
}
const auth = (
  await server.app.inject({
    method: "POST",
    url: "/api/v1/login",
    payload: { username: "admin", password },
  })
).json();
for (const [name, ids] of [
  ["生产组", ["one", "legacy", "current", "newer", "missing", "ssh"]],
  ["地区组", ["one", "two"]],
  ["空组", []],
] as const) {
  const response = await server.app.inject({
    method: "POST",
    url: "/api/v1/device-groups",
    headers: { authorization: `Bearer ${auth.access_token}` },
    payload: { v: 1, name, description: "", device_ids: ids },
  });
  assert.equal(response.statusCode, 200, response.body);
}
const vite = spawn(
  process.execPath,
  [
    join(root, "apps/web/node_modules/vite/bin/vite.js"),
    "--host",
    "127.0.0.1",
    "--port",
    "5187",
    "--strictPort",
  ],
  {
    cwd: join(root, "apps/web"),
    env: {
      ...process.env,
      NODE_EXTRA_CA_CERTS: join(tls, "ca.crt"),
      FLEET_DEV_API_TARGET: `https://localhost:${port}`,
    },
    stdio: "ignore",
  },
);
let browser: Awaited<ReturnType<typeof chromium.launch>> | undefined;
try {
  await expect
    .poll(
      async () => {
        try {
          return (await fetch("http://127.0.0.1:5187")).status;
        } catch {
          return 0;
        }
      },
      { timeout: 15000 },
    )
    .toBe(200);
  browser = await chromium.launch({ headless: true });
  const page = await browser.newPage({
    viewport: { width: 1440, height: 1000 },
  });
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(e.message));
  await page.goto("http://127.0.0.1:5187");
  await page.getByLabel("账号", { exact: true }).fill("admin");
  await page.getByLabel("密码", { exact: true }).fill(password);
  await page.getByRole("button", { name: "登录 →", exact: true }).click();
  await page.getByRole("button", { name: "Agent 升级", exact: true }).click();
  const panel = page.getByRole("region", {
    name: "批量升级 Agent",
    exact: true,
  });
  const filter = panel.getByLabel("按设备组筛选升级设备", { exact: true });
  const all = panel.getByLabel("全选当前筛选的可升级设备", { exact: true });
  await expect(panel.getByLabel("目标版本", { exact: true })).toHaveValue(
    "0.2.1",
  );
  await filter.selectOption({ label: "生产组" });
  await expect(
    panel.getByText("当前 5 台，可升级 1 台", { exact: true }),
  ).toBeVisible();
  await expect(panel.getByText("SSH Linux", { exact: true })).toHaveCount(0);
  await all.check();
  for (const name of [
    "旧版 Linux",
    "已更新 Linux",
    "更高版本 Linux",
    "缺包 Linux",
  ])
    await expect(
      panel.getByLabel(`选择 ${name}`, { exact: true }),
    ).toBeDisabled();
  await filter.selectOption({ label: "地区组" });
  assert.equal(
    await all.evaluate((el: HTMLInputElement) => el.indeterminate),
    true,
  );
  await all.check();
  await expect(panel.locator(".selection-summary")).toContainText(
    "已选择 2 台",
  );
  await filter.selectOption({ label: "生产组" });
  await all.uncheck();
  await expect(panel.locator(".selection-summary")).toContainText(
    "已选择 1 台（1 台在当前筛选外）",
  );
  await filter.selectOption({ label: "空组" });
  await expect(
    panel.getByText("当前筛选下没有 Agent 设备", { exact: true }),
  ).toBeVisible();
  await expect(all).toBeDisabled();
  await filter.selectOption({ label: "未分组" });
  await expect(
    panel.getByText("当前 1 台，可升级 1 台", { exact: true }),
  ).toBeVisible();
  await all.check();
  await filter.selectOption({ label: "生产组" });
  await all.check();
  await expect(panel.locator(".selection-summary")).toContainText(
    "已选择 3 台（2 台在当前筛选外）",
  );
  await page.screenshot({
    path: join(output, "agent-upgrade-groups.png"),
    fullPage: true,
  });
  await page.setViewportSize({ width: 390, height: 844 });
  await filter.scrollIntoViewIfNeeded();
  assert.ok(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= window.innerWidth,
    ),
  );
  await page.screenshot({
    path: join(output, "agent-upgrade-groups-mobile.png"),
    fullPage: true,
  });
  await panel.getByLabel("同时升级数量", { exact: true }).selectOption("1");
  await panel
    .getByRole("button", { name: "升级所选设备", exact: true })
    .click();
  await expect(
    panel.getByText(
      "已创建升级批次，共 3 台。现有终端和任务结束后会自动升级。",
      { exact: true },
    ),
  ).toBeVisible();
  const jobs = server.store.db
    .prepare(
      "SELECT device_id,status,sha256 FROM agent_upgrades ORDER BY device_id",
    )
    .all();
  assert.deepEqual(
    jobs.map((r: any) => ({ ...r })),
    ["one", "two", "untagged"].map((device_id) => ({
      device_id,
      status: "QUEUED",
      sha256,
    })),
  );
  assert.equal(
    (
      server.store.db
        .prepare("SELECT COUNT(*) AS n FROM agent_upgrade_batches")
        .get() as any
    ).n,
    1,
  );
  assert.deepEqual(errors, []);
  const evidence = {
    ok: true,
    checks: [
      "Real browser and API filter optional overlapping device groups, ungrouped and empty groups",
      "Select-all excludes SSH and ineligible Agent devices and preserves hidden selections",
      "Cross-filter selection submits exactly three distinct device IDs in one offline batch",
      "Desktop and mobile layout stays within viewport",
    ],
    scope:
      "Isolated database and offline device/package fixtures; no actual Agent upgrade",
  };
  writeFileSync(
    join(output, "agent-upgrade-groups-browser.json"),
    JSON.stringify(evidence, null, 2),
  );
  console.log(JSON.stringify(evidence));
} finally {
  await browser?.close();
  vite.kill("SIGTERM");
  await server.close();
}
