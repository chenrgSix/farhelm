import { X509Certificate, createPrivateKey } from "node:crypto";
import { chmodSync, existsSync, readFileSync } from "node:fs";
import { createServer } from "node:http";
import { join, resolve } from "node:path";
import { createSecureContext } from "node:tls";
import type { buildServer } from "./server.js";
import { deployment } from "./deployment.js";
import { runtimeConfig } from "./runtime-config.js";
import { prepareLocalAdmin } from "./local-admin.js";
import {
  certificateMatches,
  managedCertificate,
  privateFile,
  validateCertificate,
} from "./certificate-files.js";
import { fail, integer, keys, object, str, version } from "./util.js";

export interface DeploymentSettings {
  device_access: "agent-ssh" | "ssh-only";
  web_enabled: boolean;
  web_protocol: "http" | "https";
}
type Snapshot = {
  settings: DeploymentSettings;
  entry_url: string | null;
  web_origin: string | null;
};
type Saved = Snapshot & {
  v: 1;
  revision: number;
  listener_port: number;
  agent_listener_port?: number;
  ssh_port: number;
  previous: Snapshot | null;
  state: "idle" | "applying" | "awaiting_confirmation" | "rolled_back";
  confirm_by: number | null;
  last_error: string | null;
};
type Running = Awaited<ReturnType<typeof buildServer>>;
const pem = (value: string | Buffer) =>
  Buffer.isBuffer(value) || value.includes("-----BEGIN ")
    ? value
    : readFileSync(value);
export function parseDeployment(value: unknown): DeploymentSettings {
  const b = object(value);
  keys(b, ["device_access", "web_enabled", "web_protocol"]);
  if (
    !["agent-ssh", "ssh-only"].includes(b.device_access) ||
    typeof b.web_enabled !== "boolean" ||
    !["http", "https"].includes(b.web_protocol)
  )
    fail(400, "INVALID_DEPLOYMENT_SETTINGS");
  return {
    device_access: b.device_access,
    web_enabled: b.web_enabled,
    web_protocol: b.web_protocol,
  };
}

// The journal is independent of SQLite so startup can select the listener before
// opening the application database or recovering terminal sessions.
export class DeploymentController {
  private saved!: Saved;
  private running?: Running;
  private activeSettings?: DeploymentSettings;
  private restartRequired = true;
  private control?: ReturnType<typeof createServer>;
  private timer?: NodeJS.Timeout;
  private operation?: Promise<void>;
  private applying = false;
  private stopping = false;
  private readonly env: NodeJS.ProcessEnv;
  readonly dataDir: string;
  readonly path: string;
  constructor(
    env: NodeJS.ProcessEnv,
    private readonly build: typeof buildServer,
    private readonly confirmationMs = 120_000,
  ) {
    this.env = { ...env };
    this.dataDir = resolve(env.FLEET_DATA_DIR ?? "./data");
    this.path = join(this.dataDir, "deployment.json");
  }
  busy() {
    return this.applying && this.restartRequired;
  }
  legacyAgentEntryEnabled() {
    return (
      this.saved.settings.web_enabled &&
      this.saved.settings.web_protocol === "https"
    );
  }
  terminalsBlocked() {
    return this.restartRequired && (this.applying || !!this.saved.previous);
  }
  private write(next: Saved) {
    privateFile(this.path, JSON.stringify(next) + "\n");
    this.saved = next;
  }
  private config(settings: DeploymentSettings) {
    return runtimeConfig({
      ...this.env,
      FLEET_DEVICE_ACCESS: settings.device_access,
      FLEET_WEB_ENABLED: settings.web_enabled ? "1" : "0",
      FLEET_WEB_PROTOCOL: settings.web_protocol,
    });
  }
  private async launch(snapshot: Snapshot) {
    const { config, host, port, agentPort } = this.config(snapshot.settings);
    config.deploymentControl = this;
    if (snapshot.entry_url) config.consoleOrigin = snapshot.entry_url;
    const socket =
      config.deviceAccess === "ssh-only"
        ? await prepareLocalAdmin(this.dataDir)
        : undefined;
    const server = await this.build(config);
    try {
      if (socket) {
        await server.app.listen({ path: socket });
        chmodSync(socket, 0o600);
      } else await server.app.listen({ host, port: agentPort });
      await server.configureWeb(
        {
          host,
          port: port ?? this.saved.listener_port,
          enabled: snapshot.settings.web_enabled,
          protocol: snapshot.settings.web_protocol,
        },
        snapshot.web_origin,
      );
    } catch (error) {
      await server.close();
      throw error;
    }
    this.running = server;
    this.activeSettings = { ...snapshot.settings };
    console.log(
      `Farhelm web: ${snapshot.settings.web_enabled ? snapshot.settings.web_protocol + "://" + host + ":" + (port ?? this.saved.listener_port) : "disabled"}; Agent: ${socket ? "disabled" : "https://" + host + ":" + agentPort}`,
    );
    if (server.ssh) {
      console.log(
        `Farhelm SSH listening on ${config.ssh!.host}:${config.ssh!.port}`,
      );
      console.log(
        `Farhelm SSH host fingerprint: ${server.ssh.info().fingerprint}`,
      );
    }
  }
  async start() {
    // This private recovery socket also prevents two CLI instances opening the
    // same database and interrupting each other's live sessions.
    const socket = await prepareLocalAdmin(this.dataDir, "deployment.sock");
    this.control = createServer((req, res) => {
      res.setHeader("Content-Type", "application/json");
      res.setHeader("Cache-Control", "no-store");
      if (req.method !== "POST" || req.url !== "/enable-web") {
        res.writeHead(404).end('{"error":"NOT_FOUND"}');
        return;
      }
      try {
        if (!this.running || this.stopping) fail(503, "DEPLOYMENT_APPLYING");
        const result = this.prepare(
          {
            v: 1,
            revision: this.saved.revision,
            settings: {
              ...this.saved.settings,
              web_enabled: true,
              web_protocol: this.saved.settings.web_protocol,
            },
            confirm_web_disable: false,
          },
          null,
        );
        res.once("finish", () => this.apply());
        res.end(JSON.stringify(result));
      } catch (error: any) {
        res
          .writeHead(error.statusCode ?? 500)
          .end(JSON.stringify({ error: error.code ?? "RECOVERY_FAILED" }));
      }
    });
    this.control.requestTimeout = 5000;
    this.control.headersTimeout = 5000;
    await new Promise<void>((resolve, reject) =>
      this.control!.once("error", reject).listen(socket, resolve),
    );
    chmodSync(socket, 0o600);
    try {
      let interrupted = false;
      if (existsSync(this.path)) {
        const saved = JSON.parse(readFileSync(this.path, "utf8")) as Saved;
        if (
          saved.v !== 1 ||
          !Number.isSafeInteger(saved.revision) ||
          saved.revision < 0 ||
          !Number.isInteger(saved.listener_port) ||
          saved.listener_port < 1 ||
          saved.listener_port > 65535 ||
          !Number.isInteger(saved.ssh_port) ||
          saved.ssh_port < 0 ||
          saved.ssh_port > 65535
        )
          throw Error("Invalid deployment journal");
        if (
          saved.agent_listener_port !== undefined &&
          (!Number.isInteger(saved.agent_listener_port) ||
            saved.agent_listener_port < 1 ||
            saved.agent_listener_port > 65535)
        )
          throw Error("Invalid Agent listening port");
        saved.settings = parseDeployment(saved.settings);
        if (saved.previous) {
          interrupted = true;
          saved.previous.settings = parseDeployment(saved.previous.settings);
          this.write({
            ...saved,
            ...saved.previous,
            previous: null,
            revision: saved.revision + 1,
            state: "rolled_back",
            confirm_by: null,
            last_error: "APPLY_INTERRUPTED",
          });
        } else this.saved = saved;
      } else {
        const original = runtimeConfig(this.env);
        const d = deployment(original.config);
        this.saved = {
          v: 1,
          revision: 0,
          settings: {
            device_access: d.deviceAccess,
            web_enabled: d.webEnabled,
            web_protocol: d.webProtocol,
          },
          entry_url: null,
          web_origin: this.env.FLEET_CONSOLE_ORIGIN ?? null,
          listener_port: original.port ?? (d.tls ? 8443 : 8080),
          ssh_port: original.config.ssh?.port ?? 0,
          agent_listener_port: original.agentPort,
          previous: null,
          state: "idle",
          confirm_by: null,
          last_error: null,
        };
      }
      // Keep the existing listening port when changing protocol, even if the
      // initial deployment relied on its default port.
      this.env.FLEET_PORT ??= String(this.saved.listener_port);
      this.env.FLEET_SSH_PORT ??= String(this.saved.ssh_port);
      this.env.FLEET_AGENT_PORT ??= String(
        this.saved.agent_listener_port ??
          (this.saved.listener_port === 8444 ? 8445 : 8444),
      );
      this.saved.agent_listener_port = Number(this.env.FLEET_AGENT_PORT);
      await this.launch(this.saved);
      if (interrupted)
        this.running!.store.audit("deployment.rolled_back", null, null, null, {
          revision: this.saved.revision,
          code: "APPLY_INTERRUPTED",
        });
      this.write(this.saved);
    } catch (error) {
      await this.stop();
      throw error;
    }
  }
  private activeTerminals() {
    return (
      this.running!.store.db.prepare(
        "SELECT count(*) n FROM terminal_sessions WHERE ended_at IS NULL",
      ).get() as { n: number }
    ).n;
  }
  private tlsReady() {
    try {
      const { config } = this.config({
        device_access: "ssh-only",
        web_enabled: true,
        web_protocol: "https",
      });
      const managed = managedCertificate(this.dataDir);
      if (managed) validateCertificate(managed, Date.now());
      const cert = new X509Certificate(pem(managed?.cert ?? config.tlsCert!));
      const key = pem(managed?.key ?? config.tlsKey!);
      if (
        cert.ca ||
        (cert.keyUsage && !cert.keyUsage.includes("1.3.6.1.5.5.7.3.1")) ||
        !cert.checkPrivateKey(createPrivateKey(key)) ||
        Date.parse(cert.validFrom) > Date.now() ||
        Date.parse(cert.validTo) <= Date.now()
      )
        throw Error("Invalid TLS identity");
      createSecureContext({ cert: pem(managed?.cert ?? config.tlsCert!), key });
      return { cert, domain: managed?.domain ?? null };
    } catch {
      return undefined;
    }
  }
  snapshot() {
    return {
      v: 1,
      revision: this.saved.revision,
      settings: this.saved.settings,
      state: this.saved.state,
      entry_url: this.saved.entry_url,
      rollback_url: this.saved.previous?.entry_url ?? null,
      confirm_by: this.saved.confirm_by,
      last_error: this.saved.last_error,
      active_terminals: this.activeTerminals(),
      https_ready: !!this.tlsReady(),
      agent_https_port: Number(
        this.env.FLEET_AGENT_PUBLIC_PORT ?? this.env.FLEET_AGENT_PORT,
      ),
      agents_on_web: this.running?.legacyAgentConnections() ?? 0,
      web_reload_supported: this.running?.webReady("https") ?? false,
      recovery_command: `node apps/server/dist/enable-web.js --data-dir '${this.dataDir.replaceAll("'", "'\\''")}'`,
    };
  }
  prepare(value: unknown, actor: string | null) {
    const b = object(value);
    keys(b, [
      "v",
      "revision",
      "settings",
      "entry_origin",
      "confirm_web_disable",
    ]);
    version(b);
    integer(b.revision, 0, Number.MAX_SAFE_INTEGER);
    const settings = parseDeployment(b.settings);
    if (
      b.confirm_web_disable !== undefined &&
      typeof b.confirm_web_disable !== "boolean"
    )
      fail(400, "INVALID_DEPLOYMENT_SETTINGS");
    if (this.applying || this.saved.previous || this.stopping)
      fail(409, "DEPLOYMENT_APPLYING");
    if (b.revision !== this.saved.revision)
      fail(409, "DEPLOYMENT_REVISION_CONFLICT");
    if (JSON.stringify(settings) === JSON.stringify(this.saved.settings))
      return this.snapshot();
    if (!settings.web_enabled && b.confirm_web_disable !== true)
      fail(400, "CONFIRM_WEB_DISABLE_REQUIRED");
    if (b.entry_origin !== undefined) str(b.entry_origin, 1, 2048);
    let origin: URL;
    try {
      origin = new URL(
        b.entry_origin ??
          this.saved.web_origin ??
          this.env.FLEET_CONSOLE_ORIGIN ??
          `http://${this.env.FLEET_HOST ?? "127.0.0.1"}:${this.env.FLEET_PORT}`,
      );
      if (
        !["http:", "https:"].includes(origin.protocol) ||
        origin.username ||
        origin.password ||
        origin.pathname !== "/" ||
        origin.search ||
        origin.hash
      )
        throw Error();
    } catch {
      return fail(400, "INVALID_DEPLOYMENT_ORIGIN");
    }
    const oldOrigin = origin.origin;
    const originPort =
      origin.port || (origin.protocol === "https:" ? "443" : "80");
    origin.protocol = settings.web_protocol + ":";
    origin.port = originPort;
    const needTls =
      settings.device_access === "agent-ssh" ||
      (settings.web_enabled && settings.web_protocol === "https");
    if (needTls) {
      const ready = this.tlsReady();
      if (!ready) fail(409, "DEPLOYMENT_HTTPS_NOT_READY");
      if (
        settings.web_enabled &&
        settings.web_protocol === "https" &&
        !certificateMatches(ready.cert, origin.hostname)
      ) {
        if (!ready.domain) fail(409, "DEPLOYMENT_CERTIFICATE_HOST_MISMATCH");
        origin.hostname = ready.domain;
      }
    }
    let next;
    try {
      next = this.config(settings);
    } catch {
      return fail(409, "DEPLOYMENT_CONFIG_NOT_READY");
    }
    if (
      settings.web_enabled &&
      (!next.config.webDist ||
        !existsSync(join(next.config.webDist, "index.html")))
    )
      fail(409, "DEPLOYMENT_WEB_NOT_READY");
    const restart = this.needsRestart(settings);
    if (
      settings.device_access === "agent-ssh" &&
      (!settings.web_enabled || settings.web_protocol === "http") &&
      this.running!.legacyAgentConnections()
    )
      fail(409, "AGENT_ENDPOINT_SYNC_REQUIRED");
    if (restart && this.activeTerminals())
      fail(409, "DEPLOYMENT_ACTIVE_TERMINALS");
    if (
      restart &&
      this.running!.store.db.prepare(
        "SELECT 1 FROM tasks WHERE status NOT IN ('SUCCEEDED','FAILED','TIMED_OUT','CANCELLED','EXPIRED','UNKNOWN') LIMIT 1",
      ).get()
    )
      fail(409, "DEPLOYMENT_ACTIVE_TASKS");
    const previous = {
      settings: this.saved.settings,
      entry_url: this.saved.settings.web_enabled ? oldOrigin : null,
      web_origin: oldOrigin,
    };
    this.running!.store.audit("deployment.requested", actor, null, null, {
      revision: this.saved.revision + 1,
      ...settings,
    });
    this.write({
      ...this.saved,
      revision: this.saved.revision + 1,
      settings,
      entry_url: settings.web_enabled ? origin.origin : null,
      web_origin: settings.web_enabled ? origin.origin : oldOrigin,
      previous,
      state: "applying",
      confirm_by: null,
      last_error: null,
    });
    this.restartRequired = restart;
    this.applying = true;
    setTimeout(() => this.apply(), 250).unref();
    return this.snapshot();
  }
  apply() {
    if (!this.applying || this.operation || this.stopping) return;
    this.operation = this.activate().finally(() => {
      this.operation = undefined;
    });
    // A double failure is fatal; keep the last working settings on disk for restart.
    void this.operation.catch((error) => {
      console.error(
        "Deployment recovery failed:",
        error instanceof Error ? error.message : "unknown",
      );
      process.exitCode = 1;
      void this.stop();
    });
  }
  private needsRestart(settings: DeploymentSettings) {
    return (
      !this.running ||
      this.activeSettings?.device_access !== settings.device_access ||
      !this.running.webReady(settings.web_protocol)
    );
  }
  private async reconfigure(snapshot: Snapshot) {
    if (this.needsRestart(snapshot.settings)) {
      await this.running?.close();
      this.running = undefined;
      await this.launch(snapshot);
    } else {
      const { host, port } = this.config(snapshot.settings);
      await this.running!.configureWeb(
        {
          host,
          port: port ?? this.saved.listener_port,
          enabled: snapshot.settings.web_enabled,
          protocol: snapshot.settings.web_protocol,
        },
        snapshot.web_origin,
      );
      this.activeSettings = { ...snapshot.settings };
    }
  }
  private async activate() {
    try {
      await this.reconfigure(this.saved);
      if (this.saved.settings.web_enabled) {
        this.write({
          ...this.saved,
          state: "awaiting_confirmation",
          confirm_by: Date.now() + this.confirmationMs,
        });
        this.timer = setTimeout(() => {
          this.applying = true;
          this.operation = this.rollback("CONFIRMATION_TIMEOUT").finally(() => {
            this.operation = undefined;
          });
          void this.operation.catch(() => {
            process.exitCode = 1;
            void this.stop();
          });
        }, this.confirmationMs);
      } else this.finish(null);
      this.applying = false;
    } catch {
      await this.rollback("APPLY_FAILED");
    }
  }
  confirm(value: unknown, actor: string) {
    const b = object(value);
    keys(b, ["v", "revision"]);
    version(b);
    if (b.revision !== this.saved.revision)
      fail(409, "DEPLOYMENT_REVISION_CONFLICT");
    if (this.applying) fail(409, "DEPLOYMENT_APPLYING");
    if (this.saved.state !== "awaiting_confirmation" || !this.saved.previous)
      fail(409, "DEPLOYMENT_NOT_PENDING");
    this.finish(actor);
    return this.snapshot();
  }
  private finish(actor: string | null) {
    const pending = this.saved;
    try {
      this.running!.store.transaction(() => {
        this.running!.store.audit("deployment.applied", actor, null, null, {
          revision: this.saved.revision,
          ...this.saved.settings,
        });
        this.write({
          ...this.saved,
          previous: null,
          state: "idle",
          confirm_by: null,
          last_error: null,
        });
      });
    } catch (error) {
      // If committing the audit failed after the file write, retain the trial
      // journal so the existing timer (or a restart) still restores the old mode.
      if (this.saved !== pending) this.write(pending);
      throw error;
    }
    clearTimeout(this.timer);
  }
  private async rollback(code: string) {
    clearTimeout(this.timer);
    const previous = this.saved.previous!;
    // Rollback itself must survive a crash before it can re-open the listener.
    this.write({
      ...this.saved,
      ...previous,
      revision: this.saved.revision + 1,
      previous: null,
      state: "rolled_back",
      confirm_by: null,
      last_error: code,
    });
    await this.reconfigure(this.saved);
    this.running!.store.audit("deployment.rolled_back", null, null, null, {
      revision: this.saved.revision,
      code,
    });
    this.applying = false;
  }
  async stop() {
    this.stopping = true;
    clearTimeout(this.timer);
    await this.operation?.catch(() => undefined);
    clearTimeout(this.timer);
    if (this.running) await this.running.close();
    this.running = undefined;
    if (this.control)
      await new Promise<void>((resolve) =>
        this.control!.close(() => resolve()),
      );
  }
}
