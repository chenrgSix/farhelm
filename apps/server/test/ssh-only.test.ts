import test from "node:test";
import assert from "node:assert/strict";
import {
  mkdtempSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
  statSync,
  existsSync,
  symlinkSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { request } from "node:http";
import { buildServer } from "../src/server.js";
import { runtimeConfig } from "../src/runtime-config.js";
import {
  localAdminPath,
  localAdminServer,
  prepareLocalAdmin,
} from "../src/local-admin.js";

const root = mkdtempSync(join(tmpdir(), "fh-ssh-only-"));
test("explicit SSH-only mode ignores HTTPS files and ports; full mode still requires TLS", () => {
  assert.throws(() => runtimeConfig({}), /FLEET_TLS_CERT/);
  assert.throws(() => runtimeConfig({ FLEET_MODE: "sh-only" }), /FLEET_MODE/);
  for (const port of ["0", "-1", "65536", "invalid"])
    assert.throws(
      () => runtimeConfig({ FLEET_MODE: "ssh-only", FLEET_SSH_PORT: port }),
      /FLEET_SSH_PORT/,
    );
  const result = runtimeConfig({
    FLEET_MODE: "ssh-only",
    FLEET_PORT: "invalid",
    FLEET_TLS_CERT: "/missing",
    FLEET_TLS_KEY: "/missing",
    FLEET_WEB_DIST: "/missing",
    FLEET_CA_CERT: "/missing",
    FLEET_ACME_ENABLED: "1",
    FLEET_ACME_HTTP_PORT: "invalid",
  });
  assert.equal(result.port, undefined);
  assert.deepEqual(result.config.ssh, {
    host: "127.0.0.1",
    port: 2222,
    publicHost: undefined,
    publicPort: undefined,
  });
  assert.equal(result.config.tlsCert, undefined);
  assert.equal(result.config.agentInstall, undefined);
  assert.equal(result.config.webDist, undefined);
  assert.equal(result.config.acme, undefined);
  assert.throws(
    () =>
      runtimeConfig({
        FLEET_MODE: "ssh-only",
        FLEET_TEST_MODE: "1",
        FLEET_SSH_HOST: "0.0.0.0",
      }),
    /loopback/,
  );
  const full = runtimeConfig({ FLEET_TLS_CERT: "cert", FLEET_TLS_KEY: "key" });
  assert.equal(full.config.mode, "full");
  assert.equal(full.port, 8443);
  assert.equal(full.config.ssh, undefined);
});

test("SSH-only starts with no certificate, retains its SSH identity and exposes authenticated management only on Unix", async () => {
  const dataDir = mkdtempSync(join(root, "data-"));
  // Even damaged, unused HTTPS state must not prevent SSH-only startup.
  mkdirSync(join(dataDir, "certificates"));
  for (const name of ["active.json", "retired.json", "private-ca.json"])
    writeFileSync(join(dataDir, "certificates", name), "invalid-unused-HTTPS");
  const config = {
    dataDir,
    mode: "ssh-only" as const,
    adminUsername: "admin",
    adminPassword: "ssh-only-test-password1",
    ssh: { host: "127.0.0.1", port: 0 },
    tlsCert: "/missing",
    tlsKey: "/missing",
    webDist: "/missing",
    agentInstall: { distDir: "/missing", publicUrl: "", caCert: "/missing" },
  };
  await prepareLocalAdmin(dataDir);
  let server = await buildServer(config);
  const fingerprint = server.ssh!.info().fingerprint;
  const key = readFileSync(join(dataDir, "ssh_host_ed25519_key"));
  try {
    assert.equal(server.app.server.listening, false);
    assert.ok(server.ssh!.info().enabled);
    assert.equal(
      statSync(join(dataDir, "ssh_host_ed25519_key")).mode & 0o777,
      0o600,
    );
    await server.app.listen({ path: localAdminPath(dataDir) });
    await assert.rejects(() => prepareLocalAdmin(dataDir), /already in use/);
    const status = await new Promise<number>((resolve, reject) => {
      const r = request(
        { socketPath: localAdminPath(dataDir), path: "/api/v1/devices" },
        (res) => {
          res.resume();
          res.on("end", () => resolve(res.statusCode!));
        },
      );
      r.on("error", reject);
      r.end();
    });
    assert.equal(status, 401);
    assert.equal(
      (await server.app.inject({ method: "GET", url: "/" })).statusCode,
      404,
    );
    assert.equal(
      (
        await server.app.inject({
          method: "GET",
          url: "/api/v1/settings/certificate",
        })
      ).statusCode,
      404,
    );
    const login = await server.app.inject({
      method: "POST",
      url: "/api/v1/login",
      payload: { username: "admin", password: config.adminPassword },
    });
    assert.equal(login.statusCode, 200);
    const devices = await server.app.inject({
      method: "GET",
      url: "/api/v1/devices",
      headers: { authorization: "Bearer " + login.json().access_token },
    });
    assert.equal(devices.statusCode, 200);
    await server.close();
    assert.equal(existsSync(localAdminPath(dataDir)), false);
    await prepareLocalAdmin(dataDir);
    server = await buildServer(config);
    assert.equal(server.ssh!.info().fingerprint, fingerprint);
    assert.deepEqual(readFileSync(join(dataDir, "ssh_host_ed25519_key")), key);
    assert.equal(
      readFileSync(join(dataDir, "certificates/active.json"), "utf8"),
      "invalid-unused-HTTPS",
    );
  } finally {
    await server.close();
  }
  writeFileSync(join(dataDir, "ssh_host_ed25519_key"), "damaged-host-key");
  await assert.rejects(() => buildServer(config), /Invalid SSH host key/);
  assert.equal(
    readFileSync(join(dataDir, "ssh_host_ed25519_key"), "utf8"),
    "damaged-host-key",
  );
});

test("local administration cannot bind TCP or replace arbitrary files or symlinks", async () => {
  const dataDir = mkdtempSync(join(root, "guard-"));
  const server = localAdminServer((_req, res) => res.end(), dataDir);
  assert.throws(
    () => server.listen({ host: "127.0.0.1", port: 0 }),
    /private Unix socket/,
  );
  assert.throws(
    () => server.listen({ path: join(root, "other.sock") }),
    /private Unix socket/,
  );
  assert.equal(server.listening, false);
  writeFileSync(localAdminPath(dataDir), "do not overwrite");
  await assert.rejects(() => prepareLocalAdmin(dataDir), /unexpected/);
  assert.equal(
    readFileSync(localAdminPath(dataDir), "utf8"),
    "do not overwrite",
  );
  const another = mkdtempSync(join(root, "symlink-"));
  symlinkSync(localAdminPath(dataDir), localAdminPath(another));
  await assert.rejects(() => prepareLocalAdmin(another), /unexpected/);
  assert.equal(
    readFileSync(localAdminPath(dataDir), "utf8"),
    "do not overwrite",
  );
});
