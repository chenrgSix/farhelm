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
  terminal_max_minutes: 60,
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
        terminal_max_minutes: 60,
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

it("saves a custom duration or unlimited and restores the persisted selection", async () => {
  const request = vi
    .spyOn(api, "request")
    .mockResolvedValueOnce(initial)
    .mockResolvedValueOnce({
      ...initial,
      terminal_max_minutes: 120,
      revision: 1,
    })
    .mockResolvedValueOnce({ ...initial, terminal_max_minutes: 0, revision: 2 })
    .mockResolvedValueOnce({
      ...initial,
      terminal_max_minutes: 0,
      revision: 2,
    });
  const wrapper = mount(Panel);
  await flushPromises();
  const duration = wrapper.get<HTMLInputElement>("#terminal-max-minutes");
  await duration.setValue(120);
  await wrapper.get("form").trigger("submit");
  await flushPromises();
  expect(request.mock.calls[1][1]?.body).toMatchObject({
    terminal_max_minutes: 120,
    revision: 0,
  });
  await wrapper.get('input[type="checkbox"]').setValue(true);
  expect(duration.element.disabled).toBe(true);
  await wrapper.get("form").trigger("submit");
  await flushPromises();
  expect(request.mock.calls[2][1]?.body).toMatchObject({
    terminal_max_minutes: 0,
    revision: 1,
  });
  await wrapper.get('button[type="button"]').trigger("click");
  await flushPromises();
  expect(
    wrapper.get<HTMLInputElement>('input[type="checkbox"]').element.checked,
  ).toBe(true);
  expect(duration.element.disabled).toBe(true);
  wrapper.unmount();
});
it("rejects invalid duration without saving, while retaining the last chosen number when toggling unlimited", async () => {
  const request = vi.spyOn(api, "request").mockResolvedValue(initial);
  const wrapper = mount(Panel);
  await flushPromises();
  const duration = wrapper.get<HTMLInputElement>("#terminal-max-minutes");
  for (const value of ["", "0", "-1", "1.5", "150119987580"]) {
    await duration.setValue(value);
    await wrapper.get("form").trigger("submit");
    expect(request).toHaveBeenCalledTimes(1);
    expect(wrapper.get('[role="alert"]').text()).toContain("正整数");
  }
  await duration.setValue(180);
  await wrapper.get('input[type="checkbox"]').setValue(true);
  await wrapper.get('input[type="checkbox"]').setValue(false);
  expect(duration.element.value).toBe("180");
  wrapper.unmount();
});
