import { test } from "node:test";
import assert from "node:assert/strict";
import { createPrivateKey, createHash, generateKeyPairSync } from "node:crypto";
import { mkdtempSync, readFileSync, statSync, unlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { once } from "node:events";
import { createServer as createTcpServer } from "node:net";
import ssh2, {
  type ClientChannel,
  type ServerChannel,
  type Connection,
} from "ssh2";
import { WebSocket } from "ws";
import { buildServer } from "../src/server.js";
import { fingerprint } from "../src/ssh-target.js";
import { Credentials } from "../src/credentials.js";
import { hash, token } from "../src/util.js";

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
test("a managed direct SSH account uses its own username and key with the device's pinned endpoint", async () => {
  const f = await fixture(15000, "root");
  try {
    const account = await f.api("POST", `/devices/${f.id}/accounts`, {
      v: 1,
      name: "Direct root",
      username: "root",
      method: "ssh",
      allowed_users: [],
      private_key: loginKey,
    });
    assert.equal(account.status, 200, JSON.stringify(account.body));
    assert.equal(JSON.stringify(account.body).includes("PRIVATE KEY"), false);
    const terminal = await f.web(f.admin, f.id, account.body.account.id);
    assert.deepEqual(await terminal.wait("terminal.ready"), {
      backend: "ssh",
      username: "root",
    });
    await until(() => terminal.output().includes("TARGET_SSH_READY"));
    terminal.send("terminal.input", {
      data: Buffer.from("output\r").toString("base64"),
    });
    await until(() => terminal.output().includes("TARGET_OUTPUT"));
    terminal.send("terminal.input", {
      data: Buffer.from("exit\r").toString("base64"),
    });
    assert.equal((await terminal.wait("terminal.closed")).reason, "SHELL_EXIT");
    const events = f.store.db
      .prepare("SELECT data FROM terminal_recordings WHERE session_id=?")
      .all(terminal.id);
    assert.ok(JSON.stringify(events).includes(account.body.account.id));
    assert.equal(JSON.stringify(events).includes("PRIVATE KEY"), false);
  } finally {
    await f.close();
  }
});
async function until(fn: () => unknown, label = "condition") {
  for (let n = 0; n < 300; n++) {
    if (await fn()) return;
    await new Promise((r) => setTimeout(r, 10));
  }
  throw new Error("Timed out: " + label);
}
async function fixture(
  heartbeatTimeoutMs = 15000,
  targetUsername = "linux-user",
  targetPassword?: string,
) {
  const downstream = new Set<Connection>();
  const shells: ServerChannel[] = [],
    inputs: Buffer[] = [],
    sizes: any[] = [];
  let authentications = 0;
  const authMethods: string[] = [];
  const targetServer = new ssh2.Server({ hostKeys: [hostKey] }, (client) => {
    downstream.add(client);
    client.on("error", () => {});
    client.on("close", () => downstream.delete(client));
    client.on("authentication", (ctx) => {
      authentications++;
      authMethods.push(ctx.method);
      if (
        ctx.method === "password" &&
        targetPassword !== undefined &&
        ctx.username === targetUsername &&
        ctx.password === targetPassword
      ) {
        ctx.accept();
        return;
      }
      if (
        ctx.method === "publickey" &&
        ctx.username === targetUsername &&
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
    auth_method: "private_key",
    fingerprint: hostFingerprint,
  };
  const config = {
    dataDir: mkdtempSync(join(root, "data-")),
    tlsCert: join(root, "tls/server.crt"),
    tlsKey: join(root, "tls/server.key"),
    heartbeatTimeoutMs,
    adminUsername: "admin",
    adminPassword: "connection-test-password1",
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
        { username, password: "connection-test-password1" },
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
  async function web(
    auth = admin,
    targetId = id,
    accountId?: string,
    connectionMode?: "normal" | "root",
  ) {
    const created = await api(
      "POST",
      "/terminal-sessions",
      {
        v: 1,
        device_id: targetId,
        cols: 100,
        rows: 32,
        ...(accountId ? { account_id: accountId } : {}),
        ...(connectionMode ? { connection_mode: connectionMode } : {}),
      },
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
      password: "connection-test-password1",
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
  async function agent(id: string, terminal = true) {
    const access = token();
    s.store.db
      .prepare(
        "INSERT INTO device_tokens(token_hash,device_id,expires_at,scope) VALUES(?,?,?,'agent-control-output')",
      )
      .run(hash(access), id, Date.now() + 60000);
    const ws = new WebSocket(origin.replace("https:", "wss:") + "/agent/ws", {
      ca,
      headers: { authorization: "Bearer " + access },
    });
    browsers.push(ws);
    ws.on("error", () => {});
    const send = (type: string, body: unknown) =>
      ws.send(JSON.stringify({ v: 1, type, body }));
    ws.on("message", (raw) => {
      const m = JSON.parse(String(raw));
      if (m.type === "terminal.open") {
        send("terminal.opened", { session_id: m.body.session_id });
        send("terminal.output", {
          session_id: m.body.session_id,
          seq: 1,
          data: Buffer.from("AGENT_PRIMARY_READY\r\n").toString("base64"),
        });
      }
    });
    await once(ws, "open");
    send("agent.hello", {
      agent_version: "dual-channel-test-double",
      capabilities: terminal ? ["terminal.pty.v1"] : [],
    });
    await until(
      async () =>
        (await api("GET", "/devices")).body.devices.find(
          (d: any) => d.id === id,
        )?.control_online,
    );
    return ws;
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
    agent,
    gateway,
    shells,
    inputs,
    sizes,
    downstream,
    authentications: () => authentications,
    authMethods,
    gatewayInfo: () => s.ssh!.info(),
    close,
  };
}

test("SSH device credentials: admin-only, encrypted and write-only, explicit host pinning and revision checks", async () => {
  const f = await fixture();
  try {
    f.store.seedUser({
      username: "ops",
      password: "connection-test-password1",
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
      password: "connection-test-password1",
      role: "ops",
      deviceScope: [f.id],
    });
    f.store.seedUser({
      username: "outsider",
      password: "connection-test-password1",
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
      password: "connection-test-password1",
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
      payload: { username: "admin", password: "connection-test-password1" },
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

test("one Agent identity can configure, test, preserve and remove encrypted SSH backup independently of sudo and permissions", async () => {
  const f = await fixture();
  try {
    const id = "hybrid",
      path = `/devices/${id}/connection`;
    f.store.db
      .prepare(
        "INSERT INTO devices(id,public_key,name,created_at) VALUES(?,'hybrid-public-key','Hybrid Linux',1)",
      )
      .run(id);
    f.store.seedUser({
      username: "ops",
      password: "connection-test-password1",
      role: "ops",
      deviceScope: [id],
    });
    const ops = await f.login("ops");
    assert.equal(
      (
        await f.api(
          "PUT",
          path,
          { v: 1, revision: 0, ssh: f.ssh, private_key: loginKey },
          ops,
        )
      ).status,
      403,
    );
    assert.equal(
      (await f.api("PUT", path, { v: 1, revision: 0, ssh: f.ssh })).status,
      400,
    );
    const saved = await f.api("PUT", path, {
      v: 1,
      revision: 0,
      ssh: f.ssh,
      private_key: loginKey,
      sudo_password: "sudo-secret",
    });
    assert.equal(saved.status, 200);
    assert.equal(saved.body.kind, "agent");
    assert.equal(saved.body.has_private_key, true);
    assert.equal(saved.body.has_sudo_password, true);
    assert.deepEqual(saved.body.ssh, f.ssh);
    assert.equal(
      (await f.api("POST", path + "/test", { v: 1, revision: 1 })).body.ok,
      true,
    );
    const preserve = await f.api("PUT", path, {
      v: 1,
      revision: 1,
      sudo_password: "new-sudo-secret",
    });
    assert.deepEqual(preserve.body.ssh, f.ssh);
    assert.equal(preserve.body.has_private_key, true);
    const row = f.store.db
      .prepare("SELECT * FROM device_connections WHERE device_id=?")
      .get(id)!;
    assert.equal(JSON.stringify(row).includes("PRIVATE KEY"), false);
    const vault = new Credentials(f.config.dataDir, true);
    assert.equal(vault.open(id, String(row.secrets)).private_key, loginKey);
    assert.equal(
      vault.open(id, String(row.secrets)).sudo_password,
      "new-sudo-secret",
    );
    const visible = (await f.api("GET", "/devices", undefined, ops)).body
      .devices;
    assert.equal(visible.length, 1);
    assert.equal(visible[0].id, id);
    assert.equal(visible[0].connection_kind, "agent");
    assert.equal(visible[0].ssh_configured, true);
    assert.equal(visible[0].terminal_backend, "ssh");
    assert.equal(visible[0].control_online, false);
    assert.equal(visible[0].terminal_available, true);
    for (const value of [
      saved.body,
      visible,
      f.store.db.prepare("SELECT * FROM audit").all(),
    ]) {
      assert.equal(JSON.stringify(value).includes("PRIVATE KEY"), false);
      assert.equal(JSON.stringify(value).includes("sudo-secret"), false);
    }
    assert.equal((await f.api("GET", path, undefined, ops)).status, 403);
    const removed = await f.api("PUT", path, { v: 1, revision: 2, ssh: null });
    assert.equal(removed.status, 200);
    assert.equal(removed.body.ssh, null);
    assert.equal(removed.body.has_private_key, false);
    assert.equal(removed.body.has_sudo_password, true);
    assert.deepEqual(
      vault.open(
        id,
        String(
          f.store.db
            .prepare("SELECT secrets FROM device_connections WHERE device_id=?")
            .get(id)!.secrets,
        ),
      ),
      { sudo_password: "new-sudo-secret" },
    );
    assert.equal(
      (
        await f.api("POST", "/terminal-sessions", {
          v: 1,
          device_id: id,
          cols: 80,
          rows: 24,
        })
      ).body.error,
      "DEVICE_OFFLINE",
    );
    assert.equal(
      f.store.db.prepare("SELECT COUNT(*) n FROM devices").get()!.n,
      2,
    );
    assert.equal(
      f.store.db.prepare("SELECT public_key FROM devices WHERE id=?").get(id)!
        .public_key,
      "hybrid-public-key",
    );
  } finally {
    await f.close();
  }
});

test("web and gateway prefer Agent, fall back on new connections, preserve existing SSH sessions after recovery and enforce the same device scope and recording", async () => {
  const f = await fixture();
  try {
    const id = "hybrid",
      path = `/devices/${id}/connection`;
    f.store.db
      .prepare(
        "INSERT INTO devices(id,public_key,name,created_at) VALUES(?,'hybrid-public-key','Hybrid Linux',1)",
      )
      .run(id);
    await f.api("PUT", path, {
      v: 1,
      revision: 0,
      ssh: f.ssh,
      private_key: loginKey,
    });
    f.store.seedUser({
      username: "ops",
      password: "connection-test-password1",
      role: "ops",
      deviceScope: [id],
    });
    f.store.seedUser({
      username: "outsider",
      password: "connection-test-password1",
      role: "ops",
      deviceScope: [],
    });
    const ops = await f.login("ops"),
      outsider = await f.login("outsider");
    assert.equal(
      (
        await f.api(
          "POST",
          "/terminal-sessions",
          { v: 1, device_id: id, cols: 80, rows: 24 },
          outsider,
        )
      ).status,
      403,
    );
    const primary = await f.agent(id);
    const web = await f.web(ops, id);
    assert.equal((await web.wait("terminal.ready")).backend, "agent");
    await until(() => web.output().includes("AGENT_PRIMARY_READY"));
    const direct = await f.gateway("ops:" + id);
    await until(() => direct.output().includes("AGENT_PRIMARY_READY"));
    assert.equal(
      f.shells.length,
      0,
      "Online Agent never authenticates to target SSH",
    );
    primary.terminate();
    await web.wait("terminal.closed");
    await until(
      async () =>
        !(await f.api("GET", "/devices")).body.devices.find(
          (d: any) => d.id === id,
        ).control_online,
    );
    // An unresolved Agent upgrade must not block the independent recovery channel.
    f.store.db
      .prepare(
        "INSERT INTO agent_upgrade_batches(id,actor_id,request_json,concurrency,created_at) SELECT 'test-batch',id,'{}',1,? FROM users WHERE username='admin'",
      )
      .run(Date.now());
    f.store.db
      .prepare(
        "INSERT INTO agent_upgrades(id,batch_id,device_id,arch,sha256,size,version,status,created_at,updated_at) VALUES('test-upgrade','test-batch',?,'aarch64',?,128,'0.2.1','UNKNOWN',?,?)",
      )
      .run(id, "a".repeat(64), Date.now(), Date.now());
    const backup = await f.web(ops, id);
    assert.equal((await backup.wait("terminal.ready")).backend, "ssh");
    await until(() => backup.output().includes("TARGET_SSH_READY"));
    const menu = await f.gateway("ops");
    await until(() => menu.output().includes("备用 SSH · 按需连接"));
    assert.equal((menu.output().match(/Hybrid Linux/g) ?? []).length, 1);
    menu.stream.write("1\r");
    await until(() => menu.output().includes("TARGET_SSH_READY"));
    f.store.db
      .prepare(
        "UPDATE agent_upgrades SET status='FAILED' WHERE id='test-upgrade'",
      )
      .run();
    await f.agent(id);
    backup.send("terminal.input", {
      data: Buffer.from("output").toString("base64"),
    });
    await until(() => backup.output().includes("TARGET_OUTPUT 中文"));
    const recovered = await f.web(f.admin, id);
    assert.equal((await recovered.wait("terminal.ready")).backend, "agent");
    const sessions = (
      await f.api("GET", "/terminal-sessions")
    ).body.sessions.filter((s: any) => s.device_id === id);
    assert.deepEqual(
      new Set(sessions.map((s: any) => s.transport + ":" + s.backend)),
      new Set(["web:agent", "ssh:agent", "web:ssh", "ssh:ssh"]),
    );
    const recording = (
      await f.api(
        "GET",
        `/terminal-sessions/${backup.id}/recording`,
        undefined,
        ops,
      )
    ).body;
    assert.equal(recording.session.device_id, id);
    assert.equal(recording.session.backend, "ssh");
    assert.ok(
      recording.events.some(
        (e: any) =>
          e.kind === "output" &&
          Buffer.from(e.data.data, "base64")
            .toString()
            .includes("TARGET_OUTPUT"),
      ),
    );
    assert.equal(
      (
        await f.api(
          "GET",
          `/terminal-sessions/${backup.id}/recording`,
          undefined,
          outsider,
        )
      ).status,
      403,
    );
    assert.equal(
      (await f.api("PUT", path, { v: 1, revision: 1, ssh: null })).body.error,
      "CONNECTION_HAS_ACTIVE_SESSIONS",
    );
    f.store.db
      .prepare("UPDATE users SET device_scope='[]' WHERE username='ops'")
      .run();
    backup.send("terminal.input", {
      data: Buffer.from("MUST_NOT_EXECUTE").toString("base64"),
    });
    await backup.wait("terminal.closed");
    assert.equal(
      Buffer.concat(f.inputs).toString().includes("MUST_NOT_EXECUTE"),
      false,
    );
    await f.api("POST", `/devices/${id}/revoke`, { v: 1 });
    await recovered.wait("terminal.closed");
    assert.equal(
      (
        await f.api("POST", "/terminal-sessions", {
          v: 1,
          device_id: id,
          cols: 80,
          rows: 24,
        })
      ).status,
      403,
    );
    assert.equal(
      f.store.db.prepare("SELECT COUNT(*) n FROM devices").get()!.n,
      2,
    );
  } finally {
    await f.close();
  }
});

test("unsupported or expired Agent falls back to SSH and pin mismatch is rejected without sending credentials", async () => {
  const f = await fixture(1000);
  try {
    const id = "hybrid",
      path = `/devices/${id}/connection`;
    f.store.db
      .prepare(
        "INSERT INTO devices(id,public_key,name,created_at) VALUES(?,'hybrid-key','Hybrid',1)",
      )
      .run(id);
    await f.api("PUT", path, {
      v: 1,
      revision: 0,
      ssh: { ...f.ssh, fingerprint: "SHA256:" + "A".repeat(43) },
      private_key: loginKey,
    });
    const agent = await f.agent(id, false);
    const before = f.authentications();
    const denied = await f.web(f.admin, id);
    assert.equal(
      (await denied.wait("terminal.closed")).reason,
      "SSH_HOST_KEY_MISMATCH",
    );
    assert.equal(f.authentications(), before);
    agent.terminate();
    await until(() => agent.readyState === WebSocket.CLOSED);
    await f.api("PUT", path, { v: 1, revision: 1, ssh: f.ssh });
    await f.agent(id);
    await until(
      async () =>
        (await f.api("GET", "/devices")).body.devices.find(
          (d: any) => d.id === id,
        ).terminal_backend === "ssh",
    );
    const fallback = await f.web(f.admin, id);
    assert.equal((await fallback.wait("terminal.ready")).backend, "ssh");
  } finally {
    await f.close();
  }
});

test("global network policy uses each machine IP, retains SSH fallback and recordings, and forbids public in private-only", async () => {
  const f = await fixture();
  try {
    const routePath = `/devices/${f.id}/network-route`,
      settingsPath = "/settings/network";
    f.store.seedUser({
      username: "route-user",
      password: "connection-test-password1",
      role: "ops",
      deviceScope: [f.id],
    });
    f.store.seedUser({
      username: "route-denied",
      password: "connection-test-password1",
      role: "ops",
      deviceScope: [],
    });
    const user = await f.login("route-user"),
      denied = await f.login("route-denied");
    const common = {
      enabled: true,
      mode: "vpn_preferred",
      agent: { vpn_url: "https://10.1.1.1", public_url: null },
    };
    assert.equal(
      (await f.api("GET", routePath, undefined, denied)).status,
      403,
    );
    assert.equal(
      (
        await f.api(
          "PUT",
          settingsPath,
          { v: 1, revision: 0, settings: common },
          user,
        )
      ).status,
      403,
    );
    assert.equal(
      (
        await f.api(
          "PUT",
          routePath,
          { v: 1, revision: 0, vpn_ip: "127.0.0.1", ssh_port: f.ssh.port },
          user,
        )
      ).status,
      403,
    );
    assert.equal(
      (
        await f.api("PUT", settingsPath, {
          v: 1,
          revision: 0,
          settings: common,
        })
      ).status,
      200,
    );
    const primary = await f.web(user);
    await primary.wait("terminal.ready");
    assert.equal(
      (
        await f.api("PUT", settingsPath, {
          v: 1,
          revision: 1,
          settings: { ...common, mode: "private_only" },
        })
      ).status,
      409,
    );
    primary.send("terminal.input", {
      data: Buffer.from("output\n").toString("base64"),
    });
    await until(() => primary.output().includes("TARGET_OUTPUT"));
    await f.api(
      "POST",
      `/terminal-sessions/${primary.id}/close`,
      { v: 1 },
      user,
    );
    const unused = createTcpServer();
    await new Promise<void>((r) => unused.listen(0, "127.0.0.1", r));
    const port = (unused.address() as any).port;
    await new Promise<void>((r) => unused.close(() => r()));
    assert.equal(
      (
        await f.api("PUT", routePath, {
          v: 1,
          revision: 0,
          vpn_ip: "127.0.0.1",
          ssh_port: port,
        })
      ).status,
      200,
    );
    const fallback = await f.web(user);
    await fallback.wait("terminal.ready");
    fallback.send("terminal.input", {
      data: Buffer.from("output\n").toString("base64"),
    });
    await until(() => fallback.output().includes("TARGET_OUTPUT"));
    await f.api(
      "POST",
      `/terminal-sessions/${fallback.id}/close`,
      { v: 1 },
      user,
    );
    const rec = (
      await f.api(
        "GET",
        `/terminal-sessions/${fallback.id}/recording`,
        undefined,
        user,
      )
    ).body;
    assert.ok(
      rec.events.some(
        (e: any) =>
          e.kind === "output" &&
          Buffer.from(e.data.data, "base64")
            .toString()
            .includes("TARGET_OUTPUT"),
      ),
    );
    assert.equal((await f.api("GET", routePath)).body.ssh.channel, "public");
    const before = f.authentications();
    assert.equal(
      (
        await f.api("PUT", settingsPath, {
          v: 1,
          revision: 1,
          settings: { ...common, mode: "private_only" },
        })
      ).status,
      200,
    );
    const blocked = await f.web(user);
    await blocked.wait("terminal.closed");
    assert.equal(f.authentications(), before);
    assert.equal(
      (
        await f.api("PUT", routePath, {
          v: 1,
          revision: 1,
          vpn_ip: "127.0.0.1",
          ssh_port: f.ssh.port,
        })
      ).status,
      200,
    );
    const gateway = await f.gateway(`admin:${f.id}`);
    await until(() => gateway.output().includes("TARGET_SSH_READY"));
    gateway.stream.write("exit\n");
    await until(() =>
      f.store.db
        .prepare(
          "SELECT 1 FROM terminal_sessions WHERE device_id=? AND transport='ssh' AND ended_at IS NOT NULL",
        )
        .get(f.id),
    );
    assert.equal(
      (
        await f.api("PUT", f.path, {
          v: 1,
          revision: 1,
          ssh: { ...f.ssh, fingerprint: "SHA256:" + "B".repeat(43) },
        })
      ).status,
      200,
    );
    const bad = await f.web(user);
    assert.equal(
      (await bad.wait("terminal.closed")).reason,
      "SSH_HOST_KEY_MISMATCH",
    );
  } finally {
    await f.close();
  }
});

test("simple root mode uses the default root SSH key and rechecks privilege permission on an active direct connection", async () => {
  const f = await fixture(15000, "root");
  try {
    const config = await f.api("PUT", f.path, {
      v: 1,
      revision: 1,
      ssh: { ...f.ssh, username: "root" },
    });
    assert.equal(config.status, 200, JSON.stringify(config));
    const user = f.store.seedUser({
      username: "root-ssh-ops",
      password: "connection-test-password1",
      role: "ops",
      deviceScope: [f.id],
    });
    const auth = await f.login(user.username);
    const rejected = await f.api(
      "POST",
      "/terminal-sessions",
      { v: 1, device_id: f.id, cols: 80, rows: 24, connection_mode: "root" },
      auth,
    );
    assert.equal(rejected.body.error, "SUDO_PERMISSION_REQUIRED");
    const permissions = f.store.db
      .prepare("SELECT permissions FROM access_roles WHERE id='ops'")
      .get()!.permissions as string;
    f.store.db
      .prepare("UPDATE access_roles SET permissions=? WHERE id='ops'")
      .run(JSON.stringify([...JSON.parse(permissions), "terminal.sudo"]));
    const terminal = await f.web(auth, f.id, undefined, "root");
    assert.deepEqual(await terminal.wait("terminal.ready"), {
      backend: "ssh",
      username: "root",
    });
    await until(() => terminal.output().includes("TARGET_SSH_READY"));
    assert.equal(
      f.store.db.prepare("SELECT count(*) AS n FROM target_accounts").get()!.n,
      0,
    );
    f.store.db
      .prepare("UPDATE access_roles SET permissions=? WHERE id='ops'")
      .run(permissions);
    assert.equal(
      (await terminal.wait("terminal.closed")).reason,
      "AUTHORIZATION_EXPIRED",
    );
    await until(() => f.downstream.size === 0);
  } finally {
    await f.close();
  }
});

test("password SSH devices authenticate through web and gateway, keep secrets private, and reject wrong passwords and untrusted hosts", async () => {
  const password = "  ssh-only-密码'$\\ secret  ";
  const f = await fixture(15000, "linux-user", password);
  try {
    const created = await f.api("POST", "/ssh-devices", {
      v: 1,
      name: "Password SSH",
      ssh: { ...f.ssh, auth_method: "password" },
      ssh_password: password,
    });
    assert.equal(created.status, 200, JSON.stringify(created.body));
    const id = created.body.device_id,
      path = `/devices/${id}/connection`;
    assert.equal(created.body.has_ssh_password, true);
    assert.equal(created.body.has_private_key, false);
    assert.equal(created.body.has_passphrase, false);
    assert.equal(JSON.stringify(created.body).includes(password), false);
    const stored = f.store.db
      .prepare("SELECT * FROM device_connections WHERE device_id=?")
      .get(id)!;
    assert.equal(JSON.stringify(stored).includes("ssh-only-"), false);
    assert.equal(
      new Credentials(f.config.dataDir, true).open(id, stored.secrets as string)
        .ssh_password,
      password,
    );
    f.store.seedUser({
      username: "password-ops",
      password: "connection-test-password1",
      role: "ops",
      deviceScope: [id],
    });
    const ops = await f.login("password-ops");
    assert.equal((await f.api("GET", path, undefined, ops)).status, 403);
    assert.equal(
      (
        await f.api(
          "PUT",
          path,
          { v: 1, revision: 1, ssh_password: "overwrite" },
          ops,
        )
      ).status,
      403,
    );
    assert.equal(
      (
        await f.api(
          "POST",
          "/ssh-devices",
          {
            v: 1,
            name: "Denied",
            ssh: { ...f.ssh, auth_method: "password" },
            ssh_password: password,
          },
          ops,
        )
      ).status,
      403,
    );
    assert.equal(
      (await f.api("POST", path + "/test", { v: 1, revision: 1 })).body.ok,
      true,
    );
    const terminal = await f.web(ops, id);
    assert.equal((await terminal.wait("terminal.ready")).backend, "ssh");
    await until(() => terminal.output().includes("TARGET_SSH_READY"));
    terminal.send("terminal.input", {
      data: Buffer.from("output\r").toString("base64"),
    });
    await until(() => terminal.output().includes("TARGET_OUTPUT"));
    assert.equal(
      (
        await f.api("PUT", path, {
          v: 1,
          revision: 1,
          ssh_password: "overwrite",
        })
      ).body.error,
      "CONNECTION_HAS_ACTIVE_SESSIONS",
    );
    await f.api(
      "POST",
      `/terminal-sessions/${terminal.id}/close`,
      { v: 1 },
      ops,
    );
    await terminal.wait("terminal.closed");
    const gateway = await f.gateway(`password-ops:${id}`);
    await until(() => gateway.output().includes("TARGET_SSH_READY"));
    gateway.stream.write("exit\r");
    await until(
      () =>
        f.store.db
          .prepare(
            "SELECT 1 FROM terminal_sessions WHERE device_id=? AND ended_at IS NULL",
          )
          .get(id) === undefined,
    );
    assert.deepEqual(new Set(f.authMethods), new Set(["password"]));
    const recording = (
      await f.api(
        "GET",
        `/terminal-sessions/${terminal.id}/recording`,
        undefined,
        ops,
      )
    ).body;
    assert.equal(JSON.stringify(recording).includes("ssh-only-"), false);
    assert.equal(
      JSON.stringify(f.store.db.prepare("SELECT * FROM audit").all()).includes(
        "ssh-only-",
      ),
      false,
    );
    // An older client omitting the method and password must preserve both.
    const { auth_method: _, ...legacySsh } = f.ssh;
    const saved = await f.api("PUT", path, {
      v: 1,
      revision: 1,
      ssh: legacySsh,
    });
    assert.equal(saved.body.ssh.auth_method, "password");
    assert.equal(
      (await f.api("POST", path + "/test", { v: 1, revision: 2 })).body.ok,
      true,
    );
    assert.equal(
      (await f.api("PUT", path, { v: 1, revision: 1, ssh_password: "wrong" }))
        .status,
      409,
    );
    assert.equal(
      (await f.api("PUT", path, { v: 1, revision: 2, ssh_password: "wrong" }))
        .status,
      200,
    );
    assert.equal(
      (await f.api("POST", path + "/test", { v: 1, revision: 3 })).body
        .last_error,
      "SSH_AUTH_FAILED",
    );
    const failed = await f.web(ops, id);
    assert.equal(
      (await failed.wait("terminal.closed")).reason,
      "SSH_AUTH_FAILED",
    );
    assert.deepEqual(new Set(f.authMethods), new Set(["password"]));
    // A separate key-based account must not inherit the default password method.
    const account = await f.api("POST", `/devices/${id}/accounts`, {
      v: 1,
      name: "Own key",
      username: "linux-user",
      method: "ssh",
      allowed_users: [],
      private_key: loginKey,
    });
    assert.equal(account.status, 200);
    const own = await f.web(f.admin, id, account.body.account.id);
    await own.wait("terminal.ready");
    await until(() => own.output().includes("TARGET_SSH_READY"));
    assert.ok(f.authMethods.includes("publickey"));
    await f.api("POST", `/terminal-sessions/${own.id}/close`, { v: 1 });
    await own.wait("terminal.closed");
    await f.api("PUT", path, {
      v: 1,
      revision: 3,
      ssh: { ...legacySsh, fingerprint: "SHA256:" + "A".repeat(43) },
      ssh_password: password,
    });
    const attempts = f.authentications();
    assert.equal(
      (await f.api("POST", path + "/test", { v: 1, revision: 4 })).body
        .last_error,
      "SSH_HOST_KEY_MISMATCH",
    );
    const untrusted = await f.web(ops, id);
    assert.equal(
      (await untrusted.wait("terminal.closed")).reason,
      "SSH_HOST_KEY_MISMATCH",
    );
    assert.equal(
      f.authentications(),
      attempts,
      "Never send a password before verifying the host key",
    );
  } finally {
    await f.close();
  }
});

test("SSH authentication changes validate the selected credentials atomically and discard the previous method's secrets", async () => {
  const f = await fixture();
  try {
    const passwordSsh = { ...f.ssh, auth_method: "password" };
    const invalid = [
      { ssh: passwordSsh },
      { ssh: passwordSsh, ssh_password: "" },
      { ssh: passwordSsh, ssh_password: null },
      { ssh: passwordSsh, ssh_password: 123 },
      { ssh: passwordSsh, ssh_password: "a".repeat(1025) },
      { ssh: passwordSsh, ssh_password: "secret", private_key: loginKey },
      { ssh: passwordSsh, ssh_password: "secret", passphrase: null },
      { ssh: { ...f.ssh, auth_method: "unknown" }, private_key: loginKey },
      { ssh: { ...f.ssh, auth_method: null }, private_key: loginKey },
      { ssh: f.ssh, ssh_password: "secret" },
    ];
    for (const payload of invalid) {
      const result = await f.api("PUT", f.path, {
        v: 1,
        revision: 1,
        ...payload,
      });
      assert.equal(result.status, 400, JSON.stringify(result.body));
    }
    assert.equal((await f.api("GET", f.path)).body.revision, 1);
    const password = "selected-password";
    const changed = await f.api("PUT", f.path, {
      v: 1,
      revision: 1,
      ssh: passwordSsh,
      ssh_password: password,
    });
    assert.equal(changed.status, 200);
    const credentials = () =>
      new Credentials(f.config.dataDir, true).open(
        f.id,
        f.store.db
          .prepare("SELECT secrets FROM device_connections WHERE device_id=?")
          .get(f.id)!.secrets as string,
      );
    assert.deepEqual(credentials(), { ssh_password: password });
    assert.equal(
      (await f.api("PUT", f.path, { v: 1, revision: 2, ssh: f.ssh })).body
        .error,
      "SSH_PRIVATE_KEY_REQUIRED",
    );
    assert.deepEqual(credentials(), { ssh_password: password });
    const keypair = generateKeyPairSync("rsa", {
      modulusLength: 2048,
      privateKeyEncoding: {
        type: "pkcs1",
        format: "pem",
        cipher: "aes-256-cbc",
        passphrase: "key-only-passphrase",
      },
      publicKeyEncoding: { type: "spki", format: "pem" },
    });
    const keySaved = await f.api("PUT", f.path, {
      v: 1,
      revision: 2,
      ssh: f.ssh,
      private_key: keypair.privateKey,
      passphrase: "key-only-passphrase",
    });
    assert.equal(keySaved.status, 200);
    assert.equal(keySaved.body.has_ssh_password, false);
    assert.equal(credentials().ssh_password, undefined);
    assert.equal(credentials().passphrase, "key-only-passphrase");
    assert.equal(
      (await f.api("PUT", f.path, { v: 1, revision: 3, ssh: passwordSsh })).body
        .error,
      "SSH_PASSWORD_REQUIRED",
    );
    const switched = await f.api("PUT", f.path, {
      v: 1,
      revision: 3,
      ssh: passwordSsh,
      ssh_password: password,
    });
    assert.equal(switched.status, 200);
    assert.deepEqual(credentials(), { ssh_password: password });
    assert.equal(
      (await f.api("PUT", f.path, { v: 1, revision: 4, ssh: null })).status,
      400,
    );
    // Legacy on-disk configuration without auth_method still uses its original key.
    await f.api("PUT", f.path, {
      v: 1,
      revision: 4,
      ssh: f.ssh,
      private_key: loginKey,
    });
    const { auth_method: _, ...legacy } = f.ssh;
    f.store.db
      .prepare("UPDATE device_connections SET config_json=? WHERE device_id=?")
      .run(JSON.stringify(legacy), f.id);
    assert.equal(
      (await f.api("POST", f.path + "/test", { v: 1, revision: 5 })).body.ok,
      true,
    );
  } finally {
    await f.close();
  }
});

test("password backup SSH retains Agent identity and independent sudo secret, follows fallback and removes only SSH credentials", async () => {
  const password = "backup-SSH-password";
  const f = await fixture(15000, "linux-user", password);
  try {
    const id = "password-hybrid",
      path = `/devices/${id}/connection`;
    f.store.db
      .prepare(
        "INSERT INTO devices(id,public_key,name,created_at) VALUES(?,'password-hybrid-key','Password hybrid',1)",
      )
      .run(id);
    const payload = {
      v: 1,
      revision: 0,
      ssh: { ...f.ssh, auth_method: "password" },
      ssh_password: password,
      sudo_password: "independent-sudo-password",
    };
    const saved = await f.api("PUT", path, payload);
    assert.equal(saved.status, 200);
    assert.equal(saved.body.kind, "agent");
    assert.equal(saved.body.has_ssh_password, true);
    assert.equal(saved.body.has_sudo_password, true);
    assert.equal(
      (await f.api("POST", path + "/test", { v: 1, revision: 1 })).body.ok,
      true,
    );
    const agent = await f.agent(id);
    const primary = await f.web(f.admin, id);
    assert.equal((await primary.wait("terminal.ready")).backend, "agent");
    await f.api("POST", `/terminal-sessions/${primary.id}/close`, { v: 1 });
    agent.terminate();
    await until(
      async () =>
        !(await f.api("GET", "/devices")).body.devices.find(
          (d: any) => d.id === id,
        ).control_online,
    );
    const fallback = await f.web(f.admin, id);
    assert.equal((await fallback.wait("terminal.ready")).backend, "ssh");
    await until(() => fallback.output().includes("TARGET_SSH_READY"));
    const gateway = await f.gateway(`admin:${id}`);
    await until(() => gateway.output().includes("TARGET_SSH_READY"));
    gateway.stream.write("exit\r");
    await f.api("POST", `/terminal-sessions/${fallback.id}/close`, { v: 1 });
    await until(
      () =>
        !f.store.db
          .prepare(
            "SELECT 1 FROM terminal_sessions WHERE device_id=? AND ended_at IS NULL",
          )
          .get(id),
    );
    await f.api("PUT", path, {
      v: 1,
      revision: 1,
      sudo_password: "updated-sudo-password",
    });
    assert.equal((await f.api("GET", path)).body.has_ssh_password, true);
    const removed = await f.api("PUT", path, { v: 1, revision: 2, ssh: null });
    assert.equal(removed.status, 200);
    assert.equal(removed.body.ssh, null);
    assert.equal(removed.body.has_ssh_password, false);
    assert.equal(removed.body.has_private_key, false);
    assert.equal(removed.body.has_sudo_password, true);
    const row = f.store.db
      .prepare("SELECT secrets FROM device_connections WHERE device_id=?")
      .get(id)!;
    assert.deepEqual(
      new Credentials(f.config.dataDir, true).open(id, row.secrets as string),
      { sudo_password: "updated-sudo-password" },
    );
    assert.equal(
      (
        await f.api("PUT", path, {
          ...payload,
          revision: 3,
          ssh_password: undefined,
        })
      ).body.error,
      "SSH_PASSWORD_REQUIRED",
    );
    assert.equal(
      (await f.api("PUT", path, { v: 1, revision: 3, ssh_password: password }))
        .status,
      400,
    );
  } finally {
    await f.close();
  }
});

test("password credentials survive server restart without returning plaintext", async () => {
  const f = await fixture();
  const password = "restart-password";
  await f.api("PUT", f.path, {
    v: 1,
    revision: 1,
    ssh: { ...f.ssh, auth_method: "password" },
    ssh_password: password,
  });
  await f.close();
  const restored = await buildServer(f.config);
  try {
    const login = await restored.app.inject({
      method: "POST",
      url: "/api/v1/login",
      payload: { username: "admin", password: "connection-test-password1" },
    });
    const view = await restored.app.inject({
      method: "GET",
      url: "/api/v1" + f.path,
      headers: { authorization: "Bearer " + login.json().access_token },
    });
    assert.equal(view.statusCode, 200);
    assert.equal(view.json().has_ssh_password, true);
    assert.equal(view.json().ssh.auth_method, "password");
    assert.equal(view.body.includes(password), false);
    const row = restored.store.db
      .prepare("SELECT secrets FROM device_connections WHERE device_id=?")
      .get(f.id)!;
    assert.equal(
      new Credentials(f.config.dataDir, true).open(f.id, row.secrets as string)
        .ssh_password,
      password,
    );
  } finally {
    await restored.close();
  }
});
