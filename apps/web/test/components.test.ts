import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mount, flushPromises } from "@vue/test-utils";
import { webcrypto } from "node:crypto";
import ExecForm from "../src/components/ExecForm.vue";
import TaskDetail from "../src/components/TaskDetail.vue";
import HealthBadge from "../src/components/HealthBadge.vue";
import App from "../src/App.vue";
import { api } from "../src/api/client";
import type { Device, Task, User } from "../src/api/types";
const user: User = {
  id: "user-1",
  username: "admin",
  role: "admin",
  device_scope: "*",
};
const device: Device = {
  id: "device-1",
  name: "测试设备",
  control_online: true,
  private_data_reachable: null,
  business_healthy: null,
  last_seen: 1000,
  revoked_at: null,
  agent_version: "0.1",
};
const task: Task = {
  task_id: "task-1",
  device_id: device.id,
  actor_id: user.id,
  action: "exec",
  argv: ["/usr/bin/uptime"],
  cwd: "/tmp",
  created_at: 1000,
  expires_at: 10000,
  timeout_ms: 1000,
  max_output_bytes: 10000,
  payload_hash: "a".repeat(64),
  status: "RUNNING",
  result: null,
};
beforeEach(() => {
  vi.stubGlobal("crypto", webcrypto);
  vi.spyOn(window, "confirm").mockReturnValue(true);
});
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  api.setToken(null);
});
describe("Exec idempotency user flow", () => {
  it("locks duplicate clicks; retains original request/key through failed response retry", async () => {
    let reject!: (error: Error) => void;
    const request = vi
      .spyOn(api, "request")
      .mockImplementationOnce(
        () =>
          new Promise((_, no) => {
            reject = no;
          }),
      )
      .mockResolvedValueOnce({ task_id: task.task_id, status: "QUEUED" });
    const wrapper = mount(ExecForm, {
      props: { user, devices: [device], initialDevice: device.id },
    });
    await wrapper.find("form").trigger("submit");
    await wrapper.find("form").trigger("submit");
    expect(request).toHaveBeenCalledTimes(1);
    const original = request.mock.calls[0]![1]!;
    reject(new Error("network lost"));
    await flushPromises();
    expect(wrapper.text()).toContain("提交结果尚未确认");
    expect(wrapper.find("fieldset").attributes("disabled")).toBeDefined();
    await wrapper.find("form").trigger("submit");
    await flushPromises();
    expect(request.mock.calls[1]![1]!.idempotencyKey).toBe(
      original.idempotencyKey,
    );
    expect(request.mock.calls[1]![1]!.body).toEqual(original.body);
    expect(wrapper.emitted("created")).toEqual([[task.task_id]]);
    await wrapper.find("form").trigger("submit");
    expect(request).toHaveBeenCalledTimes(2);
    wrapper.unmount();
  });
  it("does not submit business roles or out-of-scope devices", async () => {
    const request = vi.spyOn(api, "request");
    const wrapper = mount(ExecForm, {
      props: {
        user: { ...user, role: "business" },
        devices: [device],
        initialDevice: device.id,
      },
    });
    await wrapper.find("form").trigger("submit");
    await flushPromises();
    expect(request).not.toHaveBeenCalled();
    expect(wrapper.text()).toContain("无权");
    wrapper.unmount();
  });
});
describe("output, uncertainty, and cancellation", () => {
  it("shows unknown health independently of online control", () => {
    const unknown = mount(HealthBadge, { props: { value: null } });
    const online = mount(HealthBadge, { props: { value: true, good: "在线" } });
    expect(unknown.text()).toBe("未知");
    expect(online.text()).toBe("在线");
    unknown.unmount();
    online.unmount();
  });
  it("renders hostile output using text nodes and verifies artifact hash", async () => {
    const bytes = new TextEncoder().encode(
      "<img src=x onerror=alert(1)>\x1b[31mhello",
    );
    const sha256 = Buffer.from(
      await webcrypto.subtle.digest("SHA-256", bytes),
    ).toString("hex");
    vi.spyOn(api, "output").mockResolvedValue(bytes);
    const finished: Task = {
      ...task,
      status: "SUCCEEDED",
      result: {
        status: "SUCCEEDED",
        exit_code: 0,
        reason: null,
        audit_complete: true,
        stdout: { sha256, size: bytes.length },
        stderr: null,
        started_at: 1000,
        finished_at: 2000,
        cleanup: "process_group",
      },
    };
    const wrapper = mount(TaskDetail, { props: { task: finished, user } });
    await wrapper.find(".output-heading button").trigger("click");
    await flushPromises();
    await vi.waitFor(() =>
      expect(wrapper.find('[data-stream="stdout"]').text()).toContain(
        "<img src=x onerror=alert(1)>\\u001b[31mhello",
      ),
    );
    expect(wrapper.find('[data-stream="stdout"] img').exists()).toBe(false);
    wrapper.unmount();
  });
  it("does not display mismatched artifact bytes", async () => {
    vi.spyOn(api, "output").mockResolvedValue(
      new TextEncoder().encode("untrusted"),
    );
    const finished: Task = {
      ...task,
      status: "UNKNOWN",
      result: {
        status: "UNKNOWN",
        exit_code: null,
        reason: "CANCEL_CLEANUP_UNCONFIRMED",
        audit_complete: false,
        stdout: { sha256: "a".repeat(64), size: 9 },
        stderr: null,
        started_at: 1000,
        finished_at: 2000,
        cleanup: "unconfirmed",
      },
    };
    const wrapper = mount(TaskDetail, { props: { task: finished, user } });
    expect(wrapper.text()).toContain("禁止盲目重跑");
    expect(wrapper.text()).toContain("无法确认全部进程清理");
    await wrapper.find(".output-heading button").trigger("click");
    await flushPromises();
    await vi.waitFor(() =>
      expect(wrapper.text()).toContain("SHA-256 与任务记录不符"),
    );
    expect(wrapper.find('[data-stream="stdout"]').text()).not.toContain(
      "untrusted",
    );
    wrapper.unmount();
  });
  it("submits cancellation without pretending the task has stopped", async () => {
    const request = vi
      .spyOn(api, "request")
      .mockResolvedValue({ ok: true, status: "RUNNING" });
    const wrapper = mount(TaskDetail, { props: { task, user } });
    await wrapper.find(".danger-outline").trigger("click");
    await flushPromises();
    expect(request).toHaveBeenCalledWith("/tasks/task-1/cancel", {
      method: "POST",
      body: { v: 1 },
    });
    expect(wrapper.text()).toContain("等待 Agent 的真实结束与清理结果");
    expect(wrapper.find(".status").text()).toBe("执行中");
    expect(wrapper.emitted("refresh")).toHaveLength(1);
    wrapper.unmount();
  });
  it("auditor cannot cancel", () => {
    const wrapper = mount(TaskDetail, {
      props: { task, user: { ...user, role: "auditor" } },
    });
    expect(wrapper.find(".danger-outline").exists()).toBe(false);
    wrapper.unmount();
  });
});
describe("login and real-data-only console", () => {
  it("never exposes sample data when login/API fails", async () => {
    vi.spyOn(api, "request").mockRejectedValue(new Error("API unavailable"));
    const wrapper = mount(App);
    await wrapper.find('input[name="username"]').setValue("admin");
    await wrapper.find('input[name="password"]').setValue("test-password");
    await wrapper.find("form").trigger("submit");
    await flushPromises();
    expect(wrapper.find(".app-shell").exists()).toBe(false);
    expect(wrapper.text()).toContain("API unavailable");
    expect(
      (wrapper.find('input[name="password"]').element as HTMLInputElement)
        .value,
    ).toBe("");
    wrapper.unmount();
  });
  it("business user sees empty real lists and no Exec action", async () => {
    const business = { ...user, role: "business" as const };
    vi.spyOn(api, "request").mockImplementation(async (path) => {
      if (path === "/login")
        return { access_token: "test-token", user: business };
      if (path === "/me") return business;
      if (path === "/devices") return { devices: [] };
      if (path === "/tasks") return { tasks: [] };
      if (path === "/terminal-sessions") return { sessions: [] };
      return { audit: [] };
    });
    const wrapper = mount(App);
    await wrapper.find('input[name="username"]').setValue("business");
    await wrapper.find('input[name="password"]').setValue("test-password");
    await wrapper.find("form").trigger("submit");
    await flushPromises();
    expect(wrapper.text()).toContain("还没有已授权设备");
    expect(wrapper.findComponent(ExecForm).exists()).toBe(false);
    expect(wrapper.find(".heading-actions").text()).not.toContain("执行命令");
    expect(wrapper.find("nav").text()).not.toContain("系统设置");
    expect(localStorage.length).toBe(0);
    wrapper.unmount();
  });
  it("shows system settings to admins and resets the page after signing out", async () => {
    let loggedInUser = user;
    vi.spyOn(api, "request").mockImplementation(async (path) => {
      if (path === "/login")
        return { access_token: "test-token", user: loggedInUser };
      if (path === "/me") return loggedInUser;
      if (path === "/devices") return { devices: [] };
      if (path === "/tasks") return { tasks: [] };
      if (path === "/terminal-sessions") return { sessions: [] };
      if (path === "/settings/agent-sync") return { revision: 1, devices: [] };
      if (path === "/settings")
        return {
          v: 1,
          platform_server_url: "https://fleet.example.com",
          revision: 1,
          updated_at: 1700000000000,
        };
      return { audit: [] };
    });
    const wrapper = mount(App);
    async function login() {
      await wrapper
        .get('input[name="username"]')
        .setValue(loggedInUser.username);
      await wrapper.get('input[name="password"]').setValue("test-password");
      await wrapper.get("form").trigger("submit");
      await flushPromises();
    }
    await login();
    await wrapper
      .findAll("nav button")
      .find((b) => b.text().includes("系统设置"))!
      .trigger("click");
    await flushPromises();
    expect(wrapper.find(".settings-panel").text()).toContain("平台访问地址");
    await wrapper.get('[aria-label="退出登录"]').trigger("click");
    loggedInUser = { ...user, role: "business" };
    await login();
    expect(wrapper.find("nav").text()).not.toContain("系统设置");
    expect(wrapper.find(".settings-panel").exists()).toBe(false);
    expect(wrapper.get("h1").text()).toBe("设备总览");
    wrapper.unmount();
  });
});
