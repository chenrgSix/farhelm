export type Role = "admin" | "ops" | "business" | "auditor";
export interface User {
  id: string;
  username: string;
  role: Role;
  device_scope: "*" | string[];
  permissions?: Permission[];
  role_ids?: string[];
  role_names?: string[];
  group_ids?: string[];
}
export interface Device {
  ip_addresses?: string[];
  connection_kind?: "agent" | "ssh";
  device_groups?: { id: string; name: string }[];
  terminal_available?: boolean;
  terminal_backend?: "agent" | "ssh" | null;
  ssh_configured?: boolean;
  ssh_status?: "unknown" | "connected" | "failed";
  ssh_checked_at?: number | null;
  id: string;
  name: string;
  control_online: boolean;
  private_data_reachable: boolean | null;
  business_healthy: boolean | null;
  last_seen: number | null;
  revoked_at: number | null;
  agent_version: string | null;
}
export interface DeviceConnection {
  v: 1;
  device_id: string;
  kind: "agent" | "ssh";
  revision: number;
  ssh: {
    host: string;
    port: number;
    username: string;
    fingerprint: string;
  } | null;
  has_private_key: boolean;
  has_passphrase: boolean;
  has_sudo_password: boolean;
  last_checked_at: number | null;
  last_error: string | null;
}
export interface HealthCheck {
  id: string;
  name: string;
  enabled: boolean;
  interval_secs: number;
  timeout_ms: number;
  failure_threshold: number;
  probe:
    | {
        kind: "http";
        url: string;
        expected_status: number;
        body_contains: string;
      }
    | { kind: "tcp"; host: string; port: number }
    | { kind: "systemd"; unit: string };
}
export interface HealthResult {
  status: "healthy" | "unhealthy" | "unknown" | "disabled";
  last_checked_at: number | null;
  duration_ms: number | null;
  reason: string;
  consecutive_failures: number;
}
export interface HealthResponse {
  v: 1;
  revision: number;
  supported: boolean;
  device_online: boolean;
  checks: (HealthCheck & { result: HealthResult })[];
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
export interface TerminalSession {
  backend?: "agent" | "ssh";
  transport?: "web" | "ssh";
  id: string;
  device_id: string;
  actor_id: string;
  status: "OPENING" | "OPEN" | "CLOSED" | "INTERRUPTED";
  created_at: number;
  ended_at: number | null;
  reason: string | null;
  audit_complete: number;
  cols: number;
  rows: number;
}

export interface NetworkEvent {
  event_id: string;
  reason: "connection_lost" | "connection_failed" | "agent_restart";
  last_contact_at: number | null;
  detected_at: number;
  recovered_at: number;
  received_at: number;
}
export interface NetworkResponse {
  v: 1;
  device_id: string;
  device_online: boolean;
  supported: boolean;
  last_seen: number | null;
  snapshot: null | {
    observed_at: number;
    received_at: number;
    truncated: boolean;
    addresses: {
      interface: string;
      address: string;
      family: "ipv4" | "ipv6";
      up: boolean;
    }[];
  };
  events: NetworkEvent[];
  next_before: number | null;
}
export interface NetworkProbeConfig {
  revision: number;
  enabled: boolean;
  interval_secs: number;
  timeout_ms: number;
  failure_threshold: number;
  targets: string[];
}
export interface NetworkProbeReport {
  sample_id: string;
  seq: number;
  revision: number;
  observed_at: number;
  platform_connected: boolean;
  status:
    | "healthy"
    | "platform_unreachable"
    | "partial_unreachable"
    | "checking"
    | "targets_unreachable"
    | "suspected_offline"
    | "disabled";
  consecutive_failures: number;
  results: {
    target: string;
    reachable: boolean;
    reason: string;
    duration_ms: number;
  }[];
}
export interface NetworkProbeResponse {
  v: 1;
  config: NetworkProbeConfig;
  applied_revision: number | null;
  supported: boolean;
  device_online: boolean;
  result: NetworkProbeReport | null;
  result_fresh: boolean;
  events: (NetworkProbeReport & { received_at: number })[];
  next_before: number | null;
}

export type Permission =
  | "devices.read"
  | "terminal.connect"
  | "tasks.read"
  | "tasks.execute"
  | "recordings.read"
  | "audit.read"
  | "health.manage"
  | "network.manage";
export type DeviceScope = "*" | string[];
export interface ManagedUser {
  id: string;
  username: string;
  enabled: boolean;
  revision: number;
  created_at: number;
  role_ids: string[];
  group_ids: string[];
  device_scope: DeviceScope;
  effective_role: Role;
  effective_permissions: Permission[];
  effective_device_scope: DeviceScope;
  role_names: string[];
}
export interface ManagedRole {
  id: string;
  name: string;
  description: string;
  permissions: Permission[];
  builtin: boolean;
  revision: number;
  user_count: number;
  group_count: number;
}
export interface ManagedGroup {
  id: string;
  name: string;
  description: string;
  device_scope: DeviceScope;
  revision: number;
  role_ids: string[];
  member_ids: string[];
}
export interface ManagedDeviceGroup {
  id: string;
  name: string;
  description: string;
  revision: number;
  device_ids: string[];
}
export interface AccessManagement {
  v: 1;
  users: ManagedUser[];
  roles: ManagedRole[];
  groups: ManagedGroup[];
  device_groups: ManagedDeviceGroup[];
  permissions: { id: Permission; label: string; description: string }[];
}
