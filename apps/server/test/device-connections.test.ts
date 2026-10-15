import { test } from "node:test";
import assert from "node:assert/strict";
import { createPrivateKey, createHash, generateKeyPairSync } from "node:crypto";
import { mkdtempSync, readFileSync, statSync, unlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { once } from "node:events";
import ssh2, {
  type ClientChannel,
  type ServerChannel,
  type Connection,
} from "ssh2";
import { WebSocket } from "ws";
import { buildServer } from "../src/server.js";
import { fingerprint } from "../src/ssh-target.js";
import { Credentials } from "../src/credentials.js";

const root = mkdtempSync(join(tmpdir(), "farhelm-connections-test-"));
execFileSync("bash", ["../../deploy/dev/generate-tls.sh", join(root, "tls")], {
  stdio: "ignore",
});
const ca = readFileSync(join(root, "tls/ca.crt"));
const keypair = () =>
  generateKeyPairSync("rsa", {
    modulusLength: 2048,
    privateKeyEncoding: { type: "pkcs1", format: "pem" },
    publicKeyEncoding: { type: "spki", format: "pem" },
  });
const hostKey = keypair().privateKey,
  loginKey = keypair().privateKey;
const hostParsed = ssh2.utils.parseKey(hostKey) as ssh2.ParsedKey;
const loginParsed = ssh2.utils.parseKey(loginKey) as ssh2.ParsedKey;
const hostFingerprint = fingerprint(hostParsed.getPublicSSH());
async function until(fn: () => unknown, label = "condition") {
  for (let n = 0; n < 300; n++) {
    if (await fn()) return;
    await new Promise((r) => setTimeout(r, 10));
  }
  throw new Error("Timed out: " + label);
}
async function fixture() {
  const downstream = new Set<Connection>();
  const shells: ServerChannel[] = [],
    inputs: Buffer[] = [],
    sizes: any[] = [];
  let authentications = 0;
  const targetServer = new ssh2.Server({ hostKeys: [hostKey] }, (client) => {
    downstream.add(client);
    client.on("error", () => {});
    client.on("close", () => downstream.delete(client));
    client.on("authentication", (ctx) => {
      authentications++;
      if (
        ctx.method === "publickey" &&
        ctx.username === "linux-user" &&
        ctx.key.data.equals(loginParsed.getPublicSSH()) &&
        (!ctx.signature ||
          loginParsed.verify(ctx.blob!, ctx.signature, ctx.hashAlgo) === true)
      )
        ctx.accept();
      else ctx.reject();
    });
    client.on("session", (accept) => {
      const session = accept();
      session.on("pty", (accept, _reject, info) => {
        sizes.push(info);
        accept?.();
      });
      session.on("window-change", (accept, _reject, info) => {
        sizes.push(info);
        accept?.();
      });
      session.on("shell", (accept) => {
        const stream = accept();
        shells.push(stream);
        stream.on("error", () => {});
        stream.on("data", (chunk: Buffer) => {
          inputs.push(chunk);
          if (chunk.toString().includes("exit")) {
            stream.write("TARGET_END\r\n");
            stream.exit(0);
            stream.end();
          } else if (chunk.toString().includes("output"))
            stream.write("TARGET_OUTPUT 中文\r\n");
        });
        stream.write("TARGET_SSH_READY\r\n");
      });
    });
  });
  await new Promise<void>((resolve) =>
    targetServer.listen(0, "127.0.0.1", resolve),
  );
  const ssh = {
    host: "127.0.0.1",
    port: (targetServer.address() as any).port,
    username: "linux-user",
    fingerprint: hostFingerprint,
  };
  const config = {
    dataDir: mkdtempSync(join(root, "data-")),
    tlsCert: join(root, "tls/server.crt"),
    tlsKey: join(root, "tls/server.key"),
    adminUsername: "admin",
    adminPassword: "connection-test-password",
    ssh: { host: "127.0.0.1", port: 0 },
  };
  const s = await buildServer(config);
  await s.app.listen({ host: "127.0.0.1", port: 0 });
  const origin = `https://localhost:${(s.app.server.address() as any).port}`;
  async function api(method: string, path: string, body?: any, auth = admin) {
    const response = await s.app.inject({
      method: method as any,
      url: "/api/v1" + path,
      payload: body,
      headers: auth ? { authorization: "Bearer " + auth } : {},
    });
    return { status: response.statusCode, body: response.json() };
  }
  let admin = "";
  const login = async (username: string) =>
    (
      await api(
        "POST",
        "/login",
        { username, password: "connection-test-password" },
        "",
      )
    ).body.access_token as string;
  admin = await login("admin");
  const created = await api("POST", "/ssh-devices", {
    v: 1,
    name: "SSH only",
    ssh,
    private_key: loginKey,
  });
  assert.equal(created.status, 200, JSON.stringify(created.body));
  const id = created.body.device_id;
  const path = `/devices/${id}/connection`;
  const browsers: WebSocket[] = [],
    clients: ssh2.Client[] = [];
  async function web(auth = admin) {
    const created = await api(
      "POST",
      "/terminal-sessions",
      { v: 1, device_id: id, cols: 100, rows: 32 },
      auth,
    );
    assert.equal(created.status, 200, JSON.stringify(created.body));
    const ws = new WebSocket(
      origin.replace("https:", "wss:") + "/api/v1/terminal/ws",
      { ca, headers: { origin } },
    );
    browsers.push(ws);
    const events: any[] = [];
    ws.on("error", () => {});
    ws.on("message", (raw) => events.push(JSON.parse(raw.toString())));
    await once(ws, "open");
    const send = (type: string, body: any) =>
      ws.send(JSON.stringify({ v: 1, type, body }));
    send("terminal.attach", {
      session_id: created.body.session_id,
      ticket: created.body.ticket,
    });
    const wait = async (type: string) => {
      await until(() => events.some((e) => e.type === type), type);
      return events.find((e) => e.type === type).body;
    };
    const output = () =>
      events
        .filter((e) => e.type === "terminal.output")
        .map((e) => Buffer.from(e.body.data, "base64").toString())
        .join("");
    return { ws, send, events, wait, output, id: created.body.session_id };
  }
  async function gateway(username = "admin") {
    const client = new ssh2.Client();
    clients.push(client);
    client.on("error", () => {});
    const ready = once(client, "ready");
    client.connect({
      host: "127.0.0.1",
      port: s.ssh!.info().port,
      username,
      password: "connection-test-password",
      hostVerifier: (raw: Buffer) =>
        fingerprint(raw) === s.ssh!.info().fingerprint,
    });
    await ready;
    const stream = await new Promise<ClientChannel>((resolve, reject) =>
      client.shell({ rows: 24, cols: 80 }, (error, channel) =>
        error ? reject(error) : resolve(channel),
      ),
    );
    let output = "";
    stream.on("data", (data: Buffer) => {
      output += data.toString();
    });
    return { client, stream, output: () => output };
  }
  async function close() {
    for (const ws of browsers) ws.terminate();
    for (const client of clients) client.destroy();
    await s.close();
    for (const client of downstream) client.end();
    await new Promise<void>((resolve) => targetServer.close(() => resolve()));
  }
  return {
    ...s,
    config,
    api,
    login,
    admin,
    id,
    path,
    ssh,
    web,
    gateway,
    shells,
    inputs,
    sizes,
    downstream,
    authentications: () => authentications,
    gatewayInfo: () => s.ssh!.info(),
    close,
  };
}

test("SSH device credentials: admin-only, encrypted and write-only, explicit host pinning and revision checks", async () => {
  const f = await fixture();
  try {
    f.store.seedUser({
      username: "ops",
      password: "connection-test-password",
      role: "ops",
      deviceScope: [f.id],
    });
    const ops = await f.login("ops");
    assert.equal((await f.api("GET", f.path, undefined, ops)).status, 403);
    assert.equal(
      (await f.api("PUT", f.path, { v: 1, revision: 1, ssh: f.ssh }, ops))
        .status,
      403,
    );
    assert.equal(
      (
        await f.api(
          "POST",
          "/ssh/host-key",
          { v: 1, host: f.ssh.host, port: f.ssh.port },
          ops,
        )
      ).status,
      403,
    );
    const scan = await f.api("POST", "/ssh/host-key", {
      v: 1,
      host: f.ssh.host,
      port: f.ssh.port,
    });
    assert.equal(scan.status, 200);
    assert.equal(scan.body.fingerprint, hostFingerprint);
    assert.equal(
      f.authentications(),
      0,
      "Scanning must stop before authentication",
    );
    const checked = await f.api("POST", f.path + "/test", {
      v: 1,
      revision: 1,
    });
    assert.equal(checked.body.ok, true, JSON.stringify(checked.body));
    const stored = f.store.db
      .prepare("SELECT * FROM device_connections WHERE device_id=?")
      .get(f.id)!;
    assert.equal(JSON.stringify(stored).includes("PRIVATE KEY"), false);
    assert.equal(
      JSON.stringify((await f.api("GET", f.path)).body).includes("PRIVATE KEY"),
      false,
    );
    assert.equal(
      statSync(join(f.config.dataDir, "credentials.key")).mode & 0o777,
      0o600,
    );
    assert.equal(
      (await f.api("PUT", f.path, { v: 1, revision: 0, ssh: f.ssh })).status,
      409,
    );
    assert.equal(
      (
        await f.api("PUT", f.path, {
          v: 1,
          revision: 1,
          ssh: { ...f.ssh, host: "host/path" },
        })
      ).status,
      400,
    );
    const wrong = { ...f.ssh, fingerprint: "SHA256:" + "A".repeat(43) };
    assert.equal(
      (await f.api("PUT", f.path, { v: 1, revision: 1, ssh: wrong })).status,
      200,
    );
    const attempts = f.authentications();
    const denied = await f.api("POST", f.path + "/test", { v: 1, revision: 2 });
    assert.equal(denied.body.last_error, "SSH_HOST_KEY_MISMATCH");
    assert.equal(
      f.authentications(),
      attempts,
      "Mismatch must not submit credentials",
    );
    const browser = await f.web();
    assert.equal(
      (await browser.wait("terminal.closed")).reason,
      "SSH_HOST_KEY_MISMATCH",
    );
    assert.equal(f.shells.length, 0);
    assert.equal(
      (await f.api("PUT", f.path, { v: 1, revision: 2, ssh: f.ssh })).status,
      200,
    );
    const view = (await f.api("GET", "/devices")).body.devices.find(
      (d: any) => d.id === f.id,
    );
    assert.equal(view.connection_kind, "ssh");
    assert.equal(view.control_online, false);
    assert.equal(view.terminal_available, true);
    const health = await f.api("PUT", `/devices/${f.id}/health-checks`, {
      v: 1,
      revision: 0,
      checks: [],
    });
    assert.equal(health.body.error, "AGENT_REQUIRED_FOR_HEALTH_CHECKS");
    assert.equal(
      (await f.api("POST", "/commands", { v: 1, device_id: f.id })).body.error,
      "AGENT_REQUIRED_FOR_TASKS",
    );
  } finally {
    await f.close();
  }
});

test("web terminal uses a real SSH protocol target without Agent, records output and resizing, and closes on revoke", async () => {
  const f = await fixture();
  try {
    const browser = await f.web();
    await browser.wait("terminal.ready");
    await until(() => browser.output().includes("TARGET_SSH_READY"));
    assert.equal(f.sizes[0].cols, 100);
    assert.equal(f.sizes[0].rows, 32);
    browser.send("terminal.resize", { cols: 120, rows: 45 });
    browser.send("terminal.input", {
      data: Buffer.from("hidden-password").toString("base64"),
    });
    browser.send("terminal.input", {
      data: Buffer.from("output").toString("base64"),
    });
    await until(() => browser.output().includes("TARGET_OUTPUT 中文"));
    await until(() => f.sizes.some((s) => s.cols === 120 && s.rows === 45));
    const recording = await f.api(
      "GET",
      `/terminal-sessions/${browser.id}/recording`,
    );
    assert.equal(recording.body.session.backend, "ssh");
    assert.equal(recording.body.session.transport, "web");
    const output = recording.body.events
      .filter((e: any) => e.kind === "output")
      .map((e: any) => Buffer.from(e.data.data, "base64").toString())
      .join("");
    assert.ok(output.includes("TARGET_OUTPUT 中文"));
    assert.equal(output.includes("hidden-password"), false);
    assert.equal(
      (await f.api("PUT", f.path, { v: 1, revision: 1, ssh: f.ssh })).body
        .error,
      "CONNECTION_HAS_ACTIVE_SESSIONS",
    );
    browser.send("terminal.input", {
      data: Buffer.from("exit").toString("base64"),
    });
    const closed = await browser.wait("terminal.closed");
    assert.equal(closed.reason, "SHELL_EXIT");
    assert.equal(closed.audit_complete, true);
    const next = await f.web();
    await next.wait("terminal.ready");
    assert.equal(
      (await f.api("POST", `/devices/${f.id}/revoke`, { v: 1 })).status,
      200,
    );
    assert.equal(
      (await next.wait("terminal.closed")).reason,
      "AUTHORIZATION_EXPIRED",
    );
    await until(() => f.downstream.size === 0, "target connection cleanup");
  } finally {
    await f.close();
  }
});

test("SSH gateway selects SSH-only devices, uses shared recordings and rechecks current operator scope", async () => {
  const f = await fixture();
  try {
    f.store.seedUser({
      username: "ops",
      password: "connection-test-password",
      role: "ops",
      deviceScope: [f.id],
    });
    f.store.seedUser({
      username: "outsider",
      password: "connection-test-password",
      role: "ops",
      deviceScope: [],
    });
    const outside = await f.gateway("outsider");
    await until(() => outside.output().includes("暂无可访问设备"));
    assert.equal(outside.output().includes("SSH only"), false);
    outside.stream.write("q\r");
    const gateway = await f.gateway("ops");
    await until(() => gateway.output().includes("SSH · 按需连接"));
    assert.equal(
      f.store.db.prepare("SELECT COUNT(*) n FROM terminal_sessions").get()!.n,
      0,
    );
    gateway.stream.write("1\r");
    await until(() => gateway.output().includes("TARGET_SSH_READY"));
    gateway.stream.write("output");
    await until(() => gateway.output().includes("TARGET_OUTPUT 中文"));
    const session = f.store.db
      .prepare("SELECT * FROM terminal_sessions")
      .get()!;
    assert.equal(session.backend, "ssh");
    assert.equal(session.transport, "ssh");
    assert.ok(Number(session.output_bytes) > 0);
    f.store.db
      .prepare("UPDATE users SET device_scope='[]' WHERE username='ops'")
      .run();
    const closed = once(gateway.stream, "close");
    gateway.stream.write("MUST_NOT_EXECUTE");
    await closed;
    await until(() => f.downstream.size === 0);
    assert.equal(
      Buffer.concat(f.inputs).toString().includes("MUST_NOT_EXECUTE"),
      false,
    );
    const row = f.store.db
      .prepare("SELECT * FROM terminal_sessions WHERE id=?")
      .get(session.id)!;
    assert.equal(row.status, "INTERRUPTED");
  } finally {
    await f.close();
  }
});

test("Agent optional sudo password is preserved/cleared explicitly and is never returned or made usable to operators", async () => {
  const f = await fixture();
  try {
    f.store.db
      .prepare(
        "INSERT INTO devices(id,public_key,name,created_at) VALUES('agent-device','agent-key','Agent',?)",
      )
      .run(Date.now());
    const path = "/devices/agent-device/connection";
    const secret = "sudo-password-to-keep-private";
    const saved = await f.api("PUT", path, {
      v: 1,
      revision: 0,
      sudo_password: secret,
    });
    assert.equal(saved.body.has_sudo_password, true);
    assert.equal(saved.body.kind, "agent");
    assert.equal(JSON.stringify(saved.body).includes(secret), false);
    assert.equal(
      (await f.api("PUT", path, { v: 1, revision: 1 })).body.has_sudo_password,
      true,
    );
    f.store.seedUser({
      username: "ops",
      password: "connection-test-password",
      role: "ops",
      deviceScope: ["agent-device"],
    });
    assert.equal(
      (await f.api("GET", path, undefined, await f.login("ops"))).status,
      403,
    );
    assert.equal(
      JSON.stringify(f.store.db.prepare("SELECT * FROM audit").all()).includes(
        secret,
      ),
      false,
    );
    const encrypted = f.store.db
      .prepare(
        "SELECT secrets FROM device_connections WHERE device_id='agent-device'",
      )
      .get()!.secrets as string;
    const vault = new Credentials(f.config.dataDir, true);
    assert.equal(vault.open("agent-device", encrypted).sudo_password, secret);
    assert.throws(
      () => vault.open(f.id, encrypted),
      "ciphertext cannot be moved to another device",
    );
    assert.equal(
      (await f.api("PUT", path, { v: 1, revision: 2, sudo_password: null }))
        .body.has_sudo_password,
      false,
    );
    unlinkSync(join(f.config.dataDir, "credentials.key"));
    assert.throws(
      () => new Credentials(f.config.dataDir, true),
      /CREDENTIALS_KEY_MISSING/,
    );
  } finally {
    await f.close();
  }
});

test("encrypted SSH private keys require their passphrase; replacement clears the old passphrase", async () => {
  const f = await fixture();
  try {
    const passphrase = "encrypted-key-passphrase";
    const encrypted = createPrivateKey(loginKey)
      .export({
        type: "pkcs8",
        format: "pem",
        cipher: "aes-256-cbc",
        passphrase,
      })
      .toString();
    assert.equal(
      (
        await f.api("PUT", f.path, {
          v: 1,
          revision: 1,
          ssh: f.ssh,
          private_key: encrypted,
        })
      ).status,
      400,
    );
    const changed = await f.api("PUT", f.path, {
      v: 1,
      revision: 1,
      ssh: f.ssh,
      private_key: encrypted,
      passphrase,
    });
    assert.equal(changed.status, 200);
    assert.equal(changed.body.has_passphrase, true);
    assert.equal(
      (await f.api("POST", f.path + "/test", { v: 1, revision: 2 })).body.ok,
      true,
    );
    const replaced = await f.api("PUT", f.path, {
      v: 1,
      revision: 2,
      ssh: f.ssh,
      private_key: loginKey,
    });
    assert.equal(replaced.body.has_passphrase, false);
    assert.equal(
      (await f.api("POST", f.path + "/test", { v: 1, revision: 3 })).body.ok,
      true,
    );
  } finally {
    await f.close();
  }
});

test("offline backup and restart preserve decryptable credentials, gateway identity and file permissions", async () => {
  const f = await fixture();
  const before = f.gatewayInfo().fingerprint;
  await f.close();
  const destination = f.config.dataDir + "-backup";
  execFileSync(
    "python3",
    [
      "../../scripts/backup.py",
      f.config.dataDir,
      destination,
      "--server-stopped",
    ],
    { stdio: "ignore" },
  );
  for (const entry of JSON.parse(
    readFileSync(join(destination, "backup-manifest.json"), "utf8"),
  )) {
    assert.equal(
      createHash("sha256")
        .update(readFileSync(join(destination, entry.path)))
        .digest("hex"),
      entry.sha256,
    );
  }
  for (const name of [
    "fleet.sqlite",
    "credentials.key",
    "ssh_host_ed25519_key",
  ])
    assert.equal(statSync(join(destination, name)).mode & 0o777, 0o600);
  const restored = await buildServer({ ...f.config, dataDir: destination });
  try {
    assert.equal(restored.ssh!.info().fingerprint, before);
    const login = await restored.app.inject({
      method: "POST",
      url: "/api/v1/login",
      payload: { username: "admin", password: "connection-test-password" },
    });
    const view = await restored.app.inject({
      method: "GET",
      url: "/api/v1" + f.path,
      headers: { authorization: "Bearer " + login.json().access_token },
    });
    assert.equal(view.statusCode, 200);
    assert.equal(view.json().has_private_key, true);
    assert.equal(view.json().ssh.fingerprint, hostFingerprint);
  } finally {
    await restored.close();
  }
});
