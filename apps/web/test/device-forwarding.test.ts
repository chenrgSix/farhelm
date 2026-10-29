import { afterEach, expect, it, vi } from "vitest";
import { flushPromises, mount } from "@vue/test-utils";
import Panel from "../src/components/DeviceForwarding.vue";
import Connection from "../src/components/DeviceConnectionPanel.vue";
import { api, ApiError } from "../src/api/client";
const initial = {
  v: 1,
  device_id: "one",
  revision: 0,
  enabled: false,
  updated_at: null,
};
afterEach(() => vi.restoreAllMocks());
it("shows the default-off scope, saves enable and disable with the current revision", async () => {
  const request = vi
    .spyOn(api, "request")
    .mockResolvedValueOnce(initial)
    .mockResolvedValueOnce({ ...initial, enabled: true, revision: 1 })
    .mockResolvedValueOnce({ ...initial, revision: 2 });
  const wrapper = mount(Panel, { props: { deviceId: "one" } });
  await flushPromises();
  expect(
    wrapper.get<HTMLInputElement>('[aria-label="允许 TCP 转发"]').element
      .checked,
  ).toBe(false);
  expect(wrapper.text()).toContain("默认关闭");
  expect(wrapper.text()).toContain("关闭后立即断开");
  expect(
    wrapper.get<HTMLButtonElement>('button[type="submit"]').element.disabled,
  ).toBe(true);
  await wrapper.get('[aria-label="允许 TCP 转发"]').setValue(true);
  await wrapper.get("form").trigger("submit");
  await flushPromises();
  expect(request).toHaveBeenLastCalledWith("/devices/one/forwarding", {
    method: "PUT",
    body: { v: 1, revision: 0, enabled: true },
  });
  expect(wrapper.get('[role="status"]').text()).toContain("已允许");
  await wrapper.get('[aria-label="允许 TCP 转发"]').setValue(false);
  await wrapper.get("form").trigger("submit");
  await flushPromises();
  expect(request).toHaveBeenLastCalledWith("/devices/one/forwarding", {
    method: "PUT",
    body: { v: 1, revision: 1, enabled: false },
  });
  expect(wrapper.get('[role="status"]').text()).toContain("已关闭转发");
  expect(wrapper.emitted("changed")).toHaveLength(2);
  wrapper.unmount();
});
it.each([
  new ApiError("DEVICE_FORWARDING_CHANGED_RELOAD", 409),
  new ApiError("network", 0),
])("requires reload after a conflict or uncertain save: %s", async (error) => {
  const request = vi
    .spyOn(api, "request")
    .mockResolvedValueOnce(initial)
    .mockRejectedValueOnce(error)
    .mockResolvedValueOnce({ ...initial, enabled: true, revision: 2 });
  const wrapper = mount(Panel, { props: { deviceId: "one" } });
  await flushPromises();
  await wrapper.get('[aria-label="允许 TCP 转发"]').setValue(true);
  await wrapper.get("form").trigger("submit");
  await flushPromises();
  expect(wrapper.get('[role="alert"]').text()).toContain("重新加载");
  await wrapper.get("form").trigger("submit");
  expect(request).toHaveBeenCalledTimes(2);
  await wrapper.get('button[type="button"]').trigger("click");
  await flushPromises();
  expect(
    wrapper.get<HTMLInputElement>('[aria-label="允许 TCP 转发"]').element
      .checked,
  ).toBe(true);
  expect(wrapper.find('[role="alert"]').exists()).toBe(false);
  wrapper.unmount();
});
it.each(["agent", "ssh"])(
  "offers forwarding settings separately from credentials for %s devices",
  async (kind) => {
    const request = vi
      .spyOn(api, "request")
      .mockResolvedValue({
        v: 1,
        device_id: "one",
        kind,
        revision: 1,
        ssh: null,
      });
    const wrapper = mount(Connection, {
      props: {
        device: { id: "one", name: "test", connection_kind: kind } as any,
      },
      global: { stubs: { DeviceForwarding: true } },
    });
    await flushPromises();
    await wrapper
      .findAll("button")
      .find((b) => b.text() === "TCP 转发")!
      .trigger("click");
    expect(wrapper.findComponent(Panel).props("deviceId")).toBe("one");
    expect(wrapper.find("#connection-config-form").exists()).toBe(false);
    expect(wrapper.findAll("button").some((b) => b.text() === "保存配置")).toBe(
      false,
    );
    expect(request).toHaveBeenCalledTimes(1);
    wrapper.unmount();
  },
);
