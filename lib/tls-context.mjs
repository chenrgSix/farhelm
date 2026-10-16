import { readFileSync } from "node:fs";
import { X509Certificate, createPrivateKey, createHash } from "node:crypto";
import { createSecureContext } from "node:tls";

export function readTlsContext(certPath, keyPath) {
  const cert = readFileSync(certPath),
    key = readFileSync(keyPath);
  const leaf = new X509Certificate(cert);
  if (
    leaf.ca ||
    Date.parse(leaf.validFrom) > Date.now() ||
    Date.parse(leaf.validTo) <= Date.now()
  )
    throw new Error(
      "TLS certificate is not a currently valid server certificate",
    );
  if (!leaf.checkPrivateKey(createPrivateKey(key)))
    throw new Error("TLS certificate/key mismatch");
  const options = { cert, key, minVersion: "TLSv1.2" };
  createSecureContext(options);
  return {
    options,
    fingerprint: createHash("sha256").update(cert).update(key).digest("hex"),
  };
}

// setSecureContext changes new handshakes only; existing HTTPS/WSS sessions stay open.
export function watchTlsContext(
  server,
  { certPath, keyPath, intervalMs = 5000, log = () => {} },
) {
  let fingerprint;
  let lastError = "";
  const check = () => {
    try {
      const next = readTlsContext(certPath, keyPath);
      if (next.fingerprint !== fingerprint) {
        server.setSecureContext(next.options);
        fingerprint = next.fingerprint;
        log("TLS certificate reloaded; existing connections preserved");
      }
      lastError = "";
      return true;
    } catch (error) {
      const message =
        error instanceof Error ? error.message : "Invalid TLS files";
      if (message !== lastError)
        log("TLS reload failed; retaining last valid certificate: " + message);
      lastError = message;
      return false;
    }
  };
  check();
  const timer = setInterval(check, intervalMs);
  timer.unref();
  return { check, close: () => clearInterval(timer) };
}
