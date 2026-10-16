import { chmodSync } from "node:fs";
import { buildServer } from "./server.js";
import { prepareLocalAdmin } from "./local-admin.js";
import { runtimeConfig } from "./runtime-config.js";

const { config, host, port, sshOnly } = runtimeConfig();
// Check for a live instance before touching session recovery or the database.
const adminSocket = sshOnly
  ? await prepareLocalAdmin(config.dataDir)
  : undefined;
const server = await buildServer(config);
try {
  if (adminSocket) {
    await server.app.listen({ path: adminSocket });
    chmodSync(adminSocket, 0o600);
  } else {
    await server.app.listen({ host, port });
  }
} catch (error) {
  await server.close();
  throw error;
}
if (server.ssh) {
  const info = server.ssh.info();
  console.log(
    `Farhelm SSH listening on ${config.ssh!.host}:${config.ssh!.port}`,
  );
  console.log(`Farhelm SSH host fingerprint: ${info.fingerprint}`);
}
if (adminSocket)
  console.log(
    `Farhelm SSH-only mode; local management socket: ${adminSocket} (0600); HTTPS disabled`,
  );
else console.log(`Farhelm HTTPS listening at https://${host}:${port}`);
let stopping = false;
for (const signal of ["SIGINT", "SIGTERM"] as const)
  process.on(signal, () => {
    if (stopping) return;
    stopping = true;
    void server.close().then(() => process.exit(0));
  });
