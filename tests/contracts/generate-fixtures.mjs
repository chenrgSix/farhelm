// Intentional, deterministic public test material. Never use these keys/tokens outside tests.
import { writeFileSync } from "node:fs";
import { createHash, createPrivateKey, sign } from "node:crypto";
const root = new URL("../../contracts/v1/fixtures/", import.meta.url);
const save = (name, data) =>
  writeFileSync(new URL(name, root), JSON.stringify(data, null, 2) + "\n");
const clone = (x) => structuredClone(x);
const canonicalize = (x) =>
  x === null || typeof x !== "object"
    ? JSON.stringify(x)
    : Array.isArray(x)
      ? "[" + x.map(canonicalize).join(",") + "]"
      : "{" +
        Object.keys(x)
          .sort()
          .map((k) => JSON.stringify(k) + ":" + canonicalize(x[k]))
          .join(",") +
        "}";
const sha = (x) => createHash("sha256").update(x).digest("hex");
const manifest = [];
function fixture(name, schema, data, valid = true, reason) {
  const path = `${valid ? "valid" : "invalid"}/${name}.json`;
  save(path, data);
  manifest.push({
    path,
    schema: `${schema}.schema.json`,
    valid,
    ...(reason ? { reason } : {}),
  });
}
const seed = "9d61b19deffd5a60ba844af492ec2cc44449c5697b326919703bac031cae7f60";
const publicKey =
  "d75a980182b10ab7d54bfed3c964073a0ee172f3daa62325af021a68f707511a";
const publicKeyB64 = Buffer.from(publicKey, "hex").toString("base64");
const privateKey = createPrivateKey({
  key: Buffer.from("302e020100300506032b657004220420" + seed, "hex"),
  format: "der",
  type: "pkcs8",
});
const rfc = {
  source: "https://www.rfc-editor.org/rfc/rfc8032#section-7.1",
  label: "RFC 8032 Ed25519 TEST 1, public test key only",
  seed_hex: seed,
  public_key_hex: publicKey,
  message_hex: "",
  signature_hex:
    "e5564300c360ac729086e2cc806e828a84877f1eb8e5d974d873e065224901555fb8821590a33bacc61e39701cf9b46bd25bf5f0595bbe24655141438e7a100b",
};
save("ed25519-rfc8032.json", rfc);
const baseTask = {
  task_id: "00000000-0000-4000-8000-000000000001",
  device_id: "00000000-0000-4000-8000-000000000002",
  actor_id: "00000000-0000-4000-8000-000000000003",
  action: "exec",
  argv: ["/usr/bin/printf", "fleet: %s\\n", "你好, fleet 👋"],
  cwd: "/tmp",
  created_at: 1735689600000,
  expires_at: 1735689660000,
  timeout_ms: 5000,
  max_output_bytes: 65536,
};
const canonical = canonicalize(baseTask),
  task = { ...baseTask, payload_hash: sha(canonical) };
save("canonical-task.json", {
  description:
    "UTF-8, sorted ASCII field names, no insignificant whitespace, no payload_hash in preimage",
  task,
  canonical_utf8: canonical,
  canonical_hex: Buffer.from(canonical).toString("hex"),
  payload_hash: task.payload_hash,
});
const time = 1735689600100;
const challengeCases = [];
for (const purpose of ["enroll", "auth"]) {
  const enrollmentToken =
    purpose === "enroll" ? "public-test-enrollment-token".padEnd(43, "0") : "";
  const fields = {
    server_instance: "fleet-fixture-server",
    purpose,
    challenge_id: `00000000-0000-4000-8000-00000000000${purpose === "enroll" ? "4" : "5"}`,
    nonce: Buffer.from(Array.from({ length: 32 }, (_, i) => i)).toString(
      "base64",
    ),
    public_key: publicKeyB64,
    device_id: purpose === "auth" ? task.device_id : "",
    enrollment_token_sha256: enrollmentToken ? sha(enrollmentToken) : "",
    expires_at: 1735689660000,
  };
  const bytes = Buffer.from(
    [
      "fleet-v1",
      fields.server_instance,
      fields.purpose,
      fields.challenge_id,
      fields.nonce,
      fields.public_key,
      fields.device_id,
      fields.enrollment_token_sha256,
      String(fields.expires_at),
      "",
    ].join("\n"),
  );
  const response = {
    v: 1,
    challenge_id: fields.challenge_id,
    signing_payload: bytes.toString("base64"),
    expires_at: fields.expires_at,
  };
  const signature = sign(null, bytes, privateKey).toString("base64");
  const request = {
    v: 1,
    purpose,
    public_key: publicKeyB64,
    ...(purpose === "enroll"
      ? { enrollment_token: enrollmentToken }
      : { device_id: task.device_id }),
  };
  challengeCases.push({
    fields,
    enrollment_token: enrollmentToken,
    request,
    response,
    signing_payload_utf8: bytes.toString(),
    signing_payload_hex: bytes.toString("hex"),
    signature,
  });
  fixture(`challenge-${purpose}`, "challenge-request", request);
  fixture(`challenge-response-${purpose}`, "challenge-response", response);
}
save("challenge-signatures.json", {
  description:
    "Public RFC 8032 key signs Farhelm v1 domain-separated bytes; terminal LF and empty fields are significant",
  seed_hex: seed,
  public_key_hex: publicKey,
  cases: challengeCases,
});
const enroll = challengeCases[0],
  auth = challengeCases[1];
fixture("challenge-auth-key-recovery", "challenge-request", {
  v: 1,
  purpose: "auth",
  public_key: publicKeyB64,
});
fixture("enrollment", "enrollment", {
  v: 1,
  challenge_id: enroll.fields.challenge_id,
  signature: enroll.signature,
  name: "fixture-agent",
});
fixture("enrollment-response", "enrollment-response", {
  v: 1,
  device_id: task.device_id,
});
fixture("auth", "auth", {
  v: 1,
  challenge_id: auth.fields.challenge_id,
  signature: auth.signature,
});
fixture("auth-response", "auth-response", {
  v: 1,
  device_id: task.device_id,
  access_token: "public-test-access-token",
  expires_at: time + 300000,
});
fixture("task", "task", task);
const artifact = { sha256: sha(Buffer.alloc(0)), size: 0 };
const finished = {
  status: "SUCCEEDED",
  exit_code: 0,
  reason: null,
  audit_complete: true,
  stdout: artifact,
  stderr: artifact,
  started_at: time,
  finished_at: time + 10,
  cleanup: "process_group",
};
const unknown = {
  ...finished,
  status: "UNKNOWN",
  exit_code: null,
  reason: "RECOVERY_RUNNING",
  audit_complete: false,
  stdout: null,
  stderr: null,
  cleanup: "unconfirmed",
};
const expired = {
  ...finished,
  status: "EXPIRED",
  exit_code: null,
  reason: "TTL_EXPIRED",
  stdout: {},
  stderr: null,
  started_at: null,
  cleanup: "not_started",
};
fixture("result-succeeded", "result", finished);
fixture("result-unknown", "result", unknown);
fixture("result-no-execution", "result", expired);
const accepted = {
  event_id: "00000000-0000-4000-8000-000000000006",
  task_id: task.task_id,
  seq: 1,
  kind: "accepted",
  at: time,
  payload: {},
};
const started = {
  ...accepted,
  event_id: "00000000-0000-4000-8000-000000000007",
  seq: 2,
  kind: "started",
  at: time + 1,
};
const event = {
  ...accepted,
  event_id: "00000000-0000-4000-8000-000000000008",
  seq: 3,
  kind: "finished",
  at: time + 10,
  payload: finished,
};
fixture("event-accepted", "event", accepted);
fixture("event-started", "event", started);
fixture("event-finished", "event", event);
fixture("event-no-execution-seq2", "event", {
  ...event,
  seq: 2,
  payload: expired,
});
for (const [type, body] of Object.entries({
  "agent.hello": { agent_version: "0.1.0" },
  "agent.heartbeat": { agent_version: "0.1.0" },
  "task.assign": task,
  "task.cancel": { task_id: task.task_id },
  "task.event": event,
  "event.ack": {
    event_id: event.event_id,
    task_id: event.task_id,
    seq: event.seq,
  },
  error: { code: "EVENT_GAP" },
}))
  fixture(`envelope-${type}`, "envelope", { v: 1, type, body });
const command = {
  v: 1,
  device_id: task.device_id,
  argv: task.argv,
  cwd: task.cwd,
  timeout_ms: task.timeout_ms,
  max_output_bytes: task.max_output_bytes,
  ttl_seconds: 60,
};
fixture("command", "commands", command);
fixture("command-zero-output", "commands", { ...command, max_output_bytes: 0 });
fixture("command-response", "command-response", {
  v: 1,
  task_id: task.task_id,
  status: "QUEUED",
});
fixture("enrollment-token-minimal", "enrollment-token-request", { v: 1 });
fixture("enrollment-token-request", "enrollment-token-request", {
  v: 1,
  name: "fixture enrollment",
  ttl_seconds: 3600,
});
fixture("enrollment-token-response", "enrollment-token-response", {
  v: 1,
  enrollment_token: enroll.enrollment_token,
  expires_at: time + 3600000,
});
const user = {
  id: task.actor_id,
  username: "test-admin",
  role: "admin",
  device_scope: "*",
};
fixture("user", "user", user);
fixture("user-scoped", "user", {
  ...user,
  role: "ops",
  device_scope: [task.device_id],
});
fixture("login", "login", {
  username: "test-admin",
  password: "test-only-password",
});
fixture("login-response", "login-response", {
  access_token: "public-test-user-token",
  user,
});
fixture("me-response", "me-response", { v: 1, ...user });
fixture("me-ssh-web", "me-response", {
  v: 1,
  ...user,
  runtime: {
    device_access: "ssh-only",
    web_enabled: true,
    web_protocol: "http",
  },
});
const device = {
  id: task.device_id,
  name: "fixture-agent",
  control_online: false,
  private_data_reachable: null,
  business_healthy: null,
  last_seen: time,
  revoked_at: null,
  agent_version: "0.1.0",
};
fixture("device", "device", device);
fixture("devices-response", "devices-response", { v: 1, devices: [device] });
fixture("devices-paged", "devices-response", {
  v: 1,
  devices: [],
  page: {
    number: 1,
    limit: 50,
    total: 0,
    pages: 1,
    visible_total: 100,
    groups: [{ id: "group-1", name: "生产" }],
  },
});
const detail = {
  ...task,
  status: "SUCCEEDED",
  last_seq: 3,
  cancel_requested: false,
  result: finished,
};
fixture("task-detail", "task-detail", detail);
fixture("task-response", "task-response", { v: 1, ...detail });
fixture("tasks-response", "tasks-response", { v: 1, tasks: [detail] });
fixture("cancel-request", "cancel-request", { v: 1 });
fixture("cancel-response", "cancel-response", {
  v: 1,
  ok: true,
  status: "RUNNING",
});
fixture("revoke-request", "revoke-request", { v: 1 });
fixture("revoke-response", "revoke-response", { v: 1, ok: true });
fixture("artifact-response", "artifact-response", { v: 1, ...artifact });
function bad(name, schema, base, mutate, reason) {
  const value = clone(base);
  mutate(value);
  fixture(name, schema, value, false, reason);
}
bad(
  "task-extra-field",
  "task",
  task,
  (x) => (x.uid = 0),
  "Arbitrary execution identity is forbidden",
);
bad(
  "task-missing-field",
  "task",
  task,
  (x) => delete x.actor_id,
  "Server actor binding is required",
);
bad("task-empty-argv", "task", task, (x) => (x.argv = []), "No executable");
bad(
  "task-null-byte-argv",
  "task",
  task,
  (x) => (x.argv = ["/bin/echo", "hello\0world"]),
  "NUL cannot be an OS argument",
);
bad(
  "task-relative-cwd",
  "task",
  task,
  (x) => (x.cwd = "tmp"),
  "Working directory must be absolute",
);
bad(
  "task-unsafe-number",
  "task",
  task,
  (x) => (x.created_at = 9007199254740992),
  "JSON number precision must be shared across Rust/JS",
);
bad(
  "task-fractional-time",
  "task",
  task,
  (x) => (x.expires_at += 0.5),
  "Integer milliseconds only",
);
bad(
  "task-negative-limit",
  "task",
  task,
  (x) => (x.max_output_bytes = -1),
  "No negative limits",
);
bad(
  "task-too-large-output",
  "task",
  task,
  (x) => (x.max_output_bytes = 1048577),
  "One MiB task limit",
);
bad(
  "task-uppercase-hash",
  "task",
  task,
  (x) => (x.payload_hash = x.payload_hash.toUpperCase()),
  "Lowercase SHA256 only",
);
bad(
  "task-action-shortcut",
  "task",
  task,
  (x) => (x.action = "exec.request"),
  "Only exec action",
);
bad(
  "envelope-unknown-version",
  "envelope",
  { v: 1, type: "task.assign", body: task },
  (x) => (x.v = 2),
  "Unknown version rejected",
);
bad(
  "envelope-unknown-type",
  "envelope",
  { v: 1, type: "task.assign", body: task },
  (x) => (x.type = "exec.request"),
  "No second execution path",
);
bad(
  "envelope-extra-token",
  "envelope",
  { v: 1, type: "task.assign", body: task },
  (x) => (x.access_token = "secret"),
  "Authentication belongs in headers",
);
bad(
  "envelope-task-field",
  "envelope",
  { v: 1, type: "task.assign", body: task },
  (x) => (x.body.uid = 0),
  "Nested exact task validation",
);
bad(
  "command-spoof-actor",
  "commands",
  command,
  (x) => (x.actor_id = "attacker"),
  "Server derives actor",
);
bad(
  "command-missing-version",
  "commands",
  command,
  (x) => delete x.v,
  "HTTP mutations are explicitly versioned",
);
bad(
  "command-invalid-version",
  "commands",
  command,
  (x) => (x.v = "1"),
  "Version has integer type",
);
bad(
  "command-timeout-zero",
  "commands",
  command,
  (x) => (x.timeout_ms = 0),
  "Timeout must be 100ms or greater",
);
bad(
  "command-unknown-option",
  "commands",
  command,
  (x) => (x.shell = true),
  "No arbitrary options",
);
bad(
  "challenge-enroll-missing-token",
  "challenge-request",
  enroll.request,
  (x) => delete x.enrollment_token,
  "Enrollment requires token",
);
bad(
  "challenge-auth-token",
  "challenge-request",
  auth.request,
  (x) => (x.enrollment_token = enroll.enrollment_token),
  "Cannot cross-bind purpose fields",
);
bad(
  "challenge-enroll-device",
  "challenge-request",
  enroll.request,
  (x) => (x.device_id = task.device_id),
  "Enrollment has no preassigned device",
);
bad(
  "challenge-malformed-key",
  "challenge-request",
  auth.request,
  (x) => (x.public_key = "not-base64"),
  "Raw 32-byte Ed25519 key required",
);
bad(
  "challenge-noncanonical-key",
  "challenge-request",
  auth.request,
  (x) => (x.public_key = x.public_key.slice(0, -2) + "B="),
  "Unused base64 pad bits must be zero",
);
bad(
  "auth-short-signature",
  "auth",
  { v: 1, challenge_id: auth.fields.challenge_id, signature: auth.signature },
  (x) => (x.signature = x.signature.slice(4)),
  "64-byte Ed25519 signature required",
);
bad(
  "event-zero-sequence",
  "event",
  accepted,
  (x) => (x.seq = 0),
  "Sequence starts at one",
);
bad(
  "event-invalid-uuid",
  "event",
  accepted,
  (x) => (x.event_id = "event-1"),
  "event_id is a UUID",
);
bad(
  "event-accepted-payload",
  "event",
  accepted,
  (x) => (x.payload = { status: "RUNNING" }),
  "Accepted payload is exactly empty",
);
bad(
  "event-started-payload",
  "event",
  started,
  (x) => (x.payload = { pid: 1 }),
  "Started payload is exactly empty",
);
bad(
  "event-extra-field",
  "event",
  event,
  (x) => (x.device_id = task.device_id),
  "Device comes from authenticated connection",
);
bad(
  "result-missing-artifacts",
  "result",
  finished,
  (x) => (x.stdout = null),
  "Executed success requires output evidence",
);
bad(
  "result-unknown-complete-missing",
  "result",
  unknown,
  (x) => (x.audit_complete = true),
  "Missing crash artifacts cannot claim complete audit",
);
bad(
  "result-empty-artifact-after-start",
  "result",
  finished,
  (x) => (x.stdout = {}),
  "Empty object is for non-execution only",
);
bad(
  "result-artifact-extra",
  "result",
  finished,
  (x) => (x.stdout.path = "/tmp/out"),
  "Only owner-bound hash/size references",
);
bad(
  "result-not-started-timestamp",
  "result",
  expired,
  (x) => (x.started_at = time),
  "No-execution result cannot have started_at",
);
bad(
  "result-extra-property",
  "result",
  finished,
  (x) => (x.output_truncated = false),
  "No silent truncation shorthand",
);
bad(
  "login-versioned",
  "login",
  { username: "test-admin", password: "test-only-password" },
  (x) => (x.v = 1),
  "Login exception stays unversioned",
);
bad(
  "device-false-health",
  "device",
  device,
  (x) => (x.business_healthy = true),
  "Unmeasured status must remain unknown",
);
bad(
  "user-unknown-role",
  "user",
  user,
  (x) => (x.role = "superuser"),
  "No undocumented role",
);
bad(
  "user-duplicate-scope",
  "user",
  user,
  (x) => (x.device_scope = [task.device_id, task.device_id]),
  "Unique scope IDs",
);
bad(
  "cancel-request-extra",
  "cancel-request",
  { v: 1 },
  (x) => (x.force = true),
  "No force option",
);
bad(
  "artifact-response-too-large",
  "artifact-response",
  { v: 1, ...artifact },
  (x) => (x.size = 1048577),
  "Object upload hard limit",
);

fixture("command-bare-executable", "commands", {
  ...command,
  argv: ["uptime"],
});
fixture("result-unknown-captured", "result", {
  ...unknown,
  stdout: artifact,
  stderr: artifact,
});
fixture("result-no-execution-null", "result", {
  ...expired,
  stdout: null,
  stderr: null,
});
fixture("result-no-execution-empty", "result", {
  ...expired,
  stdout: {},
  stderr: {},
});
fixture("error-response", "error-response", { v: 1, error: "INVALID_REQUEST" });
fixture("health-response", "health-response", {
  v: 1,
  ok: true,
  server_instance: "fleet-fixture-server",
});
bad(
  "command-relative-executable",
  "commands",
  command,
  (x) => (x.argv = ["./program"]),
  "Only absolute program path or a bare name",
);
bad(
  "result-unknown-complete-captured",
  "result",
  { ...unknown, stdout: artifact, stderr: artifact },
  (x) => (x.audit_complete = true),
  "UNKNOWN never claims complete audit",
);
bad(
  "result-no-execution-success",
  "result",
  expired,
  (x) => (x.status = "SUCCEEDED"),
  "Success requires actual execution",
);
bad(
  "result-expired-after-start",
  "result",
  finished,
  (x) => (x.status = "EXPIRED"),
  "Expiry is a pre-execution terminal state",
);

const auditDetails = {
  "user.bootstrap": { username: user.username, role: user.role },
  "user.login": {},
  "user.login_failed": { username_hash: sha(user.username) },
  "enrollment.created": {
    expires_at: time + 3600000,
    name: "fixture enrollment",
  },
  "device.enrolled": { recovered: false },
  "device.revoked": {},
  "task.created": {
    action: "AGENT_EXEC",
    argv: task.argv,
    cwd: task.cwd,
    role: user.role,
    authorized: true,
    payload_hash: task.payload_hash,
  },
  "task.cancel_requested": {},
  "output.viewed": { stream: "stdout", ...artifact },
  "authorization.denied": {
    reason: "DEVICE_SCOPE_DENIED",
    method: "GET",
    route: "/api/v1/tasks/:id",
  },
  "task.accepted": {
    event_id: accepted.event_id,
    seq: accepted.seq,
    at: accepted.at,
    payload: accepted.payload,
  },
  "task.started": {
    event_id: started.event_id,
    seq: started.seq,
    at: started.at,
    payload: started.payload,
  },
  "task.finished": {
    event_id: event.event_id,
    seq: event.seq,
    at: event.at,
    payload: event.payload,
  },
};
const auditRecords = Object.entries(auditDetails).map(
  ([action, detail], i) => ({
    id: i + 1,
    at: time + i,
    actor_id: task.actor_id,
    device_id: task.device_id,
    task_id: task.task_id,
    action,
    detail,
  }),
);
for (const record of auditRecords)
  fixture("audit-" + record.action, "audit", record);
fixture("audit-response", "audit-response", { v: 1, audit: auditRecords });
fixture("audit-null-identities", "audit", {
  id: 99,
  at: time,
  actor_id: null,
  device_id: null,
  task_id: null,
  action: "user.login_failed",
  detail: { username_hash: sha(user.username) },
});
bad(
  "audit-unregistered-action",
  "audit",
  auditRecords[0],
  (x) => (x.action = "unregistered.action"),
  "Audit action variants are explicit",
);
bad(
  "audit-wrong-detail-shape",
  "audit",
  auditRecords[0],
  (x) => (x.detail = { recovered: true }),
  "Detail must match its action",
);
bad(
  "audit-nested-extra-field",
  "audit",
  auditRecords.at(-1),
  (x) => (x.detail.payload.secret = "hidden"),
  "Audit payloads also reject undeclared fields",
);
fixture("deployment-settings", "deployment-settings", {
  device_access: "ssh-only",
  web_enabled: true,
  web_protocol: "http",
});
fixture("deployment-response", "deployment-response", {
  v: 1,
  revision: 0,
  settings: {
    device_access: "ssh-only",
    web_enabled: true,
    web_protocol: "http",
  },
  state: "idle",
  entry_url: null,
  rollback_url: null,
  confirm_by: null,
  last_error: null,
  active_terminals: 0,
  https_ready: false,
  recovery_command:
    "node apps/server/dist/enable-web.js --data-dir '/srv/farhelm/data'",
});
fixture("deployment-update", "deployment-update", {
  v: 1,
  revision: 0,
  settings: {
    device_access: "ssh-only",
    web_enabled: true,
    web_protocol: "http",
  },
  entry_origin: "http://farhelm.test:8080",
  confirm_web_disable: false,
});
fixture("deployment-confirm", "deployment-confirm", { v: 1, revision: 1 });
fixture("audit-deployment.requested", "audit", {
  id: 1,
  at: 1735689600100,
  actor_id: null,
  device_id: null,
  task_id: null,
  action: "deployment.requested",
  detail: {
    revision: 1,
    device_access: "ssh-only",
    web_enabled: true,
    web_protocol: "http",
  },
});
fixture("audit-deployment.applied", "audit", {
  id: 1,
  at: 1735689600100,
  actor_id: null,
  device_id: null,
  task_id: null,
  action: "deployment.applied",
  detail: {
    revision: 1,
    device_access: "ssh-only",
    web_enabled: true,
    web_protocol: "http",
  },
});
fixture("audit-deployment.rolled_back", "audit", {
  id: 1,
  at: 1735689600100,
  actor_id: null,
  device_id: null,
  task_id: null,
  action: "deployment.rolled_back",
  detail: { revision: 1, code: "APPLY_FAILED" },
});
fixture("deployment-agent-http", "deployment-settings", {
  device_access: "agent-ssh",
  web_enabled: true,
  web_protocol: "http",
});
save("manifest.json", manifest);
console.log(`Wrote ${manifest.length} fixtures`);
