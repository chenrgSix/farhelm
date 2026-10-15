import { afterEach, expect, it, vi } from "vitest";
import { flushPromises, mount } from "@vue/test-utils";
import DeviceNetworkPanel from "../src/components/DeviceNetworkPanel.vue";
import { api } from "../src/api/client";
import type { Device, NetworkResponse } from "../src/api/types";
const device: Device = {
  id: "device",
  name: "Linux",
  control_online: true,
  business_healthy: null,
  private_data_reachable: null,
  last_seen: null,
  revoked_at: null,
  agent_version: "0.2.2",
};
const data: NetworkResponse = {
  v: 1,
  device_id: "device",
  device_online: false,
  supported: true,
  last_seen: 100000,
  snapshot: {
    observed_at: 100000,
    received_at: 100001,
    truncated: false,
    addresses: [
      { interface: "eth0", address: "10.2.3.4", family: "ipv4", up: true },
    ],
  },
  events: [
    {
      event_id: "e",
      reason: "connection_lost",
      last_contact_at: 100000,
      detected_at: 120000,
      recovered_at: 195000,
      received_at: 195001,
    },
  ],
  next_before: 50,
};
afterEach(() => vi.restoreAllMocks());
it("shows last reported IP and detected outage time without claiming whole-machine outage; pages and preserves data on failure", async () => {
  const request = vi.spyOn(api, "request").mockResolvedValue(data);
  const wrapper = mount(DeviceNetworkPanel, { props: { device } });
  await flushPromises();
  expect(wrapper.text()).toContain("10.2.3.4");
  expect(wrapper.text()).toContain("离线");
  expect(wrapper.text()).toContain("补传");
  expect(wrapper.text()).toContain("1 分 15 秒");
  expect(wrapper.text()).toContain("无法据此确认整机断网");
  request.mockResolvedValueOnce({
    ...data,
    events: [{ ...data.events[0], reason: "agent_restart" }],
    next_before: null,
  });
  await wrapper
    .findAll("button")
    .find((b) => b.text() === "更早记录")!
    .trigger("click");
  await flushPromises();
  expect(request).toHaveBeenLastCalledWith("/devices/device/network?before=50");
  expect(wrapper.text()).toContain("起点未知");
  expect(wrapper.text()).toContain("第 2 页");
  request.mockRejectedValueOnce(new Error("暂时不可用"));
  await wrapper
    .findAll("button")
    .find((b) => b.text() === "上一页")!
    .trigger("click");
  await flushPromises();
  expect(wrapper.text()).toContain("第 2 页");
  expect(wrapper.text()).toContain("暂时不可用");
  expect(wrapper.text()).toContain("10.2.3.4");
  wrapper.unmount();
});
it("does not restart polling when an outstanding request returns after close", async () => {
  let resolve!: (value: NetworkResponse) => void;
  vi.spyOn(api, "request").mockReturnValue(new Promise((r) => (resolve = r)));
  const timer = vi.spyOn(globalThis, "setInterval");
  const wrapper = mount(DeviceNetworkPanel, { props: { device } });
  wrapper.unmount();
  resolve(data);
  await flushPromises();
  expect(timer).not.toHaveBeenCalled();
});
