import "reflect-metadata";
import {
  createHash,
  createPrivateKey,
  randomBytes,
  webcrypto,
  X509Certificate,
} from "node:crypto";
import { isIP } from "node:net";
import {
  createSecureContext,
  type SecureContext,
  type TLSSocket,
} from "node:tls";
import {
  BasicConstraintsExtension,
  Extension,
  KeyUsageFlags,
  KeyUsagesExtension,
  SubjectAlternativeNameExtension,
  X509CertificateGenerator,
} from "@peculiar/x509";
import { certificateMatches } from "./certificate-files.js";
import { normalizeIP } from "./certificate-host.js";

export type AcmeChallengeType = "http-01" | "tls-alpn-01";
export type ChallengeCertificate = { cert: string; key: string };
export const ACME_ALPN = "acme-tls/1";

// RFC 8738: an IP validation request uses reverse DNS syntax in SNI, but the
// certificate must contain the original IP SAN (no reverse-DNS lookup is made).
export function challengeServerName(host: string) {
  if (isIP(host) === 4)
    return host.split(".").reverse().join(".") + ".in-addr.arpa";
  if (isIP(host) === 6) {
    const [left, right] = normalizeIP(host).split("::");
    const a = left ? left.split(":") : [],
      b = right ? right.split(":") : [];
    const parts =
      right === undefined
        ? a
        : [...a, ...Array(8 - a.length - b.length).fill("0"), ...b];
    return (
      parts
        .map((p) => p.padStart(4, "0"))
        .join("")
        .split("")
        .reverse()
        .join(".") + ".ip6.arpa"
    );
  }
  return host.toLowerCase();
}

export async function createChallengeCertificate(
  host: string,
  authorization: string,
): Promise<ChallengeCertificate> {
  const keys = await webcrypto.subtle.generateKey(
    { name: "ECDSA", namedCurve: "P-256" },
    true,
    ["sign", "verify"],
  );
  const digest = createHash("sha256").update(authorization).digest();
  // RFC 8737 acmeIdentifier: critical extension, DER OCTET STRING of 32 bytes.
  const der = Uint8Array.from([4, 32, ...digest]).buffer;
  const now = Date.now();
  const serial = randomBytes(16);
  serial[0] = serial[0]! & 0x7f || 1;
  const cert = await X509CertificateGenerator.createSelfSigned({
    keys: keys as CryptoKeyPair,
    signingAlgorithm: { name: "ECDSA", hash: "SHA-256" },
    serialNumber: serial.toString("hex"),
    name: "CN=ACME validation",
    notBefore: new Date(now - 60000),
    notAfter: new Date(now + 10 * 60000),
    extensions: [
      new BasicConstraintsExtension(false, undefined, true),
      new KeyUsagesExtension(KeyUsageFlags.digitalSignature, true),
      new SubjectAlternativeNameExtension([
        { type: isIP(host) ? "ip" : "dns", value: host },
      ]),
      new Extension("1.3.6.1.5.5.7.1.31", true, der),
    ],
  });
  const key = createPrivateKey({
    key: Buffer.from(
      await webcrypto.subtle.exportKey("pkcs8", keys.privateKey),
    ),
    type: "pkcs8",
    format: "der",
  })
    .export({ type: "pkcs8", format: "pem" })
    .toString();
  return { cert: cert.toString("pem"), key };
}

// Kept only in memory for the in-flight order. Normal HTTPS/WSS handshakes keep
// their existing identity; only an exclusive acme-tls/1 offer gets this key.
export class AcmeTlsResponder {
  private selected = new WeakMap<TLSSocket, SecureContext>();
  private active?: {
    name: string;
    token: string;
    context: SecureContext;
    expires: number;
  };
  constructor(private now = Date.now) {}
  publish(host: string, token: string, bundle: ChallengeCertificate | null) {
    if (!bundle) {
      if (this.active?.token === token) this.clear();
      return;
    }
    if (bundle.cert.length > 32768 || bundle.key.length > 16384)
      throw new Error("Invalid TLS challenge");
    const cert = new X509Certificate(bundle.cert);
    if (
      cert.ca ||
      !certificateMatches(cert, host) ||
      !cert.checkPrivateKey(createPrivateKey(bundle.key))
    )
      throw new Error("Invalid TLS challenge identity");
    this.active = {
      name: challengeServerName(host),
      token,
      context: createSecureContext({ ...bundle, minVersion: "TLSv1.2" }),
      expires: this.now() + 5 * 60000,
    };
  }
  clear() {
    this.active = undefined;
    this.selected = new WeakMap();
  }
  // TLS 1.3 invokes ALPN before Node's SNI callback, whereas TLS 1.2 invokes
  // them in the opposite order. Preserve the per-socket choice in both paths.
  sniContext(socket: TLSSocket) {
    return this.selected.get(socket);
  }
  callback() {
    const responder = this;
    return function (
      this: TLSSocket,
      { servername, protocols }: { servername: string; protocols: string[] },
    ) {
      if (protocols.length === 1 && protocols[0] === ACME_ALPN) {
        const active = responder.active;
        if (
          !active ||
          active.expires <= responder.now() ||
          servername?.toLowerCase() !== active.name
        )
          return undefined;
        responder.selected.set(this, active.context);
        this.setKeyCert(active.context);
        return ACME_ALPN;
      }
      return protocols.includes("http/1.1") ? "http/1.1" : undefined;
    };
  }
}
