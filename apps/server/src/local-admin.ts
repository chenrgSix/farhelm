import { createServer, type RequestListener } from "node:http";
import { connect } from "node:net";
import { chmodSync, lstatSync, mkdirSync, unlinkSync } from "node:fs";
import { join, resolve } from "node:path";

export const localAdminPath = (dataDir: string) =>
  join(resolve(dataDir), "admin.sock");

// Keep the shared management/auth routes usable locally without ever exposing HTTP TCP.
export function localAdminServer(handler: RequestListener, dataDir: string) {
  const server = createServer(handler);
  const listen = server.listen;
  server.listen = function (this: typeof server, ...args: unknown[]) {
    const options = args[0] as
      { path?: string; port?: number; fd?: number } | undefined;
    if (
      !options ||
      options.path !== localAdminPath(dataDir) ||
      options.port !== undefined ||
      options.fd !== undefined
    )
      throw new Error(
        "SSH-only management may listen only on its private Unix socket",
      );
    return Reflect.apply(listen, this, args);
  } as typeof server.listen;
  return server;
}

export async function prepareLocalAdmin(
  dataDir: string,
  filename = "admin.sock",
) {
  if (process.platform === "win32")
    throw new Error(
      "SSH-only mode requires Unix-domain sockets (Linux or macOS)",
    );
  const path = join(resolve(dataDir), filename);
  if (Buffer.byteLength(path) > 100)
    throw new Error(
      "SSH-only data directory is too long for its Unix socket path",
    );
  mkdirSync(dataDir, { recursive: true, mode: 0o700 });
  chmodSync(dataDir, 0o700);
  let before;
  try {
    before = lstatSync(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return path;
    throw error;
  }
  if (!before.isSocket() || before.uid !== process.getuid!())
    throw new Error("Refusing to replace an unexpected local management path");
  const stale = await new Promise<boolean>((resolve, reject) => {
    const socket = connect(path);
    socket.once("connect", () => {
      socket.destroy();
      resolve(false);
    });
    socket.once("error", (error: NodeJS.ErrnoException) => {
      if (error.code === "ECONNREFUSED" || error.code === "ENOENT")
        resolve(true);
      else reject(error);
    });
    socket.setTimeout(1000, () => {
      socket.destroy();
      reject(new Error("Local management socket is busy"));
    });
  });
  if (!stale)
    throw new Error("Farhelm local management socket is already in use");
  // Only remove the exact stale socket inspected above, never a replacement/symlink.
  try {
    const current = lstatSync(path);
    if (
      !current.isSocket() ||
      current.ino !== before.ino ||
      current.dev !== before.dev
    )
      throw new Error("Local management socket changed during startup");
    unlinkSync(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  return path;
}
