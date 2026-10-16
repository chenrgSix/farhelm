import test from "node:test";
import assert from "node:assert/strict";
import {
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  readFileSync,
  statSync,
  renameSync,
  rmSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer } from "node:net";
import { request as http } from "node:http";
import { request as https } from "node:https";
import { execFileSync } from "node:child_process";
import { buildServer } from "../src/server.js";
import { PrivateAuthority } from "../src/private-ca.js";
import { DeploymentController } from "../src/deployment-settings.js";
import { assertValid } from "../../../tests/contracts/validate.mjs";
const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));
async function freePort() {
  const server = createServer();
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const port = (server.address() as any).port;
  await new Promise<void>((r) => server.close(() => r()));
  return port;
}
async function fixture(confirmationMs = 10000, withTls = true) {
  const root = mkdtempSync(join(tmpdir(), "fh-deploy-"));
  const web = join(root, "web"),
    data = join(root, "data");
  mkdirSync(web);
  writeFileSync(join(web, "index.html"), "Farhelm test");
  if (withTls)
    execFileSync(
      "openssl",
      [
        "req",
        "-x509",
        "-newkey",
        "rsa:2048",
        "-nodes",
        "-keyout",
        root + "/key",
        "-out",
        root + "/cert",
        "-days",
        "1",
        "-subj",
        "/CN=localhost",
        "-addext",
        "basicConstraints=critical,CA:FALSE",
        "-addext",
        "subjectAltName=IP:127.0.0.1,DNS:localhost",
      ],
      { stdio: "ignore" },
    );
  const port = await freePort(),
    sshPort = await freePort();
  const env = {
    FLEET_HOST: "127.0.0.1",
    FLEET_PORT: String(port),
    FLEET_SSH_PORT: String(sshPort),
    FLEET_DATA_DIR: data,
    FLEET_WEB_DIST: web,
    FLEET_DEVICE_ACCESS: "ssh-only",
    FLEET_WEB_ENABLED: "1",
    FLEET_WEB_PROTOCOL: "http",
    FLEET_ADMIN_USER: "admin",
    FLEET_ADMIN_PASSWORD: "deployment-test-password1",
    ...(withTls
      ? { FLEET_TLS_CERT: root + "/cert", FLEET_TLS_KEY: root + "/key" }
      : {}),
  };
  let running: Awaited<ReturnType<typeof buildServer>>;
  let failNext = false;
  const build: typeof buildServer = async (config) => {
    if (failNext) {
      failNext = false;
      throw Error("Injected startup failure");
    }
    running = await buildServer({ ...config, logger: false });
    return running;
  };
  let controller = new DeploymentController(env, build, confirmationMs);
  await controller.start();
  let token = "";
  function api(
    path: string,
    method = "GET",
    body?: unknown,
    protocol = "http",
    auth = token,
    socketPath?: string,
  ): Promise<{ status: number; body: any; headers: any }> {
    return new Promise((resolve, reject) => {
      const req = (protocol === "https" ? https : http)(
        {
          hostname: "127.0.0.1",
          port,
          agent: false,
          ...(socketPath ? { socketPath } : {}),
          path: "/api/v1" + path,
          method,
          ...(protocol === "https"
            ? { ca: readFileSync(root + "/cert"), servername: "localhost" }
            : {}),
          headers: {
            ...(auth ? { authorization: "Bearer " + auth } : {}),
            ...(body ? { "content-type": "application/json" } : {}),
          },
        },
        (res) => {
          let text = "";
          res.on("data", (c) => (text += c));
          res.on("end", () =>
            resolve({
              status: res.statusCode!,
              body: JSON.parse(text),
              headers: res.headers,
            }),
          );
        },
      );
      req.on("error", reject);
      req.setTimeout(2000, () => req.destroy(Error("timeout")));
      req.end(body ? JSON.stringify(body) : undefined);
    });
  }
  token = (
    await api("/login", "POST", {
      username: "admin",
      password: env.FLEET_ADMIN_PASSWORD,
    })
  ).body.access_token;
  const get = async (protocol = "http", socket?: string) => {
    const result = await api(
      "/settings/deployment",
      "GET",
      undefined,
      protocol,
      token,
      socket,
    );
    assert.equal(result.status, 200);
    assertValid("deployment-response", result.body);
    return result.body;
  };
  const until = async (fn: () => Promise<boolean>) => {
    for (let i = 0; i < 120; i++) {
      try {
        if (await fn()) return;
      } catch {}
      await wait(50);
    }
    throw Error("Condition timed out");
  };
  return {
    root,
    data,
    env,
    port,
    sshPort,
    api,
    get,
    until,
    get controller() {
      return controller;
    },
    get running() {
      return running!;
    },
    fail() {
      failNext = true;
    },
    token,
    async restart() {
      await controller.stop();
      controller = new DeploymentController(env, build, confirmationMs);
      await controller.start();
    },
    async close() {
      await controller.stop();
    },
  };
}
const change = (state: any, settings: any, port: number, extra = {}) => ({
  v: 1,
  revision: state.revision,
  settings: { ...state.settings, ...settings },
  entry_origin: `http://127.0.0.1:${port}`,
  ...extra,
});

test("administrator-only settings validate revisions, TLS readiness, active terminals and unknown fields before mutation", async () => {
  const f = await fixture(10000, false);
  try {
    const state = await f.get();
    assert.equal(state.https_ready, false);
    assert.equal(
      (await f.api("/settings/deployment", "GET", undefined, "http", ""))
        .status,
      401,
    );
    f.running.store.seedUser({
      username: "ops",
      password: "deployment-test-password1",
      role: "ops",
      deviceScope: "*",
    });
    const ops = (
      await f.api("/login", "POST", {
        username: "ops",
        password: "deployment-test-password1",
      })
    ).body.access_token;
    for (const method of ["GET", "PUT", "POST"]) {
      const suffix = method === "POST" ? "/confirm" : "";
      assert.equal(
        (
          await f.api(
            "/settings/deployment" + suffix,
            method,
            method === "GET" ? undefined : change(state, {}, f.port),
            "http",
            ops,
          )
        ).status,
        403,
      );
    }
    for (const [input, expected] of [
      [
        change(state, { web_protocol: "https" }, f.port),
        "DEPLOYMENT_HTTPS_NOT_READY",
      ],
      [
        change(state, { device_access: "agent-ssh" }, f.port),
        "AGENT_HTTPS_REQUIRED",
      ],
      [
        change(state, { web_enabled: false }, f.port),
        "CONFIRM_WEB_DISABLE_REQUIRED",
      ],
      [
        change(state, { web_enabled: false }, f.port, { revision: 99 }),
        "DEPLOYMENT_REVISION_CONFLICT",
      ],
      [
        change(state, { web_enabled: false, extra: true }, f.port),
        "UNKNOWN_FIELD",
      ],
    ] as const) {
      const result = await f.api("/settings/deployment", "PUT", input);
      assert.equal(result.body.error, expected);
      assert.equal((await f.get()).revision, 0);
    }
    const db = f.running.store.db;
    const admin = db
      .prepare("SELECT id FROM users WHERE username='admin'")
      .get() as any;
    db.prepare(
      "INSERT INTO devices(id,public_key,name,created_at) VALUES('d','key','device',1)",
    ).run();
    db.prepare(
      "INSERT INTO terminal_sessions(id,device_id,actor_id,status,cols,rows,created_at) VALUES('t','d',?,'ACTIVE',80,24,1)",
    ).run(admin.id);
    assert.equal(
      (
        await f.api(
          "/settings/deployment",
          "PUT",
          change(state, { web_enabled: false }, f.port, {
            confirm_web_disable: true,
          }),
        )
      ).body.error,
      "DEPLOYMENT_ACTIVE_TERMINALS",
    );
    assert.equal((await f.get()).active_terminals, 1);
    db.prepare("DELETE FROM terminal_sessions WHERE id='t'").run();
    db.prepare(
      "INSERT INTO tasks(id,device_id,actor_id,task_json,payload_hash,status,created_at,updated_at) VALUES('task','d',?,'{}','hash','RUNNING',1,1)",
    ).run(admin.id);
    assert.equal(
      (
        await f.api(
          "/settings/deployment",
          "PUT",
          change(state, { web_enabled: false }, f.port, {
            confirm_web_disable: true,
          }),
        )
      ).body.error,
      "DEPLOYMENT_ACTIVE_TASKS",
    );
    db.prepare("DELETE FROM tasks WHERE id='task'").run();
    assert.equal(statSync(f.data + "/deployment.json").mode & 0o777, 0o600);
    assert.equal(statSync(f.data + "/deployment.sock").mode & 0o777, 0o600);
  } finally {
    await f.close();
  }
});

test("HTTP to HTTPS to Agent and back applies, confirms and survives restart with identities and data", async () => {
  const f = await fixture();
  try {
    const key = readFileSync(f.data + "/ssh_host_ed25519_key");
    let state = await f.get();
    assert.equal(state.https_ready, true);
    assert.equal(
      (
        await f.api(
          "/settings/deployment",
          "PUT",
          change(
            state,
            { web_protocol: "https", device_access: "agent-ssh" },
            f.port,
          ),
        )
      ).status,
      200,
    );
    await f.until(
      async () => (await f.get("https")).state === "awaiting_confirmation",
    );
    state = await f.get("https");
    assert.equal(state.settings.device_access, "agent-ssh");
    const blocked = await f.api(
      "/terminal-sessions",
      "POST",
      { v: 1, device_id: "missing", cols: 80, rows: 24 },
      "https",
    );
    assert.equal(blocked.body.error, "DEPLOYMENT_APPLYING");
    assert.equal(
      (
        await f.api(
          "/settings/deployment",
          "PUT",
          change(state, {}, f.port),
          "https",
        )
      ).body.error,
      "DEPLOYMENT_APPLYING",
    );
    assert.equal(
      (
        await f.api(
          "/settings/deployment/confirm",
          "POST",
          { v: 1, revision: state.revision },
          "https",
        )
      ).status,
      200,
    );
    delete (f.env as Record<string, string>).FLEET_PORT;
    delete (f.env as Record<string, string>).FLEET_SSH_PORT;
    await f.restart();
    state = await f.get("https");
    assert.equal(state.state, "idle");
    assert.equal(state.settings.web_protocol, "https");
    assert.equal(
      (await f.api("/me", "GET", undefined, "https")).body.runtime
        .device_access,
      "agent-ssh",
    );
    const result = await f.api(
      "/settings/deployment",
      "PUT",
      change(
        state,
        { web_protocol: "http", device_access: "ssh-only" },
        f.port,
        { entry_origin: `https://127.0.0.1:${f.port}` },
      ),
      "https",
    );
    assert.equal(result.headers["strict-transport-security"], "max-age=0");
    await f.until(
      async () => (await f.get()).state === "awaiting_confirmation",
    );
    state = await f.get();
    assert.equal(
      (
        await f.api("/settings/deployment/confirm", "POST", {
          v: 1,
          revision: state.revision,
        })
      ).status,
      200,
    );
    assert.deepEqual(readFileSync(f.data + "/ssh_host_ed25519_key"), key);
    for (const audit of (await f.api("/audit")).body.audit)
      assertValid("audit", audit);
  } finally {
    await f.close();
  }
});

test("failed activation and unconfirmed entry restore the old listener", async () => {
  const f = await fixture(500);
  try {
    let state = await f.get();
    f.fail();
    await f.api(
      "/settings/deployment",
      "PUT",
      change(state, { web_protocol: "https" }, f.port),
    );
    await f.until(async () => (await f.get()).last_error === "APPLY_FAILED");
    state = await f.get();
    await f.api(
      "/settings/deployment",
      "PUT",
      change(state, { web_protocol: "https" }, f.port),
    );
    await f.until(
      async () => (await f.get()).last_error === "CONFIRMATION_TIMEOUT",
    );
    assert.equal((await f.get()).settings.web_protocol, "http");
  } finally {
    await f.close();
  }
});

test("a restart during trial rolls back; web disable persists and private recovery reopens management", async () => {
  const f = await fixture();
  try {
    let state = await f.get();
    await f.api(
      "/settings/deployment",
      "PUT",
      change(state, { web_protocol: "https" }, f.port),
    );
    await f.until(
      async () => (await f.get("https")).state === "awaiting_confirmation",
    );
    await f.restart();
    state = await f.get();
    assert.equal(state.last_error, "APPLY_INTERRUPTED");
    await f.api(
      "/settings/deployment",
      "PUT",
      change(state, { web_enabled: false }, f.port, {
        confirm_web_disable: true,
      }),
    );
    const socket = f.data + "/admin.sock";
    await f.until(async () => (await f.get("http", socket)).state === "idle");
    await f.restart();
    assert.equal((await f.get("http", socket)).settings.web_enabled, false);
    await assert.rejects(() => f.api("/me"));
    await new Promise<void>((resolve, reject) => {
      const req = http(
        {
          socketPath: f.data + "/deployment.sock",
          method: "POST",
          path: "/enable-web",
        },
        (res) => {
          res.resume();
          res.once("end", () => {
            assert.equal(res.statusCode, 200);
            resolve();
          });
        },
      );
      req.on("error", reject);
      req.end();
    });
    await f.until(
      async () => (await f.get()).state === "awaiting_confirmation",
    );
    state = await f.get();
    await f.api("/settings/deployment/confirm", "POST", {
      v: 1,
      revision: state.revision,
    });
    assert.equal((await f.get()).settings.web_enabled, true);
    await assert.rejects(
      new DeploymentController(f.env, buildServer).start(),
      /already in use/,
    );
    assert.equal((await f.get()).state, "idle");
  } finally {
    await f.close();
  }
});

test("HTTP deployment can reuse its managed private certificate without TLS environment variables", async () => {
  const f = await fixture(10000, false);
  try {
    const ca = new PrivateAuthority(f.running.store);
    await ca.prepare(null);
    const bundle = await ca.issue("localhost");
    writeFileSync(
      f.data + "/certificates/active.json",
      JSON.stringify({ ...bundle, domain: "localhost", mode: "private" }),
      { mode: 0o600 },
    );
    writeFileSync(f.root + "/cert", ca.read()!.cert);
    const state = await f.get();
    assert.equal(state.https_ready, true);
    const result = await f.api(
      "/settings/deployment",
      "PUT",
      change(state, { web_protocol: "https" }, f.port),
    );
    assert.equal(result.body.entry_url, `https://localhost:${f.port}`);
    await f.until(
      async () => (await f.get("https")).state === "awaiting_confirmation",
    );
    await f.api(
      "/settings/deployment/confirm",
      "POST",
      { v: 1, revision: result.body.revision },
      "https",
    );
    await f.restart();
    assert.equal((await f.get("https")).settings.web_protocol, "https");
  } finally {
    await f.close();
  }
});

test("a failed confirmation write retains the rollback timer and does not record a false applied audit", async () => {
  const f = await fixture(1500);
  try {
    const state = await f.get();
    const result = await f.api(
      "/settings/deployment",
      "PUT",
      change(state, { web_protocol: "https" }, f.port),
    );
    await f.until(
      async () => (await f.get("https")).state === "awaiting_confirmation",
    );
    const path = f.data + "/deployment.json";
    renameSync(path, path + ".saved");
    mkdirSync(path);
    try {
      assert.equal(
        (
          await f.api(
            "/settings/deployment/confirm",
            "POST",
            { v: 1, revision: result.body.revision },
            "https",
          )
        ).status,
        500,
      );
      assert.equal(
        f.running.store.db
          .prepare(
            "SELECT count(*) n FROM audit WHERE action='deployment.applied'",
          )
          .get()!.n,
        0,
      );
    } finally {
      rmSync(path, { recursive: true });
      renameSync(path + ".saved", path);
    }
    await f.until(
      async () => (await f.get()).last_error === "CONFIRMATION_TIMEOUT",
    );
    assert.equal((await f.get()).settings.web_protocol, "http");
  } finally {
    await f.close();
  }
});
