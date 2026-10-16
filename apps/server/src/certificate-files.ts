import { X509Certificate, createPrivateKey, randomUUID } from "node:crypto";
import { createSecureContext } from "node:tls";
import {
  closeSync,
  fsyncSync,
  openSync,
  renameSync,
  writeFileSync,
  unlinkSync,
  readFileSync,
  existsSync,
} from "node:fs";
import { dirname, join } from "node:path";

export type CertificateBundle = { cert: string; key: string; domain: string };
export function privateFile(path: string, content: string) {
  const temp = `${path}.${randomUUID()}.tmp`;
  try {
    const fd = openSync(temp, "wx", 0o600);
    try {
      writeFileSync(fd, content);
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
    renameSync(temp, path);
    const directory = openSync(dirname(path), "r");
    try {
      fsyncSync(directory);
    } finally {
      closeSync(directory);
    }
  } finally {
    if (existsSync(temp)) unlinkSync(temp);
  }
}
export function certificateInfo(cert: string | Buffer) {
  const leaf = new X509Certificate(cert);
  const from = Date.parse(leaf.validFrom),
    to = Date.parse(leaf.validTo);
  return {
    subject: leaf.subject,
    issuer: leaf.issuer,
    domains: leaf.subjectAltName ?? "",
    valid_from: from,
    expires_at: to,
    fingerprint: leaf.fingerprint256,
    renew_at: Math.floor(to - Math.min(30 * 86400000, (to - from) / 3)),
  };
}
export function validateCertificate(bundle: CertificateBundle, now?: number) {
  if (
    typeof bundle?.cert !== "string" ||
    typeof bundle.key !== "string" ||
    typeof bundle.domain !== "string" ||
    bundle.cert.length > 131072 ||
    bundle.key.length > 16384
  )
    throw new Error("Invalid certificate bundle");
  const leaf = new X509Certificate(bundle.cert);
  if (
    leaf.ca ||
    (leaf.keyUsage && !leaf.keyUsage.includes("1.3.6.1.5.5.7.3.1")) ||
    !leaf.checkPrivateKey(createPrivateKey(bundle.key)) ||
    leaf.checkHost(bundle.domain, { subject: "never", wildcards: false }) !==
      bundle.domain
  )
    throw new Error("Invalid certificate identity or private key");
  const chain =
    bundle.cert.match(
      /-----BEGIN CERTIFICATE-----[\s\S]*?-----END CERTIFICATE-----/g,
    ) ?? [];
  if (chain.length < 2) throw new Error("Incomplete certificate chain");
  const certificates = chain.map((pem) => new X509Certificate(pem));
  for (let i = 0; i < certificates.length; i++) {
    const current = certificates[i]!;
    if (
      now !== undefined &&
      (Date.parse(current.validFrom) > now ||
        Date.parse(current.validTo) <= now)
    )
      throw new Error("Certificate is not currently valid");
    const issuer = certificates[i + 1];
    if (
      issuer &&
      (!issuer.ca ||
        !current.checkIssued(issuer) ||
        !current.verify(issuer.publicKey))
    )
      throw new Error("Invalid certificate chain");
  }
  createSecureContext({
    cert: bundle.cert,
    key: bundle.key,
    minVersion: "TLSv1.2",
  });
  return bundle;
}
export function managedCertificate(
  dataDir: string,
  filename = "active.json",
): CertificateBundle | undefined {
  const path = join(dataDir, "certificates", filename);
  if (!existsSync(path)) return undefined;
  // An expired certificate must not prevent HTTP-01 recovery at startup.
  // A damaged bundle fails closed instead of silently reverting the identity.
  return validateCertificate(JSON.parse(readFileSync(path, "utf8")));
}
