import test from "node:test";
import assert from "node:assert/strict";
import {
  mkdtempSync,
  readFileSync,
  writeFileSync,
  statSync,
  rmSync,
  renameSync,
} from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { X509Certificate } from "node:crypto";
import { createServer, request } from "node:https";
import { connect } from "node:tls";
import { once } from "node:events";
import { execFileSync } from "node:child_process";
import {
  initializeTls,
  renewTls,
  prepareMigration,
  activateMigration,
} from "../../scripts/dev-tls.mjs";
import { watchTlsContext } from "../../lib/tls-context.mjs";
const fixture = () => mkdtempSync(join(tmpdir(), "farhelm-renewal-"));
const leaf = (dir) =>
  new X509Certificate(readFileSync(join(dir, "server.crt")));
function get(port, ca) {
  return new Promise((resolve, reject) => {
    const req = request(
      { hostname: "localhost", port, path: "/", ca, agent: false },
      (res) => {
        res.resume();
        res.on("end", () => resolve(res.statusCode));
      },
    );
    req.on("error", reject);
    req.end();
  });
}
test("managed renewal retains CA and private keys, respects threshold, and serializes concurrent writers", async () => {
  const dir = fixture();
  try {
    await initializeTls(dir);
    const root = readFileSync(join(dir, "ca.crt")),
      key = readFileSync(join(dir, "server.key")),
      before = leaf(dir);
    assert.ok(
      Date.parse(new X509Certificate(root).validTo) >
        Date.now() + 3000 * 86400000,
    );
    assert.equal((await renewTls(dir)).status, "current");
    assert.equal(leaf(dir).fingerprint256, before.fingerprint256);
    const result = await renewTls(dir, {
      now: Date.parse(before.validTo) - 29 * 86400000,
    });
    assert.equal(result.status, "renewed");
    assert.notEqual(leaf(dir).fingerprint256, before.fingerprint256);
    assert.deepEqual(readFileSync(join(dir, "ca.crt")), root);
    assert.deepEqual(readFileSync(join(dir, "server.key")), key);
    const concurrent = await Promise.all([
      renewTls(dir, { force: true }),
      renewTls(dir, { force: true }),
    ]);
    assert.deepEqual(concurrent.map((x) => x.status).sort(), [
      "busy",
      "renewed",
    ]);
    assert.equal(statSync(join(dir, "server.crt")).mode & 0o777, 0o600);
    await assert.rejects(initializeTls(dir), /overwrite/);
    writeFileSync(
      join(dir, "managed.json"),
      JSON.stringify({ v: 1, ca_fingerprint256: "different" }),
    );
    const stable = readFileSync(join(dir, "server.crt"));
    await assert.rejects(renewTls(dir, { force: true }), /CA changed/);
    assert.deepEqual(readFileSync(join(dir, "server.crt")), stable);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
test("failed signer and near-expiry root leave the last valid server certificate intact", async () => {
  const dir = fixture();
  try {
    await initializeTls(dir);
    const before = readFileSync(join(dir, "server.crt"));
    renameSync(join(dir, "ca.key"), join(dir, "ca.key.saved"));
    await assert.rejects(renewTls(dir, { force: true }));
    assert.deepEqual(readFileSync(join(dir, "server.crt")), before);
    renameSync(join(dir, "ca.key.saved"), join(dir, "ca.key"));
    const root = new X509Certificate(readFileSync(join(dir, "ca.crt")));
    await assert.rejects(
      renewTls(dir, { now: Date.parse(root.validTo) - 89 * 86400000 }),
      /root CA needs/,
    );
    assert.deepEqual(readFileSync(join(dir, "server.crt")), before);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
test("hot reload uses new certificate on new handshakes and preserves existing sockets; bad pairs are rejected", async () => {
  const dir = fixture();
  let server, watcher, socket;
  try {
    await initializeTls(dir);
    const ca = readFileSync(join(dir, "ca.crt"));
    server = createServer(
      {
        cert: readFileSync(join(dir, "server.crt")),
        key: readFileSync(join(dir, "server.key")),
      },
      (_req, res) => res.end("ok"),
    );
    await new Promise((r) => server.listen(0, "127.0.0.1", r));
    const port = server.address().port;
    watcher = watchTlsContext(server, {
      certPath: join(dir, "server.crt"),
      keyPath: join(dir, "server.key"),
      intervalMs: 20,
    });
    socket = connect({ host: "localhost", port, ca });
    await once(socket, "secureConnect");
    const previous = socket.getPeerCertificate().fingerprint256;
    await renewTls(dir, { force: true });
    await new Promise((r) => setTimeout(r, 50));
    assert.ok(!socket.destroyed);
    assert.equal(socket.getPeerCertificate().fingerprint256, previous);
    const fresh = connect({ host: "localhost", port, ca });
    await once(fresh, "secureConnect");
    assert.equal(
      fresh.getPeerCertificate().fingerprint256,
      leaf(dir).fingerprint256,
    );
    assert.notEqual(fresh.getPeerCertificate().fingerprint256, previous);
    fresh.destroy();
    socket.write(
      "GET / HTTP/1.1\r\nHost: localhost\r\nConnection: close\r\n\r\n",
    );
    const [response] = await once(socket, "data");
    assert.match(response.toString(), /200 OK/);
    const good = readFileSync(join(dir, "server.crt"));
    writeFileSync(join(dir, "server.crt"), "incomplete certificate");
    watcher.close();
    // An invalid file at watcher startup must still recover when valid files arrive.
    watcher = watchTlsContext(server, {
      certPath: join(dir, "server.crt"),
      keyPath: join(dir, "server.key"),
      intervalMs: 20,
    });
    assert.equal(watcher.check(), false);
    assert.equal(await get(port, ca), 200);
    writeFileSync(join(dir, "server.crt"), good);
    assert.equal(watcher.check(), true);
    const key = readFileSync(join(dir, "server.key"));
    writeFileSync(join(dir, "server.key"), readFileSync(join(dir, "ca.key")));
    assert.equal(watcher.check(), false);
    assert.equal(await get(port, ca), 200);
    writeFileSync(join(dir, "server.key"), key);
    await assert.rejects(get(port, []), /certificate|issuer|verify/i);
  } finally {
    watcher?.close();
    socket?.destroy();
    if (server) {
      server.closeAllConnections();
      await new Promise((r) => server.close(r));
    }
    rmSync(dir, { recursive: true, force: true });
  }
});
test("one-time migration keeps the Agent CA identity and Docker mount inode, and prepared trust is stable", async () => {
  const dir = fixture();
  try {
    await initializeTls(dir);
    // Recreate the prior 7-day CA, preserving its subject/key and the signed leaf.
    execFileSync(
      "openssl",
      [
        "req",
        "-x509",
        "-new",
        "-sha256",
        "-key",
        join(dir, "ca.key"),
        "-days",
        "7",
        "-out",
        join(dir, "ca.crt"),
        "-subj",
        "/CN=Farhelm local development CA",
        "-addext",
        "basicConstraints=critical,CA:TRUE",
        "-addext",
        "keyUsage=critical,keyCertSign,cRLSign",
      ],
      { stdio: "ignore" },
    );
    rmSync(join(dir, "managed.json"));
    const old = new X509Certificate(readFileSync(join(dir, "ca.crt"))),
      inode = statSync(join(dir, "ca.crt")).ino;
    const before = leaf(dir).fingerprint256;
    assert.equal((await renewTls(dir)).status, "unmanaged");
    await prepareMigration(dir);
    const prepared = readFileSync(join(dir, "ca-next.crt"));
    await prepareMigration(dir);
    assert.deepEqual(readFileSync(join(dir, "ca-next.crt")), prepared);
    assert.equal(leaf(dir).fingerprint256, before);
    await activateMigration(dir);
    const next = new X509Certificate(readFileSync(join(dir, "ca.crt")));
    assert.ok(next.publicKey.equals(old.publicKey));
    assert.equal(next.subject, old.subject);
    assert.equal(statSync(join(dir, "ca.crt")).ino, inode);
    assert.notEqual(leaf(dir).fingerprint256, before);
    assert.equal((await renewTls(dir)).status, "current");
    // Both old and new roots validate signatures during the migration window.
    assert.ok(leaf(dir).verify(old.publicKey));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
test("the durable local CA rejects certificates for unrelated hostnames", async () => {
  const dir = fixture();
  try {
    await initializeTls(dir);
    writeFileSync(
      join(dir, "other.cnf"),
      "subjectAltName=DNS:example.com\nbasicConstraints=critical,CA:FALSE\nextendedKeyUsage=serverAuth\n",
    );
    execFileSync(
      "openssl",
      [
        "req",
        "-new",
        "-key",
        join(dir, "server.key"),
        "-out",
        join(dir, "other.csr"),
        "-subj",
        "/CN=example.com",
      ],
      { stdio: "ignore" },
    );
    execFileSync(
      "openssl",
      [
        "x509",
        "-req",
        "-in",
        join(dir, "other.csr"),
        "-CA",
        join(dir, "ca.crt"),
        "-CAkey",
        join(dir, "ca.key"),
        "-set_serial",
        "123",
        "-days",
        "1",
        "-extfile",
        join(dir, "other.cnf"),
        "-out",
        join(dir, "other.crt"),
      ],
      { stdio: "ignore" },
    );
    assert.throws(() =>
      execFileSync(
        "openssl",
        ["verify", "-CAfile", join(dir, "ca.crt"), join(dir, "other.crt")],
        { stdio: "ignore" },
      ),
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
