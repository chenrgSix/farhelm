import { test } from "node:test";
import assert from "node:assert/strict";
import {
  mkdtempSync,
  readFileSync,
  rmSync,
  mkdirSync,
  writeFileSync,
  symlinkSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { generateKeyPairSync, sign, randomUUID } from "node:crypto";
import { once } from "node:events";
import { request } from "node:https";
import { WebSocket } from "ws";
import { buildServer } from "../src/server.js";
import { canonical, hash } from "../src/util.js";
const root = mkdtempSync(join(tmpdir(), "fleet-server-test-"));
execFileSync(
  "openssl",
  [
    "req",
    "-x509",
    "-newkey",
    "rsa:2048",
    "-nodes",
    "-keyout",
    join(root, "key.pem"),
    "-out",
    join(root, "cert.pem"),
    "-days",
    "1",
    "-subj",
    "/CN=localhost",
    "-addext",
    "subjectAltName=IP:127.0.0.1,DNS:localhost",
  ],
  { stdio: "ignore" },
);
const tlsCert = readFileSync(join(root, "cert.pem")),
  tlsKey = readFileSync(join(root, "key.pem"));
const config = {
  dataDir: join(root, "data"),
  tlsCert,
  tlsKey,
  adminUsername: "admin",
  adminPassword: "local-test-password",
  testMode: true,
  heartbeatTimeoutMs: 60000,
};
async function fixture(opts = {}) {
  const s = await buildServer({ ...config, ...opts });
  await s.app.listen({ host: "127.0.0.1", port: 0 });
  const address = s.app.server.address() as any;
  const url = `https://127.0.0.1:${address.port}`;
  return { ...s, url };
}
async function api(
  s: any,
  method: string,
  url: string,
  payload?: unknown,
  auth?: string,
  extra = {},
) {
  const r = await s.app.inject({
    method,
    url,
    payload,
    headers: { ...(auth ? { authorization: "Bearer " + auth } : {}), ...extra },
  });
  let body;
  try {
    body = r.json();
  } catch {
    body = r.rawPayload;
  }
  return { status: r.statusCode, body };
}
async function login(s: any, username = "admin") {
  const r = await api(s, "POST", "/api/v1/login", {
    username,
    password: "local-test-password",
  });
  assert.equal(r.status, 200);
  return r.body.access_token as string;
}
async function enroll(s: any, admin: string) {
  const pair = generateKeyPairSync("ed25519");
  const public_key = (
    pair.publicKey.export({ type: "spki", format: "der" }) as Buffer
  )
    .subarray(-32)
    .toString("base64");
  const t = await api(
    s,
    "POST",
    "/api/v1/enrollment-tokens",
    { v: 1, ttl_seconds: 600 },
    admin,
  );
  assert.equal(t.status, 200);
  const enrollment_token = t.body.enrollment_token;
  const proof = async (purpose: string, device_id?: string) => {
    const c = await api(s, "POST", "/api/agent/challenge", {
      v: 1,
      purpose,
      public_key,
      ...(purpose === "enroll" ? { enrollment_token } : {}),
      ...(device_id ? { device_id } : {}),
    });
    assert.equal(c.status, 200);
    return {
      v: 1,
      challenge_id: c.body.challenge_id,
      signature: sign(
        null,
        Buffer.from(c.body.signing_payload, "base64"),
        pair.privateKey,
      ).toString("base64"),
    };
  };
  const p = await proof("enroll");
  const e = await api(s, "POST", "/api/agent/enroll", {
    ...p,
    name: "test-device",
  });
  assert.equal(e.status, 200);
  const device_id = e.body.device_id;
  return { device_id, public_key, enrollment_token, proof, pair, p };
}
function websocketClient(url: string, accessToken: string) {
  const ws = new WebSocket(url.replace("https:", "wss:") + "/agent/ws", {
    ca: tlsCert,
    headers: { authorization: "Bearer " + accessToken },
  });
  const messages: any[] = [];
  ws.on("message", (x) => messages.push(JSON.parse(x.toString())));
  const wait = async (
    type: string,
    predicate: (b: any) => boolean = () => true,
  ) => {
    const start = Date.now();
    while (Date.now() - start < 3000) {
      const i = messages.findIndex((x) => x.type === type && predicate(x.body));
      if (i >= 0) return messages.splice(i, 1)[0].body;
      await new Promise((r) => setTimeout(r, 10));
    }
    throw new Error(
      "Timed out waiting for " + type + ": " + JSON.stringify(messages),
    );
  };
  const send = (type: string, body: any) =>
    ws.send(JSON.stringify({ v: 1, type, body }));
  return { ws, messages, wait, send };
}
async function httpsPut(s: any, path: string, body: Buffer, auth: string) {
  return await new Promise<{
    status: number;
    body: any;
  }>((resolve, reject) => {
    const req = request(
      s.url + path,
      {
        method: "PUT",
        ca: tlsCert,
        headers: {
          authorization: "Bearer " + auth,
          "content-type": "application/octet-stream",
          "content-length": body.length,
        },
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on("data", (x) => chunks.push(x));
        res.on("end", () =>
          resolve({
            status: res.statusCode!,
            body: JSON.parse(Buffer.concat(chunks).toString()),
          }),
        );
      },
    );
    req.on("error", reject);
    req.end(body);
  });
}
test("durable Ed25519 enrollment, scoped RBAC, HTTPS objects, WSS ACK/replay and revocation", async () => {
  let s = await fixture();
  let ws: WebSocket | undefined;
  try {
    assert.equal(
      s.store.db.prepare("PRAGMA synchronous").get()!.synchronous,
      2,
    );
    const admin = await login(s);
    const device = await enroll(s, admin);
    assert.equal(
      (
        await api(s, "POST", "/api/agent/enroll", {
          ...device.p,
          name: "again",
        })
      ).status,
      401,
      "challenge single use",
    );
    const recovery = await api(s, "POST", "/api/agent/enroll", {
      ...(await device.proof("enroll")),
      name: "again",
    });
    assert.equal(recovery.body.device_id, device.device_id);
    const wrong = generateKeyPairSync("ed25519");
    const badProof = await device.proof("auth");
    badProof.signature = sign(
      null,
      Buffer.from("wrong"),
      wrong.privateKey,
    ).toString("base64");
    assert.equal(
      (await api(s, "POST", "/api/agent/auth", badProof)).status,
      401,
    );
    const auth = await api(
      s,
      "POST",
      "/api/agent/auth",
      await device.proof("auth"),
    );
    assert.equal(auth.body.device_id, device.device_id, "key-only recovery");
    const accessToken = auth.body.access_token;
    for (const role of ["business", "auditor", "ops"] as const) {
      s.store.seedUser({
        username: role,
        password: "local-test-password",
        role,
        deviceScope: role === "ops" ? [] : "*",
      });
      const userToken = await login(s, role);
      const r = await api(
        s,
        "POST",
        "/api/v1/commands",
        {
          v: 1,
          device_id: device.device_id,
          argv: ["echo", "hello"],
          cwd: "/tmp",
          timeout_ms: 1000,
          max_output_bytes: 1024,
          ttl_seconds: 60,
        },
        userToken,
        { "idempotency-key": role },
      );
      assert.equal(r.status, 403);
      assert.equal(
        (await api(s, "POST", "/api/v1/enrollment-tokens", { v: 1 }, userToken))
          .status,
        403,
      );
    }
    const client = websocketClient(s.url, accessToken);
    ws = client.ws;
    await once(ws, "open");
    client.send("agent.hello", { agent_version: "test/1" });
    const command = {
      v: 1,
      device_id: device.device_id,
      argv: ["/bin/echo", "hello"],
      cwd: "/tmp",
      timeout_ms: 1000,
      max_output_bytes: 1024,
      ttl_seconds: 60,
    };
    const cmd = await api(s, "POST", "/api/v1/commands", command, admin, {
      "idempotency-key": "unique-request",
    });
    assert.equal(cmd.status, 200);
    const task = await client.wait("task.assign");
    const { payload_hash, ...immutable } = task;
    assert.equal(hash(canonical(immutable)), payload_hash);
    const same = await api(s, "POST", "/api/v1/commands", command, admin, {
      "idempotency-key": "unique-request",
    });
    assert.equal(same.body.task_id, task.task_id);
    assert.equal(
      (
        await api(
          s,
          "POST",
          "/api/v1/commands",
          { ...command, argv: ["different"] },
          admin,
          { "idempotency-key": "unique-request" },
        )
      ).status,
      409,
    );
    const event = (kind: string, seq: number, payload = {}) => ({
      event_id: randomUUID(),
      task_id: task.task_id,
      seq,
      kind,
      at: Date.now(),
      payload,
    });
    const accepted = event("accepted", 1);
    s.testHooks!.dropNextAck("accepted");
    client.send("task.event", accepted);
    await new Promise((r) => setTimeout(r, 50));
    assert.equal(s.store.task(task.task_id).status, "ACCEPTED");
    assert.equal(
      client.messages.some((m) => m.type === "event.ack"),
      false,
    );
    client.send("task.event", accepted);
    assert.equal((await client.wait("event.ack")).event_id, accepted.event_id);
    client.send("task.event", { ...accepted, at: accepted.at + 1 });
    assert.equal((await client.wait("error")).code, "EVENT_ID_CONFLICT");
    const started = event("started", 2);
    client.send("task.event", started);
    await client.wait("event.ack");
    const stdout = Buffer.from([104, 101, 108, 108, 111, 10, 0xff]),
      stderr = Buffer.alloc(0);
    const outRef = { sha256: hash(stdout), size: stdout.length },
      errRef = { sha256: hash(stderr), size: 0 };
    const finished = event("finished", 3, {
      status: "SUCCEEDED",
      exit_code: 0,
      reason: null,
      audit_complete: true,
      stdout: outRef,
      stderr: errRef,
      started_at: started.at,
      finished_at: Date.now(),
      cleanup: "process_group",
    });
    client.send("task.event", finished);
    assert.equal((await client.wait("error")).code, "ARTIFACT_NOT_DURABLE");
    assert.equal(s.store.task(task.task_id).status, "RUNNING");
    const path = `/api/agent/tasks/${task.task_id}/artifacts/`;
    assert.equal(
      (
        await httpsPut(
          s,
          path + hash(Buffer.from("wrong")),
          stdout,
          accessToken,
        )
      ).status,
      422,
    );
    assert.equal(
      (await httpsPut(s, path + outRef.sha256, stdout, accessToken)).status,
      200,
    );
    assert.equal(
      (await httpsPut(s, path + errRef.sha256, stderr, accessToken)).status,
      200,
    );
    s.testHooks!.dropNextAck("finished");
    client.send("task.event", finished);
    await new Promise((r) => setTimeout(r, 50));
    assert.equal(s.store.task(task.task_id).status, "SUCCEEDED");
    client.send("task.event", finished);
    await client.wait("event.ack");
    assert.equal(
      (
        s.store.db
          .prepare("SELECT COUNT(*) AS n FROM events WHERE task_id=?")
          .get(task.task_id) as any
      ).n,
      3,
    );
    const output = await api(
      s,
      "GET",
      `/api/v1/tasks/${task.task_id}/output/stdout`,
      undefined,
      admin,
    );
    assert.equal(output.status, 200);
    assert.deepEqual(output.body, stdout);
    assert.ok(
      (await api(s, "GET", "/api/v1/audit", undefined, admin)).body.audit.some(
        (a: any) => a.action === "output.viewed",
      ),
    );
    const newer = websocketClient(s.url, accessToken);
    const oldClosed = once(ws, "close");
    await once(newer.ws, "open");
    await oldClosed;
    ws = newer.ws;
    newer.send("agent.hello", { agent_version: "test/2" });
    await s.close();
    ws = undefined;
    s = await fixture();
    const admin2 = await login(s);
    assert.equal(
      (await api(s, "GET", `/api/v1/tasks/${task.task_id}`, undefined, admin2))
        .body.status,
      "SUCCEEDED",
    );
    assert.deepEqual(
      (
        await api(
          s,
          "GET",
          `/api/v1/tasks/${task.task_id}/output/stdout`,
          undefined,
          admin2,
        )
      ).body,
      stdout,
    );
    const fresh = await api(s, "POST", "/api/agent/challenge", {
      v: 1,
      purpose: "auth",
      public_key: device.public_key,
    });
    const auth2 = await api(s, "POST", "/api/agent/auth", {
      v: 1,
      challenge_id: fresh.body.challenge_id,
      signature: sign(
        null,
        Buffer.from(fresh.body.signing_payload, "base64"),
        device.pair.privateKey,
      ).toString("base64"),
    });
    const revokeClient = websocketClient(s.url, auth2.body.access_token);
    ws = revokeClient.ws;
    await once(ws, "open");
    revokeClient.send("agent.hello", { agent_version: "test/3" });
    const closed = once(ws, "close");
    assert.equal(
      (
        await api(
          s,
          "POST",
          `/api/v1/devices/${device.device_id}/revoke`,
          { v: 1 },
          admin2,
        )
      ).status,
      200,
    );
    await closed;
    assert.equal(
      (
        await api(s, "POST", "/api/agent/challenge", {
          v: 1,
          purpose: "auth",
          public_key: device.public_key,
        })
      ).status,
      401,
    );
  } finally {
    ws?.terminate();
    await s.close();
  }
});
test("strict bounds, authentication, short token expiry and contiguous events", async () => {
  const s = await fixture({
    dataDir: join(root, "bounds"),
    deviceTokenTtlMs: 1000,
  });
  let ws: WebSocket | undefined;
  try {
    const admin = await login(s);
    const device = await enroll(s, admin);
    const auth = await api(
      s,
      "POST",
      "/api/agent/auth",
      await device.proof("auth"),
    );
    const client = websocketClient(s.url, auth.body.access_token);
    ws = client.ws;
    await once(ws, "open");
    client.send("agent.hello", { agent_version: "test" });
    const command = {
      v: 1,
      device_id: device.device_id,
      argv: ["true"],
      cwd: "/tmp",
      timeout_ms: 100,
      max_output_bytes: 0,
      ttl_seconds: 1,
    };
    assert.equal(
      (
        await api(s, "POST", "/api/v1/commands", command, undefined, {
          "idempotency-key": "x",
        })
      ).status,
      401,
    );
    assert.equal(
      (
        await api(
          s,
          "POST",
          "/api/v1/commands",
          { ...command, argv: ["./bad"] },
          admin,
          { "idempotency-key": "x" },
        )
      ).status,
      400,
    );
    const cmd = await api(s, "POST", "/api/v1/commands", command, admin, {
      "idempotency-key": "x",
    });
    assert.equal(cmd.status, 200);
    await client.wait("task.assign");
    client.send("task.event", {
      event_id: randomUUID(),
      task_id: cmd.body.task_id,
      seq: 2,
      kind: "started",
      at: Date.now(),
      payload: {},
    });
    assert.equal((await client.wait("error")).code, "EVENT_GAP");
    assert.equal(s.store.task(cmd.body.task_id).last_seq, 0);
    const close = once(ws, "close");
    await close;
    assert.equal(
      (await api(s, "GET", "/api/v1/devices", undefined, admin)).body.devices[0]
        .control_online,
      false,
    );
    assert.equal(
      (
        await api(s, "POST", "/api/agent/challenge", {
          v: 2,
          purpose: "auth",
          public_key: device.public_key,
        })
      ).status,
      400,
    );
    assert.equal(
      (await api(s, "POST", "/api/v1/enrollment-tokens", {}, admin)).status,
      400,
    );
  } finally {
    ws?.terminate();
    await s.close();
  }
});

test("same-origin static assets are isolated, API paths never use SPA fallback", async () => {
  const web = join(root, "web");
  mkdirSync(web);
  writeFileSync(join(web, "index.html"), "<h1>Fleet</h1>");
  writeFileSync(join(web, "app.js"), "export const ok=true");
  writeFileSync(join(web, ".env"), "secret");
  symlinkSync(join(root, "key.pem"), join(web, "escape.pem"));
  const s = await fixture({ dataDir: join(root, "static-data"), webDist: web });
  try {
    assert.equal((await s.app.inject({ url: "/" })).body, "<h1>Fleet</h1>");
    assert.equal(
      (await s.app.inject({ url: "/devices/one" })).body,
      "<h1>Fleet</h1>",
    );
    assert.equal((await s.app.inject({ url: "/app.js" })).statusCode, 200);
    for (const url of [
      "/api",
      "/api/unknown",
      "/agent/unknown",
      "/.env",
      "/escape.pem",
      "/missing.js",
      "/%2e%2e/key.pem",
    ])
      assert.equal((await s.app.inject({ url })).statusCode, 404, url);
    assert.ok(
      (await s.app.inject({ url: "/" })).headers["content-security-policy"],
    );
  } finally {
    await s.close();
  }
});

test("cross-device denial is auditable; malformed Unicode and huge frames reject", async () => {
  const s = await fixture({ dataDir: join(root, "scope-data") });
  let ws: WebSocket | undefined;
  try {
    const admin = await login(s);
    const device = await enroll(s, admin);
    const ops = s.store.seedUser({
      username: "limited",
      password: "local-test-password",
      role: "ops",
      deviceScope: [],
    });
    const opToken = await login(s, "limited");
    const command = {
      v: 1,
      device_id: device.device_id,
      argv: ["true"],
      cwd: "/tmp",
      timeout_ms: 100,
      max_output_bytes: 0,
      ttl_seconds: 60,
    };
    assert.equal(
      (
        await api(s, "POST", "/api/v1/commands", command, opToken, {
          "idempotency-key": "scope",
        })
      ).status,
      403,
    );
    const denial = (
      await api(s, "GET", "/api/v1/audit", undefined, admin)
    ).body.audit.find((a: any) => a.action === "authorization.denied");
    assert.equal(denial.actor_id, ops.id);
    assert.equal(denial.device_id, device.device_id);
    assert.equal(denial.detail.reason, "DEVICE_SCOPE_DENIED");
    assert.equal(
      (
        await api(
          s,
          "POST",
          "/api/v1/commands",
          { ...command, argv: ["echo", String.fromCharCode(0xd800)] },
          admin,
          { "idempotency-key": "bad-unicode" },
        )
      ).status,
      400,
    );
    assert.equal(
      (
        await api(
          s,
          "POST",
          "/api/v1/commands",
          { ...command, argv: ["echo", "界".repeat(3000)] },
          admin,
          { "idempotency-key": "bad-bytes" },
        )
      ).status,
      400,
    );
    const auth = await api(
      s,
      "POST",
      "/api/agent/auth",
      await device.proof("auth"),
    );
    const client = websocketClient(s.url, auth.body.access_token);
    ws = client.ws;
    await once(ws, "open");
    const closed = once(ws, "close");
    ws.send("x".repeat(65537));
    const [code] = await closed;
    assert.equal(code, 1009);
  } finally {
    ws?.terminate();
    await s.close();
  }
});
test.after(() => rmSync(root, { recursive: true, force: true }));
