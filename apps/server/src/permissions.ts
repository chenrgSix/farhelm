import type { Role, User } from "./types.js";

export const PERMISSIONS = [
  "devices.read",
  "terminal.connect",
  "tasks.read",
  "tasks.execute",
  "recordings.read",
  "audit.read",
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
  return role === "admin" || role === "ops"
    ? [...PERMISSIONS]
    : [...READ_PERMISSIONS];
}
export function hasPermission(user: User, permission: Permission): boolean {
  return (user.permissions ?? rolePermissions(user.role)).includes(permission);
}
