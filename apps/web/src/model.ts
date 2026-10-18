import type { CommandRequest, TaskStatus, User, Permission } from "./api/types";

export const terminalStates = new Set<TaskStatus>([
  "SUCCEEDED",
  "FAILED",
  "TIMED_OUT",
  "CANCELLED",
  "EXPIRED",
  "UNKNOWN",
]);
export const statusLabels: Record<TaskStatus, string> = {
  QUEUED: "等待下发",
  SENT: "已尝试下发",
  ACCEPTED: "已接收",
  RUNNING: "执行中",
  SUCCEEDED: "执行成功",
  FAILED: "执行失败",
  TIMED_OUT: "执行超时",
  CANCELLED: "已取消",
  EXPIRED: "未执行已过期",
  UNKNOWN: "结果不确定",
};
export const roleLabels = {
  admin: "管理员",
  ops: "运维人员",
  business: "普通用户",
  auditor: "审计员",
};
export function hasPermission(
  user: User | null,
  permission: Permission,
  deviceId?: string,
): boolean {
  if (!user) return false;
  const allowed = user.permissions
    ? user.permissions.includes(permission)
    : permission.endsWith(".read_all")
      ? ["admin", "auditor"].includes(user.role)
      : ["admin", "ops"].includes(user.role) ||
        [
          "devices.read",
          "tasks.read",
          "recordings.read",
          "audit.read",
        ].includes(permission);
  return (
    allowed &&
    (!deviceId ||
      user.role === "admin" ||
      user.device_scope === "*" ||
      user.device_scope.includes(deviceId))
  );
}
export function canExecute(user: User | null, deviceId?: string): boolean {
  return hasPermission(user, "tasks.execute", deviceId);
}
export function parseCommand(input: {
  device_id: string;
  argv: string;
  cwd: string;
  timeout_ms: number;
  max_output_bytes: number;
  ttl_seconds: number;
}): CommandRequest {
  let argv: unknown;
  try {
    argv = JSON.parse(input.argv);
  } catch {
    throw new Error("argv 必须是有效的 JSON 字符串数组");
  }
  if (
    !Array.isArray(argv) ||
    !argv.length ||
    argv.length > 128 ||
    argv.some(
      (value) =>
        typeof value !== "string" ||
        value.includes("\0") ||
        /[\uD800-\uDFFF]/u.test(value) ||
        value.length < 1 ||
        new TextEncoder().encode(value).length > 8192,
    ) ||
    !argv[0] ||
    argv.reduce(
      (total, value) => total + new TextEncoder().encode(value).length,
      0,
    ) > 32768
  )
    throw new Error(
      "argv 需包含 1–128 个非空字符串参数，每项最多 8192 字节，总计最多 32768 字节，程序名不能为空",
    );
  if (argv[0].includes("/") && !argv[0].startsWith("/"))
    throw new Error("程序必须是绝对路径或不含斜杠的程序名");
  if (!input.device_id) throw new Error("请选择已授权设备");
  if (
    !input.cwd.startsWith("/") ||
    input.cwd.includes("\0") ||
    /[\uD800-\uDFFF]/u.test(input.cwd) ||
    input.cwd.length > 4096
  )
    throw new Error("工作目录必须是绝对路径，最多 4096 字符");
  const numeric = [
    ["timeout_ms", 100, 3_600_000],
    ["max_output_bytes", 0, 1_048_576],
    ["ttl_seconds", 1, 86_400],
  ] as const;
  for (const [name, min, max] of numeric)
    if (
      !Number.isSafeInteger(input[name]) ||
      input[name] < min ||
      input[name] > max
    )
      throw new Error(`${name} 必须是 ${min}–${max} 之间的整数`);
  return {
    v: 1,
    device_id: input.device_id,
    argv: argv as string[],
    cwd: input.cwd,
    timeout_ms: input.timeout_ms,
    max_output_bytes: input.max_output_bytes,
    ttl_seconds: input.ttl_seconds,
  };
}
/** A retry always uses the exact immutable request and original idempotency key. */
export class CommandAttempt {
  readonly key: string;
  readonly request: CommandRequest;
  state: "pending" | "uncertain" | "confirmed" = "pending";
  taskId: string | null = null;
  constructor(request: CommandRequest, key: string = crypto.randomUUID()) {
    this.key = key;
    this.request = Object.freeze({
      ...request,
      argv: Object.freeze([...request.argv]) as unknown as string[],
    });
  }
}
export function formatTime(value: number | null | undefined): string {
  if (value == null || !Number.isFinite(value)) return "暂无记录";
  return new Intl.DateTimeFormat("zh-CN", {
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
  }).format(value);
}
export function formatBytes(value: number) {
  return value < 1024
    ? `${value} B`
    : value < 1048576
      ? `${(value / 1024).toFixed(1)} KiB`
      : `${(value / 1048576).toFixed(1)} MiB`;
}
export function outputPreview(
  bytes: Uint8Array,
  limit = 65_536,
): { text: string; truncated: boolean } {
  const text = new TextDecoder("utf-8", { fatal: false })
    .decode(bytes.subarray(0, limit))
    .replace(
      /[\u0000-\u0008\u000b-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069]/g,
      (value) => `\\u${value.charCodeAt(0).toString(16).padStart(4, "0")}`,
    );
  return { text, truncated: bytes.length > limit };
}
