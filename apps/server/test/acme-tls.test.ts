import test from "node:test";
import assert from "node:assert/strict";
import { createHash, X509Certificate } from "node:crypto";
import {
  createServer,
  createSecureContext,
  connect,
  type TLSSocket,
} from "node:tls";
import { once } from "node:events";
import {
  X509Certificate as ParsedCertificate,
  SubjectAlternativeNameExtension,
} from "@peculiar/x509";
import {
  AcmeTlsResponder,
  ACME_ALPN,
  createChallengeCertificate,
  challengeServerName,
} from "../src/acme-tls.js";

for (const host of ["fleet.example.com", "8.8.4.4", "2606:4700:4700::1111"]) {
  test(`TLS challenge for ${host} has a single SAN and critical key authorization digest`, async () => {
    const { cert } = await createChallengeCertificate(host, "token.thumbprint");
    const parsed = new ParsedCertificate(cert);
    const ext = parsed.getExtension("1.3.6.1.5.5.7.1.31")!;
    assert.equal(ext.critical, true);
    assert.deepEqual(
      Buffer.from(ext.value),
      Buffer.concat([
        Buffer.from([4, 32]),
        createHash("sha256").update("token.thumbprint").digest(),
      ]),
    );
    assert.equal(new X509Certificate(cert).ca, false);
    assert.equal(
      parsed.getExtension<SubjectAlternativeNameExtension>("2.5.29.17")!.names
        .items.length,
      1,
    );
  });
}
test("IP verification SNI uses reverse DNS syntax without a lookup", () => {
  assert.equal(challengeServerName("8.8.4.4"), "4.4.8.8.in-addr.arpa");
  assert.equal(
    challengeServerName("2606:4700:4700::1111"),
    "11110000000000000000007400746062".split("").join(".") + ".ip6.arpa",
  );
});
test("TLS challenge is isolated by exclusive ALPN and SNI; existing connections survive replacement and cleanup", async () => {
  const normal = await createChallengeCertificate(
    "fleet.example.com",
    "normal",
  );
  const first = await createChallengeCertificate("8.8.4.4", "first");
  const next = await createChallengeCertificate("8.8.4.4", "next");
  const fp = (pem: string) => new X509Certificate(pem).fingerprint256;
  let now = Date.now();
  const responder = new AcmeTlsResponder(() => now);
  const normalContext = createSecureContext(normal);
  const server = createServer(
    {
      ...normal,
      ALPNCallback: responder.callback(),
      SNICallback: function (this: TLSSocket, _name, done) {
        done(null, responder.sniContext(this) ?? normalContext);
      },
    },
    (socket) => {
      socket.on("error", () => {});
      socket.pipe(socket);
    },
  );
  server.on("tlsClientError", () => {});
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const port = (server.address() as { port: number }).port;
  const sockets: TLSSocket[] = [];
  // Only these protocol fixtures inspect intentionally self-signed, critical ACME
  // certificates without PKI validation. Product E2E connections validate their CA.
  async function dial(
    protocols: string[],
    servername = "4.4.8.8.in-addr.arpa",
    maxVersion: "TLSv1.2" | "TLSv1.3" = "TLSv1.3",
  ) {
    const socket = connect({
      host: "127.0.0.1",
      port,
      ALPNProtocols: protocols,
      servername,
      rejectUnauthorized: false,
      maxVersion,
    });
    sockets.push(socket);
    await once(socket, "secureConnect");
    socket.on("error", () => {});
    return socket;
  }
  try {
    const existing = await dial(["http/1.1"], "fleet.example.com");
    responder.publish("8.8.4.4", "first", first);
    for (const version of ["TLSv1.2", "TLSv1.3"] as const) {
      const socket = await dial([ACME_ALPN], undefined, version);
      assert.equal(socket.alpnProtocol, ACME_ALPN);
      assert.equal(socket.getPeerCertificate().fingerprint256, fp(first.cert));
    }
    for (const protocols of [[], ["http/1.1"], [ACME_ALPN, "http/1.1"]]) {
      const socket = await dial(protocols);
      assert.equal(socket.getPeerCertificate().fingerprint256, fp(normal.cert));
    }
    await assert.rejects(dial([ACME_ALPN], "other.example.com"));
    await assert.rejects(dial([ACME_ALPN], ""));
    assert.equal(
      (await dial([], "")).getPeerCertificate().fingerprint256,
      fp(normal.cert),
    );
    responder.publish("8.8.4.4", "next", next);
    responder.publish("8.8.4.4", "first", null);
    assert.equal(
      (await dial([ACME_ALPN])).getPeerCertificate().fingerprint256,
      fp(next.cert),
    );
    responder.clear();
    await assert.rejects(dial([ACME_ALPN]));
    const data = once(existing, "data");
    existing.write("connection survives");
    assert.equal((await data)[0].toString(), "connection survives");
    responder.publish("8.8.4.4", "next", next);
    now += 300001;
    await assert.rejects(dial([ACME_ALPN]));
  } finally {
    sockets.forEach((s) => s.destroy());
    await new Promise<void>((r) => server.close(() => r()));
  }
});
