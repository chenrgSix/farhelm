import type { Role, User } from "./types.js";

export const PERMISSIONS = [
  "devices.read",
  "terminal.connect",
  "tasks.read",
  "tasks.read_all",
  "tasks.execute",
  "recordings.read",
  "recordings.read_all",
  "audit.read",
  "audit.read_all",
  "health.manage",
  "network.manage",
] as const;
export type Permission = (typeof PERMISSIONS)[number];
export const READ_PERMISSIONS: Permission[] = [
  "devices.read",
  "tasks.read",
  "recordings.read",
  "audit.read",
];
export function rolePermissions(role: Role): Permission[] {
  return role === "admin"
    ? [...PERMISSIONS]
    : role === "ops"
      ? PERMISSIONS.filter((p) => !p.endsWith(".read_all"))
      : role === "auditor"
        ? [
            ...READ_PERMISSIONS,
            "recordings.read_all",
            "tasks.read_all",
            "audit.read_all",
          ]
        : [...READ_PERMISSIONS];
}
export function hasPermission(user: User, permission: Permission): boolean {
  return (user.permissions ?? rolePermissions(user.role)).includes(permission);
}

export function canReadOtherRecordings(user: User): boolean {
  return user.role === "admin" || hasPermission(user, "recordings.read_all");
}

export function canReadOtherHistory(
  user: User,
  kind: "tasks" | "audit" | "sessions",
): boolean {
  return (
    user.role === "admin" ||
    hasPermission(
      user,
      kind === "sessions"
        ? "recordings.read_all"
        : kind === "tasks"
          ? "tasks.read_all"
          : "audit.read_all",
    )
  );
}
