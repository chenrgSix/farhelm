import { afterEach, expect, it, vi } from "vitest";
import { flushPromises, mount } from "@vue/test-utils";
import AgentTerminalPrivilege from "../src/components/AgentTerminalPrivilege.vue";
import { api } from "../src/api/client";
const initial = {
  revision: 0,
  enabled: false,
  desired_enabled: null,
  online: true,
  supported: true,
  blocked: false,
  status: "applied",
  reason: null,
};
afterEach(() => {
  vi.restoreAllMocks();
  vi.useRealTimers();
});
it("shows pending separately from actual state and polls until the Agent confirms", async () => {
  vi.useFakeTimers();
  const request = vi
    .spyOn(api, "request")
    .mockResolvedValueOnce(initial)
    .mockResolvedValueOnce({
      ...initial,
      revision: 1,
      desired_enabled: true,
      status: "pending",
    })
    .mockResolvedValue({
      ...initial,
      revision: 1,
      desired_enabled: true,
      enabled: true,
    });
  const wrapper = mount(AgentTerminalPrivilege, { props: { deviceId: "one" } });
  await flushPromises();
  await wrapper.get('input[type="checkbox"]').setValue(true);
  await wrapper
    .findAll("button")
    .find((b) => b.text() === "保存提权设置")!
    .trigger("click");
  await flushPromises();
  expect(request).toHaveBeenCalledWith("/devices/one/terminal-privilege", {
    method: "PUT",
    body: { v: 1, revision: 0, enabled: true },
  });
  expect(wrapper.text()).toContain("Agent 实际状态：未启用");
  expect(wrapper.text()).toContain("等待 Agent 确认");
  await vi.advanceTimersByTimeAsync(1500);
  await flushPromises();
  expect(wrapper.text()).toContain("Agent 实际状态：已启用");
  wrapper.unmount();
  const count = request.mock.calls.length;
  await vi.advanceTimersByTimeAsync(6000);
  expect(request.mock.calls).toHaveLength(count);
});
it.each([
  [{ supported: false, enabled: null }, "需升级 Agent 至 0.2.11"],
  [{ online: false }, "Agent 离线"],
  [{ blocked: true }, "NoNewPrivileges"],
])(
  "prevents misleading controls for unavailable Agents",
  async (change, message) => {
    vi.spyOn(api, "request").mockResolvedValue({ ...initial, ...change });
    const wrapper = mount(AgentTerminalPrivilege, {
      props: { deviceId: "one" },
    });
    await flushPromises();
    expect(wrapper.get("input").attributes("disabled")).toBeDefined();
    expect(wrapper.text()).toContain(message);
    wrapper.unmount();
  },
);
it("shows the actual state after an Agent rejects the requested change", async () => {
  vi.spyOn(api, "request").mockResolvedValue({
    ...initial,
    desired_enabled: true,
    status: "failed",
    reason: "PERSIST_FAILED",
  });
  const wrapper = mount(AgentTerminalPrivilege, { props: { deviceId: "one" } });
  await flushPromises();
  expect(wrapper.text()).toContain("Agent 保存失败");
  expect(wrapper.get<HTMLInputElement>("input").element.checked).toBe(false);
  wrapper.unmount();
});
