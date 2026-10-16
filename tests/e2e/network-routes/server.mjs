import { buildServer } from "/workspace/apps/server/dist/server.js";
import { readFileSync, writeFileSync } from "node:fs";
const fixture = JSON.parse(readFileSync("/fixture/config.json"));
const server = await buildServer({
  dataDir: "/data",
  tlsCert: "/fixture/server.crt",
  tlsKey: "/fixture/server.key",
  adminUsername: "admin",
  adminPassword: fixture.password,
  consoleOrigin: fixture.origin,
  webDist: "/workspace/apps/web/dist",
  ssh: { host: "0.0.0.0", port: 2222 },
});
let publicRequests = 0;
const observe = (req) => {
  if (
    req.headers.host === fixture.publicHost &&
    (req.url.startsWith("/api/agent") || req.url.startsWith("/agent/"))
  )
    writeFileSync("/fixture/public-requests", String(++publicRequests));
};
server.app.server.on("request", observe);
server.app.server.on("upgrade", observe);
await server.app.listen({ host: "0.0.0.0", port: 8443 });
const stop = async () => {
  await server.close();
  process.exit(0);
};
process.on("SIGTERM", stop);
process.on("SIGINT", stop);
