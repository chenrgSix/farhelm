import { afterEach, expect, it, vi } from "vitest";
import { mount, flushPromises } from "@vue/test-utils";
import DeviceDetail from "../src/components/DeviceDetail.vue";
import { api } from "../src/api/client";
import * as clipboard from "../src/clipboard";
import type { Device, DeviceDisk, User } from "../src/api/types";
// Disk-detail tests isolate the workbench, which loads its own API resource.
vi.mock("../src/components/DeviceWorkbench.vue", () => ({
  default: { render: () => null },
}));
const device: Device = {
  id: "device",
  name: "测试服务器",
  control_online: true,
  business_healthy: null,
  private_data_reachable: null,
  last_seen: 1,
  revoked_at: null,
  agent_version: "test",
};
const user: User = {
  id: "admin",
  username: "admin",
  role: "admin",
  device_scope: "*",
};
const data = {
  v: 1,
  device_id: "device",
  interval_hours: 24,
  revision: 0,
  usage: {
    total_bytes: 100 * 1024 ** 3,
    used_bytes: 40 * 1024 ** 3,
    available_bytes: 55 * 1024 ** 3,
    filesystem_count: 2,
  },
  checked_at: Date.now(),
  last_error: null,
  next_collection_at: Date.now() + 86400000,
  cache_until: Date.now() + 300000,
  collecting: false,
  stale: false,
} satisfies DeviceDisk;
afterEach(() => {
  vi.restoreAllMocks();
  vi.useRealTimers();
});
it("previews three IP addresses and lets users expand and collapse the full list", async () => {
  vi.spyOn(api, "request").mockResolvedValue(data);
  const addresses = [
    "10.0.1.20",
    "172.17.0.1",
    "fe80::1",
    "2001:db8:1234:5678:abcd:1234:5678:9abc",
  ];
  const wrapper = mount(DeviceDetail, {
    props: { device: { ...device, ip_addresses: addresses }, user },
  });
  await flushPromises();
  const list = wrapper.get('ul[aria-label="设备 IP 地址"]');
  const shown = () => list.findAll("li").map((row) => row.text());
  const toggle = wrapper.get("button[aria-expanded]");
  expect(shown()).toEqual(addresses.slice(0, 3));
  expect(toggle.text()).toBe("查看全部 4 个地址");
  expect(toggle.attributes("aria-controls")).toBe(list.attributes("id"));
  await toggle.trigger("click");
  expect(shown()).toEqual(addresses);
  expect(toggle.attributes("aria-expanded")).toBe("true");
  await toggle.trigger("click");
  expect(shown()).toEqual(addresses.slice(0, 3));
  expect(toggle.attributes("aria-expanded")).toBe("false");
  await wrapper.setProps({
    device: { ...device, ip_addresses: addresses.slice(0, 3) },
  });
  expect(shown()).toEqual(addresses.slice(0, 3));
  expect(wrapper.find("button[aria-expanded]").exists()).toBe(false);
  await wrapper.setProps({ device });
  expect(wrapper.find('ul[aria-label="设备 IP 地址"]').exists()).toBe(false);
  expect(wrapper.text()).toContain("尚未上报");
  wrapper.unmount();
});
it("copies a device-specific link without any authentication material", async () => {
  vi.spyOn(api, "request").mockResolvedValue(data);
  const copy = vi.spyOn(clipboard, "copyText").mockResolvedValue();
  const wrapper = mount(DeviceDetail, { props: { device, user } });
  await flushPromises();
  await wrapper
    .findAll("button")
    .find((b) => b.text() === "复制设备链接")!
    .trigger("click");
  await flushPromises();
  expect(copy).toHaveBeenCalledWith(
    window.location.origin +
      window.location.pathname +
      window.location.search +
      "#/devices/device",
  );
  expect(wrapper.text()).toContain("设备链接已复制");
  wrapper.unmount();
});
it("joins an existing collection even when the pending attempt has a cache deadline", async () => {
  const request = vi
    .spyOn(api, "request")
    .mockResolvedValueOnce({ ...data, usage: null, collecting: true })
    .mockResolvedValueOnce(data);
  const wrapper = mount(DeviceDetail, { props: { device, user } });
  await flushPromises();
  expect(request).toHaveBeenCalledTimes(2);
  expect(request).toHaveBeenLastCalledWith("/devices/device/disk/collect", {
    method: "POST",
    body: { v: 1 },
    timeoutMs: 25000,
  });
  expect(wrapper.find("meter").exists()).toBe(true);
  wrapper.unmount();
});
it("opens from cache without polling and requests a fresh sample on a manual click", async () => {
  vi.useFakeTimers();
  const updated = {
    ...data,
    checked_at: data.checked_at + 1000,
    usage: { ...data.usage, used_bytes: 60 * 1024 ** 3 },
  };
  const request = vi
    .spyOn(api, "request")
    .mockResolvedValueOnce(data)
    .mockResolvedValueOnce(updated);
  const wrapper = mount(DeviceDetail, { props: { device, user } });
  await flushPromises();
  expect(wrapper.text()).toContain("40.0");
  expect(wrapper.text()).toContain("100 GiB");
  expect(wrapper.get("select").element.value).toBe("24");
  expect(request).toHaveBeenCalledTimes(1);
  await wrapper
    .findAll("button")
    .find((b) => b.text() === "刷新磁盘")!
    .trigger("click");
  await flushPromises();
  expect(request).toHaveBeenCalledTimes(2);
  expect(request).toHaveBeenLastCalledWith("/devices/device/disk/collect", {
    method: "POST",
    body: { v: 1, force: true },
    timeoutMs: 25000,
  });
  expect(wrapper.text()).toContain("60.0");
  expect(wrapper.text()).toContain("磁盘数据已刷新");
  await vi.advanceTimersByTimeAsync(24 * 3600000);
  expect(request).toHaveBeenCalledTimes(2);
  wrapper.unmount();
});
it("collects once when opened without cached data, saves only an explicit schedule and supports returning to the list", async () => {
  const request = vi
    .spyOn(api, "request")
    .mockResolvedValueOnce({
      ...data,
      usage: null,
      cache_until: null,
      checked_at: null,
    })
    .mockResolvedValue(data);
  const wrapper = mount(DeviceDetail, { props: { device, user } });
  await flushPromises();
  expect(request).toHaveBeenCalledTimes(2);
  expect(request).toHaveBeenNthCalledWith(2, "/devices/device/disk/collect", {
    method: "POST",
    body: { v: 1 },
    timeoutMs: 25000,
  });
  await wrapper.get("select").setValue("8");
  expect(request).toHaveBeenCalledTimes(2);
  await wrapper
    .findAll("button")
    .find((b) => b.text() === "保存")!
    .trigger("click");
  await flushPromises();
  expect(request).toHaveBeenLastCalledWith("/devices/device/disk/settings", {
    method: "PUT",
    body: { v: 1, revision: 0, interval_hours: 8 },
  });
  await wrapper.findAll("button")[0]!.trigger("click");
  expect(wrapper.emitted("close")).toHaveLength(1);
  wrapper.unmount();
});
it("shows stale values and the failure reason without giving read-only users schedule controls", async () => {
  vi.spyOn(api, "request").mockResolvedValue({
    ...data,
    last_error: "DEVICE_OFFLINE",
    stale: true,
  });
  const wrapper = mount(DeviceDetail, {
    props: { device, user: { ...user, role: "ops" } },
  });
  await flushPromises();
  expect(wrapper.text()).toContain("设备离线");
  expect(wrapper.text()).toContain("上次成功结果");
  expect(wrapper.find("select").exists()).toBe(false);
  wrapper.unmount();
});
