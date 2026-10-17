import {
  createServer as http,
  type IncomingMessage,
  type Server,
} from "node:http";
import {
  createServer as https,
  type ServerOptions,
  type Server as HttpsServer,
} from "node:https";
import type { Socket } from "node:net";
import type { SecureContextOptions } from "node:tls";

const webRequests = new WeakSet<IncomingMessage>();
export const isWebRequest = (request: IncomingMessage) =>
  webRequests.has(request);
export type WebBinding = {
  host: string;
  port: number;
  enabled: boolean;
  protocol: "http" | "https";
};

// Separate TCP listeners share the authenticated router and recording store.
// Closing a listening socket does not terminate established terminal upgrades.
export class WebListener {
  private current?: Server;
  private servers = new Set<Server>();
  private sockets = new Set<Socket>();
  constructor(
    private router: Server,
    private tls: () => ServerOptions,
  ) {}
  async configure(binding: WebBinding) {
    if (this.current) {
      const previous = this.current;
      this.current = undefined;
      // close() releases the listening port immediately, but its callback waits
      // for upgraded sockets. Keep those sockets alive while binding the new entry.
      previous.close();
      await new Promise<void>((resolve) => setImmediate(resolve));
    }
    if (!binding.enabled) return;
    const server = binding.protocol === "https" ? https(this.tls()) : http();
    server.on("secureConnection", (socket) => {
      if (socket.alpnProtocol === "acme-tls/1") socket.end();
    });
    server.requestTimeout = 30000;
    server.headersTimeout = 30000;
    server.keepAliveTimeout = 10000;
    server.on("request", (req, res) => {
      webRequests.add(req);
      this.router.emit("request", req, res);
    });
    server.on("upgrade", (req, socket, head) => {
      webRequests.add(req);
      this.router.emit("upgrade", req, socket, head);
    });
    server.on("connection", (socket) => {
      this.sockets.add(socket);
      socket.once("close", () => this.sockets.delete(socket));
    });
    this.servers.add(server);
    server.once("close", () => this.servers.delete(server));
    try {
      await new Promise<void>((resolve, reject) => {
        const failed = (error: Error) => reject(error);
        server.once("error", failed);
        server.listen(binding.port, binding.host, () => {
          server.off("error", failed);
          resolve();
        });
      });
      this.current = server;
    } catch (error) {
      this.servers.delete(server);
      throw error;
    }
  }
  setSecureContext(options: SecureContextOptions) {
    for (const server of this.servers)
      if ("setSecureContext" in server)
        (server as HttpsServer).setSecureContext(options);
  }
  address() {
    return this.current?.address();
  }
  async close() {
    for (const socket of this.sockets) socket.destroy();
    await Promise.all(
      [...this.servers].map(
        (server) =>
          new Promise<void>((resolve) => server.close(() => resolve())),
      ),
    );
    this.servers.clear();
    this.current = undefined;
  }
}
