import test from "node:test";
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
  const server = await buildServer({
    dataDir,
    tlsCert: join(root, "tls/server.crt"),
    tlsKey: join(root, "tls/server.key"),
    adminUsername: "admin",
    adminPassword: "installer-test-password",
    agentInstall: {
      distDir,
      publicUrl,
      caCert: join(root, "tls/ca.crt"),
    },
  });
  const admin = (
    await server.app.inject({
      method: "POST",
      url: "/api/v1/login",
      payload: { username: "admin", password: "installer-test-password" },
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
  return { ...server, api, body, binary, distDir };
}
test("installer is admin-only, validates HTTPS/account/options and reports missing packages", async () => {
  const f = await fixture(false);
  try {
    f.store.seedUser({
      username: "ops",
      password: "installer-test-password",
      role: "ops",
      deviceScope: "*",
    });
    const ops = (
      await f.api("POST", "/api/v1/login", {
        username: "ops",
        password: "installer-test-password",
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
      "https://another.example.com",
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
