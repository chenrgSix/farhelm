import { test } from "node:test";
import assert from "node:assert/strict";
import { randomBytes, generateKeyPairSync } from "node:crypto";
import { createServer, connect as tcpConnect, type Socket } from "node:net";
import { once } from "node:events";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync, spawn } from "node:child_process";
import ssh2, { type ClientChannel } from "ssh2";
import { WebSocket } from "ws";
import { buildServer } from "../src/server.js";
import { fingerprint } from "../src/ssh-target.js";
import { hash, token } from "../src/util.js";

const root = mkdtempSync(join(tmpdir(), "farhelm-forward-"));
const password = "forward-test-password1";
execFileSync("bash", ["../../deploy/dev/generate-tls.sh", join(root, "tls")], {
  stdio: "ignore",
});
const hostKey = generateKeyPairSync("rsa", {
  modulusLength: 2048,
  privateKeyEncoding: { type: "pkcs1", format: "pem" },
  publicKeyEncoding: { type: "spki", format: "pem" },
}).privateKey;
const parsed = ssh2.utils.parseKey(hostKey) as ssh2.ParsedKey;
async function until(fn: () => unknown, label = "condition") {
  for (let i = 0; i < 400; i++) {
    if (await fn()) return;
    await new Promise((r) => setTimeout(r, 10));
  }
  throw new Error("Timed out: " + label);
}
async function fixture(kind: "ssh" | "agent" = "ssh", enabled = true) {
  const downstream = new Set<ssh2.Connection>(),
    sockets = new Set<Socket>();
  const requests: { host: string; port: number }[] = [];
  let holdForwards = false;
  const echo = createServer({ allowHalfOpen: true }, (socket) => {
    sockets.add(socket);
    socket.on("error", () => {});
    socket.on("close", () => sockets.delete(socket));
    // Reply after EOF to exercise half-close through every forwarding layer.
    const chunks: Buffer[] = [];
    socket.on("data", (data) => chunks.push(data));
    socket.on("end", () => socket.end(Buffer.concat(chunks)));
  });
  await new Promise<void>((r) => echo.listen(0, "127.0.0.1", r));
  const echoPort = (echo.address() as any).port;
  const target = new ssh2.Server({ hostKeys: [hostKey] }, (client) => {
    downstream.add(client);
    client.on("error", () => {});
    client.on("close", () => downstream.delete(client));
    client.on("authentication", (ctx) =>
      ctx.method === "password" && ctx.password === password
        ? ctx.accept()
        : ctx.reject(["password"]),
    );
    client.on("tcpip", (accept, reject, info) => {
      requests.push({ host: info.destIP, port: info.destPort });
      if (holdForwards) return;
      const socket = tcpConnect({
        host: info.destIP === "database.internal" ? "127.0.0.1" : info.destIP,
        port: info.destPort,
        allowHalfOpen: true,
      });
      sockets.add(socket);
      socket.on("close", () => sockets.delete(socket));
      socket.once("error", () => reject());
      socket.once("connect", () => {
        socket.removeAllListeners("error");
        const channel = accept();
        socket.on("error", () => channel.destroy());
        channel.on("error", () => socket.destroy());
        socket.on("close", () => {
          if (!socket.readableEnded || !socket.writableFinished)
            channel.destroy();
        });
        channel.on("close", () => socket.destroy());
        // A TCP close can precede draining the SSH write window. Preserve buffered replies.
        let outputEnded = false;
        socket.on("end", () =>
          channel.write(Buffer.alloc(0), () => {
            outputEnded = true;
            channel.eof();
            if (channel.readableEnded) channel.end();
          }),
        );
        channel.on("end", () => {
          if (outputEnded) channel.end();
        });
        channel.pipe(socket).pipe(channel, { end: false });
      });
    });
  });
  await new Promise<void>((r) => target.listen(0, "127.0.0.1", r));
  const targetPort = (target.address() as any).port;
  const dataDir = mkdtempSync(join(root, "server-"));
  const server = await buildServer({
    dataDir,
    tlsCert: join(root, "tls/server.crt"),
    tlsKey: join(root, "tls/server.key"),
    adminUsername: "admin",
    adminPassword: password,
    ssh: { host: "127.0.0.1", port: 0 },
  });
  await server.app.listen({ host: "127.0.0.1", port: 0 });
  server.store.db
    .prepare(
      "INSERT INTO devices(id,public_key,name,created_at,connection_kind) VALUES('device','test-key','forward-device',?,?)",
    )
    .run(Date.now(), kind);
  server.store.seedUser({
    username: "ops",
    password,
    role: "ops",
    deviceScope: ["device"],
  });
  const auth = (
    await server.app.inject({
      method: "POST",
      url: "/api/v1/login",
      payload: { username: "admin", password },
    })
  ).json().access_token;
  async function configure(
    fingerprintValue = fingerprint(parsed.getPublicSSH()),
    deviceId = "device",
  ) {
    const revision = Number(
      server.store.db
        .prepare("SELECT revision FROM device_connections WHERE device_id=?")
        .get(deviceId)?.revision ?? 0,
    );
    const result = await server.app.inject({
      method: "PUT",
      url: `/api/v1/devices/${deviceId}/connection`,
      headers: { authorization: "Bearer " + auth },
      payload: {
        v: 1,
        revision,
        ssh: {
          host: "127.0.0.1",
          port: targetPort,
          username: "terminal",
          auth_method: "password",
          fingerprint: fingerprintValue,
        },
        ssh_password: password,
      },
    });
    assert.equal(result.statusCode, 200, result.body);
  }
  async function setForwarding(enabled: boolean, deviceId = "device") {
    const revision = Number(
      server.store.db
        .prepare("SELECT revision FROM device_forwarding WHERE device_id=?")
        .get(deviceId)?.revision ?? 0,
    );
    const result = await server.app.inject({
      method: "PUT",
      url: `/api/v1/devices/${deviceId}/forwarding`,
      headers: { authorization: "Bearer " + auth },
      payload: { v: 1, revision, enabled },
    });
    assert.equal(result.statusCode, 200, result.body);
  }
  if (enabled) await setForwarding(true);
  if (kind === "ssh") await configure();
  let agent: WebSocket | undefined;
  const agentSockets = new Map<
    string,
    { socket: Socket; seq: number; input: number }
  >();
  if (kind === "agent") {
    const access = token();
    server.store.db
      .prepare(
        "INSERT INTO device_tokens(token_hash,device_id,expires_at,scope) VALUES(?,'device',?,'agent-control-output')",
      )
      .run(hash(access), Date.now() + 120000);
    agent = new WebSocket(
      `wss://localhost:${(server.app.server.address() as any).port}/agent/ws`,
      {
        ca: readFileSync(join(root, "tls/ca.crt")),
        headers: { authorization: "Bearer " + access },
      },
    );
    agent.on("error", () => {});
    const send = (type: string, body: unknown) =>
      agent?.readyState === WebSocket.OPEN &&
      agent.send(JSON.stringify({ v: 1, type, body }));
    agent.on("message", (raw) => {
      const { type, body } = JSON.parse(raw.toString()),
        id = body.forward_id;
      const current = agentSockets.get(id);
      if (type === "tcp.open") {
        requests.push({ host: body.host, port: body.port });
        if (holdForwards) return;
        const socket = tcpConnect({
          host: body.host === "database.internal" ? "127.0.0.1" : body.host,
          port: body.port,
          allowHalfOpen: true,
        });
        const state = { socket, seq: 0, input: 0 };
        agentSockets.set(id, state);
        socket.on("connect", () => send("tcp.opened", { forward_id: id }));
        socket.on("data", (data) => {
          socket.pause();
          send("tcp.data", {
            forward_id: id,
            seq: ++state.seq,
            data: data.toString("base64"),
          });
        });
        // Force protocol-sized reads even when TCP coalesces packets.
        socket.removeAllListeners("data");
        socket.on("readable", () => pump(id));
        socket.on("end", () => send("tcp.end", { forward_id: id }));
        socket.on("error", () =>
          send("tcp.closed", { forward_id: id, reason: "TCP_FAILED" }),
        );
        socket.on("close", () => agentSockets.delete(id));
      } else if (type === "tcp.data" && current) {
        current.socket.write(Buffer.from(body.data, "base64"), () =>
          send("tcp.ack", { forward_id: id, seq: body.seq }),
        );
      } else if (type === "tcp.ack" && current) {
        current.input = body.seq;
        pump(id);
      } else if (type === "tcp.end") current?.socket.end();
      else if (type === "tcp.close") current?.socket.destroy();
    });
    function pump(id: string) {
      const state = agentSockets.get(id);
      if (!state || state.seq !== state.input) return;
      const data = state.socket.read(
        Math.min(8192, state.socket.readableLength),
      );
      if (data?.length)
        send("tcp.data", {
          forward_id: id,
          seq: ++state.seq,
          data: data.toString("base64"),
        });
    }
    await once(agent, "open");
    send("agent.hello", {
      agent_version: "forward-test",
      capabilities: ["tcp.forward.v1"],
    });
    await new Promise((r) => setTimeout(r, 30));
  }
  const clients: ssh2.Client[] = [];
  async function connect(username = "ops:device") {
    const client = new ssh2.Client();
    clients.push(client);
    client.on("error", () => {});
    const ready = once(client, "ready");
    client.connect({
      host: "127.0.0.1",
      port: server.ssh!.info().port,
      username,
      password,
      hostVerifier: (raw) =>
        fingerprint(raw) === server.ssh!.info().fingerprint,
    });
    await ready;
    return client;
  }
  async function forward(
    client: ssh2.Client,
    host = "database.internal",
    port = echoPort,
  ) {
    return new Promise<ClientChannel>((resolve, reject) =>
      client.forwardOut("127.0.0.1", 3456, host, port, (error, stream) =>
        error ? reject(error) : resolve(stream),
      ),
    );
  }
  return {
    ...server,
    async mappingApi(
      method: "GET" | "POST" | "PUT" | "DELETE",
      suffix = "",
      payload?: any,
    ) {
      const result = await server.app.inject({
        method,
        url: "/api/v1/devices/device/tcp-mappings" + suffix,
        headers: { authorization: "Bearer " + auth },
        payload,
      });
      assert.equal(result.statusCode, 200, result.body);
      return result.json();
    },
    configure,
    setForwarding,
    holdForwards() {
      holdForwards = true;
    },
    requests,
    dataDir,
    echoPort,
    targetPort,
    connect,
    forward,
    agent,
    async close() {
      for (const client of clients) client.destroy();
      agent?.terminate();
      for (const state of agentSockets.values()) state.socket.destroy();
      await server.close();
      for (const client of downstream) client.end();
      for (const socket of sockets) socket.destroy();
      await Promise.all([
        new Promise<void>((r) => target.close(() => r())),
        new Promise<void>((r) => echo.close(() => r())),
      ]);
    },
  };
}
async function roundtrip(stream: ClientChannel | Socket, data: Buffer) {
  const chunks: Buffer[] = [];
  stream.on("data", (data) => chunks.push(data));
  const end = once(stream, "end");
  stream.end(data);
  await end;
  assert.deepEqual(Buffer.concat(chunks), data);
}
test(
  "busy Agent transfer leaves other SSH connections usable while its frames are paced",
  { timeout: 15000 },
  async () => {
    const f = await fixture("agent");
    try {
      const first = await f.forward(await f.connect());
      const second = await f.forward(await f.connect("admin:device"));
      // Reproduce the shared-budget failure without a minute-long bulk transfer.
      const late = JSON.stringify({
        v: 1,
        type: "terminal.closed",
        body: { session_id: "finished" },
      });
      for (let i = 0; i < 11900; i++) f.agent!.send(late);
      let finished = false;
      const large = roundtrip(first, Buffer.alloc(2 * 1024 * 1024, 42)).then(
        () => {
          finished = true;
        },
      );
      await new Promise((r) => setTimeout(r, 100));
      await roundtrip(second, Buffer.from("independent query"));
      assert.equal(
        finished,
        false,
        "another account can finish while the bulk transfer is active",
      );
      await large;
      assert.equal(f.agent?.readyState, WebSocket.OPEN);
    } finally {
      await f.close();
    }
  },
);
for (const kind of ["ssh", "agent"] as const) {
  test(
    `${kind} forwarding carries binary data with half-close, audits metadata and enforces device grants`,
    { timeout: 15000 },
    async () => {
      const f = await fixture(kind);
      try {
        const client = await f.connect();
        const data = randomBytes(256 * 1024);
        await roundtrip(await f.forward(client), data);
        await until(() =>
          f.store.db
            .prepare("SELECT 1 FROM audit WHERE action='ssh.forward_closed'")
            .get(),
        );
        const audits = f.store.db
          .prepare("SELECT * FROM audit WHERE action LIKE 'ssh.forward_%'")
          .all();
        assert.equal(audits.length, 2);
        const closed = JSON.parse(audits[1]!.detail_json as string);
        assert.equal(closed.bytes_sent, data.length);
        assert.equal(closed.bytes_received, data.length);
        assert.equal(
          JSON.stringify(audits).includes(
            data.subarray(0, 20).toString("base64"),
          ),
          false,
        );
        assert.deepEqual(f.requests[0], {
          host: "database.internal",
          port: f.echoPort,
        });
        const channel = await f.forward(client);
        channel.on("error", () => {});
        channel.resume();
        const ended = once(channel, "close");
        f.store.db
          .prepare("UPDATE users SET device_scope='[]' WHERE username='ops'")
          .run();
        await ended;
        await assert.rejects(f.connect(), /authentication/);
      } finally {
        await f.close();
      }
    },
  );
  test(
    `${kind} forwarding rejects unbound users, revoked default grants and session expiry`,
    { timeout: 15000 },
    async () => {
      const f = await fixture(kind);
      try {
        const unbound = await f.connect("ops");
        await assert.rejects(f.forward(unbound));
        assert.equal(f.requests.length, 0);
        const client = await f.connect();
        const channel = await f.forward(client);
        channel.on("error", () => {});
        channel.resume();
        let ended = once(channel, "close");
        f.store.db
          .prepare(
            "DELETE FROM account_authorizations WHERE device_id='device'",
          )
          .run();
        await ended;
        await assert.rejects(f.forward(client));
        const admin = await f.connect("admin:device"),
          active = await f.forward(admin);
        active.on("error", () => {});
        active.resume();
        ended = once(active, "close");
        f.store.db.prepare("UPDATE user_sessions SET expires_at=0").run();
        await ended;
      } finally {
        await f.close();
      }
    },
  );
}
test(
  "SSH forwarding pins target host keys, rejects invalid destinations and closes on configuration changes",
  { timeout: 15000 },
  async () => {
    const f = await fixture();
    try {
      const client = await f.connect();
      await assert.rejects(f.forward(client, "bad host"));
      await f.configure("SHA256:" + "a".repeat(43));
      await assert.rejects(f.forward(client));
      assert.equal(f.requests.length, 0);
      await f.configure();
      const channel = await f.forward(client);
      channel.on("error", () => {});
      channel.resume();
      const ended = once(channel, "close");
      await f.configure();
      await ended;
    } finally {
      await f.close();
    }
  },
);
test(
  "system OpenSSH -N -L and -J through a selected SSH device",
  { timeout: 20000 },
  async () => {
    const f = await fixture();
    const children: ReturnType<typeof spawn>[] = [];
    try {
      const askpass = join(f.dataDir, "askpass"),
        config = join(f.dataDir, "ssh_config"),
        known = join(f.dataDir, "known_hosts");
      writeFileSync(askpass, `#!/bin/sh\nprintf '%s\\n' '${password}'\n`, {
        mode: 0o700,
      });
      const gatewayKey = ssh2.utils.parseKey(
        readFileSync(join(f.dataDir, "ssh_host_ed25519_key")),
      ) as ssh2.ParsedKey;
      writeFileSync(
        known,
        `[127.0.0.1]:${f.ssh!.info().port} ${gatewayKey.type} ${gatewayKey.getPublicSSH().toString("base64")}\n[127.0.0.1]:${f.targetPort} ${parsed.type} ${parsed.getPublicSSH().toString("base64")}\n`,
      );
      writeFileSync(
        config,
        `Host *\n  StrictHostKeyChecking yes\n  UserKnownHostsFile ${known}\n  PreferredAuthentications password\n  PubkeyAuthentication no\n  ServerAliveInterval 1\n  ServerAliveCountMax 2\n`,
      );
      for (const jump of [false, true]) {
        const probe = createServer();
        await new Promise<void>((r) => probe.listen(0, "127.0.0.1", r));
        const localPort = (probe.address() as any).port;
        await new Promise<void>((r) => probe.close(() => r()));
        const args = [
          "-F",
          config,
          "-N",
          "-o",
          "ExitOnForwardFailure=yes",
          "-L",
          `127.0.0.1:${localPort}:database.internal:${f.echoPort}`,
        ];
        if (jump)
          args.push(
            "-J",
            `ops:device@127.0.0.1:${f.ssh!.info().port}`,
            "-p",
            String(f.targetPort),
            "terminal@127.0.0.1",
          );
        else
          args.push(
            "-p",
            String(f.ssh!.info().port),
            "-l",
            "ops:device",
            "127.0.0.1",
          );
        const child = spawn("ssh", args, {
          env: {
            ...process.env,
            SSH_ASKPASS: askpass,
            SSH_ASKPASS_REQUIRE: "force",
            DISPLAY: "farhelm-test",
          },
          stdio: ["ignore", "pipe", "pipe"],
        });
        children.push(child);
        let errors = "";
        child.stderr!.on("data", (d) => (errors += d));
        let socket: Socket | undefined;
        await until(async () => {
          assert.equal(child.exitCode, null, errors);
          const candidate = tcpConnect({
            host: "127.0.0.1",
            port: localPort,
            allowHalfOpen: true,
          });
          try {
            await once(candidate, "connect");
            socket = candidate;
            return true;
          } catch {
            candidate.destroy();
            return false;
          }
        }, "OpenSSH local listener");
        await roundtrip(socket!, randomBytes(65536));
        socket!.destroy();
        const exit = once(child, "exit");
        child.kill("SIGTERM");
        await exit;
      }
    } finally {
      for (const child of children) child.kill("SIGTERM");
      await f.close();
    }
  },
);
for (const kind of ["ssh", "agent"] as const) {
  test(
    `${kind} forwarding bounds concurrent channels, releases slots and closes all channels on account disable`,
    { timeout: 20000 },
    async () => {
      const f = await fixture(kind);
      try {
        const client = await f.connect(),
          channels: ClientChannel[] = [];
        for (let i = 0; i < 16; i++) {
          const channel = await f.forward(client);
          channel.resume();
          channel.on("error", () => {});
          channels.push(channel);
        }
        await assert.rejects(f.forward(client));
        assert.equal(f.requests.length, 16);
        const closed = once(channels[0]!, "close");
        channels[0]!.destroy();
        await closed;
        const replacement = await f.forward(client);
        replacement.resume();
        replacement.on("error", () => {});
        const ended = once(replacement, "close");
        f.store.db
          .prepare("UPDATE users SET enabled=0 WHERE username='ops'")
          .run();
        await ended;
        await until(
          () =>
            Number(
              f.store.db
                .prepare(
                  "SELECT COUNT(*) AS n FROM audit WHERE action='ssh.forward_closed'",
                )
                .get()!.n,
            ) === 17,
        );
      } finally {
        await f.close();
      }
    },
  );
}
test(
  "failed and unauditable forwarding never accepts a channel and releases pending resources",
  { timeout: 15000 },
  async () => {
    const f = await fixture();
    try {
      const client = await f.connect();
      const probe = createServer();
      await new Promise<void>((r) => probe.listen(0, "127.0.0.1", r));
      const unavailable = (probe.address() as any).port;
      await new Promise<void>((r) => probe.close(() => r()));
      await assert.rejects(f.forward(client, "127.0.0.1", unavailable));
      const audit = f.store.audit.bind(f.store);
      f.store.audit = (action, ...args) => {
        if (action === "ssh.forward_opened") throw new Error("storage failed");
        return audit(action, ...args);
      };
      await assert.rejects(f.forward(client));
      f.store.audit = audit;
      await roundtrip(
        await f.forward(client),
        Buffer.from("after failed requests"),
      );
    } finally {
      await f.close();
    }
  },
);
for (const kind of ["ssh", "agent"] as const) {
  test(
    `${kind} forwarding drains a slow client's SSH window before closing`,
    { timeout: 30000 },
    async () => {
      const f = await fixture(kind);
      try {
        const channel = await f.forward(await f.connect());
        const data = randomBytes(4 * 1024 * 1024),
          chunks: Buffer[] = [];
        channel.end(data);
        await new Promise((r) => setTimeout(r, 200));
        channel.on("data", (bytes) => chunks.push(bytes));
        await once(channel, "end");
        const received = Buffer.concat(chunks);
        assert.equal(received.length, data.length);
        assert.ok(received.equals(data));
      } finally {
        await f.close();
      }
    },
  );
}

for (const kind of ["ssh", "agent"] as const) {
  test(
    `${kind} device policy denies before dialing, closes live forwards immediately and isolates other devices`,
    { timeout: 15000 },
    async () => {
      const f = await fixture(kind, false);
      try {
        const client = await f.connect();
        const admin = await f.connect("admin:device");
        await assert.rejects(f.forward(client));
        await assert.rejects(f.forward(admin));
        assert.equal(
          f.requests.length,
          0,
          "disabled policy applies even to admins, before any target connection",
        );
        f.store.db
          .prepare(
            "INSERT INTO devices(id,public_key,name,created_at,connection_kind) VALUES('other','other-key','other-device',1,'ssh')",
          )
          .run();
        await f.configure(undefined, "other");
        await f.setForwarding(true, "other");
        const other = await f.forward(await f.connect("admin:other"));
        await f.setForwarding(true);
        const channel = await f.forward(client);
        channel.on("error", () => {});
        channel.resume();
        const closed = once(channel, "close");
        await f.setForwarding(false);
        assert.equal(
          f.store.db
            .prepare(
              "SELECT count(*) AS n FROM audit WHERE action='ssh.forward_closed' AND device_id='device'",
            )
            .get()!.n,
          1,
          "API response waits until live forwards have been stopped",
        );
        await closed;
        const requests = f.requests.length;
        await assert.rejects(f.forward(client));
        assert.equal(f.requests.length, requests);
        await roundtrip(other, Buffer.from("other device remains connected"));
        await f.setForwarding(true);
        await roundtrip(
          await f.forward(client),
          Buffer.from("same authenticated connection after re-enable"),
        );
      } finally {
        await f.close();
      }
    },
  );
}

for (const kind of ["ssh", "agent"] as const) {
  test(
    `${kind} disabling forwarding cancels pending opens before they can be accepted`,
    { timeout: 15000 },
    async () => {
      const f = await fixture(kind);
      try {
        const client = await f.connect();
        f.holdForwards();
        const rejected = assert.rejects(f.forward(client));
        await until(
          () => f.requests.length === 1,
          "pending forwarding request",
        );
        await f.setForwarding(false);
        const closed = JSON.parse(
          f.store.db
            .prepare(
              "SELECT detail_json FROM audit WHERE action='ssh.forward_closed'",
            )
            .get()!.detail_json as string,
        );
        assert.equal(closed.opened, false);
        assert.equal(closed.bytes_sent, 0);
        await rejected;
        assert.equal(
          f.store.db
            .prepare(
              "SELECT count(*) AS n FROM audit WHERE action='ssh.forward_opened'",
            )
            .get()!.n,
          0,
        );
      } finally {
        await f.close();
      }
    },
  );
}

for (const kind of ["ssh", "agent"] as const) {
  test(
    `${kind} web mapping forwards raw TCP, checks sources, revokes active connections and closes its listener`,
    { timeout: 15000 },
    async () => {
      const f = await fixture(kind);
      const clients: Socket[] = [];
      try {
        const probe = createServer();
        await new Promise<void>((resolve) =>
          probe.listen(0, "127.0.0.1", resolve),
        );
        const port = (probe.address() as any).port;
        await new Promise<void>((resolve) => probe.close(() => resolve()));
        const config = {
          v: 1,
          name: "mapped db",
          enabled: true,
          listen_host: "127.0.0.1",
          listen_port: port,
          target_host: "database.internal",
          target_port: f.echoPort,
          source_cidrs: ["127.0.0.1/32"],
        };
        let mapping = (await f.mappingApi("POST", "", config)).mapping;
        const connect = async () => {
          const socket = tcpConnect({
            host: "127.0.0.1",
            port,
            allowHalfOpen: false,
          });
          clients.push(socket);
          socket.on("error", () => {});
          await once(socket, "connect");
          return socket;
        };
        await roundtrip(await connect(), randomBytes(512 * 1024));
        const channel = await connect();
        channel.resume();
        await until(() => f.requests.length === 2);
        const closed = once(channel, "close");
        mapping = (
          await f.mappingApi("PUT", "/" + mapping.id, {
            ...config,
            revision: mapping.revision,
            source_cidrs: ["192.0.2.1"],
          })
        ).mapping;
        await closed;
        const denied = await connect();
        denied.resume();
        await once(denied, "close");
        assert.equal(
          f.requests.length,
          2,
          "denied source never reaches backend",
        );
        assert.ok(
          f.store.db
            .prepare(
              "SELECT 1 FROM audit WHERE action='mapping.connection_denied'",
            )
            .get(),
        );
        mapping = (
          await f.mappingApi("PUT", "/" + mapping.id, {
            ...config,
            revision: mapping.revision,
          })
        ).mapping;
        const running = await connect();
        running.resume();
        await until(() => f.requests.length === 3);
        const ended = once(running, "close");
        await f.setForwarding(false);
        await ended;
        const view = (await f.mappingApi("GET")).mappings[0];
        assert.equal(view.status, "error");
        assert.equal(view.error, "DEVICE_FORWARDING_DISABLED");
        await assert.rejects(connect(), /ECONNREFUSED/);
        const audits = f.store.db
          .prepare(
            "SELECT detail_json FROM audit WHERE action='mapping.forward_opened'",
          )
          .all();
        assert.equal(audits.length, 3);
        assert.equal(
          JSON.parse(audits[0]!.detail_json as string).backend,
          kind,
        );
        assert.equal(
          JSON.parse(audits[0]!.detail_json as string).source_address,
          "127.0.0.1",
        );
        await f.setForwarding(true);
        mapping = (
          await f.mappingApi("PUT", "/" + mapping.id, {
            ...config,
            revision: mapping.revision,
          })
        ).mapping;
        f.holdForwards();
        const pending = await connect();
        pending.resume();
        await until(() => f.requests.length === 4, "pending mapped connection");
        const cancelled = once(pending, "close");
        f.store.db
          .prepare("UPDATE users SET enabled=0 WHERE username='admin'")
          .run();
        await cancelled;
        await assert.rejects(connect(), /ECONNREFUSED/);
        const pendingAudit = f.store.db
          .prepare(
            "SELECT detail_json FROM audit WHERE action='mapping.forward_closed' ORDER BY id DESC LIMIT 1",
          )
          .get()!;
        assert.equal(
          JSON.parse(pendingAudit.detail_json as string).opened,
          false,
          "disabled owner cancels pending mapping and listening port",
        );
      } finally {
        for (const socket of clients) socket.destroy();
        await f.close();
      }
    },
  );
}
