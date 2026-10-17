import test from "node:test";
import assert from "node:assert/strict";
import {
  mkdtempSync,
  readFileSync,
  writeFileSync,
  existsSync,
  rmSync,
  statSync,
  unlinkSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { X509Certificate } from "node:crypto";
import { initialize } from "../../deploy/server/bootstrap.mjs";
import { Store } from "../../apps/server/dist/store.js";
import { passwordVerify } from "../../apps/server/dist/util.js";

function fixture(t, extras = {}) {
  const data = mkdtempSync(join(tmpdir(), "fh-deploy-"));
  t.after(() => rmSync(data, { recursive: true, force: true }));
  return {
    data,
    env: {
      FLEET_DATA_DIR: data,
      FARHELM_PUBLIC_HOST: "192.0.2.10",
      FARHELM_PUBLIC_PORT: "8443",
      ...extras,
    },
  };
}
test("first boot creates a managed IP certificate, administrator and platform URL; restarts preserve identities and user edits", async (t) => {
  const { data, env } = fixture(t);
  const result = await initialize(env);
  assert.equal(result.url, "https://192.0.2.10:8443");
  const creds = JSON.parse(readFileSync(join(data, "bootstrap-admin.json")));
  assert.match(creds.password, /[a-zA-Z]/);
  assert.match(creds.password, /[0-9]/);
  assert.equal(
    statSync(join(data, "bootstrap-admin.json")).mode & 0o777,
    0o600,
  );
  const cert = JSON.parse(readFileSync(join(data, "certificates/active.json")));
  const ca = readFileSync(join(data, "ca.crt"), "utf8");
  assert.equal(
    new X509Certificate(cert.cert).checkIP("192.0.2.10"),
    "192.0.2.10",
  );
  assert.ok(
    new X509Certificate(cert.cert).verify(new X509Certificate(ca).publicKey),
  );
  const db = new Store(data);
  const user = db.db.prepare("SELECT * FROM users").get();
  assert.ok(passwordVerify(creds.password, user.password_hash));
  assert.equal(
    db.db.prepare("SELECT enabled FROM certificate_settings").get().enabled,
    1,
  );
  assert.equal(
    db.db.prepare("SELECT platform_server_url FROM system_settings").get()
      .platform_server_url,
    result.agent_url,
  );
  db.db.prepare("UPDATE users SET username='renamed-admin'").run();
  db.close();
  writeFileSync(join(data, "recording-preservation.txt"), "recording marker");
  await initialize({
    ...env,
    FARHELM_PUBLIC_HOST: "changed.internal",
    FLEET_ADMIN_USER: "another-admin",
    FLEET_ADMIN_PASSWORD: "Changed12345",
  });
  assert.equal(readFileSync(join(data, "ca.crt"), "utf8"), ca);
  assert.deepEqual(
    JSON.parse(readFileSync(join(data, "certificates/active.json"))),
    cert,
  );
  assert.equal(
    readFileSync(join(data, "recording-preservation.txt"), "utf8"),
    "recording marker",
  );
  const reopened = new Store(data);
  assert.deepEqual(
    reopened.db
      .prepare("SELECT username FROM users")
      .all()
      .map((r) => r.username),
    ["renamed-admin"],
  );
  reopened.close();
  unlinkSync(join(data, "fleet.sqlite"));
  await assert.rejects(initialize(env), /database is missing/);
});
test("SSH-only HTTP bootstrap needs no certificate and handles IPv6 URL formatting", async (t) => {
  const { data, env } = fixture(t, {
    FLEET_DEVICE_ACCESS: "ssh-only",
    FLEET_WEB_PROTOCOL: "http",
    FARHELM_PUBLIC_HOST: "2001:db8::10",
    FARHELM_PUBLIC_PORT: "8080",
  });
  assert.equal((await initialize(env)).url, "http://[2001:db8::10]:8080");
  assert.ok(!existsSync(join(data, "certificates")));
});
test("invalid credentials or host fail before persisting state; unrelated existing data is not adopted", async (t) => {
  const { data, env } = fixture(t);
  await assert.rejects(
    initialize({ ...env, FLEET_ADMIN_PASSWORD: "no-numbers" }),
    /INVALID_PASSWORD_POLICY/,
  );
  await assert.rejects(
    initialize({ ...env, FARHELM_PUBLIC_HOST: "https://bad.internal" }),
  );
  assert.ok(!existsSync(join(data, "installation.json")));
  writeFileSync(join(data, "fleet.sqlite"), "existing data");
  await assert.rejects(initialize(env), /non-empty data directory/);
  assert.equal(
    readFileSync(join(data, "fleet.sqlite"), "utf8"),
    "existing data",
  );
});
test("interrupted initialization resumes its original intent and credentials", async (t) => {
  const { data, env } = fixture(t);
  writeFileSync(
    join(data, "installation.json"),
    JSON.stringify({
      v: 1,
      complete: false,
      env: {
        FARHELM_PUBLIC_HOST: "original.internal",
        FARHELM_PUBLIC_PORT: "8443",
        FLEET_DEVICE_ACCESS: "agent-ssh",
        FLEET_WEB_PROTOCOL: "https",
      },
    }),
  );
  writeFileSync(
    join(data, "bootstrap-admin.json"),
    JSON.stringify({ username: "admin", password: "Original123456" }),
    { mode: 0o600 },
  );
  assert.equal((await initialize(env)).url, "https://original.internal:8443");
  const db = new Store(data);
  assert.ok(
    passwordVerify(
      "Original123456",
      db.db.prepare("SELECT password_hash FROM users").get().password_hash,
    ),
  );
  db.close();
});

test("HTTP management bootstraps an independent HTTPS Agent entry with automatic CA renewal", async (t) => {
  const { data, env } = fixture(t, {
    FLEET_WEB_PROTOCOL: "http",
    FLEET_AGENT_PUBLIC_PORT: "9444",
  });
  const result = await initialize(env);
  assert.equal(result.url, "http://192.0.2.10:8443");
  assert.equal(result.agent_url, "https://192.0.2.10:9444");
  assert.ok(existsSync(join(data, "ca.crt")));
  const db = new Store(data);
  try {
    assert.equal(
      db.db.prepare("SELECT platform_server_url FROM system_settings").get()
        .platform_server_url,
      result.agent_url,
    );
    assert.equal(
      db.db.prepare("SELECT enabled FROM certificate_settings").get().enabled,
      1,
    );
  } finally {
    db.close();
  }
});
