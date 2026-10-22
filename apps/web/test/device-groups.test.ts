import { afterEach, expect, it, vi } from "vitest";
import { flushPromises, mount } from "@vue/test-utils";
import DeviceGroupTools from "../src/components/DeviceGroupTools.vue";
import { api } from "../src/api/client";
import type { Device, ManagedDeviceGroup } from "../src/api/types";
const devices: Device[] = [
  {
    id: "one",
    name: "Linux-1",
    control_online: false,
    business_healthy: null,
    private_data_reachable: null,
    last_seen: null,
    revoked_at: null,
    agent_version: null,
    device_groups: [{ id: "prod", name: "生产" }],
  },
  {
    id: "two",
    name: "Linux-2",
    control_online: false,
    business_healthy: null,
    private_data_reachable: null,
    last_seen: null,
    revoked_at: null,
    agent_version: null,
    device_groups: [],
  },
];
const groups: ManagedDeviceGroup[] = [
  {
    id: "prod",
    name: "生产",
    description: "",
    revision: 1,
    device_ids: ["one"],
  },
  { id: "region", name: "地区", description: "", revision: 0, device_ids: [] },
];
afterEach(() => vi.restoreAllMocks());
async function setup(admin = true) {
  const request = vi
    .spyOn(api, "request")
    .mockImplementation(async (_path, options) =>
      _path.startsWith("/device-options?")
        ? {
            devices,
            page: {
              number: 1,
              limit: 25,
              total: devices.length,
              pages: 1,
              visible_total: devices.length,
              groups: [],
            },
          }
        : options
          ? { v: 1, changed_count: 2 }
          : ({ v: 1, device_groups: structuredClone(groups) } as any),
    );
  const wrapper = mount(DeviceGroupTools, {
    props: {
      devices,
      admin,
      selectedIds: ["one", "two"],
      visibleIds: ["one"],
      filter: "",
    },
    global: { stubs: { Teleport: true } },
  });
  await flushPromises();
  return { wrapper, request };
}
it("filter is available to readers without fetching privileged groups or exposing management controls", async () => {
  const { wrapper, request } = await setup(false);
  expect(request).not.toHaveBeenCalled();
  expect(wrapper.text()).not.toContain("管理设备组");
  expect(wrapper.text()).not.toContain("添加标签");
  await wrapper.get("select").setValue("prod");
  expect(wrapper.emitted("update:filter")).toEqual([["prod"]]);
  await wrapper.get("select").setValue("__ungrouped__");
  expect(wrapper.emitted("update:filter")?.at(-1)).toEqual(["__ungrouped__"]);
  wrapper.unmount();
});
it("batch requests use a frozen selection across filters, preserve selection afterwards and never replace all group members", async () => {
  const { wrapper, request } = await setup();
  expect(wrapper.text()).toContain("1 台不在当前页");
  await wrapper
    .findAll("button")
    .find((b) => b.text() === "添加标签")!
    .trigger("click");
  await flushPromises();
  await wrapper.get('[aria-label="批量标签 地区"]').setValue(true);
  await wrapper.setProps({ selectedIds: ["one"] });
  await wrapper.get("form").trigger("submit");
  await flushPromises();
  expect(request).toHaveBeenCalledWith("/device-groups/batch", {
    method: "POST",
    body: {
      v: 1,
      operation: "add",
      device_ids: ["one", "two"],
      group_ids: ["region"],
    },
  });
  expect(wrapper.emitted("update:selectedIds")).toBeUndefined();
  expect(wrapper.emitted("changed")).toHaveLength(1);
  await wrapper
    .findAll("button")
    .find((b) => b.text() === "移除标签")!
    .trigger("click");
  await flushPromises();
  await wrapper.get('[aria-label="批量标签 生产"]').setValue(true);
  await wrapper.get("form").trigger("submit");
  await flushPromises();
  expect(request).toHaveBeenCalledWith("/device-groups/batch", {
    method: "POST",
    body: {
      v: 1,
      operation: "remove",
      device_ids: ["one"],
      group_ids: ["prod"],
    },
  });
  wrapper.unmount();
});
it("management supports empty and overlapping groups and prevents stale editor overwrites", async () => {
  const { wrapper, request } = await setup();
  await wrapper
    .findAll("button")
    .find((b) => b.text() === "管理设备组")!
    .trigger("click");
  await flushPromises();
  await wrapper
    .findAll("button")
    .find((b) => b.text() === "创建设备组")!
    .trigger("click");
  await wrapper.get('input[maxlength="64"]').setValue("空组");
  await wrapper.get("form").trigger("submit");
  await flushPromises();
  expect(request).toHaveBeenCalledWith("/device-groups", {
    method: "POST",
    body: { v: 1, name: "空组", description: "", device_ids: [] },
  });
  await wrapper.get('[aria-label="编辑设备组 地区"]').trigger("click");
  await wrapper
    .findAll("button")
    .find((b) => b.text() === "选择组内设备")!
    .trigger("click");
  await flushPromises();
  await wrapper.get('[aria-label="组内设备 Linux-1"]').setValue(true);
  request.mockRejectedValueOnce(new Error("ACCESS_REVISION_CONFLICT"));
  await wrapper.get("form").trigger("submit");
  await flushPromises();
  expect(request).toHaveBeenCalledWith("/device-groups/region", {
    method: "PUT",
    body: {
      v: 1,
      revision: 0,
      name: "地区",
      description: "",
      device_ids: ["one"],
    },
  });
  expect(
    wrapper.get('button[type="submit"]').attributes("disabled"),
  ).toBeDefined();
  expect(wrapper.text()).toContain("核对最新状态");
  wrapper.unmount();
});
