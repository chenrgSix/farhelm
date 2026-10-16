import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { networkInterfaces } from "node:os";
import { isIP } from "node:net";
const exec = promisify(execFile);
export interface EasyTierPath {
  state: "p2p" | "relay" | "not_detected" | "unknown";
  latency_ms: number | null;
}
const result = (state: EasyTierPath["state"]): EasyTierPath => ({
  state,
  latency_ms: null,
});
// Require both the destination's actual OS route and EasyTier's local virtual IP.
// An installed binary, interface name or a private destination alone is insufficient.
export function parseEasyTier(
  routes: unknown,
  target: string,
  interfaceAddresses: string[],
): EasyTierPath {
  if (!Array.isArray(routes)) return result("unknown");
  const local = routes.find(
    (r) => r && r.path_len === 0 && typeof r.ipv4 === "string",
  );
  if (!local || !interfaceAddresses.includes(local.ipv4.split("/")[0]))
    return result("unknown");
  const matches = routes.filter(
    (r) => r && typeof r.ipv4 === "string" && r.ipv4.split("/")[0] === target,
  );
  if (matches.length !== 1) return result("unknown"); // Subnet proxies/multiple instances need more evidence.
  const row = matches[0],
    hops = row.path_len,
    latHops = row.path_len_lat_first;
  if (
    !Number.isInteger(hops) ||
    hops < 1 ||
    (latHops > 0 && (latHops === 1) !== (hops === 1))
  )
    return result("unknown");
  return {
    state: hops === 1 ? "p2p" : "relay",
    latency_ms:
      hops === 1 &&
      typeof row.next_hop_lat === "number" &&
      Number.isFinite(row.next_hop_lat) &&
      row.next_hop_lat >= 0
        ? row.next_hop_lat
        : null,
  };
}
let cached: { at: number; promise: Promise<unknown> } | undefined;
async function routes() {
  if (!cached || Date.now() - cached.at > 5000)
    cached = {
      at: Date.now(),
      promise: exec(
        "easytier-cli",
        ["--rpc-portal", "127.0.0.1:15888", "--output", "json", "route"],
        { timeout: 1500, maxBuffer: 1048576 },
      ).then((r) => JSON.parse(r.stdout)),
    };
  return cached.promise;
}
export async function observeEasyTier(target: string): Promise<EasyTierPath> {
  if (!isIP(target)) return result("unknown");
  try {
    const data = await routes();
    let iface: string | undefined;
    if (process.platform === "linux") {
      const r = await exec("ip", ["-j", "route", "get", target], {
        timeout: 1000,
        maxBuffer: 16384,
      });
      iface = JSON.parse(r.stdout)?.[0]?.dev;
    } else if (process.platform === "darwin") {
      const r = await exec("/sbin/route", ["-n", "get", target], {
        timeout: 1000,
        maxBuffer: 16384,
      });
      iface = r.stdout.match(/interface:\s*(\S+)/)?.[1];
    }
    if (!iface) return result("unknown");
    return parseEasyTier(
      data,
      target,
      (networkInterfaces()[iface] ?? []).map((a) => a.address),
    );
  } catch (error: any) {
    return result(
      error?.code === "ENOENT" && String(error?.path).includes("easytier-cli")
        ? "not_detected"
        : "unknown",
    );
  }
}
