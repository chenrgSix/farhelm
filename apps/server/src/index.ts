import { buildServer } from "./server.js";
import { DeploymentController } from "./deployment-settings.js";
const deployment = new DeploymentController(process.env, buildServer);
await deployment.start();
let stopping = false;
for (const signal of ["SIGINT", "SIGTERM"] as const)
  process.on(signal, () => {
    if (stopping) return;
    stopping = true;
    void deployment.stop().then(() => process.exit(0));
  });
