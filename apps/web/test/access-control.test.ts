import { afterEach, expect, it, vi } from "vitest";
import { flushPromises, mount } from "@vue/test-utils";
import AccessManagementPanel from "../src/components/AccessManagementPanel.vue";
import { api } from "../src/api/client";
import { hasPermission } from "../src/model";
import type { AccessManagement, Device, User } from "../src/api/types";
const devices: Device[] = [
  {
    id: "one",
    name: "Linux-1",
    control_online: true,
    business_healthy: null,
    private_data_reachable: null,
    last_seen: null,
    revoked_at: null,
    agent_version: null,
  },
];
const data: AccessManagement = {
  v: 1,
  permissions: [
    { id: "devices.read", label: "查看设备", description: "设备" },
    { id: "tasks.read", label: "查看任务", description: "任务" },
    { id: "tasks.read_all", label: "查看他人任务", description: "审计" },
    { id: "audit.read", label: "查看本人操作审计", description: "本人" },
    { id: "audit.read_all", label: "查看他人操作审计", description: "审计" },
    { id: "recordings.read", label: "查看本人会话与录制", description: "本人" },
    {
      id: "recordings.read_all",
      label: "查看他人会话与录制",
      description: "审计",
    },
    { id: "tasks.execute", label: "执行命令", description: "执行" },
  ],
  users: [
    {
      id: "user",
      username: "operator",
      enabled: true,
      revision: 3,
      created_at: 1,
      role_ids: [],
      group_ids: ["group"],
      device_scope: [],
      effective_role: "ops",
      effective_permissions: ["devices.read", "terminal.connect"],
      effective_device_scope: ["one"],
      role_names: ["运维"],
    },
  ],
  roles: [
    {
      id: "ops",
      name: "运维",
      description: "",
      permissions: ["devices.read", "terminal.connect"],
      builtin: true,
      revision: 0,
      user_count: 0,
      group_count: 1,
    },
  ],
  groups: [
    {
      id: "group",
      name: "运维组",
      description: "",
      revision: 2,
      role_ids: ["ops"],
      member_ids: ["user"],
      device_scope: [],
    },
  ],
  device_groups: [
    {
      id: "production",
      name: "生产组",
      description: "可选标签",
      revision: 1,
      device_ids: ["one"],
    },
    {
      id: "other",
      name: "公共组",
      description: "",
      revision: 0,
      device_ids: [],
    },
  ],
};
afterEach(() => vi.restoreAllMocks());
async function setup() {
  const request = vi
    .spyOn(api, "request")
    .mockImplementation(async (_path, options) =>
      options ? { v: 1, ok: true } : (structuredClone(data) as any),
    );
  const wrapper = mount(AccessManagementPanel, {
    props: { currentUserId: "admin", devices },
    global: { stubs: { Teleport: true } },
  });
  await flushPromises();
  const button = (text: string) =>
    wrapper.findAll("button").find((b) => b.text() === text)!;
  return { wrapper, request, button };
}
it("creates users with no implicit privileges, uses device-group tags to select concrete devices and clears passwords", async () => {
  const { wrapper, request, button } = await setup();
  await button("创建用户").trigger("click");
  await wrapper.get('input[autocomplete="off"]').setValue("new-user");
  await wrapper.get('input[type="password"]').setValue("abcd1234");
  await wrapper.get('[aria-label="加入用户组 运维组"]').setValue(true);
  await wrapper.get('[aria-label="批量选择设备组 生产组"]').setValue(true);
  await wrapper.get("form").trigger("submit");
  await flushPromises();
  expect(request).toHaveBeenCalledWith("/users", {
    method: "POST",
    body: {
      v: 1,
      username: "new-user",
      password: "abcd1234",
      enabled: true,
      role_ids: [],
      group_ids: ["group"],
      device_scope: ["one"],
    },
  });
  expect(wrapper.find('input[type="password"]').exists()).toBe(false);
  wrapper.unmount();
});
it("edits user groups with members, role grants and concrete devices and optimistic revision", async () => {
  const { wrapper, request } = await setup();
  await wrapper.get('[role="tab"]:nth-child(3)').trigger("click");
  await wrapper.get('[aria-label="编辑用户组 运维组"]').trigger("click");
  await wrapper.get('[aria-label="批量选择设备组 生产组"]').setValue(true);
  await wrapper.get("form").trigger("submit");
  await flushPromises();
  expect(request).toHaveBeenCalledWith("/groups/group", {
    method: "PUT",
    body: {
      v: 1,
      revision: 2,
      name: "运维组",
      description: "",
      role_ids: ["ops"],
      member_ids: ["user"],
      device_scope: ["one"],
    },
  });
  wrapper.unmount();
});
it("keeps device-group management out of account management", async () => {
  const { wrapper } = await setup();
  expect(wrapper.findAll('[role="tab"]').map((t) => t.text())).toEqual([
    "用户 1",
    "角色 1",
    "用户组 1",
  ]);
  expect(wrapper.text()).not.toContain("创建设备组");
  wrapper.unmount();
});
it("stale saves cannot overwrite newer permissions; role permission dependencies are included", async () => {
  const { wrapper, request, button } = await setup();
  await wrapper.get('[role="tab"]:nth-child(2)').trigger("click");
  await button("创建角色").trigger("click");
  await wrapper.get('input[maxlength="64"]').setValue("命令执行");
  await wrapper.get('input[value="tasks.execute"]').setValue(true);
  request.mockRejectedValueOnce(
    new Error("权限已修改（ACCESS_REVISION_CONFLICT）"),
  );
  await wrapper.get("form").trigger("submit");
  await flushPromises();
  expect(request).toHaveBeenCalledWith("/roles", {
    method: "POST",
    body: {
      v: 1,
      name: "命令执行",
      description: "",
      permissions: ["tasks.execute", "devices.read", "tasks.read"],
    },
  });
  expect(
    wrapper.get('button[type="submit"]').attributes("disabled"),
  ).toBeDefined();
  expect(wrapper.text()).toContain("刷新列表");
  wrapper.unmount();
});
it("granular permissions replace legacy ops powers and always honor device scope", () => {
  const u: User = {
    id: "u",
    username: "u",
    role: "ops",
    device_scope: ["one"],
    permissions: ["devices.read", "terminal.connect"],
  };
  expect(hasPermission(u, "terminal.connect", "one")).toBe(true);
  expect(hasPermission(u, "terminal.connect", "two")).toBe(false);
  expect(hasPermission(u, "tasks.execute", "one")).toBe(false);
  expect(hasPermission({ ...u, permissions: [] }, "devices.read")).toBe(false);
});

it("validates the same password policy when an administrator resets a password", async () => {
  const { wrapper, request } = await setup();
  await wrapper.get('[aria-label="重置密码 operator"]').trigger("click");
  await wrapper.get('input[type="password"]').setValue("onlyletters");
  await wrapper.get("form").trigger("submit");
  await flushPromises();
  expect(wrapper.get('[role="alert"]').text()).toContain("英文字母和数字");
  expect(
    request.mock.calls.filter(([, options]) => options?.method === "POST"),
  ).toHaveLength(0);
  await wrapper.get('input[type="password"]').setValue("abcd1234");
  await wrapper.get("form").trigger("submit");
  await flushPromises();
  expect(request).toHaveBeenCalledWith("/users/user/password", {
    method: "POST",
    body: { v: 1, revision: 3, password: "abcd1234" },
  });
  wrapper.unmount();
});

it("cross-user recording permission requires own recording access and does not follow ops by default", async () => {
  const { wrapper, request, button } = await setup();
  await wrapper.get('[role="tab"]:nth-child(2)').trigger("click");
  await button("创建角色").trigger("click");
  await wrapper.get('input[maxlength="64"]').setValue("会话审计");
  await wrapper.get('input[value="recordings.read_all"]').setValue(true);
  expect(
    wrapper.get<HTMLInputElement>('input[value="recordings.read"]').element
      .checked,
  ).toBe(true);
  expect(
    wrapper.get('input[value="recordings.read"]').attributes("disabled"),
  ).toBeDefined();
  await wrapper.get("form").trigger("submit");
  await flushPromises();
  expect(request).toHaveBeenCalledWith("/roles", {
    method: "POST",
    body: {
      v: 1,
      name: "会话审计",
      description: "",
      permissions: ["recordings.read_all", "devices.read", "recordings.read"],
    },
  });
  for (const role of ["ops", "business", "admin", "auditor"] as const)
    expect(
      hasPermission(
        { id: "u", username: "u", role, device_scope: "*" },
        "recordings.read_all",
      ),
    ).toBe(["admin", "auditor"].includes(role));
  expect(
    hasPermission(
      {
        id: "u",
        username: "u",
        role: "auditor",
        device_scope: "*",
        permissions: ["recordings.read"],
      },
      "recordings.read_all",
    ),
  ).toBe(false);
  wrapper.unmount();
});

it("task and audit review grants select and lock their base read permissions", async () => {
  const { wrapper, request, button } = await setup();
  await wrapper.get('[role="tab"]:nth-child(2)').trigger("click");
  await button("创建角色").trigger("click");
  await wrapper.get('input[maxlength="64"]').setValue("操作审计");
  for (const kind of ["tasks", "audit"]) {
    await wrapper.get(`input[value="${kind}.read_all"]`).setValue(true);
    const base = wrapper.get<HTMLInputElement>(`input[value="${kind}.read"]`);
    expect(base.element.checked).toBe(true);
    expect(base.attributes("disabled")).toBeDefined();
  }
  await wrapper.get("form").trigger("submit");
  await flushPromises();
  const saved = request.mock.calls.find(([path]) => path === "/roles")![1]!
    .body as any;
  expect(saved.permissions).toEqual(
    expect.arrayContaining([
      "tasks.read",
      "tasks.read_all",
      "audit.read",
      "audit.read_all",
      "devices.read",
    ]),
  );
  wrapper.unmount();
});
