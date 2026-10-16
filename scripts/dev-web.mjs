import { createServer } from "../apps/web/node_modules/vite/dist/node/index.js";
import { dirname, resolve, join } from "node:path";
import { existsSync } from "node:fs";
import { renewTls } from "./dev-tls.mjs";
import { watchTlsContext } from "../lib/tls-context.mjs";
const root = resolve(import.meta.dirname, "..");
const certPath = resolve(process.env.FLEET_DEV_WEB_TLS_CERT),
  keyPath = resolve(process.env.FLEET_DEV_WEB_TLS_KEY);
const dir = dirname(certPath);
const autoRenew =
  process.env.FLEET_DEV_TLS_AUTO_RENEW !== "0" &&
  certPath === join(dir, "server.crt") &&
  keyPath === join(dir, "server.key") &&
  existsSync(join(dir, "managed.json"));
async function renew() {
  try {
    const result = await renewTls(dir);
    if (result.status === "renewed")
      console.log(
        "[TLS] Automatically renewed development server certificate until " +
          result.expires,
      );
  } catch (e) {
    console.error(
      "[TLS] Automatic renewal failed; retaining existing certificate: " +
        e.message,
    );
  }
}
if (autoRenew) await renew();
const server = await createServer({
  root: join(root, "apps/web"),
  server: {
    host: process.env.FLEET_DEV_WEB_HOST || "127.0.0.1",
    port: Number(process.env.FLEET_DEV_WEB_PORT || 5173),
    strictPort: true,
  },
});
await server.listen();
const watcher = watchTlsContext(
  {
    setSecureContext: (options) => server.httpServer.setSecureContext(options),
  },
  {
    certPath,
    keyPath,
    log: (message) => console.log("[TLS] " + message),
  },
);
const timer = autoRenew
  ? setInterval(() => void renew(), 60 * 60 * 1000)
  : undefined;
timer?.unref();
console.log(
  "[TLS] " +
    (autoRenew
      ? "Automatic renewal enabled: hourly check, renew with 30 days remaining"
      : "Custom/unmanaged certificate: hot reload enabled; automatic signing disabled"),
);
server.printUrls();
for (const signal of ["SIGTERM", "SIGINT"])
  process.on(signal, () => {
    clearInterval(timer);
    watcher.close();
    void server.close().then(() => process.exit(0));
  });
