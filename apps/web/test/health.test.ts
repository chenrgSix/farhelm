import { afterEach, describe, expect, it, vi } from "vitest";
import { flushPromises, mount } from "@vue/test-utils";
import { webcrypto } from "node:crypto";
import HealthChecksPanel from "../src/components/HealthChecksPanel.vue";
import { api } from "../src/api/client";
import type { Device, HealthResponse, User } from "../src/api/types";
const device: Device = {
  id: "device",
  name: "Test Linux",
  control_online: true,
  business_healthy: null,
  private_data_reachable: null,
  last_seen: null,
  revoked_at: null,
  agent_version: "test",
};
const user: User = {
  id: "admin",
  username: "admin",
  role: "admin",
  device_scope: "*",
};
const response: HealthResponse = {
  v: 1,
  revision: 0,
  supported: true,
  device_online: true,
  checks: [],
};
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});
describe("health check configuration", () => {
  it("saves UI fields and keeps unsaved changes out of manual probing", async () => {
    vi.stubGlobal("crypto", webcrypto);
    const request = vi.spyOn(api, "request").mockResolvedValue(response);
    const wrapper = mount(HealthChecksPanel, { props: { device, user } });
    await flushPromises();
    expect(wrapper.text()).toContain("尚未配置健康检查");
    await wrapper
      .findAll("button")
      .find((b) => b.text() === "添加检查")!
      .trigger("click");
    await wrapper
      .find('input[type="url"]')
      .setValue("http://127.0.0.1:8080/healthz");
    expect(
      wrapper
        .findAll("button")
        .find((b) => b.text() === "立即探测")!
        .attributes("disabled"),
    ).toBeDefined();
    request.mockImplementation(async (_path, options) => {
      const body = options?.body as any;
      return {
        ...response,
        revision: 1,
        checks: body.checks.map((c: any) => ({
          ...c,
          result: {
            status: "unknown",
            reason: "AWAITING_RESULT",
            last_checked_at: null,
            duration_ms: null,
            consecutive_failures: 0,
          },
        })),
      };
    });
    await wrapper.find("form").trigger("submit");
    await flushPromises();
    expect(request).toHaveBeenLastCalledWith("/devices/device/health-checks", {
      method: "PUT",
      body: {
        v: 1,
        revision: 0,
        checks: [
          expect.objectContaining({
            probe: {
              kind: "http",
              url: "http://127.0.0.1:8080/healthz",
              expected_status: 200,
              body_contains: "",
            },
          }),
        ],
      },
    });
    expect(wrapper.text()).toContain("配置已保存");
    expect(wrapper.emitted("changed")).toHaveLength(1);
    wrapper.unmount();
  });
  it("read-only roles see results without config or execution actions", async () => {
    vi.spyOn(api, "request").mockResolvedValue(response);
    const wrapper = mount(HealthChecksPanel, {
      props: { device, user: { ...user, role: "auditor" } },
    });
    await flushPromises();
    expect(wrapper.text()).toContain("当前账号仅可查看");
    expect(wrapper.text()).not.toContain("添加检查");
    expect(wrapper.text()).not.toContain("立即探测");
    expect(wrapper.text()).not.toContain("保存配置");
    wrapper.unmount();
  });
});
