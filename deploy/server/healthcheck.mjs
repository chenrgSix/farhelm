import { readFileSync } from "node:fs";
import { join } from "node:path";
import http from "node:http";
import https from "node:https";
import { isIP } from "node:net";
import { checkServerIdentity } from "node:tls";
const data = process.env.FLEET_DATA_DIR ?? "/var/lib/farhelm";
try {
  const { settings } = JSON.parse(
    readFileSync(join(data, "deployment.json"), "utf8"),
  );
  const local = settings.device_access === "ssh-only" && !settings.web_enabled;
  const tls =
    !local &&
    (settings.device_access === "agent-ssh" ||
      settings.web_protocol === "https");
  const options = {
    path: "/healthz",
    timeout: 5000,
    ...(local
      ? { socketPath: join(data, "admin.sock") }
      : { host: "127.0.0.1", port: Number(process.env.FLEET_PORT ?? 8443) }),
  };
  if (tls) {
    const bundle = JSON.parse(
      readFileSync(join(data, "certificates/active.json"), "utf8"),
    );
    options.ca = bundle.cert;
    options.servername = isIP(bundle.domain) ? "" : bundle.domain;
    options.checkServerIdentity = (_, cert) =>
      checkServerIdentity(bundle.domain, cert);
  }
  const req = (tls ? https : http).get(options, (res) => {
    let body = "";
    res.on("data", (chunk) => {
      body += chunk;
      if (body.length > 4096) req.destroy();
    });
    res.on("end", () => {
      try {
        process.exit(
          res.statusCode === 200 && JSON.parse(body).ok === true ? 0 : 1,
        );
      } catch {
        process.exit(1);
      }
    });
  });
  req.on("timeout", () => req.destroy(Error("Health check timeout")));
  req.on("error", () => process.exit(1));
} catch {
  process.exit(1);
}
