import { afterEach, expect, it, vi } from "vitest";
import { mount, flushPromises, type VueWrapper } from "@vue/test-utils";
import App from "../src/App.vue";
import { api, ApiError } from "../src/api/client";
import { writeTabSession } from "../src/tab-session";
import { readAppRoute, routeHash } from "../src/navigation";

const admin = {
  id: "admin",
  username: "admin",
  role: "admin",
  device_scope: "*",
};
const device = {
  id: "one",
  name: "一号服务器",
  control_online: true,
  terminal_available: true,
  revoked_at: null,
  agent_version: "test",
  last_seen: null,
};
let wrapper: VueWrapper | undefined;
afterEach(() => {
  wrapper?.unmount();
  wrapper = undefined;
  vi.restoreAllMocks();
  api.setToken(null);
  sessionStorage.clear();
  window.history.replaceState(null, "", "/");
});
function mock() {
  return vi.spyOn(api, "request").mockImplementation(async (path) => {
    if (path === "/me") return admin;
    if (path === "/login") return { access_token: "test-token", user: admin };
    if (path === "/devices/one") return device;
    if (path === "/devices/missing")
      throw new ApiError("设备不存在或无权查看", 404);
    if (path === "/devices") return { devices: [device] };
    if (path.startsWith("/tasks")) return { tasks: [] };
    return {};
  });
}
function mountApp() {
  wrapper = mount(App, {
    global: {
      stubs: {
        DeviceDetail: {
          props: ["device"],
          template:
            '<section aria-label="设备详情"><h2>{{device.name}}</h2><button @click="$emit(\'close\')">返回设备列表</button><slot name="actions" /></section>',
        },
      },
    },
  });
}
it("encodes device links and rejects malformed or unrecognized routes", () => {
  const route = { view: "devices" as const, deviceId: "设备 空格" };
  expect(readAppRoute(routeHash(route))).toEqual(route);
  for (const hash of [
    "#/devices/%",
    "#/devices/a/b",
    "#/devices/%2F",
    "#/devices/",
    "#/unknown",
    "#/settings/a",
  ])
    expect(readAppRoute(hash)).toBeNull();
});
it("restores a direct detail link after login and reload without loading the full list", async () => {
  window.history.replaceState(null, "", "/#/devices/one");
  const request = mock();
  mountApp();
  expect(request).not.toHaveBeenCalled();
  await wrapper!.get('[name="username"]').setValue("admin");
  await wrapper!.get('[name="password"]').setValue("password1");
  await wrapper!.get("form").trigger("submit");
  await flushPromises();
  expect(wrapper!.get("h2").text()).toBe(device.name);
  expect(
    request.mock.calls.some(([p]) => p === "/devices" || p === "/tasks"),
  ).toBe(false);
  expect(wrapper!.findAll("button").some((b) => b.text() === "健康检查")).toBe(
    true,
  );
  expect(wrapper!.findAll("button").some((b) => b.text() === "连接终端")).toBe(
    true,
  );
  wrapper!.unmount();
  request.mockClear();
  mountApp();
  await flushPromises();
  expect(wrapper!.get("h2").text()).toBe(device.name);
  expect(
    request.mock.calls.some(([p]) => p === "/login" || p === "/devices"),
  ).toBe(false);
});
it("handles history navigation and missing details while preserving the route", async () => {
  writeTabSession({ token: "test-token", view: "devices" });
  mock();
  mountApp();
  await flushPromises();
  await wrapper!
    .get('[aria-label="查看设备详情：一号服务器"]')
    .trigger("click");
  await flushPromises();
  expect(window.location.hash).toBe("#/devices/one");
  window.history.replaceState(null, "", "/#/devices");
  window.dispatchEvent(new PopStateEvent("popstate"));
  await flushPromises();
  expect(wrapper!.get("h1").text()).toBe("设备总览");
  window.history.replaceState(null, "", "/#/devices/missing");
  window.dispatchEvent(new PopStateEvent("popstate"));
  await flushPromises();
  expect(wrapper!.text()).toContain("设备不存在或无权查看");
  expect(wrapper!.find('[aria-label="设备详情"]').exists()).toBe(false);
  expect(window.location.hash).toBe("#/devices/missing");
});
it("does not query a bookmarked device outside the current user's scope", async () => {
  window.history.replaceState(null, "", "/#/devices/one");
  writeTabSession({ token: "test-token", view: "devices" });
  const request = vi
    .spyOn(api, "request")
    .mockResolvedValue({ ...admin, role: "ops", device_scope: [] });
  mountApp();
  await flushPromises();
  expect(wrapper!.text()).toContain("无权查看");
  expect(request.mock.calls.every(([p]) => p === "/me")).toBe(true);
});
