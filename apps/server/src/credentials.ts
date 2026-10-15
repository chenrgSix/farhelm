import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import {
  existsSync,
  readFileSync,
  openSync,
  writeFileSync,
  fsyncSync,
  closeSync,
  chmodSync,
} from "node:fs";
import { join } from "node:path";

// A separate persistent encryption key keeps credentials out of database copies,
// API responses and audits. Back up this key separately; never replace a lost key.
export class Credentials {
  private readonly key: Buffer;
  constructor(dataDir: string, hasCredentials: boolean) {
    const path = join(dataDir, "credentials.key");
    if (!existsSync(path)) {
      if (hasCredentials) throw new Error("CREDENTIALS_KEY_MISSING");
      const fd = openSync(path, "wx", 0o600);
      try {
        writeFileSync(fd, randomBytes(32));
        fsyncSync(fd);
      } finally {
        closeSync(fd);
      }
      const dir = openSync(dataDir, "r");
      try {
        fsyncSync(dir);
      } finally {
        closeSync(dir);
      }
    }
    chmodSync(path, 0o600);
    this.key = readFileSync(path);
    if (this.key.length !== 32) throw new Error("CREDENTIALS_KEY_INVALID");
  }
  seal(id: string, data: Record<string, string>) {
    const iv = randomBytes(12);
    const cipher = createCipheriv("aes-256-gcm", this.key, iv);
    cipher.setAAD(Buffer.from("farhelm-device-credentials-v1:" + id));
    const encrypted = Buffer.concat([
      cipher.update(JSON.stringify(data), "utf8"),
      cipher.final(),
    ]);
    return Buffer.concat([iv, cipher.getAuthTag(), encrypted]).toString(
      "base64",
    );
  }
  open(id: string, data: string): Record<string, string> {
    const raw = Buffer.from(data, "base64");
    const decipher = createDecipheriv(
      "aes-256-gcm",
      this.key,
      raw.subarray(0, 12),
    );
    decipher.setAAD(Buffer.from("farhelm-device-credentials-v1:" + id));
    decipher.setAuthTag(raw.subarray(12, 28));
    return JSON.parse(
      Buffer.concat([
        decipher.update(raw.subarray(28)),
        decipher.final(),
      ]).toString("utf8"),
    );
  }
}
