import { createHash, createPrivateKey } from "node:crypto";
import ssh2, { type ClientChannel, type ConnectConfig } from "ssh2";

export type SshTargetConfig = {
  host: string;
  port: number;
  username: string;
  fingerprint: string;
} & (
  | { authMethod?: "private_key"; privateKey: string; passphrase?: string }
  | { authMethod: "password"; password: string }
);
export interface TargetTerminal {
  send(type: string, body: Record<string, any>): boolean;
  close(): void;
}
export const fingerprint = (key: Buffer) =>
  "SHA256:" +
  createHash("sha256").update(key).digest("base64").replace(/=+$/, "");

// ssh2 accepts OpenSSH/traditional PEM. Convert RSA/EC PKCS#8 in memory so
// modern OpenSSL keys (including encrypted PKCS#8) work with the same UI.
export function preparePrivateKey(privateKey: string, passphrase?: string) {
  if (
    ssh2.utils.parseKey(privateKey, passphrase) instanceof Error &&
    /-----BEGIN (?:ENCRYPTED )?PRIVATE KEY-----/.test(privateKey)
  ) {
    const key = createPrivateKey({ key: privateKey, passphrase });
    if (key.asymmetricKeyType === "rsa" || key.asymmetricKeyType === "ec") {
      return {
        privateKey: key
          .export({
            format: "pem",
            type: key.asymmetricKeyType === "rsa" ? "pkcs1" : "sec1",
          })
          .toString(),
        passphrase: undefined,
      };
    }
  }
  return { privateKey, passphrase };
}

export class SshTargets {
  private clients = new Map<
    ssh2.Client,
    { promise: Promise<void>; release(): void }
  >();
  private started = new WeakSet<ssh2.Client>();
  private closing = false;
  private client() {
    if (this.closing) throw new Error("SERVER_SHUTDOWN");
    const client = new ssh2.Client();
    let release!: () => void;
    const promise = new Promise<void>((resolve) => {
      release = () => {
        this.clients.delete(client);
        resolve();
      };
    });
    client.once("close", release);
    this.clients.set(client, { promise, release });
    return client;
  }
  private destroy(client: ssh2.Client) {
    client.destroy();
    if (!this.started.has(client)) this.clients.get(client)?.release();
  }
  private connect(client: ssh2.Client, config: ConnectConfig) {
    this.started.add(client);
    try {
      client.connect(config);
    } catch (error) {
      this.destroy(client);
      this.clients.get(client)?.release();
      throw error;
    }
  }
  private connectConfig(
    config: SshTargetConfig,
    mismatch: () => void,
  ): ConnectConfig {
    return {
      host: config.host,
      port: config.port,
      username: config.username,
      ...(config.authMethod === "password"
        ? { password: config.password }
        : preparePrivateKey(config.privateKey, config.passphrase)),
      authHandler:
        config.authMethod === "password" ? ["password"] : ["publickey"],
      readyTimeout: 8000,
      keepaliveInterval: 15000,
      keepaliveCountMax: 2,
      hostVerifier: (key: Buffer) => {
        if (fingerprint(key) === config.fingerprint) return true;
        mismatch();
        return false;
      },
    };
  }
  scan(host: string, port: number): Promise<string> {
    return new Promise((resolve, reject) => {
      const client = this.client();
      let done = false,
        observed: string | undefined;
      const finish = (value?: string) => {
        if (done) return;
        done = true;
        clearTimeout(timer);
        this.destroy(client);
        if (value) resolve(value);
        else reject(new Error("SSH_HOST_KEY_UNAVAILABLE"));
      };
      const timer = setTimeout(() => finish(), 8000);
      client.on("error", () => finish(observed));
      client.on("close", () => finish(observed));
      try {
        this.connect(client, {
          host,
          port,
          username: "farhelm-host-key-scan",
          readyTimeout: 8000,
          authHandler: () => false,
          hostVerifier: (key: Buffer) => {
            observed = fingerprint(key);
            queueMicrotask(() => finish(observed));
            return false;
          },
        });
      } catch {
        finish();
      }
    });
  }
  test(config: SshTargetConfig): Promise<string | null> {
    return new Promise((resolve) => {
      const client = this.client();
      let done = false,
        mismatch = false;
      const finish = (error: string | null) => {
        if (done) return;
        done = true;
        clearTimeout(timer);
        this.destroy(client);
        resolve(error);
      };
      const timer = setTimeout(() => finish("SSH_CONNECT_TIMEOUT"), 10000);
      client.on("ready", () => finish(null));
      client.on("error", (err: any) =>
        finish(
          mismatch
            ? "SSH_HOST_KEY_MISMATCH"
            : err.level === "client-authentication"
              ? "SSH_AUTH_FAILED"
              : "SSH_CONNECT_FAILED",
        ),
      );
      client.on("close", () => finish("SSH_CONNECT_FAILED"));
      try {
        this.connect(
          client,
          this.connectConfig(config, () => {
            mismatch = true;
          }),
        );
      } catch {
        finish("SSH_CONNECT_FAILED");
      }
    });
  }
  open(
    config: SshTargetConfig,
    cols: number,
    rows: number,
    receive: (type: string, body: Record<string, any>) => void,
  ): TargetTerminal {
    const client = this.client();
    let channel: ClientChannel | undefined;
    let stopped = false,
      mismatch = false,
      exited = false,
      seq = 0;
    const close = () => {
      if (stopped) return;
      stopped = true;
      clearTimeout(timer);
      channel?.destroy();
      this.destroy(client);
    };
    const finish = (reason: string) => {
      if (stopped) return;
      close();
      receive("terminal.closed", { reason });
    };
    const timer = setTimeout(() => finish("SSH_CONNECT_TIMEOUT"), 10000);
    client.on("error", (err: any) =>
      finish(
        mismatch
          ? "SSH_HOST_KEY_MISMATCH"
          : err.level === "client-authentication"
            ? "SSH_AUTH_FAILED"
            : "SSH_CONNECT_FAILED",
      ),
    );
    client.on("close", () => finish("SSH_TARGET_DISCONNECTED"));
    client.on("ready", () => {
      if (stopped) return;
      client.shell({ term: "xterm-256color", cols, rows }, (err, stream) => {
        if (stopped) {
          stream?.destroy();
          return;
        }
        if (err) {
          finish("SSH_PTY_FAILED");
          return;
        }
        clearTimeout(timer);
        channel = stream;
        stream.on("error", () => finish("SSH_TARGET_DISCONNECTED"));
        stream.on("exit", () => {
          exited = true;
        });
        stream.on("close", () =>
          finish(exited ? "SHELL_EXIT" : "SSH_TARGET_DISCONNECTED"),
        );
        const output = (data: Buffer) => {
          for (let offset = 0; offset < data.length && !stopped; offset += 8192)
            receive("terminal.output", {
              seq: ++seq,
              data: data.subarray(offset, offset + 8192).toString("base64"),
            });
        };
        // Register consumers before ready; the shared recorder commits before display.
        stream.on("data", output);
        stream.stderr.on("data", output);
        receive("terminal.opened", {});
      });
    });
    // Delay connect so the shared session owns its close handle before callbacks run.
    queueMicrotask(() => {
      if (stopped) return;
      try {
        this.connect(
          client,
          this.connectConfig(config, () => {
            mismatch = true;
          }),
        );
      } catch {
        finish("SSH_CONNECT_FAILED");
      }
    });
    return {
      close,
      send(type, body) {
        if (stopped || !channel) return false;
        try {
          if (type === "terminal.input") {
            const data = Buffer.from(body.data, "base64");
            if (channel.writableLength + data.length > 262144) {
              finish("SSH_TARGET_BACKPRESSURE");
              return false;
            }
            channel.write(data);
          } else if (type === "terminal.resize")
            channel.setWindow(body.rows, body.cols, 0, 0);
          return true;
        } catch {
          finish("SSH_TARGET_DISCONNECTED");
          return false;
        }
      },
    };
  }
  async close() {
    this.closing = true;
    const pending = [...this.clients.values()].map((c) => c.promise);
    for (const client of this.clients.keys()) this.destroy(client);
    await Promise.all(pending);
  }
}
