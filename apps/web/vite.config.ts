import { defineConfig } from "vitest/config";
import vue from "@vitejs/plugin-vue";
import { readFileSync } from "node:fs";
import { Agent } from "node:https";
import { isIP } from "node:net";

// Keep browser API requests same-origin. A trusted custom CA may be supplied to
// Node via NODE_EXTRA_CA_CERTS; TLS verification is never disabled.
const target = process.env.FLEET_DEV_API_TARGET;
if (target && !/^https?:\/\//.test(target))
  throw new Error("FLEET_DEV_API_TARGET must use HTTP or HTTPS");
const cert = process.env.FLEET_DEV_WEB_TLS_CERT;
const key = process.env.FLEET_DEV_WEB_TLS_KEY;
if (!!cert !== !!key)
  throw new Error("Set both FLEET_DEV_WEB_TLS_CERT and FLEET_DEV_WEB_TLS_KEY");
const upstreamHost = target
  ? new URL(target).hostname.replace(/^\[|\]$/g, "")
  : "";
const proxyOptions = target
  ? {
      target,
      changeOrigin: false,
      secure: true,
      ws: true,
      // Preserve the public Host for terminal Origin validation, while checking
      // the upstream TLS certificate against its configured host, not user input.
      agent: target.startsWith("https:")
        ? new Agent({ servername: isIP(upstreamHost) ? "" : upstreamHost })
        : undefined,
    }
  : undefined;
export default defineConfig({
  plugins: [vue()],
  server: {
    host: "127.0.0.1",
    https:
      cert && key
        ? { cert: readFileSync(cert), key: readFileSync(key) }
        : undefined,
    allowedHosts: ["host.docker.internal"],
    proxy: target
      ? {
          "^/api(?:/|$)": proxyOptions!,
          "^/agent(?:/|$)": proxyOptions!,
          "^/healthz$": proxyOptions!,
        }
      : undefined,
  },
  test: { environment: "jsdom", clearMocks: true },
});
