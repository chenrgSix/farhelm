# Farhelm Agent (Linux, Rust/Tokio)

This is the real native Agent. It uses rustls HTTPS/WSS, Ed25519 identity, a SQLite WAL/FULL journal, and bounded raw output files. It does not depend on SSH or EasyTier.

## Build and run

For automatic installation, use the console's **Add device → Agent** form. It generates a command that installs a static Linux binary, creates a non-root account if needed, registers the device, and starts a systemd service or background process. See [Agent installation](../docs/agent-installation.md) for platform packages, prerequisites and file locations. Platform and Agent release packages are v0.2.13. Existing v0.2.7 Agents remain compatible for ordinary connections; sudo terminals require an upgraded Agent, explicit terminal privilege-escalation opt-in and existing Linux sudo permissions. The Agent URL always uses the independent HTTPS ingress (default port 8444). The manual build/run instructions below do not install accounts or services.

Use an installed stable Rust toolchain and a C compiler (bundled SQLite and ring need one):

```sh
cargo build --locked
cargo test --locked
cargo clippy --locked --all-targets -- -D warnings
cargo fmt --check

# Run as the non-root Linux account selected and configured by the operator.
# The agent creates a missing state directory with mode 0700.
export FLEET_SERVER_URL=https://localhost:8444
export FLEET_CA_CERT=/absolute/path/to/ca.crt
export FLEET_STATE_DIR=/absolute/path/to/private/agent-state
export FLEET_ENROLLMENT_TOKEN='admin-issued-short-lived-token'
export FLEET_DEVICE_NAME=test-linux
./target/debug/farhelm-agent
```

Existing state directories must be owned by the running UID and have no group/other permissions. The persisted identity seed is 32 bytes, mode 0600, and is never sent to the server. Enrollment first attempts key-based authentication, allowing recovery after a lost successful enrollment response. A pinned server instance prevents silently moving the identity to a different server database. Missing either the journal or identity while the other remains is a fail-closed recovery condition, not a fresh enrollment.

`FLEET_EXECUTION_BACKEND=same-uid` is the default, per the user's explicit single-account decision. `disabled` allows identity/control testing without command execution. `development-same-uid` remains an alias. Execution as UID 0 is rejected. No account, sudo rule, privileged helper, systemd service, or host permission is installed or changed.

Interactive PTYs also default to `no_new_privs`. An operator can explicitly set `FLEET_TERMINAL_ALLOW_PRIVILEGE_ESCALATION=1` to permit the host's existing sudo/setuid policy in terminals. This does not change the Exec backend's mandatory `no_new_privs`, and cannot override an inherited `no_new_privs` flag. The local development Docker image installs sudo and grants fleet passwordless sudo inside that container; the Agent itself never configures sudoers on a real host. See [terminal configuration](../docs/terminal.md).

## Important security boundary

Agent-local health checks are configured from the console. The `health.probes.v1` capability enables bounded HTTP/HTTPS, TCP and read-only systemd probes over the existing authenticated control channel. Probes stop on connection loss and restart from the server's current configuration on reconnect; they never replay terminal input or restart services. See [health checks](../docs/health-checks.md).

The chosen single Linux UID executes commands and owns Agent state. An arbitrary command under that UID can read the Agent key, change its local journal, and interfere with the process. Mode 0600 protects against other ordinary UIDs; it is not isolation from that account's own commands. Central records already received are separately persisted, but the server cannot prove an endpoint has provided untampered or complete evidence. This implementation must not be described as endpoint tamper-proof or production-hardened.

Commands receive only PATH=/usr/bin:/bin, LANG=C.UTF-8 and LC_ALL=C.UTF-8, and no stdin. The executable must be an absolute path or a bare program name; slash-containing relative paths are rejected. Each command also receives Linux `no_new_privs`, preventing setuid/file-capability elevation to a more privileged UID. No shell is inserted. Explicitly requested `/bin/sh -c ...` is still a shell command and is audited as such.

## Execution and reliability

- A locked state directory permits one Agent instance. One scheduler permits one task at a time and continues independently of the WSS connection
- Immutable task hashing, permanent task IDs and transactionally sequenced accepted/started/finished outbox events prevent automatic repeat execution; ACKs match event ID, task ID and sequence
- RUNNING is committed before spawn. Any RUNNING record seen on restart becomes UNKNOWN and is never automatically rerun, including the ambiguous pre-spawn window
- Output prefixes are preserved after crashes. Recovery synchronizes existing output files and retains incomplete evidence with audit_complete=false
- PID, `/proc` start time, process group and UID are checked before signaling residual processes. No saved PID is blindly killed
- Both streams are drained concurrently into private files, with a single combined byte budget, an absolute 1 MiB/object bound, and a 16 MiB free-space reserve before starting
- Output overflow or capture/storage failure stops execution and marks evidence incomplete. Failure to open capture files prevents spawning
- TTL is checked before start. Cancellation and timeout terminate the verified process group with TERM, a 200 ms grace, KILL, and wait/reap. Linux subreaper mode helps reap ordinary descendants
- Ordinary process groups do not contain deliberate `setsid` or double-fork escapes. Every executed result therefore says cleanup=unconfirmed. Forced timeout/cancellation and uncertain outcomes are UNKNOWN with a specific reason and audit_complete=false; normal exit success/failure can have complete captured streams without claiming containment
- Raw HTTPS artifacts are verified/uploaded before finished is sent; server ACK is required before deleting an outbox row. Transfer does not block heartbeat or cancellation handling. Files and task tombstones are retained; automatic spool/tombstone GC is deliberately absent until a retention policy is defined
- TLS certificate and hostname validation are always enabled. A configured CA remains trusted; platform CA sync can append verified anchors to the private state directory without changing system trust. No insecure fallback exists. Authorization tokens use headers, never URLs
- Short-lived access tokens renew before expiry. WSS reconnection uses bounded exponential backoff plus jitter, preserving the same device identity and replaying the ordered durable outbox

## Test-only crash points

`FLEET_TEST_MODE=1`, a loopback server origin and `FLEET_TEST_FAULT=<point>` enable one intentional exit with code 86 per point per state directory. A synced `fault-<point>.once` marker prevents crash loops. Normal operation does not enable these hooks.

Supported points: `after_enroll_response`, `after_accept`, `after_running`, `after_spawn`, `after_seal`, `after_finish`.

- `after_enroll_response`: server enrollment succeeded but device ID was not saved; restart recovers by key
- `after_running`: state says RUNNING but spawn has not happened; restart conservatively reports UNKNOWN
- `after_spawn`: process identity has been journaled; restart verifies it before attempting residual process-group cleanup and reports UNKNOWN
- `after_seal`: output exists but result is not committed; restart reports UNKNOWN and preserves output
- `after_finish`: result/outbox is committed; restart replays it without executing again

Shared cross-language fixtures live in `../contracts/v1/fixtures`. Rust tests cover RFC 8032 signing, canonical task hashes, challenge context binding, journal/ACK dedupe, single-instance locking, environment clearing, real dual-stream/nonzero execution, bounded capture, timeout/fork cleanup, storage refusal and crash recovery. The repository's `tests/e2e` exercises the actual binary against the HTTPS/WSS server. These local tests do not validate a real public NAT path, a production host configuration, or strong escaped-descendant containment.

Agent 0.2.4 supports additive CA synchronization (`agent.trust.v1`) over the authenticated control channel. See [private certificates](../docs/private-certificates.md#已有-agent先同步-ca再切换证书).

Normal Agent terminals on 0.2.12+ can delegate a saved sudo password using the existing device switch and `terminal.sudo` authorization. The shell stays non-root. A session-local sudo wrapper registers each command before executing system sudo with the Agent askpass helper; the broker binds credential requests to that registered sudo process and its direct helper. Ordinary descendants cannot request the credential directly. Explicit stdin sudo (`-S`) and absolute system sudo paths retain native behavior. Session closure removes the wrapper/socket and discards the in-memory credential. Upgrade the platform before enabling this capability on Agents.

EasyTier observation accepts `FLEET_EASYTIER_CLI`, `FLEET_EASYTIER_RPC`, and optional `FLEET_EASYTIER_CONTAINER` in the Agent environment. Container collection preserves the effective UID/GID and requires a matching Linux network namespace plus actual egress evidence. It never grants Docker access or escalates privileges. See [configuration and deployment limits](../docs/network-routes.md#本机与-docker-采集配置).
