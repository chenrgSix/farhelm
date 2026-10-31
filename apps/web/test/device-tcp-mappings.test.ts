import { afterEach, expect, it, vi } from "vitest";
import { mount, flushPromises } from "@vue/test-utils";
import Panel from "../src/components/DeviceTcpMappings.vue";
import Connection from "../src/components/DeviceConnectionPanel.vue";
import { api, ApiError } from "../src/api/client";
const mapping = {
  id: "map-1",
  revision: 1,
  name: "数据库",
  enabled: false,
  listen_host: "127.0.0.1",
  listen_port: 11433,
  target_host: "192.168.0.4",
  target_port: 1433,
  source_cidrs: ["192.168.1.20"],
  status: "disabled",
  error: null,
  connections: 0,
};
afterEach(() => vi.restoreAllMocks());
async function fill(wrapper: ReturnType<typeof mount>) {
  await wrapper
    .findAll("button")
    .find((b) => b.text() === "新增映射")!
    .trigger("click");
  await wrapper.get('[aria-label="映射名称"]').setValue("数据库");
  await wrapper.get('[aria-label="平台监听 IP"]').setValue("192.168.1.5");
  await wrapper.get('[aria-label="目标 IP 或域名"]').setValue("192.168.0.4");
}
it("requires sources, defaults off, creates only through the web API and refreshes runtime status", async () => {
  const request = vi
    .spyOn(api, "request")
    .mockResolvedValueOnce({ v: 1, mappings: [] })
    .mockResolvedValueOnce({ v: 1, mapping })
    .mockResolvedValueOnce({ v: 1, mappings: [mapping] });
  const wrapper = mount(Panel, { props: { deviceId: "one" } });
  await flushPromises();
  await fill(wrapper);
  expect(
    wrapper.get<HTMLInputElement>('[aria-label="启用映射"]').element.checked,
  ).toBe(false);
  await wrapper.get("form").trigger("submit");
  expect(request).toHaveBeenCalledTimes(1);
  await wrapper
    .get('[aria-label="允许的来源 IP / CIDR"]')
    .setValue("192.168.1.20\n2001:db8::/64");
  await wrapper.get("form").trigger("submit");
  await flushPromises();
  expect(request).toHaveBeenCalledWith("/devices/one/tcp-mappings", {
    method: "POST",
    body: {
      v: 1,
      name: "数据库",
      enabled: false,
      listen_host: "192.168.1.5",
      listen_port: 11433,
      target_host: "192.168.0.4",
      target_port: 1433,
      source_cidrs: ["192.168.1.20", "2001:db8::/64"],
    },
  });
  expect(wrapper.text()).toContain("已停用");
  expect(wrapper.emitted("changed")).toHaveLength(1);
  wrapper.unmount();
});
it.each([
  new ApiError("MAPPING_CHANGED_RELOAD", 409),
  new ApiError("network", 0),
])(
  "requires reload before repeating an uncertain mapping mutation: %s",
  async (error) => {
    const request = vi
      .spyOn(api, "request")
      .mockResolvedValueOnce({ v: 1, mappings: [mapping] })
      .mockRejectedValueOnce(error)
      .mockResolvedValueOnce({ v: 1, mappings: [{ ...mapping, revision: 2 }] });
    const wrapper = mount(Panel, { props: { deviceId: "one" } });
    await flushPromises();
    await wrapper
      .findAll("button")
      .find((b) => b.text() === "编辑映射")!
      .trigger("click");
    await wrapper.get('[aria-label="启用映射"]').setValue(true);
    await wrapper.get("form").trigger("submit");
    await flushPromises();
    expect(request).toHaveBeenLastCalledWith(
      "/devices/one/tcp-mappings/map-1",
      {
        method: "PUT",
        body: {
          v: 1,
          revision: 1,
          name: mapping.name,
          enabled: true,
          listen_host: mapping.listen_host,
          listen_port: mapping.listen_port,
          target_host: mapping.target_host,
          target_port: mapping.target_port,
          source_cidrs: mapping.source_cidrs,
        },
      },
    );
    expect(wrapper.get('[role="alert"]').text()).toContain("重新加载");
    await wrapper.get("form").trigger("submit");
    expect(request).toHaveBeenCalledTimes(2);
    await wrapper
      .findAll("button")
      .find((b) => b.text() === "重新加载映射")!
      .trigger("click");
    await flushPromises();
    expect(wrapper.find("form").exists()).toBe(false);
    wrapper.unmount();
  },
);
it("reports bind conflicts and deletes with the stored revision", async () => {
  const request = vi
    .spyOn(api, "request")
    .mockResolvedValueOnce({ v: 1, mappings: [mapping] })
    .mockRejectedValueOnce(
      new ApiError("请求冲突，请核对原任务：MAPPING_PORT_IN_USE", 409),
    )
    .mockResolvedValueOnce({ v: 1, ok: true })
    .mockResolvedValueOnce({ v: 1, mappings: [] });
  const wrapper = mount(Panel, { props: { deviceId: "one" } });
  await flushPromises();
  await wrapper
    .findAll("button")
    .find((b) => b.text() === "编辑映射")!
    .trigger("click");
  await wrapper.get("form").trigger("submit");
  await flushPromises();
  expect(wrapper.get('[role="alert"]').text()).toContain("端口已被占用");
  await wrapper
    .findAll("button")
    .find((b) => b.text() === "删除映射并断开")!
    .trigger("click");
  await flushPromises();
  expect(request).toHaveBeenCalledWith("/devices/one/tcp-mappings/map-1", {
    method: "DELETE",
    body: { v: 1, revision: 1 },
  });
  expect(wrapper.text()).toContain("相关连接已断开");
  wrapper.unmount();
});
it.each(["agent", "ssh"])(
  "exposes mappings in the %s device configuration",
  async (kind) => {
    vi.spyOn(api, "request").mockResolvedValue({
      v: 1,
      device_id: "one",
      kind,
      revision: 1,
      ssh: null,
    });
    const wrapper = mount(Connection, {
      props: {
        device: { id: "one", name: "test", connection_kind: kind } as any,
      },
      global: { stubs: { DeviceTcpMappings: true } },
    });
    await flushPromises();
    await wrapper
      .findAll("button")
      .find((b) => b.text() === "端口映射")!
      .trigger("click");
    expect(wrapper.findComponent(Panel).props("deviceId")).toBe("one");
    expect(wrapper.find("#connection-config-form").exists()).toBe(false);
    wrapper.unmount();
  },
);
