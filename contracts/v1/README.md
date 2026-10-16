# Farhelm v1 JSON contracts

These Draft 2020-12 JSON Schemas implement `../../PROTOCOL.md`. Concrete JSON objects reject undeclared properties, including nested objects. Read this document alongside the protocol; a schema pass does **not** establish authorization, durable storage, or valid state transitions.

The Farhelm rename retains the v1 schema IDs under `https://fleet.local/contracts/v1/`, the `fleet-v1` signing domain and the public cryptographic vectors for compatibility. Schema titles and validation messages use the current product name.

## Version and shape decisions

- Every JSON HTTP mutation and success response includes `v: 1`, except the login request and successful login response. Examples in the protocol's User API section that omit `v` are shorthand; the protocol's opening version rule takes precedence. Server and console were aligned on this decision.
- HTTP error bodies are `{ "v": 1, "error": "ERROR_CODE" }`, including login errors. This is a documented implementation extension.
- WSS messages are exactly `{ "v": 1, "type": ..., "body": ... }`. Body objects are not separately versioned. The supported types are `agent.hello`, `agent.heartbeat`, `task.assign`, `task.cancel`, `task.event`, `event.ack`, and the implementation's `error` response with exact body `{ "code": "ERROR_CODE" }`.
- `task.schema.json` describes the immutable task body. `task-detail.schema.json` adds the server projection: `status`, `last_seq`, `cancel_requested`, and `result`. A single HTTP task response adds `v`; a task list versions the outer response only.
- `me-response.schema.json` is flat: `{ "v": 1, "id": ..., "username": ..., "role": ..., "device_scope": ... }`.
- Artifact upload responses include `v`. Stored stdout/stderr references are exactly `{ "sha256": ..., "size": ... }`, without `v`.
- `UNKNOWN` always has `audit_complete: false`. Its missing streams may be `null`. Terminal no-execution results use `cleanup: "not_started"`, `started_at: null`, `exit_code: null`; either stream may be a reference, `{}`, or `null`. Empty references are rejected after execution. `EXPIRED` is a no-execution state.
- Control connectivity, private-data reachability, and business health are separate fields. Private-data reachability remains `null`. Business health is boolean only for fresh configured Agent-local probes, otherwise `null`; see `device-health-response`, `health-config`, `health-run-request`, `health-check`, `health-result` and `health-envelope` schemas and [health checks](../../docs/health-checks.md).
- `audit.schema.json` models current server audit actions with exact action-specific `detail` structures. New actions or detail fields require an explicit schema update. This freezes current response validation, not the database's ability to persist future audit actions.

## Schema index

| Interface | Request/body schema | Success response schema |
| --- | --- | --- |
| POST `/api/v1/login` | `login` | `login-response` |
| GET `/api/v1/me` | None | `me-response` |
| GET `/api/v1/devices` | None | `devices-response` |
| POST `/api/v1/enrollment-tokens` | `enrollment-token-request` | `enrollment-token-response` |
| POST `/api/agent/challenge` | `challenge-request` | `challenge-response` |
| POST `/api/agent/enroll` | `enrollment` | `enrollment-response` |
| POST `/api/agent/auth` | `auth` | `auth-response` |
| POST `/api/v1/commands` | `commands` | `command-response` |
| GET `/api/v1/tasks` | None | `tasks-response` |
| GET `/api/v1/audit` | None | `audit-response` |
| GET `/api/v1/tasks/:id` | None | `task-response` |
| POST `/api/v1/tasks/:id/cancel` | `cancel-request` | `cancel-response` |
| POST `/api/v1/devices/:id/revoke` | `revoke-request` | `revoke-response` |
| PUT `/api/agent/tasks/:id/artifacts/:sha256` | Raw octets | `artifact-response` |
| GET `/healthz` | None | `health-response` |
| WSS `/agent/ws` | `envelope` | `envelope` |
| All HTTP errors | N/A | `error-response` |

Names in this table have a `.schema.json` suffix on disk. `common` contains shared definitions; `result`, `event`, `task`, `task-detail`, `device`, `user`, and `audit` can also be validated independently.

## Constraints and checks outside JSON Schema

Implemented bounds are explicit in `common.schema.json`: IDs at most 128 characters; 1–128 argv items; at most 8,192 characters per argument; absolute cwd at most 4,096 characters; timeout 100–3,600,000 ms; combined output cap 0–1,048,576 bytes. Command TTL is 1–86,400 seconds; enrollment TTL is 60–86,400 seconds. The executable is an absolute path or a bare program name resolved under the agent's fixed PATH. NUL and lone Unicode surrogate values are rejected in canonical task strings. Public keys/signatures use canonical padded base64 of 32/64 raw bytes; hashes are lowercase SHA-256 hex.

JSON Schema string lengths count Unicode code points. Runtime code must also apply its **UTF-8 byte** limits: at most 8,192 bytes per argument, at most 32,768 argument bytes combined, at most 4,096 cwd bytes, and at most 65,536 bytes per WSS frame. Check frame bytes before parsing. The schema deliberately does not pretend character counts prove byte budgets.

Both peers must additionally enforce:

1. Strict UTF-8/JSON parsing and safe integer range; `created_at > 0`, `expires_at > created_at`; live TTL and challenge-expiry checks
2. Task hash equality and immutable task-ID replay semantics, actor/device binding, bearer authentication, roles and device scope
3. Purpose-bound challenge bytes, signature verification, single-use proof redemption and rate limits
4. Contiguous event sequence, allowed state transitions, per-task execution concurrency, permanent task tombstones, and byte-identical event replay
5. Actual artifact bytes/hash, owner binding, combined stream size, fsync/rename/index ordering, availability before finished ACK, and output-view audit
6. Accurate execution/cleanup/audit claims; the presence of `cleanup: "process_group"` does not prove containment of processes that escaped their group
7. Required `Idempotency-Key` header (actor/request bound), and credentials in Authorization headers rather than URL/query/body fields

These semantic and storage checks cannot be replaced with schema validation.

## Shared fixtures and cryptographic vectors

`fixtures/manifest.json` lists all positive and negative JSON examples and their target schemas. Positive and negative examples cover every public schema, recursive unknown-field rejection, version mismatches, caller-supplied actor/UID fields, bad keys/signatures, scalar and resource bounds, missing output evidence, and no-execution results.

- `fixtures/canonical-task.json` fixes the full task, exact canonical UTF-8/hex preimage, and expected SHA-256. It includes non-ASCII text and a literal backslash escape. Expected hash: `eca4fda56f783d84468340f144040d5d8438021d67f83fda25413338da5277e4`
- `fixtures/ed25519-rfc8032.json` is the public [RFC 8032 §7.1 TEST 1](https://www.rfc-editor.org/rfc/rfc8032#section-7.1), checked using Node's native Ed25519 implementation
- `fixtures/challenge-signatures.json` uses that **public test seed** to sign enrollment and authentication challenges. It fixes all fields, empty-line placement, terminal LF, byte encodings, token digest, and deterministic signatures

The test seed and tokens are intentionally public, deterministic test material. Never use them as real credentials. Canonicalization follows the constrained-value subset described in the protocol and [RFC 8785](https://www.rfc-editor.org/rfc/rfc8785); it is not a general-purpose JCS implementation.

## Run and reuse

From repository root:

```sh
npm --prefix tests/contracts ci
npm --prefix tests/contracts test
```

Use a writable npm cache when needed, for example `npm --prefix tests/contracts ci --cache /tmp/fleet-npm-cache`. Node 20+ is required. Tests have no network requirement after installation.

Server/e2e tests can import the same validators:

```js
import { validate, assertValid } from './tests/contracts/validate.mjs';
assertValid('task-response', response.json()); // returns input or throws
if (!validate('commands', body)) console.error(validate.errors);
```

Names can be a short name, filename, or exact schema `$id`. Validators do not coerce inputs, insert defaults, or remove unknown fields. AJV strict validation is enabled; only its fixed-tuple warning is disabled because argv intentionally has one executable followed by variable arguments.

`tests/contracts/generate-contracts.py` is the schema source generator. `tests/contracts/generate-fixtures.mjs` deterministically regenerates public fixtures. After changing either source, regenerate and run the suite; changes to canonical/signing vectors require coordinated Rust/TypeScript review.

## Agent CA trust rollout

Agent 0.2.4 advertises `agent.trust.v1` and optional `trusted_ca_fingerprints` in `agent.hello`. The authenticated control channel carries `agent.trust.update` (request UUID, configuration revision, SHA-256 fingerprint, CA public PEM, prospective server chain, server name) and `agent.trust.result` (`applied` or a bounded failure reason). These frames are part of `envelope.schema.json`.

Admin-only GET / POST `/api/v1/settings/certificate/agent-sync` return `agent-ca-sync`; POST uses the `{v, revision}` shape of `certificate-check`. A revision/fingerprint/request match is required for a receipt. `applied` means certificate-chain/hostname validation, durable additive storage and runtime trust reload have completed. Existing private trust is preserved. Late/stale responses cannot authorize another rollout; reconnect reports the trust anchors actually loaded. `certificate-status.activation_ready` includes the server-side cutover guard. Same-CA renewal for the same entry does not need a new fleet rollout. See [private certificate operations](../../docs/private-certificates.md).

Certificate settings accept optional `challenge_type` (`http-01` or `tls-alpn-01`); omission preserves the saved choice, and migrated configurations default to HTTP-01. Status always returns the selected type. `challenge_port` is the internal listener port, not a configurable public CA validation port: HTTP-01 requires public 80 and TLS-ALPN-01 public 443. TLS validation shares the platform HTTPS listener and retains existing connections. Old audit entries may omit the new field.

Authenticated users can `POST /api/v1/me/password` using `password-change` (`v`, `current_password`, `new_password`), without device or administrator permissions. The target is always the authenticated user. Success returns `{v: 1, ok: true}`, atomically changes the password, increments the user revision, invalidates all of that user's sessions and audits `access.password_changed`; active terminals close immediately. Wrong current passwords return 400 `CURRENT_PASSWORD_INCORRECT`, preserve login and audit `user.password_change_failed` without credential material. Attempts are limited per account, independent of login token. No automatic retry is safe after an uncertain response.
