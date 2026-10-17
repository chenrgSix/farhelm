// Shared first-boot initialization for systemd and Docker. Existing installations
// are never reconfigured from changed environment variables on restart.
import { existsSync, mkdirSync, readFileSync, readdirSync } from "node:fs";
import { join, resolve } from "node:path";
import { randomBytes } from "node:crypto";
import { isIP } from "node:net";
import { fileURLToPath } from "node:url";
import { setTimeout as delay } from "node:timers/promises";
import { Store } from "../../apps/server/dist/store.js";
import {
  PrivateAuthority,
  privateCertificateHost,
} from "../../apps/server/dist/private-ca.js";
import { CertificateManager } from "../../apps/server/dist/certificates.js";
import {
  managedCertificate,
  privateFile,
} from "../../apps/server/dist/certificate-files.js";
import { accountPassword } from "../../apps/server/dist/util.js";
import { deployment } from "../../apps/server/dist/deployment.js";

export async function initialize(env = process.env) {
  const data = resolve(env.FLEET_DATA_DIR ?? "/var/lib/farhelm");
  const marker = join(data, "installation.json");
  let pending;
  if (existsSync(marker)) {
    const saved = JSON.parse(readFileSync(marker, "utf8"));
    if (saved.v !== 1) throw Error("Unsupported installation state");
    if (saved.complete) {
      if (!existsSync(join(data, "fleet.sqlite")))
        throw Error(
          "Installation database is missing; restore the data directory",
        );
      return saved;
    }
    pending = saved;
  } else if (
    existsSync(data) &&
    readdirSync(data).some((name) => name !== "lost+found")
  ) {
    throw Error(
      "Refusing to initialize a non-empty data directory without installation.json; use the existing deployment or restore its complete backup",
    );
  }
  // Resume the original intent even if the container environment has changed.
  const initialEnv = pending?.env ?? env;
  const host = privateCertificateHost(
    initialEnv.FARHELM_PUBLIC_HOST ?? "localhost",
  );
  const port = Number(
    initialEnv.FARHELM_PUBLIC_PORT ?? initialEnv.FLEET_PORT ?? 8443,
  );
  if (!Number.isInteger(port) || port < 1 || port > 65535)
    throw Error("Invalid public port");
  const mode = deployment({
    deviceAccess: initialEnv.FLEET_DEVICE_ACCESS ?? "agent-ssh",
    webEnabled: true,
    webProtocol: initialEnv.FLEET_WEB_PROTOCOL ?? "https",
  });
  const url = new URL(
    `${mode.tls ? "https" : "http"}://${isIP(host) === 6 ? `[${host}]` : host}:${port}`,
  ).origin;
  const credentialsPath = join(data, "bootstrap-admin.json");
  const credentials = existsSync(credentialsPath)
    ? JSON.parse(readFileSync(credentialsPath, "utf8"))
    : {
        username: env.FLEET_ADMIN_USER || "admin",
        password:
          env.FLEET_ADMIN_PASSWORD ||
          `Fh1${randomBytes(24).toString("base64url")}`,
      };
  accountPassword(credentials.password);
  if (
    typeof credentials.username !== "string" ||
    !credentials.username.trim() ||
    credentials.username.length > 128
  )
    throw Error("Invalid administrator username");
  mkdirSync(data, { recursive: true, mode: 0o700 });
  // Write the intent before creating any identity. An interrupted first boot can
  // resume with the same password and CA instead of creating new credentials.
  privateFile(
    marker,
    JSON.stringify({
      v: 1,
      complete: false,
      url,
      env: {
        FARHELM_PUBLIC_HOST: host,
        FARHELM_PUBLIC_PORT: String(port),
        FLEET_DEVICE_ACCESS: mode.deviceAccess,
        FLEET_WEB_PROTOCOL: mode.webProtocol,
      },
    }) + "\n",
  );
  if (!existsSync(credentialsPath))
    privateFile(credentialsPath, JSON.stringify(credentials, null, 2) + "\n");
  const store = new Store(data);
  let manager;
  try {
    const row = store.db.prepare("SELECT id FROM users LIMIT 1").get();
    const actor =
      row?.id ??
      store.seedUser({ ...credentials, role: "admin", deviceScope: "*" }).id;
    if (mode.tls) {
      const authority = new PrivateAuthority(store);
      await authority.prepare(actor);
      const ca = authority.read();
      privateFile(join(data, "ca.crt"), ca.cert);
      const initial = managedCertificate(data);
      const fallback = initial ?? (await authority.issue(host));
      manager = new CertificateManager({
        store,
        privateAvailable: true,
        initial,
        fallback: () => fallback.cert,
        activate: () => {},
      });
      if (!manager.current().revision)
        manager.save(
          {
            v: 1,
            revision: 0,
            mode: "private",
            domain: host,
            email: "",
            enabled: true,
            tos_agreed: false,
          },
          actor,
        );
      await manager.tick();
      for (
        let i = 0;
        i < 100 && ["pending", "issuing"].includes(manager.snapshot().status);
        i++
      )
        await delay(100);
      if (manager.snapshot().status !== "valid")
        throw Error(
          `Certificate initialization failed: ${manager.snapshot().last_error?.code ?? manager.snapshot().status}`,
        );
      store.db
        .prepare(
          "INSERT OR IGNORE INTO system_settings(id,platform_server_url,revision,updated_at,updated_by) VALUES(1,?,1,?,?)",
        )
        .run(url, Date.now(), actor);
    }
    const result = { v: 1, complete: true, url };
    privateFile(marker, JSON.stringify(result) + "\n");
    return result;
  } finally {
    await manager?.close();
    store.close();
  }
}

if (
  process.argv[1] &&
  resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  const installation = await initialize();
  console.log(
    `Farhelm initial entry: ${installation.url}; initial credentials: ${process.env.FLEET_DATA_DIR ?? "/var/lib/farhelm"}/bootstrap-admin.json (read locally; not printed in logs)`,
  );
  if (installation.url.startsWith("https:"))
    console.log(
      "Trust the CA public certificate ca.crt on the administrator computer once, or configure a public certificate in system settings.",
    );
  // The bootstrap credentials are not a continuing account-management input.
  delete process.env.FLEET_ADMIN_USER;
  delete process.env.FLEET_ADMIN_PASSWORD;
  if (!process.argv.includes("--init-only"))
    await import("../../apps/server/dist/index.js");
}
