import { fail } from "./util.js";

// Fixed, read-only Linux inventory; no caller-controlled shell fragments or sudo.
export const DISK_COMMAND = "LC_ALL=C df -P -k -l -T";
const persistent = new Set([
  "ext2",
  "ext3",
  "ext4",
  "xfs",
  "btrfs",
  "zfs",
  "f2fs",
  "jfs",
  "reiserfs",
  "bcachefs",
  "ntfs",
  "ntfs3",
  "vfat",
  "exfat",
  "fuseblk",
  "ufs",
]);
export interface DiskUsage {
  total_bytes: number;
  used_bytes: number;
  available_bytes: number;
  filesystem_count: number;
}
export function validateDiskUsage(value: unknown): DiskUsage {
  if (!value || typeof value !== "object") fail(400, "INVALID_DISK_USAGE");
  const v = value as Record<string, unknown>;
  if (
    Object.keys(v).sort().join() !==
    "available_bytes,filesystem_count,total_bytes,used_bytes"
  )
    fail(400, "INVALID_DISK_USAGE");
  for (const key of [
    "total_bytes",
    "used_bytes",
    "available_bytes",
    "filesystem_count",
  ])
    if (!Number.isSafeInteger(v[key]) || (v[key] as number) < 0)
      fail(400, "INVALID_DISK_USAGE");
  const result = v as unknown as DiskUsage;
  if (
    !result.total_bytes ||
    !result.filesystem_count ||
    result.filesystem_count > 1024 ||
    result.used_bytes + result.available_bytes > result.total_bytes
  )
    fail(400, "INVALID_DISK_USAGE");
  return result;
}
export function parseDiskUsage(text: string): DiskUsage {
  if (Buffer.byteLength(text) > 65536) fail(400, "DISK_OUTPUT_LIMIT");
  const seen = new Set<string>();
  const result = {
    total_bytes: 0,
    used_bytes: 0,
    available_bytes: 0,
    filesystem_count: 0,
  };
  for (const line of text.trim().split(/\r?\n/).slice(1)) {
    const fields = line.trim().split(/\s+/);
    if (!persistent.has(fields[1] ?? "")) continue;
    if (fields.length < 7 || !fields.slice(2, 5).every((v) => /^\d+$/.test(v)))
      fail(400, "INVALID_DISK_USAGE");
    const source = fields[0]!;
    if (seen.has(source)) continue;
    seen.add(source);
    const [total, used, available] = fields
      .slice(2, 5)
      .map((v) => Number(v) * 1024) as [number, number, number];
    validateDiskUsage({
      total_bytes: total,
      used_bytes: used,
      available_bytes: available,
      filesystem_count: 1,
    });
    result.total_bytes += total;
    result.used_bytes += used;
    result.available_bytes += available;
    result.filesystem_count++;
  }
  if (!result.filesystem_count) fail(400, "DISK_NO_LOCAL_FILESYSTEM");
  return validateDiskUsage(result);
}
