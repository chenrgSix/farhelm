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
const view = { scripts: [button], runs: [] };
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
      .mockResolvedValueOnce({ scripts: [], runs: [] })
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
