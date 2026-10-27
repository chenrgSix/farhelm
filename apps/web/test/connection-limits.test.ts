import { afterEach, expect, it, vi } from "vitest";
import { flushPromises, mount } from "@vue/test-utils";
import Panel from "../src/components/ConnectionLimitsPanel.vue";
import { api, ApiError } from "../src/api/client";
const initial = {
  v: 1,
  revision: 0,
  per_user: 4,
  per_device: 4,
  terminal_total: 32,
  ssh_total: 64,
  ssh_per_ip: 16,
  updated_at: null,
};
afterEach(() => vi.restoreAllMocks());
it("saves Farhelm limits with revision and bounded inputs without sending network configuration", async () => {
  const request = vi
    .spyOn(api, "request")
    .mockResolvedValueOnce(initial)
    .mockResolvedValueOnce({ ...initial, per_device: 8, revision: 1 });
  const wrapper = mount(Panel);
  await flushPromises();
  expect(
    wrapper.get('input[aria-label="单用户并发连接上限"]').attributes("max"),
  ).toBe("128");
  await wrapper.get('input[aria-label="单设备终端默认上限"]').setValue(8);
  await wrapper.get("form").trigger("submit");
  await flushPromises();
  expect(request.mock.calls[1]).toEqual([
    "/settings/connections",
    {
      method: "PUT",
      body: {
        v: 1,
        revision: 0,
        per_user: 4,
        per_device: 8,
        terminal_total: 32,
        ssh_total: 64,
        ssh_per_ip: 16,
      },
    },
  ]);
  expect(wrapper.get('[role="status"]').text()).toContain("新连接立即生效");
  wrapper.unmount();
});
it("preserves a conflicting draft and prevents blind retries until current limits are reloaded", async () => {
  const request = vi
    .spyOn(api, "request")
    .mockResolvedValueOnce(initial)
    .mockRejectedValueOnce(new ApiError("SETTINGS_REVISION_CONFLICT", 409))
    .mockResolvedValueOnce({ ...initial, revision: 2, per_user: 10 });
  const wrapper = mount(Panel);
  await flushPromises();
  await wrapper.get('input[aria-label="单用户并发连接上限"]').setValue(8);
  await wrapper.get("form").trigger("submit");
  await flushPromises();
  expect(wrapper.get('[role="alert"]').text()).toContain("重新加载");
  await wrapper.get("form").trigger("submit");
  expect(request).toHaveBeenCalledTimes(2);
  await wrapper.get('button[type="button"]').trigger("click");
  await flushPromises();
  expect(
    wrapper.get<HTMLInputElement>('input[aria-label="单用户并发连接上限"]')
      .element.value,
  ).toBe("10");
  wrapper.unmount();
});
