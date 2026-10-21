import test from "node:test";
import assert from "node:assert/strict";
import {
  mkdtempSync,
  readFileSync,
  writeFileSync,
  mkdirSync,
  statSync,
  unlinkSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { X509Certificate } from "node:crypto";
import { request as httpsRequest } from "node:https";
import { checkServerIdentity } from "node:tls";
import { setTimeout as delay } from "node:timers/promises";
import { Store } from "../src/store.js";
import { PrivateAuthority, privateCertificateHost } from "../src/private-ca.js";
import { CertificateManager } from "../src/certificates.js";
import {
  certificateInfo,
  managedCertificate,
  validateCertificate,
} from "../src/certificate-files.js";
import { buildServer } from "../src/server.js";
// @ts-ignore shared contract validators
import { assertValid } from "../../../tests/contracts/validate.mjs";
const root = mkdtempSync(join(tmpdir(), "farhelm-private-ca-"));
execFileSync("bash", ["../../deploy/dev/generate-tls.sh", join(root, "tls")], {
  stdio: "ignore",
});
const draft = {
  v: 1,
  revision: 0,
  mode: "private",
  domain: "farhelm.internal",
  email: "",
  enabled: false,
  tos_agreed: false,
};
async function until(check: () => boolean) {
  for (let i = 0; i < 300; i++) {
    if (check()) return;
    await delay(10);
  }
  throw Error("Timed out");
}
async function fixture(dataDir = mkdtempSync(join(root, "data-"))) {
  const store = new Store(dataDir);
  const actor = store.seedUser({
    username: "admin",
    password: "private-ca-test-password1",
    role: "admin",
    deviceScope: "*",
  }).id;
  let now = Date.now(),
    active = managedCertificate(dataDir),
    fail = false;
  const manager = new CertificateManager({
    store,
    privateAvailable: true,
    initial: active,
    fallback: () => readFileSync(join(root, "tls/server.crt")),
    now: () => now,
    activate: (bundle) => {
      if (fail) throw Error("activation failed");
      active = bundle;
    },
    issue: async () => {
      throw Error("Private mode must never call ACME");
    },
  });
  await manager.start();
  return {
    store,
    manager,
    actor,
    active: () => active!,
    time: (n: number) => (now = n),
    fail: () => (fail = true),
    close: async () => {
      await manager.close();
      store.close();
    },
  };
}
test("private host parsing accepts LAN names and canonical IPs but rejects URL/shell/SAN injection", () => {
  for (const [input, output] of [
    ["FARHELM.internal", "farhelm.internal"],
    ["fleet", "fleet"],
    ["192.168.10.5", "192.168.10.5"],
    ["2001:0db8::1", "2001:db8::1"],
    ["内网.公司", "xn--v6q792i.xn--55qx5d"],
  ])
    assert.equal(privateCertificateHost(input), output);
  for (const name of [
    "https://fleet.internal",
    "fleet:443",
    "*.internal",
    "fleet,IP:127.0.0.1",
    "fleet\n.internal",
    "[::1]",
    "fe80::1%eth0",
    "a..b",
    "-fleet",
    "123.999",
  ])
    assert.throws(() => privateCertificateHost(name));
});
test("offline CA signing and renewal preserve trust, private keys and persisted identity", async () => {
  const f = await fixture();
  try {
    assert.throws(
      () => f.manager.save({ ...draft, enabled: true }, f.actor),
      /PRIVATE_CA_NOT_PREPARED/,
    );
    f.manager.save(draft, f.actor);
    await Promise.all([
      f.manager.prepare({ v: 1, revision: 1 }, f.actor),
      f.manager.prepare({ v: 1, revision: 1 }, f.actor),
    ]);
    const ca = f.manager.downloadCA();
    assertValid("certificate-ca", ca);
    assert.equal(
      f.store.db
        .prepare(
          "SELECT COUNT(*) n FROM audit WHERE action='certificate.ca_created'",
        )
        .get()!.n,
      1,
    );
    const caPath = join(f.store.dataDir, "certificates/private-ca.json");
    const original = readFileSync(caPath, "utf8");
    assert.equal(statSync(caPath).mode & 0o777, 0o600);
    f.manager.save({ ...draft, revision: 1, enabled: true }, f.actor);
    await until(() => f.manager.snapshot().status === "valid");
    assert.equal(f.manager.port(), null);
    const first = f.active();
    validateCertificate(first, Date.now());
    const leaf = new X509Certificate(first.cert),
      anchor = new X509Certificate(ca.certificate_pem);
    assert.ok(leaf.verify(anchor.publicKey));
    assert.equal(leaf.ca, false);
    assert.equal(leaf.checkHost(draft.domain), draft.domain);
    assert.ok(
      certificateInfo(first.cert).expires_at <= Date.now() + 90 * 86400000,
    );
    assert.equal(
      f.manager.agentCA(`https://${draft.domain}`, "old CA"),
      ca.certificate_pem,
    );
    assert.equal(
      f.manager.agentCA("https://other.internal", "other CA"),
      "other CA",
    );
    assertValid("certificate-status", f.manager.snapshot());
    assert.ok(!JSON.stringify(f.manager.snapshot()).includes("PRIVATE KEY"));
    f.time(certificateInfo(first.cert).renew_at + 1000);
    await f.manager.tick();
    const renewed = f.active();
    assert.notEqual(renewed.cert, first.cert);
    assert.notEqual(renewed.key, first.key);
    assert.ok(new X509Certificate(renewed.cert).verify(anchor.publicKey));
    assert.equal(readFileSync(caPath, "utf8"), original);
    assert.equal(managedCertificate(f.store.dataDir)!.cert, renewed.cert);
    f.fail();
    f.time(certificateInfo(renewed.cert).renew_at + 1000);
    await f.manager.tick();
    assert.equal(f.manager.snapshot().status, "error");
    assert.equal(f.active().cert, renewed.cert);
    assert.equal(managedCertificate(f.store.dataDir)!.cert, renewed.cert);
    // Losing a private key never silently creates a new trust anchor.
    unlinkSync(caPath);
    assert.equal(
      f.manager.snapshot().last_error!.code,
      "PRIVATE_CA_UNAVAILABLE",
    );
    await assert.rejects(
      () => f.manager.prepare({ v: 1, revision: 2 }, f.actor),
      /PRIVATE_CA_UNAVAILABLE/,
    );
    writeFileSync(caPath, original, { mode: 0o600 });
    assert.equal(f.manager.downloadCA().fingerprint, ca.fingerprint);
    for (const row of f.store.db
      .prepare("SELECT * FROM audit WHERE action LIKE 'certificate.%'")
      .all() as any[])
      assertValid("audit", {
        id: row.id,
        at: row.at,
        actor_id: row.actor_id,
        device_id: row.device_id,
        task_id: row.task_id,
        action: row.action,
        detail: JSON.parse(row.detail_json),
      });
  } finally {
    await f.close();
  }
});
test("CA handles IP SANs, refuses damaged and expiring roots and retains trust on restart", async () => {
  const f = await fixture();
  try {
    const ca = new PrivateAuthority(f.store);
    await ca.prepare(f.actor);
    for (const domain of ["127.0.0.1", "::1"]) {
      const bundle = {
        ...(await ca.issue(domain)),
        domain,
        mode: "private" as const,
      };
      validateCertificate(bundle, Date.now());
      assert.ok(new X509Certificate(bundle.cert).checkIP(domain));
    }
    const old = {
      ...(await ca.issue("old.internal")),
      domain: "old.internal",
      mode: "private" as const,
    };
    const active = {
      ...(await ca.issue("new.internal")),
      domain: "new.internal",
      mode: "private" as const,
    };
    const routing = new CertificateManager({
      store: f.store,
      privateAvailable: true,
      initial: active,
      retired: old,
      fallback: () => readFileSync(join(root, "tls/server.crt")),
      activate: () => {},
    });
    assert.equal(routing.agentCA("https://old.internal", ""), ca.read()!.cert);
    assert.equal(routing.agentCA("https://new.internal", ""), ca.read()!.cert);
    await routing.close();
    const fingerprint = ca.info()!.fingerprint;
    assert.equal(
      new PrivateAuthority(f.store).info()!.fingerprint,
      fingerprint,
    );
    const expired = new PrivateAuthority(
      f.store,
      () => ca.info()!.expires_at - 1000,
    );
    await assert.rejects(
      () => expired.issue("fleet.internal"),
      /PRIVATE_CA_EXPIRED/,
    );
    const path = join(f.store.dataDir, "certificates/private-ca.json");
    writeFileSync(path, "{}");
    await assert.rejects(() => ca.prepare(f.actor), /PRIVATE_CA_UNAVAILABLE/);
  } finally {
    await f.close();
  }
});
test("adding private certificate addresses reissues with the same CA and persists them through renewal", async () => {
  const f = await fixture();
  const config = { ...draft, domain: "123.88.4.44" };
  try {
    f.manager.save(config, f.actor);
    await f.manager.prepare({ v: 1, revision: 1 }, f.actor);
    f.manager.save({ ...config, revision: 1, enabled: true }, f.actor);
    await until(() => f.manager.snapshot().status === "valid");
    const original = f.active(),
      ca = f.manager.downloadCA();
    f.time(f.manager.snapshot().retry_allowed_at! + 1000);
    const added = f.manager.save(
      {
        ...config,
        revision: 2,
        enabled: true,
        additional_domains: [
          "192.168.1.5",
          "FLEET.internal",
          "2001:0db8::5",
          "192.168.1.5",
          config.domain,
        ],
      },
      f.actor,
    );
    const expected = ["192.168.1.5", "2001:db8::5", "fleet.internal"];
    assert.deepEqual(added.additional_domains, expected);
    assert.equal(added.status, "pending");
    assert.equal(
      f.active().cert,
      original.cert,
      "old certificate serves until the replacement is ready",
    );
    assertValid("certificate-status", added);
    await until(() => f.manager.snapshot().status === "valid");
    const first = f.active();
    assert.notEqual(first.cert, original.cert);
    assert.deepEqual(f.manager.downloadCA(), ca);
    const assertNames = (bundle: typeof first) => {
      validateCertificate(
        bundle,
        Date.parse(new X509Certificate(bundle.cert).validFrom) + 1000,
      );
      const leaf = new X509Certificate(bundle.cert);
      assert.ok(leaf.checkIP(config.domain));
      assert.ok(leaf.checkIP("192.168.1.5"));
      assert.ok(leaf.checkIP("2001:db8::5"));
      assert.ok(leaf.checkHost("fleet.internal"));
      assert.ok(leaf.verify(new X509Certificate(ca.certificate_pem).publicKey));
    };
    assertNames(first);
    for (const host of [config.domain, "192.168.1.5", "fleet.internal"])
      assert.equal(
        f.manager.agentCA(`https://${host}:8444`, ""),
        ca.certificate_pem,
      );
    const proof = await f.manager.trustProof(3);
    assert.ok(new X509Certificate(proof.proof_pem).checkIP("192.168.1.5"));
    assert.equal(
      f.manager.save({ ...config, revision: 3, enabled: true }, f.actor)
        .revision,
      3,
      "an older client omitting additional_domains must preserve the list",
    );
    assert.deepEqual(f.manager.snapshot().additional_domains, expected);
    assert.throws(
      () =>
        validateCertificate({ ...first, additionalDomains: ["192.168.1.99"] }),
      /Invalid certificate identity/,
    );
    f.time(certificateInfo(first.cert).renew_at + 1000);
    await f.manager.tick();
    assert.notEqual(f.active().cert, first.cert);
    assertNames(f.active());
    assert.deepEqual(
      managedCertificate(f.store.dataDir)!.additionalDomains,
      expected,
    );
    assert.deepEqual(f.manager.downloadCA(), ca);
    f.time(f.manager.snapshot().retry_allowed_at! + 1000);
    f.manager.save(
      { ...config, revision: 3, enabled: true, additional_domains: [] },
      f.actor,
    );
    await until(() => f.manager.snapshot().status === "valid");
    assert.equal(
      new X509Certificate(f.active().cert).checkIP("192.168.1.5"),
      undefined,
    );
    assert.ok(new X509Certificate(f.active().cert).checkIP(config.domain));
  } finally {
    await f.close();
  }
});
test("additional certificate addresses are validated and legacy databases migrate without changing the CA", async () => {
  const f = await fixture();
  const dataDir = f.store.dataDir;
  let ca;
  try {
    for (const value of [
      null,
      "192.168.1.5",
      [123],
      ["https://192.168.1.5"],
      ["*.internal"],
      Array(32).fill("fleet.internal"),
    ])
      assert.throws(() =>
        f.manager.save({ ...draft, additional_domains: value }, f.actor),
      );
    assert.throws(
      () =>
        f.manager.save(
          {
            ...draft,
            mode: "acme",
            domain: "fleet.example.com",
            email: "ops@example.com",
            additional_domains: ["192.168.1.5"],
          },
          f.actor,
        ),
      /CERTIFICATE_ADDITIONAL_DOMAINS_PRIVATE_ONLY/,
    );
    f.manager.save(draft, f.actor);
    await f.manager.prepare({ v: 1, revision: 1 }, f.actor);
    ca = f.manager.downloadCA();
    f.store.db.exec(
      "ALTER TABLE certificate_settings DROP COLUMN additional_domains_json",
    );
  } finally {
    await f.close();
  }
  const store = new Store(dataDir);
  try {
    assert.equal(
      store.db
        .prepare("SELECT additional_domains_json FROM certificate_settings")
        .get()!.additional_domains_json,
      "[]",
    );
    assert.equal(
      new PrivateAuthority(store).info()!.fingerprint,
      ca!.fingerprint,
    );
  } finally {
    store.close();
  }
});
test("private certificate APIs are admin-only and installers capture the active CA automatically", async () => {
  const dataDir = mkdtempSync(join(root, "api-")),
    webDist = join(dataDir, "web"),
    distDir = join(dataDir, "packages");
  mkdirSync(webDist);
  writeFileSync(
    join(webDist, "index.html"),
    "<html>Farhelm unified entry</html>",
  );
  mkdirSync(distDir);
  const binary = Buffer.alloc(128);
  Buffer.from("7f454c460201", "hex").copy(binary);
  binary.writeUInt16LE(183, 18);
  writeFileSync(join(distDir, "farhelm-agent-linux-aarch64"), binary);
  const config = {
    dataDir,
    webDist,
    tlsCert: join(root, "tls/server.crt"),
    tlsKey: join(root, "tls/server.key"),
    adminUsername: "admin",
    adminPassword: "private-ca-test-password1",
    agentInstall: { distDir, publicUrl: "https://farhelm.internal" },
  };
  let server = await buildServer(config);
  const api = (method: any, path: string, body?: any, token = admin) =>
    server.app.inject({
      method,
      url: "/api/v1" + path,
      payload: body,
      headers: { authorization: "Bearer " + token },
    });
  let admin = (
    await server.app.inject({
      method: "POST",
      url: "/api/v1/login",
      payload: { username: "admin", password: config.adminPassword },
    })
  ).json().access_token;
  try {
    await server.app.listen({ host: "127.0.0.1", port: 0 });
    for (const role of ["ops", "business", "auditor"] as const) {
      server.store.seedUser({
        username: role,
        password: config.adminPassword,
        role,
        deviceScope: "*",
      });
      const token = (
        await api("POST", "/login", {
          username: role,
          password: config.adminPassword,
        })
      ).json().access_token;
      assert.equal(
        (
          await api(
            "POST",
            "/settings/certificate/renew",
            { v: 1, revision: 1 },
            token,
          )
        ).statusCode,
        403,
      );
      for (const method of ["GET", "POST"])
        assert.equal(
          (
            await api(
              method,
              "/settings/certificate/ca",
              method === "POST" ? { v: 1, revision: 1 } : undefined,
              token,
            )
          ).statusCode,
          403,
        );
    }
    assert.equal(
      (await api("PUT", "/settings/certificate", draft)).statusCode,
      200,
    );
    assert.equal(
      (
        await api("POST", "/settings/certificate/ca", {
          v: 1,
          revision: 1,
          key: "forbidden",
        })
      ).statusCode,
      400,
    );
    assert.equal(
      (await api("POST", "/settings/certificate/ca", { v: 1, revision: 1 }))
        .statusCode,
      200,
    );
    const ca = (await api("GET", "/settings/certificate/ca")).json();
    assertValid("certificate-ca", ca);
    assert.equal(
      (
        await api("PUT", "/settings/certificate", {
          ...draft,
          revision: 1,
          enabled: true,
          additional_domains: ["123.88.4.44", "192.168.1.5", "127.0.0.1"],
        })
      ).statusCode,
      200,
    );
    let state: any;
    for (let i = 0; i < 300; i++) {
      state = (await api("GET", "/settings/certificate")).json();
      if (state.status === "valid") break;
      await delay(10);
    }
    assert.equal(state.status, "valid", JSON.stringify(state.last_error));
    const health = (host: string) =>
      new Promise<void>((resolve, reject) => {
        const address = server.app.server.address() as { port: number };
        // Both IPs reach the same loopback test listener, with no SNI. TLS still
        // verifies the actual requested IP and the CA, exactly as an IP URL does.
        const req = httpsRequest(
          {
            hostname: "127.0.0.1",
            port: address.port,
            path: "/healthz",
            ca: ca.certificate_pem,
            servername: "",
            agent: false,
            checkServerIdentity: (_name, cert) =>
              checkServerIdentity(host, cert),
          },
          (res) => {
            res.resume();
            res.on("end", () => {
              assert.equal(res.statusCode, 200);
              resolve();
            });
          },
        );
        req.setTimeout(3000, () => req.destroy(Error("TLS timeout")));
        req.on("error", reject);
        req.end();
      });
    await health("123.88.4.44");
    await health("192.168.1.5");
    await assert.rejects(() => health("192.168.1.99"), /not in the cert/);
    assert.equal(
      (await api("GET", "/agent-install/options")).json().private_ca,
      true,
    );
    const install = (
      await api("POST", "/agent-installations", {
        v: 1,
        name: "private-agent",
        run_user: "farhelm",
      })
    ).json();
    assert.ok(
      install.command.includes(
        Buffer.from(ca.certificate_pem).toString("base64"),
      ),
    );
    assert.ok(install.command.includes("--cacert"));
    const stored = JSON.parse(
      (
        server.store.db
          .prepare("SELECT config_json FROM agent_installations WHERE id=?")
          .get(install.id) as any
      ).config_json,
    );
    assert.equal(stored.ca, ca.certificate_pem);
    for (const host of ["123.88.4.44", "192.168.1.5"]) {
      const response = await api("POST", "/agent-installations", {
        v: 1,
        name: "ip-agent",
        server_url: `https://${host}:8444`,
      });
      assert.equal(response.statusCode, 200, response.body);
      assert.ok(response.json().command.includes("--cacert"));
      assert.ok(
        response
          .json()
          .command.includes(Buffer.from(ca.certificate_pem).toString("base64")),
      );
    }
    assert.equal(
      (await server.app.inject({ method: "GET", url: "/" })).statusCode,
      200,
    );
    await server.close();
    server = await buildServer(config);
    await server.app.listen({ host: "127.0.0.1", port: 0 });
    await health("123.88.4.44");
    await health("192.168.1.5");
    assert.deepEqual(
      (await api("GET", "/settings/certificate")).json().additional_domains,
      ["123.88.4.44", "127.0.0.1", "192.168.1.5"],
    );
    assert.equal(
      (await api("GET", "/settings/certificate/ca")).json().fingerprint,
      ca.fingerprint,
    );
    assert.equal(
      (await api("GET", "/settings/certificate")).json().certificate
        .fingerprint,
      state.certificate.fingerprint,
    );
  } finally {
    await server.close();
  }
});

test("manual private renewal keeps the CA, enforces cooldown, and preserves the certificate on failure", async () => {
  const f = await fixture();
  try {
    f.manager.save(draft, f.actor);
    await f.manager.prepare({ v: 1, revision: 1 }, f.actor);
    assert.throws(
      () => f.manager.request({ v: 1, revision: 1 }, f.actor, true),
      /CERTIFICATE_MANAGEMENT_UNAVAILABLE/,
    );
    f.manager.save({ ...draft, revision: 1, enabled: true }, f.actor);
    await until(() => f.manager.snapshot().status === "valid");
    const first = f.active(),
      ca = f.manager.downloadCA();
    assert.throws(
      () => f.manager.request({ v: 1, revision: 1 }, f.actor, true),
      /CERTIFICATE_REVISION_CONFLICT/,
    );
    assert.throws(
      () => f.manager.request({ v: 1, revision: 2 }, f.actor, true),
      /CERTIFICATE_RETRY_LATER/,
    );
    f.time(f.manager.snapshot().retry_allowed_at! + 1000);
    f.manager.request({ v: 1, revision: 2 }, f.actor);
    await f.manager.tick();
    assert.equal(
      f.active().cert,
      first.cert,
      "ordinary check must not renew early",
    );
    f.manager.request({ v: 1, revision: 2 }, f.actor, true);
    f.manager.request({ v: 1, revision: 2 }, f.actor, true);
    await until(() => f.active().cert !== first.cert);
    const renewed = f.active();
    assert.notEqual(renewed.key, first.key);
    assert.deepEqual(f.manager.downloadCA(), ca);
    assert.ok(
      new X509Certificate(renewed.cert).verify(
        new X509Certificate(ca.certificate_pem).publicKey,
      ),
    );
    assert.equal(managedCertificate(f.store.dataDir)!.cert, renewed.cert);
    assert.equal(
      f.store.db
        .prepare(
          "SELECT COUNT(*) n FROM audit WHERE action='certificate.renew_requested' AND actor_id=?",
        )
        .get(f.actor)!.n,
      1,
    );
    await until(() => f.manager.snapshot().status === "valid");
    assert.throws(
      () => f.manager.request({ v: 1, revision: 2 }, f.actor, true),
      /CERTIFICATE_RETRY_LATER/,
    );
    f.time(f.manager.snapshot().retry_allowed_at! + 1000);
    f.fail();
    f.manager.request({ v: 1, revision: 2 }, f.actor, true);
    await until(() => f.manager.snapshot().status === "error");
    assert.equal(f.active().cert, renewed.cert);
    assert.equal(managedCertificate(f.store.dataDir)!.cert, renewed.cert);
    const failedAt = f.manager.snapshot().last_attempt_at;
    f.time(f.manager.snapshot().next_attempt_at! + 1000);
    await f.manager.tick();
    assert.ok(f.manager.snapshot().last_attempt_at! > failedAt!);
    assert.equal(f.manager.snapshot().status, "error");
    assert.equal(f.active().cert, renewed.cert);
  } finally {
    await f.close();
  }
});
