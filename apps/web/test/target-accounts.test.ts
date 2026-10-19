import { afterEach, expect, it, vi } from "vitest";
import { flushPromises, mount } from "@vue/test-utils";
import TargetAccountsPanel from "../src/components/TargetAccountsPanel.vue";
import { api } from "../src/api/client";
afterEach(() => vi.restoreAllMocks());
const account = {
  id: "root-account",
  device_id: "device",
  name: "生产 root",
  username: "root",
  method: "sudo",
  revision: 3,
  is_default: false,
  allowed_users: ["ops"],
  allowed_groups: ["operations"],
  allowed_roles: ["operator-role"],
};
const defaultAccount = {
  id: "default-account",
  device_id: "device",
  name: "默认登录账号",
  username: "Agent 运行账号",
  method: "default",
  revision: 0,
  is_default: true,
};
const props = { deviceId: "device", deviceName: "服务器" };
it("selects the sole authorized default account from the unified account list", async () => {
  const request = vi
    .spyOn(api, "request")
    .mockResolvedValue({ accounts: [defaultAccount] });
  const wrapper = mount(TargetAccountsPanel, { props });
  await flushPromises();
  expect(request).toHaveBeenCalledWith("/devices/device/login-accounts");
  expect(wrapper.emitted("selected")).toEqual([[defaultAccount]]);
  wrapper.unmount();
});
it("does not offer a default account when no login account is authorized", async () => {
  vi.spyOn(api, "request").mockResolvedValue({ accounts: [] });
  const wrapper = mount(TargetAccountsPanel, { props });
  await flushPromises();
  expect(wrapper.emitted("selected")).toBeUndefined();
  expect(wrapper.text()).toContain("尚未获授任何登录账号");
  expect(wrapper.find("button.button.primary").exists()).toBe(false);
  wrapper.unmount();
});
it("selects a permitted custom account without retrieving credentials", async () => {
  const request = vi
    .spyOn(api, "request")
    .mockResolvedValue({ accounts: [account] });
  const wrapper = mount(TargetAccountsPanel, { props });
  await flushPromises();
  expect(wrapper.text()).toContain("从 Agent 运行账号经 sudo 切换");
  await wrapper.get("button.button.primary").trigger("click");
  expect(wrapper.emitted("selected")).toEqual([[account]]);
  expect(request).toHaveBeenCalledTimes(1);
  wrapper.unmount();
});
it("keeps account configuration separate from grants and links the default account to its existing configuration", async () => {
  vi.spyOn(api, "request").mockResolvedValue({
    accounts: [defaultAccount, account],
  });
  const wrapper = mount(TargetAccountsPanel, {
    props: { ...props, manage: true },
  });
  await flushPromises();
  expect(wrapper.find("form").exists()).toBe(false);
  expect(wrapper.find('input[type="checkbox"]').exists()).toBe(false);
  await wrapper
    .findAll("button")
    .find((b) => b.text() === "配置默认账号")!
    .trigger("click");
  expect(wrapper.emitted("connection")).toHaveLength(1);
  await wrapper
    .findAll("button")
    .find((b) => b.text() === "管理访问授权")!
    .trigger("click");
  expect(wrapper.emitted("authorize")).toHaveLength(1);
  wrapper.unmount();
});
it("saves credential-only metadata without changing grants and removes the secret form after save", async () => {
  const request = vi
    .spyOn(api, "request")
    .mockResolvedValueOnce({ accounts: [defaultAccount] })
    .mockResolvedValueOnce({ account })
    .mockResolvedValue({ accounts: [defaultAccount, account] });
  const wrapper = mount(TargetAccountsPanel, {
    props: { ...props, manage: true },
  });
  await flushPromises();
  await wrapper
    .findAll("button")
    .find((b) => b.text() === "新增登录账号")!
    .trigger("click");
  await wrapper
    .get('input[placeholder="例如：生产 root 运维"]')
    .setValue("生产 root");
  await wrapper.get('input[type="password"]').setValue("fixture-password9");
  await wrapper.get("form").trigger("submit");
  await flushPromises();
  expect(request.mock.calls[1]).toEqual([
    "/devices/device/accounts",
    {
      method: "POST",
      body: {
        v: 1,
        name: "生产 root",
        username: "root",
        method: "sudo",
        sudo_password: "fixture-password9",
      },
    },
  ]);
  expect(wrapper.find("form").exists()).toBe(false);
  expect(wrapper.text()).not.toContain("fixture-password9");
  wrapper.unmount();
});
it("preserves stored credentials and authorization during an account edit", async () => {
  const request = vi
    .spyOn(api, "request")
    .mockResolvedValue({ accounts: [account] });
  const wrapper = mount(TargetAccountsPanel, {
    props: { ...props, manage: true },
  });
  await flushPromises();
  await wrapper
    .findAll("button")
    .find((b) => b.text() === "编辑")!
    .trigger("click");
  await wrapper.get("form").trigger("submit");
  await flushPromises();
  expect(request.mock.calls[1][1]?.body).toEqual({
    v: 1,
    revision: 3,
    name: "生产 root",
    username: "root",
    method: "sudo",
  });
  wrapper.unmount();
});
it("does not fall back to the default account when lookup fails", async () => {
  vi.spyOn(api, "request").mockRejectedValue(new Error("PERMISSION_DENIED"));
  const wrapper = mount(TargetAccountsPanel, { props });
  await flushPromises();
  expect(wrapper.emitted("selected")).toBeUndefined();
  expect(wrapper.get('[role="alert"]').text()).toContain("PERMISSION_DENIED");
  wrapper.unmount();
});
