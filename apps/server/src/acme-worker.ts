import { parentPort, workerData } from "node:worker_threads";
import { createRequire } from "node:module";
// Import only the pinned client's native-crypto implementation. Its legacy
// forge entry point is not loaded or used for certificate verification.
const require = createRequire(import.meta.url);
const Client: typeof import("acme-client").Client = require("acme-client/src/client");
const crypto: typeof import("acme-client").crypto = require("acme-client/src/crypto");
const axios: typeof import("acme-client").axios = require("acme-client/src/axios");

const port = parentPort!;
const { domain, email, accountKey, directoryUrl } = workerData as {
  domain: string;
  email: string;
  accountKey: string;
  directoryUrl?: string;
};
// Isolated from other HTTP clients. The parent bounds the entire job and can
// terminate it on shutdown; a CA Retry-After is persisted by the parent.
axios.defaults.timeout = 20_000;
axios.defaults.maxRedirects = 0;
axios.defaults.maxContentLength = 1048576;
axios.defaults.maxBodyLength = 1048576;
(axios.defaults as any).acmeSettings.retryMaxAttempts = 0;
let retryAfter: number | null = null;
axios.interceptors.response.use((response) => {
  const value = response.headers["retry-after"];
  if (response.status === 429 && value) {
    const at = /^\d+$/.test(String(value))
      ? Date.now() + Number(value) * 1000
      : Date.parse(String(value));
    if (Number.isFinite(at) && at > Date.now()) retryAfter = at;
  }
  return response;
});
let sequence = 0;
const acknowledgements = new Map<number, () => void>();
port.on("message", ({ id }) => {
  acknowledgements.get(id)?.();
  acknowledgements.delete(id);
});
async function challenge(
  action: "add" | "remove",
  token: string,
  authorization?: string,
) {
  const id = ++sequence;
  await new Promise<void>((resolve) => {
    acknowledgements.set(id, resolve);
    port.postMessage({ type: "challenge", id, action, token, authorization });
  });
}
try {
  const client = new Client({
    directoryUrl:
      directoryUrl ?? "https://acme-v02.api.letsencrypt.org/directory",
    accountKey,
    backoffAttempts: 12,
    backoffMin: 1000,
    backoffMax: 5000,
  });
  await client.createAccount({
    termsOfServiceAgreed: true,
    contact: [`mailto:${email}`],
  });
  await client.updateAccount({ contact: [`mailto:${email}`] });
  const key = await crypto.createPrivateEcdsaKey();
  const [, csr] = await crypto.createCsr(
    { commonName: domain, altNames: [domain] },
    key,
  );
  const cert = await client.auto({
    csr,
    email,
    termsOfServiceAgreed: true,
    challengePriority: ["http-01"],
    // The CA still verifies HTTP-01 publicly. A local self-probe would require
    // hairpin NAT and could resolve an administrator's domain to a private IP.
    skipChallengeVerification: true,
    challengeCreateFn: async (authz, item, authorization) => {
      if (
        authz.identifier.value !== domain ||
        item.type !== "http-01" ||
        !/^[A-Za-z0-9_-]{1,128}$/.test(item.token ?? "")
      )
        throw new Error("Unsupported ACME challenge");
      await challenge("add", item.token!, authorization);
    },
    challengeRemoveFn: async (_authz, item) => {
      await challenge("remove", item.token!);
    },
  });
  port.postMessage({ type: "issued", cert, key: key.toString() });
} catch (error) {
  const raw = error instanceof Error ? error.message : "";
  const code = /rateLimited|429/i.test(raw)
    ? "ACME_RATE_LIMITED"
    : /dns|NXDOMAIN|SERVFAIL/i.test(raw)
      ? "ACME_DNS_FAILED"
      : /unauthorized|connection|Invalid response|challenge/i.test(raw)
        ? "ACME_CHALLENGE_FAILED"
        : /rejectedIdentifier|invalidContact|malformed/i.test(raw)
          ? "ACME_CONFIG_REJECTED"
          : "ACME_REQUEST_FAILED";
  // Never send provider response bodies, JWS payloads, keys or challenge values
  // to API responses or logs.
  port.postMessage({ type: "failed", code, retryAfter });
} finally {
  port.close();
}
