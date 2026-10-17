import { afterEach, expect, it, vi } from "vitest";
import { mount, flushPromises, type VueWrapper } from "@vue/test-utils";
import DeploymentPanel from "../src/components/DeploymentPanel.vue";
import { api } from "../src/api/client";
const runtime = {
  device_access: "ssh-only",
  web_enabled: true,
  web_protocol: "http",
} as const;
const base = {
  v: 1,
  revision: 7,
  settings: runtime,
  state: "idle",
  entry_url: null,
  rollback_url: null,
  confirm_by: null,
  last_error: null,
  active_terminals: 0,
  https_ready: true,
  recovery_command: "node apps/server/dist/enable-web.js --data-dir '/data'",
};
let wrapper: VueWrapper;
afterEach(() => {
  wrapper?.unmount();
  vi.restoreAllMocks();
  vi.useRealTimers();
});
async function setup(state = base) {
  vi.useFakeTimers();
  const request = vi.spyOn(api, "request").mockResolvedValue(state);
  wrapper = mount(DeploymentPanel, { props: { runtime } });
  await flushPromises();
  return request;
}
it("shows independent settings and requires explicit acknowledgement before disabling web", async () => {
  const request = await setup();
  await wrapper.get('[aria-label="网页管理"]').setValue("false");
  expect(
    wrapper.get('button[type="submit"]').attributes("disabled"),
  ).toBeDefined();
  await wrapper.get('input[type="checkbox"]').setValue(true);
  request.mockResolvedValueOnce({
    ...base,
    state: "applying",
    settings: { ...runtime, web_enabled: false },
  });
  await wrapper.get("form").trigger("submit");
  await flushPromises();
  expect(request).toHaveBeenLastCalledWith("/settings/deployment", {
    method: "PUT",
    body: {
      v: 1,
      revision: 7,
      settings: { ...runtime, web_enabled: false },
      entry_origin: window.location.origin,
      confirm_web_disable: true,
    },
  });
  expect(wrapper.text()).toContain("重新开启网页请在平台服务器执行");
  expect(wrapper.get("code").text()).toContain("enable-web.js");
});
it("requires an Agent certificate independently of the web protocol", async () => {
  await setup({ ...base, https_ready: false });
  await wrapper.get('[aria-label="设备接入方式"]').setValue("agent-ssh");
  expect(wrapper.text()).toContain("没有可用的 HTTPS 证书");
  expect(
    wrapper.get('button[type="submit"]').attributes("disabled"),
  ).toBeDefined();
  await wrapper.get('[aria-label="网页协议"]').setValue("https");
  expect(wrapper.text()).toContain("没有可用的 HTTPS 证书");
  expect(
    wrapper.get('button[type="submit"]').attributes("disabled"),
  ).toBeDefined();
});
it("does not interrupt active terminals and refreshes the preflight count", async () => {
  const request = await setup({ ...base, active_terminals: 1 });
  await wrapper.get('[aria-label="网页协议"]').setValue("https");
  expect(
    wrapper.get('button[type="submit"]').attributes("disabled"),
  ).toBeDefined();
  request.mockResolvedValueOnce(base);
  await wrapper
    .findAll("button")
    .find((b) => b.text() === "刷新运行设置")!
    .trigger("click");
  await flushPromises();
  await wrapper.get('[aria-label="网页协议"]').setValue("https");
  expect(
    wrapper.get('button[type="submit"]').attributes("disabled"),
  ).toBeUndefined();
});
it("shows the new entry and confirms the exact pending revision", async () => {
  const request = await setup();
  await wrapper.get('[aria-label="网页协议"]').setValue("https");
  request.mockResolvedValueOnce({
    ...base,
    revision: 8,
    settings: { ...runtime, web_protocol: "https" },
    entry_url: "https://fleet.test:8080",
    state: "applying",
  });
  await wrapper.get("form").trigger("submit");
  await flushPromises();
  expect(wrapper.get("a").attributes("href")).toBe("https://fleet.test:8080");
  request.mockResolvedValueOnce({
    ...base,
    revision: 8,
    settings: { ...runtime, web_protocol: "https" },
    state: "awaiting_confirmation",
    confirm_by: Date.now() + 120000,
  });
  await vi.advanceTimersByTimeAsync(1000);
  await flushPromises();
  request.mockResolvedValueOnce({
    ...base,
    revision: 8,
    settings: { ...runtime, web_protocol: "https" },
  });
  await wrapper
    .findAll("button")
    .find((b) => b.text().includes("确认保留此配置"))!
    .trigger("click");
  await flushPromises();
  expect(request).toHaveBeenLastCalledWith("/settings/deployment/confirm", {
    method: "POST",
    body: { v: 1, revision: 8 },
  });
  expect(wrapper.text()).toContain("配置已生效并保存");
});
it("keeps edits after a conflict and shows rollback after a failed trial", async () => {
  const request = await setup();
  await wrapper.get('[aria-label="网页协议"]').setValue("https");
  request.mockRejectedValueOnce(Error("配置已修改，请刷新"));
  await wrapper.get("form").trigger("submit");
  await flushPromises();
  expect(wrapper.get('[role="alert"]').text()).toContain("请刷新");
  expect(
    (wrapper.get('[aria-label="网页协议"]').element as HTMLSelectElement).value,
  ).toBe("https");
  request.mockResolvedValueOnce({
    ...base,
    revision: 9,
    state: "rolled_back",
    last_error: "CONFIRMATION_TIMEOUT",
  });
  await wrapper
    .findAll("button")
    .find((b) => b.text() === "刷新运行设置")!
    .trigger("click");
  await flushPromises();
  expect(wrapper.text()).toContain("已恢复原设置");
  expect(
    (wrapper.get('[aria-label="网页协议"]').element as HTMLSelectElement).value,
  ).toBe("http");
});

it("allows HTTP web with Agent HTTPS and active sessions when only the web listener changes", async () => {
  const request = await setup({
    ...base,
    active_terminals: 2,
    web_reload_supported: true,
    agent_https_port: 8444,
    settings: {
      device_access: "agent-ssh",
      web_enabled: true,
      web_protocol: "https",
    },
  } as any);
  await wrapper.get('[aria-label="网页协议"]').setValue("http");
  expect(wrapper.text()).toContain("Agent 使用独立 HTTPS 入口");
  expect(
    wrapper.get('button[type="submit"]').attributes("disabled"),
  ).toBeUndefined();
  await wrapper.get("form").trigger("submit");
  await flushPromises();
  expect(request.mock.calls.at(-1)?.[1]?.body).toMatchObject({
    settings: { device_access: "agent-ssh", web_protocol: "http" },
  });
});
it("requires legacy Agent address migration before removing its HTTPS web entry", async () => {
  await setup({
    ...base,
    web_reload_supported: true,
    agents_on_web: 1,
    settings: {
      device_access: "agent-ssh",
      web_enabled: true,
      web_protocol: "https",
    },
  } as any);
  await wrapper.get('[aria-label="网页协议"]').setValue("http");
  expect(wrapper.text()).toContain("先在下方 Agent 接入设置");
  expect(
    wrapper.get('button[type="submit"]').attributes("disabled"),
  ).toBeDefined();
});
