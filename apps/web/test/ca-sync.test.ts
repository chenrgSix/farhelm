import { afterEach, expect, it, vi } from "vitest";
import { mount, flushPromises } from "@vue/test-utils";
import AgentCASyncPanel from "../src/components/AgentCASyncPanel.vue";
import { api } from "../src/api/client";
afterEach(() => {
  vi.restoreAllMocks();
  vi.useRealTimers();
});
const fingerprint = "AB:".repeat(31) + "AB";
const state = {
  revision: 4,
  fingerprint,
  all_ready: false,
  devices: [
    { device_id: "a", name: "ready-agent", status: "ready", online: false },
    { device_id: "b", name: "old-agent", status: "unsupported", online: true },
    { device_id: "c", name: "offline-agent", status: "pending", online: false },
    {
      device_id: "d",
      name: "broken-agent",
      status: "failed",
      online: true,
      reason: "CERTIFICATE_INVALID",
    },
  ],
};
it("shows readiness, legacy upgrade and offline queue, submits current revision and stops polling on unmount", async () => {
  vi.useFakeTimers();
  const request = vi.spyOn(api, "request").mockResolvedValue(state);
  const w = mount(AgentCASyncPanel, {
    props: { revision: 4, fingerprint, disabled: false },
  });
  await flushPromises();
  for (const label of [
    "1 / 4 台已就绪",
    "已保存并校验",
    "需先升级 Agent",
    "等待上线后补同步",
    "域名或 CA 指纹校验失败",
  ])
    expect(w.text()).toContain(label);
  await w.get("button").trigger("click");
  await flushPromises();
  expect(request).toHaveBeenLastCalledWith("/settings/certificate/agent-sync", {
    method: "POST",
    body: { v: 1, revision: 4 },
  });
  await vi.advanceTimersByTimeAsync(3000);
  expect(request).toHaveBeenCalledTimes(3);
  w.unmount();
  await vi.advanceTimersByTimeAsync(10000);
  expect(request).toHaveBeenCalledTimes(3);
});
it("does not sync unsaved settings or overwrite a newer revision with an old response", async () => {
  let resolveOld!: (s: unknown) => void;
  const request = vi
    .spyOn(api, "request")
    .mockImplementationOnce(
      () =>
        new Promise((r) => {
          resolveOld = r;
        }),
    )
    .mockResolvedValue({ ...state, revision: 5, devices: [], all_ready: true });
  const w = mount(AgentCASyncPanel, {
    props: { revision: 4, fingerprint, disabled: true },
  });
  expect(w.get("button").attributes("disabled")).toBeDefined();
  await w.get("button").trigger("click");
  expect(request).toHaveBeenCalledTimes(1);
  await w.setProps({ revision: 5 });
  await flushPromises();
  resolveOld(state);
  await flushPromises();
  expect(w.text()).toContain("所有已有 Agent 均已就绪");
  expect(w.text()).not.toContain("old-agent");
  w.unmount();
});
