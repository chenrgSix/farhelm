import test from "node:test";
import { generateKeyPairSync, sign } from "node:crypto";
import { once } from "node:events";
import { WebSocket } from "ws";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { buildServer } from "../src/server.js";
import { hash } from "../src/util.js";

const root = mkdtempSync(join(tmpdir(), "farhelm-install-test-"));
execFileSync("bash", ["../../deploy/dev/generate-tls.sh", join(root, "tls")], {
  stdio: "ignore",
});
async function fixture(
  packages = true,
  publicUrl = "https://fleet.example.com",
) {
  const dataDir = mkdtempSync(join(root, "data-")),
    distDir = join(dataDir, "packages");
  mkdirSync(distDir);
  const binary = Buffer.alloc(128);
  Buffer.from("7f454c460201", "hex").copy(binary);
  binary.writeUInt16LE(183, 18);
  if (packages)
    writeFileSync(join(distDir, "farhelm-agent-linux-aarch64"), binary);
  const config = {
    dataDir,
    tlsCert: join(root, "tls/server.crt"),
    tlsKey: join(root, "tls/server.key"),
    adminUsername: "admin",
    adminPassword: "installer-test-password1",
    agentInstall: {
      distDir,
      publicUrl,
      caCert: join(root, "tls/ca.crt"),
    },
  };
  const server = await buildServer(config);
  const admin = (
    await server.app.inject({
      method: "POST",
      url: "/api/v1/login",
      payload: { username: "admin", password: "installer-test-password1" },
    })
  ).json().access_token;
  const api = (
    method: "GET" | "POST",
    url: string,
    payload?: any,
    auth: string = admin,
  ) =>
    server.app.inject({
      method,
      url,
      payload,
      headers: { authorization: "Bearer " + auth },
    });
  const body = {
    v: 1,
    name: "安装测试 $(touch /tmp/should-not-exist) `echo x` ' \\\" 中文",
    run_user: "farhelm",
    ttl_seconds: 600,
  };
  return { ...server, api, body, binary, distDir, config };
}
test("installer is admin-only, validates HTTPS/account/options and reports missing packages", async () => {
  const f = await fixture(false);
  try {
    f.store.seedUser({
      username: "ops",
      password: "installer-test-password1",
      role: "ops",
      deviceScope: "*",
    });
    const ops = (
      await f.api("POST", "/api/v1/login", {
        username: "ops",
        password: "installer-test-password1",
      })
    ).json().access_token;
    assert.equal(
      (await f.api("GET", "/api/v1/agent-install/options", undefined, ops))
        .statusCode,
      403,
    );
    assert.equal(
      (await f.api("POST", "/api/v1/agent-installations", f.body, ops))
        .statusCode,
      403,
    );
    assert.equal(
      (await f.api("GET", "/api/v1/agent-install/options")).json().architectures
        .length,
      0,
    );
    assert.equal(
      (await f.api("POST", "/api/v1/agent-installations", f.body)).statusCode,
      503,
    );
    writeFileSync(join(f.distDir, "farhelm-agent-linux-aarch64"), f.binary);
    for (const server_url of [
      "http://fleet.example.com",
      "https://user:secret@fleet.example.com",
      "https://fleet.example.com/path",
      "https://fleet.example.com/?token=x",
      "https://fleet.example.com/#fragment",
      "",
    ]) {
      assert.equal(
        (
          await f.api("POST", "/api/v1/agent-installations", {
            ...f.body,
            server_url,
          })
        ).statusCode,
        400,
      );
    }
    for (const fields of [
      { run_user: "root" },
      { run_user: "a;touch x" },
      { name: "new\nline" },
      { allow_sudo: "true" },
      { start_mode: "cron" },
    ])
      assert.equal(
        (
          await f.api("POST", "/api/v1/agent-installations", {
            ...f.body,
            ...fields,
          })
        ).statusCode,
        400,
      );
  } finally {
    await f.close();
  }
});
test("one-time install download pins scripts/packages, protects shell data and stores only token hashes", async () => {
  const f = await fixture();
  try {
    const created = await f.api("POST", "/api/v1/agent-installations", f.body);
    assert.equal(created.statusCode, 200);
    const { id, command } = created.json();
    assert.ok(
      command.includes("https://fleet.example.com/api/agent/install.sh"),
    );
    assert.equal(
      (await f.api("GET", "/api/v1/agent-install/options")).json().server_url,
      "https://fleet.example.com",
    );
    // Decode the header embedded in the generated command, without invoking the network or shell as root.
    const candidates = command.match(/[A-Za-z0-9+/=]{50,}/g) as string[];
    const auth = candidates
      .map((s) => Buffer.from(s, "base64").toString())
      .find((s) => s.startsWith("Authorization: Bearer "))!;
    const secret = auth.slice("Authorization: Bearer ".length).trim();
    assert.equal(secret.length, 43);
    assert.equal(command.includes("-k "), false);
    assert.equal(command.includes(secret), false);
    assert.equal(command.includes("?token"), false);
    assert.equal(
      JSON.stringify(
        f.store.db.prepare("SELECT * FROM agent_installations").all(),
      ).includes(secret),
      false,
    );
    assert.equal(
      JSON.stringify(f.store.db.prepare("SELECT * FROM audit").all()).includes(
        secret,
      ),
      false,
    );
    const script = await f.api(
      "GET",
      "/api/agent/install.sh",
      undefined,
      secret,
    );
    assert.equal(script.statusCode, 200);
    assert.ok(command.includes(hash(script.body)));
    const path = join(root, id + ".sh");
    writeFileSync(path, script.body);
    execFileSync("bash", ["-n", path]);
    const envEncoded = script.body.match(/^env_b64='([A-Za-z0-9+/=]+)'$/m)![1]!;
    const envPath = join(root, id + ".env");
    writeFileSync(envPath, Buffer.from(envEncoded, "base64"));
    assert.ok(
      readFileSync(envPath, "utf8").includes(
        'FLEET_SERVER_URL="https://fleet.example.com"',
      ),
    );
    const name = execFileSync(
      "bash",
      ["-c", 'source "$1"; printf %s "$FLEET_DEVICE_NAME"', "test", envPath],
      { encoding: "utf8" },
    );
    assert.equal(name, f.body.name);
    assert.equal((await f.api("GET", "/api/agent/install.sh")).statusCode, 401);
    const pkg = await f.api(
      "GET",
      "/api/agent/packages/aarch64",
      undefined,
      secret,
    );
    assert.equal(pkg.statusCode, 200);
    assert.deepEqual(pkg.rawPayload, f.binary);
    writeFileSync(
      join(f.distDir, "farhelm-agent-linux-aarch64"),
      Buffer.concat([f.binary, Buffer.from("changed")]),
    );
    assert.equal(
      (await f.api("GET", "/api/agent/packages/aarch64", undefined, secret))
        .statusCode,
      409,
    );
    assert.equal(
      (await f.api("GET", `/api/v1/agent-installations/${id}`)).json().status,
      "waiting",
    );
    f.store.db
      .prepare(
        "INSERT INTO devices(id,public_key,name,created_at) VALUES('new','key','installed',1)",
      )
      .run();
    f.store.db
      .prepare(
        "UPDATE enrollment_tokens SET redeemed_device_id='new' WHERE token_hash=?",
      )
      .run(hash(secret));
    assert.equal(
      (await f.api("GET", "/api/agent/install.sh", undefined, secret))
        .statusCode,
      401,
    );
    assert.equal(
      (await f.api("GET", "/api/agent/packages/aarch64", undefined, secret))
        .statusCode,
      401,
    );
    assert.equal(
      (
        await f.api("GET", "/api/agent/install-status", undefined, secret)
      ).json().status,
      "registered",
    );
    f.store.db
      .prepare("UPDATE enrollment_tokens SET expires_at=1 WHERE token_hash=?")
      .run(hash(secret));
    assert.equal(
      (await f.api("GET", "/api/agent/install-status", undefined, secret))
        .statusCode,
      401,
    );
  } finally {
    await f.close();
  }
});
test("missing or invalid central address prevents issuing an installation command", async () => {
  for (const publicUrl of [
    "",
    "http://fleet.example.com",
    "https://user:password@fleet.example.com",
    "https://fleet.example.com/path",
  ]) {
    const f = await fixture(true, publicUrl);
    try {
      const created = await f.api(
        "POST",
        "/api/v1/agent-installations",
        f.body,
      );
      assert.equal(created.statusCode, publicUrl ? 400 : 503);
      assert.equal(
        f.store.db.prepare("SELECT COUNT(*) n FROM agent_installations").get()!
          .n,
        0,
      );
      if (!publicUrl)
        assert.equal(
          (await f.api("GET", "/api/v1/agent-install/options")).json()
            .server_url,
          "",
        );
    } finally {
      await f.close();
    }
  }
});

const pair = () => {
  const keys = generateKeyPairSync("ed25519");
  return {
    ...keys,
    public_key: (
      keys.publicKey.export({ type: "spki", format: "der" }) as Buffer
    )
      .subarray(-32)
      .toString("base64"),
  };
};
test("custom install addresses stay local to the enrolled device and survive server restart", async () => {
  const f = await fixture();
  const localUrl = "https://192.168.1.100:8444";
  let closed = false;
  try {
    const settings = (await f.api("GET", "/api/v1/settings")).json();
    const created = await f.api("POST", "/api/v1/agent-installations", {
      ...f.body,
      server_url: localUrl + "/",
    });
    assert.equal(created.statusCode, 200, created.body);
    const { command, server_url } = created.json();
    assert.equal(server_url, localUrl);
    assert.ok(command.includes(localUrl + "/api/agent/install.sh"));
    const header = (command.match(/[A-Za-z0-9+/=]{50,}/g) as string[])
      .map((s) => Buffer.from(s, "base64").toString())
      .find((s) => s.startsWith("Authorization: Bearer "))!;
    const secret = header.slice("Authorization: Bearer ".length).trim();
    const script = await f.api(
      "GET",
      "/api/agent/install.sh",
      undefined,
      secret,
    );
    assert.equal(script.statusCode, 200);
    assert.ok(script.body.includes(`server='${localUrl}'`));
    const env = Buffer.from(
      script.body.match(/^env_b64='([^']+)'$/m)![1]!,
      "base64",
    ).toString();
    assert.ok(env.includes(`FLEET_SERVER_URL="${localUrl}"`));
    assert.ok(command.includes(hash(script.body)));
    assert.equal(command.includes("-k "), false);
    const key = pair();
    const challenge = (
      await f.api("POST", "/api/agent/challenge", {
        v: 1,
        purpose: "enroll",
        public_key: key.public_key,
        enrollment_token: secret,
      })
    ).json();
    const enrolled = await f.api("POST", "/api/agent/enroll", {
      v: 1,
      challenge_id: challenge.challenge_id,
      signature: sign(
        null,
        Buffer.from(challenge.signing_payload, "base64"),
        key.privateKey,
      ).toString("base64"),
      name: "LAN device",
    });
    assert.equal(enrolled.statusCode, 200, enrolled.body);
    const id = enrolled.json().device_id;
    assert.equal(
      f.store.db
        .prepare("SELECT agent_server_url FROM devices WHERE id=?")
        .get(id)!.agent_server_url,
      localUrl,
    );
    assert.deepEqual((await f.api("GET", "/api/v1/settings")).json(), settings);
    assert.equal(
      (await f.api("GET", "/api/v1/agent-install/options")).json().server_url,
      settings.platform_server_url,
    );
    const next = await f.api("POST", "/api/v1/agent-installations", {
      ...f.body,
      name: "Other device",
    });
    assert.equal(next.json().server_url, settings.platform_server_url);
    await f.close();
    closed = true;
    const restarted = await buildServer(f.config);
    try {
      assert.equal(
        restarted.store.db
          .prepare("SELECT agent_server_url FROM devices WHERE id=?")
          .get(id)!.agent_server_url,
        localUrl,
      );
    } finally {
      await restarted.close();
    }
  } finally {
    if (!closed) await f.close();
  }
});
test("an explicit install address works without a global default", async () => {
  const f = await fixture(true, "");
  try {
    const r = await f.api("POST", "/api/v1/agent-installations", {
      ...f.body,
      server_url: "https://[fd00::1]:8444",
    });
    assert.equal(r.statusCode, 200, r.body);
    assert.equal(r.json().server_url, "https://[fd00::1]:8444");
    assert.equal(
      (await f.api("GET", "/api/v1/settings")).json().platform_server_url,
      "",
    );
  } finally {
    await f.close();
  }
});
async function boundFixture() {
  const f = await fixture();
  await f.app.listen({ host: "127.0.0.1", port: 0 });
  const key = generateKeyPairSync("rsa", {
    modulusLength: 2048,
    privateKeyEncoding: { type: "pkcs1", format: "pem" },
    publicKeyEncoding: { type: "spki", format: "pem" },
  }).privateKey;
  const r = await f.api("POST", "/api/v1/ssh-devices", {
    v: 1,
    name: "Original SSH",
    ssh: {
      host: "127.0.0.1",
      port: 22,
      username: "linux",
      fingerprint:
        "SHA256:" + Buffer.alloc(32).toString("base64").replace(/=+$/, ""),
    },
    private_key: key,
  });
  assert.equal(r.statusCode, 200, r.body);
  const id = r.json().device_id;
  const install = async (target = id, server_url?: string) => {
    const r = await f.api("POST", "/api/v1/agent-installations", {
      v: 1,
      device_id: target,
      ...(server_url ? { server_url } : {}),
    });
    assert.equal(r.statusCode, 200, r.body);
    const data = r.json();
    const header = (data.command.match(/[A-Za-z0-9+/=]{50,}/g) as string[])
      .map((s) => Buffer.from(s, "base64").toString())
      .find((s) => s.startsWith("Authorization: Bearer "))!;
    return {
      ...data,
      secret: header.slice("Authorization: Bearer ".length).trim(),
    };
  };
  const proof = async (
    key: ReturnType<typeof pair>,
    purpose: "auth" | "enroll",
    secret?: string,
  ) => {
    const c = await f.api("POST", "/api/agent/challenge", {
      v: 1,
      purpose,
      public_key: key.public_key,
      ...(purpose === "enroll"
        ? { enrollment_token: secret }
        : { device_id: id }),
    });
    assert.equal(c.statusCode, 200, c.body);
    return {
      v: 1,
      challenge_id: c.json().challenge_id,
      signature: sign(
        null,
        Buffer.from(c.json().signing_payload, "base64"),
        key.privateKey,
      ).toString("base64"),
    };
  };
  const enroll = async (key: ReturnType<typeof pair>, secret: string) =>
    f.api("POST", "/api/agent/enroll", {
      ...(await proof(key, "enroll", secret)),
      name: "Must not rename original",
    });
  const sockets: WebSocket[] = [];
  const connect = async (key: ReturnType<typeof pair>) => {
    const auth = await f.api(
      "POST",
      "/api/agent/auth",
      await proof(key, "auth"),
    );
    assert.equal(auth.statusCode, 200, auth.body);
    const ws = new WebSocket(
      `wss://localhost:${(f.app.server.address() as any).port}/agent/ws`,
      {
        ca: readFileSync(join(root, "tls/ca.crt")),
        headers: { authorization: "Bearer " + auth.json().access_token },
      },
    );
    sockets.push(ws);
    await once(ws, "open");
    return ws;
  };
  const row = () =>
    f.store.db.prepare("SELECT * FROM devices WHERE id=?").get(id) as any;
  const close = async () => {
    for (const ws of sockets) ws.terminate();
    await f.close();
  };
  return { ...f, id, install, proof, enroll, connect, row, close };
}
async function until(fn: () => unknown) {
  for (let i = 0; i < 300; i++) {
    if (await fn()) return;
    await new Promise((r) => setTimeout(r, 10));
  }
  throw Error("Timed out waiting for Agent state");
}
const hello = (ws: WebSocket, runtime?: any) =>
  ws.send(
    JSON.stringify({
      v: 1,
      type: "agent.hello",
      body: {
        agent_version: "0.2.3",
        capabilities: ["terminal.pty.v1"],
        ...(runtime ? { runtime } : {}),
      },
    }),
  );

test("SSH enrollment stages a bound key, preserves identity and promotes atomically on first valid hello", async () => {
  const f = await boundFixture();
  try {
    const db = f.store.db,
      original = f.row();
    const connection = db
      .prepare("SELECT * FROM device_connections WHERE device_id=?")
      .get(f.id);
    db.prepare(
      "INSERT INTO device_groups(id,name,description,created_at,updated_at) VALUES('tag','Production','',1,1)",
    ).run();
    db.prepare(
      "INSERT INTO device_group_members(device_id,group_id) VALUES(?,'tag')",
    ).run(f.id);
    const user = db
      .prepare("SELECT id FROM users WHERE username='admin'")
      .get()!.id;
    db.prepare(
      "INSERT INTO terminal_sessions(id,device_id,actor_id,status,cols,rows,created_at,ended_at,backend,audit_complete) VALUES('old',?,?,'CLOSED',80,24,1,2,'ssh',1)",
    ).run(f.id, user);
    db.prepare(
      "INSERT INTO terminal_recordings VALUES('old',1,1,'output',?)",
    ).run(JSON.stringify({ data: Buffer.from("history").toString("base64") }));
    const oldSession = db.prepare("SELECT * FROM terminal_sessions").all(),
      oldRecordings = db.prepare("SELECT * FROM terminal_recordings").all();
    f.store.seedUser({
      username: "scoped",
      password: "installer-test-password1",
      role: "ops",
      deviceScope: [f.id],
    });
    const scope = db
      .prepare("SELECT * FROM users WHERE username='scoped'")
      .get();
    const localUrl = "https://192.168.1.100:8444";
    const command = await f.install(f.id, localUrl),
      key = pair();
    assert.equal(f.row().connection_kind, "ssh");
    assert.equal(
      f.row().agent_server_url,
      null,
      "issuing a command does not change the SSH device",
    );
    const waiting = (
      await f.api("GET", `/api/v1/agent-installations/${command.id}`)
    ).json();
    assert.deepEqual(waiting, { v: 1, device_id: f.id, status: "waiting" });
    const registered = await f.enroll(key, command.secret);
    assert.equal(registered.statusCode, 200, registered.body);
    assert.equal(registered.json().device_id, f.id);
    assert.equal(f.row().public_key, original.public_key);
    assert.equal(f.row().agent_pending_public_key, key.public_key);
    assert.equal(f.row().agent_server_url, localUrl);
    assert.equal(f.row().connection_kind, "ssh");
    assert.equal(
      (await f.api("GET", "/api/v1/devices")).json().devices[0]
        .terminal_backend,
      "ssh",
    );
    assert.equal((await f.enroll(key, command.secret)).json().device_id, f.id);
    assert.equal(
      (
        await f.api("POST", "/api/v1/agent-installations", {
          v: 1,
          device_id: f.id,
        })
      ).json().error,
      "AGENT_ALREADY_REGISTERED",
    );
    // Authentication remains valid after command expiry; no second installation is needed.
    db.prepare("UPDATE enrollment_tokens SET expires_at=1").run();
    const ws = await f.connect(key);
    const malformed = once(ws, "message");
    hello(ws, { arch: "bad", sha256: "0".repeat(64) });
    await malformed;
    assert.equal(f.row().connection_kind, "ssh");
    const audit = f.store.audit.bind(f.store);
    f.store.audit = ((action: string, ...args: any[]) => {
      if (action === "device.agent_enabled") throw Error("audit failed");
      return (audit as any)(action, ...args);
    }) as any;
    const rejected = once(ws, "message");
    hello(ws);
    await rejected;
    assert.equal(f.row().connection_kind, "ssh");
    f.store.audit = audit;
    hello(await f.connect(key));
    await until(() => f.row().connection_kind === "agent");
    const enabled = f.row();
    assert.equal(enabled.id, original.id);
    assert.equal(enabled.name, original.name);
    assert.equal(enabled.created_at, original.created_at);
    assert.equal(enabled.public_key, key.public_key);
    assert.equal(enabled.agent_pending_public_key, null);
    assert.equal(enabled.agent_server_url, localUrl);
    assert.deepEqual(
      db
        .prepare("SELECT * FROM device_connections WHERE device_id=?")
        .get(f.id),
      connection,
    );
    assert.equal(db.prepare("SELECT count(*) n FROM devices").get()!.n, 1);
    assert.equal(
      db
        .prepare("SELECT group_id FROM device_group_members WHERE device_id=?")
        .get(f.id)!.group_id,
      "tag",
    );
    assert.deepEqual(
      db.prepare("SELECT * FROM users WHERE username='scoped'").get(),
      scope,
    );
    assert.deepEqual(
      db.prepare("SELECT * FROM terminal_sessions").all(),
      oldSession,
    );
    assert.deepEqual(
      db.prepare("SELECT * FROM terminal_recordings").all(),
      oldRecordings,
    );
    const online = (
      await f.api("GET", `/api/v1/agent-installations/${command.id}`)
    ).json();
    assert.equal(online.status, "online");
    assert.equal(
      (await f.api("GET", "/api/v1/devices")).json().devices[0]
        .terminal_backend,
      "agent",
    );
    const again = await f.connect(key);
    hello(again);
    await until(
      async () =>
        (await f.api("GET", "/api/v1/devices")).json().devices[0]
          .control_online,
    );
    assert.equal(
      db
        .prepare(
          "SELECT count(*) n FROM audit WHERE action='device.agent_enabled'",
        )
        .get()!.n,
      1,
    );
    again.terminate();
    await until(
      async () =>
        (await f.api("GET", "/api/v1/devices")).json().devices[0]
          .terminal_backend === "ssh",
    );
  } finally {
    await f.close();
  }
});

test("bound commands cannot rebind other identities, bypass admin, swap devices or outlive revocation", async () => {
  const f = await boundFixture();
  try {
    f.store.seedUser({
      username: "ops",
      password: "installer-test-password1",
      role: "ops",
      deviceScope: [f.id],
    });
    const ops = (
      await f.api("POST", "/api/v1/login", {
        username: "ops",
        password: "installer-test-password1",
      })
    ).json().access_token;
    assert.equal(
      (
        await f.api(
          "POST",
          "/api/v1/agent-installations",
          { v: 1, device_id: f.id },
          ops,
        )
      ).statusCode,
      403,
    );
    assert.equal(
      (
        await f.api("POST", "/api/v1/agent-installations", {
          v: 1,
          device_id: "missing",
        })
      ).statusCode,
      404,
    );
    const first = await f.install(),
      second = await f.install(),
      key = pair();
    assert.equal(
      (await f.api("GET", "/api/agent/install.sh", undefined, first.secret))
        .statusCode,
      401,
    );
    assert.equal(
      (await f.api("GET", `/api/v1/agent-installations/${first.id}`)).json()
        .status,
      "expired",
    );
    assert.equal(
      (
        await f.api("POST", "/api/agent/challenge", {
          v: 1,
          purpose: "enroll",
          public_key: key.public_key,
          enrollment_token: second.secret,
          device_id: f.id,
        })
      ).statusCode,
      400,
    );
    const db = f.store.db;
    db.prepare(
      "INSERT INTO devices(id,public_key,name,created_at) VALUES('other',?,'Other',1)",
    ).run(key.public_key);
    assert.equal(
      (await f.enroll(key, second.secret)).json().error,
      "AGENT_IDENTITY_ALREADY_BOUND",
    );
    assert.equal(f.row().agent_pending_public_key, null);
    const winner = pair(),
      loser = pair();
    const pendingLoser = await f.proof(loser, "enroll", second.secret);
    assert.equal((await f.enroll(winner, second.secret)).statusCode, 200);
    assert.equal(
      (
        await f.api("POST", "/api/agent/enroll", {
          ...pendingLoser,
          name: "Wrong",
        })
      ).statusCode,
      401,
    );
    const normal = (
      await f.api("POST", "/api/v1/enrollment-tokens", {
        v: 1,
        ttl_seconds: 600,
      })
    ).json();
    assert.equal(
      (await f.enroll(winner, normal.enrollment_token)).json().error,
      "AGENT_IDENTITY_ALREADY_BOUND",
    );
    const normalResult = await f.enroll(pair(), normal.enrollment_token);
    assert.equal(normalResult.statusCode, 200);
    assert.notEqual(normalResult.json().device_id, f.id);
    assert.equal(
      (await f.api("POST", `/api/v1/devices/${f.id}/revoke`, { v: 1 }))
        .statusCode,
      200,
    );
    assert.equal(
      (
        await f.api(
          "GET",
          "/api/agent/install-status",
          undefined,
          second.secret,
        )
      ).statusCode,
      401,
    );
    assert.equal(
      (await f.api("GET", `/api/v1/agent-installations/${second.id}`)).json()
        .status,
      "revoked",
    );
    assert.equal(f.row().connection_kind, "ssh");
  } finally {
    await f.close();
  }
});

test("a pending SSH-bound identity survives platform restart and expired installation credentials", async () => {
  const f = await boundFixture();
  let stopped = false,
    restarted: Awaited<ReturnType<typeof buildServer>> | undefined,
    ws: WebSocket | undefined;
  try {
    const command = await f.install(),
      key = pair();
    const enrolled = await f.enroll(key, command.secret);
    assert.equal(enrolled.json().device_id, f.id);
    f.store.db.prepare("UPDATE enrollment_tokens SET expires_at=1").run();
    const connection = f.store.db
      .prepare("SELECT * FROM device_connections WHERE device_id=?")
      .get(f.id);
    await f.close();
    stopped = true;
    restarted = await buildServer(f.config);
    await restarted.app.listen({ host: "127.0.0.1", port: 0 });
    const row = () =>
      restarted!.store.db.prepare("SELECT * FROM devices WHERE id=?").get(f.id);
    assert.equal(row()!.connection_kind, "ssh");
    assert.equal(row()!.agent_pending_public_key, key.public_key);
    const c = await restarted.app.inject({
      method: "POST",
      url: "/api/agent/challenge",
      payload: {
        v: 1,
        purpose: "auth",
        public_key: key.public_key,
        device_id: f.id,
      },
    });
    assert.equal(c.statusCode, 200, c.body);
    const a = await restarted.app.inject({
      method: "POST",
      url: "/api/agent/auth",
      payload: {
        v: 1,
        challenge_id: c.json().challenge_id,
        signature: sign(
          null,
          Buffer.from(c.json().signing_payload, "base64"),
          key.privateKey,
        ).toString("base64"),
      },
    });
    assert.equal(a.statusCode, 200, a.body);
    ws = new WebSocket(
      `wss://localhost:${(restarted.app.server.address() as any).port}/agent/ws`,
      {
        ca: readFileSync(join(root, "tls/ca.crt")),
        headers: { authorization: "Bearer " + a.json().access_token },
      },
    );
    await once(ws, "open");
    hello(ws);
    await until(() => row()!.connection_kind === "agent");
    assert.equal(
      restarted.store.db.prepare("SELECT count(*) n FROM devices").get()!.n,
      1,
    );
    assert.deepEqual(
      restarted.store.db
        .prepare("SELECT * FROM device_connections WHERE device_id=?")
        .get(f.id),
      connection,
    );
  } finally {
    ws?.terminate();
    if (restarted) await restarted.close();
    if (!stopped) await f.close();
  }
});
