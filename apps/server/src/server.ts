import { AcmeTlsResponder, ACME_ALPN } from "./acme-tls.js";
import type { TLSSocket } from "node:tls";
import Fastify, {
  LogController,
  type FastifyRequest,
  type FastifyInstance,
  type FastifyServerOptions,
} from "fastify";
import type { Server as HttpsServer } from "node:https";
import websocket from "@fastify/websocket";
import { WebSocket } from "ws";
import {
  randomUUID,
  randomBytes,
  createPublicKey,
  verify,
  X509Certificate,
} from "node:crypto";
import { createSecureContext } from "node:tls";
import {
  readFileSync,
  mkdirSync,
  openSync,
  writeFileSync,
  fsyncSync,
  closeSync,
  renameSync,
  unlinkSync,
  statfsSync,
  existsSync,
  realpathSync,
  statSync,
} from "node:fs";
import { join, isAbsolute, resolve, extname } from "node:path";
import { Store } from "./store.js";
import { auditContext, auditText } from "./audit-context.js";
import { deployment } from "./deployment.js";
import { localAdminServer } from "./local-admin.js";
import { historyPage } from "./history.js";
import { watchTlsContext } from "../../../lib/tls-context.mjs";
import { registerAccessControl } from "./access-control.js";
import {
  hasPermission,
  canReadOtherHistory,
  type Permission,
} from "./permissions.js";
import { registerTerminals } from "./terminal.js";
import { SSH_MENU_PAGE_SIZE } from "./ssh-menu.js";
import { createSshGateway, type SshLogin } from "./ssh.js";
import { registerNetworkRoutes } from "./network-routes.js";
import { registerNetworkProbes } from "./network-probes.js";
import { registerAgentNetwork } from "./agent-network.js";
import { registerHealth } from "./health.js";
import { registerDeviceConnections } from "./device-connections.js";
import { registerAgentReleases, legacyArtifacts } from "./agent-releases.js";
import { registerAgentInstall } from "./agent-install.js";
import { registerSettings } from "./settings.js";
import { certificateMatches, managedCertificate } from "./certificate-files.js";
import { agentCASync, registerAgentCASync } from "./agent-ca.js";
import { CertificateManager, registerCertificates } from "./certificates.js";
import { registerAgentUpgrades, type UpgradeInfo } from "./agent-upgrades.js";
import {
  ApiError,
  fail,
  hash,
  token,
  canonical,
  object,
  keys,
  str,
  integer,
  version,
  base64,
  digest,
  passwordHash,
  passwordVerify,
  RateLimiter,
} from "./util.js";
import {
  TERMINAL,
  type ServerConfig,
  type User,
  type Task,
  type TaskEvent,
} from "./types.js";
interface Connection {
  socket: WebSocket;
  deviceId: string;
  tokenHash: string;
  expiresAt: number;
  lastHeartbeat: number;
  ready: boolean;
  terminal: boolean;
  health: boolean;
  address: boolean;
  trust: boolean;
  network: boolean;
  networkProbes: boolean;
  route: boolean;
  upgrade?: UpgradeInfo;
  healthSession: string;
}
const MAX_OBJECT = 1048576;
const MAX_FRAME = 65536;
const PUBKEY_PREFIX = Buffer.from("302a300506032b6570032100", "hex");
const readPem = (x: string | Buffer) =>
  Buffer.isBuffer(x)
    ? x
    : x.includes("-----BEGIN ")
      ? Buffer.from(x)
      : readFileSync(x);
export async function buildServer(config: ServerConfig) {
  const {
    deviceAccess,
    webEnabled,
    webProtocol,
    agentEnabled,
    localAdmin,
    tls,
  } = deployment(config);
  if (localAdmin && !config.ssh)
    throw new Error("SSH-only mode requires an SSH listener");
  if (tls && (!config.tlsCert || !config.tlsKey))
    throw new Error("Explicit TLS certificate and key are required for HTTPS");
  config = {
    ...config,
    ...(!tls
      ? {
          tlsCert: undefined,
          tlsKey: undefined,
          acme: undefined,
          certificateTest: undefined,
        }
      : {}),
    ...(!webEnabled ? { webDist: undefined, consoleOrigin: undefined } : {}),
    ...(!agentEnabled ? { agentInstall: undefined } : {}),
  };
  const store = new Store(config.dataDir);
  const db = store.db;
  const rate = new RateLimiter();
  const connections = new Map<string, Connection>();
  const dropAcks: string[] = [];
  const deviceTtl = integer(config.deviceTokenTtlMs ?? 300000, 1000, 3600000);
  const sessionTtl = integer(config.sessionTtlMs ?? 28800000, 1000, 86400000);
  const heartbeatTimeout = integer(
    config.heartbeatTimeoutMs ?? 15000,
    1000,
    600000,
  );
  const dummyPassword = passwordHash(randomBytes(32).toString("hex"));
  const artifactRoot = join(config.dataDir, "objects");
  mkdirSync(artifactRoot, { recursive: true, mode: 0o700 });
  // Refuse to silently present an index whose acknowledged objects were lost/corrupted.
  for (const item of db
    .prepare("SELECT * FROM artifacts")
    .iterate() as Iterable<any>) {
    const path = join(artifactRoot, item.relative_path);
    const bytes = existsSync(path) ? readFileSync(path) : undefined;
    if (!bytes || bytes.length !== item.size || hash(bytes) !== item.sha256) {
      store.close();
      throw new Error(
        "ARTIFACT_RECONCILIATION_FAILED: " + item.task_id + "/" + item.sha256,
      );
    }
  }
  if (
    config.adminUsername !== undefined ||
    config.adminPassword !== undefined
  ) {
    if (!config.adminUsername || !config.adminPassword)
      throw new Error("Both explicit admin username and password are required");
    // Bootstrap is only for a fresh database. Renaming or disabling an account
    // must never recreate it from a stale deployment environment on restart.
    if (!(db.prepare("SELECT COUNT(*) AS n FROM users").get() as any).n)
      store.seedUser({
        username: config.adminUsername,
        password: config.adminPassword,
        role: "admin",
        deviceScope: "*",
      });
  }
  if (config.acme?.testDirectoryUrl && !config.testMode)
    throw new Error(
      "Custom ACME directories are restricted to isolated test mode",
    );
  if (config.acme && config.agentInstall?.caCert)
    throw new Error(
      "ACME mode requires Agents to use public trust roots; remove the private Agent CA setting",
    );
  if (config.certificateTest && !config.testMode)
    throw new Error("Certificate test options require isolated test mode");
  const acmeTls = tls && config.acme ? new AcmeTlsResponder() : undefined;
  const managed = !tls ? undefined : managedCertificate(config.dataDir);
  const identity = (cert: string | Buffer, key: string | Buffer) => ({
    certificate: new X509Certificate(cert),
    context: createSecureContext({ cert, key, minVersion: "TLSv1.2" }),
  });
  const bootstrapIdentity = !tls
    ? undefined
    : identity(readPem(config.tlsCert!), readPem(config.tlsKey!));
  let activeIdentity = managed
    ? identity(managed.cert, managed.key)
    : undefined;
  const retired = !tls
    ? undefined
    : managedCertificate(config.dataDir, "retired.json");
  let retiredIdentity = retired
    ? identity(retired.cert, retired.key)
    : undefined;
  let activeDomain = managed?.domain;
  const options = {
    bodyLimit: MAX_FRAME,
    requestTimeout: 30000,
    connectionTimeout: 30000,
    keepAliveTimeout: 10000,
    logger: config.logger
      ? {
          redact: [
            "req.headers.authorization",
            "req.body.password",
            "req.body.current_password",
            "req.body.new_password",
            "req.body.private_key",
            "req.body.passphrase",
            "req.body.sudo_password",
            "req.body.enrollment_token",
            "res.headers.set-cookie",
          ],
        }
      : false,
    logController: new LogController({ disableRequestLogging: true }),
  } satisfies FastifyServerOptions;
  const app: FastifyInstance = localAdmin
    ? Fastify({
        ...options,
        serverFactory: (handler) => localAdminServer(handler, config.dataDir),
      })
    : !tls
      ? Fastify(options)
      : Fastify({
          ...options,
          https: {
            key: managed?.key ?? readPem(config.tlsKey!),
            cert: managed?.cert ?? readPem(config.tlsCert!),
            minVersion: "TLSv1.2",
            ...(acmeTls ? { ALPNCallback: acmeTls.callback() } : {}),
            SNICallback: function (this: TLSSocket, name, callback) {
              const selected =
                activeIdentity &&
                [activeIdentity, retiredIdentity, bootstrapIdentity].find(
                  (item) => item && certificateMatches(item.certificate, name),
                );
              callback(null, acmeTls?.sniContext(this) ?? selected?.context);
            },
          },
        });
  app.addHook("onRequest", (req, _reply, done) => {
    const route = req.routeOptions.url ?? "unknown";
    auditContext.run(
      {
        source: /^\/(?:api\/)?agent(?:\/|$)/.test(route) ? "agent" : "http",
        remote_address: auditText(req.ip, 128),
        request_id: auditText(req.id, 128),
        method: auditText(req.method, 16),
        route: auditText(route, 256),
        user_agent: auditText(req.headers["user-agent"], 512),
      },
      done,
    );
  });
  if (acmeTls)
    app.server.prependListener("secureConnection", (socket: TLSSocket) => {
      // ACME proves possession in the handshake; it never serves application data.
      if (socket.alpnProtocol === ACME_ALPN) socket.end();
    });
  // Run after websocket bookkeeping so rejected upgrades also close their sockets.
  // Block Agent enrollment, authentication and control on the management listener.
  app.addHook("preValidation", async (req) => {
    const route = req.routeOptions.url ?? "";
    if (
      config.deploymentControl?.busy() ||
      (config.deploymentControl?.terminalsBlocked() &&
        route === "/api/v1/commands")
    )
      fail(503, "DEPLOYMENT_APPLYING");
    if (
      !agentEnabled &&
      (/^\/(?:api\/)?agent(?:\/|$)/.test(route) ||
        /^\/api\/v1\/(?:enrollment-tokens|agent-[^/]+)(?:\/|$)/.test(route) ||
        route === "/api/v1/commands" ||
        route.endsWith("/agent-sync") ||
        (route === "/api/v1/settings" && req.method === "PUT"))
    )
      fail(403, "AGENT_ACCESS_DISABLED");
  });
  let tlsWatcher: ReturnType<typeof watchTlsContext> | undefined;
  app.addHook("onListen", async () => {
    if (
      tls &&
      !config.acme &&
      !managed &&
      typeof config.tlsCert === "string" &&
      !config.tlsCert.includes("-----BEGIN ") &&
      typeof config.tlsKey === "string" &&
      !config.tlsKey.includes("-----BEGIN ")
    ) {
      tlsWatcher = watchTlsContext(app.server as HttpsServer, {
        certPath: config.tlsCert,
        keyPath: config.tlsKey,
        log: (message) => app.log.warn(message),
      });
    }
  });
  app.addHook("onClose", async () => {
    tlsWatcher?.close();
  });
  app.setErrorHandler((err: any, req, reply) => {
    if (err instanceof ApiError && err.statusCode === 403) {
      try {
        const u = db
          .prepare(
            "SELECT u.id FROM user_sessions s JOIN users u ON u.id=s.user_id WHERE s.token_hash=? AND s.expires_at>? AND u.enabled=1",
          )
          .get(
            typeof req.headers.authorization === "string" &&
              /^Bearer [A-Za-z0-9_-]{43}$/.test(req.headers.authorization)
              ? hash(req.headers.authorization.slice(7))
              : "",
            Date.now(),
          ) as any;
        const p = req.params as any;
        const resourceId =
          p?.id ?? p?.task_id ?? (req.body as any)?.device_id ?? null;
        let deviceId: string | null = null;
        let taskId: string | null = null;
        if (typeof resourceId === "string") {
          const t = db
            .prepare("SELECT id,device_id FROM tasks WHERE id=?")
            .get(resourceId) as any;
          if (t) {
            deviceId = t.device_id;
            taskId = t.id;
          } else if (
            db.prepare("SELECT id FROM devices WHERE id=?").get(resourceId)
          )
            deviceId = resourceId;
        }
        store.audit("authorization.denied", u?.id ?? null, deviceId, taskId, {
          reason: err.code,
          method: req.method,
          route: req.routeOptions.url ?? "unknown",
        });
      } catch {
        return reply.code(503).send({ v: 1, error: "AUDIT_STORAGE_FAILURE" });
      }
    }
    if (err instanceof ApiError)
      return reply.code(err.statusCode).send({ v: 1, error: err.code });
    if (err.statusCode && err.statusCode < 500)
      return reply
        .code(err.statusCode)
        .send({ v: 1, error: err.code ?? "INVALID_REQUEST" });
    app.log.error(
      { err: { name: err.name, code: err.code } },
      "Request failed",
    );
    return reply.code(500).send({ v: 1, error: "INTERNAL_ERROR" });
  });
  app.addHook("onSend", async (_req, reply, payload) => {
    reply
      .header("cache-control", "no-store")
      .header("x-content-type-options", "nosniff")
      .header("referrer-policy", "no-referrer");
    if (tls && !reply.hasHeader("strict-transport-security"))
      reply.header("strict-transport-security", "max-age=31536000");
    return payload;
  });
  app.addHook("onRequest", async (req) => {
    rate.check("global", 10000);
    rate.check("http:" + req.ip, 1000);
    if (req.url.length > 4096) fail(414, "URL_TOO_LONG");
  });
  app.addContentTypeParser(
    "application/octet-stream",
    { parseAs: "buffer", bodyLimit: MAX_OBJECT },
    (_req, body, done) => done(null, body),
  );
  await app.register(websocket, {
    options: { maxPayload: MAX_FRAME, perMessageDeflate: false },
  });
  function bearer(req: FastifyRequest) {
    const authorization = req.headers.authorization;
    if (
      typeof authorization !== "string" ||
      !/^Bearer [A-Za-z0-9_-]{43}$/.test(authorization)
    )
      fail(401, "AUTH_REQUIRED");
    return hash(authorization.slice(7));
  }
  function userAuth(req: FastifyRequest): User {
    const row = db
      .prepare(
        "SELECT u.* FROM user_sessions s JOIN users u ON u.id=s.user_id WHERE s.token_hash=? AND s.expires_at>? AND u.enabled=1",
      )
      .get(bearer(req), Date.now());
    if (!row) fail(401, "SESSION_INVALID");
    return store.user(row);
  }
  function deviceAuth(req: FastifyRequest): {
    id: string;
    expires_at: number;
    token_hash: string;
  } {
    const th = bearer(req);
    const row = db
      .prepare(
        "SELECT d.id,t.expires_at FROM device_tokens t JOIN devices d ON d.id=t.device_id WHERE t.token_hash=? AND t.expires_at>? AND d.revoked_at IS NULL AND (d.connection_kind='agent' OR d.agent_pending_public_key IS NOT NULL) AND t.scope=?",
      )
      .get(th, Date.now(), "agent-control-output") as any;
    if (!row) fail(401, "DEVICE_AUTH_INVALID");
    return { ...row, token_hash: th };
  }
  function inScope(user: User, deviceId: string) {
    return (
      user.role === "admin" ||
      user.device_scope === "*" ||
      user.device_scope.includes(deviceId)
    );
  }
  function requireScope(user: User, deviceId: string) {
    if (!inScope(user, deviceId)) fail(403, "DEVICE_SCOPE_DENIED");
  }
  function admin(req: FastifyRequest): User {
    const user = userAuth(req);
    if (user.role !== "admin") fail(403, "ADMIN_REQUIRED");
    return user;
  }
  if (config.deploymentControl) {
    const control = config.deploymentControl;
    app.get("/api/v1/settings/deployment", async (req) => {
      admin(req);
      return control.snapshot();
    });
    app.put("/api/v1/settings/deployment", async (req, reply) => {
      const result = control.prepare(req.body, admin(req).id);
      if (tls && result.settings.web_protocol === "http")
        reply.header("strict-transport-security", "max-age=0");
      reply.raw.once("finish", () => control.apply());
      return result;
    });
    app.post("/api/v1/settings/deployment/confirm", async (req) =>
      control.confirm(req.body, admin(req).id),
    );
  }
  function operator(req: FastifyRequest): User {
    const user = userAuth(req);
    if (!hasPermission(user, "tasks.execute")) fail(403, "EXEC_ROLE_REQUIRED");
    return user;
  }
  function permitted(req: FastifyRequest, permission: Permission): User {
    const user = userAuth(req);
    if (!hasPermission(user, permission)) fail(403, "PERMISSION_DENIED");
    return user;
  }
  function availableStorage() {
    if (
      Number(statfsSync(config.dataDir).bavail) *
        Number(statfsSync(config.dataDir).bsize) <
      64 * 1024 * 1024
    )
      fail(507, "AUDIT_STORAGE_LOW");
  }
  function syncDir(path: string) {
    const fd = openSync(path, "r");
    try {
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
  }
  function requireDevice(id: string) {
    const row = db.prepare("SELECT * FROM devices WHERE id=?").get(id) as any;
    if (!row) fail(404, "DEVICE_NOT_FOUND");
    return row;
  }
  function live(c: Connection) {
    const row = db
      .prepare(
        "SELECT 1 FROM device_tokens t JOIN devices d ON d.id=t.device_id WHERE t.token_hash=? AND t.expires_at>? AND d.revoked_at IS NULL",
      )
      .get(c.tokenHash, Date.now());
    return (
      !!row &&
      connections.get(c.deviceId) === c &&
      c.socket.readyState === WebSocket.OPEN
    );
  }
  function send(c: Connection, type: string, body: unknown) {
    if (!live(c)) return false;
    const msg = JSON.stringify({ v: 1, type, body });
    if (
      Buffer.byteLength(msg) > MAX_FRAME ||
      c.socket.bufferedAmount > 262144
    ) {
      c.socket.close(1013, "Bounded send queue exceeded");
      return false;
    }
    c.socket.send(msg);
    return true;
  }
  function dispatch(id: string, all = false) {
    const c = connections.get(id);
    if (!c?.ready || !live(c) || !networkRoutes.allowed(id)) return;
    const rows = db
      .prepare(
        "SELECT * FROM tasks WHERE device_id=? AND status NOT IN ('SUCCEEDED','FAILED','TIMED_OUT','CANCELLED','EXPIRED','UNKNOWN') ORDER BY created_at,id",
      )
      .all(id) as any[];
    for (const row of rows) {
      if (all || row.status === "QUEUED" || row.status === "SENT") {
        if (
          send(c, "task.assign", JSON.parse(row.task_json)) &&
          row.status === "QUEUED"
        )
          db.prepare(
            "UPDATE tasks SET status='SENT',updated_at=? WHERE id=? AND status='QUEUED'",
          ).run(Date.now(), row.id);
      }
      if (row.cancel_requested) send(c, "task.cancel", { task_id: row.id });
    }
  }
  const caSync = agentCASync(store, (id) => {
    const c = connections.get(id);
    return c?.ready && live(c)
      ? { supported: c.trust, send: (type, body) => send(c, type, body) }
      : undefined;
  });
  const certificates = !tls
    ? undefined
    : new CertificateManager({
        store,
        config: config.acme,
        tlsAlpn: acmeTls,
        tlsPort: () => {
          const address = app.server.address();
          return address && typeof address !== "string" ? address.port : null;
        },
        privateAvailable: !!config.webDist,
        privateLeafLifetimeMs: config.certificateTest?.privateLeafLifetimeMs,
        agentsReady: agentEnabled ? caSync.allReady : () => true,
        initial: managed,
        retired,
        fallback: () => readPem(config.tlsCert!),
        warn: (message) => app.log.warn(message),
        activate: (bundle) => {
          const next = identity(bundle.cert, bundle.key);
          (app.server as HttpsServer).setSecureContext({
            cert: bundle.cert,
            key: bundle.key,
            minVersion: "TLSv1.2",
          });
          if (activeDomain && activeDomain !== bundle.domain)
            retiredIdentity = activeIdentity;
          activeIdentity = next;
          activeDomain = bundle.domain;
          tlsWatcher?.close();
          tlsWatcher = undefined;
        },
      });
  if (certificates) {
    registerCertificates(app, certificates, admin);
    registerAgentCASync(app, certificates, caSync, admin);
  }
  const settings = registerSettings(app, {
    store,
    admin,
    initialServerUrl: config.agentInstall?.publicUrl,
    agent: (id) => {
      const c = connections.get(id);
      return c?.ready && live(c) && !networkRoutes.current(id).policy
        ? { supported: c.address, send: (type, body) => send(c, type, body) }
        : undefined;
    },
  });
  const legacyArtifact = legacyArtifacts(config.agentInstall?.distDir);
  const releases = registerAgentReleases(app, {
    store,
    admin,
    distDir: config.agentInstall?.distDir,
    artifact: legacyArtifact,
  });
  const installations = registerAgentInstall(app, {
    releases,
    artifact: legacyArtifact,
    store,
    config,
    admin,
    rate,
    serverUrl: () => settings.current().platform_server_url,
    ca: (url, fallback) => certificates?.agentCA(url, fallback) ?? fallback,
    online: (id) => !!connections.get(id)?.ready && live(connections.get(id)!),
  });
  const upgrades = registerAgentUpgrades(app, {
    store,
    admin,
    deviceAuth,
    releases,
    agent: (id) => {
      const c = connections.get(id);
      return c?.ready && live(c)
        ? { info: c.upgrade, send: (type, body) => send(c, type, body) }
        : undefined;
    },
  });
  const networkRoutes = registerNetworkRoutes(app, {
    store,
    admin,
    reader: (req) => permitted(req, "devices.read"),
    requireScope,
    requireDevice,
    agent(id) {
      const c = connections.get(id);
      return c?.ready &&
        live(c) &&
        Date.now() - c.lastHeartbeat <= heartbeatTimeout
        ? {
            supported: c.route,
            connectionId: c.healthSession,
            send: (type, body) => send(c, type, body),
          }
        : undefined;
    },
  });
  const deviceConnections = registerDeviceConnections(app, {
    routes: networkRoutes,
    store,
    admin,
    requireDevice,
    availableStorage,
    rate,
  });
  const networkProbes = registerNetworkProbes(app, {
    store,
    userAuth: (req) => permitted(req, "devices.read"),
    operator: (req) => permitted(req, "network.manage"),
    requireScope,
    requireDevice,
    availableStorage,
    rate,
    agent(id) {
      const c = connections.get(id);
      if (
        !c?.ready ||
        !live(c) ||
        Date.now() - c.lastHeartbeat > heartbeatTimeout
      )
        return undefined;
      return {
        supported: c.networkProbes,
        connectionId: c.healthSession,
        send: (type, body) => send(c, type, body),
      };
    },
  });
  const network = registerAgentNetwork(app, {
    store,
    userAuth: (req) => permitted(req, "devices.read"),
    requireScope,
    requireDevice,
    online: (id) => {
      const c = connections.get(id);
      return (
        !!c?.ready &&
        live(c) &&
        Date.now() - c.lastHeartbeat <= heartbeatTimeout
      );
    },
    supported: (id) => !!connections.get(id)?.network,
  });
  const health = registerHealth(app, {
    store,
    userAuth: (req) => permitted(req, "devices.read"),
    operator: (req) => permitted(req, "health.manage"),
    requireScope,
    requireDevice,
    availableStorage,
    rate,
    agent(id) {
      const c = connections.get(id);
      if (
        !c?.ready ||
        !live(c) ||
        Date.now() - c.lastHeartbeat > heartbeatTimeout
      )
        return undefined;
      return {
        supported: c.health,
        connectionId: c.healthSession,
        send: (type, body) => send(c, type, body),
      };
    },
  });
  const terminals = registerTerminals(app, {
    connections: deviceConnections,
    route: (id, backend) => networkRoutes.snapshot(id)[backend],
    store,
    operator: (req) => permitted(req, "terminal.connect"),
    userAuth,
    requireScope,
    inScope,
    availableStorage,
    requireConnect: () => {
      if (config.deploymentControl?.terminalsBlocked())
        fail(503, "DEPLOYMENT_APPLYING");
    },
    requireAvailable: (id) => {
      if (upgrades.active(id)) fail(409, "AGENT_UPGRADE_IN_PROGRESS");
    },
    rate,
    consoleOrigin: config.consoleOrigin,
    consoleProtocol: tls ? "https" : "http",
    agent(id) {
      const c = connections.get(id);
      if (
        !c?.ready ||
        !live(c) ||
        !networkRoutes.allowed(id) ||
        Date.now() - c.lastHeartbeat > heartbeatTimeout
      )
        return undefined;
      return {
        terminal: c.terminal,
        send: (type, body) => send(c, type, body),
      };
    },
  });
  function challengeProof(body: Record<string, any>, purpose: string) {
    version(body);
    keys(
      body,
      purpose === "enroll"
        ? ["v", "challenge_id", "signature", "name"]
        : ["v", "challenge_id", "signature"],
    );
    const id = str(body.challenge_id, 1, 128);
    const signature = base64(body.signature, 64);
    const row = db
      .prepare("SELECT * FROM challenges WHERE id=?")
      .get(id) as any;
    if (
      !row ||
      row.purpose !== purpose ||
      row.used ||
      row.failures >= 5 ||
      row.expires_at <= Date.now()
    )
      fail(401, "CHALLENGE_INVALID");
    const pub = createPublicKey({
      key: Buffer.concat([
        PUBKEY_PREFIX,
        Buffer.from(row.public_key, "base64"),
      ]),
      format: "der",
      type: "spki",
    });
    if (
      !verify(
        null,
        Buffer.from(row.signing_payload, "base64"),
        pub,
        Buffer.from(signature, "base64"),
      )
    ) {
      db.prepare("UPDATE challenges SET failures=failures+1 WHERE id=?").run(
        id,
      );
      fail(401, "PROOF_INVALID");
    }
    return row;
  }
  registerAccessControl(app, {
    store,
    admin,
    userAuth,
    availableStorage,
    rate,
    changed: () => terminals.tick(),
  });
  app.get("/healthz", async () => ({
    v: 1,
    ok: true,
    server_instance: store.instance,
  }));
  function passwordUser(username: string, password: string, ip: string) {
    rate.check("login-global", 100);
    rate.check("login-ip:" + ip, 20);
    str(username, 1, 128);
    str(password, 1, 1024);
    rate.check("login-user:" + hash(username), 10);
    const row = db
      .prepare("SELECT * FROM users WHERE username=?")
      .get(username) as any;
    const valid = passwordVerify(password, row?.password_hash ?? dummyPassword);
    if (!row || !valid || !row.enabled) {
      store.audit("user.login_failed", null, null, null, {
        username_hash: hash(username),
      });
      fail(401, "INVALID_CREDENTIALS");
    }
    return store.user(row);
  }
  function loginSession(user: User) {
    const accessToken = token();
    store.transaction(() => {
      db.prepare(
        "INSERT INTO user_sessions(token_hash,user_id,expires_at) VALUES(?,?,?)",
      ).run(hash(accessToken), user.id, Date.now() + sessionTtl);
      store.audit("user.login", user.id, null, null);
    });
    return accessToken;
  }
  app.post("/api/v1/login", async (req) => {
    const b = object(req.body);
    keys(b, ["username", "password"]);
    const user = passwordUser(b.username, b.password, req.ip);
    return { access_token: loginSession(user), user };
  });
  function sshUser(login: SshLogin) {
    const row = db
      .prepare(
        "SELECT u.* FROM user_sessions s JOIN users u ON u.id=s.user_id WHERE s.token_hash=? AND s.user_id=? AND s.expires_at>? AND u.enabled=1",
      )
      .get(login.sessionHash, login.user.id, Date.now());
    if (!row) fail(401, "SESSION_INVALID");
    const user = store.user(row);
    if (!hasPermission(user, "terminal.connect"))
      fail(403, "EXEC_ROLE_REQUIRED");
    return user;
  }
  let ssh: ReturnType<typeof createSshGateway> | undefined;
  const prepareSsh = () =>
    config.ssh
      ? createSshGateway(config.dataDir, config.ssh, {
          terminals,
          authenticate(username, password, target, ip) {
            if (config.deploymentControl?.terminalsBlocked())
              fail(503, "DEPLOYMENT_APPLYING");
            const user = passwordUser(username, password, ip);
            if (!hasPermission(user, "terminal.connect")) {
              store.audit("authorization.denied", user.id, null, null, {
                reason: "SSH_TARGET_DENIED",
                method: "SSH",
                route: "ssh",
              });
              fail(403, "SSH_TARGET_DENIED");
            }
            if (target === undefined)
              return { user, sessionHash: hash(loginSession(user)) };
            str(target, 1, 128);
            // Prefer stable device IDs; a name is accepted only if globally unique.
            const exact = db
              .prepare("SELECT id,revoked_at FROM devices WHERE id=?")
              .get(target) as any;
            const matches = exact
              ? [exact]
              : (db
                  .prepare(
                    "SELECT id,revoked_at FROM devices WHERE name=? LIMIT 2",
                  )
                  .all(target) as any[]);
            const device = matches.length === 1 ? matches[0] : undefined;
            if (
              !device ||
              device.revoked_at ||
              !inScope(user, device.id) ||
              !hasPermission(user, "terminal.connect")
            ) {
              store.audit(
                "authorization.denied",
                user.id,
                device?.id ?? null,
                null,
                { reason: "SSH_TARGET_DENIED", method: "SSH", route: "ssh" },
              );
              fail(403, "SSH_TARGET_DENIED");
            }
            return {
              user,
              deviceId: device.id,
              sessionHash: hash(loginSession(user)),
            };
          },
          currentUser: sshUser,
          devices(login, page) {
            rate.check("ssh-menu:" + login.sessionHash, 120);
            const user = sshUser(login);
            integer(page, 0, 1000000);
            const rows = db
              .prepare(
                "SELECT id,name,connection_kind FROM devices WHERE revoked_at IS NULL AND (? OR id IN (SELECT value FROM json_each(?))) ORDER BY name,id LIMIT ? OFFSET ?",
              )
              .all(
                Number(user.role === "admin" || user.device_scope === "*"),
                JSON.stringify(
                  user.device_scope === "*" ? [] : user.device_scope,
                ),
                SSH_MENU_PAGE_SIZE + 1,
                page * SSH_MENU_PAGE_SIZE,
              ) as { id: string; name: string; connection_kind: string }[];
            return {
              hasMore: rows.length > SSH_MENU_PAGE_SIZE,
              devices: rows.slice(0, SSH_MENU_PAGE_SIZE).map((device) => {
                const backend = terminals.backend(device.id);
                const c = connections.get(device.id);
                const online =
                  c?.ready &&
                  live(c) &&
                  Date.now() - c.lastHeartbeat <= heartbeatTimeout;
                return {
                  ...device,
                  status:
                    backend === "ssh"
                      ? device.connection_kind === "agent"
                        ? "ssh_fallback"
                        : "ssh"
                      : backend === "agent"
                        ? "online"
                        : online
                          ? "unsupported"
                          : "offline",
                };
              }),
            };
          },
          release(sessionHash) {
            db.prepare("DELETE FROM user_sessions WHERE token_hash=?").run(
              sessionHash,
            );
          },
        })
      : undefined;
  app.get("/api/v1/ssh", async (req) => {
    userAuth(req);
    return {
      v: 1,
      ...(ssh?.info() ?? {
        enabled: false,
        host: null,
        port: null,
        fingerprint: null,
      }),
    };
  });
  app.get("/api/v1/me", async (req) => ({
    v: 1,
    ...userAuth(req),
    runtime: {
      device_access: deviceAccess,
      web_enabled: webEnabled,
      web_protocol: tls ? "https" : "http",
    },
  }));
  app.post("/api/v1/enrollment-tokens", async (req) => {
    const user = admin(req);
    const b = object(req.body);
    version(b);
    keys(b, ["v", "name", "ttl_seconds"]);
    const name = b.name === undefined ? null : str(b.name, 1, 128);
    const expires =
      Date.now() + 1000 * integer(b.ttl_seconds ?? 3600, 60, 86400);
    const enrollmentToken = token();
    store.transaction(() => {
      db.prepare(
        "INSERT INTO enrollment_tokens(token_hash,expires_at,created_by,name) VALUES(?,?,?,?)",
      ).run(hash(enrollmentToken), expires, user.id, name);
      store.audit("enrollment.created", user.id, null, null, {
        expires_at: expires,
        name,
      });
    });
    return { v: 1, enrollment_token: enrollmentToken, expires_at: expires };
  });
  app.post("/api/agent/challenge", async (req) => {
    rate.check("challenge-global", 1000);
    rate.check("challenge-ip:" + req.ip, 120);
    const b = object(req.body);
    version(b);
    keys(b, ["v", "purpose", "public_key", "enrollment_token", "device_id"]);
    if (b.purpose !== "enroll" && b.purpose !== "auth")
      fail(400, "INVALID_PURPOSE");
    const publicKey = base64(b.public_key, 32);
    rate.check("challenge-key:" + hash(publicKey), 20);
    let deviceId: string | null = null;
    let enrollmentHash: string | null = null;
    if (b.purpose === "enroll") {
      if (b.device_id !== undefined) fail(400, "ENROLL_DEVICE_NOT_ALLOWED");
      enrollmentHash = hash(str(b.enrollment_token, 43, 43));
      const e = db
        .prepare(
          "SELECT * FROM enrollment_tokens WHERE token_hash=? AND expires_at>?",
        )
        .get(enrollmentHash, Date.now()) as any;
      if (!e) fail(401, "ENROLLMENT_INVALID");
      if (e.redeemed_device_id) {
        const d = requireDevice(e.redeemed_device_id);
        if (
          ![d.public_key, d.agent_pending_public_key].includes(publicKey) ||
          d.revoked_at !== null
        )
          fail(401, "ENROLLMENT_INVALID");
      }
    } else {
      if (b.enrollment_token !== undefined)
        fail(400, "AUTH_ENROLLMENT_NOT_ALLOWED");
      const d = db
        .prepare(
          "SELECT * FROM devices WHERE (public_key=? OR agent_pending_public_key=?) AND revoked_at IS NULL",
        )
        .get(publicKey, publicKey) as any;
      if (
        !d ||
        (b.device_id !== undefined && str(b.device_id, 1, 128) !== d.id)
      )
        fail(401, "DEVICE_AUTH_INVALID");
      deviceId = b.device_id === undefined ? null : d.id;
    }
    const id = randomUUID(),
      expires = Date.now() + 60000;
    const payload = [
      "fleet-v1",
      store.instance,
      b.purpose,
      id,
      randomBytes(32).toString("base64"),
      publicKey,
      deviceId ?? "",
      enrollmentHash ?? "",
      String(expires),
      "",
    ].join("\n");
    const encoded = Buffer.from(payload).toString("base64");
    db.prepare(
      "INSERT INTO challenges(id,purpose,public_key,device_id,enrollment_hash,signing_payload,expires_at) VALUES(?,?,?,?,?,?,?)",
    ).run(id, b.purpose, publicKey, deviceId, enrollmentHash, encoded, expires);
    return {
      v: 1,
      challenge_id: id,
      signing_payload: encoded,
      expires_at: expires,
    };
  });
  app.post("/api/agent/enroll", async (req) => {
    rate.check("proof-ip:" + req.ip, 120);
    const b = object(req.body);
    const c = challengeProof(b, "enroll");
    const name = str(b.name, 1, 128);
    return store.transaction(() => {
      const e = db
        .prepare(
          "SELECT * FROM enrollment_tokens WHERE token_hash=? AND expires_at>?",
        )
        .get(c.enrollment_hash, Date.now()) as any;
      if (!e) fail(401, "ENROLLMENT_INVALID");
      let device = installations.enrollTarget(e, c.public_key);
      if (!e.target_device_id) {
        if (
          db
            .prepare("SELECT 1 FROM devices WHERE agent_pending_public_key=?")
            .get(c.public_key)
        )
          fail(409, "AGENT_IDENTITY_ALREADY_BOUND");
        device = db
          .prepare("SELECT * FROM devices WHERE public_key=?")
          .get(c.public_key) as any;
      }
      if (
        e.redeemed_device_id &&
        (!device || e.redeemed_device_id !== device.id)
      )
        fail(401, "ENROLLMENT_REDEEMED");
      if (device?.revoked_at !== null && device) fail(401, "DEVICE_REVOKED");
      if (!device) {
        const id = randomUUID();
        db.prepare(
          "INSERT INTO devices(id,public_key,name,created_at) VALUES(?,?,?,?)",
        ).run(id, c.public_key, name, Date.now());
        device = { id };
      }
      db.prepare(
        "UPDATE enrollment_tokens SET redeemed_device_id=? WHERE token_hash=?",
      ).run(device.id, c.enrollment_hash);
      db.prepare("UPDATE challenges SET used=1 WHERE id=? AND used=0").run(
        c.id,
      );
      store.audit("device.enrolled", e.created_by, device.id, null, {
        recovered: !!e.redeemed_device_id,
      });
      return { v: 1, device_id: device.id };
    });
  });
  app.post("/api/agent/auth", async (req) => {
    rate.check("proof-ip:" + req.ip, 120);
    const c = challengeProof(object(req.body), "auth");
    return store.transaction(() => {
      const d = db
        .prepare(
          "SELECT * FROM devices WHERE (public_key=? OR agent_pending_public_key=?) AND revoked_at IS NULL",
        )
        .get(c.public_key, c.public_key) as any;
      if (!d || (c.device_id !== null && c.device_id !== d.id))
        fail(401, "DEVICE_AUTH_INVALID");
      db.prepare("UPDATE challenges SET used=1 WHERE id=? AND used=0").run(
        c.id,
      );
      const accessToken = token(),
        expires = Date.now() + deviceTtl;
      db.prepare(
        "INSERT INTO device_tokens(token_hash,device_id,scope,expires_at) VALUES(?,?,?,?)",
      ).run(hash(accessToken), d.id, "agent-control-output", expires);
      return {
        v: 1,
        device_id: d.id,
        access_token: accessToken,
        expires_at: expires,
      };
    });
  });
  app.get("/api/v1/devices", async (req) => {
    const user = permitted(req, "devices.read");
    const devices = (
      db.prepare("SELECT * FROM devices ORDER BY created_at,id").all() as any[]
    )
      .filter((d) => inScope(user, d.id))
      .map((d) => ({
        id: d.id,
        name: d.name,
        device_groups: db
          .prepare(
            "SELECT g.id,g.name FROM device_groups g JOIN device_group_members m ON m.group_id=g.id WHERE m.device_id=? ORDER BY g.name",
          )
          .all(d.id),
        control_online:
          !!connections.get(d.id)?.ready &&
          live(connections.get(d.id)!) &&
          Date.now() - connections.get(d.id)!.lastHeartbeat <= heartbeatTimeout,
        private_data_reachable: networkRoutes.snapshot(d.id).agent?.connected
          ? networkRoutes.snapshot(d.id).agent!.channel === "vpn"
          : null,
        network_route: networkRoutes.snapshot(d.id),
        business_healthy: health.summary(d.id),
        last_seen: d.last_seen,
        revoked_at: d.revoked_at,
        agent_version: d.agent_version,
        ip_addresses:
          d.connection_kind === "agent"
            ? (network.snapshot(d.id)?.addresses ?? []).map(
                (a: any) => a.address,
              )
            : [],
        connection_kind: d.connection_kind,
        ssh_configured: deviceConnections.hasSsh(d.id),
        terminal_backend: d.revoked_at ? null : terminals.backend(d.id),
        terminal_available: !d.revoked_at && !!terminals.backend(d.id),
        ...(deviceConnections.hasSsh(d.id)
          ? deviceConnections.status(d.id)
          : {}),
      }));
    return { v: 1, devices };
  });
  app.post("/api/v1/devices/:id/revoke", async (req) => {
    const user = admin(req);
    const b = object(req.body);
    version(b);
    keys(b, ["v"]);
    const id = str((req.params as any).id, 1, 128);
    requireDevice(id);
    store.transaction(() => {
      db.prepare(
        "UPDATE devices SET revoked_at=COALESCE(revoked_at,?) WHERE id=?",
      ).run(Date.now(), id);
      db.prepare("DELETE FROM device_tokens WHERE device_id=?").run(id);
      store.audit("device.revoked", user.id, id, null);
    });
    terminals.revoke(id);
    connections.get(id)?.socket.close(4003, "Device revoked");
    connections.delete(id);
    return { v: 1, ok: true };
  });
  app.post("/api/v1/commands", async (req) => {
    const user = operator(req);
    rate.check("commands:" + user.id, 60);
    const b = object(req.body);
    version(b);
    keys(b, [
      "v",
      "device_id",
      "argv",
      "cwd",
      "timeout_ms",
      "max_output_bytes",
      "ttl_seconds",
    ]);
    const deviceId = str(b.device_id, 1, 128);
    requireScope(user, deviceId);
    const d = requireDevice(deviceId);
    if (d.revoked_at !== null) fail(409, "DEVICE_REVOKED");
    if (d.connection_kind !== "agent") fail(409, "AGENT_REQUIRED_FOR_TASKS");
    if (!Array.isArray(b.argv) || b.argv.length < 1 || b.argv.length > 128)
      fail(400, "INVALID_ARGV");
    const argv = b.argv.map((x) => {
      const value = str(x, 1, 8192);
      if (Buffer.byteLength(value) > 8192) fail(400, "ARGUMENT_TOO_LARGE");
      return value;
    });
    if (argv.reduce((n, x) => n + Buffer.byteLength(x), 0) > 32768)
      fail(400, "ARGV_TOO_LARGE");
    if (argv[0]!.includes("/") && !isAbsolute(argv[0]!))
      fail(400, "RELATIVE_EXECUTABLE_DENIED");
    const cwd = str(b.cwd, 1, 4096);
    if (!isAbsolute(cwd)) fail(400, "ABSOLUTE_CWD_REQUIRED");
    const timeout = integer(b.timeout_ms, 100, 3600000),
      maxOutput = integer(b.max_output_bytes, 0, MAX_OBJECT),
      ttl = integer(b.ttl_seconds, 1, 86400);
    const key = str(req.headers["idempotency-key"], 1, 128);
    const requestHash = hash(
      canonical({
        device_id: deviceId,
        argv,
        cwd,
        timeout_ms: timeout,
        max_output_bytes: maxOutput,
        ttl_seconds: ttl,
      }),
    );
    const existing = db
      .prepare("SELECT * FROM idempotency WHERE actor_id=? AND key=?")
      .get(user.id, key) as any;
    if (existing) {
      if (existing.request_hash !== requestHash)
        fail(409, "IDEMPOTENCY_CONFLICT");
      const row = store.task(existing.task_id);
      return { v: 1, task_id: row.id, status: row.status };
    }
    if (upgrades.active(deviceId)) fail(409, "AGENT_UPGRADE_IN_PROGRESS");
    availableStorage();
    const pending = (
      db
        .prepare(
          "SELECT count(*) AS n FROM tasks WHERE device_id=? AND status NOT IN ('SUCCEEDED','FAILED','TIMED_OUT','CANCELLED','EXPIRED','UNKNOWN')",
        )
        .get(deviceId) as any
    ).n;
    if (pending >= 100) fail(429, "DEVICE_QUEUE_FULL");
    const now = Date.now();
    const immutable = {
      task_id: randomUUID(),
      device_id: deviceId,
      actor_id: user.id,
      action: "exec" as const,
      argv,
      cwd,
      created_at: now,
      expires_at: now + ttl * 1000,
      timeout_ms: timeout,
      max_output_bytes: maxOutput,
    };
    const task: Task = {
      ...immutable,
      payload_hash: hash(canonical(immutable)),
    };
    if (
      Buffer.byteLength(
        JSON.stringify({ v: 1, type: "task.assign", body: task }),
      ) > MAX_FRAME
    )
      fail(400, "TASK_FRAME_TOO_LARGE");
    store.transaction(() => {
      db.prepare(
        "INSERT INTO tasks(id,device_id,actor_id,task_json,payload_hash,status,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?)",
      ).run(
        task.task_id,
        deviceId,
        user.id,
        canonical(task),
        task.payload_hash,
        "QUEUED",
        now,
        now,
      );
      db.prepare(
        "INSERT INTO idempotency(actor_id,key,request_hash,task_id) VALUES(?,?,?,?)",
      ).run(user.id, key, requestHash, task.task_id);
      store.audit("task.created", user.id, deviceId, task.task_id, {
        action: "AGENT_EXEC",
        argv,
        cwd,
        role: user.role,
        authorized: true,
        payload_hash: task.payload_hash,
      });
    });
    dispatch(deviceId);
    return {
      v: 1,
      task_id: task.task_id,
      status: store.task(task.task_id).status,
    };
  });
  app.get("/api/v1/tasks", async (req) => {
    const user = permitted(req, "tasks.read");
    const { rows, page } = historyPage(db, user, "tasks", req.query);
    return { v: 1, tasks: rows.map((r) => store.taskView(r)), page };
  });
  app.get("/api/v1/tasks/:id", async (req) => {
    const user = permitted(req, "tasks.read");
    const row = store.task(str((req.params as any).id, 1, 128));
    requireScope(user, row.device_id);
    if (row.actor_id !== user.id && !canReadOtherHistory(user, "tasks"))
      fail(403, "PERMISSION_DENIED");
    return { v: 1, ...store.taskView(row) };
  });
  app.post("/api/v1/tasks/:id/cancel", async (req) => {
    const user = operator(req);
    const b = object(req.body);
    version(b);
    keys(b, ["v"]);
    const row = store.task(str((req.params as any).id, 1, 128));
    requireScope(user, row.device_id);
    if (user.role !== "admin" && row.actor_id !== user.id)
      fail(403, "TASK_OWNER_REQUIRED");
    if (!TERMINAL.has(row.status))
      store.transaction(() => {
        db.prepare(
          "UPDATE tasks SET cancel_requested=1,updated_at=? WHERE id=?",
        ).run(Date.now(), row.id);
        store.audit("task.cancel_requested", user.id, row.device_id, row.id);
      });
    dispatch(row.device_id);
    return { v: 1, ok: true, status: row.status };
  });
  app.get("/api/v1/audit", async (req) => {
    const user = permitted(req, "audit.read");
    const { rows, page } = historyPage(db, user, "audit", req.query);
    return {
      v: 1,
      audit: rows.map((r) => ({
        id: r.id,
        at: r.at,
        actor_id: r.actor_id,
        actor_username: r.actor_name,
        device_name: r.device_label,
        target_name: r.target_name,
        context: r.request_context ? JSON.parse(r.request_context) : null,
        device_id: r.device_id,
        task_id: r.task_id,
        action: r.action,
        detail: JSON.parse(r.detail_json),
      })),
      page,
    };
  });
  app.put(
    "/api/agent/tasks/:task_id/artifacts/:sha256",
    {
      bodyLimit: MAX_OBJECT,
      onRequest: async (req) => {
        deviceAuth(req);
      },
    },
    async (req) => {
      const device = deviceAuth(req);
      rate.check("artifact:" + device.id, 240);
      const params = req.params as any;
      const taskId = str(params.task_id, 1, 128),
        sha = digest(params.sha256);
      const row = store.task(taskId);
      if (row.device_id !== device.id) fail(403, "TASK_DEVICE_MISMATCH");
      if (!Buffer.isBuffer(req.body)) fail(415, "BINARY_BODY_REQUIRED");
      const data = req.body;
      if (hash(data) !== sha) fail(422, "ARTIFACT_HASH_MISMATCH");
      const previous = db
        .prepare("SELECT * FROM artifacts WHERE task_id=? AND sha256=?")
        .get(taskId, sha) as any;
      if (previous) {
        if (previous.size !== data.length) fail(409, "ARTIFACT_CONFLICT");
        return { v: 1, sha256: sha, size: data.length };
      }
      if (TERMINAL.has(row.status)) fail(409, "TASK_TERMINAL");
      const task = JSON.parse(row.task_json) as Task;
      const total = db
        .prepare(
          "SELECT COALESCE(SUM(size),0) AS n,COUNT(*) AS count FROM artifacts WHERE task_id=?",
        )
        .get(taskId) as any;
      if (total.count >= 4 || total.n + data.length > task.max_output_bytes)
        fail(413, "TASK_OUTPUT_LIMIT");
      availableStorage();
      const directory = join(artifactRoot, taskId);
      mkdirSync(directory, { recursive: true, mode: 0o700 });
      syncDir(artifactRoot);
      const relative = join(taskId, sha),
        finalPath = join(artifactRoot, relative),
        temp = join(directory, ".tmp-" + randomUUID());
      let fd: number | undefined;
      try {
        fd = openSync(temp, "wx", 0o600);
        writeFileSync(fd, data);
        fsyncSync(fd);
        closeSync(fd);
        fd = undefined;
        renameSync(temp, finalPath);
        syncDir(directory);
        db.prepare(
          "INSERT INTO artifacts(task_id,sha256,size,relative_path,created_at) VALUES(?,?,?,?,?)",
        ).run(taskId, sha, data.length, relative, Date.now());
      } finally {
        if (fd !== undefined) closeSync(fd);
        try {
          unlinkSync(temp);
        } catch {}
      }
      return { v: 1, sha256: sha, size: data.length };
    },
  );
  app.get("/api/v1/tasks/:task_id/output/:stream", async (req, reply) => {
    const params = req.params as any;
    const row = store.task(str(params.task_id, 1, 128));
    const user = permitted(req, "tasks.read");
    requireScope(user, row.device_id);
    if (row.actor_id !== user.id && !canReadOtherHistory(user, "tasks"))
      fail(403, "PERMISSION_DENIED");
    const actor = user.id;
    const stream = str(params.stream, 1, 16);
    if (stream !== "stdout" && stream !== "stderr") fail(400, "INVALID_STREAM");
    const result = row.result_json ? JSON.parse(row.result_json) : null;
    const ref = result?.[stream];
    if (!ref?.sha256) fail(404, "OUTPUT_NOT_AVAILABLE");
    const artifact = db
      .prepare("SELECT * FROM artifacts WHERE task_id=? AND sha256=?")
      .get(row.id, ref.sha256) as any;
    if (!artifact) fail(503, "ARTIFACT_UNAVAILABLE");
    const data = readFileSync(join(artifactRoot, artifact.relative_path));
    if (data.length !== artifact.size || hash(data) !== artifact.sha256)
      fail(503, "ARTIFACT_CORRUPT");
    store.audit("output.viewed", actor, row.device_id, row.id, {
      stream,
      sha256: artifact.sha256,
      size: artifact.size,
    });
    return reply
      .header("content-type", "application/octet-stream")
      .header("content-disposition", `attachment; filename="${stream}.bin"`)
      .send(data);
  });
  function validateEvent(input: unknown): TaskEvent {
    const b = object(input);
    keys(b, ["event_id", "task_id", "seq", "kind", "at", "payload"]);
    const eventId = str(b.event_id, 36, 36);
    if (
      !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(
        eventId,
      )
    )
      fail(400, "INVALID_EVENT_ID");
    const taskId = str(b.task_id, 1, 128),
      seq = integer(b.seq, 1, 3),
      at = integer(b.at, 0, Number.MAX_SAFE_INTEGER);
    if (!["accepted", "started", "finished"].includes(b.kind))
      fail(400, "INVALID_EVENT_KIND");
    const payload = object(b.payload);
    if (b.kind !== "finished") keys(payload, []);
    else {
      keys(payload, [
        "status",
        "exit_code",
        "reason",
        "audit_complete",
        "stdout",
        "stderr",
        "started_at",
        "finished_at",
        "cleanup",
      ]);
      if (!TERMINAL.has(payload.status)) fail(400, "INVALID_RESULT_STATUS");
      if (payload.exit_code !== null)
        integer(payload.exit_code, -2147483648, 2147483647);
      if (payload.reason !== null) str(payload.reason, 0, 4096);
      if (typeof payload.audit_complete !== "boolean")
        fail(400, "INVALID_AUDIT_STATUS");
      if (payload.started_at !== null)
        integer(payload.started_at, 0, Number.MAX_SAFE_INTEGER);
      integer(payload.finished_at, 0, Number.MAX_SAFE_INTEGER);
      if (
        payload.started_at !== null &&
        payload.finished_at < payload.started_at
      )
        fail(400, "INVALID_EVENT_TIME");
      if (
        !["process_group", "unconfirmed", "not_started"].includes(
          payload.cleanup,
        )
      )
        fail(400, "INVALID_CLEANUP");
      if (payload.status === "UNKNOWN" && payload.audit_complete)
        fail(400, "UNKNOWN_AUDIT_INCOMPLETE");
      for (const stream of ["stdout", "stderr"]) {
        const ref = payload[stream];
        if (ref === null) {
          if (
            payload.cleanup !== "not_started" &&
            !(payload.status === "UNKNOWN" && payload.audit_complete === false)
          )
            fail(400, "MISSING_RESULT_OUTPUT");
        } else {
          const r = object(ref);
          if (Object.keys(r).length) {
            keys(r, ["sha256", "size"]);
            digest(r.sha256);
            integer(r.size, 0, MAX_OBJECT);
          } else if (payload.cleanup !== "not_started")
            fail(400, "EMPTY_RESULT_OUTPUT");
        }
      }
    }
    return {
      event_id: eventId,
      task_id: taskId,
      seq,
      kind: b.kind,
      at,
      payload,
    };
  }
  function receiveEvent(deviceId: string, input: unknown) {
    const event = validateEvent(input);
    return store.transaction(() => {
      const row = store.task(event.task_id);
      if (row.device_id !== deviceId) fail(403, "TASK_DEVICE_MISMATCH");
      const serialized = canonical(event);
      const existing = db
        .prepare("SELECT * FROM events WHERE event_id=?")
        .get(event.event_id) as any;
      if (existing) {
        if (
          existing.device_id !== deviceId ||
          existing.event_json !== serialized
        )
          fail(409, "EVENT_ID_CONFLICT");
        return event;
      }
      if (TERMINAL.has(row.status)) fail(409, "TASK_TERMINAL");
      if (event.seq !== row.last_seq + 1) fail(409, "EVENT_GAP");
      if (
        event.kind === "accepted" &&
        (event.seq !== 1 || !["QUEUED", "SENT"].includes(row.status))
      )
        fail(409, "INVALID_TRANSITION");
      if (event.kind === "started" && row.status !== "ACCEPTED")
        fail(409, "INVALID_TRANSITION");
      if (
        event.kind === "finished" &&
        !["ACCEPTED", "RUNNING"].includes(row.status)
      )
        fail(409, "INVALID_TRANSITION");
      if (event.kind === "finished") {
        const p = event.payload;
        const task = JSON.parse(row.task_json) as Task;
        if (row.status === "RUNNING" && p.cleanup === "not_started")
          fail(409, "STARTED_CLEANUP_CONFLICT");
        if (row.status === "ACCEPTED" && p.started_at !== null)
          fail(409, "START_TIME_WITHOUT_EVENT");
        if (p.status === "SUCCEEDED" && !p.audit_complete)
          fail(409, "SUCCESS_AUDIT_INCOMPLETE");
        if (
          ["TIMED_OUT", "CANCELLED"].includes(p.status as string) &&
          p.cleanup === "unconfirmed"
        )
          fail(409, "CLEANUP_UNCONFIRMED_REQUIRES_UNKNOWN");
        if (p.status === "SUCCEEDED" && row.status !== "RUNNING")
          fail(409, "SUCCESS_WITHOUT_START");
        if (p.status === "EXPIRED" && row.status === "RUNNING")
          fail(409, "EXPIRED_AFTER_START");
        let bytes = 0;
        for (const stream of ["stdout", "stderr"]) {
          const ref = p[stream] as any;
          if (ref?.sha256) {
            const a = db
              .prepare("SELECT * FROM artifacts WHERE task_id=? AND sha256=?")
              .get(event.task_id, ref.sha256) as any;
            if (
              !a ||
              a.size !== ref.size ||
              !existsSync(join(artifactRoot, a.relative_path))
            )
              fail(409, "ARTIFACT_NOT_DURABLE");
            const bytesOnDisk = readFileSync(
              join(artifactRoot, a.relative_path),
            );
            if (bytesOnDisk.length !== a.size || hash(bytesOnDisk) !== a.sha256)
              fail(409, "ARTIFACT_NOT_DURABLE");
            bytes += ref.size;
          } else if (p.audit_complete && p.cleanup !== "not_started")
            fail(409, "COMPLETE_OUTPUT_REQUIRED");
        }
        if (bytes > task.max_output_bytes) fail(413, "TASK_OUTPUT_LIMIT");
      }
      const status =
        event.kind === "accepted"
          ? "ACCEPTED"
          : event.kind === "started"
            ? "RUNNING"
            : (event.payload.status as string);
      db.prepare(
        "INSERT INTO events(event_id,device_id,task_id,seq,kind,event_json,created_at) VALUES(?,?,?,?,?,?,?)",
      ).run(
        event.event_id,
        deviceId,
        event.task_id,
        event.seq,
        event.kind,
        serialized,
        Date.now(),
      );
      db.prepare(
        "UPDATE tasks SET status=?,last_seq=?,result_json=?,updated_at=? WHERE id=?",
      ).run(
        status,
        event.seq,
        event.kind === "finished" ? canonical(event.payload) : null,
        Date.now(),
        event.task_id,
      );
      store.audit("task." + event.kind, row.actor_id, deviceId, event.task_id, {
        event_id: event.event_id,
        seq: event.seq,
        at: event.at,
        payload: event.payload,
      });
      return event;
    });
  }
  app.get(
    "/agent/address-probe",
    {
      websocket: true,
      preValidation: async (req) => {
        deviceAuth(req);
        if (Object.keys(req.query as object).length)
          fail(400, "WS_QUERY_NOT_ALLOWED");
      },
    },
    (socket) => {
      socket.on("error", () => {});
      socket.send(
        JSON.stringify({
          v: 1,
          type: "agent.address.ready",
          body: { server_instance: store.instance },
        }),
      );
      socket.close(1000, "Probe complete");
    },
  );
  app.get(
    "/agent/ws",
    {
      websocket: true,
      preValidation: async (req) => {
        deviceAuth(req);
        if (Object.keys(req.query as object).length)
          fail(400, "WS_QUERY_NOT_ALLOWED");
      },
    },
    (socket, req) => {
      const auth = deviceAuth(req);
      const c: Connection = {
        socket,
        deviceId: auth.id,
        tokenHash: auth.token_hash,
        expiresAt: auth.expires_at,
        lastHeartbeat: Date.now(),
        ready: false,
        terminal: false,
        health: false,
        address: false,
        trust: false,
        network: false,
        networkProbes: false,
        route: false,
        healthSession: randomUUID(),
      };
      const old = connections.get(auth.id);
      if (old) terminals.disconnect(auth.id);
      connections.set(auth.id, c);
      old?.socket.close(4001, "Superseded connection");
      socket.on("error", () => {});
      socket.on("close", () => {
        if (connections.get(auth.id) === c) {
          terminals.disconnect(auth.id);
          connections.delete(auth.id);
        }
      });
      socket.on("message", (data, isBinary) => {
        try {
          if (!live(c)) {
            socket.close(4003, "Authorization expired");
            return;
          }
          if (isBinary) fail(400, "JSON_TEXT_REQUIRED");
          const env = object(JSON.parse(data.toString()));
          keys(env, ["v", "type", "body"]);
          version(env);
          const b = object(env.body);
          rate.check(
            (String(env.type).startsWith("terminal.")
              ? "terminal-output:"
              : "ws:") + c.deviceId,
            String(env.type).startsWith("terminal.") ? 12000 : 1200,
          );
          if (env.type === "agent.hello" || env.type === "agent.heartbeat") {
            keys(b, [
              "agent_version",
              "capabilities",
              "server_url",
              "runtime",
              "trusted_ca_fingerprints",
            ]);
            if (b.capabilities !== undefined) {
              if (
                !Array.isArray(b.capabilities) ||
                b.capabilities.length > 10 ||
                b.capabilities.some(
                  (x: unknown) => typeof x !== "string" || x.length > 64,
                )
              )
                fail(400, "INVALID_CAPABILITIES");
              c.route = b.capabilities.includes("agent.route.v1");
              c.terminal = b.capabilities.includes("terminal.pty.v1");
              c.health = b.capabilities.includes("health.probes.v1");
              c.address = b.capabilities.includes("agent.address.v1");
              c.trust = b.capabilities.includes("agent.trust.v1");
              c.network = b.capabilities.includes("agent.network.v1");
              c.networkProbes = b.capabilities.includes(
                "agent.network.probes.v1",
              );
            }
            const agentVersion = str(b.agent_version, 1, 128);
            if (env.type === "agent.heartbeat" && !c.ready)
              fail(400, "HELLO_REQUIRED");
            store.transaction(() => {
              if (env.type === "agent.hello") {
                c.upgrade = upgrades.remember(
                  c.deviceId,
                  agentVersion,
                  b.runtime,
                  Array.isArray(b.capabilities) &&
                    b.capabilities.includes("agent.upgrade.v1"),
                );
                installations.activate(c.deviceId);
                caSync.remember(c.deviceId, c.trust, b.trusted_ca_fingerprints);
              }
              c.lastHeartbeat = Date.now();
              db.prepare(
                "UPDATE devices SET last_seen=?,agent_version=? WHERE id=?",
              ).run(c.lastHeartbeat, agentVersion, c.deviceId);
            });
            if (!c.ready) {
              c.ready = true;
              if (c.address) {
                send(c, "agent.address.ready", {
                  server_instance: store.instance,
                });
                if (!networkRoutes.current(c.deviceId).policy)
                  settings.sync.connected(
                    c.deviceId,
                    b.server_url,
                    settings.current(),
                  );
              }
              if (c.networkProbes)
                send(
                  c,
                  "agent.network.probe.config",
                  networkProbes.config(c.deviceId),
                );
              networkRoutes.deliver(c.deviceId);
              caSync.connected(c.deviceId);
              dispatch(c.deviceId, true);
              if (c.health)
                send(c, "health.config", health.snapshot(c.deviceId));
            }
          } else if (env.type === "agent.route.status") {
            networkRoutes.receive(c.deviceId, b);
            dispatch(c.deviceId);
          } else if (String(env.type).startsWith("agent.network.probe.")) {
            if (!c.ready || !c.networkProbes)
              fail(400, "NETWORK_PROBES_HELLO_REQUIRED");
            if (env.type === "agent.network.probe.configured")
              networkProbes.applied(c.deviceId, b);
            else if (env.type === "agent.network.probe.latest")
              networkProbes.latest(c.deviceId, b);
            else if (env.type === "agent.network.probe.event")
              send(
                c,
                "agent.network.probe.ack",
                networkProbes.event(c.deviceId, b),
              );
            else fail(400, "UNKNOWN_MESSAGE_TYPE");
          } else if (
            env.type === "agent.network" ||
            env.type === "agent.network.event"
          ) {
            if (!c.ready || !c.network) fail(400, "NETWORK_HELLO_REQUIRED");
            if (env.type === "agent.network") network.receive(c.deviceId, b);
            else send(c, "agent.network.ack", network.event(c.deviceId, b));
          } else if (env.type === "agent.upgrade.result") {
            if (!c.ready || !c.upgrade?.supported) fail(400, "HELLO_REQUIRED");
            upgrades.result(c.deviceId, b);
          } else if (env.type === "agent.trust.result") {
            if (!c.ready || !c.trust) fail(400, "HELLO_REQUIRED");
            caSync.result(c.deviceId, b);
          } else if (env.type === "agent.address.result") {
            if (!c.ready || !c.address) fail(400, "HELLO_REQUIRED");
            settings.sync.result(c.deviceId, b);
          } else if (env.type === "agent.reauth") {
            keys(b, ["access_token"]);
            const th = hash(str(b.access_token, 43, 43));
            const renewed = db
              .prepare(
                "SELECT expires_at FROM device_tokens WHERE token_hash=? AND device_id=? AND scope='agent-control-output' AND expires_at>?",
              )
              .get(th, c.deviceId, Date.now()) as any;
            if (!renewed) fail(401, "DEVICE_AUTH_INVALID");
            c.tokenHash = th;
            c.expiresAt = renewed.expires_at;
          } else if (env.type === "health.result") {
            if (!c.ready || !c.health) fail(400, "HEALTH_HELLO_REQUIRED");
            health.receive(c.deviceId, b);
          } else if (String(env.type).startsWith("terminal.")) {
            if (!c.ready) fail(400, "HELLO_REQUIRED");
            terminals.receive(c.deviceId, env.type, b);
          } else if (env.type === "task.event") {
            if (!c.ready) fail(400, "HELLO_REQUIRED");
            const event = receiveEvent(c.deviceId, b);
            const drop = dropAcks.findIndex(
              (x) => x === "*" || x === event.kind,
            );
            if (drop >= 0) dropAcks.splice(drop, 1);
            else
              send(c, "event.ack", {
                event_id: event.event_id,
                task_id: event.task_id,
                seq: event.seq,
              });
          } else fail(400, "UNKNOWN_MESSAGE_TYPE");
        } catch (e) {
          const err =
            e instanceof ApiError ? e : new ApiError(400, "INVALID_FRAME");
          send(c, "error", { code: err.code });
          if (
            [401, 403, 429].includes(err.statusCode) ||
            err.code === "INVALID_FRAME" ||
            err.code === "UNSUPPORTED_VERSION"
          )
            socket.close(4002, err.code);
        }
      });
    },
  );
  if (config.webDist) {
    const root = realpathSync(resolve(config.webDist));
    const serve = async (req: FastifyRequest, reply: any) => {
      const pathname = new URL(req.url, "https://localhost").pathname;
      if (
        pathname === "/api" ||
        pathname === "/agent" ||
        pathname.startsWith("/api/") ||
        pathname.startsWith("/agent/")
      )
        fail(404, "NOT_FOUND");
      let decoded: string;
      try {
        decoded = decodeURIComponent(pathname);
      } catch {
        fail(400, "INVALID_PATH");
      }
      if (
        decoded.includes("\\") ||
        decoded.includes("\0") ||
        decoded.split("/").some((part) => part.startsWith(".") && part !== "")
      )
        fail(404, "NOT_FOUND");
      let path = resolve(root, "." + decoded);
      if (!path.startsWith(root + "/") && path !== root) fail(404, "NOT_FOUND");
      if (!existsSync(path) || statSync(path).isDirectory()) {
        if (extname(path)) fail(404, "NOT_FOUND");
        path = join(root, "index.html");
      }
      const actual = realpathSync(path);
      if (!actual.startsWith(root + "/")) fail(404, "NOT_FOUND");
      const mime: Record<string, string> = {
        ".html": "text/html; charset=utf-8",
        ".js": "text/javascript; charset=utf-8",
        ".css": "text/css; charset=utf-8",
        ".svg": "image/svg+xml",
        ".png": "image/png",
        ".ico": "image/x-icon",
        ".woff2": "font/woff2",
        ".json": "application/json",
      };
      reply.header(
        "content-security-policy",
        "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'; object-src 'none'; frame-ancestors 'none'; base-uri 'self'",
      );
      return reply
        .type(mime[extname(actual)] ?? "application/octet-stream")
        .send(readFileSync(actual));
    };
    app.get("/", serve);
    app.get("/*", serve);
  }
  let ticks = 0;
  const timer = setInterval(() => {
    try {
      const now = Date.now();
      ++ticks;
      terminals.tick();
      settings.sync.flush();
      caSync.flush();
      upgrades.tick();
      for (const c of connections.values()) {
        if (!live(c) || now - c.lastHeartbeat > heartbeatTimeout) {
          terminals.disconnect(c.deviceId);
          c.socket.close(4003, "Authorization or heartbeat expired");
          if (connections.get(c.deviceId) === c) connections.delete(c.deviceId);
        } else if (ticks % 5 === 0) dispatch(c.deviceId);
      }
      db.prepare("DELETE FROM challenges WHERE expires_at<?").run(now - 60000);
      db.prepare("DELETE FROM device_tokens WHERE expires_at<?").run(now);
      db.prepare("DELETE FROM user_sessions WHERE expires_at<?").run(now);
    } catch {
      terminals.close();
      for (const c of connections.values())
        c.socket.close(1011, "Storage unavailable");
    }
  }, 1000);
  timer.unref();
  app.addHook("onClose", async () => {
    clearInterval(timer);
    terminals.close();
    await ssh?.close();
    await deviceConnections.close();
    for (const c of connections.values()) c.socket.terminate();
    connections.clear();
    store.close();
  });
  const testHooks = config.testMode
    ? {
        dropNextAck(kind: "accepted" | "started" | "finished" | "*" = "*") {
          dropAcks.push(kind);
        },
        disconnectDevice(id: string) {
          connections.get(id)?.socket.terminate();
        },
        replayTask(id: string) {
          const row = store.task(id),
            c = connections.get(row.device_id);
          if (c) send(c, "task.assign", JSON.parse(row.task_json));
        },
        receiveEvent,
        connections: () => connections.size,
      }
    : undefined;
  await app.ready();
  try {
    ssh = prepareSsh();
    await ssh?.listen();
  } catch (error) {
    await app.close();
    throw error;
  }
  return { app, store, testHooks, ssh, close: () => app.close() };
}
