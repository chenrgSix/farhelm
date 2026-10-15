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
  !["127.0.0.1", "::1", "localhost"].includes(host)
)
  throw new Error("Test mode requires loopback binding");
const server = await buildServer({
  dataDir: resolve(process.env.FLEET_DATA_DIR ?? "./data"),
  tlsCert,
  tlsKey,
  adminUsername: process.env.FLEET_ADMIN_USER,
  adminPassword: process.env.FLEET_ADMIN_PASSWORD,
  testMode: process.env.FLEET_TEST_MODE === "1",
  logger: true,
  webDist: process.env.FLEET_WEB_DIST,
});
await server.app.listen({ host, port });
console.log(`Fleet HTTPS listening at https://${host}:${port}`);
for (const signal of ["SIGINT", "SIGTERM"] as const)
  process.on(signal, () => {
    void server.close().then(() => process.exit(0));
  });
