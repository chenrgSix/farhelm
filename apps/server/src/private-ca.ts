import "reflect-metadata";
import {
  AuthorityKeyIdentifierExtension,
  BasicConstraintsExtension,
  ExtendedKeyUsageExtension,
  KeyUsageFlags,
  KeyUsagesExtension,
  SubjectAlternativeNameExtension,
  SubjectKeyIdentifierExtension,
  X509Certificate as ParsedCertificate,
  X509CertificateGenerator,
} from "@peculiar/x509";
import { createPrivateKey, randomBytes, X509Certificate } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { isIP } from "node:net";
import { domainToASCII } from "node:url";
import type { Store } from "./store.js";
import { CertificateError } from "./acme.js";
import { certificateInfo, privateFile } from "./certificate-files.js";
import { fail, str } from "./util.js";

const DAY = 86400000;
const algorithm = { name: "ECDSA", namedCurve: "P-384", hash: "SHA-384" };
type Authority = { cert: string; key: string };
function serial() {
  const bytes = randomBytes(20);
  bytes[0] = bytes[0]! & 0x7f || 1;
  return bytes.toString("hex");
}
function pem(key: ArrayBuffer) {
  return `-----BEGIN PRIVATE KEY-----\n${Buffer.from(key)
    .toString("base64")
    .match(/.{1,64}/g)!
    .join("\n")}\n-----END PRIVATE KEY-----\n`;
}
export function privateCertificateHost(value: unknown) {
  const input = str(value, 1, 253).trim().toLowerCase();
  if (isIP(input)) {
    // URL normalizes IPv6; certificate SANs never include brackets or zones.
    return isIP(input) === 6
      ? new URL(`https://[${input}]`).hostname.slice(1, -1)
      : input;
  }
  const name = domainToASCII(input);
  if (
    !/^[\p{L}\p{N}\p{M}.-]+$/u.test(input) ||
    !name ||
    name.length > 253 ||
    !name
      .split(".")
      .every((part) => /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(part)) ||
    !/[a-z]/.test(name.split(".").at(-1)!)
  )
    fail(400, "INVALID_PRIVATE_CERTIFICATE_HOST");
  return name;
}

// A dedicated, persistent CA for this installation. Never silently rotate it:
// browsers and Agents trust the root, not an individual short-lived leaf.
export class PrivateAuthority {
  private preparing?: Promise<void>;
  private path: string;
  constructor(
    private store: Store,
    private now = Date.now,
  ) {
    this.path = join(store.dataDir, "certificates", "private-ca.json");
  }
  private expected() {
    return (
      this.store.db
        .prepare(
          "SELECT fingerprint FROM private_certificate_authority WHERE id=1",
        )
        .get() as { fingerprint: string } | undefined
    )?.fingerprint;
  }
  read(): Authority | undefined {
    const expected = this.expected();
    if (!existsSync(this.path)) {
      if (expected) throw new CertificateError("PRIVATE_CA_UNAVAILABLE");
      return undefined;
    }
    try {
      const value = JSON.parse(readFileSync(this.path, "utf8")) as Authority;
      if (
        typeof value.cert !== "string" ||
        value.cert.length > 16384 ||
        typeof value.key !== "string" ||
        value.key.length > 16384
      )
        throw Error();
      const root = new X509Certificate(value.cert);
      if (
        !root.ca ||
        !root.checkIssued(root) ||
        !root.verify(root.publicKey) ||
        !root.checkPrivateKey(createPrivateKey(value.key)) ||
        (expected && root.fingerprint256 !== expected)
      )
        throw Error();
      chmodSync(this.path, 0o600);
      return value;
    } catch {
      throw new CertificateError("PRIVATE_CA_UNAVAILABLE");
    }
  }
  info() {
    const value = this.read();
    if (!value) return null;
    const info = certificateInfo(value.cert);
    return {
      subject: info.subject,
      fingerprint: info.fingerprint,
      valid_from: info.valid_from,
      expires_at: info.expires_at,
      expired: info.expires_at <= this.now(),
      expiring: info.expires_at <= this.now() + 90 * DAY,
    };
  }
  async prepare(actor: string | null) {
    if (this.preparing) return this.preparing;
    this.preparing = this.create(actor).finally(() => {
      this.preparing = undefined;
    });
    return this.preparing;
  }
  private async create(actor: string | null) {
    let value = this.read();
    if (!value) {
      const keys = await crypto.subtle.generateKey(algorithm, true, [
        "sign",
        "verify",
      ]);
      const root = await X509CertificateGenerator.createSelfSigned({
        name: `CN=Farhelm Private CA ${randomBytes(8).toString("hex")}`,
        serialNumber: serial(),
        keys,
        signingAlgorithm: algorithm,
        notBefore: new Date(this.now() - 5 * 60000),
        notAfter: new Date(this.now() + 3650 * DAY),
        extensions: [
          new BasicConstraintsExtension(true, 0, true),
          new KeyUsagesExtension(
            KeyUsageFlags.keyCertSign | KeyUsageFlags.cRLSign,
            true,
          ),
          await SubjectKeyIdentifierExtension.create(keys.publicKey),
        ],
      });
      value = {
        cert: root.toString("pem") + "\n",
        key: pem(await crypto.subtle.exportKey("pkcs8", keys.privateKey)),
      };
      const directory = join(this.store.dataDir, "certificates");
      mkdirSync(directory, { recursive: true, mode: 0o700 });
      chmodSync(directory, 0o700);
      privateFile(this.path, JSON.stringify(value));
    }
    const fingerprint = new X509Certificate(value.cert).fingerprint256;
    this.store.transaction(() => {
      if (!this.expected()) {
        this.store.db
          .prepare(
            "INSERT INTO private_certificate_authority(id,fingerprint) VALUES(1,?)",
          )
          .run(fingerprint);
        this.store.audit("certificate.ca_created", actor, null, null, {
          fingerprint,
        });
      }
    });
  }
  async issue(domain: string, lifetime = 90 * DAY) {
    const authority = this.read();
    if (!authority) throw new CertificateError("PRIVATE_CA_NOT_PREPARED");
    const root = new ParsedCertificate(authority.cert);
    const now = this.now();
    // Leave time to replace an expiring root deliberately; never renew the root
    // behind clients' backs, nor issue a leaf that outlives its trust anchor.
    if (root.notBefore.getTime() > now || root.notAfter.getTime() - now <= DAY)
      throw new CertificateError("PRIVATE_CA_EXPIRED");
    const key = createPrivateKey(authority.key).export({
      format: "der",
      type: "pkcs8",
    });
    const signingKey = await crypto.subtle.importKey(
      "pkcs8",
      new Uint8Array(key),
      algorithm,
      false,
      ["sign"],
    );
    const keys = await crypto.subtle.generateKey(
      { name: "ECDSA", namedCurve: "P-256" },
      true,
      ["sign", "verify"],
    );
    const leaf = await X509CertificateGenerator.create({
      subject: "CN=Farhelm HTTPS",
      issuer: root.subject,
      serialNumber: serial(),
      publicKey: keys.publicKey,
      signingKey,
      signingAlgorithm: algorithm,
      notBefore: new Date(now - Math.min(5 * 60000, lifetime / 20)),
      notAfter: new Date(Math.min(now + lifetime, root.notAfter.getTime())),
      extensions: [
        new BasicConstraintsExtension(false, undefined, true),
        new KeyUsagesExtension(KeyUsageFlags.digitalSignature, true),
        new ExtendedKeyUsageExtension(["1.3.6.1.5.5.7.3.1"]),
        new SubjectAlternativeNameExtension([
          { type: isIP(domain) ? "ip" : "dns", value: domain },
        ]),
        await SubjectKeyIdentifierExtension.create(keys.publicKey),
        await AuthorityKeyIdentifierExtension.create(root.publicKey),
      ],
    });
    return {
      cert: leaf.toString("pem") + "\n" + authority.cert,
      key: pem(await crypto.subtle.exportKey("pkcs8", keys.privateKey)),
    };
  }
  async close() {
    await this.preparing;
  }
}
