import { request } from "node:http";
import { resolve, join } from "node:path";
const args = process.argv.slice(2);
if (args.length !== 2 || args[0] !== "--data-dir")
  throw Error(
    "Usage: node apps/server/dist/enable-web.js --data-dir <server data directory>",
  );
const socketPath = join(resolve(args[1]!), "deployment.sock");
await new Promise<void>((resolve, reject) => {
  const req = request(
    { socketPath, method: "POST", path: "/enable-web" },
    (res) => {
      let body = "";
      res.on("data", (chunk) => (body += chunk));
      res.on("end", () => {
        const state = JSON.parse(body);
        if (res.statusCode !== 200) return reject(Error(state.error));
        console.log(
          `Web management: ${state.entry_url ?? "unchanged"}. Open System Settings and confirm within 2 minutes.`,
        );
        resolve();
      });
    },
  );
  req.on("error", reject);
  req.setTimeout(5000, () => req.destroy(Error("Recovery socket timed out")));
  req.end();
});
