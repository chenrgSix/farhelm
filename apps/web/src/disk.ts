export function diskBytes(value: number) {
  const units = ["B", "KiB", "MiB", "GiB", "TiB", "PiB"];
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit++;
  }
  return `${value.toLocaleString("zh-CN", { maximumFractionDigits: 1 })} ${units[unit]}`;
}
export function diskPercent(used: number, total: number) {
  return total > 0
    ? Math.min(100, Math.max(0, (used / total) * 100)).toFixed(1)
    : "—";
}
