import { afterEach, expect, it, vi } from "vitest";
import { flushPromises, mount } from "@vue/test-utils";
import Panel from "../src/components/DeviceTerminalLimit.vue";
import Connection from "../src/components/DeviceConnectionPanel.vue";
import { api, ApiError } from "../src/api/client";
const initial = {
  v: 1,
  device_id: "one",
  revision: 0,
  limit: null,
  global_limit: 4,
  effective_limit: 4,
  source: "global",
  updated_at: null,
};
afterEach(() => vi.restoreAllMocks());
it("inherits by default, saves only a per-device override and resets with null", async () => {
  const request = vi
    .spyOn(api, "request")
    .mockResolvedValueOnce(initial)
    .mockResolvedValueOnce({
      ...initial,
      limit: 6,
      effective_limit: 6,
      source: "device",
      revision: 1,
    })
    .mockResolvedValueOnce({
      ...initial,
      revision: 2,
      global_limit: 3,
      effective_limit: 3,
    });
  const wrapper = mount(Panel, { props: { deviceId: "one" } });
  await flushPromises();
  expect(
    wrapper.get<HTMLInputElement>('[aria-label="继承全局终端上限"]').element
      .checked,
  ).toBe(true);
  expect(wrapper.find('input[type="number"]').exists()).toBe(false);
  expect(wrapper.text()).toContain("当前已保存的生效上限：4");
  await wrapper.get('[aria-label="继承全局终端上限"]').setValue(false);
  await wrapper.get('[aria-label="本设备终端上限"]').setValue(129);
  await wrapper.get("form").trigger("submit");
  expect(request).toHaveBeenCalledTimes(1);
  await wrapper.get('[aria-label="本设备终端上限"]').setValue(6);
  await wrapper.get("form").trigger("submit");
  await flushPromises();
  expect(request).toHaveBeenCalledWith("/devices/one/terminal-limit", {
    method: "PUT",
    body: { v: 1, revision: 0, limit: 6 },
  });
  await wrapper.get('[aria-label="继承全局终端上限"]').setValue(true);
  await wrapper.get("form").trigger("submit");
  await flushPromises();
  expect(request).toHaveBeenLastCalledWith("/devices/one/terminal-limit", {
    method: "PUT",
    body: { v: 1, revision: 1, limit: null },
  });
  expect(wrapper.text()).toContain("当前已保存的生效上限：3");
  expect(wrapper.emitted("changed")).toHaveLength(2);
  wrapper.unmount();
});
it("keeps conflicts and uncertain saves from being retried until reload", async () => {
  const request = vi
    .spyOn(api, "request")
    .mockResolvedValueOnce(initial)
    .mockRejectedValueOnce(
      new ApiError("DEVICE_TERMINAL_LIMIT_CHANGED_RELOAD", 409),
    )
    .mockResolvedValueOnce({
      ...initial,
      revision: 2,
      limit: 8,
      effective_limit: 8,
      source: "device",
    });
  const wrapper = mount(Panel, { props: { deviceId: "one" } });
  await flushPromises();
  await wrapper.get('[aria-label="继承全局终端上限"]').setValue(false);
  await wrapper.get('[aria-label="本设备终端上限"]').setValue(6);
  await wrapper.get("form").trigger("submit");
  await flushPromises();
  expect(wrapper.get('[role="alert"]').text()).toContain("重新加载");
  await wrapper.get("form").trigger("submit");
  expect(request).toHaveBeenCalledTimes(2);
  await wrapper.get('button[type="button"]').trigger("click");
  await flushPromises();
  expect(
    wrapper.get<HTMLInputElement>('[aria-label="本设备终端上限"]').element
      .value,
  ).toBe("8");
  wrapper.unmount();
});
it.each(["agent", "ssh"])(
  "places a separate terminal-limit tab in %s device configuration without submitting SSH credentials",
  async (kind) => {
    const request = vi.spyOn(api, "request").mockResolvedValue({
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
      global: { stubs: { DeviceTerminalLimit: true } },
    });
    await flushPromises();
    await wrapper
      .findAll("button")
      .find((b) => b.text() === "终端限额")!
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
