import { afterEach, expect, it, vi } from "vitest";
import { mount, flushPromises } from "@vue/test-utils";
import SystemSettingsPanel from "../src/components/SystemSettingsPanel.vue";
import { api, ApiError } from "../src/api/client";
afterEach(() => vi.restoreAllMocks());
const initial = {
  v: 1,
  revision: 0,
  platform_server_url: "https://initial.example.com",
  updated_at: null,
};
it("loads and explicitly saves a platform address once, then displays the persisted result", async () => {
  let resolve!: (value: unknown) => void;
  const request = vi
    .spyOn(api, "request")
    .mockResolvedValueOnce(initial)
    .mockImplementationOnce(
      () =>
        new Promise((r) => {
          resolve = r;
        }),
    );
  const wrapper = mount(SystemSettingsPanel, {
    global: { stubs: { AgentAddressSyncPanel: true } },
  });
  await flushPromises();
  expect(wrapper.get<HTMLInputElement>("input").element.value).toBe(
    initial.platform_server_url,
  );
  expect(request).toHaveBeenCalledTimes(1);
  await wrapper.get("input").setValue("https://NEW.example.com/");
  await wrapper.get("form").trigger("submit");
  await wrapper.get("form").trigger("submit");
  expect(request).toHaveBeenCalledTimes(2);
  expect(request.mock.calls[1]).toEqual([
    "/settings",
    {
      method: "PUT",
      body: {
        v: 1,
        revision: 0,
        platform_server_url: "https://NEW.example.com/",
      },
    },
  ]);
  resolve({
    ...initial,
    revision: 1,
    platform_server_url: "https://new.example.com",
    updated_at: 1700000000000,
  });
  await flushPromises();
  expect(wrapper.get<HTMLInputElement>("input").element.value).toBe(
    "https://new.example.com",
  );
  expect(wrapper.get('[role="status"]').text()).toContain("已保存");
  expect(wrapper.emitted("saved")).toHaveLength(1);
  expect(
    wrapper.get('button[type="submit"]').attributes("disabled"),
  ).toBeDefined();
  wrapper.unmount();
});
it("preserves a conflicting draft and requires reloading the current revision before saving again", async () => {
  const request = vi
    .spyOn(api, "request")
    .mockResolvedValueOnce(initial)
    .mockRejectedValueOnce(new ApiError("SETTINGS_REVISION_CONFLICT", 409))
    .mockResolvedValueOnce({
      ...initial,
      revision: 2,
      platform_server_url: "https://other.example.com",
    })
    .mockResolvedValueOnce({
      ...initial,
      revision: 3,
      platform_server_url: "https://draft.example.com",
    });
  const wrapper = mount(SystemSettingsPanel, {
    global: { stubs: { AgentAddressSyncPanel: true } },
  });
  await flushPromises();
  await wrapper.get("input").setValue("https://draft.example.com");
  await wrapper.get("form").trigger("submit");
  await flushPromises();
  expect(wrapper.get('[role="alert"]').text()).toContain("其他管理员");
  expect(wrapper.get<HTMLInputElement>("input").element.value).toBe(
    "https://draft.example.com",
  );
  await wrapper.get("form").trigger("submit");
  expect(request).toHaveBeenCalledTimes(2);
  await wrapper.get('button[type="button"]').trigger("click");
  await flushPromises();
  expect(wrapper.get<HTMLInputElement>("input").element.value).toBe(
    "https://other.example.com",
  );
  await wrapper.get("input").setValue("https://draft.example.com");
  await wrapper.get("form").trigger("submit");
  await flushPromises();
  expect(request.mock.calls[3][1]?.body).toMatchObject({ revision: 2 });
  expect(wrapper.emitted("saved")).toHaveLength(1);
  wrapper.unmount();
});
it("blocks blind retries when the save response is lost", async () => {
  const request = vi
    .spyOn(api, "request")
    .mockResolvedValueOnce(initial)
    .mockRejectedValueOnce(new ApiError("network lost", 0));
  const wrapper = mount(SystemSettingsPanel, {
    global: { stubs: { AgentAddressSyncPanel: true } },
  });
  await flushPromises();
  await wrapper.get("form").trigger("submit");
  await flushPromises();
  expect(wrapper.get('[role="alert"]').text()).toContain("保存结果尚未确认");
  await wrapper.get("form").trigger("submit");
  expect(request).toHaveBeenCalledTimes(2);
  wrapper.unmount();
});
