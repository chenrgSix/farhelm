import { afterEach, expect, it, vi } from "vitest";
import { flushPromises, mount } from "@vue/test-utils";
import SshConnectionPanel from "../src/components/SshConnectionPanel.vue";
import { api } from "../src/api/client";
import type { Device, User } from "../src/api/types";
const device: Device = {
  id: "device",
  name: "Linux",
  control_online: true,
  business_healthy: null,
  private_data_reachable: null,
  last_seen: null,
  revoked_at: null,
  agent_version: null,
};
const user: User = {
  id: "user",
  username: "o'brien",
  role: "ops",
  device_scope: ["device"],
};
afterEach(() => vi.restoreAllMocks());
it("shows the advertised endpoint, escaped username, exact fingerprint and copies the reviewed command", async () => {
  vi.spyOn(api, "request").mockResolvedValue({
    enabled: true,
    host: "fleet.example.com",
    port: 2222,
    fingerprint: "SHA256:example",
  });
  const writeText = vi.fn().mockResolvedValue(undefined);
  Object.defineProperty(navigator, "clipboard", {
    value: { writeText },
    configurable: true,
  });
  const w = mount(SshConnectionPanel, { props: { device, user } });
  await flushPromises();
  const command = w.get("pre").text();
  expect(command).toBe(
    "ssh -tt -p 2222 -l 'o'\\''brien:device' -- 'fleet.example.com'",
  );
  expect(w.text()).toContain("SHA256:example");
  await w
    .findAll("button")
    .find((b) => b.text() === "复制连接命令")!
    .trigger("click");
  await flushPromises();
  expect(writeText).toHaveBeenCalledWith(command);
  expect(w.text()).toContain("已复制");
  w.unmount();
});
it("does not offer a connection command when the gateway is disabled", async () => {
  vi.spyOn(api, "request").mockResolvedValue({
    enabled: false,
    host: null,
    port: null,
    fingerprint: null,
  });
  const w = mount(SshConnectionPanel, { props: { device, user } });
  await flushPromises();
  expect(w.text()).toContain("SSH 入口尚未启用");
  expect(w.find("pre").exists()).toBe(false);
  w.unmount();
});
