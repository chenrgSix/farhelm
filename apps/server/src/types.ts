export type Role = "admin" | "ops" | "business" | "auditor";
export type Scope = "*" | string[];
export interface User {
  id: string;
  username: string;
  role: Role;
  device_scope: Scope;
}
export interface Task {
  task_id: string;
  device_id: string;
  actor_id: string;
  action: "exec";
  argv: string[];
  cwd: string;
  created_at: number;
  expires_at: number;
  timeout_ms: number;
  max_output_bytes: number;
  payload_hash: string;
}
export interface TaskEvent {
  event_id: string;
  task_id: string;
  seq: number;
  kind: "accepted" | "started" | "finished";
  at: number;
  payload: Record<string, unknown>;
}
export interface ServerConfig {
  dataDir: string;
  tlsCert: string | Buffer;
  tlsKey: string | Buffer;
  adminUsername?: string;
  adminPassword?: string;
  deviceTokenTtlMs?: number;
  sessionTtlMs?: number;
  heartbeatTimeoutMs?: number;
  testMode?: boolean;
  logger?: boolean;
  webDist?: string;
  consoleOrigin?: string;
}
export const TERMINAL = new Set([
  "SUCCEEDED",
  "FAILED",
  "TIMED_OUT",
  "CANCELLED",
  "EXPIRED",
  "UNKNOWN",
]);
