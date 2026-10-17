import type { ServerConfig } from "./types.js";

// Legacy mode remains a preset; each explicit setting overrides that preset.
export function deployment(
  config: Pick<
    ServerConfig,
    "mode" | "deviceAccess" | "webEnabled" | "webProtocol"
  >,
) {
  if (config.mode !== undefined && !["full", "ssh-only"].includes(config.mode))
    throw new Error("Invalid server mode");
  const deviceAccess =
    config.deviceAccess ??
    (config.mode === "ssh-only" ? "ssh-only" : "agent-ssh");
  const webEnabled = config.webEnabled ?? config.mode !== "ssh-only";
  const webProtocol = config.webProtocol ?? "https";
  if (!["agent-ssh", "ssh-only"].includes(deviceAccess))
    throw new Error("Invalid FLEET_DEVICE_ACCESS");
  if (typeof webEnabled !== "boolean")
    throw new Error("Invalid FLEET_WEB_ENABLED");
  if (!["http", "https"].includes(webProtocol))
    throw new Error("Invalid FLEET_WEB_PROTOCOL");
  const agentEnabled = deviceAccess === "agent-ssh";
  const localAdmin = !agentEnabled && !webEnabled;
  const tls = !localAdmin && (agentEnabled || webProtocol === "https");
  return {
    deviceAccess,
    webEnabled,
    webProtocol,
    agentEnabled,
    localAdmin,
    tls,
  };
}
