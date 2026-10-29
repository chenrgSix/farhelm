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
async function fixture(kind: "ssh" | "agent" = "ssh") {
  const downstream = new Set<ssh2.Connection>(),
    sockets = new Set<Socket>();
  const requests: { host: string; port: number }[] = [];
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
        socket.on("close", () => channel.destroy());
        channel.on("close", () => socket.destroy());
        channel.pipe(socket).pipe(channel);
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
  ) {
    const revision = Number(
      server.store.db
        .prepare(
          "SELECT revision FROM device_connections WHERE device_id='device'",
        )
        .get()?.revision ?? 0,
    );
    const result = await server.app.inject({
      method: "PUT",
      url: "/api/v1/devices/device/connection",
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
    configure,
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
