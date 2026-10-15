# Fleet HTTPS / WSS server

P0/P1 development implementation. Node.js **24+** is required for `node:sqlite` (`DatabaseSync`; availability/experimental status depends on the exact Node 24 release). SQLite runs WAL, `synchronous=FULL`, foreign keys and a five-second busy timeout. This is a single-process/single-host server, not a high-availability or production-security claim.

## Start

Run `npm ci`, `npm run build`, then `npm start` in this directory. Set:

- `FLEET_HOST` (default `127.0.0.1`), `FLEET_PORT` (default `8443`)
- `FLEET_DATA_DIR` (default `./data`): private server-owned storage, separate from Agent execution storage
- `FLEET_TLS_CERT`, `FLEET_TLS_KEY`: certificate-chain and key file paths; TLS 1.2+ only, no HTTP downgrade
- `FLEET_ADMIN_USER`, `FLEET_ADMIN_PASSWORD`: explicit initial admin; minimum password length 12, no defaults. Existing users are never reset from environment variables. Remove bootstrap password from the environment after first use
- Optional `FLEET_WEB_DIST`: built Vue directory containing `index.html`; serves the console and APIs on the same HTTPS origin
- Optional `FLEET_TEST_MODE=1`: in-process hooks only. CLI requires loopback binding. No fault-injection HTTP endpoint exists

The UI uses explicit Bearer sessions. No CORS, cookies, query tokens or public user-provisioning endpoint is enabled. `/api/v1/me` returns the flat user object plus `v:1`. All JSON mutations except login require `v:1`. `/healthz` exposes the server instance identifier used in challenge domain separation.

`buildServer(config)` from `src/server.ts` / `dist/server.js` returns `{app, store, close, testHooks}`. Call `await app.listen({host:'127.0.0.1',port:0})` in tests. Config accepts `dataDir`, `tlsCert`/`tlsKey` (paths, PEM strings or Buffers), optional `adminUsername`/`adminPassword`, `deviceTokenTtlMs` (default 300000), `sessionTtlMs` (28800000), `heartbeatTimeoutMs` (15000), `webDist`, `testMode`, `logger`.

The private test/admin seeding API is `store.seedUser({username,password,role,deviceScope})`. Roles: `admin`, `ops`, `business`, `auditor`; scope is `'*'` or explicit device ID array. This is an in-process API, not remotely callable. User/role lifecycle and SSO are future work. `store.db` is available for focused integration assertions and consistent SQLite backup tooling.

## Durability and recovery

- Database: `<dataDir>/fleet.sqlite` and live WAL/SHM sidecars
- Artifact objects: `<dataDir>/objects/<task_id>/<sha256>`; restrictive directory/file modes
- Every command inserts the immutable task, actor-scoped idempotency record and audit entry in one transaction before any delivery
- Each contiguous task event inserts event, state projection and audit in one transaction before ACK. Same event ID and canonical event bytes re-ACK; conflicting content rejects
- `EVENT_GAP` is deliberately **rejected without ACK**, not stored out of order. Agent must replay its durable outbox in sequence. It cannot advance a task state over a gap
- Artifact upload validates task ownership, size and SHA-256, writes a temporary file, fsyncs it, atomically renames, fsyncs directories, then commits its database index. Finished ACK requires each referenced artifact to exist, match size and hash, and fit the combined output limit
- Restart checks all indexed artifacts and refuses startup if any confirmed object is missing/corrupt. Unindexed files are harmless crash orphans; this version never automatically garbage-collects them or permanent task/event/idempotency tombstones
- A cancelled request is recorded and retransmitted, not treated as evidence of process termination. `UNKNOWN` never automatically creates a new execution
- Newest authenticated WSS connection owns sends. Old connections cannot mutate state or ACK. Tokens are checked on every frame and HTTP request, and active connections expire or are revoked
- Authorization denials and output views are audited. Console output reads require a scoped user session; device credentials are upload/control-only

For backups use SQLite's supported online-backup API or stop the server in an explicitly authorized environment, then copy the database **and matching objects**. Copying the live `.sqlite` file alone is unsafe. Restore into separate private storage and verify the object index before use. Hashes detect accidental corruption but do not make records immune to an administrator who can rewrite both DB and objects.

## Resource boundaries

Control JSON/frame: 64 KiB; binary objects: 1 MiB. Task combined stdout/stderr: 0..1 MiB. `argv` has 1..128 nonempty strings, at most 8192 UTF-8 bytes per argument and 32768 total; malformed Unicode/NUL rejects. Executable is an absolute path or bare name; relative paths with slash reject. `cwd` must be absolute (up to 4096 JS UTF-16 units). Serialized assignment must also fit the frame bound. Timeout 100..3600000 ms; task TTL 1..86400 seconds; enrollment TTL 60..86400 seconds (default3600). At most100 unfinished tasks/device,4 distinct uploaded objects/task. Minimum64 MiB free disk to create commands/objects. Outbound WSS pending bytes capped256 KiB. Task/audit listing bounded to latest500/1000 authorized entries; pagination is future work.

Fixed one-minute rate windows: global HTTP10000, IP HTTP1000; login global100/IP20/username10; challenges global1000/IP120/key20; proof IP120; commands/user60; artifact/device240; WSS/device1200. Rate map has at most10000 keys. Challenges last60 seconds and allow at most5 bad signature attempts. These conservative development limits need measurement/tuning for a 500-device reconnect wave. Trusted reverse-proxy IP handling is intentionally not enabled by default.

Unknown WSS types/version and malformed frames reject. Protocol diagnostic extension: `{v:1,type:'error',body:{code:string}}`; no data is acknowledged by an error. `EVENT_GAP` carries no cumulative ACK. Audit completeness cannot be true for UNKNOWN; success requires complete audit. Missing stream references are permitted only for UNKNOWN/incomplete evidence or tasks proven not started. Timeout/cancel with unconfirmed cleanup must be UNKNOWN.

## Verification

`npm run typecheck`, `npm test`, `npm run build`. Tests generate a disposable local CA-compatible certificate and use real HTTPS/WSS with certificate trust validation, not `rejectUnauthorized:false`.

Coverage includes key proof/recovery and challenge replay, authorization roles/scope/denial audit, actor-bound idempotency, raw binary outputs, missing/wrong-hash objects, ACK loss/replay, persistence across server restart, newest connection, expiry/revocation, event gap rejection, invalid Unicode/oversized frames, and static traversal/symlink/API-fallback protection. TLS/NAT on a real public endpoint, power-loss/storage-controller semantics, 50–500 device load, production identity and independent audit custody still need separately authorized validation.
