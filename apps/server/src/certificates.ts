import type { FastifyInstance, FastifyRequest } from "fastify";
import { createServer, type Server } from "node:http";
import {
  mkdirSync,
  chmodSync,
  existsSync,
  readFileSync,
  unlinkSync,
} from "node:fs";
import { join } from "node:path";
import { isIP } from "node:net";
import { domainToASCII } from "node:url";
import { X509Certificate } from "node:crypto";
import { PrivateAuthority, privateCertificateHost } from "./private-ca.js";
import type { Store } from "./store.js";
import type { User } from "./types.js";
import { fail, integer, keys, object, str, version } from "./util.js";
import { acmeIssuer, CertificateError, type IssueCertificate } from "./acme.js";
import {
  certificateInfo,
  certificateMatches,
  privateFile,
  validateCertificate,
  type CertificateBundle,
} from "./certificate-files.js";

const HOUR = 3600000,
  COOLDOWN = 5 * 60000;
export type AcmeConfig = {
  httpHost: string;
  httpPort: number;
  testDirectoryUrl?: string;
};
type Row = {
  mode: "acme" | "private";
  revision: number;
  domain: string;
  email: string;
  enabled: number;
  tos_agreed: number;
  updated_at: number | null;
  last_attempt_at: number | null;
  last_success_at: number | null;
  next_attempt_at: number | null;
  retry_after: number | null;
  last_error: string | null;
  failures: number;
};
const empty: Row = {
  mode: "acme",
  revision: 0,
  domain: "",
  email: "",
  enabled: 0,
  tos_agreed: 0,
  updated_at: null,
  last_attempt_at: null,
  last_success_at: null,
  next_attempt_at: null,
  retry_after: null,
  last_error: null,
  failures: 0,
};
export const certificateErrors: Record<string, string> = {
  PRIVATE_CA_NOT_PREPARED: "请先创建并下载内网 CA，完成浏览器信任后再启用。",
  PRIVATE_CA_UNAVAILABLE:
    "内网 CA 文件缺失或损坏，请从备份恢复；平台不会自动更换 CA。",
  PRIVATE_CA_EXPIRED:
    "内网 CA 已过期、尚未生效或即将到期，请安排 CA 信任迁移。",
  PRIVATE_CERTIFICATE_FAILED:
    "内网证书签发失败，已保留当前证书，请检查平台存储和系统时间。",
  ACME_RATE_LIMITED: "证书机构限制了申请频率，请等待下次重试时间。",
  ACME_DNS_FAILED:
    "域名解析验证失败，请检查域名的 A / AAAA 记录是否指向此平台。",
  ACME_CHALLENGE_FAILED:
    "域名验证失败，请检查公网 80 端口和 HTTP 验证入口是否可达。",
  ACME_CONFIG_REJECTED: "证书机构拒绝了申请配置，请检查域名和联系邮箱。",
  ACME_REQUEST_FAILED: "无法完成证书申请，请检查平台到证书机构的网络连接。",
  ACME_TIMEOUT: "证书申请超时，请检查网络和公网 80 端口。",
  ACME_INVALID_CERTIFICATE: "新证书校验失败，已保留当前证书。",
  ACME_STORAGE_FAILED: "证书保存或加载失败，请检查平台数据目录的空间和权限。",
  ACME_HTTP_UNAVAILABLE: "HTTP 验证端口监听失败，请检查端口占用和监听权限。",
};
export function certificateDomain(value: unknown) {
  const input = str(value, 1, 253).trim().toLowerCase();
  const domain = domainToASCII(input);
  if (
    !/^[\p{L}\p{N}\p{M}.-]+$/u.test(input) ||
    !domain ||
    domain.length > 253 ||
    isIP(domain) ||
    !domain.includes(".") ||
    !domain
      .split(".")
      .every((label) => /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(label)) ||
    !/[a-z]/.test(domain.split(".").at(-1)!) ||
    /(?:^|\.)(?:localhost|local|internal|test|invalid|example|onion)$/.test(
      domain,
    )
  )
    fail(400, "INVALID_CERTIFICATE_DOMAIN");
  return domain;
}
export class CertificateManager {
  private active?: CertificateBundle;
  private retired?: CertificateBundle;
  private authority: PrivateAuthority;
  private closed = false;
  private listener?: Server;
  private ready = false;
  private starting?: Promise<void>;
  private timer?: NodeJS.Timeout;
  private job?: Promise<void>;
  private controller?: AbortController;
  private challenges = new Map<string, string>();
  private issue: IssueCertificate;
  private schedulerError: string | null = null;
  private now: () => number;
  constructor(
    private d: {
      store: Store;
      config?: AcmeConfig;
      privateAvailable?: boolean;
      privateLeafLifetimeMs?: number;
      initial?: CertificateBundle;
      retired?: CertificateBundle;
      fallback: () => string | Buffer;
      activate: (bundle: CertificateBundle) => void;
      issue?: IssueCertificate;
      now?: () => number;
      warn?: (message: string) => void;
    },
  ) {
    this.active = d.initial;
    this.retired = d.retired;
    this.issue = d.issue ?? acmeIssuer(d.config?.testDirectoryUrl);
    this.now = d.now ?? Date.now;
    this.authority = new PrivateAuthority(d.store, this.now);
  }
  current(): Row {
    return (
      (this.d.store.db
        .prepare("SELECT * FROM certificate_settings WHERE id=1")
        .get() as Row | undefined) ?? { ...empty }
    );
  }
  private available(mode: Row["mode"]) {
    return mode === "private" ? !!this.d.privateAvailable : !!this.d.config;
  }
  private matches(row: Row) {
    return (
      this.active?.domain === row.domain &&
      (this.active.mode ?? "acme") === row.mode
    );
  }
  snapshot() {
    const row = this.current();
    const cert = certificateInfo(this.active?.cert ?? this.d.fallback());
    const matching = this.matches(row);
    const available = this.available(row.mode);
    let ca = null,
      caError: string | null = null;
    try {
      ca = this.authority.info();
    } catch {
      caError = "PRIVATE_CA_UNAVAILABLE";
    }
    const error =
      available && row.mode === "acme" && row.enabled && !this.ready
        ? "ACME_HTTP_UNAVAILABLE"
        : (this.schedulerError ??
          (row.mode === "private" ? caError : null) ??
          row.last_error);
    const status = !available
      ? "external"
      : !row.enabled
        ? "disabled"
        : this.job
          ? matching
            ? "renewing"
            : "issuing"
          : error
            ? "error"
            : matching && cert.expires_at <= this.now()
              ? "expired"
              : matching
                ? "valid"
                : "pending";
    return {
      v: 1,
      mode: row.mode,
      acme_available: !!this.d.config,
      private_ca_available: !!this.d.privateAvailable,
      private_ca: ca,
      revision: row.revision,
      domain: row.domain,
      email: row.email,
      enabled: !!row.enabled,
      tos_agreed: !!row.tos_agreed,
      updated_at: row.updated_at,
      available,
      challenge_port: this.port(),
      challenge_ready: this.ready,
      status,
      last_error: error
        ? {
            code: error,
            message: certificateErrors[error] ?? "证书管理失败，请稍后重试。",
          }
        : null,
      last_attempt_at: row.last_attempt_at,
      last_success_at: row.last_success_at,
      next_attempt_at: row.enabled ? row.next_attempt_at : null,
      retry_allowed_at:
        Math.max(
          row.retry_after ?? 0,
          row.last_attempt_at ? row.last_attempt_at + COOLDOWN : 0,
        ) || null,
      certificate: {
        ...cert,
        managed: !!this.active,
        domain: this.active?.domain ?? null,
        expired: cert.expires_at <= this.now(),
      },
    };
  }
  save(body: unknown, actor: string) {
    const b = object(body);
    version(b);
    keys(b, [
      "v",
      "revision",
      "domain",
      "email",
      "enabled",
      "tos_agreed",
      "mode",
    ]);
    const mode = b.mode ?? "acme";
    if (mode !== "acme" && mode !== "private")
      fail(400, "INVALID_CERTIFICATE_MODE");
    const revision = integer(b.revision, 0, Number.MAX_SAFE_INTEGER - 1);
    if (typeof b.enabled !== "boolean" || typeof b.tos_agreed !== "boolean")
      fail(400, "INVALID_BODY");
    const domain =
        mode === "private"
          ? privateCertificateHost(b.domain)
          : certificateDomain(b.domain),
      email = str(b.email, 0, 254).trim();
    if (
      mode === "acme" &&
      !/^[A-Za-z0-9.!#$%&'*+/=?^_`{|}~-]+@[A-Za-z0-9](?:[A-Za-z0-9.-]*[A-Za-z0-9])?\.[A-Za-z]{2,63}$/.test(
        email,
      )
    )
      fail(400, "INVALID_CERTIFICATE_EMAIL");
    if (mode === "acme" && b.enabled && !b.tos_agreed)
      fail(400, "CERTIFICATE_TOS_REQUIRED");
    if (b.enabled && !this.available(mode))
      fail(409, "CERTIFICATE_MANAGEMENT_UNAVAILABLE");
    if (b.enabled && mode === "private" && !this.authority.info())
      fail(409, "PRIVATE_CA_NOT_PREPARED");
    const saved = this.d.store.transaction(() => {
      const row = this.current();
      if (revision !== row.revision) fail(409, "CERTIFICATE_REVISION_CONFLICT");
      if (this.job && b.enabled) fail(409, "CERTIFICATE_BUSY");
      if (
        row.mode === mode &&
        row.domain === domain &&
        row.email === email &&
        !!row.enabled === b.enabled &&
        !!row.tos_agreed === b.tos_agreed
      )
        return false;
      const next = b.enabled
        ? Math.max(
            this.now(),
            row.retry_after ?? 0,
            row.last_attempt_at ? row.last_attempt_at + COOLDOWN : 0,
          )
        : null;
      this.d.store.db
        .prepare(
          `INSERT INTO certificate_settings
        (id,revision,domain,email,enabled,tos_agreed,updated_at,next_attempt_at,mode)
        VALUES(1,?,?,?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET revision=excluded.revision,
        domain=excluded.domain,email=excluded.email,enabled=excluded.enabled,tos_agreed=excluded.tos_agreed,
        updated_at=excluded.updated_at,next_attempt_at=excluded.next_attempt_at,mode=excluded.mode,last_error=NULL,failures=0`,
        )
        .run(
          revision + 1,
          domain,
          email,
          Number(b.enabled),
          Number(b.tos_agreed),
          this.now(),
          next,
          mode,
        );
      this.d.store.audit("certificate.configured", actor, null, null, {
        revision: revision + 1,
        domain,
        mode,
        enabled: b.enabled,
      });
      return true;
    });
    if (saved && !b.enabled) this.controller?.abort();
    this.schedule();
    return this.snapshot();
  }
  request(body: unknown, actor: string) {
    const b = object(body);
    version(b);
    keys(b, ["v", "revision"]);
    const row = this.current();
    if (integer(b.revision, 1, Number.MAX_SAFE_INTEGER) !== row.revision)
      fail(409, "CERTIFICATE_REVISION_CONFLICT");
    if (!this.available(row.mode) || !row.enabled)
      fail(409, "CERTIFICATE_MANAGEMENT_UNAVAILABLE");
    if (this.job) return this.snapshot();
    if (
      this.now() <
      Math.max(
        row.retry_after ?? 0,
        row.last_attempt_at ? row.last_attempt_at + COOLDOWN : 0,
      )
    )
      fail(429, "CERTIFICATE_RETRY_LATER");
    this.d.store.transaction(() => {
      this.d.store.db
        .prepare("UPDATE certificate_settings SET next_attempt_at=? WHERE id=1")
        .run(this.now());
      this.d.store.audit("certificate.check_requested", actor, null, null, {
        revision: row.revision,
      });
    });
    this.schedule();
    return this.snapshot();
  }
  async prepare(body: unknown, actor: string) {
    const b = object(body);
    version(b);
    keys(b, ["v", "revision"]);
    const row = this.current();
    if (integer(b.revision, 1, Number.MAX_SAFE_INTEGER) !== row.revision)
      fail(409, "CERTIFICATE_REVISION_CONFLICT");
    if (!this.d.privateAvailable || row.mode !== "private" || this.closed)
      fail(409, "CERTIFICATE_MANAGEMENT_UNAVAILABLE");
    await this.authority.prepare(actor);
    return this.snapshot();
  }
  downloadCA() {
    const ca = this.authority.read();
    if (!ca) fail(404, "PRIVATE_CA_NOT_PREPARED");
    return {
      v: 1,
      certificate_pem: ca.cert,
      fingerprint: certificateInfo(ca.cert).fingerprint,
    };
  }
  agentCA(url: string, fallback: string) {
    const host = new URL(url).hostname.replace(/^\[|\]$/g, "");
    const bundle = [this.active, this.retired].find(
      (item) =>
        item && certificateMatches(new X509Certificate(item.cert), host),
    );
    if (bundle && bundle.mode !== "private") return "";
    const cert = bundle
      ? new X509Certificate(bundle.cert)
      : new X509Certificate(this.d.fallback());
    if (!certificateMatches(cert, host)) return fallback;
    const ca = this.authority.read();
    if (ca && cert.verify(new X509Certificate(ca.cert).publicKey))
      return ca.cert;
    if (bundle?.mode === "private") fail(503, "PRIVATE_CA_UNAVAILABLE");
    return fallback;
  }
  private schedule() {
    setImmediate(() => {
      void this.tick().then(
        () => {
          this.schedulerError = null;
        },
        () => {
          this.schedulerError = "ACME_STORAGE_FAILED";
          this.d.warn?.(
            "Certificate scheduler failed; retaining current TLS context",
          );
        },
      );
    });
  }
  port() {
    const address = this.listener?.address();
    return address && typeof address !== "string"
      ? address.port
      : (this.d.config?.httpPort ?? null);
  }
  private async listen() {
    if (this.closed || this.ready || !this.d.config) return;
    if (this.starting) return this.starting;
    const config = this.d.config;
    if (!this.listener)
      this.listener = createServer(
        { requestTimeout: 5000, headersTimeout: 5000, maxHeaderSize: 4096 },
        (req, res) => {
          const token =
            /^\/\.well-known\/acme-challenge\/([A-Za-z0-9_-]{1,128})$/.exec(
              req.url ?? "",
            )?.[1];
          const value =
            req.method === "GET" &&
            req.headers.host?.toLowerCase().split(":")[0] ===
              this.current().domain &&
            token
              ? this.challenges.get(token)
              : undefined;
          res.writeHead(value ? 200 : 404, {
            "Content-Type": "text/plain",
            "Cache-Control": "no-store",
            Connection: "close",
          });
          res.end(value ?? "Not found");
        },
      );
    this.starting = new Promise<void>((resolve) => {
      const listener = this.listener!;
      const failed = () => {
        this.ready = false;
        resolve();
      };
      listener.once("error", failed);
      listener.listen(config.httpPort, config.httpHost, () => {
        listener.off("error", failed);
        this.ready = true;
        resolve();
      });
    }).finally(() => {
      this.starting = undefined;
    });
    return this.starting;
  }
  async start() {
    if (!this.d.config && !this.d.privateAvailable) return;
    await this.listen();
    this.timer = setInterval(() => this.schedule(), 60000);
    this.timer.unref();
    this.schedule();
  }
  async tick() {
    if (this.closed || this.job) return;
    const before = this.current();
    if (!this.available(before.mode)) return;
    if (before.mode === "acme") await this.listen();
    if (this.closed || (before.mode === "acme" && !this.ready) || this.job)
      return;
    const row = this.current(),
      now = this.now();
    if (
      !row.enabled ||
      (row.mode === "acme" && !row.tos_agreed) ||
      (row.next_attempt_at ?? 0) > now ||
      (row.retry_after ?? 0) > now
    )
      return;
    if (this.matches(row)) {
      const info = certificateInfo(this.active!.cert);
      if (info.renew_at > now) {
        this.d.store.db
          .prepare(
            "UPDATE certificate_settings SET next_attempt_at=?,last_error=NULL WHERE id=1",
          )
          .run(info.renew_at);
        return;
      }
    }
    this.d.store.db
      .prepare(
        "UPDATE certificate_settings SET last_attempt_at=?,next_attempt_at=? WHERE id=1",
      )
      .run(now, now + HOUR);
    this.controller = new AbortController();
    this.job = this.run(row, this.controller.signal).finally(() => {
      this.challenges.clear();
      this.job = undefined;
      this.controller = undefined;
    });
    await this.job;
  }
  private async run(row: Row, signal: AbortSignal) {
    const directory = join(this.d.store.dataDir, "certificates");
    const current = () =>
      !this.closed &&
      !signal.aborted &&
      this.current().revision === row.revision;
    let phase = "ACME_STORAGE_FAILED";
    try {
      mkdirSync(directory, { recursive: true, mode: 0o700 });
      chmodSync(directory, 0o700);
      phase =
        row.mode === "private"
          ? "PRIVATE_CERTIFICATE_FAILED"
          : "ACME_REQUEST_FAILED";
      const result =
        row.mode === "private"
          ? await this.authority.issue(row.domain, this.d.privateLeafLifetimeMs)
          : await this.issue({
              domain: row.domain,
              email: row.email,
              directory,
              signal,
              challenge: (token, authorization) => {
                if (!current()) throw new Error("Cancelled");
                if (!/^[A-Za-z0-9_-]{1,128}$/.test(token))
                  throw new Error("Invalid challenge token");
                if (authorization === null) this.challenges.delete(token);
                else if (/^[A-Za-z0-9_.-]{1,1024}$/.test(authorization))
                  this.challenges.set(token, authorization);
                else throw new Error("Invalid challenge authorization");
              },
            });
      if (!current()) return;
      phase = "ACME_INVALID_CERTIFICATE";
      const bundle = validateCertificate(
        { ...result, domain: row.domain, mode: row.mode },
        this.now(),
      );
      phase = "ACME_STORAGE_FAILED";
      const path = join(directory, "active.json");
      const previous = existsSync(path)
        ? readFileSync(path, "utf8")
        : undefined;
      if (previous) privateFile(join(directory, "previous.json"), previous);
      if (this.active && this.active.domain !== bundle.domain)
        privateFile(
          join(directory, "retired.json"),
          JSON.stringify(this.active),
        );
      privateFile(path, JSON.stringify(bundle));
      try {
        this.d.activate(bundle);
      } catch (error) {
        if (previous) privateFile(path, previous);
        else unlinkSync(path);
        throw error;
      }
      if (this.active && this.active.domain !== bundle.domain)
        this.retired = this.active;
      this.active = bundle;
      const info = certificateInfo(bundle.cert);
      this.d.store.transaction(() => {
        this.d.store.db
          .prepare(
            `UPDATE certificate_settings SET last_success_at=?,next_attempt_at=?,
          retry_after=NULL,last_error=NULL,failures=0 WHERE id=1`,
          )
          .run(this.now(), info.renew_at);
        this.d.store.audit("certificate.issued", null, null, null, {
          revision: row.revision,
          domain: row.domain,
          fingerprint: info.fingerprint,
          expires_at: info.expires_at,
        });
      });
    } catch (error) {
      if (!current()) return;
      const code =
        error instanceof CertificateError && certificateErrors[error.code]
          ? error.code
          : phase;
      const failures = Math.min(row.failures + 1, 10);
      const retryAfter =
        error instanceof CertificateError ? error.retryAfter : null;
      const next = Math.max(
        this.now() + Math.min(24, 2 ** (failures - 1)) * HOUR,
        retryAfter ??
          (code === "ACME_RATE_LIMITED" ? this.now() + 24 * HOUR : 0),
      );
      this.d.store.transaction(() => {
        this.d.store.db
          .prepare(
            "UPDATE certificate_settings SET failures=?,last_error=?,next_attempt_at=?,retry_after=? WHERE id=1",
          )
          .run(
            failures,
            code,
            next,
            code === "ACME_RATE_LIMITED" ? next : retryAfter,
          );
        this.d.store.audit("certificate.failed", null, null, null, {
          revision: row.revision,
          code,
        });
      });
    }
  }
  async close() {
    this.closed = true;
    clearInterval(this.timer);
    this.controller?.abort();
    await this.job;
    await this.authority.close();
    await this.starting;
    this.challenges.clear();
    if (this.listener?.listening) {
      this.listener.closeAllConnections();
      await new Promise<void>((resolve) =>
        this.listener!.close(() => resolve()),
      );
    }
    this.ready = false;
  }
}
export function registerCertificates(
  app: FastifyInstance,
  manager: CertificateManager,
  admin: (req: FastifyRequest) => User,
) {
  app.get("/api/v1/settings/certificate", async (req) => {
    admin(req);
    return manager.snapshot();
  });
  app.put("/api/v1/settings/certificate", async (req) =>
    manager.save(req.body, admin(req).id),
  );
  app.post("/api/v1/settings/certificate/check", async (req) =>
    manager.request(req.body, admin(req).id),
  );
  app.post("/api/v1/settings/certificate/ca", async (req) =>
    manager.prepare(req.body, admin(req).id),
  );
  app.get("/api/v1/settings/certificate/ca", async (req, reply) => {
    admin(req);
    reply.header("Cache-Control", "no-store");
    return manager.downloadCA();
  });
  app.addHook("onListen", () => manager.start());
  app.addHook("onClose", () => manager.close());
}
