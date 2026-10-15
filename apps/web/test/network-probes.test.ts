import { afterEach, expect, it, vi } from "vitest";
import { flushPromises, mount } from "@vue/test-utils";
import NetworkProbesPanel from "../src/components/NetworkProbesPanel.vue";
import { api } from "../src/api/client";
import type { Device, User, NetworkProbeResponse } from "../src/api/types";
const device: Device = {
  id: "d",
  name: "Linux",
  control_online: true,
  private_data_reachable: null,
  business_healthy: null,
  last_seen: null,
  revoked_at: null,
  agent_version: "0.2.3",
};
const user: User = {
  id: "u",
  username: "ops",
  role: "ops",
  device_scope: ["d"],
};
const data: NetworkProbeResponse = {
  v: 1,
  config: {
    revision: 0,
    enabled: false,
    interval_secs: 30,
    timeout_ms: 3000,
    failure_threshold: 3,
    targets: [],
  },
  applied_revision: 0,
  supported: true,
  device_online: true,
  result: null,
  result_fresh: false,
  events: [],
  next_before: null,
};
afterEach(() => vi.restoreAllMocks());
it("saves per-device targets and timing, preserves unsaved edits on refresh, and exposes pending application", async () => {
  const request = vi.spyOn(api, "request").mockResolvedValue(data);
  const w = mount(NetworkProbesPanel, { props: { device, user } });
  await flushPromises();
  await w.find('input[type="checkbox"]').setValue(true);
  for (let i = 0; i < 2; i++)
    await w
      .findAll("button")
      .find((b) => b.text() === "添加探测地址")!
      .trigger("click");
  await w.findAll('input[type="text"]')[0].setValue("tcp://192.168.1.1:53");
  await w.findAll('input[type="text"]')[1].setValue("https://example.test/");
  await w.findAll('input[type="number"]')[0].setValue(10);
  let sent: any;
  request.mockImplementation(async (_p, options) => {
    sent = options!.body;
    return {
      ...data,
      config: { ...sent.config, revision: 1 },
      applied_revision: null,
    };
  });
  await w.find("form").trigger("submit");
  await flushPromises();
  expect(sent.config.targets).toEqual([
    "tcp://192.168.1.1:53",
    "https://example.test/",
  ]);
  expect(sent.config.interval_secs).toBe(10);
  expect(w.text()).toContain("配置已保存");
  expect(w.text()).toContain("等待 Agent 确认");
  w.unmount();
});
it("keeps stale offline evidence labelled as historical and forbids read-only users from changing config", async () => {
  const report = {
    sample_id: "s",
    seq: 1,
    revision: 1,
    observed_at: 100,
    platform_connected: false,
    status: "suspected_offline" as const,
    consecutive_failures: 3,
    results: [
      {
        target: "tcp://host:80",
        reachable: false,
        reason: "TIMEOUT",
        duration_ms: 100,
      },
    ],
  };
  vi.spyOn(api, "request").mockResolvedValue({
    ...data,
    config: { ...data.config, enabled: true, revision: 1 },
    device_online: false,
    result: report,
    events: [{ ...report, received_at: 200 }],
  });
  const w = mount(NetworkProbesPanel, {
    props: { device, user: { ...user, role: "auditor" } },
  });
  await flushPromises();
  expect(w.text()).toContain("仅作历史参考");
  expect(w.text()).toContain("恢复后补传");
  expect(w.find("fieldset").attributes("disabled")).toBeDefined();
  expect(w.text()).not.toContain("保存探测配置");
  expect(w.text()).toContain("疑似网络故障");
  w.unmount();
});
it("ignores a stale polling response that arrives after a successful save", async () => {
  vi.useFakeTimers();
  let pending!: (v: any) => void;
  const request = vi
    .spyOn(api, "request")
    .mockResolvedValueOnce(data)
    .mockImplementationOnce(() => new Promise((r) => (pending = r)))
    .mockResolvedValueOnce({
      ...data,
      config: { ...data.config, revision: 1, interval_secs: 10 },
    });
  const w = mount(NetworkProbesPanel, { props: { device, user } });
  await flushPromises();
  await w.findAll('input[type="number"]')[0].setValue(10);
  await vi.advanceTimersByTimeAsync(5000);
  await w.find("form").trigger("submit");
  await flushPromises();
  pending(data);
  await flushPromises();
  expect(
    (w.findAll('input[type="number"]')[0].element as HTMLInputElement).value,
  ).toBe("10");
  expect(request).toHaveBeenCalledTimes(3);
  w.unmount();
  vi.useRealTimers();
});
