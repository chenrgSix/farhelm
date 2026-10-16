// Requires farhelm-network-test:local (Linux, node >=24, iproute2, sshd, EasyTier 2.6.4)
// and a Linux Agent build at FLEET_ROUTE_AGENT_BIN. All resources are disposable.
import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import {
  mkdtempSync,
  writeFileSync,
  readFileSync,
  mkdirSync,
  copyFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { request } from "node:https";
import { once } from "node:events";
import { createServer } from "node:net";
import { createRequire } from "node:module";
import { chromium, expect } from "@playwright/test";
import { assertValid } from "../contracts/validate.mjs";
const require = createRequire(import.meta.url),
  { WebSocket } = require("../../apps/server/node_modules/ws"),
  ssh2 = require("../../apps/server/node_modules/ssh2");
const root = resolve(import.meta.dirname, "../.."),
  temp = mkdtempSync(join(tmpdir(), "farhelm-routes-e2e-")),
  prefix = `farhelm-route-${process.pid}`,
  platform = prefix + "-platform",
  target = prefix + "-target",
  hub = prefix + "-hub",
  network = prefix + "-net";
const password = "isolated-route-test-password1",
  steps = [],
  containers = [],
  sockets = [];
const record = (message) => {
  steps.push(message);
  console.log(message);
};
let token = "",
  apiPort,
  sshPort,
  vite,
  browser;
const docker = (...args) =>
  execFileSync("docker", args, {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    timeout: 30000,
  }).trim();
async function until(fn, label, ms = 30000) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (await fn()) return;
    await new Promise((r) => setTimeout(r, 200));
  }
  throw Error("Timed out: " + label);
}
async function freePort() {
  const s = createServer();
  await new Promise((r) => s.listen(0, "127.0.0.1", r));
  const p = s.address().port;
  await new Promise((r) => s.close(r));
  return p;
}
const openssl = (...args) => execFileSync("openssl", args, { stdio: "ignore" });
function api(method, path, body, auth = token) {
  return new Promise((resolve, reject) => {
    const data =
      body === undefined ? undefined : Buffer.from(JSON.stringify(body));
    const req = request(
      {
        hostname: "127.0.0.1",
        servername: "localhost",
        port: apiPort,
        method,
        path: "/api/v1" + path,
        ca: readFileSync(join(temp, "ca.crt")),
        headers: {
          ...(auth ? { authorization: "Bearer " + auth } : {}),
          ...(data
            ? {
                "content-type": "application/json",
                "content-length": data.length,
              }
            : {}),
        },
      },
      (res) => {
        let text = "";
        res.on("data", (d) => (text += d));
        res.on("end", () => {
          try {
            assert.equal(res.statusCode, 200, text);
            resolve(JSON.parse(text));
          } catch (e) {
            reject(e);
          }
        });
      },
    );
    req.on("error", reject);
    req.setTimeout(25000, () => req.destroy(Error("API timeout")));
    req.end(data);
  });
}
function launch(container, name, command, args, user = "root", env = []) {
  docker(
    "exec",
    "-d",
    "--user",
    user,
    ...env.flatMap((e) => ["-e", e]),
    container,
    "sh",
    "-c",
    `echo $$ > /tmp/${name}.pid; exec "$@" > /tmp/${name}.log 2>&1`,
    "sh",
    command,
    ...args,
  );
}
function stop(container, name) {
  docker("exec", container, "sh", "-c", `kill "$(cat /tmp/${name}.pid)"`);
}
async function web(id) {
  const session = await api("POST", "/terminal-sessions", {
    v: 1,
    device_id: id,
    cols: 100,
    rows: 30,
  });
  const ws = new WebSocket(`wss://localhost:${apiPort}/api/v1/terminal/ws`, {
    ca: readFileSync(join(temp, "ca.crt")),
    headers: { origin: `https://localhost:${apiPort}` },
  });
  sockets.push(ws);
  const events = [];
  ws.on("error", () => {});
  ws.on("message", (d) => events.push(JSON.parse(String(d))));
  await once(ws, "open");
  const send = (type, body) => ws.send(JSON.stringify({ v: 1, type, body }));
  send("terminal.attach", {
    session_id: session.session_id,
    ticket: session.ticket,
  });
  await until(() => events.some((e) => e.type === "terminal.ready"), "web PTY");
  return {
    id: session.session_id,
    send,
    events,
    output: () =>
      events
        .filter((e) => e.type === "terminal.output")
        .map((e) => Buffer.from(e.body.data, "base64").toString())
        .join(""),
    close: () =>
      api("POST", `/terminal-sessions/${session.session_id}/close`, { v: 1 }),
  };
}
async function marker(terminal, value) {
  assert.match(value, /^[A-Z0-9_]+$/);
  terminal.send("terminal.input", {
    data: Buffer.from(
      `printf '%s%s\\n' '${value.slice(0, 4)}' '${value.slice(4)}'\r`,
    ).toString("base64"),
  });
  try {
    await until(() => terminal.output().includes(value), "PTY " + value);
  } catch (e) {
    console.error(JSON.stringify(terminal.output()));
    throw e;
  }
}
try {
  const webPort = await freePort(),
    origin = `http://127.0.0.1:${webPort}`;
  copyFileSync(
    join(root, "tests/e2e/network-routes/server.mjs"),
    join(temp, "server.mjs"),
  );
  copyFileSync(
    join(root, "tests/e2e/network-routes/proxy.py"),
    join(temp, "proxy.py"),
  );
  copyFileSync(
    process.env.FLEET_ROUTE_AGENT_BIN ??
      join(root, ".dev/route-target/debug/farhelm-agent"),
    join(temp, "agent"),
  );
  docker("network", "create", network);
  for (const name of [hub, platform, target]) {
    const mounts = [
      "--mount",
      `type=bind,source=${temp},target=/fixture`,
      ...["apps/server", "lib", "apps/web/dist"].flatMap((p) => [
        "--mount",
        `type=bind,source=${join(root, p)},target=/workspace/${p},readonly`,
      ]),
    ];
    docker(
      "run",
      "--rm",
      "-d",
      "--init",
      "--name",
      name,
      "--network",
      network,
      "--cap-add",
      "NET_ADMIN",
      "--device",
      "/dev/net/tun",
      ...(name === platform
        ? ["-p", "127.0.0.1::8443", "-p", "127.0.0.1::2222"]
        : []),
      ...mounts,
      "farhelm-network-test:local",
    );
    containers.push(name);
  }
  apiPort = Number(docker("port", platform, "8443/tcp").split(":").at(-1));
  sshPort = Number(docker("port", platform, "2222/tcp").split(":").at(-1));
  const eth = (name) =>
      docker(
        "inspect",
        "-f",
        `{{range .NetworkSettings.Networks}}{{.IPAddress}}{{end}}`,
        name,
      ),
    platformIP = eth(platform),
    targetIP = eth(target),
    hubIP = eth(hub);
  writeFileSync(
    join(temp, "config.json"),
    JSON.stringify({ password, origin, publicHost: `${platformIP}:8443` }),
  );
  openssl(
    "req",
    "-x509",
    "-newkey",
    "rsa:2048",
    "-nodes",
    "-keyout",
    join(temp, "ca.key"),
    "-out",
    join(temp, "ca.crt"),
    "-days",
    "1",
    "-subj",
    "/CN=Farhelm route isolated test CA",
    "-addext",
    "basicConstraints=critical,CA:TRUE",
  );
  openssl(
    "req",
    "-newkey",
    "rsa:2048",
    "-nodes",
    "-keyout",
    join(temp, "server.key"),
    "-out",
    join(temp, "server.csr"),
    "-subj",
    "/CN=localhost",
  );
  writeFileSync(
    join(temp, "ext"),
    `subjectAltName=DNS:localhost,IP:127.0.0.1,IP:${platformIP},IP:10.144.77.1\nbasicConstraints=critical,CA:FALSE\nkeyUsage=digitalSignature,keyEncipherment\nextendedKeyUsage=serverAuth\n`,
  );
  openssl(
    "x509",
    "-req",
    "-in",
    join(temp, "server.csr"),
    "-CA",
    join(temp, "ca.crt"),
    "-CAkey",
    join(temp, "ca.key"),
    "-CAcreateserial",
    "-out",
    join(temp, "server.crt"),
    "-days",
    "1",
    "-extfile",
    join(temp, "ext"),
  );
  const et = (name, ip, relay = false) =>
    launch(name, "et", "easytier-core", [
      "-i",
      ip,
      "--network-name",
      prefix,
      "--network-secret",
      "isolated-network-secret",
      "--rpc-portal",
      "127.0.0.1:15888",
      "--disable-ipv6",
      ...(name !== hub ? ["-p", `tcp://${hubIP}:11010`] : []),
      ...(relay ? ["--disable-p2p"] : []),
    ]);
  et(hub, "10.144.77.3");
  et(platform, "10.144.77.1");
  et(target, "10.144.77.2");
  launch(platform, "server", "node", ["/fixture/server.mjs"]);
  launch(platform, "vpn", "python3", ["/fixture/proxy.py"]);
  await until(
    async () => {
      try {
        token = (
          await api("POST", "/login", { username: "admin", password }, "")
        ).access_token;
        return !!token;
      } catch {
        return false;
      }
    },
    "platform",
    10000,
  );
  const enrollment = await api("POST", "/enrollment-tokens", {
    v: 1,
    name: "route-agent",
  });
  docker(
    "exec",
    target,
    "sh",
    "-c",
    "mkdir -p /home/fleet/route-state; chown fleet /home/fleet/route-state; chmod 700 /home/fleet/route-state; chmod 755 /fixture/agent",
  );
  const agentEnv = [
    `FLEET_SERVER_URL=https://${platformIP}:8443`,
    "FLEET_STATE_DIR=/home/fleet/route-state",
    "FLEET_CA_CERT=/fixture/ca.crt",
    `FLEET_ENROLLMENT_TOKEN=${enrollment.enrollment_token}`,
    "FLEET_DEVICE_NAME=route-agent",
  ];
  const runAgent = () =>
    launch(target, "agent", "/fixture/agent", ["--worker"], "fleet", agentEnv);
  runAgent();
  let id;
  await until(async () => {
    id = (await api("GET", "/devices")).devices.find(
      (d) => d.name === "route-agent",
    )?.id;
    return !!id;
  }, "Agent enrollment");
  const routePath = `/devices/${id}/network-route`,
    snapshot = async () =>
      assertValid("network-route-response", await api("GET", routePath));
  const policy = {
    mode: "vpn_preferred",
    agent: {
      vpn_url: "https://localhost:8444",
      vpn_ip: "10.144.77.1",
      public_url: `https://${platformIP}:8443`,
    },
    ssh: null,
  };
  const platformPath = "/settings/network";
  await api("PUT", platformPath, {
    v: 1,
    revision: 0,
    settings: { enabled: true, mode: policy.mode, agent: policy.agent },
  });
  assert.equal((await snapshot()).source, "platform");
  await until(
    async () => {
      const s = await snapshot();
      return (
        s.agent_applied &&
        s.agent?.connected &&
        s.agent.channel === "vpn" &&
        s.agent.easytier.state === "p2p"
      );
    },
    "Agent authenticated over real EasyTier P2P",
    90000,
  );
  record(
    "Agent uses authenticated HTTPS/WSS through actual EasyTier P2P and OS tunnel route",
  );
  const first = await web(id);
  await marker(first, "VPN_P2P_RECORDED");
  await first.close();
  stop(platform, "vpn");
  await until(
    async () => {
      const s = await snapshot();
      return (
        s.agent?.connected &&
        s.agent.channel === "public" &&
        s.agent.reason === "VPN_UNREACHABLE"
      );
    },
    "Agent public fallback",
    45000,
  );
  const held = await web(id);
  await marker(held, "PUBLIC_FALLBACK_RECORDED");
  launch(platform, "vpn", "python3", ["/fixture/proxy.py"]);
  await until(
    async () =>
      (await snapshot()).agent?.reason === "VPN_RECOVERY_WAITING_IDLE",
    "stable VPN recovery holds existing terminal",
    120000,
  );
  assert.equal((await snapshot()).agent.channel, "public");
  await marker(held, "SAME_SESSION_AFTER_RECOVERY");
  assert.ok(!held.events.some((e) => e.type === "terminal.closed"));
  await held.close();
  await until(async () => {
    const s = await snapshot();
    return s.agent?.connected && s.agent.channel === "vpn";
  }, "idle switch back to VPN");
  const rec = await api("GET", `/terminal-sessions/${held.id}/recording`);
  const output = rec.events
    .filter((e) => e.kind === "output")
    .map((e) => Buffer.from(e.data.data, "base64").toString())
    .join("");
  assert.ok(
    output.includes("PUBLIC_FALLBACK_RECORDED") &&
      output.includes("SAME_SESSION_AFTER_RECOVERY"),
  );
  record(
    "VPN outage falls back; three recovery checks preserve active PTY and recording, idle reconnect returns to VPN",
  );
  stop(platform, "et");
  stop(target, "et");
  await new Promise((r) => setTimeout(r, 1000));
  et(platform, "10.144.77.1", true);
  et(target, "10.144.77.2", true);
  await until(
    async () => {
      const s = await snapshot();
      return (
        s.agent?.connected &&
        s.agent.channel === "vpn" &&
        s.agent.easytier.state === "relay"
      );
    },
    "actual EasyTier relay reported",
    120000,
  );
  record("EasyTier via third node is reported as relay, not P2P");
  // Browser reads actual runtime observations and applies private-only through the form.
  vite = spawn(
    process.execPath,
    [
      join(root, "apps/web/node_modules/vite/bin/vite.js"),
      "--host",
      "127.0.0.1",
      "--port",
      String(webPort),
      "--strictPort",
    ],
    {
      cwd: join(root, "apps/web"),
      env: {
        ...process.env,
        NODE_EXTRA_CA_CERTS: join(temp, "ca.crt"),
        FLEET_DEV_API_TARGET: `https://localhost:${apiPort}`,
      },
      stdio: "ignore",
    },
  );
  await until(async () => {
    try {
      return (await fetch(origin)).ok;
    } catch {
      return false;
    }
  }, "test browser frontend");
  browser = await chromium.launch({
    headless: true,
    channel: process.env.FLEET_TEST_BROWSER_CHANNEL ?? "msedge",
  });
  const page = await browser.newPage({
    viewport: { width: 1440, height: 1050 },
  });
  await page.goto(origin);
  await page.getByLabel("账号", { exact: true }).fill("admin");
  await page.getByLabel("密码", { exact: true }).fill(password);
  await page.getByRole("button", { name: "登录 →", exact: true }).click();
  await page
    .getByRole("button", { name: "内网地址", exact: true })
    .first()
    .click();
  await expect(page.locator(".route-panel")).toContainText("EasyTier · 中继");
  assert.equal(await page.locator(".route-panel select").count(), 0);
  await page
    .getByRole("button", { name: "前往平台网络设置", exact: true })
    .click();
  const panel = page.locator('[aria-labelledby="network-settings-title"]');
  await panel.locator("select").selectOption("private_only");
  await panel
    .getByRole("button", { name: "保存平台网络策略", exact: true })
    .click();
  await expect(panel.getByRole("status")).toContainText("已保存统一网络策略");
  await panel.scrollIntoViewIfNeeded();
  mkdirSync(join(root, ".test-output"), { recursive: true });
  await page.screenshot({
    path: join(root, ".test-output/network-routes-desktop.png"),
  });
  await page.setViewportSize({ width: 390, height: 844 });
  await page.screenshot({
    path: join(root, ".test-output/network-routes-mobile.png"),
  });
  assert.equal(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth,
    ),
    true,
  );
  record(
    "Device form has only machine addresses; desktop/mobile system settings save one private-only policy for all devices",
  );
  await until(async () => {
    const s = await snapshot();
    return s.revision === 2 && s.agent_applied && s.agent?.channel === "vpn";
  }, "private-only applied");
  stop(platform, "vpn");
  await until(
    async () => !(await snapshot()).agent?.connected,
    "private-only disconnect",
  );
  const before = Number(readFileSync(join(temp, "public-requests"), "utf8"));
  stop(target, "agent");
  runAgent();
  await new Promise((r) => setTimeout(r, 12000));
  assert.equal(
    Number(readFileSync(join(temp, "public-requests"), "utf8")),
    before,
    "private-only must not reconnect to public after restart",
  );
  launch(platform, "vpn", "python3", ["/fixture/proxy.py"]);
  await until(
    async () => {
      const s = await snapshot();
      return s.agent_applied && s.agent?.connected && s.agent.channel === "vpn";
    },
    "private-only recovery",
    45000,
  );
  record(
    "Private-only persists across real Agent restart and does not contact public endpoint while VPN is down",
  );
  // A separate SSH-only inventory record exercises server-side routing without a Farhelm Agent dependency.
  execFileSync("ssh-keygen", [
    "-q",
    "-t",
    "rsa",
    "-b",
    "2048",
    "-N",
    "",
    "-m",
    "PEM",
    "-f",
    join(temp, "ssh-login"),
  ]);
  docker(
    "exec",
    target,
    "sh",
    "-c",
    "mkdir -p /home/fleet/.ssh /run/sshd; cp /fixture/ssh-login.pub /home/fleet/.ssh/authorized_keys; chown -R fleet /home/fleet/.ssh; chmod 700 /home/fleet/.ssh; chmod 600 /home/fleet/.ssh/authorized_keys; passwd -d fleet >/dev/null; ssh-keygen -A",
  );
  launch(target, "sshd", "/usr/sbin/sshd", [
    "-D",
    "-e",
    "-o",
    "PasswordAuthentication=no",
  ]);
  await until(
    () => {
      try {
        return (
          docker(
            "exec",
            target,
            "sh",
            "-c",
            "ss -lnt | grep -q ':22 ' && echo ready || true",
          ) === "ready"
        );
      } catch {
        return false;
      }
    },
    "target sshd listening",
    10000,
  );
  const key = await api("POST", "/ssh/host-key", {
    v: 1,
    host: targetIP,
    port: 22,
  });
  const sshDevice = await api("POST", "/ssh-devices", {
    v: 1,
    name: "SSH-only VPN",
    ssh: {
      host: targetIP,
      port: 22,
      username: "fleet",
      fingerprint: key.fingerprint,
    },
    private_key: readFileSync(join(temp, "ssh-login"), "utf8"),
  });
  const sid = sshDevice.device_id,
    spath = `/devices/${sid}/network-route`;
  await api("PUT", platformPath, {
    v: 1,
    revision: 2,
    settings: { enabled: true, mode: policy.mode, agent: policy.agent },
  });
  await api("PUT", spath, {
    v: 1,
    revision: 0,
    vpn_ip: "10.144.77.2",
    ssh_port: 22,
  });
  assert.equal((await api("GET", spath)).source, "platform");
  const st = await web(sid);
  await marker(st, "SSH_VPN_RECORDED");
  await until(
    async () => (await api("GET", spath)).ssh?.easytier.state === "relay",
    "SSH path reports real EasyTier relay",
  );
  await st.close();
  stop(target, "et");
  const fallbackSsh = await web(sid);
  await marker(fallbackSsh, "SSH_PUBLIC_RECORDED");
  assert.equal((await api("GET", spath)).ssh.channel, "public");
  await fallbackSsh.close();
  const client = new ssh2.Client();
  client.on("error", () => {});
  const ready = once(client, "ready");
  const info = await api("GET", "/ssh");
  client.connect({
    host: "127.0.0.1",
    port: sshPort,
    username: `admin:${sid}`,
    password,
    hostVerifier: (raw) =>
      "SHA256:" +
        require("node:crypto")
          .createHash("sha256")
          .update(raw)
          .digest("base64")
          .replace(/=+$/, "") ===
      info.fingerprint,
  });
  await ready;
  const stream = await new Promise((resolve, reject) =>
    client.shell({ cols: 80, rows: 24 }, (e, c) =>
      e ? reject(e) : resolve(c),
    ),
  );
  let cliOutput = "";
  stream.on("data", (d) => (cliOutput += d));
  await until(() => cliOutput.includes("$"), "SSH gateway shell", 30000);
  stream.write("printf '%s%s\\n' 'SSH_' 'GATEWAY_RECORDED'\r");
  await until(
    () => cliOutput.includes("SSH_GATEWAY_RECORDED"),
    "SSH gateway marker",
  );
  stream.write("exit\n");
  await once(stream, "close");
  client.end();
  await api("PUT", platformPath, {
    v: 1,
    revision: 3,
    settings: {
      enabled: true,
      mode: "private_only",
      agent: { ...policy.agent, public_url: null },
    },
  });
  const tested = await api("POST", `/devices/${sid}/connection/test`, {
    v: 1,
    revision: 1,
  });
  assert.equal(tested.ok, false);
  const sessions = (await api("GET", "/terminal-sessions")).sessions.filter(
    (s) => s.device_id === sid,
  );
  assert.deepEqual(
    new Set(sessions.map((s) => s.transport)),
    new Set(["web", "ssh"]),
  );
  for (const [sessionId, expected] of [
    [st.id, "SSH_VPN_RECORDED"],
    [fallbackSsh.id, "SSH_PUBLIC_RECORDED"],
    [sessions.find((s) => s.transport === "ssh").id, "SSH_GATEWAY_RECORDED"],
  ]) {
    const recording = await api(
      "GET",
      `/terminal-sessions/${sessionId}/recording`,
    );
    assert.equal(recording.session.backend, "ssh");
    assert.equal(recording.session.device_id, sid);
    assert.ok(
      recording.events
        .filter((e) => e.kind === "output")
        .map((e) => Buffer.from(e.data.data, "base64").toString())
        .join("")
        .includes(expected),
    );
  }
  record(
    "SSH-only inventory uses VPN, falls back for web and SSH gateway, enforces private-only, preserves shared recording",
  );
  writeFileSync(
    join(root, ".test-output/network-routes-e2e.json"),
    JSON.stringify({ passed: true, steps }, null, 2) + "\n",
  );
  console.log(JSON.stringify({ passed: true, steps }, null, 2));
} catch (e) {
  console.error(e);
  for (const c of containers) {
    try {
      console.error(
        c,
        docker(
          "exec",
          c,
          "sh",
          "-c",
          "tail -25 /tmp/agent.log /tmp/server.log /tmp/et.log /tmp/sshd.log 2>/dev/null; true",
        ),
      );
    } catch {}
  }
  throw e;
} finally {
  await browser?.close();
  vite?.kill("SIGTERM");
  for (const ws of sockets) ws.terminate();
  for (const name of containers.reverse()) {
    try {
      docker("rm", "-f", name);
    } catch {}
  }
  try {
    docker("network", "rm", network);
  } catch {}
}
