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
  resolve({
    id: "install-id",
    command: "bash -c 'example-command'",
    expires_at: Date.now() + 60000,
  });
  await flushPromises();
  expect(wrapper.text()).toContain("设备已注册，等待 Agent 上线");
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
