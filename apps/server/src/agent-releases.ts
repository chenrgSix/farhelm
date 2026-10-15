import type { FastifyInstance, FastifyRequest } from "fastify";
import { randomUUID } from "node:crypto";
import {
  readFileSync,
  lstatSync,
  existsSync,
  mkdirSync,
  writeFileSync,
  openSync,
  fsyncSync,
  closeSync,
  renameSync,
  unlinkSync,
} from "node:fs";
import { join } from "node:path";
import type { Store } from "./store.js";
import type { User } from "./types.js";
import {
  fail,
  hash,
  integer,
  keys,
  object,
  str,
  version as apiVersion,
} from "./util.js";
const LIMIT = 64 * 1024 * 1024;
const machines = ["aarch64", "x86_64"];
export type Artifact = { bytes: Buffer; digest: string };
export type Release = {
  sha256: string;
  arch: string;
  version: string;
  size: number;
  enabled: boolean;
  source: "upload" | "directory";
  created_at: number;
};
type Manifest = Pick<Release, "sha256" | "arch" | "version" | "size"> & {
  upgrade_protocol: 1;
};
export function releaseVersion(value: unknown) {
  const v = str(value, 1, 20);
  if (!/^\d{1,6}\.\d{1,6}\.\d{1,6}$/.test(v))
    fail(400, "INVALID_AGENT_VERSION");
  return v;
}
export function compareVersion(a: string, b: string) {
  const x = a.split(".").map(Number),
    y = b.split(".").map(Number);
  for (let i = 0; i < 3; i++) if (x[i] !== y[i]) return x[i]! - y[i]!;
  return 0;
}
function manifest(value: unknown): Manifest {
  const m = object(value);
  keys(m, ["arch", "version", "sha256", "size", "upgrade_protocol"]);
  const arch = str(m.arch, 1, 16),
    sha256 = str(m.sha256, 64, 64);
  if (!machines.includes(arch)) fail(400, "INVALID_AGENT_ARCH");
  if (!/^[a-f0-9]{64}$/.test(sha256)) fail(400, "INVALID_SHA256");
  if (m.upgrade_protocol !== 1) fail(400, "AGENT_PACKAGE_PROTOCOL");
  return {
    arch,
    sha256,
    version: releaseVersion(m.version),
    size: integer(m.size, 64, LIMIT),
    upgrade_protocol: 1,
  };
}
function uploadManifest(req: FastifyRequest) {
  const text = str(req.headers["x-agent-manifest"], 1, 2048);
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    fail(400, "INVALID_AGENT_MANIFEST");
  }
  return manifest(parsed);
}
function validate(bytes: Buffer, m: Manifest) {
  if (bytes.length !== m.size) fail(400, "AGENT_PACKAGE_SIZE");
  if (
    bytes.subarray(0, 6).toString("hex") !== "7f454c460201" ||
    bytes.readUInt16LE(18) !== (m.arch === "aarch64" ? 183 : 62)
  )
    fail(400, "AGENT_PACKAGE_ARCH");
  if (hash(bytes) !== m.sha256) fail(400, "AGENT_PACKAGE_DIGEST");
}
export function legacyArtifacts(distDir?: string) {
  const cache = new Map<
    string,
    { stamp: string; bytes: Buffer; digest: string }
  >();
  return (arch: string): Artifact | undefined => {
    if (!distDir || !machines.includes(arch)) return;
    const path = join(distDir, `farhelm-agent-linux-${arch}`);
    if (!existsSync(path)) return;
    const stat = lstatSync(path);
    if (!stat.isFile() || stat.size < 64 || stat.size > LIMIT) return;
    const stamp = `${stat.ino}:${stat.mtimeMs}:${stat.ctimeMs}:${stat.size}`;
    if (cache.get(arch)?.stamp !== stamp) {
      const bytes = readFileSync(path);
      if (
        bytes.subarray(0, 6).toString("hex") !== "7f454c460201" ||
        bytes.readUInt16LE(18) !== (arch === "aarch64" ? 183 : 62)
      )
        return;
      cache.set(arch, { stamp, bytes, digest: hash(bytes) });
    }
    return cache.get(arch);
  };
}
export type ReleaseCatalog = ReturnType<typeof registerAgentReleases>;
export function registerAgentReleases(
  app: FastifyInstance,
  d: {
    store: Store;
    admin: (req: FastifyRequest) => User;
    distDir?: string;
    artifact: (arch: string) => Artifact | undefined;
  },
) {
  const { db } = d.store,
    dir = join(d.store.dataDir, "objects", "agent-releases");
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const row = (sha: string) =>
    db.prepare("SELECT * FROM agent_releases WHERE sha256=?").get(sha) as
      (Omit<Release, "enabled"> & { enabled: number }) | undefined;
  function save(
    m: Manifest,
    bytes: Buffer,
    source: Release["source"],
    actor: string | null,
  ) {
    validate(bytes, m);
    const old = row(m.sha256),
      sameVersion = db
        .prepare("SELECT sha256 FROM agent_releases WHERE version=? AND arch=?")
        .get(m.version, m.arch) as { sha256: string } | undefined;
    if (
      (old &&
        (old.version !== m.version ||
          old.arch !== m.arch ||
          old.size !== m.size)) ||
      (sameVersion && sameVersion.sha256 !== m.sha256)
    )
      fail(409, "AGENT_RELEASE_CONFLICT");
    // Upload retries may repair a lost/corrupt object, but never overwrite another build identity.
    const path = join(dir, m.sha256);
    if (!existsSync(path) || hash(readFileSync(path)) !== m.sha256) {
      const temp = path + "." + randomUUID();
      try {
        writeFileSync(temp, bytes, { flag: "wx", mode: 0o600 });
        const fd = openSync(temp, "r");
        try {
          fsyncSync(fd);
        } finally {
          closeSync(fd);
        }
        renameSync(temp, path);
        const fdDir = openSync(dir, "r");
        try {
          fsyncSync(fdDir);
        } finally {
          closeSync(fdDir);
        }
      } finally {
        if (existsSync(temp)) unlinkSync(temp);
      }
    }
    if (!old)
      d.store.transaction(() => {
        db.prepare(
          "INSERT INTO agent_releases(sha256,arch,version,size,source,created_at) VALUES(?,?,?,?,?,?)",
        ).run(m.sha256, m.arch, m.version, m.size, source, Date.now());
        d.store.audit(
          source === "upload"
            ? "agent.release_uploaded"
            : "agent.release_imported",
          actor,
          null,
          null,
          { arch: m.arch, version: m.version, sha256: m.sha256, size: m.size },
        );
      });
    const saved = row(m.sha256)!;
    return { ...saved, enabled: !!saved.enabled };
  }
  function importDirectory() {
    if (!d.distDir) return;
    for (const arch of machines) {
      try {
        const m = manifest(
          JSON.parse(
            readFileSync(
              join(d.distDir, `farhelm-agent-linux-${arch}.json`),
              "utf8",
            ),
          ),
        );
        if (m.arch !== arch || row(m.sha256)) continue;
        const file = d.artifact(arch);
        if (file) save(m, file.bytes, "directory", null);
      } catch {
        /* Legacy discovery is optional; malformed or conflicting packages are not published. */
      }
    }
  }
  function list() {
    importDirectory();
    return (db.prepare("SELECT * FROM agent_releases").all() as any[])
      .map((r) => ({ ...r, enabled: !!r.enabled }) as Release)
      .sort(
        (a, b) =>
          compareVersion(b.version, a.version) || a.arch.localeCompare(b.arch),
      );
  }
  function get(sha: string, arch: string) {
    if (!sha || !machines.includes(arch) || !/^[a-f0-9]{64}$/.test(sha)) return;
    const r = row(sha);
    if (!r || r.arch !== arch) return;
    const bytes = readFileSync(join(dir, sha));
    validate(bytes, { ...r, upgrade_protocol: 1 });
    return { bytes, digest: sha };
  }
  function latest(arch: string) {
    const r = list().find((r) => r.enabled && r.arch === arch);
    return r ? get(r.sha256, arch) : undefined;
  }
  function has(arch: string) {
    return !!db.prepare("SELECT 1 FROM agent_releases WHERE arch=?").get(arch);
  }
  const uploads = new Set<FastifyRequest>();
  // Auth and metadata limits run before the bounded binary body parser. Only two uploads may buffer concurrently.
  app.put<{ Params: { sha256: string } }>(
    "/api/v1/agent-releases/:sha256",
    {
      bodyLimit: LIMIT,
      onRequest: async (req) => {
        d.admin(req);
        const m = uploadManifest(req);
        if (req.params.sha256 !== m.sha256) fail(400, "AGENT_PACKAGE_DIGEST");
        if (req.headers["content-type"] !== "application/octet-stream")
          fail(415, "AGENT_PACKAGE_CONTENT_TYPE");
        if (
          req.headers["content-length"] !== undefined &&
          Number(req.headers["content-length"]) !== m.size
        )
          fail(400, "AGENT_PACKAGE_SIZE");
        if (uploads.size >= 2) fail(429, "AGENT_UPLOAD_BUSY");
        uploads.add(req);
        req.raw.once("aborted", () => uploads.delete(req));
      },
      onResponse: async (req) => {
        uploads.delete(req);
      },
      onError: async (req) => {
        uploads.delete(req);
      },
    },
    async (req) => {
      const user = d.admin(req);
      const m = uploadManifest(req);
      if (!Buffer.isBuffer(req.body)) fail(400, "INVALID_PACKAGE_BODY");
      return { v: 1, release: save(m, req.body, "upload", user.id) };
    },
  );
  app.get("/api/v1/agent-releases", async (req) => {
    d.admin(req);
    return { v: 1, releases: list() };
  });
  app.post<{ Params: { sha256: string } }>(
    "/api/v1/agent-releases/:sha256",
    async (req) => {
      const user = d.admin(req),
        b = object(req.body);
      apiVersion(b);
      keys(b, ["v", "enabled"]);
      if (typeof b.enabled !== "boolean") fail(400, "INVALID_BODY");
      const r = row(req.params.sha256);
      if (!r) fail(404, "AGENT_RELEASE_NOT_FOUND");
      if (!!r.enabled !== b.enabled)
        d.store.transaction(() => {
          db.prepare("UPDATE agent_releases SET enabled=? WHERE sha256=?").run(
            Number(b.enabled),
            r.sha256,
          );
          d.store.audit("agent.release_availability", user.id, null, null, {
            sha256: r.sha256,
            enabled: b.enabled,
          });
        });
      return { v: 1, release: { ...r, enabled: b.enabled } };
    },
  );
  importDirectory();
  return { list, get, latest, has };
}
