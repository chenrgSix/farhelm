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
  allowed_users: ["ops"],
};
const props = { deviceId: "device", deviceName: "服务器" };
it("keeps default-only devices compatible and selects the default without opening a session itself", async () => {
  const request = vi.spyOn(api, "request").mockResolvedValue({ accounts: [] });
  const wrapper = mount(TargetAccountsPanel, { props });
  await flushPromises();
  expect(wrapper.emitted("selected")).toEqual([[]]);
  expect(request).toHaveBeenCalledTimes(1);
  wrapper.unmount();
});
it("selects a permitted target account without retrieving credentials", async () => {
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
it("saves account-specific sudo credentials and selected users, then clears the password input", async () => {
  const request = vi
    .spyOn(api, "request")
    .mockResolvedValueOnce({
      accounts: [],
      users: [{ id: "ops", username: "operator" }],
    })
    .mockResolvedValueOnce({ account })
    .mockResolvedValue({ accounts: [account], users: [] });
  const wrapper = mount(TargetAccountsPanel, {
    props: { ...props, manage: true },
  });
  await flushPromises();
  await wrapper
    .get('input[placeholder="例如：生产 root 运维"]')
    .setValue("生产 root");
  await wrapper.get('input[type="password"]').setValue("fixture-password9");
  await wrapper.get('input[type="checkbox"][value="ops"]').setValue(true);
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
        allowed_users: ["ops"],
        sudo_password: "fixture-password9",
      },
    },
  ]);
  expect(
    wrapper.get<HTMLInputElement>('input[type="password"]').element.value,
  ).toBe("");
  expect(wrapper.text()).not.toContain("fixture-password9");
  expect(wrapper.emitted("selected")).toBeUndefined();
  wrapper.unmount();
});
it("preserves stored credentials when editing with blank password and sends the current revision", async () => {
  const request = vi
    .spyOn(api, "request")
    .mockResolvedValue({ accounts: [account], users: [] });
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
  expect(request.mock.calls[1][1]?.body).toMatchObject({
    revision: 3,
    method: "sudo",
    allowed_users: ["ops"],
  });
  expect(request.mock.calls[1][1]?.body).not.toHaveProperty("sudo_password");
  wrapper.unmount();
});
it("does not silently fall back to the default account when authorization lookup fails", async () => {
  vi.spyOn(api, "request").mockRejectedValue(new Error("PERMISSION_DENIED"));
  const wrapper = mount(TargetAccountsPanel, { props });
  await flushPromises();
  expect(wrapper.emitted("selected")).toBeUndefined();
  expect(wrapper.get('[role="alert"]').text()).toContain("PERMISSION_DENIED");
  wrapper.unmount();
});
