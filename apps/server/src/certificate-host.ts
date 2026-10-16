import { BlockList, isIP } from "node:net";

// IANA special-purpose ranges: these cannot identify a public HTTPS endpoint.
// https://www.iana.org/assignments/iana-ipv4-special-registry/
// https://www.iana.org/assignments/iana-ipv6-special-registry/
const reserved = new BlockList();
for (const [address, prefix] of [
  ["0.0.0.0", 8],
  ["10.0.0.0", 8],
  ["100.64.0.0", 10],
  ["127.0.0.0", 8],
  ["169.254.0.0", 16],
  ["172.16.0.0", 12],
  ["192.0.0.0", 24],
  ["192.0.2.0", 24],
  ["192.88.99.0", 24],
  ["192.168.0.0", 16],
  ["198.18.0.0", 15],
  ["198.51.100.0", 24],
  ["203.0.113.0", 24],
  ["224.0.0.0", 4],
  ["240.0.0.0", 4],
] as const)
  reserved.addSubnet(address, prefix, "ipv4");
for (const [address, prefix] of [
  ["2001::", 23],
  ["2001:db8::", 32],
  ["2002::", 16],
  ["3fff::", 20],
] as const)
  reserved.addSubnet(address, prefix, "ipv6");
const globalV6 = new BlockList();
globalV6.addSubnet("2000::", 3, "ipv6");
// Globally reachable exceptions within the IETF protocol-assignment blocks.
const exceptions = new BlockList();
for (const ip of ["192.0.0.9", "192.0.0.10"]) exceptions.addAddress(ip, "ipv4");
for (const ip of ["2001:1::1", "2001:1::2", "2001:1::3"])
  exceptions.addAddress(ip, "ipv6");
for (const [ip, prefix] of [
  ["2001:3::", 32],
  ["2001:4:112::", 48],
  ["2001:20::", 28],
  ["2001:30::", 28],
] as const)
  exceptions.addSubnet(ip, prefix, "ipv6");

export function normalizeIP(value: string) {
  return isIP(value) === 6
    ? new URL(`https://[${value}]`).hostname.slice(1, -1)
    : value;
}
export function isPublicIP(value: string) {
  const family = isIP(value);
  if (!family || value.includes("%")) return false;
  const type = family === 6 ? "ipv6" : "ipv4";
  return (
    exceptions.check(value, type) ||
    ((family === 4 || globalV6.check(value, type)) &&
      !reserved.check(value, type))
  );
}

export function challengeHostMatches(
  host: string | undefined,
  expected: string,
) {
  // Parse authority syntax strictly: URL alone would also accept credentials,
  // paths and non-canonical numeric IPv4 forms. IPv6 Host uses brackets.
  const match = /^(\[[0-9a-fA-F:]+\]|[a-zA-Z0-9.-]+)(?::([0-9]{1,5}))?$/.exec(
    host ?? "",
  );
  if (!match || (match[2] && Number(match[2]) > 65535)) return false;
  const name = match[1]!.replace(/^\[|\]$/g, "").toLowerCase();
  return isIP(expected)
    ? !!isIP(name) && normalizeIP(name) === expected
    : name === expected;
}
