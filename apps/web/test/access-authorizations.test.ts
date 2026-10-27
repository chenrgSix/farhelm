import { afterEach, expect, it, vi } from "vitest";
import { flushPromises, mount } from "@vue/test-utils";
import Control from "../src/components/AccessControlPanel.vue";
import Panel from "../src/components/AccessAuthorizationsPanel.vue";
import { api } from "../src/api/client";
const resources = {
  devices: [{ id: "device", name: "生产服务器" }],
  accounts: [
    {
      id: "default",
      device_id: "device",
      name: "普通连接",
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
      id: "retired-rule",
      device_id: "device",
      account_id: "root",
      subject_type: "user",
      subject_id: "old",
      subject_name: "旧账号专属授权",
      legacy_scope: false,
      revision: 1,
    },
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
                ...resources.accounts[0],
                allowed: false,
                reasons: ["运维组"],
                missing: ["终端连接权限"],
              },
              {
                ...resources.accounts[1],
                allowed: true,
                reasons: ["旧账号来源"],
                missing: [],
              },
            ],
          }
        : options?.method
          ? { v: 1, rule_ids: ["new"] }
          : resources,
  );
}
it("creates ordinary device grants without account selection or archived rules", async () => {
  const request = mock();
  const wrapper = mount(Panel);
  await flushPromises();
  expect(wrapper.text()).toContain("继承原设备授权");
  expect(wrapper.find("form").exists()).toBe(false);
  await wrapper
    .findAll("button")
    .find((b) => b.text() === "新增连接授权")!
    .trigger("click");
  const selects = wrapper.findAll("select");
  expect(selects[0].element.value).toBe("group");
  await selects[1].setValue("group");
  expect(wrapper.find('input[type="checkbox"]').exists()).toBe(false);
  expect(wrapper.text()).not.toContain("生产 root");
  expect(wrapper.text()).not.toContain("旧账号专属授权");
  await wrapper.get("form").trigger("submit");
  await flushPromises();
  expect(request).toHaveBeenCalledWith("/access-authorizations", {
    method: "POST",
    body: {
      v: 1,
      device_id: "device",
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
  expect(wrapper.text()).not.toContain("生产 root");
  expect(wrapper.text()).not.toContain("旧账号来源");
  expect(wrapper.text()).toContain("不可使用：缺少 终端连接权限");
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

it("exposes ordinary authorization and permission inspection directly without advanced account entry points", async () => {
  const wrapper = mount(Control, {
    props: { currentUserId: "admin", devices: [] },
    global: {
      stubs: { AccessManagementPanel: true, AccessAuthorizationsPanel: true },
    },
  });
  expect(wrapper.find("details").exists()).toBe(false);
  expect(wrapper.text()).not.toContain("高级授权");
  await wrapper
    .findAll("button")
    .find((b) => b.text() === "设备访问授权")!
    .trigger("click");
  expect(wrapper.findComponent(Panel).exists()).toBe(true);
  expect(wrapper.findComponent(Panel).props("effective")).toBe(false);
  await wrapper
    .findAll("button")
    .find((b) => b.text() === "权限核对")!
    .trigger("click");
  expect(wrapper.findComponent(Panel).props("effective")).toBe(true);
  wrapper.unmount();
});

it("saves per-device personal deny and permits only allow rules for groups", async () => {
  const request = mock();
  const wrapper = mount(Panel);
  await flushPromises();
  await wrapper
    .findAll("button")
    .find((b) => b.text() === "配置 sudo 授权")!
    .trigger("click");
  await wrapper.get('select[aria-label="sudo 授权对象"]').setValue("user");
  await wrapper.get('select[aria-label="sudo 策略"]').setValue("deny");
  await wrapper.get('form[aria-label="配置 sudo 授权"]').trigger("submit");
  await flushPromises();
  expect(request).toHaveBeenCalledWith("/access-authorizations/sudo", {
    method: "POST",
    body: {
      v: 1,
      device_id: "device",
      subject_type: "user",
      subject_id: "user",
      effect: "deny",
      revision: 0,
    },
  });
  await wrapper
    .findAll("button")
    .find((b) => b.text() === "配置 sudo 授权")!
    .trigger("click");
  await wrapper.get('select[aria-label="sudo 授权对象类型"]').setValue("group");
  expect(
    wrapper
      .find('select[aria-label="sudo 策略"] option[value="deny"]')
      .exists(),
  ).toBe(false);
  wrapper.unmount();
});
