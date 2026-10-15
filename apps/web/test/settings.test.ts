import { afterEach, expect, it, vi } from "vitest";
import { mount, flushPromises } from "@vue/test-utils";
import SystemSettingsPanel from "../src/components/SystemSettingsPanel.vue";
import { api, ApiError } from "../src/api/client";
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});
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
        platform_server_url: "https://new.example.com",
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
  await wrapper
    .findAll("button")
    .find((b) => b.text() === "重新加载配置")!
    .trigger("click");
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
it("uses the HTTPS page origin without saving until the administrator submits", async () => {
  vi.stubGlobal(
    "location",
    new URL("https://front.example.com:9443/devices?tab=online#details"),
  );
  const request = vi
    .spyOn(api, "request")
    .mockResolvedValueOnce(initial)
    .mockResolvedValueOnce({
      ...initial,
      revision: 1,
      platform_server_url: "https://front.example.com:9443",
    });
  const wrapper = mount(SystemSettingsPanel, {
    global: { stubs: { AgentAddressSyncPanel: true } },
  });
  await flushPromises();
  await wrapper
    .findAll("button")
    .find((b) => b.text() === "使用当前网页地址")!
    .trigger("click");
  expect(wrapper.get<HTMLInputElement>("input").element.value).toBe(
    "https://front.example.com:9443",
  );
  expect(request).toHaveBeenCalledTimes(1);
  await wrapper.get("form").trigger("submit");
  await flushPromises();
  expect(request.mock.calls[1][1]?.body).toMatchObject({
    platform_server_url: "https://front.example.com:9443",
  });
  wrapper.unmount();
});
it("extracts the HTTPS origin from pasted page links and rejects HTTP and embedded credentials", async () => {
  const request = vi
    .spyOn(api, "request")
    .mockResolvedValueOnce(initial)
    .mockResolvedValueOnce({
      ...initial,
      revision: 1,
      platform_server_url: "https://front.example.com",
    });
  const wrapper = mount(SystemSettingsPanel, {
    global: { stubs: { AgentAddressSyncPanel: true } },
  });
  await flushPromises();
  expect(
    wrapper
      .findAll("button")
      .find((b) => b.text() === "使用当前网页地址")!
      .attributes("disabled"),
  ).toBeDefined();
  for (const value of [
    "http://front.example.com",
    "https://user:password@front.example.com",
    "https://exa mple.com",
  ]) {
    await wrapper.get("input").setValue(value);
    await wrapper.get("form").trigger("submit");
    await flushPromises();
    expect(request).toHaveBeenCalledTimes(1);
    expect(wrapper.get('[role="alert"]').text()).toMatch(/HTTPS|账号或密码/);
  }
  await wrapper
    .get("input")
    .setValue("https://FRONT.example.com:443/devices?tab=online#row");
  expect(wrapper.text()).toContain("将使用：https://front.example.com");
  await wrapper.get("form").trigger("submit");
  await flushPromises();
  expect(request.mock.calls[1][1]?.body).toMatchObject({
    platform_server_url: "https://front.example.com",
  });
  wrapper.unmount();
});
