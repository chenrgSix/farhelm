import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { networkInterfaces } from "node:os";
import { isIP } from "node:net";
import { readFile, readlink } from "node:fs/promises";
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
  const locals = routes.filter(
    (r) => r && r.path_len === 0 && typeof r.ipv4 === "string",
  );
  if (
    locals.length !== 1 ||
    !interfaceAddresses.includes(locals[0].ipv4.split("/")[0])
  )
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
export interface EasyTierConfig {
  cli: string;
  rpc: string;
  container?: string;
}
export function easyTierConfig(env: NodeJS.ProcessEnv): EasyTierConfig {
  const cli = env.FLEET_EASYTIER_CLI || "easytier-cli";
  const rpc = env.FLEET_EASYTIER_RPC || "127.0.0.1:15888";
  const container = env.FLEET_EASYTIER_CONTAINER || undefined;
  // An executable path/name, never a shell command or Docker option.
  if (
    cli.length > 4096 ||
    /[\x00-\x1f\x7f]/.test(cli) ||
    !(cli.startsWith("/") || /^[a-zA-Z0-9][a-zA-Z0-9_.-]*$/.test(cli))
  )
    throw new Error("Invalid FLEET_EASYTIER_CLI");
  const endpoint = rpc.match(
    /^(\[[0-9a-fA-F:.]+\]|[a-zA-Z0-9][a-zA-Z0-9.-]*):(\d{1,5})$/,
  );
  if (
    !endpoint ||
    rpc.length > 260 ||
    Number(endpoint[2]) < 1 ||
    Number(endpoint[2]) > 65535 ||
    (endpoint[1]!.startsWith("[") && isIP(endpoint[1]!.slice(1, -1)) !== 6)
  )
    throw new Error("Invalid FLEET_EASYTIER_RPC");
  if (container && !/^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,127}$/.test(container))
    throw new Error("Invalid FLEET_EASYTIER_CONTAINER");
  return { cli, rpc, container };
}
type Run = (program: string, args: string[]) => Promise<string>;
async function runCommand(program: string, args: string[]) {
  return (
    await exec(program, args, {
      timeout: program === "docker" ? 4000 : 1500,
      killSignal: "SIGKILL",
      maxBuffer: 1048576,
    })
  ).stdout;
}
async function namespace() {
  const [boot, net] = await Promise.all([
    readFile("/proc/sys/kernel/random/boot_id", "utf8"),
    readlink("/proc/self/ns/net"),
  ]);
  return { boot: boot.trim(), net };
}
// Each observer owns its cache; changing deployment configuration cannot reuse
// another CLI, RPC endpoint or container's route table.
export function createEasyTierObserver(
  deps: {
    env?: () => NodeJS.ProcessEnv;
    run?: Run;
    platform?: string;
    interfaces?: typeof networkInterfaces;
    namespace?: typeof namespace;
    uid?: number;
    gid?: number;
  } = {},
) {
  const run = deps.run ?? runCommand;
  const platform = deps.platform ?? process.platform;
  const interfaces = deps.interfaces ?? networkInterfaces;
  const identity = deps.namespace ?? namespace;
  const uid = deps.uid ?? process.geteuid?.();
  const gid = deps.gid ?? process.getegid?.();
  let cached:
    { key: string; at: number; promise: Promise<unknown> } | undefined;
  async function routes(config: EasyTierConfig) {
    const key = JSON.stringify(config);
    if (!cached || cached.key !== key || Date.now() - cached.at > 5000) {
      const load = async () => {
        const args = ["--rpc-portal", config.rpc, "--output", "json", "route"];
        if (!config.container) return JSON.parse(await run(config.cli, args));
        if (platform !== "linux" || uid === undefined || gid === undefined)
          throw new Error("Docker network namespace cannot be verified");
        const prefix = [
          "exec",
          "--user",
          `${uid}:${gid}`,
          config.container,
          "timeout",
          "-s",
          "KILL",
          "2",
        ];
        const local = await identity();
        // A local socket may still point to a VM/remote engine. Require the same
        // kernel boot and network namespace before treating container routes as ours.
        const boot = (
          await run("docker", [
            ...prefix,
            "cat",
            "/proc/sys/kernel/random/boot_id",
          ])
        ).trim();
        const net = (
          await run("docker", [...prefix, "readlink", "/proc/self/ns/net"])
        ).trim();
        if (!local.boot || boot !== local.boot || net !== local.net)
          throw new Error(
            "EasyTier container uses a different network namespace",
          );
        // Killing docker exec alone does not stop the command inside the container.
        // Bound that command too, without requesting root or extra privileges.
        return JSON.parse(
          await run("docker", [...prefix, config.cli, ...args]),
        );
      };
      cached = { key, at: Date.now(), promise: load() };
    }
    return cached.promise;
  }
  return async (target: string): Promise<EasyTierPath> => {
    if (!isIP(target)) return result("unknown");
    let collector: string | undefined;
    try {
      const config = easyTierConfig((deps.env ?? (() => process.env))());
      collector = config.container ? "docker" : config.cli;
      const data = await routes(config);
      let iface: string | undefined;
      if (platform === "linux") {
        const rows = JSON.parse(
          await run("ip", ["-j", "route", "get", target]),
        );
        if (Array.isArray(rows) && rows.length === 1) iface = rows[0]?.dev;
      } else if (platform === "darwin") {
        const route = await run("/sbin/route", ["-n", "get", target]);
        iface = route.match(/interface:\s*(\S+)/)?.[1];
      }
      if (!iface) return result("unknown");
      return parseEasyTier(
        data,
        target,
        (interfaces()[iface] ?? []).map((a) => a.address),
      );
    } catch (error: any) {
      // A missing configured collector is different from missing routing evidence.
      return result(
        error?.code === "ENOENT" && collector && error.path === collector
          ? "not_detected"
          : "unknown",
      );
    }
  };
}
export const observeEasyTier = createEasyTierObserver();
