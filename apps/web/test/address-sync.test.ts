import { afterEach, expect, it, vi } from "vitest";
import { mount, flushPromises } from "@vue/test-utils";
import AgentAddressSyncPanel from "../src/components/AgentAddressSyncPanel.vue";
import { api } from "../src/api/client";
afterEach(() => {
  vi.restoreAllMocks();
  vi.useRealTimers();
});
it("shows distinct saved/applied/legacy/offline states and retries using the displayed revision", async () => {
  vi.useFakeTimers();
  const request = vi.spyOn(api, "request").mockResolvedValue({
    revision: 4,
    devices: [
      { device_id: "a", name: "online", status: "saved", online: true },
      { device_id: "b", name: "done", status: "applied", online: true },
      { device_id: "c", name: "old", status: "unsupported", online: true },
      {
        device_id: "managed",
        name: "VPN Agent",
        status: "network_managed",
        online: true,
      },
      { device_id: "d", name: "offline", status: "pending", online: false },
      {
        device_id: "e",
        name: "failed",
        status: "failed",
        online: true,
        reason: "PROBE_FAILED",
      },
    ],
  });
  const wrapper = mount(AgentAddressSyncPanel, { props: { revision: 4 } });
  await flushPromises();
  for (const text of [
    "已保存，等待终端结束",
    "已切换",
    "由平台网络策略管理",
    "需升级 Agent",
    "等待上线",
    "保留原地址",
  ])
    expect(wrapper.text()).toContain(text);
  const managed = wrapper
    .findAll("li")
    .find((row) => row.text().includes("VPN Agent"))!;
  expect(managed.text()).toContain("在线");
  expect(managed.text()).not.toContain("离线");
  await wrapper.get("button").trigger("click");
  await flushPromises();
  expect(request).toHaveBeenLastCalledWith("/settings/agent-sync", {
    method: "POST",
    body: { v: 1, revision: 4 },
  });
  await vi.advanceTimersByTimeAsync(3000);
  expect(request).toHaveBeenCalledTimes(3);
  wrapper.unmount();
  await vi.advanceTimersByTimeAsync(10000);
  expect(request).toHaveBeenCalledTimes(3);
});
