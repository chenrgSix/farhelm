import { open } from "node:fs/promises";
import { webcrypto } from "node:crypto";
import { fail } from "./util.js";

/** Read a bounded immutable snapshot; disk I/O and SHA-256 run off the event loop. */
export async function readVerifiedFile(
  path: string,
  size: number,
  sha256: string,
) {
  if (!Number.isSafeInteger(size) || size < 64 || size > 64 * 1024 * 1024)
    fail(409, "AGENT_PACKAGE_CHANGED");
  const file = await open(path, "r");
  try {
    const before = await file.stat();
    if (!before.isFile() || before.size !== size)
      fail(409, "AGENT_PACKAGE_CHANGED");
    const bytes = new Uint8Array(size);
    let offset = 0;
    while (offset < size) {
      const { bytesRead } = await file.read(
        bytes,
        offset,
        Math.min(1024 * 1024, size - offset),
        offset,
      );
      if (!bytesRead) fail(409, "AGENT_PACKAGE_CHANGED");
      offset += bytesRead;
    }
    const after = await file.stat();
    if (
      after.size !== size ||
      after.mtimeMs !== before.mtimeMs ||
      after.ctimeMs !== before.ctimeMs
    )
      fail(409, "AGENT_PACKAGE_CHANGED");
    const digest = Buffer.from(
      await webcrypto.subtle.digest("SHA-256", bytes),
    ).toString("hex");
    if (digest !== sha256) fail(409, "AGENT_PACKAGE_CHANGED");
    return Buffer.from(bytes.buffer);
  } finally {
    await file.close();
  }
}
