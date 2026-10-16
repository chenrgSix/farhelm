import { X509Certificate, createPrivateKey, randomBytes } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
  renameSync,
  unlinkSync,
  mkdtempSync,
  rmSync,
  openSync,
  closeSync,
  fsyncSync,
  copyFileSync,
} from "node:fs";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { readTlsContext } from "../lib/tls-context.mjs";
const exec = promisify(execFile);
const DAY = 86400000;
export const LEAF_DAYS = 90,
  RENEW_BEFORE_DAYS = 30;
const constraints =
  "critical,permitted;DNS:localhost,permitted;DNS:host.docker.internal,permitted;IP:127.0.0.1/255.255.255.255,permitted;IP:::1/ffff:ffff:ffff:ffff:ffff:ffff:ffff:ffff";
const leafExtensions = `subjectAltName=DNS:localhost,DNS:host.docker.internal,IP:127.0.0.1,IP:::1\nbasicConstraints=critical,CA:FALSE\nkeyUsage=critical,digitalSignature,keyEncipherment\nextendedKeyUsage=serverAuth\nauthorityKeyIdentifier=keyid,issuer\n`;
async function openssl(args) {
  try {
    await exec("openssl", args, { timeout: 30000 });
  } catch {
    throw new Error(`OpenSSL ${args[0]} failed; existing TLS files retained`);
  }
}
function atomic(path, data) {
  const tmp = `${path}.${process.pid}.${randomBytes(4).toString("hex")}.tmp`;
  try {
    writeFileSync(tmp, data, { flag: "wx", mode: 0o600 });
    const fd = openSync(tmp, "r");
    try {
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
    renameSync(tmp, path);
  } finally {
    if (existsSync(tmp)) unlinkSync(tmp);
  }
}
async function locked(dir, operation) {
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const lock = join(dir, ".renew.lock");
  let fd;
  try {
    fd = openSync(lock, "wx", 0o600);
  } catch (error) {
    if (error.code !== "EEXIST") throw error;
    let owner;
    try {
      owner = Number(readFileSync(lock, "utf8"));
    } catch {}
    if (!Number.isInteger(owner) || owner < 1) return { status: "busy" };
    try {
      process.kill(owner, 0);
      return { status: "busy" };
    } catch (e) {
      if (e.code !== "ESRCH") return { status: "busy" };
    }
    unlinkSync(lock);
    return locked(dir, operation);
  }
  writeFileSync(fd, String(process.pid));
  closeSync(fd);
  try {
    return await operation();
  } finally {
    unlinkSync(lock);
  }
}
function caCertificate(dir, name = "ca.crt") {
  const ca = new X509Certificate(readFileSync(join(dir, name)));
  if (
    !ca.ca ||
    !ca.verify(ca.publicKey) ||
    !ca.checkPrivateKey(createPrivateKey(readFileSync(join(dir, "ca.key"))))
  )
    throw new Error("Development CA/key mismatch");
  return ca;
}
async function makeRoot(dir, out, subject) {
  await openssl([
    "req",
    "-x509",
    "-new",
    "-sha256",
    "-key",
    join(dir, "ca.key"),
    "-days",
    "3650",
    "-out",
    out,
    "-subj",
    subject,
    "-addext",
    "basicConstraints=critical,CA:TRUE,pathlen:0",
    "-addext",
    "keyUsage=critical,keyCertSign,cRLSign",
    "-addext",
    "nameConstraints=" + constraints,
  ]);
}
async function signLeaf(dir, caPath, output) {
  const temp = mkdtempSync(join(dir, ".sign-"));
  try {
    writeFileSync(join(temp, "extensions.cnf"), leafExtensions, {
      mode: 0o600,
    });
    await openssl([
      "req",
      "-new",
      "-sha256",
      "-key",
      join(dir, "server.key"),
      "-out",
      join(temp, "server.csr"),
      "-subj",
      "/CN=localhost",
    ]);
    await openssl([
      "x509",
      "-req",
      "-in",
      join(temp, "server.csr"),
      "-CA",
      caPath,
      "-CAkey",
      join(dir, "ca.key"),
      "-set_serial",
      "0x" + randomBytes(16).toString("hex"),
      "-days",
      String(LEAF_DAYS),
      "-sha256",
      "-extfile",
      join(temp, "extensions.cnf"),
      "-out",
      output,
    ]);
    readTlsContext(output, join(dir, "server.key"));
    await openssl([
      "verify",
      "-CAfile",
      caPath,
      "-verify_hostname",
      "host.docker.internal",
      output,
    ]);
  } finally {
    rmSync(temp, { recursive: true, force: true });
  }
}
function markManaged(dir, ca) {
  atomic(
    join(dir, "managed.json"),
    JSON.stringify({
      v: 1,
      ca_fingerprint256: ca.fingerprint256,
      leaf_days: LEAF_DAYS,
      renew_before_days: RENEW_BEFORE_DAYS,
    }) + "\n",
  );
}
export async function initializeTls(dir) {
  dir = resolve(dir);
  return locked(dir, async () => {
    if (
      ["ca.key", "ca.crt", "server.key", "server.crt"].some((n) =>
        existsSync(join(dir, n)),
      )
    )
      throw new Error("Refusing to overwrite existing TLS files");
    const stage = mkdtempSync(join(dir, ".init-"));
    try {
      for (const name of ["ca", "server"])
        await openssl([
          "genpkey",
          "-algorithm",
          "RSA",
          "-pkeyopt",
          "rsa_keygen_bits:2048",
          "-out",
          join(stage, name + ".key"),
        ]);
      await makeRoot(
        stage,
        join(stage, "ca.crt"),
        "/CN=Farhelm local development CA",
      );
      await signLeaf(stage, join(stage, "ca.crt"), join(stage, "server.crt"));
      for (const name of ["ca.key", "server.key", "ca.crt", "server.crt"])
        atomic(join(dir, name), readFileSync(join(stage, name)));
      markManaged(dir, caCertificate(dir));
      return { status: "initialized", directory: dir };
    } finally {
      rmSync(stage, { recursive: true, force: true });
    }
  });
}
// Explicit one-time upgrade: retain the CA public key/subject already trusted by Agents.
// Prepare first so the user can trust the durable root before activating a new leaf.
export async function prepareMigration(dir) {
  dir = resolve(dir);
  return locked(dir, async () => {
    const old = caCertificate(dir);
    if (
      ![
        "CN=Linux Fleet local development CA",
        "CN=Farhelm local development CA",
      ].includes(old.subject)
    )
      throw new Error("Not a Farhelm development CA");
    const path = join(dir, "ca-next.crt");
    if (!existsSync(path)) {
      const tmp = join(dir, "ca-next.tmp");
      try {
        await makeRoot(dir, tmp, "/" + old.subject);
        atomic(path, readFileSync(tmp));
      } finally {
        if (existsSync(tmp)) unlinkSync(tmp);
      }
    }
    const next = caCertificate(dir, "ca-next.crt");
    if (
      next.subject !== old.subject ||
      !next.publicKey.equals(old.publicKey) ||
      Date.parse(next.validTo) < Date.now() + 365 * DAY
    )
      throw new Error("Invalid prepared development CA");
    return { status: "prepared", certificate: path };
  });
}
export async function activateMigration(dir) {
  dir = resolve(dir);
  return locked(dir, async () => {
    const old = caCertificate(dir),
      next = caCertificate(dir, "ca-next.crt");
    if (
      !next.publicKey.equals(old.publicKey) ||
      next.subject !== old.subject ||
      Date.parse(next.validTo) < Date.now() + 365 * DAY
    )
      throw new Error("Migration must preserve the existing CA identity");
    const leaf = join(dir, "server-next.crt");
    try {
      await signLeaf(dir, join(dir, "ca-next.crt"), leaf);
      const backup = join(dir, "backups", String(Date.now()));
      mkdirSync(backup, { recursive: true, mode: 0o700 });
      for (const name of ["ca.crt", "server.crt"])
        copyFileSync(join(dir, name), join(backup, name));
      // Keep the inode: the current Docker Agent bind-mounts this public CA file.
      const fd = openSync(join(dir, "ca.crt"), "r+");
      try {
        const pem = readFileSync(join(dir, "ca-next.crt"));
        const { writeSync, ftruncateSync } = await import("node:fs");
        writeSync(fd, pem, 0, pem.length, 0);
        ftruncateSync(fd, pem.length);
        fsyncSync(fd);
      } finally {
        closeSync(fd);
      }
      atomic(join(dir, "server.crt"), readFileSync(leaf));
      markManaged(dir, next);
      return {
        status: "migrated",
        ca_expires: next.validTo,
        server_expires: new X509Certificate(readFileSync(leaf)).validTo,
      };
    } finally {
      if (existsSync(leaf)) unlinkSync(leaf);
    }
  });
}
export async function renewTls(dir, { force = false, now = Date.now() } = {}) {
  dir = resolve(dir);
  return locked(dir, async () => {
    if (!existsSync(join(dir, "managed.json"))) return { status: "unmanaged" };
    const config = JSON.parse(readFileSync(join(dir, "managed.json"), "utf8"));
    const ca = caCertificate(dir);
    if (config.v !== 1 || config.ca_fingerprint256 !== ca.fingerprint256)
      throw new Error("Managed CA changed; explicit trust migration required");
    if (
      Date.parse(ca.validFrom) > now ||
      Date.parse(ca.validTo) <= now + LEAF_DAYS * DAY
    )
      throw new Error(
        "Development root CA needs explicit renewal and trust migration",
      );
    const leaf = new X509Certificate(readFileSync(join(dir, "server.crt")));
    if (!force && Date.parse(leaf.validTo) > now + RENEW_BEFORE_DAYS * DAY)
      return { status: "current", expires: leaf.validTo };
    const path = join(dir, "server-renewed.crt");
    try {
      await signLeaf(dir, join(dir, "ca.crt"), path);
      atomic(
        join(dir, "server.previous.crt"),
        readFileSync(join(dir, "server.crt")),
      );
      atomic(join(dir, "server.crt"), readFileSync(path));
      return {
        status: "renewed",
        expires: new X509Certificate(readFileSync(path)).validTo,
      };
    } finally {
      if (existsSync(path)) unlinkSync(path);
    }
  });
}
if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(resolve(process.argv[1])).href
) {
  const [action, dir = ".dev/tls", flag] = process.argv.slice(2);
  const commands = {
    init: initializeTls,
    "prepare-migration": prepareMigration,
    "activate-migration": activateMigration,
    renew: (d) => renewTls(d, { force: flag === "--force" }),
  };
  if (!commands[action])
    throw new Error(
      "Usage: node scripts/dev-tls.mjs init|prepare-migration|activate-migration|renew [directory] [--force]",
    );
  console.log(JSON.stringify(await commands[action](dir)));
}
