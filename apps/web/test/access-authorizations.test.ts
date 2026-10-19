import { afterEach, expect, it, vi } from "vitest";
import { flushPromises, mount } from "@vue/test-utils";
import Panel from "../src/components/AccessAuthorizationsPanel.vue";
import { api } from "../src/api/client";
const resources = {
  devices: [{ id: "device", name: "生产服务器" }],
  accounts: [
    {
      id: "default",
      device_id: "device",
      name: "默认登录账号",
      username: "fleet",
      method: "default",
      is_default: true,
    },
    {
      id: "root",
      device_id: "device",
      name: "生产 root",
      username: "root",
      method: "sudo",
      is_default: false,
    },
  ],
  rules: [
    {
      id: "legacy",
      device_id: "device",
      account_id: "default",
      subject_type: "device_scope",
      subject_id: null,
      subject_name: "继承原设备授权",
      legacy_scope: true,
      revision: 1,
    },
  ],
};
const access = {
  users: [{ id: "user", username: "alice", enabled: true }],
  groups: [{ id: "group", name: "运维组" }],
  roles: [{ id: "role", name: "运维角色" }],
};
afterEach(() => vi.restoreAllMocks());
function mock() {
  return vi.spyOn(api, "request").mockImplementation(async (path, options) =>
    path === "/access"
      ? access
      : path.startsWith("/access-authorizations/effective/")
        ? {
            user: { username: "alice", role_names: ["运维角色"] },
            accounts: [
              {
                ...resources.accounts[1],
                allowed: false,
                reasons: ["运维组"],
                missing: ["sudo／特权账号权限"],
              },
            ],
          }
        : options?.method
          ? { v: 1, rule_ids: ["new"] }
          : resources,
  );
}
it("shows existing rules first and chooses one subject type in the new grant form", async () => {
  const request = mock();
  const wrapper = mount(Panel);
  await flushPromises();
  expect(wrapper.text()).toContain("继承原设备授权");
  expect(wrapper.find("form").exists()).toBe(false);
  await wrapper
    .findAll("button")
    .find((b) => b.text() === "新增访问授权")!
    .trigger("click");
  const selects = wrapper.findAll("select");
  expect(selects[0].element.value).toBe("group");
  await selects[1].setValue("group");
  await wrapper.get('input[type="checkbox"][value="root"]').setValue(true);
  await wrapper.get("form").trigger("submit");
  await flushPromises();
  expect(request).toHaveBeenCalledWith("/access-authorizations", {
    method: "POST",
    body: {
      v: 1,
      device_id: "device",
      account_ids: ["root"],
      subject_type: "group",
      subject_id: "group",
    },
  });
  expect(wrapper.find("form").exists()).toBe(false);
  wrapper.unmount();
});
it("shows effective authorization sources and missing operation permission", async () => {
  mock();
  const wrapper = mount(Panel, { props: { effective: true } });
  await flushPromises();
  await wrapper.get("select").setValue("user");
  await flushPromises();
  expect(wrapper.text()).toContain("运维组");
  expect(wrapper.text()).toContain("不可使用：缺少 sudo／特权账号权限");
  wrapper.unmount();
});
it("deletes only the chosen rule with its revision", async () => {
  const request = mock();
  vi.spyOn(window, "confirm").mockReturnValue(true);
  const wrapper = mount(Panel);
  await flushPromises();
  await wrapper
    .findAll("button")
    .find((b) => b.text() === "删除")!
    .trigger("click");
  await flushPromises();
  expect(request).toHaveBeenCalledWith("/access-authorizations/legacy", {
    method: "DELETE",
    body: { v: 1, revision: 1 },
  });
  wrapper.unmount();
});
