import { readFileSync } from "node:fs";
import { join } from "node:path";
import http from "node:http";
import https from "node:https";
import { isIP } from "node:net";
import { checkServerIdentity } from "node:tls";
const data = process.env.FLEET_DATA_DIR ?? "/var/lib/farhelm";
async function check(options, tls) {
  if (tls) {
    const bundle = JSON.parse(
      readFileSync(join(data, "certificates/active.json"), "utf8"),
    );
    options.ca = bundle.cert;
    options.servername = isIP(bundle.domain) ? "" : bundle.domain;
    options.checkServerIdentity = (_, cert) =>
      checkServerIdentity(bundle.domain, cert);
  }
  await new Promise((resolve, reject) => {
    const req = (tls ? https : http).get(
      { path: "/healthz", timeout: 5000, ...options },
      (res) => {
        let body = "";
        res.on("data", (chunk) => {
          body += chunk;
          if (body.length > 4096)
            req.destroy(Error("Oversized health response"));
        });
        res.on("error", reject);
        res.on("end", () => {
          try {
            if (res.statusCode === 200 && JSON.parse(body).ok === true)
              resolve();
            else reject(Error("Unhealthy"));
          } catch (error) {
            reject(error);
          }
        });
      },
    );
    req.on("timeout", () => req.destroy(Error("Health check timeout")));
    req.on("error", reject);
  });
}
try {
  const { settings, listener_port, agent_listener_port } = JSON.parse(
    readFileSync(join(data, "deployment.json"), "utf8"),
  );
  const checks = [];
  if (settings.web_enabled)
    checks.push(
      check(
        {
          host: "127.0.0.1",
          port: Number(process.env.FLEET_PORT ?? listener_port ?? 8443),
        },
        settings.web_protocol === "https",
      ),
    );
  if (settings.device_access === "agent-ssh")
    checks.push(
      check(
        {
          host: "127.0.0.1",
          port: Number(
            process.env.FLEET_AGENT_PORT ?? agent_listener_port ?? 8444,
          ),
        },
        true,
      ),
    );
  if (!checks.length)
    checks.push(check({ socketPath: join(data, "admin.sock") }, false));
  await Promise.all(checks);
} catch {
  process.exitCode = 1;
}
