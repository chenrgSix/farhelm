import { afterEach, expect, it, vi } from "vitest";
import { mount, flushPromises } from "@vue/test-utils";
import AgentInstallPanel from "../src/components/AgentInstallPanel.vue";
import { api } from "../src/api/client";
afterEach(() => {
  vi.restoreAllMocks();
  vi.useRealTimers();
});
const options = {
  server_url: "https://fleet.example.com",
  architectures: ["aarch64", "x86_64"],
};
it("generates once on explicit form submit, copies the command and reports real online status", async () => {
  vi.useFakeTimers();
  let resolve!: (value: any) => void;
  const request = vi
    .spyOn(api, "request")
    .mockResolvedValueOnce(options)
    .mockImplementationOnce(
      () =>
        new Promise((r) => {
          resolve = r;
        }),
    )
    .mockResolvedValueOnce({ status: "registered" })
    .mockResolvedValueOnce({ status: "online" });
  const writeText = vi.fn().mockResolvedValue(undefined);
  Object.defineProperty(navigator, "clipboard", {
    configurable: true,
    value: { writeText },
  });
  const wrapper = mount(AgentInstallPanel);
  await flushPromises();
  expect(wrapper.get('[role="dialog"]').text()).toContain(
    "添加设备 · Agent 接入",
  );
  expect(request).toHaveBeenCalledTimes(1);
  expect(wrapper.get<HTMLInputElement>("input[readonly]").element.value).toBe(
    options.server_url,
  );
  expect(wrapper.text()).toContain("平台服务端地址");
  await wrapper.get("input").setValue("new-linux");
  await wrapper.get("form").trigger("submit");
  await wrapper.get("form").trigger("submit");
  expect(request).toHaveBeenCalledTimes(2);
  expect(request.mock.calls[1][1]?.body).toMatchObject({
    name: "new-linux",
    run_user: "farhelm",
    start_mode: "auto",
    allow_sudo: false,
  });
  expect(request.mock.calls[1][1]?.body).not.toHaveProperty("server_url");
  resolve({
    id: "install-id",
    command: "bash -c 'example-command'",
    expires_at: Date.now() + 60000,
    server_url: "https://updated.example.com",
  });
  await flushPromises();
  expect(wrapper.text()).toContain("设备已注册，等待 Agent 上线");
  expect(wrapper.text()).toContain("https://updated.example.com");
  expect(wrapper.text()).not.toContain(options.server_url);
  await wrapper
    .findAll("button")
    .find((b) => b.text() === "复制安装命令")!
    .trigger("click");
  expect(writeText).toHaveBeenCalledWith("bash -c 'example-command'");
  await vi.advanceTimersByTimeAsync(2000);
  expect(wrapper.emitted("added")).toHaveLength(1);
  expect(wrapper.text()).toContain("设备已注册并在线");
  wrapper.unmount();
  await vi.advanceTimersByTimeAsync(10000);
  expect(request).toHaveBeenCalledTimes(4);
});
it("blocks generation until the platform has configured its server address", async () => {
  const request = vi
    .spyOn(api, "request")
    .mockResolvedValue({ ...options, server_url: "" });
  const wrapper = mount(AgentInstallPanel);
  await flushPromises();
  await wrapper.get("input").setValue("new-linux");
  await wrapper.get("form").trigger("submit");
  expect(request).toHaveBeenCalledTimes(1);
  expect(wrapper.text()).toContain("平台尚未配置服务端地址");
  expect(
    wrapper.get("button.button.primary").attributes("disabled"),
  ).toBeDefined();
  wrapper.unmount();
});
it("does not enable generation when packages are unavailable or continue polling after close", async () => {
  const request = vi
    .spyOn(api, "request")
    .mockResolvedValue({ ...options, architectures: [] });
  const wrapper = mount(AgentInstallPanel);
  await flushPromises();
  await wrapper.get("form").trigger("submit");
  expect(request).toHaveBeenCalledTimes(1);
  expect(wrapper.text()).toContain("平台尚未准备 Agent 安装包");
  wrapper.unmount();
});
it("binds installation to an existing SSH device and reports promotion only after Agent is online", async () => {
  vi.useFakeTimers();
  const request = vi
    .spyOn(api, "request")
    .mockResolvedValueOnce(options)
    .mockResolvedValueOnce({
      id: "bound-install",
      command: "bound-command",
      expires_at: Date.now() + 60000,
      server_url: options.server_url,
    })
    .mockResolvedValueOnce({ status: "registered" })
    .mockResolvedValueOnce({ status: "online" });
  const wrapper = mount(AgentInstallPanel, {
    props: { device: { id: "existing-ssh", name: "Production" } },
  });
  await flushPromises();
  expect(wrapper.text()).toContain("安装 Agent · Production");
  expect(wrapper.get<HTMLInputElement>("input").element.value).toBe(
    "Production",
  );
  expect(wrapper.get("input").attributes("readonly")).toBeDefined();
  await wrapper.get("form").trigger("submit");
  await flushPromises();
  expect(request.mock.calls[1][1]?.body).toMatchObject({
    device_id: "existing-ssh",
  });
  expect(request.mock.calls[1][1]?.body).not.toHaveProperty("name");
  expect(wrapper.text()).toContain("原 SSH 仍可使用");
  expect(wrapper.emitted("added")).toBeUndefined();
  await vi.advanceTimersByTimeAsync(2000);
  expect(wrapper.text()).toContain("原 SSH 已保留为备用");
  expect(wrapper.emitted("added")).toHaveLength(1);
  wrapper.unmount();
});
it("explains recovery for an already registered Agent without issuing a duplicate command", async () => {
  const request = vi
    .spyOn(api, "request")
    .mockResolvedValueOnce(options)
    .mockRejectedValueOnce(new Error("AGENT_ALREADY_REGISTERED"));
  const wrapper = mount(AgentInstallPanel, {
    props: { device: { id: "existing", name: "Server" } },
  });
  await flushPromises();
  await wrapper.get("form").trigger("submit");
  await flushPromises();
  expect(wrapper.get('[role="alert"]').text()).toContain(
    "无需重复安装；原 SSH 仍可使用",
  );
  expect(wrapper.find("textarea").exists()).toBe(false);
  expect(request).toHaveBeenCalledTimes(2);
  wrapper.unmount();
});
