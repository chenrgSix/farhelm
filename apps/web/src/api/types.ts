export type Role = "admin" | "ops" | "business" | "auditor";
export interface User {
  id: string;
  username: string;
  role: Role;
  device_scope: "*" | string[];
}
export interface Device {
  id: string;
  name: string;
  control_online: boolean;
  private_data_reachable: boolean | null;
  business_healthy: boolean | null;
  last_seen: number | null;
  revoked_at: number | null;
  agent_version: string | null;
}
export type TaskStatus =
  | "QUEUED"
  | "SENT"
  | "ACCEPTED"
  | "RUNNING"
  | "SUCCEEDED"
  | "FAILED"
  | "TIMED_OUT"
  | "CANCELLED"
  | "EXPIRED"
  | "UNKNOWN";
export interface Artifact {
  sha256: string;
  size: number;
}
export interface TaskResult {
  status: TaskStatus;
  exit_code: number | null;
  reason: string | null;
  audit_complete: boolean;
  stdout: Artifact | null;
  stderr: Artifact | null;
  started_at: number | null;
  finished_at: number;
  cleanup: "process_group" | "unconfirmed" | "not_started";
}
export interface TaskEvent {
  event_id: string;
  task_id: string;
  seq: number;
  kind: string;
  at: number;
  payload: unknown;
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
  status: TaskStatus;
  result: TaskResult | null;
  events?: TaskEvent[];
  cancel_requested?: boolean | number;
}
export interface AuditEntry {
  id: string | number;
  at: number;
  actor_id: string | null;
  device_id: string | null;
  task_id: string | null;
  action: string;
  detail?: unknown;
  [key: string]: unknown;
}
export interface CommandRequest {
  v: 1;
  device_id: string;
  argv: string[];
  cwd: string;
  timeout_ms: number;
  max_output_bytes: number;
  ttl_seconds: number;
}
export interface CommandResponse {
  task_id: string;
  status: TaskStatus;
}
