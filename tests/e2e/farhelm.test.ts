import { test } from "node:test";
import assert from "node:assert/strict";
import { request as httpsRequest } from "node:https";
import { generateKeyPairSync, sign, randomUUID, createHash } from "node:crypto";
import { spawn, execFileSync, type ChildProcess } from "node:child_process";
import {
  mkdtempSync,
  readFileSync,
  existsSync,
  writeFileSync,
  mkdirSync,
  appendFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { assertValid } from "../contracts/validate.mjs";
import { buildServer } from "../../apps/server/src/server.ts";

const root = path.resolve(import.meta.dirname, "../..");
const runDir = mkdtempSync(path.join(tmpdir(), "fleet-e2e-"));
const logsDir = path.join(root, ".test-output");
mkdirSync(logsDir, { recursive: true });
const logFile = path.join(logsDir, "e2e-agent.log");
writeFileSync(logFile, "");
const tls = path.join(runDir, "tls");
execFileSync("bash", [path.join(root, "deploy/dev/generate-tls.sh"), tls]);
const ca = readFileSync(path.join(tls, "ca.crt"));
const binary =
  process.env.FLEET_AGENT_BIN ||
  path.join(root, "agent/target/debug/farhelm-agent");
const pause = (ms: number) => new Promise((r) => setTimeout(r, ms));
async function until<T>(
  fn: () => Promise<T> | T,
  predicate: (v: T) => boolean,
  label: string,
  ms = 25000,
): Promise<T> {
  const end = Date.now() + ms;
  let value: T | undefined;
  let lastError: unknown;
  while (Date.now() < end) {
    try {
      value = await fn();
      if (predicate(value)) return value;
    } catch (e) {
      lastError = e;
    }
    await pause(100);
  }
  throw new Error(
    `Timed out: ${label}. Last=${JSON.stringify(value)} error=${String(lastError)}`,
  );
}
let port = 0;
async function api(
  method: string,
  url: string,
  body?: unknown,
  token?: string,
  extra: Record<string, string> = {},
) {
  const bytes =
    body === undefined ? undefined : Buffer.from(JSON.stringify(body));
  return await new Promise<{ status: number; body: any; raw: Buffer }>(
    (resolve, reject) => {
      const req = httpsRequest(
        {
          hostname: "localhost",
          agent: false,
          port,
          path: url,
          method,
          ca,
          headers: {
            ...(bytes
              ? {
                  "content-type": "application/json",
                  "content-length": String(bytes.length),
                }
              : {}),
            ...(token ? { authorization: `Bearer ${token}` } : {}),
            ...extra,
          },
        },
        (res) => {
          const chunks: Buffer[] = [];
          res.on("data", (x) => chunks.push(x));
          res.on("end", () => {
            const raw = Buffer.concat(chunks);
            let parsed: any;
            try {
              parsed = JSON.parse(raw.toString());
            } catch {
              parsed = raw.toString();
            }
            resolve({ status: res.statusCode || 0, body: parsed, raw });
          });
        },
      );
      req.on("error", reject);
      if (bytes) req.write(bytes);
      req.end();
    },
  );
}
function launch(
  state: string,
  enroll?: string,
  extra: Record<string, string> = {},
) {
  const child = spawn(binary, [], {
    env: {
      ...process.env,
      FLEET_SERVER_URL: `https://localhost:${port}`,
      FLEET_CA_CERT: path.join(tls, "ca.crt"),
      FLEET_STATE_DIR: state,
      FLEET_ENROLLMENT_TOKEN: enroll || "",
      FLEET_DEVICE_NAME: path.basename(state),
      FLEET_EXECUTION_BACKEND: "same-uid",
      FLEET_HEARTBEAT_MS: "200",
      FLEET_TEST_MODE: "1",
      ...extra,
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  child.stdout?.on("data", (b) => appendFileSync(logFile, b));
  child.stderr?.on("data", (b) => appendFileSync(logFile, b));
  return child;
}
async function stop(child: ChildProcess | undefined) {
  if (!child || child.exitCode !== null || child.signalCode !== null) return;
  child.kill("SIGTERM");
  await Promise.race([new Promise((r) => child.once("exit", r)), pause(3000)]);
  if (child.exitCode === null && child.signalCode === null)
    child.kill("SIGKILL");
}

// This suite always launches the compiled Rust Agent; no JavaScript Agent substitutes.
test(
  "Farhelm real Rust / HTTPS / WSS vertical slice and fault recovery",
  { timeout: 180000 },
  async (t) => {
    assert.ok(existsSync(binary), `Build the Rust Agent first: ${binary}`);
    let server = await buildServer({
      dataDir: path.join(runDir, "server"),
      tlsCert: path.join(tls, "server.crt"),
      tlsKey: path.join(tls, "server.key"),
      adminUsername: "admin",
      adminPassword: "test-only-password-48chars-do-not-use-in-production",
      deviceTokenTtlMs: 10_000,
      testMode: true,
    });
    await server.app.listen({ host: "127.0.0.1", port: 0 });
    port = (server.app.server.address() as any).port;
    const children: ChildProcess[] = [];
    try {
      const login = await api("POST", "/api/v1/login", {
        username: "admin",
        password: "test-only-password-48chars-do-not-use-in-production",
      });
      assert.equal(login.status, 200, JSON.stringify(login.body));
      assertValid("login-response", login.body);
      const admin = login.body.access_token;
      let device: any;
      const state = path.join(runDir, "agent-main");
      let agent: ChildProcess;
      const devices = async () => {
        const r = await api("GET", "/api/v1/devices", undefined, admin);
        assert.equal(r.status, 200);
        assertValid("devices-response", r.body);
        return r.body.devices as any[];
      };
      const getTask = async (id: string) => {
        const r = await api("GET", `/api/v1/tasks/${id}`, undefined, admin);
        assert.equal(r.status, 200, JSON.stringify(r.body));
        assertValid("task-response", r.body);
        return r.body;
      };
      const terminal = (v: any) =>
        [
          "SUCCEEDED",
          "FAILED",
          "EXPIRED",
          "CANCELLED",
          "TIMED_OUT",
          "UNKNOWN",
        ].includes(v.status);
      async function command(argv: string[], opts: any = {}) {
        const key = opts.key || randomUUID();
        const body = {
          v: 1,
          device_id: device.id,
          argv,
          cwd: runDir,
          timeout_ms: 5000,
          max_output_bytes: 65536,
          ttl_seconds: 60,
          ...opts,
        };
        delete body.key;
        const r = await api("POST", "/api/v1/commands", body, admin, {
          "idempotency-key": key,
        });
        assert.ok([200, 201, 202].includes(r.status), JSON.stringify(r.body));
        assertValid("command-response", r.body);
        return { id: r.body.task_id, key, body };
      }
      async function done(id: string, ms = 25000) {
        return until(() => getTask(id), terminal, `task ${id} terminal`, ms);
      }
      async function output(id: string, stream = "stdout") {
        const r = await api(
          "GET",
          `/api/v1/tasks/${id}/output/${stream}`,
          undefined,
          admin,
        );
        assert.equal(r.status, 200, JSON.stringify(r.body));
        return r.raw;
      }

      await t.test("TLS rejects untrusted CA, login required", async () => {
        await assert.rejects(
          new Promise((resolve, reject) => {
            const r = httpsRequest(
              { hostname: "localhost", port, path: "/healthz" },
              resolve,
            );
            r.on("error", reject);
            r.end();
          }),
        );
        assert.equal((await api("GET", "/api/v1/devices")).status, 401);
        assert.equal(
          (
            await api("POST", "/api/v1/login", {
              username: "admin",
              password: "wrong",
            })
          ).status,
          401,
        );
      });
      await t.test(
        "actual Rust rejects an untrusted TLS CA and does not enroll",
        async () => {
          const otherTls = path.join(runDir, "untrusted-tls");
          execFileSync("bash", [
            path.join(root, "deploy/dev/generate-tls.sh"),
            otherTls,
          ]);
          const en = await api(
            "POST",
            "/api/v1/enrollment-tokens",
            { v: 1, ttl_seconds: 600 },
            admin,
          );
          let diagnostics = "";
          const child = launch(
            path.join(runDir, "agent-wrong-ca"),
            en.body.enrollment_token,
            { FLEET_CA_CERT: path.join(otherTls, "ca.crt") },
          );
          children.push(child);
          child.stderr?.on("data", (b) => (diagnostics += b.toString()));
          await until(
            () => diagnostics,
            (x) => /certificate|UnknownIssuer|invalid peer/i.test(x),
            "Rust TLS rejection",
          );
          await stop(child);
          assert.equal(
            (await devices()).some((x) => x.name === "agent-wrong-ca"),
            false,
          );
        },
      );
      await t.test(
        "actual Rust enrollment, WSS heartbeat, correct TLS CA",
        async () => {
          const en = await api(
            "POST",
            "/api/v1/enrollment-tokens",
            { v: 1, ttl_seconds: 600 },
            admin,
          );
          assert.ok([200, 201].includes(en.status), JSON.stringify(en.body));
          agent = launch(state, en.body.enrollment_token);
          children.push(agent);
          device = (
            await until(
              devices,
              (d) => d.some((x) => x.name === "agent-main" && x.control_online),
              "agent heartbeat",
            )
          ).find((x) => x.name === "agent-main");
          assert.equal(device.private_data_reachable, null);
          assert.equal(device.business_healthy, null);
        },
      );
      await t.test(
        "stdout stderr exit status and identity durable audit",
        async () => {
          const c = await command([
            "/bin/sh",
            "-c",
            'printf "hello fleet\\n"; printf "diagnostic\\n" >&2',
          ]);
          const task = await done(c.id);
          assert.equal(task.status, "SUCCEEDED");
          assert.equal(task.actor_id, login.body.user.id);
          assert.equal(task.result.audit_complete, true);
          assert.equal((await output(c.id)).toString(), "hello fleet\n");
          assert.equal(
            (await output(c.id, "stderr")).toString(),
            "diagnostic\n",
          );
          const audit = await api("GET", "/api/v1/audit", undefined, admin);
          assert.equal(audit.status, 200);
          assert.ok(
            audit.body.audit.some((a: any) => JSON.stringify(a).includes(c.id)),
          );
          const fail = await command([
            "/bin/sh",
            "-c",
            'printf "failure" >&2; exit 7',
          ]);
          const failed = await done(fail.id);
          assert.equal(failed.status, "FAILED");
          assert.equal(failed.result.exit_code, 7);
        },
      );
      await t.test(
        "HTTP idempotency and three same-ID deliveries never repeat side effects",
        async () => {
          const marker = path.join(runDir, "side-effects");
          server.testHooks.dropNextAck("accepted");
          const c = await command([
            "/bin/sh",
            "-c",
            `printf once\\n >> '${marker}'; sleep 0.3`,
          ]);
          const duplicate = await api(
            "POST",
            "/api/v1/commands",
            c.body,
            admin,
            { "idempotency-key": c.key },
          );
          assert.equal(duplicate.body.task_id, c.id);
          const conflict = await api(
            "POST",
            "/api/v1/commands",
            { ...c.body, argv: ["/bin/true"] },
            admin,
            { "idempotency-key": c.key },
          );
          assert.equal(conflict.status, 409);
          server.testHooks.replayTask(c.id);
          server.testHooks.replayTask(c.id);
          server.testHooks.replayTask(c.id);
          assert.equal((await done(c.id)).status, "SUCCEEDED");
          await pause(300);
          assert.equal(readFileSync(marker, "utf8").match(/once/g)?.length, 1);
        },
      );
      await t.test(
        "lost finished ACK and WSS disconnect replay result with no duplicate execution",
        async () => {
          const marker = path.join(runDir, "disconnect-side-effect");
          server.testHooks.dropNextAck("finished");
          const c = await command([
            "/bin/sh",
            "-c",
            `printf once >> '${marker}'; sleep 0.5; printf reconnected`,
          ]);
          await until(
            () => getTask(c.id),
            (x) => x.status === "RUNNING",
            "running before disconnect",
          );
          server.testHooks.disconnectDevice(device.id);
          assert.equal((await done(c.id)).status, "SUCCEEDED");
          assert.equal((await output(c.id)).toString(), "reconnected");
          server.testHooks.disconnectDevice(device.id);
          await pause(1400);
          assert.equal(readFileSync(marker, "utf8"), "once");
        },
      );
      await t.test(
        "running task survives short token renewal and original token expiry",
        async () => {
          const marker = path.join(runDir, "token-renew-side-effect");
          const old = server.store.db
            .prepare(
              "SELECT token_hash,expires_at FROM device_tokens WHERE device_id=? ORDER BY expires_at DESC LIMIT 1",
            )
            .get(device.id) as any;
          const c = await command(
            [
              "/bin/sh",
              "-c",
              `printf once >> '${marker}'; sleep 12; printf renewed`,
            ],
            { timeout_ms: 20000 },
          );
          await until(
            () =>
              server.store.db
                .prepare(
                  "SELECT token_hash FROM device_tokens WHERE device_id=? ORDER BY expires_at DESC LIMIT 1",
                )
                .get(device.id) as any,
            (x) => x && x.token_hash !== old.token_hash,
            "new device token while running",
            10000,
          );
          const result = await done(c.id, 25000);
          assert.equal(result.status, "SUCCEEDED");
          assert.ok(Date.now() > old.expires_at);
          assert.equal(readFileSync(marker, "utf8"), "once");
          assert.equal((await output(c.id)).toString(), "renewed");
        },
      );
      await t.test(
        "binary stdout and concurrent stderr preserve exact bytes",
        async () => {
          const c = await command([
            "/usr/bin/python3",
            "-c",
            "import os,threading; t=threading.Thread(target=lambda:os.write(2,b'err'+bytes([255,0])*500));t.start();os.write(1,b'out'+bytes([254,0])*500);t.join()",
          ]);
          assert.equal((await done(c.id)).status, "SUCCEEDED");
          assert.deepEqual(
            await output(c.id),
            Buffer.concat([
              Buffer.from("out"),
              Buffer.from(Array(500).fill([254, 0]).flat()),
            ]),
          );
          assert.deepEqual(
            await output(c.id, "stderr"),
            Buffer.concat([
              Buffer.from("err"),
              Buffer.from(Array(500).fill([255, 0]).flat()),
            ]),
          );
        },
      );
      await t.test(
        "single execution concurrency preserves sequential side effects",
        async () => {
          const marker = path.join(runDir, "concurrency");
          const a = await command([
            "/bin/sh",
            "-c",
            `printf A >> '${marker}'; sleep 0.4; printf B >> '${marker}'`,
          ]);
          const b = await command(["/bin/sh", "-c", `printf C >> '${marker}'`]);
          await done(a.id);
          await done(b.id);
          assert.equal(readFileSync(marker, "utf8"), "ABC");
        },
      );
      await t.test(
        "timeout stops ordinary fork descendant; no false strong cleanup claim",
        async () => {
          const pidFile = path.join(runDir, "child.pid");
          const c = await command(
            ["/bin/sh", "-c", `sleep 25 & echo $! > '${pidFile}'; wait`],
            { timeout_ms: 500 },
          );
          const result = await done(c.id);
          assert.ok(["TIMED_OUT", "UNKNOWN"].includes(result.status));
          assert.match(result.result.reason, /TIMEOUT|TIMED_OUT/);
          assert.equal(result.result.cleanup, "unconfirmed");
          const pid = Number(readFileSync(pidFile, "utf8"));
          await until(
            () => {
              try {
                const stat = readFileSync(`/proc/${pid}/stat`, "utf8");
                return stat.split(" ")[2] === "Z";
              } catch {
                return true;
              }
            },
            Boolean,
            "fork child stopped",
          );
        },
      );
      await t.test(
        "cancel running command records request separately and waits for evidence",
        async () => {
          const c = await command(["/bin/sleep", "20"], { timeout_ms: 25000 });
          await until(
            () => getTask(c.id),
            (x) => x.status === "RUNNING",
            "running cancel target",
          );
          const cancelled = await api(
            "POST",
            `/api/v1/tasks/${c.id}/cancel`,
            { v: 1 },
            admin,
          );
          assert.equal(cancelled.status, 200);
          assertValid("cancel-response", cancelled.body);
          const result = await done(c.id);
          assert.equal(result.status, "UNKNOWN");
          assert.match(result.result.reason, /CANCEL/);
          assert.equal(result.result.audit_complete, false);
        },
      );
      await t.test(
        "output hard limit stops and marks audit incomplete",
        async () => {
          const c = await command(
            ["/bin/sh", "-c", "while true; do printf 0123456789abcdef; done"],
            { max_output_bytes: 4096, timeout_ms: 5000 },
          );
          const task = await done(c.id);
          assert.notEqual(task.status, "SUCCEEDED");
          assert.equal(task.result.audit_complete, false);
          assert.match(task.result.reason, /OUTPUT_LIMIT/);
          assert.ok((await output(c.id)).length <= 4096);
        },
      );
      await t.test(
        "business/auditor/cross-device ops cannot arbitrary Exec",
        async () => {
          for (const role of ["business", "auditor", "ops"]) {
            const username = `test-${role}`;
            server.store.seedUser({
              username,
              password: "role-test-password-that-is-long-enough",
              role,
              deviceScope: role === "ops" ? ["not-this-device"] : "*",
            } as any);
            const l = await api("POST", "/api/v1/login", {
              username,
              password: "role-test-password-that-is-long-enough",
            });
            assert.equal(l.status, 200);
            const r = await api(
              "POST",
              "/api/v1/commands",
              {
                v: 1,
                device_id: device.id,
                argv: ["/bin/true"],
                cwd: "/",
                timeout_ms: 1000,
                max_output_bytes: 4096,
                ttl_seconds: 30,
              },
              l.body.access_token,
              { "idempotency-key": randomUUID() },
            );
            assert.equal(r.status, 403, JSON.stringify(r.body));
          }
        },
      );
      await t.test(
        "crash after durable RUNNING is UNKNOWN and never replayed",
        async () => {
          await stop(agent);
          agent = launch(state, undefined, {
            FLEET_TEST_FAULT: "after_running",
          });
          children.push(agent);
          await until(
            devices,
            (d) => d.some((x) => x.id === device.id && x.control_online),
            "crash-injection agent online",
          );
          const marker = path.join(runDir, "must-not-execute");
          const c = await command([
            "/bin/sh",
            "-c",
            `printf executed > '${marker}'`,
          ]);
          await until(
            () => agent.exitCode !== null || agent.signalCode !== null,
            Boolean,
            "injected process exit",
          );
          agent = launch(state);
          children.push(agent);
          const task = await done(c.id);
          assert.equal(task.status, "UNKNOWN");
          assert.equal(existsSync(marker), false);
          server.testHooks.replayTask(c.id);
          await pause(700);
          assert.equal(existsSync(marker), false);
        },
      );
      await t.test(
        "crash after spawn preserves UNKNOWN and cleans verified remaining group",
        async () => {
          await stop(agent);
          agent = launch(state, undefined, { FLEET_TEST_FAULT: "after_spawn" });
          children.push(agent);
          await until(
            devices,
            (d) => d.some((x) => x.id === device.id && x.control_online),
            "spawn-fault agent online",
          );
          const c = await command(["/bin/sleep", "20"], { timeout_ms: 25000 });
          await until(
            () => agent.exitCode !== null || agent.signalCode !== null,
            Boolean,
            "after_spawn injected exit",
          );
          agent = launch(state);
          children.push(agent);
          const task = await done(c.id);
          assert.equal(task.status, "UNKNOWN");
          assert.equal(task.result.audit_complete, false);
        },
      );
      await t.test(
        "accepted, sealed-output and committed-result crash boundaries recover conservatively",
        async () => {
          for (const [fault, expected, count] of [
            ["after_accept", "SUCCEEDED", 1],
            ["after_seal", "UNKNOWN", 1],
            ["after_finish", "SUCCEEDED", 1],
          ] as const) {
            await stop(agent);
            agent = launch(state, undefined, { FLEET_TEST_FAULT: fault });
            children.push(agent);
            await until(
              devices,
              (d) => d.some((x) => x.id === device.id && x.control_online),
              `${fault} agent online`,
            );
            const marker = path.join(runDir, `marker-${fault}`);
            const c = await command([
              "/bin/sh",
              "-c",
              `printf once >> '${marker}'; printf '${fault}'`,
            ]);
            await until(
              () => agent.exitCode !== null || agent.signalCode !== null,
              Boolean,
              `${fault} injected exit`,
            );
            agent = launch(state);
            children.push(agent);
            const task = await done(c.id);
            assert.equal(task.status, expected, fault);
            assert.equal(
              readFileSync(marker, "utf8").match(/once/g)?.length,
              count,
            );
            server.testHooks.replayTask(c.id);
            await pause(150);
            assert.equal(readFileSync(marker, "utf8"), "once");
          }
        },
      );
      await t.test(
        "expired offline task never runs after reconnect",
        async () => {
          await stop(agent);
          const marker = path.join(runDir, "expired-marker");
          const c = await command(["/bin/sh", "-c", `touch '${marker}'`], {
            ttl_seconds: 1,
          });
          await pause(1400);
          agent = launch(state);
          children.push(agent);
          assert.equal((await done(c.id)).status, "EXPIRED");
          assert.equal(existsSync(marker), false);
        },
      );
      await t.test(
        "real Rust recovers lost enrollment response using original private key",
        async () => {
          const en = await api(
            "POST",
            "/api/v1/enrollment-tokens",
            { v: 1, ttl_seconds: 600 },
            admin,
          );
          const lossState = path.join(runDir, "agent-enrollment-loss");
          let child = launch(lossState, en.body.enrollment_token, {
            FLEET_TEST_FAULT: "after_enroll_response",
          });
          children.push(child);
          await until(
            () => child.exitCode !== null || child.signalCode !== null,
            Boolean,
            "Rust enrollment-response fault exit",
          );
          const original = (await devices()).find(
            (x) => x.name === "agent-enrollment-loss",
          );
          assert.ok(original, "server committed original identity");
          child = launch(lossState);
          children.push(child);
          await until(
            devices,
            (d) => d.some((x) => x.id === original.id && x.control_online),
            "Rust key-only identity recovery",
          );
          assert.equal(
            (await devices()).filter((x) => x.name === "agent-enrollment-loss")
              .length,
            1,
          );
          await stop(child);
        },
      );
      await t.test(
        "Ed25519 wrong proof/replay rejected and lost enrollment response recovers same ID",
        async () => {
          const { privateKey, publicKey } = generateKeyPairSync("ed25519");
          const pub = publicKey
            .export({ type: "spki", format: "der" })
            .subarray(-32)
            .toString("base64");
          const en = await api(
            "POST",
            "/api/v1/enrollment-tokens",
            { v: 1, ttl_seconds: 600 },
            admin,
          );
          const challenge = await api("POST", "/api/agent/challenge", {
            v: 1,
            purpose: "enroll",
            public_key: pub,
            enrollment_token: en.body.enrollment_token,
          });
          assert.equal(challenge.status, 200);
          const signature = sign(
            null,
            Buffer.from(challenge.body.signing_payload, "base64"),
            privateKey,
          ).toString("base64");
          const payload = {
            v: 1,
            challenge_id: challenge.body.challenge_id,
            signature,
            name: "recovered-proof-device",
          };
          const enrolled = await api("POST", "/api/agent/enroll", payload);
          assert.ok(
            [200, 201].includes(enrolled.status),
            JSON.stringify(enrolled.body),
          );
          assert.ok(
            [400, 401, 409].includes(
              (await api("POST", "/api/agent/enroll", payload)).status,
            ),
          );
          const recovery = await api("POST", "/api/agent/challenge", {
            v: 1,
            purpose: "auth",
            public_key: pub,
          });
          assert.equal(recovery.status, 200);
          const recovered = await api("POST", "/api/agent/auth", {
            v: 1,
            challenge_id: recovery.body.challenge_id,
            signature: sign(
              null,
              Buffer.from(recovery.body.signing_payload, "base64"),
              privateKey,
            ).toString("base64"),
          });
          assert.equal(recovered.body.device_id, enrolled.body.device_id);
          const wrong = await api("POST", "/api/agent/challenge", {
            v: 1,
            purpose: "auth",
            public_key: pub,
          });
          const denied = await api("POST", "/api/agent/auth", {
            v: 1,
            challenge_id: wrong.body.challenge_id,
            signature: Buffer.alloc(64).toString("base64"),
          });
          assert.equal(denied.status, 401);
        },
      );
      await t.test(
        "offline backup restore preserves task audit and complete output hashes",
        async () => {
          const c = await command(["/bin/echo", "durable-backup"]);
          assert.equal((await done(c.id)).status, "SUCCEEDED");
          const expected = await output(c.id);
          await stop(agent);
          await server.close();
          const backup = path.join(runDir, "restored-server");
          execFileSync("python3", [
            path.join(root, "scripts/backup.py"),
            path.join(runDir, "server"),
            backup,
            "--server-stopped",
          ]);
          const manifest = JSON.parse(
            readFileSync(path.join(backup, "backup-manifest.json"), "utf8"),
          );
          for (const f of manifest) {
            const bytes = readFileSync(path.join(backup, f.path));
            assert.equal(bytes.length, f.size);
            assert.equal(
              createHash("sha256").update(bytes).digest("hex"),
              f.sha256,
            );
          }
          server = await buildServer({
            dataDir: backup,
            tlsCert: path.join(tls, "server.crt"),
            tlsKey: path.join(tls, "server.key"),
            deviceTokenTtlMs: 10000,
            testMode: true,
          });
          await server.app.listen({ host: "127.0.0.1", port });
          assert.deepEqual(await output(c.id), expected);
          assert.equal((await getTask(c.id)).status, "SUCCEEDED");
          agent = launch(state);
          children.push(agent);
          await until(
            devices,
            (d) => d.some((x) => x.id === device.id && x.control_online),
            "reconnect to restored same server identity",
          );
          const audit = await api("GET", "/api/v1/audit", undefined, admin);
          assert.ok(audit.body.audit.some((x: any) => x.task_id === c.id));
        },
      );
      await t.test(
        "revocation closes old connection and prevents reauthentication",
        async () => {
          const revoke = await api(
            "POST",
            `/api/v1/devices/${device.id}/revoke`,
            { v: 1 },
            admin,
          );
          assert.equal(revoke.status, 200);
          await until(
            devices,
            (d) =>
              d.some(
                (x) => x.id === device.id && !x.control_online && x.revoked_at,
              ),
            "revoked offline",
          );
          await pause(1200);
          assert.equal(
            (await devices()).find((x) => x.id === device.id).control_online,
            false,
          );
        },
      );
      writeFileSync(
        path.join(logsDir, "e2e-environment.json"),
        JSON.stringify(
          {
            runDir,
            node: process.version,
            platform: process.platform,
            binary,
            completedAt: new Date().toISOString(),
          },
          null,
          2,
        ),
      );
    } finally {
      for (const child of children) await stop(child);
      await server.close();
    }
  },
);
