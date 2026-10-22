import { afterEach, expect, it, vi } from "vitest";
import type { User } from "../src/api/types";
import {
  clearDeviceListState,
  defaultDeviceListState,
  readDeviceListState,
  writeDeviceListState,
} from "../src/device-list-state";

const user: User = {
  id: "one",
  username: "one",
  role: "ops",
  device_scope: ["b", "a"],
  permissions: ["devices.read", "tasks.read"],
};
const state = { page: 3, limit: 25, q: "设备", group: "group-a" };
const key = "farhelm.device-list.v1";
afterEach(() => {
  vi.restoreAllMocks();
  sessionStorage.clear();
});

it("restores navigation for the same authorization, irrespective of set ordering", () => {
  writeDeviceListState(user, state);
  expect(
    readDeviceListState({
      ...user,
      username: "renamed",
      device_scope: ["a", "b"],
      permissions: ["tasks.read", "devices.read"],
    }),
  ).toEqual(state);
});
it.each([
  { id: "two" },
  { role: "admin" },
  { device_scope: ["a"] },
  { permissions: ["devices.read"] },
  { permissions: undefined },
  { api_token_id: "token" },
])("discards saved state on authorization change: %j", (change) => {
  writeDeviceListState(user, state);
  expect(readDeviceListState({ ...user, ...change } as User)).toEqual(
    defaultDeviceListState,
  );
  expect(sessionStorage.getItem(key)).toBeNull();
});
it.each([
  { page: -1 },
  { page: 0 },
  { page: 1.1 },
  { page: 1_000_001 },
  { page: "2" },
  { limit: 1000 },
  { q: "x".repeat(257) },
  { q: null },
  { group: "x".repeat(129) },
  { group: [] },
])("rejects invalid navigation: %j", (invalid) => {
  writeDeviceListState(user, state);
  sessionStorage.setItem(
    key,
    JSON.stringify({ ...JSON.parse(sessionStorage.getItem(key)!), ...invalid }),
  );
  expect(readDeviceListState(user)).toEqual(defaultDeviceListState);
  expect(sessionStorage.getItem(key)).toBeNull();
});
it("tolerates corrupt and unavailable storage", () => {
  sessionStorage.setItem(key, "{");
  expect(readDeviceListState(user)).toEqual(defaultDeviceListState);
  for (const method of ["getItem", "setItem", "removeItem"] as const)
    vi.spyOn(Storage.prototype, method).mockImplementation(() => {
      throw Error("disabled");
    });
  expect(readDeviceListState(user)).toEqual(defaultDeviceListState);
  expect(() => writeDeviceListState(user, state)).not.toThrow();
  expect(() => clearDeviceListState()).not.toThrow();
});
