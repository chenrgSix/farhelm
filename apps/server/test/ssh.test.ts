import { test } from "node:test";
import { DatabaseSync } from "node:sqlite";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { once } from "node:events";
import ssh2 from "ssh2";
import type { ClientChannel } from "ssh2";
import { WebSocket } from "ws";
import { buildServer } from "../src/server.js";
import { hash, token } from "../src/util.js";
import {
  seedLegacyAccount,
  seedLegacyGrant,
} from "./legacy-account-fixture.js";
import { AccountAuthorizations } from "../src/account-authorizations.js";
const root = mkdtempSync(join(tmpdir(), "fleet-ssh-test-"));
execFileSync("bash", ["../../deploy/dev/generate-tls.sh", join(root, "tls")], {
  stdio: "ignore",
});
async function until(fn: () => unknown, label: string) {
  for (let i = 0; i < 200; i++) {
    if (fn()) return;
    await new Promise((r) => setTimeout(r, 10));
  }
  throw new Error("Timed out: " + label);
}
async function fixture() {
  const dataDir = mkdtempSync(join(root, "data-"));
  const config = {
    dataDir,
    tlsCert: join(root, "tls/server.crt"),
    tlsKey: join(root, "tls/server.key"),
    adminUsername: "admin",
    adminPassword: "ssh-test-password1",
    ssh: { host: "127.0.0.1", port: 0 },
  };
  const s = await buildServer(config);
  await s.app.listen({ host: "127.0.0.1", port: 0 });
  s.store.db
    .prepare(
      "INSERT INTO devices(id,public_key,name,created_at) VALUES('device','test-key','local-linux',?)",
    )
    .run(Date.now());
  const access = token();
  s.store.db
    .prepare(
      "INSERT INTO device_tokens(token_hash,device_id,expires_at,scope) VALUES(?,'device',?,'agent-control-output')",
    )
    .run(hash(access), Date.now() + 60000);
  const agent = new WebSocket(
    `wss://localhost:${(s.app.server.address() as any).port}/agent/ws`,
    {
      ca: readFileSync(join(root, "tls/ca.crt")),
      headers: { authorization: "Bearer " + access },
    },
  );
  const messages: any[] = [];
  agent.on("message", (raw) => messages.push(JSON.parse(raw.toString())));
  agent.on("error", () => {});
  await once(agent, "open");
  const send = (type: string, body: unknown) =>
    agent.send(JSON.stringify({ v: 1, type, body }));
  send("agent.hello", {
    agent_version: "ssh-test-double",
    capabilities: ["terminal.pty.v1", "terminal.policy.v1"],
  });
  await new Promise((r) => setTimeout(r, 30));
  async function wait(type: string) {
    await until(() => messages.some((m) => m.type === type), type);
    return messages.splice(
      messages.findIndex((m) => m.type === type),
      1,
    )[0].body;
  }
  const clients: ssh2.Client[] = [];
  async function connect(
    username = "admin:device",
    password = "ssh-test-password1",
  ) {
    const c = new ssh2.Client();
    clients.push(c);
    c.on("error", () => {});
    const ready = once(c, "ready");
    c.connect({
      host: "127.0.0.1",
      port: s.ssh!.info().port,
      username,
      password,
      hostVerifier: (raw) =>
        "SHA256:" +
          Buffer.from(hash(raw), "hex")
            .toString("base64")
            .replace(/=+$/, "") ===
        s.ssh!.info().fingerprint,
    });
    await ready;
    return c;
  }
  async function open(username?: string) {
    const client = await connect(username);
    const channel = await new Promise<ClientChannel>((resolve, reject) =>
      client.shell({ cols: 80, rows: 24 }, (err, stream) =>
        err ? reject(err) : resolve(stream),
      ),
    );
    const request = await wait("terminal.open");
    send("terminal.opened", { session_id: request.session_id });
    await wait("terminal.resize");
    return { client, channel, id: request.session_id };
  }
  async function menu(username = "admin") {
    const client = await connect(username);
    const channel = await new Promise<ClientChannel>((resolve, reject) =>
      client.shell({ cols: 80, rows: 24 }, (err, stream) =>
        err ? reject(err) : resolve(stream),
      ),
    );
    channel.setEncoding("utf8");
    let output = "";
    channel.on("data", (data) => {
      output += data;
    });
    const waitText = (text: string) => until(() => output.includes(text), text);
    await waitText("输入设备编号");
    return {
      client,
      channel,
      text: () => output,
      waitText,
      clear() {
        output = "";
      },
    };
  }
  async function close() {
    for (const c of clients) c.destroy();
    agent.terminate();
    await s.close();
  }
  return {
    ...s,
    config,
    dataDir,
    agent,
    send,
    wait,
    messages,
    clients,
    connect,
    open,
    menu,
    close,
  };
}
test("SSH enforces platform password, role, scope, revocation and unambiguous target selection", async () => {
  const f = await fixture();
  try {
    f.store.seedUser({
      username: "business",
      password: "ssh-test-password1",
      role: "business",
      deviceScope: "*",
    });
    f.store.seedUser({
      username: "ops",
      password: "ssh-test-password1",
      role: "ops",
      deviceScope: [],
    });
    for (const name of ["admin:missing", "business:device", "ops:device"])
      await assert.rejects(f.connect(name), /authentication/);
    await assert.rejects(
      f.connect("admin:device", "wrong-password"),
      /authentication/,
    );
    const named = await f.connect("admin:local-linux");
    named.destroy();
    f.store.db
      .prepare(
        "INSERT INTO devices(id,public_key,name,created_at) VALUES('device2','test-key2','local-linux',?)",
      )
      .run(Date.now());
    await assert.rejects(f.connect("admin:local-linux"), /authentication/);
    f.store.db
      .prepare("UPDATE devices SET revoked_at=? WHERE id='device'")
      .run(Date.now());
    await assert.rejects(f.connect(), /authentication/);
    assert.equal(
      f.store.db.prepare("SELECT count(*) n FROM terminal_sessions").get()!.n,
      0,
    );
    assert.ok(
      f.store.db
        .prepare("SELECT id FROM audit WHERE action='authorization.denied'")
        .get(),
    );
    assert.equal(
      statSync(join(f.dataDir, "ssh_host_ed25519_key")).mode & 0o777,
      0o600,
    );
  } finally {
    await f.close();
  }
});
test("SSH shares durable recording, raw input privacy, resize, web close and privilege revocation", async () => {
  const f = await fixture();
  try {
    const { channel, id } = await f.open();
    let output = "";
    channel.on("data", (data) => {
      output += data.toString();
    });
    channel.write("hidden-password\r");
    const input = await f.wait("terminal.input");
    assert.equal(
      Buffer.from(input.data, "base64").toString(),
      "hidden-password\r",
    );
    f.send("terminal.output", {
      session_id: id,
      seq: 1,
      data: Buffer.from("SSH output 中文\r\n").toString("base64"),
    });
    await f.wait("terminal.ack");
    await until(() => output.includes("中文"), "SSH output");
    const events = f.store.db
      .prepare("SELECT kind,data FROM terminal_recordings WHERE session_id=?")
      .all(id);
    assert.ok(events.some((e) => e.kind === "output"));
    assert.equal(JSON.stringify(events).includes("hidden-password"), false);
    channel.setWindow(40, 120, 0, 0);
    assert.deepEqual(await f.wait("terminal.resize"), {
      session_id: id,
      rows: 40,
      cols: 120,
    });
    assert.equal(
      f.store.db
        .prepare("SELECT transport FROM terminal_sessions WHERE id=?")
        .get(id)!.transport,
      "ssh",
    );
    const login = await f.app.inject({
      method: "POST",
      url: "/api/v1/login",
      payload: { username: "admin", password: "ssh-test-password1" },
    });
    const closed = once(channel, "close");
    assert.equal(
      (
        await f.app.inject({
          method: "POST",
          url: `/api/v1/terminal-sessions/${id}/close`,
          headers: { authorization: "Bearer " + login.json().access_token },
          payload: { v: 1 },
        })
      ).statusCode,
      200,
    );
    await closed;
    await f.wait("terminal.close");
    assert.equal(
      f.store.db
        .prepare("SELECT status FROM terminal_sessions WHERE id=?")
        .get(id)!.status,
      "CLOSED",
    );
    f.store.seedUser({
      username: "scoped",
      password: "ssh-test-password1",
      role: "ops",
      deviceScope: ["device"],
    });
    const active = await f.open("scoped:device");
    f.store.db
      .prepare("UPDATE users SET device_scope='[]' WHERE username='scoped'")
      .run();
    active.channel.write("must-not-run\r");
    await f.wait("terminal.close");
    assert.equal(
      f.messages.some((m) => m.type === "terminal.input"),
      false,
    );
    assert.equal(
      f.store.db
        .prepare("SELECT status FROM terminal_sessions WHERE id=?")
        .get(active.id)!.status,
      "INTERRUPTED",
    );
  } finally {
    await f.close();
  }
});
test("SSH refuses exec, SFTP, forwarding and shells without PTY; cleans auth sessions and persists host key", async () => {
  const f = await fixture();
  const fingerprint = f.ssh!.info().fingerprint;
  try {
    const c = await f.connect();
    await assert.rejects(
      new Promise((resolve, reject) =>
        c.forwardOut("127.0.0.1", 12345, "127.0.0.1", 22, (err, stream) =>
          err ? reject(err) : resolve(stream),
        ),
      ),
    );
    await assert.rejects(
      new Promise((resolve, reject) =>
        c.forwardIn("127.0.0.1", 0, (err, port) =>
          err ? reject(err) : resolve(port),
        ),
      ),
    );
    await assert.rejects(
      new Promise((resolve, reject) =>
        c.exec("touch /tmp/must-not-run", (err, stream) =>
          err ? reject(err) : resolve(stream),
        ),
      ),
    );
    const sftp = await f.connect();
    await assert.rejects(
      new Promise((resolve, reject) =>
        sftp.sftp((err, stream) => (err ? reject(err) : resolve(stream))),
      ),
    );
    const plain = await f.connect();
    await assert.rejects(
      new Promise((resolve, reject) =>
        plain.shell(false, (err, stream) =>
          err ? reject(err) : resolve(stream),
        ),
      ),
    );
    for (const client of f.clients) client.destroy();
    await until(
      () =>
        f.store.db.prepare("SELECT count(*) n FROM user_sessions").get()!.n ===
        0,
      "SSH session credentials released",
    );
    assert.equal(
      f.messages.some((m) => m.type === "terminal.open"),
      false,
    );
  } finally {
    await f.close();
  }
  const restarted = await buildServer(f.config);
  try {
    assert.equal(restarted.ssh!.info().fingerprint, fingerprint);
  } finally {
    await restarted.close();
  }
});
test("SSH loss and Agent loss interrupt sessions; out-of-sequence output fails closed", async () => {
  const f = await fixture();
  try {
    const a = await f.open();
    a.client.destroy();
    await f.wait("terminal.close");
    assert.equal(
      f.store.db
        .prepare("SELECT reason FROM terminal_sessions WHERE id=?")
        .get(a.id)!.reason,
      "SSH_DISCONNECTED",
    );
    const b = await f.open();
    f.send("terminal.output", {
      session_id: b.id,
      seq: 2,
      data: Buffer.from("must not display").toString("base64"),
    });
    await f.wait("terminal.close");
    assert.equal(
      f.store.db
        .prepare("SELECT output_bytes FROM terminal_sessions WHERE id=?")
        .get(b.id)!.output_bytes,
      0,
    );
    const c = await f.open();
    f.agent.terminate();
    await until(
      () =>
        f.store.db
          .prepare("SELECT ended_at FROM terminal_sessions WHERE id=?")
          .get(c.id)!.ended_at,
      "Agent disconnect",
    );
    assert.equal(
      f.store.db
        .prepare("SELECT reason FROM terminal_sessions WHERE id=?")
        .get(c.id)!.reason,
      "AGENT_DISCONNECTED",
    );
  } finally {
    await f.close();
  }
});

test("SSH server shutdown drains client cleanup before SQLite is closed", async () => {
  const f = await fixture();
  const { client, id } = await f.open();
  const closed = new Promise<void>((resolve) =>
    client.once("close", () => resolve()),
  );
  await f.app.close();
  await closed;
  const db = new DatabaseSync(join(f.dataDir, "fleet.sqlite"), {
    readOnly: true,
  });
  try {
    assert.equal(
      db.prepare("SELECT reason FROM terminal_sessions WHERE id=?").get(id)!
        .reason,
      "SERVER_SHUTDOWN",
    );
    assert.equal(
      db.prepare("SELECT count(*) n FROM user_sessions").get()!.n,
      0,
    );
  } finally {
    db.close();
  }
});

test("SSH key generation validates candidates before saving the persistent identity", async (t) => {
  const original = ssh2.utils.generateKeyPairSync;
  let attempts = 0;
  t.mock.method(
    ssh2.utils,
    "generateKeyPairSync",
    (...args: Parameters<typeof original>) => {
      attempts++;
      return attempts === 1
        ? { private: "malformed-key", public: "unused" }
        : original(...args);
    },
  );
  const f = await fixture();
  try {
    assert.ok(attempts >= 2);
    assert.match(f.ssh!.info().fingerprint, /^SHA256:/);
    const c = await f.connect();
    c.destroy();
  } finally {
    await f.close();
  }
});

test("SSH bare username lists only scoped devices, sanitizes names and opens the displayed device with an audited PTY", async () => {
  const f = await fixture();
  try {
    f.store.db
      .prepare(
        "INSERT INTO devices(id,public_key,name,created_at) VALUES('hidden','hidden-key','secret-device',?)",
      )
      .run(Date.now());
    f.store.db
      .prepare(
        "INSERT INTO devices(id,public_key,name,created_at) VALUES('offline','offline-key','z-offline',?)",
      )
      .run(Date.now());
    f.store.db
      .prepare("UPDATE devices SET name=? WHERE id='device'")
      .run("local-linux\u001b[31m\nspoof");
    f.store.seedUser({
      username: "scoped",
      password: "ssh-test-password1",
      role: "ops",
      deviceScope: ["device", "offline"],
    });
    const m = await f.menu("scoped");
    assert.ok(m.text().includes("[在线]"));
    assert.ok(m.text().includes("[离线]"));
    assert.equal(m.text().includes("secret-device"), false);
    assert.equal(m.text().includes("\u001b"), false);
    assert.equal(m.text().includes("\nspoof"), false);
    assert.equal(
      f.messages.some((x) => x.type === "terminal.open"),
      false,
    );
    assert.equal(
      f.store.db.prepare("SELECT count(*) n FROM terminal_sessions").get()!.n,
      0,
    );
    // Invalid choices and function keys never leak into the selected shell.
    m.channel.write("99\r\n");
    await m.waitText("编号无效");
    m.channel.write("\x1b[1~9\x7f1\r\nignored-paste\r");
    const opened = await f.wait("terminal.open");
    assert.equal(opened.cols, 80);
    f.send("terminal.opened", { session_id: opened.session_id });
    await f.wait("terminal.resize");
    assert.equal(
      f.messages.some((x) => x.type === "terminal.input"),
      false,
    );
    const row = f.store.db
      .prepare("SELECT * FROM terminal_sessions WHERE id=?")
      .get(opened.session_id)!;
    assert.equal(row.device_id, "device");
    assert.equal(row.transport, "ssh");
    const createdAudit = f.store.db
      .prepare(
        "SELECT actor_username,request_context FROM audit WHERE action='terminal.created' AND json_extract(detail_json,'$.session_id')=?",
      )
      .get(opened.session_id) as any;
    assert.equal(createdAudit.actor_username, "scoped");
    assert.equal(JSON.parse(createdAudit.request_context).source, "ssh");
    assert.ok(JSON.parse(createdAudit.request_context).remote_address);
    assert.equal(
      row.actor_id,
      f.store.db.prepare("SELECT id FROM users WHERE username='scoped'").get()!
        .id,
    );
    m.channel.write("pwd\r");
    assert.equal(
      Buffer.from((await f.wait("terminal.input")).data, "base64").toString(),
      "pwd\r",
    );
    f.send("terminal.output", {
      session_id: opened.session_id,
      seq: 1,
      data: Buffer.from("menu-shell-output").toString("base64"),
    });
    await f.wait("terminal.ack");
    await m.waitText("menu-shell-output");
    assert.equal(
      f.store.db
        .prepare(
          "SELECT count(*) n FROM terminal_recordings WHERE session_id=? AND kind='output'",
        )
        .get(opened.session_id)!.n,
      1,
    );
  } finally {
    await f.close();
  }
});
test("SSH menu handles offline choices, refresh, pagination and quit without opening a shell", async () => {
  const f = await fixture();
  try {
    for (let i = 0; i < 27; i++)
      f.store.db
        .prepare(
          "INSERT INTO devices(id,public_key,name,created_at) VALUES(?,?,?,?)",
        )
        .run(
          `offline-${i}`,
          `key-${i}`,
          `z-device-${String(i).padStart(2, "0")}`,
          Date.now(),
        );
    const m = await f.menu();
    assert.ok(m.text().includes("z-device-23"));
    assert.equal(m.text().includes("z-device-24"), false);
    m.clear();
    m.channel.write("n\r");
    await m.waitText("第 2 页");
    assert.ok(m.text().includes("z-device-24"));
    assert.equal(m.text().includes("local-linux"), false);
    m.clear();
    m.channel.write("1\r");
    await m.waitText("设备离线");
    assert.equal(
      f.messages.some((x) => x.type === "terminal.open"),
      false,
    );
    m.clear();
    m.channel.write("p\r");
    await m.waitText("第 1 页");
    f.store.db
      .prepare("UPDATE devices SET name='renamed-device' WHERE id='device'")
      .run();
    m.clear();
    m.channel.write("r\r");
    await m.waitText("renamed-device");
    const closed = new Promise<void>((resolve) =>
      m.client.once("close", () => resolve()),
    );
    m.channel.write("q\r");
    await closed;
    assert.equal(
      f.store.db.prepare("SELECT count(*) n FROM terminal_sessions").get()!.n,
      0,
    );
  } finally {
    await f.close();
  }
});
test("SSH menu preserves displayed device identity and rechecks scope/revocation before connecting", async () => {
  const f = await fixture();
  try {
    const m = await f.menu();
    f.store.db
      .prepare(
        "INSERT INTO devices(id,public_key,name,created_at) VALUES('new','new-key','aaa-new-device',?)",
      )
      .run(Date.now());
    m.channel.write("1\r");
    const request = await f.wait("terminal.open");
    assert.equal(
      f.store.db
        .prepare("SELECT device_id FROM terminal_sessions WHERE id=?")
        .get(request.session_id)!.device_id,
      "device",
    );
    m.client.destroy();
    await f.wait("terminal.close");
    f.store.seedUser({
      username: "limited",
      password: "ssh-test-password1",
      role: "ops",
      deviceScope: ["device"],
    });
    const limited = await f.menu("limited");
    f.store.db
      .prepare("UPDATE users SET device_scope='[]' WHERE username='limited'")
      .run();
    limited.clear();
    limited.channel.write("1\r");
    await limited.waitText("暂无可访问设备");
    assert.equal(limited.text().includes("local-linux"), false);
    assert.equal(
      f.messages.some((x) => x.type === "terminal.open"),
      false,
    );
    f.store.db
      .prepare("UPDATE users SET device_scope=? WHERE username='limited'")
      .run(JSON.stringify(["device"]));
    limited.clear();
    limited.channel.write("r\r");
    await limited.waitText("local-linux");
    f.store.db
      .prepare("UPDATE devices SET revoked_at=? WHERE id='device'")
      .run(Date.now());
    limited.clear();
    limited.channel.write("1\r");
    await limited.waitText("暂无可访问设备");
    assert.equal(
      f.messages.some((x) => x.type === "terminal.open"),
      false,
    );
  } finally {
    await f.close();
  }
});
test("SSH menu rejects non-operators and closes expired/downgraded logins before revealing refreshed devices", async () => {
  const f = await fixture();
  try {
    f.store.seedUser({
      username: "business",
      password: "ssh-test-password1",
      role: "business",
      deviceScope: "*",
    });
    await assert.rejects(f.connect("business"), /authentication/);
    for (const expire of [true, false]) {
      const m = await f.menu();
      if (expire)
        f.store.db.prepare("UPDATE user_sessions SET expires_at=0").run();
      else
        f.store.db
          .prepare(
            "UPDATE user_roles SET role_id='business' WHERE user_id=(SELECT id FROM users WHERE username='admin')",
          )
          .run();
      const closed = new Promise<void>((resolve) =>
        m.client.once("close", () => resolve()),
      );
      m.clear();
      m.channel.write("r\r");
      await closed;
      assert.ok(m.text().includes("权限已失效"));
      assert.equal(m.text().includes("local-linux"), false);
    }
    assert.equal(
      f.messages.some((x) => x.type === "terminal.open"),
      false,
    );
  } finally {
    await f.close();
  }
});
test("SSH empty menu supports Ctrl-C/EOF and bounds oversized input without creating a PTY", async () => {
  const f = await fixture();
  try {
    f.store.seedUser({
      username: "empty",
      password: "ssh-test-password1",
      role: "ops",
      deviceScope: [],
    });
    for (const input of ["\x03", "9".repeat(100), null]) {
      const m = await f.menu("empty");
      assert.ok(m.text().includes("暂无可访问设备"));
      assert.equal(m.text().includes("local-linux"), false);
      const closed = new Promise<void>((resolve) =>
        m.client.once("close", () => resolve()),
      );
      if (input === null) m.channel.end();
      else m.channel.write(input);
      await closed;
    }
    assert.equal(
      f.messages.some((x) => x.type === "terminal.open"),
      false,
    );
  } finally {
    await f.close();
  }
});

test(
  "user-group authorization also applies to SSH gateway and closes active SSH terminals when permissions change",
  { timeout: 10000 },
  async () => {
    const f = await fixture();
    try {
      const login = await f.app.inject({
        method: "POST",
        url: "/api/v1/login",
        payload: { username: "admin", password: "ssh-test-password1" },
      });
      const headers = { authorization: "Bearer " + login.json().access_token };
      const roleResponse = await f.app.inject({
        method: "POST",
        url: "/api/v1/roles",
        headers,
        payload: {
          v: 1,
          name: "SSH 运维",
          description: "",
          permissions: ["devices.read", "terminal.connect"],
        },
      });
      assert.equal(roleResponse.statusCode, 200);
      const roleId = roleResponse.json().role.id;
      const created = await f.app.inject({
        method: "POST",
        url: "/api/v1/users",
        headers,
        payload: {
          v: 1,
          username: "group-ssh",
          password: "ssh-test-password1",
          enabled: true,
          role_ids: [roleId],
          group_ids: [],
          device_scope: [],
        },
      });
      assert.equal(created.statusCode, 200);
      const groupResponse = await f.app.inject({
        method: "POST",
        url: "/api/v1/groups",
        headers,
        payload: {
          v: 1,
          name: "SSH 运维组",
          description: "",
          role_ids: [roleId],
          member_ids: [created.json().user.id],
          device_scope: ["device"],
        },
      });
      assert.equal(groupResponse.statusCode, 200);
      const group = groupResponse.json().group;
      const opened = await f.open("group-ssh:device");
      opened.channel.resume();
      const closed = once(opened.channel, "close");
      const moved = await f.app.inject({
        method: "PUT",
        url: "/api/v1/groups/" + group.id,
        headers,
        payload: {
          v: 1,
          revision: group.revision,
          name: group.name,
          description: "",
          role_ids: [roleId],
          member_ids: [created.json().user.id],
          device_scope: [],
        },
      });
      assert.equal(moved.statusCode, 200);
      assert.equal((await f.wait("terminal.close")).session_id, opened.id);
      await closed;
      assert.equal(
        (
          f.store.db
            .prepare("SELECT reason FROM terminal_sessions WHERE id=?")
            .get(opened.id) as any
        ).reason,
        "AUTHORIZATION_EXPIRED",
      );
      await assert.rejects(f.connect("group-ssh:device"));
    } finally {
      await f.close();
    }
  },
);

test("SSH rejects direct and menu logins requiring a first password change, then accepts the new password", async () => {
  const f = await fixture();
  try {
    const admin = (
      await f.app.inject({
        method: "POST",
        url: "/api/v1/login",
        payload: { username: "admin", password: "ssh-test-password1" },
      })
    ).json().access_token;
    const roleResponse = await f.app.inject({
      method: "POST",
      url: "/api/v1/roles",
      headers: { authorization: "Bearer " + admin },
      payload: {
        v: 1,
        name: "SSH 运维",
        description: "",
        permissions: ["devices.read", "terminal.connect"],
      },
    });
    assert.equal(roleResponse.statusCode, 200);
    const created = await f.app.inject({
      method: "POST",
      url: "/api/v1/users",
      headers: { authorization: "Bearer " + admin },
      payload: {
        v: 1,
        username: "first-ssh",
        password: "Initial-ssh1",
        enabled: true,
        role_ids: [roleResponse.json().role.id],
        group_ids: [],
        device_scope: ["device"],
        must_change_password: true,
      },
    });
    assert.equal(created.statusCode, 200);
    for (const name of ["first-ssh", "first-ssh:device"])
      await assert.rejects(f.connect(name, "Initial-ssh1"), /authentication/);
    const auth = (
      await f.app.inject({
        method: "POST",
        url: "/api/v1/login",
        payload: { username: "first-ssh", password: "Initial-ssh1" },
      })
    ).json().access_token;
    const change = await f.app.inject({
      method: "POST",
      url: "/api/v1/me/password",
      headers: { authorization: "Bearer " + auth },
      payload: {
        v: 1,
        current_password: "Initial-ssh1",
        new_password: "Personal-ssh2",
      },
    });
    assert.equal(change.statusCode, 200);
    await assert.rejects(
      f.connect("first-ssh", "Initial-ssh1"),
      /authentication/,
    );
    for (const name of ["first-ssh", "first-ssh:device"])
      (await f.connect(name, "Personal-ssh2")).end();
  } finally {
    await f.close();
  }
});

test("SSH device selection and direct login always use the ordinary account despite legacy accounts", async () => {
  const f = await fixture();
  try {
    const login = (
      await f.app.inject({
        method: "POST",
        url: "/api/v1/login",
        payload: { username: "admin", password: "ssh-test-password1" },
      })
    ).json().access_token;
    for (const username of ["root", "deploy"])
      seedLegacyAccount(f.store, "device", {
        name: username,
        username,
        method: "sudo",
        sudo_password: "legacy-fixture-only",
      });
    new AccountAuthorizations(f.store.db).ensureDefault("device");
    const legacy = f.store.db
      .prepare("SELECT * FROM target_accounts ORDER BY id")
      .all();
    const grants = f.store.db
      .prepare("SELECT * FROM account_authorizations ORDER BY id")
      .all();
    for (const direct of [false, true]) {
      let text = "";
      let channel: ClientChannel;
      if (direct) {
        const client = await f.connect();
        channel = await new Promise<ClientChannel>((resolve, reject) =>
          client.shell({ cols: 80, rows: 24 }, (e, c) =>
            e ? reject(e) : resolve(c),
          ),
        );
        channel.on("data", (d) => (text += d.toString()));
      } else {
        const menu = await f.menu();
        channel = menu.channel;
        channel.on("data", (d) => (text += d.toString()));
        channel.write("1\r");
      }
      const request = await f.wait("terminal.open");
      assert.equal(request.username, undefined);
      assert.equal(request.sudo_password, undefined);
      assert.equal(
        f.messages.some((m) => m.type === "terminal.sudo.open"),
        false,
      );
      f.send("terminal.opened", { session_id: request.session_id });
      f.send("terminal.output", {
        session_id: request.session_id,
        seq: 1,
        data: Buffer.from("ORDINARY_READY\r\n").toString("base64"),
      });
      await f.wait("terminal.ack");
      await until(
        () => text.includes("ORDINARY_READY"),
        "ordinary shell without account menu",
      );
      assert.doesNotMatch(text, /输入账号编号|高级账号|legacy-fixture-only/);
      channel.close();
      await f.wait("terminal.close");
    }
    assert.deepEqual(
      f.store.db.prepare("SELECT * FROM target_accounts ORDER BY id").all(),
      legacy,
    );
    assert.deepEqual(
      f.store.db
        .prepare("SELECT * FROM account_authorizations ORDER BY id")
        .all(),
      grants,
    );
  } finally {
    await f.close();
  }
});

test("SSH never substitutes a legacy account or grants ordinary access when only a legacy account is authorized", async () => {
  const f = await fixture();
  try {
    const login = (
      await f.app.inject({
        method: "POST",
        url: "/api/v1/login",
        payload: { username: "admin", password: "ssh-test-password1" },
      })
    ).json().access_token;
    const account = seedLegacyAccount(f.store, "device", {
      name: "Old root",
      username: "root",
      method: "sudo",
      sudo_password: "legacy-fixture-only",
    });
    const restricted = f.store.seedUser({
      username: "legacy-only",
      password: "ssh-test-password1",
      role: "ops",
      deviceScope: [],
    });
    seedLegacyGrant(f.store, "device", account.id, restricted.id);
    const menu = await f.menu("legacy-only");
    menu.channel.write("1\r");
    await menu.waitText("未获授权使用该设备的默认账号");
    menu.clear();
    menu.channel.write("r\r");
    await menu.waitText("输入设备编号");
    assert.doesNotMatch(menu.text(), /输入账号编号|高级账号|Old root/);
    menu.channel.close();
    const client = await f.connect("legacy-only:device");
    const channel = await new Promise<ClientChannel>((resolve, reject) =>
      client.shell({ cols: 80, rows: 24 }, (e, c) =>
        e ? reject(e) : resolve(c),
      ),
    );
    let error = "";
    channel.stderr.on("data", (d) => (error += d.toString()));
    channel.resume();
    await once(channel, "close");
    assert.match(error, /unavailable/);
    assert.equal(
      f.store.db.prepare("SELECT count(*) n FROM terminal_sessions").get()!.n,
      0,
    );
    assert.equal(
      f.messages.some((m) =>
        ["terminal.open", "terminal.sudo.open"].includes(m.type),
      ),
      false,
    );
  } finally {
    await f.close();
  }
});

test("SSH menus and web tickets share each user's limit; opening a shell reuses its SSH slot and close releases it", async () => {
  const f = await fixture();
  try {
    const auth = (
      await f.app.inject({
        method: "POST",
        url: "/api/v1/login",
        payload: { username: "admin", password: "ssh-test-password1" },
      })
    ).json().access_token;
    const api = async (method: string, path: string, body?: any) => {
      const r = await f.app.inject({
        method: method as any,
        url: "/api/v1" + path,
        payload: body,
        headers: { authorization: "Bearer " + auth },
      });
      return { status: r.statusCode, body: r.json() };
    };
    const { updated_at, ...limits } = (
      await api("GET", "/settings/connections")
    ).body;
    assert.equal(
      (
        await api("PUT", "/settings/connections", {
          ...limits,
          per_user: 2,
          per_device: 8,
          ssh_total: 8,
          ssh_per_ip: 8,
        })
      ).status,
      200,
    );
    const menu = await f.menu();
    const ticket = await api("POST", "/terminal-sessions", {
      v: 1,
      device_id: "device",
      cols: 80,
      rows: 24,
    });
    assert.equal(ticket.status, 200);
    assert.equal(
      (
        await api("POST", "/terminal-sessions", {
          v: 1,
          device_id: "device",
          cols: 80,
          rows: 24,
        })
      ).body.error,
      "USER_CONNECTION_LIMIT",
    );
    await assert.rejects(f.connect(), /authentication/);
    menu.channel.write("1\r");
    const open = await f.wait("terminal.open");
    f.send("terminal.opened", { session_id: open.session_id });
    await f.wait("terminal.resize");
    assert.equal(
      f.store.db
        .prepare(
          "SELECT count(*) AS n FROM terminal_sessions WHERE ended_at IS NULL",
        )
        .get()!.n,
      2,
      "SSH shell is not counted twice",
    );
    menu.client.destroy();
    await until(
      () =>
        f.store.db
          .prepare("SELECT ended_at FROM terminal_sessions WHERE id=?")
          .get(open.session_id)!.ended_at,
      "SSH release",
    );
    assert.equal(
      (
        await api("POST", "/terminal-sessions", {
          v: 1,
          device_id: "device",
          cols: 80,
          rows: 24,
        })
      ).status,
      200,
    );
  } finally {
    await f.close();
  }
});

test("SSH global and per-IP connection limits can change live without dropping existing clients", async () => {
  const f = await fixture();
  try {
    f.store.db.exec(
      "UPDATE connection_limits SET per_user=8,ssh_total=2,ssh_per_ip=2",
    );
    const first = await f.connect();
    const second = await f.connect();
    await assert.rejects(f.connect(), /before handshake|socket|closed|reset/i);
    f.store.db.exec("UPDATE connection_limits SET ssh_total=4,ssh_per_ip=2");
    await assert.rejects(f.connect(), /before handshake|socket|closed|reset/i);
    f.store.db.exec("UPDATE connection_limits SET ssh_per_ip=4");
    const third = await f.connect();
    assert.ok(third);
    first.destroy();
    second.destroy();
    third.destroy();
    await until(
      () =>
        f.store.db.prepare("SELECT count(*) AS n FROM user_sessions").get()!
          .n === 0,
      "all SSH auth slots and sessions released",
    );
  } finally {
    await f.close();
  }
});

test("a per-device override shares admission between SSH menus and web tickets and reset follows the global default", async () => {
  const f = await fixture();
  try {
    const auth = (
      await f.app.inject({
        method: "POST",
        url: "/api/v1/login",
        payload: { username: "admin", password: "ssh-test-password1" },
      })
    ).json().access_token;
    const api = async (method: string, path: string, body?: any) => {
      const r = await f.app.inject({
        method: method as any,
        url: "/api/v1" + path,
        payload: body,
        headers: { authorization: "Bearer " + auth },
      });
      return { status: r.statusCode, body: r.json() };
    };
    const { updated_at, ...limits } = (
      await api("GET", "/settings/connections")
    ).body;
    assert.equal(
      (
        await api("PUT", "/settings/connections", {
          ...limits,
          per_user: 8,
          per_device: 1,
        })
      ).status,
      200,
    );
    const setting = (limit: number | null, revision: number) =>
      api("PUT", "/devices/device/terminal-limit", { v: 1, revision, limit });
    const create = () =>
      api("POST", "/terminal-sessions", {
        v: 1,
        device_id: "device",
        cols: 80,
        rows: 24,
      });
    assert.equal((await setting(1, 0)).status, 200);
    const web = await create();
    assert.equal(web.status, 200);
    const menu = await f.menu();
    menu.channel.write("1\r");
    await menu.waitText("该设备的终端数已达上限");
    assert.equal(
      f.messages.some((m) => m.type === "terminal.open"),
      false,
    );
    assert.equal((await setting(2, 1)).status, 200);
    menu.channel.write("1\r");
    const opened = await f.wait("terminal.open");
    assert.equal(opened.max_sessions, 2);
    f.send("terminal.opened", { session_id: opened.session_id });
    await f.wait("terminal.resize");
    assert.equal((await create()).body.error, "DEVICE_TERMINAL_LIMIT");
    assert.equal((await setting(null, 2)).body.effective_limit, 1);
    assert.equal(
      f.store.db
        .prepare("SELECT ended_at FROM terminal_sessions WHERE id=?")
        .get(opened.session_id)!.ended_at,
      null,
    );
    await api("POST", `/terminal-sessions/${web.body.session_id}/close`, {
      v: 1,
    });
    assert.equal((await create()).body.error, "DEVICE_TERMINAL_LIMIT");
    menu.client.destroy();
    await until(
      () =>
        f.store.db
          .prepare("SELECT ended_at FROM terminal_sessions WHERE id=?")
          .get(opened.session_id)!.ended_at,
      "SSH closed",
    );
    assert.equal((await create()).status, 200);
  } finally {
    await f.close();
  }
});
