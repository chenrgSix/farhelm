import { afterEach, expect, it, vi } from "vitest";
import { mount, flushPromises } from "@vue/test-utils";
import NetworkRoutePanel from "../src/components/NetworkRoutePanel.vue";
import NetworkSettingsPanel from "../src/components/NetworkSettingsPanel.vue";
import { api } from "../src/api/client";
import type {
  Device,
  DeviceNetworkRoute,
  PlatformNetworkResponse,
} from "../src/api/types";
const device: Device = {
  id: "device",
  name: "Linux",
  connection_kind: "agent",
  control_online: true,
  private_data_reachable: null,
  business_healthy: null,
  last_seen: null,
  revoked_at: null,
  agent_version: "0.2.5",
};
const state: DeviceNetworkRoute = {
  revision: 3,
  source: "platform",
  platform_revision: 2,
  address_revision: 1,
  addresses: { vpn_ip: "10.1.1.2", ssh_port: null },
  ssh_fallback: null,
  blocked_reason: null,
  policy: {
    mode: "vpn_preferred",
    agent: {
      vpn_url: "https://fleet.example.com",
      vpn_ip: "10.1.1.1",
      public_url: "https://fleet.example.com",
    },
    ssh: null,
  },
  agent_supported: true,
  agent_applied: true,
  ssh_active: false,
  ssh: null,
  agent: {
    channel: "public",
    endpoint: "https://fleet.example.com",
    reason: "VPN_UNREACHABLE",
    checked_at: 1,
    connected: true,
    easytier: { state: "unknown", latency_ms: null },
  },
};
const global: PlatformNetworkResponse = {
  revision: 2,
  updated_at: 1,
  settings: {
    enabled: true,
    mode: "vpn_preferred",
    agent: state.policy!.agent,
  },
  agent_enabled: true,
  platform_server_url: "https://fleet.example.com",
  legacy_devices: 0,
  suggested_agent: null,
  device_count: 3,
  pending_agents: 1,
};
afterEach(() => vi.restoreAllMocks());
it("device form saves only the machine IP, never the platform URL or mode", async () => {
  const request = vi
    .spyOn(api, "request")
    .mockResolvedValue(structuredClone(state));
  const w = mount(NetworkRoutePanel, { props: { device, admin: true } });
  await flushPromises();
  expect(w.find("select").exists()).toBe(false);
  expect(w.findAll('input[type="checkbox"]')).toHaveLength(0);
  expect(w.text()).not.toContain("平台内网 HTTPS 地址");
  await w.get('input[placeholder="10.144.144.2"]').setValue("10.1.1.9");
  await w.get("form").trigger("submit");
  await flushPromises();
  expect(request).toHaveBeenLastCalledWith("/devices/device/network-route", {
    method: "PUT",
    body: { v: 1, revision: 1, vpn_ip: "10.1.1.9", ssh_port: null },
  });
  w.unmount();
});
it("scoped readers have no editable fields or credentials requests", async () => {
  const request = vi
    .spyOn(api, "request")
    .mockResolvedValue(structuredClone(state));
  const w = mount(NetworkRoutePanel, { props: { device, admin: false } });
  await flushPromises();
  expect(w.find("form").exists()).toBe(false);
  expect(w.text()).toContain("仅管理员可修改");
  expect(request).toHaveBeenCalledTimes(1);
  w.unmount();
});
it("global private-only removes public fallback and saves once for all devices", async () => {
  const request = vi
    .spyOn(api, "request")
    .mockResolvedValue(structuredClone(global));
  const w = mount(NetworkSettingsPanel);
  await flushPromises();
  expect(w.text()).toContain("覆盖 3 台设备");
  await w.get("select").setValue("private_only");
  await w.get("form").trigger("submit");
  await flushPromises();
  expect(request).toHaveBeenLastCalledWith("/settings/network", {
    method: "PUT",
    body: {
      v: 1,
      revision: 2,
      settings: {
        enabled: true,
        mode: "private_only",
        agent: { ...global.settings.agent, public_url: null },
      },
    },
  });
  w.unmount();
});
it("SSH-only platform settings require no HTTPS fields or Agent URL", async () => {
  const request = vi.spyOn(api, "request").mockResolvedValue({
    ...global,
    agent_enabled: false,
    settings: { ...global.settings, agent: null },
  });
  const w = mount(NetworkSettingsPanel);
  await flushPromises();
  expect(w.text()).toContain("无需填写 Agent 平台地址");
  expect(
    w.find('input[placeholder="https://farhelm.example.com"]').exists(),
  ).toBe(false);
  await w.get("form").trigger("submit");
  await flushPromises();
  expect(request).toHaveBeenLastCalledWith(
    "/settings/network",
    expect.objectContaining({
      body: expect.objectContaining({
        settings: { enabled: true, mode: "vpn_preferred", agent: null },
      }),
    }),
  );
  w.unmount();
});
it("unsupported Agent and legacy settings remain visible without pretending P2P", async () => {
  vi.spyOn(api, "request").mockResolvedValue({
    ...state,
    source: "legacy",
    agent: null,
    agent_applied: false,
    agent_supported: false,
  });
  const w = mount(NetworkRoutePanel, { props: { device, admin: true } });
  await flushPromises();
  expect(w.text()).toContain("Agent 不支持网络策略");
  expect(w.text()).toContain("旧配置暂时保留");
  expect(w.text()).not.toContain("P2P 直连");
  await w
    .findAll("button")
    .find((b) => b.text() === "前往平台网络设置")!
    .trigger("click");
  expect(w.emitted("settings")).toHaveLength(1);
  w.unmount();
});
it("device address conflicts never overwrite platform settings", async () => {
  const request = vi
    .spyOn(api, "request")
    .mockResolvedValueOnce(structuredClone(state))
    .mockRejectedValueOnce(Error("NETWORK_ROUTE_CHANGED_RELOAD"));
  const w = mount(NetworkRoutePanel, { props: { device, admin: true } });
  await flushPromises();
  await w.get("form").trigger("submit");
  await flushPromises();
  expect(w.get('[role="alert"]').text()).toContain("地址已被其他管理员修改");
  expect(request).toHaveBeenCalledTimes(2);
  w.unmount();
});
