import { resolve } from "node:path";
import type { ServerConfig } from "./types.js";

export function runtimeConfig(env: NodeJS.ProcessEnv = process.env) {
  const mode = env.FLEET_MODE ?? "full";
  if (mode !== "full" && mode !== "ssh-only")
    throw new Error("FLEET_MODE must be full or ssh-only");
  const sshOnly = mode === "ssh-only";
  const host = env.FLEET_HOST ?? "127.0.0.1";
  const portNumber = (value: string, name: string) => {
    const n = Number(value);
    if (!Number.isInteger(n) || n < 1 || n > 65535)
      throw new Error(`Invalid ${name}`);
    return n;
  };
  const port = sshOnly
    ? undefined
    : portNumber(env.FLEET_PORT ?? "8443", "FLEET_PORT");
  const sshPort = sshOnly
    ? portNumber(
        env.FLEET_SSH_PORT ?? "2222",
        "FLEET_SSH_PORT (required in SSH-only mode)",
      )
    : env.FLEET_SSH_PORT && env.FLEET_SSH_PORT !== "0"
      ? portNumber(env.FLEET_SSH_PORT, "FLEET_SSH_PORT")
      : undefined;
  const sshHost = env.FLEET_SSH_HOST ?? host;
  const testMode = env.FLEET_TEST_MODE === "1";
  const acmeEnabled = !sshOnly && env.FLEET_ACME_ENABLED === "1";
  const loopback = (host: string) =>
    ["127.0.0.1", "::1", "localhost"].includes(host);
  if (
    testMode &&
    ((!sshOnly && !loopback(host)) ||
      (sshPort && !loopback(sshHost)) ||
      (acmeEnabled && !loopback(env.FLEET_ACME_HTTP_HOST ?? "0.0.0.0")))
  )
    throw new Error("Test mode requires loopback binding");
  if (!sshOnly && (!env.FLEET_TLS_CERT || !env.FLEET_TLS_KEY))
    throw new Error(
      "Explicit FLEET_TLS_CERT and FLEET_TLS_KEY are required; insecure HTTP is not supported",
    );
  const config: ServerConfig = {
    mode,
    dataDir: resolve(env.FLEET_DATA_DIR ?? "./data"),
    adminUsername: env.FLEET_ADMIN_USER,
    adminPassword: env.FLEET_ADMIN_PASSWORD,
    testMode,
    logger: true,
    ssh: sshPort
      ? {
          host: sshHost,
          port: sshPort,
          publicHost: env.FLEET_SSH_PUBLIC_HOST,
          publicPort: env.FLEET_SSH_PUBLIC_PORT
            ? portNumber(env.FLEET_SSH_PUBLIC_PORT, "FLEET_SSH_PUBLIC_PORT")
            : undefined,
        }
      : undefined,
    ...(!sshOnly
      ? {
          tlsCert: env.FLEET_TLS_CERT,
          tlsKey: env.FLEET_TLS_KEY,
          webDist: env.FLEET_WEB_DIST,
          consoleOrigin: env.FLEET_CONSOLE_ORIGIN,
          acme: acmeEnabled
            ? {
                httpHost: env.FLEET_ACME_HTTP_HOST ?? "0.0.0.0",
                httpPort: portNumber(
                  env.FLEET_ACME_HTTP_PORT ?? "80",
                  "FLEET_ACME_HTTP_PORT",
                ),
              }
            : undefined,
          agentInstall: {
            distDir: resolve(env.FLEET_AGENT_DIST_DIR ?? "./data/agent-dist"),
            publicUrl: env.FLEET_PUBLIC_URL ?? "",
            caCert: env.FLEET_AGENT_CA_CERT ?? env.FLEET_CA_CERT,
          },
        }
      : {}),
  };
  return { config, host, port, sshOnly };
}
