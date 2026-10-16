import test from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import {
  Pkcs10CertificateRequest,
  SubjectAlternativeNameExtension,
} from "@peculiar/x509";
import { orderCertificate } from "../src/acme-order.js";
const require = createRequire(import.meta.url);
const crypto: typeof import("acme-client").crypto = require("acme-client/src/crypto");

function fixture(host: string, type = "ip", valid = false) {
  const calls: unknown[] = [];
  const item = {
    type: "http-01",
    token: "test-token",
    url: "https://ca/challenge",
    status: "pending",
  };
  const authz = {
    identifier: { type, value: host },
    status: valid ? "valid" : "pending",
    challenges: [item],
  };
  const client: any = {
    createOrder: async (payload: unknown) => {
      calls.push(payload);
      return {};
    },
    getAuthorizations: async () => [authz],
    getChallengeKeyAuthorization: async () => "test-token.thumbprint",
    completeChallenge: async () => {
      calls.push("complete");
    },
    waitForValidStatus: async () => {
      calls.push("valid");
    },
    finalizeOrder: async () => {
      calls.push("finalize");
      return {};
    },
    getCertificate: async () => "issued-chain",
  };
  const challenge = async (...args: unknown[]) => {
    calls.push(args);
  };
  return { calls, client, challenge, authz };
}
for (const host of ["8.8.8.8", "2606:4700:4700::1111", "fleet.example.com"]) {
  test(`ACME order and native CSR identify ${host} correctly`, async () => {
    const ip = host !== "fleet.example.com";
    const f = fixture(host, ip ? "ip" : "dns");
    const key = await crypto.createPrivateEcdsaKey();
    const [, csr] = await crypto.createCsr({ altNames: [host] }, key);
    const parsed = new Pkcs10CertificateRequest(csr);
    const names =
      parsed.getExtension<SubjectAlternativeNameExtension>("2.5.29.17")!.names
        .items;
    assert.equal(names.length, 1);
    assert.equal(names[0]!.type, ip ? "ip" : "dns");
    assert.equal(
      await orderCertificate(
        f.client,
        host,
        csr,
        { shortlived: "supported" },
        f.challenge,
      ),
      "issued-chain",
    );
    assert.deepEqual(f.calls, [
      {
        identifiers: [{ type: ip ? "ip" : "dns", value: host }],
        ...(ip ? { profile: "shortlived" } : {}),
      },
      ["add", "test-token", "test-token.thumbprint"],
      "complete",
      "valid",
      ["remove", "test-token"],
      "finalize",
    ]);
  });
}
test("missing shortlived support never falls back to a DNS or default-profile order", async () => {
  const f = fixture("8.8.8.8");
  for (const profiles of [undefined, {}, { classic: "only" }])
    await assert.rejects(
      orderCertificate(
        f.client,
        "8.8.8.8",
        Buffer.alloc(0),
        profiles,
        f.challenge,
      ),
      /ACME_PROFILE_UNSUPPORTED/,
    );
  assert.equal(f.calls.length, 0);
});
test("authorization reuse validates its identifier and skips challenge publication", async () => {
  const f = fixture("2606:4700:4700:0:0:0:0:1111", "ip", true);
  await orderCertificate(
    f.client,
    "2606:4700:4700::1111",
    Buffer.alloc(0),
    { shortlived: "" },
    f.challenge,
  );
  assert.equal(f.calls.length, 2);
  f.authz.identifier.type = "dns";
  await assert.rejects(
    orderCertificate(
      f.client,
      "2606:4700:4700::1111",
      Buffer.alloc(0),
      { shortlived: "" },
      f.challenge,
    ),
    /Unsupported ACME challenge/,
  );
});
test("a failed HTTP challenge is removed and never finalized", async () => {
  const f = fixture("8.8.8.8");
  f.client.waitForValidStatus = async () => {
    throw new Error("validation failed");
  };
  await assert.rejects(
    orderCertificate(
      f.client,
      "8.8.8.8",
      Buffer.alloc(0),
      { shortlived: "" },
      f.challenge,
    ),
    /validation failed/,
  );
  assert.deepEqual(f.calls.at(-1), ["remove", "test-token"]);
  assert.ok(!f.calls.includes("finalize"));
});

test("TLS-ALPN selects the configured challenge and cleans it after failure", async () => {
  const f = fixture("8.8.8.8");
  f.authz.challenges.push({
    ...f.authz.challenges[0]!,
    type: "tls-alpn-01",
    token: "tls-token",
  });
  f.client.waitForValidStatus = async () => {
    throw new Error("TLS validation failed");
  };
  await assert.rejects(
    orderCertificate(
      f.client,
      "8.8.8.8",
      Buffer.alloc(0),
      { shortlived: "" },
      f.challenge,
      "tls-alpn-01",
    ),
    /TLS validation failed/,
  );
  assert.deepEqual(f.calls[1], ["add", "tls-token", "test-token.thumbprint"]);
  assert.deepEqual(f.calls.at(-1), ["remove", "tls-token"]);
  assert.ok(!f.calls.includes("finalize"));
  f.authz.challenges.pop();
  await assert.rejects(
    orderCertificate(
      f.client,
      "8.8.8.8",
      Buffer.alloc(0),
      { shortlived: "" },
      f.challenge,
      "tls-alpn-01",
    ),
    /Unsupported ACME challenge/,
  );
});
