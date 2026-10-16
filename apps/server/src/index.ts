import { buildServer } from "./server.js";
import { resolve } from "node:path";
const host = process.env.FLEET_HOST ?? "127.0.0.1";
const port = Number(process.env.FLEET_PORT ?? 8443);
if (!Number.isInteger(port) || port < 1 || port > 65535)
  throw new Error("Invalid FLEET_PORT");
const tlsCert = process.env.FLEET_TLS_CERT,
  tlsKey = process.env.FLEET_TLS_KEY;
if (!tlsCert || !tlsKey)
  throw new Error(
    "Explicit FLEET_TLS_CERT and FLEET_TLS_KEY are required; insecure HTTP is not supported",
  );
if (
  process.env.FLEET_TEST_MODE === "1" &&
  (!["127.0.0.1", "::1", "localhost"].includes(host) ||
    (process.env.FLEET_ACME_ENABLED === "1" &&
      !["127.0.0.1", "::1", "localhost"].includes(
        process.env.FLEET_ACME_HTTP_HOST ?? "0.0.0.0",
      )) ||
    (process.env.FLEET_SSH_PORT &&
      process.env.FLEET_SSH_PORT !== "0" &&
      !["127.0.0.1", "::1", "localhost"].includes(
        process.env.FLEET_SSH_HOST ?? host,
      )))
)
  throw new Error("Test mode requires loopback binding");
if (process.env.FLEET_ACME_ENABLED === "1") {
  const challengePort = Number(process.env.FLEET_ACME_HTTP_PORT ?? 80);
  if (
    !Number.isInteger(challengePort) ||
    challengePort < 1 ||
    challengePort > 65535
  )
    throw new Error("Invalid FLEET_ACME_HTTP_PORT");
}
const server = await buildServer({
  dataDir: resolve(process.env.FLEET_DATA_DIR ?? "./data"),
  tlsCert,
  tlsKey,
  adminUsername: process.env.FLEET_ADMIN_USER,
  adminPassword: process.env.FLEET_ADMIN_PASSWORD,
  testMode: process.env.FLEET_TEST_MODE === "1",
  logger: true,
  webDist: process.env.FLEET_WEB_DIST,
  consoleOrigin: process.env.FLEET_CONSOLE_ORIGIN,
  acme:
    process.env.FLEET_ACME_ENABLED === "1"
      ? {
          httpHost: process.env.FLEET_ACME_HTTP_HOST ?? "0.0.0.0",
          httpPort: Number(process.env.FLEET_ACME_HTTP_PORT ?? 80),
        }
      : undefined,
  agentInstall: {
    distDir: resolve(process.env.FLEET_AGENT_DIST_DIR ?? "./data/agent-dist"),
    publicUrl: process.env.FLEET_PUBLIC_URL ?? "",
    caCert: process.env.FLEET_AGENT_CA_CERT ?? process.env.FLEET_CA_CERT,
  },
  ssh:
    process.env.FLEET_SSH_PORT && process.env.FLEET_SSH_PORT !== "0"
      ? {
          host: process.env.FLEET_SSH_HOST ?? host,
          port: Number(process.env.FLEET_SSH_PORT),
          publicHost: process.env.FLEET_SSH_PUBLIC_HOST,
          publicPort: process.env.FLEET_SSH_PUBLIC_PORT
            ? Number(process.env.FLEET_SSH_PUBLIC_PORT)
            : undefined,
        }
      : undefined,
});
try {
  await server.app.listen({ host, port });
} catch (error) {
  await server.close();
  throw error;
}
if (server.ssh)
  console.log(`Farhelm SSH listening on port ${process.env.FLEET_SSH_PORT}`);
console.log(`Farhelm HTTPS listening at https://${host}:${port}`);
for (const signal of ["SIGINT", "SIGTERM"] as const)
  process.on(signal, () => {
    void server.close().then(() => process.exit(0));
  });
