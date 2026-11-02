import { flushPromises, mount } from "@vue/test-utils";
import { afterEach, expect, it, vi } from "vitest";
import { api, ApiError } from "../src/api/client";
import type { Device, User } from "../src/api/types";
import DeviceWorkbench from "../src/components/DeviceWorkbench.vue";
const device = { id: "device", name: "仓库服务" } as Device;
const user = {
  id: "user",
  role: "ops",
  device_scope: ["device"],
  permissions: ["devices.read", "tasks.read", "scripts.run"],
} as User;
const button = { id: "button", name: "检查状态", revision: 3 };
const view = { scripts: [button], runs: [], activity: [] };
afterEach(() => vi.restoreAllMocks());
it("操作员只能点预设按钮，提交结果不明时重试复用同一请求", async () => {
  vi.spyOn(window, "confirm").mockReturnValue(true);
  const request = vi
    .spyOn(api, "request")
    .mockResolvedValueOnce(view)
    .mockRejectedValueOnce(new ApiError("timeout"))
    .mockResolvedValueOnce({ task_id: "task" })
    .mockResolvedValueOnce({ task_id: "task", status: "SUCCEEDED" })
    .mockResolvedValueOnce(view);
  let wrapper = mount(DeviceWorkbench, {
    props: { user, device },
    global: { stubs: { TaskDetail: true } },
  });
  await flushPromises();
  expect(wrapper.text()).not.toContain("添加操作");
  await wrapper.get("li button").trigger("click");
  await flushPromises();
  expect(wrapper.text()).toContain("提交结果待确认");
  const initial = request.mock.calls[1];
  wrapper.unmount();
  request
    .mockReset()
    .mockResolvedValueOnce(view)
    .mockResolvedValueOnce({ task_id: "task" })
    .mockResolvedValueOnce({ task_id: "task", status: "SUCCEEDED" })
    .mockResolvedValueOnce(view);
  wrapper = mount(DeviceWorkbench, {
    props: { user, device },
    global: { stubs: { TaskDetail: true } },
  });
  await flushPromises();
  await wrapper.get("li button").trigger("click");
  await flushPromises();
  expect(request.mock.calls[1]).toEqual(initial);
  expect(request.mock.calls[1]).toEqual([
    "/devices/device/scripts/button/run",
    {
      method: "POST",
      body: { v: 1, revision: 3 },
      idempotencyKey: expect.any(String),
    },
  ]);
  expect(wrapper.text()).toContain("已提交「检查状态」");
  wrapper.unmount();
});
it.each(["admin", "ops"] as const)(
  "%s 持配置权限可以保存名称和多行脚本",
  async (role) => {
    const request = vi
      .spyOn(api, "request")
      .mockResolvedValueOnce({ scripts: [], runs: [], activity: [] })
      .mockResolvedValueOnce({ id: "new", revision: 1 })
      .mockResolvedValueOnce(view);
    const wrapper = mount(DeviceWorkbench, {
      props: {
        device,
        user: {
          ...user,
          role,
          permissions:
            role === "admin"
              ? [...user.permissions!, "scripts.manage"]
              : ["devices.read", "scripts.manage"],
        },
      },
    });
    await flushPromises();
    await wrapper
      .findAll("button")
      .find((b) => b.text() === "添加操作")!
      .trigger("click");
    await wrapper.get("input").setValue("检查状态");
    await wrapper
      .get("textarea")
      .setValue("cd /tmp\n/bin/sh /opt/ops/check.sh");
    await wrapper.get("form").trigger("submit");
    await flushPromises();
    expect(request.mock.calls[1]).toEqual([
      "/devices/device/scripts",
      {
        method: "POST",
        body: {
          v: 1,
          name: "检查状态",
          script: "cd /tmp\n/bin/sh /opt/ops/check.sh",
        },
      },
    ]);
    expect(wrapper.text()).toContain("操作已保存");
    expect(wrapper.find('[aria-label="配置 检查状态"]').exists()).toBe(true);
    const executable = wrapper
      .findAll("button")
      .some((b) => b.text() === "检查状态");
    expect(executable).toBe(role === "admin");
    wrapper.unmount();
  },
);

it("显示占用人和执行信息，刷新运行状态不会丢失配置草稿", async () => {
  vi.useFakeTimers();
  const owner = {
    script_id: button.id,
    task_id: "held-task",
    actor_username: "alice",
    status: "RUNNING",
    created_at: 1700000000000,
    backend: "ssh",
  };
  const request = vi
    .spyOn(api, "request")
    .mockResolvedValueOnce({ ...view, activity: [owner] })
    .mockResolvedValueOnce({ activity: [] });
  const wrapper = mount(DeviceWorkbench, {
    props: {
      device,
      user: { ...user, permissions: [...user.permissions!, "scripts.manage"] },
    },
    global: { stubs: { TaskDetail: true } },
  });
  try {
    await flushPromises();
    const run = wrapper
      .findAll("button")
      .find((b) => b.text() === button.name)!;
    expect(run.element.disabled).toBe(true);
    expect(wrapper.get(".script-activity").text()).toContain("alice · 执行中");
    expect(wrapper.get(".script-activity").text()).toContain("held-task");
    await wrapper.get('[aria-label="配置 检查状态"]').trigger("click");
    await wrapper.get("textarea").setValue("unfinished draft");
    await vi.advanceTimersByTimeAsync(2000);
    expect(request.mock.calls.at(-1)?.[0]).toBe(
      "/devices/device/scripts/activity",
    );
    expect(run.element.disabled).toBe(false);
    expect(wrapper.get("textarea").element.value).toBe("unfinished draft");
  } finally {
    wrapper.unmount();
    vi.useRealTimers();
  }
});

it("只允许配置人员核实待核对任务，确认时绑定原任务 ID", async () => {
  vi.spyOn(window, "confirm").mockReturnValue(true);
  const open = {
    script_id: button.id,
    task_id: "unknown-task",
    actor_username: "alice",
    status: "UNKNOWN",
    backend: "ssh",
    created_at: 1700000000000,
  };
  const request = vi
    .spyOn(api, "request")
    .mockResolvedValueOnce({ ...view, activity: [open] })
    .mockResolvedValueOnce({ v: 1 })
    .mockResolvedValueOnce({ activity: [] });
  const wrapper = mount(DeviceWorkbench, {
    props: { device, user },
    global: { stubs: { TaskDetail: true } },
  });
  try {
    await flushPromises();
    expect(wrapper.text()).toContain("结果待核对，已锁定");
    expect(wrapper.text()).not.toContain("已核实停止，解除占用");
    await wrapper.setProps({
      user: { ...user, permissions: ["devices.read", "scripts.manage"] },
    });
    await wrapper
      .findAll("button")
      .find((b) => b.text() === "已核实停止，解除占用")!
      .trigger("click");
    await flushPromises();
    expect(request.mock.calls[1]).toEqual([
      "/devices/device/scripts/button/runs/unknown-task/confirm-stopped",
      { method: "POST", body: { v: 1 } },
    ]);
    expect(wrapper.find(".script-activity").exists()).toBe(false);
  } finally {
    wrapper.unmount();
  }
});
