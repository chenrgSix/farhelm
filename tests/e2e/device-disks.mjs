import assert from "node:assert/strict";
import { chromium } from "@playwright/test";
import { execFileSync } from "node:child_process";
import { createServer } from "node:http";
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
import { parseDiskUsage } from "../../apps/server/dist/disk-usage.js";
import { assertValid } from "../contracts/validate.mjs";
const root = resolve(import.meta.dirname, "../..");
const binary = resolve(
  process.env.FLEET_TEST_AGENT_BINARY ||
    join(root, ".test-output/disk-target/debug/farhelm-agent"),
);
const temp = mkdtempSync(join(tmpdir(), "farhelm-disks-e2e-"));
const out = join(root, ".test-output");
mkdirSync(out, { recursive: true });
const agentName = `farhelm-disk-agent-${process.pid}`,
  sshName = `farhelm-disk-ssh-${process.pid}`;
const docker = (args) =>
  execFileSync("docker", args, {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  }).trim();
let server, frontend, browser;
async function until(fn, label, ms = 30000) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (await fn()) return;
    await new Promise((r) => setTimeout(r, 100));
  }
  throw Error("Timed out: " + label);
}
try {
  const tls = join(temp, "tls");
  execFileSync("bash", [join(root, "deploy/dev/generate-tls.sh"), tls], {
    stdio: "ignore",
  });
  const password = "isolated-disk-test-password1";
  server = await buildServer({
    dataDir: join(temp, "server"),
    tlsCert: join(tls, "server.crt"),
    tlsKey: join(tls, "server.key"),
    adminUsername: "admin",
    adminPassword: password,
    webDist: join(root, "apps/web/dist"),
  });
  await server.app.listen({ host: "0.0.0.0", port: 0 });
  const port = server.app.server.address().port;
  const login = await server.app.inject({
    method: "POST",
    url: "/api/v1/login",
    payload: { username: "admin", password },
  });
  const auth = login.json().access_token;
  async function api(method, path, payload) {
    const r = await server.app.inject({
      method,
      url: "/api/v1" + path,
      headers: { authorization: "Bearer " + auth },
      ...(payload ? { payload } : {}),
    });
    assert.equal(r.statusCode, 200, r.body);
    return r.json();
  }
  const enrollment = await api("POST", "/enrollment-tokens", {
    v: 1,
    ttl_seconds: 600,
  });
  docker([
    "run",
    "--rm",
    "-d",
    "--init",
    "--name",
    agentName,
    "--mount",
    `type=bind,source=${binary},target=/usr/local/bin/farhelm-agent,readonly`,
    "--mount",
    `type=bind,source=${tls}/ca.crt,target=/tmp/farhelm-ca.crt,readonly`,
    "-e",
    `FLEET_SERVER_URL=https://host.docker.internal:${port}`,
    "-e",
    "FLEET_CA_CERT=/tmp/farhelm-ca.crt",
    "-e",
    "FLEET_STATE_DIR=/tmp/farhelm-state",
    "-e",
    `FLEET_ENROLLMENT_TOKEN=${enrollment.enrollment_token}`,
    "-e",
    "FLEET_DEVICE_NAME=磁盘验证 Agent",
    "-e",
    "FLEET_EXECUTION_BACKEND=disabled",
    "farhelm-agent-dev:local",
  ]);
  let agentId;
  await until(async () => {
    const devices = (await api("GET", "/devices")).devices;
    agentId = devices.find(
      (d) => d.name === "磁盘验证 Agent" && d.control_online,
    )?.id;
    return !!agentId;
  }, "real Agent connects");
  assert.notEqual(
    docker(["exec", agentName, "id", "-u"]),
    "0",
    "Agent must run without root",
  );
  const passive = await api("GET", `/devices/${agentId}/disk`);
  assert.equal(passive.usage, null);
  assert.equal(passive.interval_hours, 24);
  const before = server.store.db
    .prepare(
      "SELECT COUNT(*) AS n FROM audit WHERE action='device.disk_requested'",
    )
    .get().n;
  const samples = await Promise.all(
    Array.from({ length: 8 }, () =>
      api("POST", `/devices/${agentId}/disk/collect`, { v: 1 }),
    ),
  );
  for (const sample of samples) {
    assertValid("device-disk-response", sample);
    assert.ok(sample.usage?.total_bytes > 0);
    assert.deepEqual(sample.usage, samples[0].usage);
  }
  assert.equal(
    server.store.db
      .prepare(
        "SELECT COUNT(*) AS n FROM audit WHERE action='device.disk_requested'",
      )
      .get().n,
    before + 1,
  );
  const actual = parseDiskUsage(
    docker(["exec", agentName, "sh", "-c", "LC_ALL=C df -P -k -l -T"]),
  );
  assert.equal(samples[0].usage.total_bytes, actual.total_bytes);
  assert.ok(
    Math.abs(samples[0].usage.used_bytes - actual.used_bytes) <
      16 * 1024 * 1024,
  );
  for (const key of ["host", "identity"])
    execFileSync(
      "ssh-keygen",
      ["-q", "-t", "ed25519", "-N", "", "-f", join(temp, key)],
      { stdio: "ignore" },
    );
  writeFileSync(
    join(temp, "authorized_keys"),
    readFileSync(join(temp, "identity.pub")),
  );
  writeFileSync(
    join(temp, "sshd_config"),
    "Port 22\nHostKey /fixture/host\nAuthorizedKeysFile /etc/ssh/authorized_keys\nStrictModes no\nPasswordAuthentication no\nPubkeyAuthentication yes\nKbdInteractiveAuthentication no\nPermitEmptyPasswords no\nPermitRootLogin no\nAllowUsers terminal\nUsePAM no\nPrintMotd no\nAllowTcpForwarding no\nX11Forwarding no\n",
  );
  docker([
    "run",
    "--rm",
    "-d",
    "--name",
    sshName,
    "--publish",
    "127.0.0.1::22",
    "--mount",
    `type=bind,source=${temp},target=/fixture,readonly`,
    "--mount",
    `type=bind,source=${temp}/authorized_keys,target=/etc/ssh/authorized_keys,readonly`,
    "farhelm-sshd-test:local",
  ]);
  const sshPort = Number(docker(["port", sshName, "22/tcp"]).split(":").at(-1));
  await until(() => {
    try {
      return !!docker([
        "exec",
        sshName,
        "sh",
        "-c",
        "test -s /run/sshd.pid && cat /run/sshd.pid",
      ]);
    } catch {
      return false;
    }
  }, "SSH daemon starts");
  const fingerprint = execFileSync(
    "ssh-keygen",
    ["-lf", join(temp, "host.pub"), "-E", "sha256"],
    { encoding: "utf8" },
  ).split(/\s+/)[1];
  const ssh = await api("POST", "/ssh-devices", {
    v: 1,
    name: "磁盘验证 SSH",
    ssh: {
      host: "127.0.0.1",
      port: sshPort,
      username: "terminal",
      fingerprint,
      auth_method: "private_key",
    },
    private_key: readFileSync(join(temp, "identity"), "utf8"),
  });
  const sshId = ssh.device_id;
  const sshSample = await api("POST", `/devices/${sshId}/disk/collect`, {
    v: 1,
  });
  assert.ok(sshSample.usage?.total_bytes > 0, JSON.stringify(sshSample));
  const sshActual = parseDiskUsage(
    docker([
      "exec",
      "--user",
      "terminal",
      sshName,
      "sh",
      "-c",
      "LC_ALL=C df -P -k -l -T",
    ]),
  );
  assert.equal(sshSample.usage.total_bytes, sshActual.total_bytes);
  const list = await api("GET", "/devices");
  assertValid("devices-response", list);
  assert.ok(list.devices.every((d) => d.disk_usage?.total_bytes > 0));
  const audit = await api("GET", "/audit");
  for (const event of audit.audit) assertValid("audit", event);
  // Loopback browser facade uses the real handlers and built frontend; Agent traffic remains verified TLS.
  frontend = createServer(async (req, res) => {
    try {
      const chunks = [];
      for await (const chunk of req) chunks.push(chunk);
      const r = await server.app.inject({
        method: req.method,
        url: req.url,
        headers: req.headers,
        ...(chunks.length ? { payload: Buffer.concat(chunks) } : {}),
      });
      res.writeHead(r.statusCode, r.headers);
      res.end(r.rawPayload);
    } catch {
      res.writeHead(500);
      res.end();
    }
  });
  await new Promise((r) => frontend.listen(0, "127.0.0.1", r));
  browser = await chromium.launch({
    headless: true,
    ...(process.env.FLEET_CHROMIUM_BIN
      ? { executablePath: process.env.FLEET_CHROMIUM_BIN }
      : {}),
  });
  const page = await browser.newPage({
    viewport: { width: 1440, height: 1000 },
  });
  const errors = [];
  page.on("pageerror", (e) => errors.push(e.message));
  await page.goto(`http://127.0.0.1:${frontend.address().port}`);
  await page.getByLabel("账号", { exact: true }).fill("admin");
  await page.getByLabel("密码", { exact: true }).fill(password);
  await page.getByRole("button", { name: "登录 →", exact: true }).click();
  await page
    .getByRole("button", { name: "查看设备详情：磁盘验证 Agent", exact: true })
    .click();
  await page.getByRole("meter", { name: "磁盘已用比例" }).waitFor();
  await page.screenshot({
    path: join(out, "device-disks-desktop.png"),
    fullPage: true,
  });
  await page.getByLabel("采集间隔").selectOption("8");
  await page.getByRole("button", { name: "保存", exact: true }).click();
  await page.getByText("采集间隔已保存。", { exact: true }).waitFor();
  assert.equal(
    (await api("GET", `/devices/${agentId}/disk`)).interval_hours,
    8,
  );
  await page.setViewportSize({ width: 390, height: 844 });
  await page.screenshot({
    path: join(out, "device-disks-mobile.png"),
    fullPage: true,
  });
  assert.ok(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth,
    ),
  );
  await page
    .getByRole("button", { name: "← 返回设备列表", exact: true })
    .click();
  await page
    .getByRole("button", { name: "查看设备详情：磁盘验证 SSH", exact: true })
    .click();
  await page.getByRole("meter", { name: "磁盘已用比例" }).waitFor();
  assert.deepEqual(errors, []);
  writeFileSync(
    join(out, "device-disks-e2e.json"),
    JSON.stringify(
      {
        passed: true,
        agent: samples[0].usage,
        ssh: sshSample.usage,
        checks: [
          "unprivileged real Linux Agent over verified TLS",
          "eight viewers share one collection",
          "passive cache and default 24h schedule",
          "real pinned SSH read-only collection",
          "API and audit contracts",
          "desktop/mobile details and 8h schedule edit",
          "no browser errors or mobile overflow",
        ],
      },
      null,
      2,
    ),
  );
  console.log(
    "PASS: real Agent + SSH disk collection, shared cache, API contracts, desktop/mobile details and schedule editing",
  );
} finally {
  await browser?.close();
  if (frontend) await new Promise((r) => frontend.close(r));
  for (const name of [agentName, sshName])
    try {
      docker(["rm", "-f", name]);
    } catch {}
  await server?.app.close();
  rmSync(temp, { recursive: true, force: true });
}
