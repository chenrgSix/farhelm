import { defineConfig } from "vitest/config";
import vue from "@vitejs/plugin-vue";

// Keep browser API requests same-origin. A trusted custom CA may be supplied to
// Node via NODE_EXTRA_CA_CERTS; TLS verification is never disabled.
const target = process.env.FLEET_DEV_API_TARGET;
if (target && !target.startsWith("https://"))
  throw new Error("FLEET_DEV_API_TARGET must use HTTPS");
export default defineConfig({
  plugins: [vue()],
  server: {
    host: "127.0.0.1",
    proxy: target
      ? { "/api": { target, changeOrigin: true, secure: true } }
      : undefined,
  },
  test: { environment: "jsdom", clearMocks: true },
});
