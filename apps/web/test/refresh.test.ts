import { afterEach, describe, expect, it, vi } from "vitest";
import { flushPromises, mount, type VueWrapper } from "@vue/test-utils";
import App from "../src/App.vue";
import { api } from "../src/api/client";

const user = {
  id: "admin-1",
  username: "admin",
  role: "admin",
  device_scope: "*",
};
const device = {
  id: "device-1",
  name: "生产设备",
  connection_kind: "agent",
  control_online: true,
  private_data_reachable: null,
  business_healthy: null,
  last_seen: 1000,
  revoked_at: null,
  agent_version: "0.2.3",
};
let wrapper: VueWrapper | undefined;
afterEach(() => {
  wrapper?.unmount();
  wrapper = undefined;
  vi.restoreAllMocks();
  vi.useRealTimers();
  api.setToken(null);
});
async function login() {
  await wrapper!.get('input[name="username"]').setValue("admin");
  await wrapper!.get('input[name="password"]').setValue("test-password");
  await wrapper!.get("form").trigger("submit");
  await flushPromises();
}
function navigate(label: string) {
  return wrapper!
    .findAll("nav button")
    .find((b) => b.text().includes(label))!
    .trigger("click");
}
function mockApi(extra: (path: string) => unknown = () => undefined) {
  return vi.spyOn(api, "request").mockImplementation(async (path) => {
    path = path.split("?")[0]!;
    const result = extra(path);
    if (result !== undefined) return result;
    if (path === "/login") return { access_token: "test-token", user };
    if (path === "/me") return user;
    if (path === "/devices") return { devices: [device] };
    if (path === "/tasks") return { tasks: [] };
    if (path === "/audit") return { audit: [] };
    if (path === "/terminal-sessions") return { sessions: [] };
    return { device_groups: [] };
  });
}

describe("independent list refresh", () => {
  it("keeps device operations available when the task overview fails", async () => {
    const request = mockApi((path) => {
      if (path === "/tasks") throw new Error("task service unavailable");
    });
    wrapper = mount(App);
    await login();
    expect(wrapper.text()).toContain("生产设备");
    expect(wrapper.text()).toContain("任务概况刷新失败");
    expect(
      wrapper
        .findAll("button")
        .find((b) => b.text() === "连接终端")!
        .attributes("disabled"),
    ).toBeUndefined();
    expect(
      request.mock.calls.some(
        ([path]) => path === "/audit" || path === "/terminal-sessions",
      ),
    ).toBe(false);
  });

  it("preserves failed history data and polls only the selected history page", async () => {
    vi.useFakeTimers();
    let failAudit = false;
    const request = mockApi((path) => {
      if (path === "/audit") {
        if (failAudit) throw new Error("audit unavailable");
        return {
          audit: [
            {
              id: 1,
              at: 1000,
              action: "task.created",
              actor_id: user.id,
              device_id: device.id,
              task_id: null,
              detail: {},
            },
          ],
        };
      }
    });
    wrapper = mount(App);
    await login();
    await navigate("操作审计");
    await flushPromises();
    expect(wrapper.text()).toContain("task.created");
    failAudit = true;
    request.mockClear();
    await vi.advanceTimersByTimeAsync(10_000);
    await flushPromises();
    expect(wrapper.text()).toContain("task.created");
    expect(wrapper.text()).toContain("保留上次成功读取的数据");
    expect(
      request.mock.calls.some(
        ([path]) => path === "/tasks" || path === "/terminal-sessions",
      ),
    ).toBe(false);
    await navigate("设备总览");
    await flushPromises();
    expect(wrapper.text()).not.toContain("audit unavailable");
    expect(
      wrapper
        .findAll("button")
        .find((b) => b.text() === "连接终端")!
        .attributes("disabled"),
    ).toBeUndefined();
  });

  it("does not apply a previous session's late list response after signing in again", async () => {
    let resolve!: (value: unknown) => void;
    let calls = 0;
    mockApi((path) => {
      if (path === "/devices" && calls++ === 0)
        return new Promise((done) => {
          resolve = done;
        });
    });
    wrapper = mount(App);
    await login();
    await wrapper.get('[aria-label="退出登录"]').trigger("click");
    // Finish the old login request before starting a new one.
    resolve({ devices: [{ ...device, name: "旧会话设备" }] });
    await flushPromises();
    await login();
    expect(wrapper.text()).toContain("生产设备");
    expect(wrapper.text()).not.toContain("旧会话设备");
  });
});
