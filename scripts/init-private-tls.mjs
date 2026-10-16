// Fresh offline deployments: initialize the same long-lived CA used by the UI.
// This avoids trusting a temporary CA followed by a second production CA.
import { resolve, join } from "node:path";
import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { X509Certificate } from "node:crypto";
import { Store } from "../apps/server/dist/store.js";
import { PrivateAuthority } from "../apps/server/dist/private-ca.js";
import {
  privateFile,
  validateCertificate,
} from "../apps/server/dist/certificate-files.js";
if (process.argv.length !== 3)
  throw Error("Usage: node scripts/init-private-tls.mjs <FLEET_DATA_DIR>");
const dataDir = resolve(process.argv[2]);
const store = new Store(dataDir),
  authority = new PrivateAuthority(store);
try {
  await authority.prepare(null);
  const directory = join(dataDir, "bootstrap-tls");
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  const certPath = join(directory, "server.crt"),
    keyPath = join(directory, "server.key");
  if (existsSync(certPath) !== existsSync(keyPath))
    throw Error(
      "Incomplete bootstrap certificate; restore the matching files before retrying",
    );
  const ca = authority.read().cert;
  if (existsSync(certPath)) {
    const cert = readFileSync(certPath, "utf8"),
      key = readFileSync(keyPath, "utf8");
    validateCertificate({ cert, key, domain: "localhost" });
    if (!new X509Certificate(cert).verify(new X509Certificate(ca).publicKey))
      throw Error(
        "Existing bootstrap uses a different CA; refusing to overwrite",
      );
  } else {
    const bundle = await authority.issue("localhost");
    privateFile(keyPath, bundle.key);
    privateFile(certPath, bundle.cert);
  }
  privateFile(join(directory, "ca.crt"), ca);
  console.log(
    `CA certificate: ${join(directory, "ca.crt")}\nSHA-256: ${authority.info().fingerprint}\nFLEET_TLS_CERT=${certPath}\nFLEET_TLS_KEY=${keyPath}`,
  );
} finally {
  await authority.close();
  store.close();
}
