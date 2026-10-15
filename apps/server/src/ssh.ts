import { createHash } from "node:crypto";
import { chmodSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { createServer, type Socket, type AddressInfo } from "node:net";
import { join } from "node:path";
import ssh2 from "ssh2";
import type { ServerChannel } from "ssh2";
import type { ServerConfig, User } from "./types.js";
import type { registerTerminals, TerminalPeer } from "./terminal.js";
import { integer, str } from "./util.js";

interface Login {
  user: User;
  sessionHash: string;
  deviceId: string;
}
interface Dependencies {
  authenticate(
    username: string,
    password: string,
    target: string,
    ip: string,
  ): Login;
  release(sessionHash: string): void;
  terminals: ReturnType<typeof registerTerminals>;
}
export function createSshGateway(
  dataDir: string,
  config: NonNullable<ServerConfig["ssh"]>,
  d: Dependencies,
) {
  integer(config.port, 0, 65535);
  if (config.publicPort !== undefined) integer(config.publicPort, 1, 65535);
  if (
    config.publicHost !== undefined &&
    !/^[a-zA-Z0-9.:[\]-]+$/.test(config.publicHost)
  )
    throw new Error("Invalid FLEET_SSH_PUBLIC_HOST (use a hostname or IP)");
  const path = join(dataDir, "ssh_host_ed25519_key");
  if (!existsSync(path)) {
    let privateKey: string | undefined;
    // ssh2 1.17 keygen can strip a leading zero from the Ed25519 public key.
    // Validate before persisting, retry generation only, never replace an existing identity.
    for (let attempt = 0; attempt < 8; attempt++) {
      const candidate = ssh2.utils.generateKeyPairSync("ed25519").private;
      const parsed = ssh2.utils.parseKey(candidate);
      if (!(parsed instanceof Error) && !Array.isArray(parsed)) {
        privateKey = candidate;
        break;
      }
    }
    if (!privateKey) throw new Error("Could not generate a valid SSH host key");
    writeFileSync(path, privateKey, { mode: 0o600, flag: "wx" });
  }
  chmodSync(path, 0o600);
  const key = ssh2.utils.parseKey(readFileSync(path));
  if (key instanceof Error || Array.isArray(key))
    throw new Error("Invalid SSH host key");
  const fingerprint =
    "SHA256:" +
    createHash("sha256")
      .update(key.getPublicSSH())
      .digest("base64")
      .replace(/=+$/, "");
  const ssh = new ssh2.Server({
    hostKeys: [readFileSync(path)],
    ident: "LinuxFleet",
    banner:
      "Linux Fleet: platform-user:device-id, platform password. Interactive terminal only.\r\n",
  });
  const sockets = new Set<Socket>();
  const deadlines = new Map<Socket, ReturnType<typeof setTimeout>>();
  const byIp = new Map<string, number>();
  function deadline(socket: Socket, ms: number) {
    clearTimeout(deadlines.get(socket));
    deadlines.set(socket, setTimeout(() => socket.destroy(), ms).unref());
  }
  // Bound sockets and handshake lifetime before SSH parsing/authentication begins.
  const listener = createServer((socket) => {
    const ip = socket.remoteAddress ?? "unknown";
    socket.on("error", () => {});
    if (sockets.size >= 64 || (byIp.get(ip) ?? 0) >= 16) {
      socket.destroy();
      return;
    }
    sockets.add(socket);
    byIp.set(ip, (byIp.get(ip) ?? 0) + 1);
    socket.setKeepAlive(true, 15000);
    deadline(socket, 10000);
    socket.on("close", () => {
      sockets.delete(socket);
      clearTimeout(deadlines.get(socket));
      deadlines.delete(socket);
      const left = (byIp.get(ip) ?? 1) - 1;
      if (left) byIp.set(ip, left);
      else byIp.delete(ip);
    });
    ssh.injectSocket(socket);
  });
  // injectSocket supplies the original socket through the connection info.
  ssh.on("connection", (connection, info) => {
    const socket = [...sockets].find(
      (s) => s.remoteAddress === info.ip && s.remotePort === info.port,
    )!;
    let login: Login | undefined;
    let attempts = 0;
    let used = false;
    let handle: ReturnType<Dependencies["terminals"]["openSsh"]> | undefined;
    connection.on("error", () => socket.destroy());
    connection.on("close", () => {
      handle?.disconnect();
      if (login) d.release(login.sessionHash);
    });
    connection.on("authentication", (ctx) => {
      if (++attempts > 6 || login) {
        ctx.reject();
        socket.destroy();
        return;
      }
      if (ctx.method !== "password") {
        ctx.reject(["password"]);
        return;
      }
      try {
        const composite = str(ctx.username, 3, 257);
        const separator = composite.lastIndexOf(":");
        if (separator <= 0) throw new Error("Target required");
        login = d.authenticate(
          composite.slice(0, separator),
          ctx.password,
          composite.slice(separator + 1),
          info.ip,
        );
        deadline(socket, 30000); // Authenticated clients must open a shell promptly.
        ctx.accept();
      } catch {
        ctx.reject(["password"]);
      }
    });
    // Explicitly deny all paths that could bypass the PTY audit/authorization flow.
    connection.on("tcpip", (_accept, reject) => reject());
    connection.on("openssh.streamlocal", (_accept, reject) => reject());
    connection.on("request", (_accept, reject) => reject?.());
    connection.on("session", (accept, reject) => {
      if (!login || used) {
        reject();
        return;
      }
      used = true; // One shell per SSH connection; connect again for another shell.
      const session = accept();
      let size: { cols: number; rows: number } | undefined;
      let channel: ServerChannel | undefined;
      let ready = false,
        closed = false;
      session.on("pty", (acceptPty, rejectPty, info) => {
        if (size || channel) {
          rejectPty?.();
          return;
        }
        try {
          size = {
            cols: integer(info.cols || 80, 20, 500),
            rows: integer(info.rows || 24, 5, 200),
          };
          acceptPty?.();
        } catch {
          rejectPty?.();
        }
      });
      session.on("window-change", (acceptResize, rejectResize, info) => {
        if (!size) {
          rejectResize?.();
          return;
        }
        try {
          const next = {
            cols: integer(info.cols || 80, 20, 500),
            rows: integer(info.rows || 24, 5, 200),
          };
          // Ignore the pre-ready resize; send the latest size once Agent opens.
          size = next;
          if (ready) handle?.input("terminal.resize", next);
          acceptResize?.();
        } catch {
          rejectResize?.();
        }
      });
      session.on("env", (_accept, reject) => reject?.());
      session.on("x11", (_accept, reject) => reject?.());
      session.on("auth-agent", (_accept, reject) => reject?.());
      session.on("exec", (_accept, reject) => reject());
      session.on("subsystem", (_accept, reject) => reject());
      session.on("sftp", (_accept, reject) => reject());
      session.on("signal", (acceptSignal, rejectSignal, info) => {
        if (ready && info.name === "INT") {
          handle?.input("terminal.input", {
            data: Buffer.from([3]).toString("base64"),
          });
          acceptSignal?.();
        } else rejectSignal?.();
      });
      session.on("shell", (acceptShell, rejectShell) => {
        if (!size || channel || !login) {
          rejectShell();
          return;
        }
        channel = acceptShell();
        channel.pause(); // Input cannot reach Agent until terminal.opened is received.
        channel.on("error", () => socket.destroy());
        channel.on("close", () => {
          handle?.disconnect();
          connection.end();
        });
        channel.on("end", () => {
          handle?.disconnect();
        });
        channel.on("data", (data: Buffer) => {
          if (!ready || closed) return;
          for (let offset = 0; offset < data.length && !closed; offset += 8192)
            handle?.input("terminal.input", {
              data: data.subarray(offset, offset + 8192).toString("base64"),
            });
        });
        const peer: TerminalPeer = {
          send(type, body) {
            if (closed || !channel || channel.destroyed || !channel.writable)
              return false;
            if (type === "terminal.ready") {
              ready = true;
              if (size) handle?.input("terminal.resize", size);
              channel.resume();
            } else if (type === "terminal.output") {
              if (channel.writableLength > 262144) return false;
              channel.write(Buffer.from(body.data, "base64"));
            } else if (type === "terminal.closed") {
              closed = true;
              // This is transport completion, not a remote command exit status.
              channel.exit(
                body.reason === "SHELL_EXIT" ||
                  body.reason === "USER_DISCONNECTED"
                  ? 0
                  : 1,
              );
            }
            return true;
          },
          close() {
            closed = true;
            channel?.end();
            deadline(socket, 2000);
          },
          terminate() {
            closed = true;
            socket.destroy();
          },
        };
        try {
          deadline(socket, 3600000);
          handle = d.terminals.openSsh(
            login.user,
            login.sessionHash,
            login.deviceId,
            size.cols,
            size.rows,
            peer,
          );
        } catch (error) {
          channel.stderr.end(
            "Fleet terminal unavailable; check device status and permissions in the console.\r\n",
          );
          channel.exit(1);
          peer.close();
        }
      });
    });
  });
  return {
    async listen() {
      await new Promise<void>((resolve, reject) => {
        listener.once("error", reject);
        listener.listen(config.port, config.host, () => {
          listener.off("error", reject);
          resolve();
        });
      });
    },
    info() {
      const address = listener.address() as AddressInfo | null;
      return {
        enabled: !!address,
        host: config.publicHost ?? null,
        port: config.publicPort ?? address?.port ?? config.port,
        fingerprint,
      };
    },
    async close() {
      // net.Server.close may fire before the clients' close callbacks. Wait for
      // those callbacks too: they release auth sessions while SQLite is open.
      const closing = [...sockets].map(
        (socket) =>
          new Promise<void>((resolve) => {
            socket.once("close", () => resolve());
          }),
      );
      const stopped = new Promise<void>((resolve) =>
        listener.close(() => resolve()),
      );
      for (const socket of sockets) socket.destroy();
      await Promise.all([stopped, ...closing]);
    },
  };
}
