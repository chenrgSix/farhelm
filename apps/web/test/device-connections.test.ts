import { afterEach, expect, it, vi } from "vitest";
import { flushPromises, mount } from "@vue/test-utils";
import DeviceConnectionPanel from "../src/components/DeviceConnectionPanel.vue";
import { api } from "../src/api/client";
import type { Device, DeviceConnection } from "../src/api/types";
const device: Device = {
  id: "device",
  name: "Linux",
  control_online: false,
  business_healthy: null,
  private_data_reachable: null,
  last_seen: null,
  revoked_at: null,
  agent_version: null,
};
const connection: DeviceConnection = {
  v: 1,
  device_id: "device",
  kind: "ssh",
  revision: 1,
  ssh: {
    host: "192.168.1.10",
    port: 22,
    username: "linux",
    fingerprint: "SHA256:" + "A".repeat(43),
  },
  has_private_key: true,
  has_passphrase: false,
  has_sudo_password: false,
  last_checked_at: null,
  last_error: null,
};
afterEach(() => vi.restoreAllMocks());
it("requires host identity confirmation and sends secrets only on explicit save, then removes them from the form", async () => {
  const request = vi.spyOn(api, "request").mockResolvedValue(connection);
  const wrapper = mount(DeviceConnectionPanel);
  const inputs = wrapper.findAll("input");
  await inputs[0].setValue("Linux");
  await inputs[1].setValue("192.168.1.10");
  await inputs[3].setValue("linux");
  await wrapper.get("textarea").setValue("PRIVATE-KEY-CONTENT");
  await inputs[4].setValue("key-passphrase");
  await inputs[5].setValue(connection.ssh!.fingerprint);
  await wrapper.get("form").trigger("submit");
  expect(request).not.toHaveBeenCalled();
  await wrapper.get<HTMLInputElement>('input[type="checkbox"]').setValue(true);
  await wrapper.get("form").trigger("submit");
  await flushPromises();
  expect(request).toHaveBeenCalledWith("/ssh-devices", {
    method: "POST",
    body: {
      v: 1,
      name: "Linux",
      ssh: connection.ssh,
      private_key: "PRIVATE-KEY-CONTENT",
      passphrase: "key-passphrase",
    },
  });
  expect(wrapper.get("textarea").element.value).toBe("");
  expect(
    wrapper.get<HTMLInputElement>('input[type="password"]').element.value,
  ).toBe("");
  expect(wrapper.text()).toContain("已保存，留空保持不变");
  wrapper.unmount();
});
it("changing the address invalidates fingerprint approval and blocks testing unsaved changes; untouched keys are not resubmitted", async () => {
  const request = vi.spyOn(api, "request").mockResolvedValue(connection);
  const wrapper = mount(DeviceConnectionPanel, {
    props: { device: { ...device, connection_kind: "ssh" } },
  });
  await flushPromises();
  await wrapper.findAll("input")[0].setValue("another.example");
  expect(
    wrapper.get<HTMLInputElement>('input[type="checkbox"]').element.checked,
  ).toBe(false);
  expect(
    wrapper
      .findAll("button")
      .find((b) => b.text() === "测试已保存连接")!
      .attributes("disabled"),
  ).toBeDefined();
  await wrapper.get<HTMLInputElement>('input[type="checkbox"]').setValue(true);
  await wrapper.get("form").trigger("submit");
  await flushPromises();
  expect(request.mock.calls.at(-1)?.[1]?.body).toEqual({
    v: 1,
    revision: 1,
    ssh: { ...connection.ssh, host: "another.example" },
  });
  wrapper.unmount();
});
it("Agent sudo password remains write-only, omitted blanks preserve it, and explicit clearing sends null", async () => {
  const agent = {
    ...connection,
    kind: "agent",
    ssh: null,
    has_private_key: false,
    has_sudo_password: true,
  };
  const request = vi.spyOn(api, "request").mockResolvedValue(agent);
  const wrapper = mount(DeviceConnectionPanel, { props: { device } });
  await flushPromises();
  expect(
    wrapper.get<HTMLInputElement>('input[type="password"]').element.value,
  ).toBe("");
  expect(wrapper.find("textarea").exists()).toBe(false);
  await wrapper.get("form").trigger("submit");
  await flushPromises();
  expect(request.mock.calls.at(-1)?.[1]?.body).toEqual({ v: 1, revision: 1 });
  await wrapper.get<HTMLInputElement>('input[type="checkbox"]').setValue(true);
  await wrapper.get("form").trigger("submit");
  await flushPromises();
  expect(request.mock.calls.at(-1)?.[1]?.body).toEqual({
    v: 1,
    revision: 1,
    sudo_password: null,
  });
  expect(wrapper.text()).toContain("不会自动执行 sudo");
  wrapper.unmount();
});
it("maps host-key mismatch to actionable text without retrying or replacing the trusted fingerprint", async () => {
  const request = vi
    .spyOn(api, "request")
    .mockResolvedValueOnce(connection)
    .mockResolvedValue({
      ...connection,
      ok: false,
      last_error: "SSH_HOST_KEY_MISMATCH",
    });
  const wrapper = mount(DeviceConnectionPanel, {
    props: { device: { ...device, connection_kind: "ssh" } },
  });
  await flushPromises();
  await wrapper
    .findAll("button")
    .find((b) => b.text() === "测试已保存连接")!
    .trigger("click");
  await flushPromises();
  expect(wrapper.get('[role="alert"]').text()).toContain("连接已拒绝");
  expect(request).toHaveBeenCalledTimes(2);
  expect(
    wrapper
      .findAll("input")
      .some((input) => input.element.value === connection.ssh!.fingerprint),
  ).toBe(true);
  wrapper.unmount();
});
