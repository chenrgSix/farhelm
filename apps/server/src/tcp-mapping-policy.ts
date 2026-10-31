import { BlockList, isIP } from "node:net";
import { fail, integer, keys, object, str, version } from "./util.js";

export type MappingConfig = {
  name: string;
  enabled: boolean;
  listen_host: string;
  listen_port: number;
  target_host: string;
  target_port: number;
  source_cidrs: string[];
};
export function forwardDestination(host: unknown, port: unknown) {
  str(host, 1, 253);
  integer(port, 1, 65535);
  if (
    !isIP(host as string) &&
    !(host as string)
      .split(".")
      .every((label) =>
        /^[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?$/.test(label),
      )
  )
    fail(400, "INVALID_FORWARD_HOST");
}
export function sourcePolicy(values: unknown): BlockList {
  if (!Array.isArray(values) || values.length < 1 || values.length > 64)
    fail(400, "MAPPING_SOURCE_REQUIRED");
  const list = new BlockList();
  for (const value of values) {
    const text = str(value, 1, 64),
      parts = text.split("/"),
      host = parts[0]!;
    const family = isIP(host);
    if (!family || host.includes("%") || parts.length > 2)
      fail(400, "INVALID_SOURCE_CIDR");
    const kind = family === 4 ? "ipv4" : "ipv6";
    if (parts.length === 1) list.addAddress(host, kind);
    else {
      if (!/^(0|[1-9][0-9]*)$/.test(parts[1]!))
        fail(400, "INVALID_SOURCE_CIDR");
      const prefix = integer(Number(parts[1]), 0, family === 4 ? 32 : 128);
      list.addSubnet(host, prefix, kind);
    }
  }
  return list;
}
export function sourceAllowed(list: BlockList, source: string) {
  const family = isIP(source);
  return !!family && list.check(source, family === 4 ? "ipv4" : "ipv6");
}
export function mappingConfig(
  value: unknown,
  updating: boolean,
): MappingConfig {
  const b = object(value);
  version(b);
  keys(b, [
    "v",
    ...(updating ? ["revision"] : []),
    "name",
    "enabled",
    "listen_host",
    "listen_port",
    "target_host",
    "target_port",
    "source_cidrs",
  ]);
  const name = str(b.name, 1, 80).trim(),
    listen_host = str(b.listen_host, 1, 45);
  if (!name || /[\x00-\x1f\x7f]/.test(name)) fail(400, "INVALID_MAPPING_NAME");
  if (!isIP(listen_host) || listen_host.includes("%"))
    fail(400, "MAPPING_BIND_IP_REQUIRED");
  if (typeof b.enabled !== "boolean") fail(400, "INVALID_MAPPING_ENABLED");
  const listen_port = integer(b.listen_port, 1024, 65535);
  forwardDestination(b.target_host, b.target_port);
  sourcePolicy(b.source_cidrs);
  return {
    name,
    enabled: b.enabled,
    listen_host,
    listen_port,
    target_host: b.target_host,
    target_port: b.target_port,
    source_cidrs: [...new Set(b.source_cidrs as string[])],
  };
}
