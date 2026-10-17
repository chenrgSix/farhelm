import test from "node:test";
import assert from "node:assert/strict";
import {
  mkdtempSync,
  readFileSync,
  writeFileSync,
  mkdirSync,
  rmSync,
  existsSync,
  statSync,
  symlinkSync,
  readdirSync,
} from "node:fs";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { createHash, X509Certificate } from "node:crypto";
import { execFileSync, spawnSync } from "node:child_process";
import { createServer } from "node:net";
import { get, request } from "node:https";
import { initialize } from "../../deploy/server/bootstrap.mjs";
import { DeploymentController } from "../../apps/server/dist/deployment-settings.js";
import { buildServer } from "../../apps/server/dist/server.js";
import { PrivateAuthority } from "../../apps/server/dist/private-ca.js";
import { Store } from "../../apps/server/dist/store.js";

const script = resolve("scripts/backup.py");
async function freePort() {
  const listener = createServer();
  await new Promise((r) => listener.listen(0, "127.0.0.1", r));
  const port = listener.address().port;
  await new Promise((r) => listener.close(r));
  return port;
}
function health(port, ca) {
  return new Promise((resolve, reject) => {
    const request = get(`https://127.0.0.1:${port}/healthz`, { ca }, (r) => {
      let body = "";
      r.on("data", (c) => (body += c));
      r.on("end", () => resolve(JSON.parse(body)));
    });
    request.on("error", reject);
  });
}

test("offline backup restores bootstrap, deployment journal, CA, HTTPS, identities and recordings", async (t) => {
  // Use a short path for the local management Unix socket on macOS.
  const root = mkdtempSync("/tmp/fh-restore-");
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const source = join(root, "source"),
    destination = join(root, "restored");
  const port = await freePort();
  const env = {
    FLEET_DATA_DIR: source,
    FLEET_HOST: "127.0.0.1",
    FLEET_PORT: String(port),
    FLEET_AGENT_PORT: String(await freePort()),
    FARHELM_PUBLIC_HOST: "127.0.0.1",
    FLEET_SSH_PORT: "0",
  };
  await initialize(env);
  let running;
  const build = async (config) => {
    running = await buildServer({ ...config, logger: false });
    return running;
  };
  const original = new DeploymentController(env, build);
  t.after(() => original.stop());
  await original.start();
  const credentials = JSON.parse(
    readFileSync(join(source, "bootstrap-admin.json")),
  );
  const db = running.store.db;
  const actor = db.prepare("SELECT id FROM users").get().id;
  db.prepare(
    "INSERT INTO devices(id,public_key,name,created_at) VALUES('restore-device','key','restored device',1)",
  ).run();
  db.prepare(
    "INSERT INTO terminal_sessions(id,device_id,actor_id,status,cols,rows,created_at,ended_at,audit_complete,last_seq) VALUES('recorded','restore-device',?,'CLOSED',80,24,1,2,1,1)",
  ).run(actor);
  db.prepare(
    "INSERT INTO terminal_recordings(session_id,seq,at,kind,data) VALUES('recorded',1,1,'output',?)",
  ).run(
    JSON.stringify({
      data: Buffer.from("preserved output").toString("base64"),
    }),
  );
  const instance = running.store.instance;
  await original.stop();
  mkdirSync(join(source, "future-state"));
  writeFileSync(
    join(source, "future-state", "retained.json"),
    '{"preserved":true}',
  );
  execFileSync("python3", [script, source, destination, "--server-stopped"]);
  const manifest = JSON.parse(
    readFileSync(join(destination, "backup-manifest.json")),
  );
  for (const name of [
    "certificates/private-ca.json",
    "certificates/active.json",
    "installation.json",
    "deployment.json",
    "ca.crt",
    "bootstrap-admin.json",
    "future-state/retained.json",
  ]) {
    assert.ok(
      manifest.some((entry) => entry.path === name),
      name,
    );
    assert.deepEqual(
      readFileSync(join(destination, name)),
      readFileSync(join(source, name)),
    );
  }
  for (const entry of manifest) {
    assert.equal(
      createHash("sha256")
        .update(readFileSync(join(destination, entry.path)))
        .digest("hex"),
      entry.sha256,
    );
    assert.equal(statSync(join(destination, entry.path)).mode & 0o777, 0o600);
  }
  assert.equal(statSync(destination).mode & 0o777, 0o700);
  assert.ok(!existsSync(join(destination, "fleet.sqlite-wal")));
  await initialize({
    ...env,
    FLEET_DATA_DIR: destination,
    FARHELM_PUBLIC_HOST: "must-not-reinitialize.invalid",
  });
  const restored = new DeploymentController(
    { ...env, FLEET_DATA_DIR: destination },
    build,
  );
  try {
    await restored.start();
    const ca = readFileSync(join(source, "ca.crt"));
    assert.equal((await health(port, ca)).ok, true);
    assert.equal(
      new X509Certificate(new PrivateAuthority(running.store).read().cert)
        .fingerprint256,
      new X509Certificate(ca).fingerprint256,
    );
    assert.equal(running.store.instance, instance);
    async function api(path, payload, token) {
      return new Promise((resolve, reject) => {
        const req = request(
          `https://127.0.0.1:${port}/api/v1${path}`,
          {
            ca,
            method: payload ? "POST" : "GET",
            headers: {
              ...(payload ? { "content-type": "application/json" } : {}),
              ...(token ? { authorization: `Bearer ${token}` } : {}),
            },
          },
          (res) => {
            let body = "";
            res.on("data", (chunk) => (body += chunk));
            res.on("end", () => resolve({ status: res.statusCode, body }));
          },
        );
        req.on("error", reject);
        req.end(payload ? JSON.stringify(payload) : undefined);
      });
    }
    const response = await api("/login", credentials);
    assert.equal(response.status, 200);
    const recording = await api(
      "/terminal-sessions/recorded/recording",
      undefined,
      JSON.parse(response.body).access_token,
    );
    assert.equal(recording.status, 200);
    assert.ok(
      recording.body.includes(
        Buffer.from("preserved output").toString("base64"),
      ),
    );
    // The restored CA retains its signing key, not just a copy of the public certificate.
    const renewed = await new PrivateAuthority(running.store).issue(
      "127.0.0.1",
    );
    assert.ok(
      new X509Certificate(renewed.cert).verify(
        new X509Certificate(ca).publicKey,
      ),
    );
  } finally {
    await restored.stop();
  }
  rmSync(join(source, "certificates/private-ca.json"));
  const failedDestination = join(root, "missing-ca");
  const failed = spawnSync(
    "python3",
    [script, source, failedDestination, "--server-stopped"],
    { encoding: "utf8" },
  );
  assert.notEqual(failed.status, 0);
  assert.match(failed.stderr, /private-ca.json missing/);
  assert.ok(!existsSync(failedDestination));
});

test("invalid backup inputs never leave a partial or self-recursive backup", (t) => {
  const root = mkdtempSync(join(tmpdir(), "fh-backup-invalid-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const source = join(root, "source"),
    destination = join(root, "backup");
  new Store(source).close();
  const run = (out = destination) =>
    spawnSync("python3", [script, source, out, "--server-stopped"], {
      encoding: "utf8",
    });
  assert.notEqual(run(join(source, "inside")).status, 0);
  assert.ok(!existsSync(join(source, "inside")));
  writeFileSync(join(root, "outside-secret"), "outside");
  symlinkSync(join(root, "outside-secret"), join(source, "unexpected-link"));
  assert.notEqual(run().status, 0);
  assert.ok(!existsSync(destination));
  assert.ok(
    !readdirSync(root).some((name) => name.startsWith(".farhelm-backup-")),
  );
  rmSync(join(source, "unexpected-link"));
  assert.equal(run().status, 0);
  assert.notEqual(run().status, 0);
});
