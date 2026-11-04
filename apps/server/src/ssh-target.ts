import { createHash, createPrivateKey } from "node:crypto";
import type { SshScriptIo } from "./script-io.js";
import { DISK_COMMAND } from "./disk-usage.js";
import { SCRIPT_OUTPUT_LIMIT } from "./device-scripts.js";
import { terminalShell, quoteShellArgument } from "./terminal-shell.js";
import ssh2, { type ClientChannel, type ConnectConfig } from "ssh2";
import { ApiError } from "./util.js";

function channelFailure(error: Error & { reason?: number }) {
  // SSH_OPEN_CONNECT_FAILED alone does not distinguish refusal from timeout.
  // OpenSSH also sends the socket error as a description. Never log that text.
  switch (error.reason) {
    case 1:
      return "SSH_FORWARD_PROHIBITED";
    case 2: {
      const detail = error.message
        .replace(/^\(SSH\) Channel open failure: /, "")
        .toLowerCase();
      if (detail === "connection refused") return "TARGET_CONNECT_REFUSED";
      if (detail === "connection timed out" || detail === "operation timed out")
        return "TARGET_CONNECT_TIMEOUT";
      return "TARGET_CONNECT_FAILED";
    }
    case 4:
      return "SSH_CHANNEL_RESOURCE_SHORTAGE";
    default:
      return "SSH_FORWARD_FAILED";
  }
}

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
  diskUsage(config: SshTargetConfig): Promise<string> {
    return new Promise((resolve, reject) => {
      const client = this.client();
      let done = false,
        mismatch = false,
        length = 0;
      const chunks: Buffer[] = [];
      const finish = (error?: string) => {
        if (done) return;
        done = true;
        clearTimeout(timer);
        this.destroy(client);
        if (error) reject(new Error(error));
        else resolve(Buffer.concat(chunks).toString("utf8"));
      };
      const timer = setTimeout(() => finish("DISK_COLLECTION_TIMEOUT"), 10000);
      client.on("error", (error: any) =>
        finish(
          mismatch
            ? "SSH_HOST_KEY_MISMATCH"
            : error.level === "client-authentication"
              ? "SSH_AUTH_FAILED"
              : "SSH_CONNECT_FAILED",
        ),
      );
      client.on("close", () => finish("SSH_CONNECT_FAILED"));
      client.on("ready", () => {
        if (done) return;
        client.exec(DISK_COMMAND, (error, stream) => {
          if (done) {
            stream?.destroy();
            return;
          }
          if (error) {
            finish("DISK_COLLECTION_FAILED");
            return;
          }
          stream.on("error", () => finish("DISK_COLLECTION_FAILED"));
          stream.on("data", (data: Buffer) => {
            length += data.length;
            if (length > 65536) {
              stream.destroy();
              finish("DISK_OUTPUT_LIMIT");
              return;
            }
            chunks.push(data);
          });
          stream.stderr.on("data", (data: Buffer) => {
            length += data.length;
            if (length > 65536) {
              stream.destroy();
              finish("DISK_OUTPUT_LIMIT");
            }
          });
          stream.on("close", (code: number | null) =>
            finish(code === 0 ? undefined : "DISK_COLLECTION_FAILED"),
          );
        });
      });
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
  // Only send script bytes after the host key, login and fresh authorization
  // have succeeded. After that point a disconnect has an unknown outcome.
  runScript(
    config: SshTargetConfig,
    script: string,
    timeoutMs: number,
    signal: AbortSignal,
    allowRoot: boolean,
    beforeSend: () => void,
    io?: SshScriptIo,
  ) {
    return new Promise<{ stdout: Buffer; stderr: Buffer; code: number }>(
      (resolve, reject) => {
        const client = this.client();
        let done = false,
          submitted = false,
          mismatch = false,
          bytes = 0;
        const stdout: Buffer[] = [],
          stderr: Buffer[] = [];
        const finish = (error?: string, code?: number) => {
          if (done) return;
          done = true;
          clearTimeout(timer);
          signal.removeEventListener("abort", abort);
          this.destroy(client);
          if (error) reject(new Error(error));
          else
            resolve({
              stdout: Buffer.concat(stdout),
              stderr: Buffer.concat(stderr),
              code: code!,
            });
        };
        const abort = () =>
          finish(submitted ? "SSH_SCRIPT_INTERRUPTED" : "SSH_SCRIPT_CANCELLED");
        const timer = setTimeout(
          () =>
            finish(submitted ? "SSH_SCRIPT_TIMEOUT" : "SSH_CONNECT_TIMEOUT"),
          timeoutMs,
        );
        signal.addEventListener("abort", abort, { once: true });
        client.on("error", (e: any) =>
          finish(
            submitted
              ? "SSH_SCRIPT_INTERRUPTED"
              : mismatch
                ? "SSH_HOST_KEY_MISMATCH"
                : e.level === "client-authentication"
                  ? "SSH_AUTH_FAILED"
                  : "SSH_CONNECT_FAILED",
          ),
        );
        client.on("close", () =>
          finish(submitted ? "SSH_SCRIPT_INTERRUPTED" : "SSH_CONNECT_FAILED"),
        );
        client.on("ready", () => {
          if (done) return;
          // In line mode authorization must precede exec: the SSH command itself contains the script.
          if (io) {
            try {
              beforeSend();
              submitted = true;
            } catch (error) {
              finish((error as Error).message);
              return;
            }
          }
          const command =
            (allowRoot
              ? ""
              : 'uid=$(/usr/bin/id -u) && [ "$uid" -gt 0 ] || exit 126; ') +
            "cd /tmp && exec /usr/bin/setpriv --no-new-privs -- /bin/sh " +
            (io ? "-c " + quoteShellArgument(script) : "-s");
          client.exec(command, (err, channel) => {
            if (done) {
              channel?.destroy();
              return;
            }
            if (err) {
              finish("SSH_SCRIPT_EXEC_DENIED");
              return;
            }
            const collect = (chunks: Buffer[], data: Buffer) => {
              bytes += data.length;
              if (bytes > SCRIPT_OUTPUT_LIMIT)
                finish("SSH_SCRIPT_OUTPUT_LIMIT");
              else if (!done) {
                chunks.push(data);
                io?.output(chunks === stdout ? "stdout" : "stderr", data);
              }
            };
            channel.on("data", (b: Buffer) => collect(stdout, b));
            channel.stderr.on("data", (b: Buffer) => collect(stderr, b));
            channel.on("error", () => finish("SSH_SCRIPT_INTERRUPTED"));
            channel.on("close", (code: number | null) =>
              typeof code === "number"
                ? finish(undefined, code)
                : finish("SSH_SCRIPT_INTERRUPTED"),
            );
            if (io) {
              io.ready((line) => {
                if (
                  done ||
                  channel.destroyed ||
                  channel.writableEnded ||
                  channel.writableLength > 8192
                )
                  throw new ApiError(409, "SCRIPT_INPUT_CLOSED");
                channel.write(line);
              });
              return;
            }
            try {
              beforeSend();
              submitted = true;
              channel.end(
                "exec /bin/sh -c " +
                  quoteShellArgument(script) +
                  " </dev/null\n",
              );
            } catch (error) {
              finish(
                submitted ? "SSH_SCRIPT_INTERRUPTED" : (error as Error).message,
              );
            }
          });
        });
        if (signal.aborted) {
          abort();
          return;
        }
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
      },
    );
  }
  forward(
    config: SshTargetConfig,
    host: string,
    port: number,
    signal: AbortSignal,
    timeoutMs = 10000,
  ): Promise<ClientChannel> {
    return new Promise((resolve, reject) => {
      const client = this.client();
      let stream: ClientChannel | undefined;
      let requested = false,
        settled = false,
        mismatch = false;
      const finish = (reason: string) => {
        clearTimeout(timer);
        signal.removeEventListener("abort", abort);
        stream?.destroy();
        this.destroy(client);
        if (!settled) {
          settled = true;
          reject(new ApiError(502, reason));
        }
      };
      const abort = () => finish("FORWARD_CANCELLED");
      const timer = setTimeout(
        () => finish(requested ? "SSH_FORWARD_TIMEOUT" : "SSH_CONNECT_TIMEOUT"),
        timeoutMs,
      );
      signal.addEventListener("abort", abort, { once: true });
      client.on("error", (error: any) =>
        finish(
          mismatch
            ? "SSH_HOST_KEY_MISMATCH"
            : error.level === "client-authentication"
              ? "SSH_AUTH_FAILED"
              : error.level === "client-timeout"
                ? "SSH_CONNECT_TIMEOUT"
                : "SSH_CONNECT_FAILED",
        ),
      );
      client.on("close", () => finish("SSH_TARGET_DISCONNECTED"));
      client.on("ready", () => {
        if (settled) return;
        requested = true;
        client.forwardOut("127.0.0.1", 0, host, port, (error, channel) => {
          if (settled) {
            channel?.destroy();
            return;
          }
          if (error) {
            finish(channelFailure(error));
            return;
          }
          stream = channel;
          stream.on("error", () => finish("SSH_TARGET_DISCONNECTED"));
          stream.once("close", () => finish("FORWARD_CLOSED"));
          clearTimeout(timer);
          settled = true;
          resolve(stream);
        });
      });
      if (signal.aborted) {
        abort();
        return;
      }
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
    commandToken?: string,
    restrictPrivilege = false,
  ): TargetTerminal {
    if (restrictPrivilege && !commandToken)
      throw new Error("SSH_PRIVILEGE_POLICY_NOT_SUPPORTED");
    const client = this.client();
    let channel: ClientChannel | undefined;
    let stopped = false,
      mismatch = false,
      exited = false,
      seq = 0;
    let policyPending = restrictPrivilege;
    let policyBytes = Buffer.alloc(0);
    const policyMarker = Buffer.from(
      `\x1b]777;farhelm;${commandToken};P;restricted\x07`,
    );
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
      const opened = (err: Error | undefined, stream: ClientChannel) => {
        if (stopped) {
          stream?.destroy();
          return;
        }
        if (err) {
          finish("SSH_PTY_FAILED");
          return;
        }
        if (!policyPending) clearTimeout(timer);
        channel = stream;
        stream.on("error", () => finish("SSH_TARGET_DISCONNECTED"));
        stream.on("exit", () => {
          exited = true;
        });
        stream.on("close", () =>
          finish(
            policyPending
              ? "SSH_PRIVILEGE_POLICY_NOT_SUPPORTED"
              : exited
                ? "SHELL_EXIT"
                : "SSH_TARGET_DISCONNECTED",
          ),
        );
        const output = (data: Buffer) => {
          if (policyPending) {
            policyBytes = Buffer.concat([policyBytes, data]);
            const index = policyBytes.indexOf(policyMarker);
            if (index < 0) {
              if (policyBytes.length > 8192)
                finish("SSH_PRIVILEGE_POLICY_NOT_SUPPORTED");
              return;
            }
            data = Buffer.concat([
              policyBytes.subarray(0, index),
              policyBytes.subarray(index + policyMarker.length),
            ]);
            policyBytes = Buffer.alloc(0);
            policyPending = false;
            clearTimeout(timer);
            receive("terminal.opened", {});
          }
          for (let offset = 0; offset < data.length && !stopped; offset += 8192)
            receive("terminal.output", {
              seq: ++seq,
              data: data.subarray(offset, offset + 8192).toString("base64"),
            });
        };
        // Register consumers before ready; the shared recorder commits before display.
        stream.on("data", output);
        stream.stderr.on("data", output);
        if (!policyPending) receive("terminal.opened", {});
      };
      if (commandToken)
        client.exec(
          terminalShell(commandToken, restrictPrivilege),
          { pty: { term: "xterm-256color", cols, rows } },
          opened,
        );
      else client.shell({ term: "xterm-256color", cols, rows }, opened);
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
