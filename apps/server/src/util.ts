import {
  createHash,
  randomBytes,
  scryptSync,
  scrypt,
  timingSafeEqual,
} from "node:crypto";
export class ApiError extends Error {
  constructor(
    public statusCode: number,
    public code: string,
    message = code,
  ) {
    super(message);
  }
}
export function fail(status: number, code: string): never {
  throw new ApiError(status, code);
}
export function canonical(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return "[" + value.map(canonical).join(",") + "]";
  return (
    "{" +
    Object.entries(value)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
      .map(([k, v]) => JSON.stringify(k) + ":" + canonical(v))
      .join(",") +
    "}"
  );
}
export const hash = (data: string | Buffer) =>
  createHash("sha256").update(data).digest("hex");
export const token = () => randomBytes(32).toString("base64url");
// Apply only when setting a new platform password; existing credentials still log in.
export function accountPassword(value: unknown): string {
  if (
    typeof value !== "string" ||
    value.length < 8 ||
    value.length > 1024 ||
    !/[A-Za-z]/.test(value) ||
    !/[0-9]/.test(value)
  )
    fail(400, "INVALID_PASSWORD_POLICY");
  return str(value, 8, 1024);
}
export function passwordHash(password: string) {
  const salt = randomBytes(16);
  return (
    "scrypt$16384$" +
    salt.toString("hex") +
    "$" +
    scryptSync(password, salt, 32, { N: 16384, r: 8, p: 1 }).toString("hex")
  );
}
export function passwordVerify(password: string, encoded: string) {
  const [alg, n, salt, key] = encoded.split("$");
  if (alg !== "scrypt" || n !== "16384" || !salt || !key) return false;
  const computed = scryptSync(password, Buffer.from(salt, "hex"), 32, {
    N: 16384,
    r: 8,
    p: 1,
  });
  const expected = Buffer.from(key, "hex");
  return (
    expected.length === computed.length && timingSafeEqual(expected, computed)
  );
}
// Bound both worker-pool use and queued password material. Startup seeding stays synchronous.
let passwordWorkers = 0;
const passwordQueue: (() => void)[] = [];
function derivePassword(password: string, salt: Buffer): Promise<Buffer> {
  if (passwordWorkers >= 2 && passwordQueue.length >= 16)
    return Promise.reject(new ApiError(429, "PASSWORD_AUTH_BUSY"));
  return new Promise((resolve, reject) => {
    const start = () => {
      passwordWorkers++;
      const done = (error: Error | null, key?: Buffer) => {
        passwordWorkers--;
        passwordQueue.shift()?.();
        if (error) reject(error);
        else resolve(key!);
      };
      try {
        scrypt(password, salt, 32, { N: 16384, r: 8, p: 1 }, done);
      } catch (error) {
        done(error as Error);
      }
    };
    if (passwordWorkers < 2) start();
    else passwordQueue.push(start);
  });
}
export async function passwordHashAsync(password: string) {
  const salt = randomBytes(16);
  const key = await derivePassword(password, salt);
  return "scrypt$16384$" + salt.toString("hex") + "$" + key.toString("hex");
}
export async function passwordVerifyAsync(password: string, encoded: string) {
  const [alg, n, salt, key] = encoded.split("$");
  if (alg !== "scrypt" || n !== "16384" || !salt || !key) return false;
  const computed = await derivePassword(password, Buffer.from(salt, "hex"));
  const expected = Buffer.from(key, "hex");
  return (
    expected.length === computed.length && timingSafeEqual(expected, computed)
  );
}
export function object(value: unknown): Record<string, any> {
  if (!value || typeof value !== "object" || Array.isArray(value))
    fail(400, "INVALID_BODY");
  return value as Record<string, any>;
}
export function keys(value: Record<string, any>, allowed: string[]) {
  if (Object.keys(value).some((k) => !allowed.includes(k)))
    fail(400, "UNKNOWN_FIELD");
}
export function str(value: unknown, min = 1, max = 256): string {
  if (
    typeof value !== "string" ||
    value.length < min ||
    value.length > max ||
    value.includes("\0") ||
    /[\uD800-\uDFFF]/u.test(value)
  )
    fail(400, "INVALID_STRING");
  return value;
}
export function integer(value: unknown, min: number, max: number): number {
  if (
    typeof value !== "number" ||
    !Number.isSafeInteger(value) ||
    value < min ||
    value > max
  )
    fail(400, "INVALID_INTEGER");
  return value;
}
export function version(body: Record<string, any>, required = true) {
  if ((required || body.v !== undefined) && body.v !== 1)
    fail(400, "UNSUPPORTED_VERSION");
}
export function base64(value: unknown, size: number): string {
  const s = str(value, 1, 512);
  const b = Buffer.from(s, "base64");
  if (b.length !== size || b.toString("base64") !== s)
    fail(400, "INVALID_BASE64");
  return s;
}
export function digest(value: unknown): string {
  const s = str(value, 64, 64);
  if (!/^[0-9a-f]{64}$/.test(s)) fail(400, "INVALID_DIGEST");
  return s;
}
export class RateLimiter {
  private buckets = new Map<
    string,
    {
      count: number;
      reset: number;
    }
  >();
  check(key: string, limit: number, windowMs = 60000) {
    const now = Date.now();
    let b = this.buckets.get(key);
    if (!b || b.reset <= now) {
      if (this.buckets.size >= 10000) {
        for (const [k, v] of this.buckets)
          if (v.reset <= now) this.buckets.delete(k);
        if (this.buckets.size >= 10000) fail(429, "RATE_LIMIT");
      }
      b = { count: 0, reset: now + windowMs };
      this.buckets.set(key, b);
    }
    if (++b.count > limit) fail(429, "RATE_LIMIT");
  }
}
