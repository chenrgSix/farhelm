import test from "node:test";
import assert from "node:assert/strict";
import {
  mkdtempSync,
  readFileSync,
  writeFileSync,
  statSync,
  existsSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { setTimeout as delay } from "node:timers/promises";
import { request } from "node:http";
import { isIP } from "node:net";
import { challengeHostMatches } from "../src/certificate-host.js";
import { Store } from "../src/store.js";
import { CertificateManager, certificateDomain } from "../src/certificates.js";
import { CertificateError, type IssueCertificate } from "../src/acme.js";
import {
  managedCertificate,
  certificateInfo,
} from "../src/certificate-files.js";
import { buildServer } from "../src/server.js";
// @ts-ignore shared contract validators
import { assertValid } from "../../../tests/contracts/validate.mjs";
const root = mkdtempSync(join(tmpdir(), "farhelm-certificates-"));
const openssl = (...args: string[]) =>
  execFileSync("openssl", args, { cwd: root, stdio: "ignore" });
openssl(
  "req",
  "-x509",
  "-newkey",
  "ec",
  "-pkeyopt",
  "ec_paramgen_curve:P-256",
  "-nodes",
  "-keyout",
  "ca.key",
  "-out",
  "ca.crt",
  "-subj",
  "/CN=Test ACME CA",
  "-days",
  "365",
  "-addext",
  "basicConstraints=critical,CA:TRUE",
  "-addext",
  "keyUsage=critical,keyCertSign,cRLSign",
);
let serial = 0;
function sign(domain = "fleet.example.com", days = 90) {
  const n = ++serial;
  openssl(
    "req",
    "-new",
    "-newkey",
    "ec",
    "-pkeyopt",
    "ec_paramgen_curve:P-256",
    "-nodes",
    "-keyout",
    `${n}.key`,
    "-out",
    `${n}.csr`,
    "-subj",
    `/CN=${domain}`,
  );
  writeFileSync(
    join(root, `${n}.ext`),
    `subjectAltName=${isIP(domain) ? "IP" : "DNS"}:${domain}\nbasicConstraints=critical,CA:FALSE\nkeyUsage=critical,digitalSignature\nextendedKeyUsage=serverAuth\n`,
  );
  openssl(
    "x509",
    "-req",
    "-in",
    `${n}.csr`,
    "-CA",
    "ca.crt",
    "-CAkey",
    "ca.key",
    "-set_serial",
    String(n),
    "-days",
    String(days),
    "-extfile",
    `${n}.ext`,
    "-out",
    `${n}.crt`,
  );
  return {
    cert:
      readFileSync(join(root, `${n}.crt`), "utf8") +
      readFileSync(join(root, "ca.crt"), "utf8"),
    key: readFileSync(join(root, `${n}.key`), "utf8"),
    domain,
  };
}
const bootstrap = sign("localhost");
const config = {
  v: 1,
  revision: 0,
  domain: "fleet.example.com",
  email: "ops@example.com",
  enabled: true,
  tos_agreed: true,
};
async function fixture(
  issue: IssueCertificate,
  options: {
    dataDir?: string;
    initial?: ReturnType<typeof sign>;
    now?: () => number;
    activate?: () => void;
  } = {},
) {
  const store = new Store(options.dataDir ?? mkdtempSync(join(root, "store-")));
  let actor = (
    store.db.prepare("SELECT id FROM users WHERE username='admin'").get() as any
  )?.id;
  actor ??= store.seedUser({
    username: "admin",
    password: "certificate-password",
    role: "admin",
    deviceScope: "*",
  }).id;
  let activated = 0;
  const manager = new CertificateManager({
    store,
    config: { httpHost: "127.0.0.1", httpPort: 0 },
    issue,
    fallback: () => bootstrap.cert,
    initial: options.initial,
    now: options.now,
    activate: () => {
      options.activate?.();
      activated++;
    },
  });
  await manager.start();
  return {
    manager,
    store,
    actor,
    activated: () => activated,
    close: async () => {
      await manager.close();
      store.close();
    },
  };
}
async function until(check: () => boolean) {
  for (let i = 0; i < 300; i++) {
    if (check()) return;
    await delay(10);
  }
  throw new Error("Condition timed out");
}
function http(port: number, path: string, host = "fleet.example.com") {
  return new Promise<{ code: number; body: string }>((resolve, reject) => {
    const req = request(
      { hostname: "127.0.0.1", port, path, headers: { host } },
      (res) => {
        let body = "";
        res.on("data", (b) => (body += b));
        res.on("end", () => resolve({ code: res.statusCode!, body }));
      },
    );
    req.on("error", reject);
    req.end();
  });
}
test("public certificate validation accepts domains and public IPs but rejects private and special addresses", () => {
  for (const input of [
    "https://fleet.example.com",
    "a.example.com:443",
    "*.example.com",
    "127.0.0.1",
    "0.0.0.0",
    "10.0.0.1",
    "172.16.1.1",
    "192.168.1.1",
    "100.64.0.1",
    "169.254.1.1",
    "192.0.2.1",
    "198.51.100.1",
    "203.0.113.1",
    "198.18.0.1",
    "224.0.0.1",
    "255.255.255.255",
    "::",
    "::1",
    "fc00::1",
    "fe80::1",
    "fe80::1%en0",
    "ff02::1",
    "::ffff:8.8.8.8",
    "2001:db8::1",
    "3fff::1",
    "2002:0808:0808::1",
    "[2606:4700:4700::1111]",
    "8.8.8.8:443",
    "008.008.008.008",
    "134744072",
    "0x08080808",
    "localhost",
    "host.docker.internal",
    "a.local",
    "a.test",
    "a..com",
    "-a.com",
    "a.com/path",
    "a.com?x",
    "a.co\nm",
    "123.456",
  ])
    assert.throws(() => certificateDomain(input), undefined, input);
  assert.equal(certificateDomain(" 8.8.8.8 "), "8.8.8.8");
  assert.equal(
    certificateDomain("2606:4700:4700:0:0:0:0:1111"),
    "2606:4700:4700::1111",
  );
  assert.equal(certificateDomain(" FLEET.Example.com "), "fleet.example.com");
  assert.equal(certificateDomain("例子.公司"), "xn--fsqu00a.xn--55qx5d");
});
test("issuance restricts challenges, deduplicates jobs, persists privately and survives restart", async () => {
  let calls = 0,
    finish!: (cert: ReturnType<typeof sign>) => void;
  const f = await fixture(async ({ challenge }) => {
    calls++;
    challenge("test-token", "test-token.authorization");
    return new Promise((resolve) => {
      finish = resolve;
    });
  });
  const dataDir = f.store.dataDir;
  try {
    f.manager.save(config, f.actor);
    assert.throws(
      () => f.manager.request({ v: 1, revision: 1 }, f.actor, true),
      /PRIVATE_CERTIFICATE_RENEWAL_UNAVAILABLE/,
    );
    await until(() => calls === 1);
    assert.equal(f.manager.snapshot().status, "issuing");
    assert.deepEqual(
      await http(f.manager.port()!, "/.well-known/acme-challenge/test-token"),
      { code: 200, body: "test-token.authorization" },
    );
    for (const path of [
      "/api/v1/login",
      "/",
      "/.well-known/acme-challenge/../account.key",
      "/.well-known/acme-challenge/no",
      "/.well-known/acme-challenge/test-token?extra=1",
    ])
      assert.equal((await http(f.manager.port()!, path)).code, 404);
    assert.equal(
      (
        await http(
          f.manager.port()!,
          "/.well-known/acme-challenge/test-token",
          "other.example.com",
        )
      ).code,
      404,
    );
    await Promise.all([f.manager.tick(), f.manager.tick()]);
    f.manager.request({ v: 1, revision: 1 }, f.actor);
    assert.equal(calls, 1);
    finish(sign());
    await until(() => f.manager.snapshot().status === "valid");
    assert.equal(f.activated(), 1);
    assertValid("certificate-status", f.manager.snapshot());
    assert.equal(
      (await http(f.manager.port()!, "/.well-known/acme-challenge/test-token"))
        .code,
      404,
    );
    assert.equal(
      statSync(join(dataDir, "certificates/active.json")).mode & 0o777,
      0o600,
    );
    assert.equal(statSync(join(dataDir, "certificates")).mode & 0o777, 0o700);
    assert.ok(!JSON.stringify(f.manager.snapshot()).includes("PRIVATE KEY"));
    for (const row of f.store.db
      .prepare("SELECT * FROM audit WHERE action LIKE 'certificate.%'")
      .all() as any[])
      assertValid("audit", {
        id: row.id,
        at: row.at,
        actor_id: row.actor_id,
        device_id: null,
        task_id: null,
        action: row.action,
        detail: JSON.parse(row.detail_json),
      });
  } finally {
    await f.close();
  }
  const g = await fixture(
    async () => {
      throw new Error("Unexpected issuance");
    },
    { dataDir, initial: managedCertificate(dataDir) },
  );
  try {
    await g.manager.tick();
    assert.equal(g.manager.snapshot().status, "valid");
  } finally {
    await g.close();
  }
});
test("renewal checks due date, retains certificates on failure, backs off and loads a valid replacement", async () => {
  let now = Date.now(),
    calls = 0;
  const first = sign(),
    second = sign("fleet.example.com", 180);
  now = Date.now();
  const f = await fixture(
    async () => {
      calls++;
      if (calls === 1) return first;
      if (calls === 2) throw new CertificateError("ACME_DNS_FAILED");
      return second;
    },
    { now: () => now },
  );
  try {
    f.manager.save(config, f.actor);
    await until(() => f.manager.snapshot().status === "valid");
    now += 600000;
    f.manager.request({ v: 1, revision: 1 }, f.actor);
    await f.manager.tick();
    assert.equal(calls, 1);
    now = certificateInfo(first.cert).renew_at + 1;
    await f.manager.tick();
    assert.equal(f.manager.snapshot().last_error?.code, "ACME_DNS_FAILED");
    assert.equal(f.activated(), 1);
    assert.equal(managedCertificate(f.store.dataDir)?.cert, first.cert);
    await f.manager.tick();
    assert.equal(calls, 2);
    now = f.manager.snapshot().next_attempt_at! + 1;
    await f.manager.tick();
    assert.equal(calls, 3);
    assert.equal(f.activated(), 2);
    assert.equal(f.manager.snapshot().status, "valid");
    assert.equal(
      JSON.parse(
        readFileSync(
          join(f.store.dataDir, "certificates/previous.json"),
          "utf8",
        ),
      ).cert,
      first.cert,
    );
  } finally {
    await f.close();
  }
});
test("invalid replacements and activation errors preserve the last usable certificate", async () => {
  for (const mode of ["identity", "key", "activation"] as const) {
    let now = Date.now();
    const first = sign();
    now = Date.now(); // OpenSSL may cross a second while generating notBefore.
    let calls = 0;
    const f = await fixture(
      async () => {
        calls++;
        if (calls === 1) return first;
        const second = sign(
          mode === "identity" ? "wrong.example.com" : "fleet.example.com",
          180,
        );
        return mode === "key" ? { ...second, key: first.key } : second;
      },
      {
        now: () => now,
        activate: () => {
          if (mode === "activation" && calls > 1)
            throw new Error("Failed to activate");
        },
      },
    );
    try {
      f.manager.save(config, f.actor);
      await until(() => f.manager.snapshot().status === "valid");
      now = certificateInfo(first.cert).renew_at + 1;
      await f.manager.tick();
      assert.equal(f.manager.snapshot().status, "error");
      assert.equal(managedCertificate(f.store.dataDir)?.cert, first.cert);
      assert.equal(f.activated(), 1);
    } finally {
      await f.close();
    }
  }
});
test("provider cooldown survives edits and restart; disabling cancels an in-flight result", async () => {
  const now = Date.now(),
    retry = now + 48 * 3600000;
  const f = await fixture(
    async () => {
      throw new CertificateError("ACME_RATE_LIMITED", retry);
    },
    { now: () => now },
  );
  try {
    f.manager.save(config, f.actor);
    await until(() => f.manager.snapshot().status === "error");
    assert.equal(f.manager.snapshot().retry_allowed_at, retry);
    assert.throws(
      () => f.manager.request({ v: 1, revision: 1 }, f.actor),
      /CERTIFICATE_RETRY_LATER/,
    );
    f.manager.save(
      { ...config, revision: 1, domain: "new.example.com" },
      f.actor,
    );
    assert.equal(f.manager.snapshot().next_attempt_at, retry);
    assert.throws(
      () => f.manager.save({ ...config, revision: 1 }, f.actor),
      /CERTIFICATE_REVISION_CONFLICT/,
    );
  } finally {
    await f.close();
  }
  const g = await fixture(
    async () => {
      throw new Error("Unexpected issuance during cooldown");
    },
    { dataDir: f.store.dataDir, now: () => now },
  );
  try {
    await g.manager.tick();
    assert.equal(g.manager.snapshot().next_attempt_at, retry);
  } finally {
    await g.close();
  }
  let finish!: (x: ReturnType<typeof sign>) => void;
  const h = await fixture(
    async () =>
      new Promise((resolve) => {
        finish = resolve;
      }),
  );
  try {
    h.manager.save(config, h.actor);
    await until(() => !!finish);
    assert.throws(
      () =>
        h.manager.save(
          { ...config, revision: 1, domain: "new.example.com" },
          h.actor,
        ),
      /CERTIFICATE_BUSY/,
    );
    h.manager.save({ ...config, revision: 1, enabled: false }, h.actor);
    finish(sign());
    await delay(20);
    assert.equal(h.manager.snapshot().status, "disabled");
    assert.equal(h.activated(), 0);
    assert.equal(
      existsSync(join(h.store.dataDir, "certificates/active.json")),
      false,
    );
  } finally {
    await h.close();
  }
});
test("certificate API is admin-only and rejects unavailable deployments without changing Agent addresses", async () => {
  const server = await buildServer({
    dataDir: mkdtempSync(join(root, "api-")),
    tlsCert: bootstrap.cert,
    tlsKey: bootstrap.key,
    adminUsername: "admin",
    adminPassword: "certificate-api-password",
  });
  const login = async (username: string) =>
    (
      await server.app.inject({
        method: "POST",
        url: "/api/v1/login",
        payload: { username, password: "certificate-api-password" },
      })
    ).json().access_token;
  const api = (
    method: "GET" | "PUT" | "POST",
    token: string,
    path = "/settings/certificate",
    body?: unknown,
  ) =>
    server.app.inject({
      method,
      url: "/api/v1" + path,
      payload: body,
      headers: { authorization: `Bearer ${token}` },
    });
  try {
    const admin = await login("admin");
    for (const role of ["ops", "business", "auditor"] as const) {
      server.store.seedUser({
        username: role,
        password: "certificate-api-password",
        role,
        deviceScope: "*",
      });
      const token = await login(role);
      for (const [method, path, body] of [
        ["GET", "/settings/certificate", undefined],
        ["PUT", "/settings/certificate", config],
        ["POST", "/settings/certificate/check", { v: 1, revision: 1 }],
      ] as const)
        assert.equal((await api(method, token, path, body)).statusCode, 403);
    }
    assert.equal((await api("GET", "invalid")).statusCode, 401);
    const status = (await api("GET", admin)).json();
    assert.equal(status.available, false);
    assertValid("certificate-status", status);
    assert.equal(
      (await api("PUT", admin, "/settings/certificate", config)).statusCode,
      409,
    );
    assert.equal(
      (
        await api("PUT", admin, "/settings/certificate", {
          ...config,
          enabled: false,
          private_key: "secret",
        })
      ).statusCode,
      400,
    );
    assert.equal(
      (
        await api("PUT", admin, "/settings/certificate", {
          ...config,
          enabled: false,
        })
      ).statusCode,
      200,
    );
    assert.equal((await api("GET", admin, "/settings")).json().revision, 0);
  } finally {
    await server.close();
  }
});

test("previous-domain SNI and bootstrap access survive a managed certificate restart", async () => {
  const { request: https } = await import("node:https");
  const first = sign("old.example.com"),
    active = sign();
  const f = await fixture(async () => active, { initial: first });
  try {
    f.manager.save(config, f.actor);
    await until(() => f.manager.snapshot().status === "valid");
    assert.equal(
      managedCertificate(f.store.dataDir, "retired.json")?.domain,
      "old.example.com",
    );
  } finally {
    await f.close();
  }
  const server = await buildServer({
    dataDir: f.store.dataDir,
    tlsCert: bootstrap.cert,
    tlsKey: bootstrap.key,
    acme: { httpHost: "127.0.0.1", httpPort: 0 },
  });
  try {
    await server.app.listen({ host: "127.0.0.1", port: 0 });
    const port = (server.app.server.address() as any).port;
    for (const bundle of [first, active, bootstrap]) {
      const fingerprint = await new Promise<string>((resolve, reject) => {
        const req = https(
          {
            hostname: "127.0.0.1",
            port,
            servername: bundle.domain,
            path: "/healthz",
            agent: false,
            ca: readFileSync(join(root, "ca.crt")),
          },
          (res) => {
            const value = res.socket.getPeerX509Certificate()!.fingerprint256;
            res.resume();
            res.on("end", () => resolve(value));
          },
        );
        req.on("error", reject);
        req.end();
      });
      assert.equal(fingerprint, certificateInfo(bundle.cert).fingerprint);
    }
  } finally {
    await server.close();
  }
});

test("HTTP-01 Host validation handles IPv6 and rejects malformed authorities", () => {
  for (const host of [
    "[2606:4700:4700::1111]",
    "[2606:4700:4700:0:0:0:0:1111]:80",
  ])
    assert.ok(challengeHostMatches(host, "2606:4700:4700::1111"));
  assert.ok(challengeHostMatches("8.8.8.8:80", "8.8.8.8"));
  for (const host of [
    "[2606:4700:4700::1112]",
    "2606:4700:4700::1111",
    "[2606:4700:4700::1111]:99999",
    "user@[2606:4700:4700::1111]",
    "[2606:4700:4700::1111]/",
    undefined,
  ])
    assert.equal(challengeHostMatches(host, "2606:4700:4700::1111"), false);
  assert.equal(challengeHostMatches("008.008.008.008", "8.8.8.8"), false);
});

test("IP certificates use SANs, serve IPv6 challenges and automatically renew short lifetimes without replacing on failure", async () => {
  const domain = "2606:4700:4700::1111";
  let now = Date.now(),
    calls = 0;
  const first = sign(domain, 6),
    second = sign(domain, 12);
  now = Date.now();
  const f = await fixture(
    async ({ domain: host, challenge }) => {
      assert.equal(host, domain);
      calls++;
      if (calls === 2) throw new CertificateError("ACME_CHALLENGE_FAILED");
      challenge("ip-token", "ip-token.authorization");
      assert.equal(
        (
          await http(
            f.manager.port()!,
            "/.well-known/acme-challenge/ip-token",
            "[2606:4700:4700:0:0:0:0:1111]:80",
          )
        ).code,
        200,
      );
      assert.equal(
        (
          await http(
            f.manager.port()!,
            "/.well-known/acme-challenge/ip-token",
            "[2606:4700:4700::1112]",
          )
        ).code,
        404,
      );
      return calls === 1 ? first : second;
    },
    { now: () => now },
  );
  try {
    f.manager.save({ ...config, domain }, f.actor);
    await until(() => f.manager.snapshot().status === "valid");
    const info = f.manager.snapshot().certificate;
    assert.equal(info.renew_at - info.valid_from, 4 * 86400000);
    assertValid("certificate-status", f.manager.snapshot());
    now = info.renew_at - 1;
    await f.manager.tick();
    assert.equal(calls, 1);
    now++;
    await f.manager.tick();
    assert.equal(
      f.manager.snapshot().last_error?.code,
      "ACME_CHALLENGE_FAILED",
    );
    assert.equal(f.activated(), 1);
    assert.equal(managedCertificate(f.store.dataDir)?.cert, first.cert);
    now = f.manager.snapshot().next_attempt_at!;
    await f.manager.tick();
    assert.equal(f.activated(), 2);
    assert.equal(f.manager.snapshot().status, "valid");
    assert.equal(managedCertificate(f.store.dataDir)?.cert, second.cert);
  } finally {
    await f.close();
  }
});
