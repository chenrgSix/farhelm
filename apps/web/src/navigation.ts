export const views = [
  "devices",
  "tasks",
  "audit",
  "terminals",
  "settings",
  "upgrades",
  "access",
  "api",
] as const;
export type View = (typeof views)[number];
export type AppRoute = { view: View; deviceId: string | null };

// Fragment routes work with both the built-in server and existing reverse proxies.
export function readAppRoute(hash = window.location.hash): AppRoute | null {
  const parts = hash.replace(/^#\/?/, "").split("/");
  if (!views.includes(parts[0] as View)) return null;
  if (parts.length === 1) return { view: parts[0] as View, deviceId: null };
  if (parts[0] !== "devices" || parts.length !== 2) return null;
  try {
    const id = decodeURIComponent(parts[1]!);
    if (!id || id.length > 128 || /[\x00-\x1f\x7f/\\]/.test(id)) return null;
    return { view: "devices", deviceId: id };
  } catch {
    return null;
  }
}
export function routeHash(route: AppRoute) {
  return `#/${route.view}${route.view === "devices" && route.deviceId ? "/" + encodeURIComponent(route.deviceId) : ""}`;
}
