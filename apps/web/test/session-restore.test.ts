import { afterEach, expect, it, vi } from "vitest";
import { flushPromises, mount, type VueWrapper } from "@vue/test-utils";
import App from "../src/App.vue";
import { api, ApiError } from "../src/api/client";
import { readTabSession, writeTabSession } from "../src/tab-session";
import {
  readDeviceListState,
  writeDeviceListState,
} from "../src/device-list-state";
import type { User } from "../src/api/types";
const savedList = { page: 2, limit: 25, q: "saved-filter", group: "group" };

const admin = {
  id: "admin-1",
  username: "admin",
  role: "admin",
  device_scope: "*",
};
let wrapper: VueWrapper | undefined;
afterEach(() => {
  window.history.replaceState(null, "", "/");
  wrapper?.unmount();
  wrapper = undefined;
  vi.restoreAllMocks();
  api.setToken(null);
  sessionStorage.clear();
});
function mockApi(me: () => unknown = () => admin) {
  return vi.spyOn(api, "request").mockImplementation(async (path) => {
    if (path === "/me") return me();
    if (path === "/login") return { access_token: "saved-token", user: admin };
    if (path.startsWith("/devices")) return { devices: [] };
    if (path.startsWith("/tasks")) return { tasks: [] };
    if (path.startsWith("/terminal-sessions")) return { sessions: [] };
    if (path.startsWith("/audit")) return { audit: [] };
    return { device_groups: [] };
  });
}

it("restores a verified login and selected page across reload without posting credentials again", async () => {
  const request = mockApi();
  wrapper = mount(App);
  await wrapper.get('[name="username"]').setValue("admin");
  await wrapper.get('[name="password"]').setValue("test-password1");
  await wrapper.get("form").trigger("submit");
  await flushPromises();
  await wrapper
    .findAll("nav button")
    .find((b) => b.text().includes("终端会话"))!
    .trigger("click");
  await flushPromises();
  expect(readTabSession()).toEqual({ token: "saved-token", view: "terminals" });
  expect(sessionStorage.getItem("farhelm.tab-session.v1")).not.toContain(
    "password",
  );
  expect(localStorage.length).toBe(0);
  wrapper.unmount();
  request.mockClear();
  wrapper = mount(App);
  await flushPromises();
  expect(wrapper.get("h1").text()).toBe("终端会话");
  expect(wrapper.get(".account").text()).toContain("admin");
  expect(request.mock.calls[0]![0]).toBe("/me");
  expect(request.mock.calls.some(([p]) => p === "/login")).toBe(false);
});

it("withholds protected UI until verification and ignores a saved page outside current permissions", async () => {
  writeDeviceListState(admin as User, savedList);
  writeTabSession({ token: "saved-token", view: "settings" });
  let finish!: (v: unknown) => void;
  const pending = new Promise((resolve) => {
    finish = resolve;
  });
  const request = mockApi(() => pending);
  wrapper = mount(App);
  await flushPromises();
  expect(wrapper.text()).toContain("正在恢复登录");
  expect(wrapper.find("nav").exists()).toBe(false);
  expect(wrapper.find("form").exists()).toBe(false);
  expect(request.mock.calls).toHaveLength(1);
  finish({
    ...admin,
    role: "business",
    permissions: ["devices.read"],
    device_scope: [],
  });
  await flushPromises();
  expect(wrapper.get("h1").text()).toBe("设备总览");
  expect(wrapper.get("nav").text()).not.toContain("系统设置");
  expect(readTabSession()?.view).toBe("devices");
  expect(sessionStorage.getItem("farhelm.device-list.v1")).toBeNull();
  expect(request).toHaveBeenCalledWith("/devices?page=1&limit=50");
});

it("retains the credential on network failure and retries only identity verification", async () => {
  writeDeviceListState(admin as User, savedList);
  writeTabSession({ token: "saved-token", view: "devices" });
  let offline = true;
  const request = mockApi(() => {
    if (offline) throw new ApiError("offline");
    return admin;
  });
  wrapper = mount(App);
  await flushPromises();
  expect(wrapper.get('[role="alert"]').text()).toContain("暂时无法校验");
  expect(wrapper.find("nav").exists()).toBe(false);
  expect(readTabSession()?.token).toBe("saved-token");
  expect(readDeviceListState(admin as User)).toEqual(savedList);
  offline = false;
  await wrapper.get(".session-restore button").trigger("click");
  await flushPromises();
  expect(wrapper.get(".account").text()).toContain("admin");
  expect(request.mock.calls.some(([p]) => p === "/login")).toBe(false);
  expect(request).toHaveBeenCalledWith(
    "/devices?page=2&limit=25&q=saved-filter&group=group",
  );
});

it("clears an expired or revoked credential and does not restore it on another reload", async () => {
  writeDeviceListState(admin as User, savedList);
  writeTabSession({ token: "expired-token", view: "settings" });
  const request = mockApi(() => {
    throw new ApiError("expired", 401);
  });
  wrapper = mount(App);
  await flushPromises();
  expect(wrapper.find('[name="password"]').exists()).toBe(true);
  expect(wrapper.text()).toContain("登录已失效");
  expect(readTabSession()).toBeNull();
  expect(sessionStorage.getItem("farhelm.device-list.v1")).toBeNull();
  wrapper.unmount();
  request.mockClear();
  wrapper = mount(App);
  await flushPromises();
  expect(request).not.toHaveBeenCalled();
  expect(wrapper.find("nav").exists()).toBe(false);
});

it("does not revive a late restore response after the page has been disposed", async () => {
  writeTabSession({ token: "saved-token", view: "settings" });
  let finish!: (v: unknown) => void;
  mockApi(
    () =>
      new Promise((resolve) => {
        finish = resolve;
      }),
  );
  wrapper = mount(App);
  wrapper.unmount();
  wrapper = undefined;
  writeTabSession(null);
  finish(admin);
  await flushPromises();
  expect(readTabSession()).toBeNull();
});

it("handles corrupt storage and keeps in-memory login usable when persistence is blocked", async () => {
  sessionStorage.setItem("farhelm.tab-session.v1", "not-json");
  expect(readTabSession()).toBeNull();
  expect(sessionStorage.length).toBe(0);
  vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
    throw new DOMException("blocked", "SecurityError");
  });
  mockApi();
  wrapper = mount(App);
  await wrapper.get('[name="username"]').setValue("admin");
  await wrapper.get('[name="password"]').setValue("test-password1");
  await wrapper.get("form").trigger("submit");
  await flushPromises();
  expect(wrapper.get(".account").text()).toContain("admin");
  expect(wrapper.text()).toContain("浏览器未允许保存标签页会话");
});
