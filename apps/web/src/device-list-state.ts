import type { User } from "./api/types";

const key = "farhelm.device-list.v1";
export interface DeviceListState {
  page: number;
  limit: number;
  q: string;
  group: string;
}
export const defaultDeviceListState: DeviceListState = {
  page: 1,
  limit: 50,
  q: "",
  group: "",
};

// Compare effective authorization as sets, so server ordering changes do not
// discard navigation. Never use the stored key as an authorization source.
export function deviceListAuthorization(user: User): string {
  return JSON.stringify([
    user.id,
    user.api_token_id ?? null,
    user.role,
    user.device_scope === "*" ? "*" : [...new Set(user.device_scope)].sort(),
    user.permissions ? [...new Set(user.permissions)].sort() : null,
  ]);
}

export function clearDeviceListState(): void {
  try {
    sessionStorage.removeItem(key);
  } catch {
    // Storage may be disabled; in-memory navigation still works.
  }
}

export function readDeviceListState(user: User): DeviceListState {
  try {
    const raw = sessionStorage.getItem(key);
    if (raw) {
      const saved = JSON.parse(raw);
      if (
        saved?.authorization === deviceListAuthorization(user) &&
        Number.isSafeInteger(saved.page) &&
        saved.page >= 1 &&
        saved.page <= 1_000_000 &&
        [25, 50, 100].includes(saved.limit) &&
        typeof saved.q === "string" &&
        saved.q.length <= 256 &&
        typeof saved.group === "string" &&
        saved.group.length <= 128
      )
        return {
          page: saved.page,
          limit: saved.limit,
          q: saved.q.trim(),
          group: saved.group,
        };
    }
  } catch {
    // Corrupt or inaccessible storage must not prevent login.
  }
  clearDeviceListState();
  return { ...defaultDeviceListState };
}

export function writeDeviceListState(user: User, state: DeviceListState): void {
  try {
    sessionStorage.setItem(
      key,
      JSON.stringify({
        authorization: deviceListAuthorization(user),
        ...state,
      }),
    );
  } catch {
    // No credential, device data, or cross-page selections are stored here.
  }
}
