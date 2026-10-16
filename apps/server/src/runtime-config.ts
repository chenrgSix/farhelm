import { resolve } from "node:path";
import type { ServerConfig } from "./types.js";
import { deployment } from "./deployment.js";

export function runtimeConfig(env: NodeJS.ProcessEnv = process.env) {
  const mode = env.FLEET_MODE ?? "full";
  if (mode !== "full" && mode !== "ssh-only")
    throw new Error("FLEET_MODE must be full or ssh-only");
  if (
    env.FLEET_WEB_ENABLED !== undefined &&
    !["0", "1"].includes(env.FLEET_WEB_ENABLED)
  )
    throw new Error("FLEET_WEB_ENABLED must be 0 or 1");
  const choices = {
    mode,
    deviceAccess: env.FLEET_DEVICE_ACCESS as ServerConfig["deviceAccess"],
    webEnabled:
      env.FLEET_WEB_ENABLED === undefined
        ? undefined
        : env.FLEET_WEB_ENABLED === "1",
    webProtocol: env.FLEET_WEB_PROTOCOL as ServerConfig["webProtocol"],
  } satisfies Partial<ServerConfig>;
  const {
    deviceAccess,
    webEnabled,
    webProtocol,
    agentEnabled,
    localAdmin,
    tls,
  } = deployment(choices);
  const host = env.FLEET_HOST ?? "127.0.0.1";
  const portNumber = (value: string, name: string) => {
    const n = Number(value);
    if (!Number.isInteger(n) || n < 1 || n > 65535)
      throw new Error(`Invalid ${name}`);
    return n;
  };
  const port = localAdmin
    ? undefined
    : portNumber(env.FLEET_PORT ?? (tls ? "8443" : "8080"), "FLEET_PORT");
  const sshValue = env.FLEET_SSH_PORT ?? (agentEnabled ? "0" : "2222");
  const sshPort =
    sshValue === "0" && !localAdmin
      ? undefined
      : portNumber(
          sshValue,
          "FLEET_SSH_PORT (required when web and Agent access are disabled)",
        );
  const sshHost = env.FLEET_SSH_HOST ?? host;
  const testMode = env.FLEET_TEST_MODE === "1";
  const acmeEnabled = tls && env.FLEET_ACME_ENABLED === "1";
  const loopback = (host: string) =>
    ["127.0.0.1", "::1", "localhost"].includes(host);
  if (
    testMode &&
    ((!localAdmin && !loopback(host)) ||
      (sshPort && !loopback(sshHost)) ||
      (acmeEnabled && !loopback(env.FLEET_ACME_HTTP_HOST ?? "0.0.0.0")))
  )
    throw new Error("Test mode requires loopback binding");
  if (tls && (!env.FLEET_TLS_CERT || !env.FLEET_TLS_KEY))
    throw new Error(
      "Explicit FLEET_TLS_CERT and FLEET_TLS_KEY are required for HTTPS; use FLEET_WEB_PROTOCOL=http with SSH-only device access for certificate-free web management",
    );
  const config: ServerConfig = {
    mode,
    deviceAccess,
    webEnabled,
    webProtocol,
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
    webDist: webEnabled ? env.FLEET_WEB_DIST : undefined,
    consoleOrigin: webEnabled ? env.FLEET_CONSOLE_ORIGIN : undefined,
    ...(tls
      ? {
          tlsCert: env.FLEET_TLS_CERT,
          tlsKey: env.FLEET_TLS_KEY,
          acme: acmeEnabled
            ? {
                httpHost: env.FLEET_ACME_HTTP_HOST ?? "0.0.0.0",
                httpPort: portNumber(
                  env.FLEET_ACME_HTTP_PORT ?? "80",
                  "FLEET_ACME_HTTP_PORT",
                ),
              }
            : undefined,
        }
      : {}),
    ...(agentEnabled
      ? {
          agentInstall: {
            distDir: resolve(env.FLEET_AGENT_DIST_DIR ?? "./data/agent-dist"),
            publicUrl: env.FLEET_PUBLIC_URL ?? "",
            caCert: env.FLEET_AGENT_CA_CERT ?? env.FLEET_CA_CERT,
          },
        }
      : {}),
  };
  return { config, host, port, localAdmin, tls };
}
