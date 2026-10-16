import { afterEach, expect, it, vi } from "vitest";
import { mount, flushPromises } from "@vue/test-utils";
import NetworkRoutePanel from "../src/components/NetworkRoutePanel.vue";
import { api } from "../src/api/client";
import type { Device, DeviceNetworkRoute } from "../src/api/types";
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
  revision: 1,
  policy: {
    mode: "vpn_preferred",
    agent: { vpn_url: "https://10.1.1.1", public_url: "https://example.com" },
    ssh: null,
  },
  agent_supported: true,
  agent_applied: true,
  ssh_active: false,
  ssh: null,
  agent: {
    channel: "public",
    endpoint: "https://example.com",
    reason: "VPN_UNREACHABLE",
    checked_at: 1,
    connected: true,
    easytier: { state: "unknown", latency_ms: null },
  },
};
afterEach(() => vi.restoreAllMocks());
it("private-only clears public fallback from submitted Agent policy", async () => {
  const request = vi
    .spyOn(api, "request")
    .mockResolvedValue(structuredClone(state));
  const w = mount(NetworkRoutePanel, { props: { device, admin: true } });
  await flushPromises();
  expect(w.text()).toContain("内网连接失败，使用公网备用");
  await w.get("select").setValue("private_only");
  await w.get("form").trigger("submit");
  await flushPromises();
  expect(request).toHaveBeenLastCalledWith("/devices/device/network-route", {
    method: "PUT",
    body: {
      v: 1,
      revision: 1,
      policy: {
        mode: "private_only",
        agent: { vpn_url: "https://10.1.1.1", public_url: null },
        ssh: null,
      },
    },
  });
  w.unmount();
});
it("scoped readers see observations without editable policy or SSH credentials requests", async () => {
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
it("unknown or unsupported Agent is not presented as VPN connected", async () => {
  vi.spyOn(api, "request").mockResolvedValue({
    ...state,
    agent: null,
    agent_applied: false,
    agent_supported: false,
  });
  const w = mount(NetworkRoutePanel, { props: { device, admin: true } });
  await flushPromises();
  expect(w.text()).toContain("Agent 不支持网络策略");
  expect(w.text()).toContain("尚未检测");
  expect(w.text()).not.toContain("P2P 直连");
  w.unmount();
});
it("changing SSH mode retains shared identity while sending only route endpoints", async () => {
  const sshDevice = { ...device, connection_kind: "ssh" as const };
  const policy = {
    mode: "vpn_preferred",
    agent: null,
    ssh: {
      vpn_host: "10.1.1.2",
      vpn_port: 22,
      public_host: "example.com",
      public_port: 2222,
    },
  };
  const request = vi
    .spyOn(api, "request")
    .mockResolvedValue({ ...state, policy });
  const w = mount(NetworkRoutePanel, {
    props: { device: sshDevice, admin: true },
  });
  await flushPromises();
  await w.get("select").setValue("private_only");
  await w.get("form").trigger("submit");
  await flushPromises();
  expect(request).toHaveBeenLastCalledWith("/devices/device/network-route", {
    method: "PUT",
    body: {
      v: 1,
      revision: 1,
      policy: {
        mode: "private_only",
        agent: null,
        ssh: {
          vpn_host: "10.1.1.2",
          vpn_port: 22,
          public_host: null,
          public_port: null,
        },
      },
    },
  });
  w.unmount();
});

it("keeps TLS hostname and sends a private connection IP independently", async () => {
  const request = vi
    .spyOn(api, "request")
    .mockResolvedValue(structuredClone(state));
  const w = mount(NetworkRoutePanel, { props: { device, admin: true } });
  await flushPromises();
  await w
    .get('input[placeholder="https://10.144.144.1:8443"]')
    .setValue("https://fleet.example.com");
  await w.get('input[placeholder="10.144.144.1"]').setValue("10.144.144.1");
  await w.get("form").trigger("submit");
  await flushPromises();
  expect(request).toHaveBeenLastCalledWith(
    "/devices/device/network-route",
    expect.objectContaining({
      body: expect.objectContaining({
        policy: expect.objectContaining({
          agent: {
            vpn_url: "https://fleet.example.com",
            vpn_ip: "10.144.144.1",
            public_url: "https://example.com",
          },
        }),
      }),
    }),
  );
  w.unmount();
});
