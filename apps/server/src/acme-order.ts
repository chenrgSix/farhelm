import { isIP } from "node:net";
import type { Client } from "acme-client";
import { normalizeIP } from "./certificate-host.js";

type OrderClient = Pick<
  Client,
  | "createOrder"
  | "getAuthorizations"
  | "getChallengeKeyAuthorization"
  | "completeChallenge"
  | "waitForValidStatus"
  | "finalizeOrder"
  | "getCertificate"
>;

// The pinned client's auto() emits DNS-only orders and cannot select profiles.
// Use its public ACME primitives so IP identifiers and shortlived reach the CA.
export async function orderCertificate(
  client: OrderClient,
  host: string,
  csr: Buffer,
  profiles: unknown,
  challenge: (
    action: "add" | "remove",
    token: string,
    authorization?: string,
  ) => Promise<void>,
) {
  const ip = !!isIP(host);
  if (
    ip &&
    (!profiles ||
      typeof profiles !== "object" ||
      !Object.hasOwn(profiles, "shortlived"))
  )
    throw new Error("ACME_PROFILE_UNSUPPORTED");
  const identifier = { type: ip ? "ip" : "dns", value: host };
  const payload = {
    identifiers: [identifier],
    ...(ip ? { profile: "shortlived" } : {}),
  };
  const order = await client.createOrder(payload);
  const authorizations = await client.getAuthorizations(order);
  if (authorizations.length !== 1)
    throw new Error("Unsupported ACME challenge");
  const authz = authorizations[0]!;
  if (
    authz.identifier.type !== identifier.type ||
    authz.wildcard ||
    (ip ? normalizeIP(authz.identifier.value) : authz.identifier.value) !== host
  )
    throw new Error("Unsupported ACME challenge");
  if (authz.status !== "valid") {
    const item = authz.challenges.find((c) => c.type === "http-01");
    if (!item || !/^[A-Za-z0-9_-]{1,128}$/.test(item.token ?? ""))
      throw new Error("Unsupported ACME challenge");
    const authorization = await client.getChallengeKeyAuthorization(item);
    try {
      await challenge("add", item.token!, authorization);
      // The CA performs real HTTP-01 verification. A local probe would require
      // hairpin NAT and could incorrectly fail on an internal route.
      await client.completeChallenge(item);
      await client.waitForValidStatus(item);
    } finally {
      await challenge("remove", item.token!);
    }
  }
  const finalized = await client.finalizeOrder(order, csr);
  return client.getCertificate(finalized);
}
