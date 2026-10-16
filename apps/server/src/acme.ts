import { Worker } from "node:worker_threads";
import { generateKeyPairSync } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { privateFile } from "./certificate-files.js";

export class CertificateError extends Error {
  constructor(
    public code: string,
    public retryAfter: number | null = null,
  ) {
    super(code);
  }
}
export type IssueCertificate = (input: {
  domain: string;
  email: string;
  directory: string;
  signal: AbortSignal;
  challenge: (token: string, authorization: string | null) => void;
}) => Promise<{ cert: string; key: string }>;

export function acmeIssuer(directoryUrl?: string): IssueCertificate {
  return async ({ domain, email, directory, signal, challenge }) => {
    signal.throwIfAborted();
    const path = join(directory, "account.key");
    if (!existsSync(path)) {
      const { privateKey } = generateKeyPairSync("ec", {
        namedCurve: "prime256v1",
        privateKeyEncoding: { type: "pkcs8", format: "pem" },
        publicKeyEncoding: { type: "spki", format: "pem" },
      });
      privateFile(path, privateKey);
    }
    const worker = new Worker(
      new URL(
        import.meta.url.endsWith(".ts")
          ? "./acme-worker.ts"
          : "./acme-worker.js",
        import.meta.url,
      ),
      {
        workerData: {
          domain,
          email,
          accountKey: readFileSync(path, "utf8"),
          directoryUrl,
        },
      },
    );
    await using cleanup = {
      async [Symbol.asyncDispose]() {
        await worker.terminate();
      },
    };
    return await new Promise((resolve, reject) => {
      const finish = (
        error?: Error,
        result?: { cert: string; key: string },
      ) => {
        clearTimeout(timeout);
        signal.removeEventListener("abort", abort);
        if (error) reject(error);
        else resolve(result!);
      };
      const abort = () => finish(new CertificateError("ACME_CANCELLED"));
      const timeout = setTimeout(
        () => finish(new CertificateError("ACME_TIMEOUT")),
        5 * 60_000,
      );
      signal.addEventListener("abort", abort, { once: true });
      worker.on("message", (message) => {
        if (message.type === "challenge") {
          try {
            challenge(
              message.token,
              message.action === "add" ? message.authorization : null,
            );
            worker.postMessage({ id: message.id });
          } catch {
            finish(new CertificateError("ACME_CHALLENGE_FAILED"));
          }
        } else if (message.type === "issued")
          finish(undefined, { cert: message.cert, key: message.key });
        else if (message.type === "failed")
          finish(new CertificateError(message.code, message.retryAfter));
      });
      worker.once("error", () =>
        finish(new CertificateError("ACME_REQUEST_FAILED")),
      );
      worker.once("exit", () =>
        finish(new CertificateError("ACME_REQUEST_FAILED")),
      );
    });
  };
}
