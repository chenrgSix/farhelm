import { afterEach, expect, it, vi } from "vitest";
import { flushPromises, mount } from "@vue/test-utils";
import ApiTokensPanel from "../src/components/ApiTokensPanel.vue";
import { api, ApiError } from "../src/api/client";
import type { ApiToken, ApiTokenList } from "../src/api/tokens";
import type { Device } from "../src/api/types";
import { auditOutcome, auditSource } from "../src/audit";

const devices: Device[] = ["one", "two"].map((id) => ({
  id,
  name: "Linux-" + id,
  device_groups: id === "one" ? [{ id: "prod", name: "生产组" }] : [],
  control_online: false,
  private_data_reachable: null,
  business_healthy: null,
  last_seen: null,
  revoked_at: null,
  agent_version: null,
}));
const grant: ApiToken = {
  id: "grant",
  owner_id: "admin",
  owner_username: "administrator",
  name: "每日巡检",
  prefix: "fh_api_abcdefgh",
  permissions: ["devices.read"],
  device_scope: ["one"],
  expires_at: Date.now() + 86400000,
  created_at: 1,
  updated_at: 1,
  revoked_at: null,
  last_used_at: null,
  last_used_address: null,
  revision: 3,
  status: "active",
};
const data: ApiTokenList = {
  v: 1,
  tokens: [grant],
  permissions: [
    { id: "devices.read", label: "查看设备", description: "查看授权设备" },
    { id: "tasks.execute", label: "执行命令", description: "创建任务" },
    { id: "tasks.read_all", label: "查看他人任务", description: "审计任务" },
  ],
};
const mounted: ReturnType<typeof mount>[] = [];
afterEach(() => {
  mounted.splice(0).forEach((w) => w.unmount());
  vi.restoreAllMocks();
});
async function setup(handler?: (path: string, options: any) => any) {
  const request = vi
    .spyOn(api, "request")
    .mockImplementation(async (path, options) =>
      handler ? handler(path, options) : structuredClone(data),
    );
  const wrapper = mount(ApiTokensPanel, {
    props: { currentUserId: "admin", devices },
    global: { stubs: { Teleport: true } },
  });
  mounted.push(wrapper);
  await flushPromises();
  const button = (text: string) =>
    wrapper.findAll("button").find((b) => b.text() === text)!;
  return { wrapper, request, button };
}
it("creates a scoped token using concrete device group selections, reveals its secret once and clears it on dismissal", async () => {
  const secret = "fh_api_" + "x".repeat(43);
  const { wrapper, request, button } = await setup((_path, options) =>
    options ? { v: 1, token: grant, secret } : structuredClone(data),
  );
  await button("创建 Token").trigger("click");
  await wrapper.get('input[placeholder="例如：每日巡检"]').setValue("AI 巡检");
  await wrapper.get('[aria-label="批量选择设备组 生产组"]').setValue(true);
  await wrapper.get("form").trigger("submit");
  await flushPromises();
  const creation = request.mock.calls.find(
    ([, options]) => options?.method === "POST",
  )!;
  expect(creation[0]).toBe("/api-tokens");
  expect(creation[1]?.body).toMatchObject({
    v: 1,
    name: "AI 巡检",
    permissions: ["devices.read"],
    device_scope: ["one"],
  });
  expect((creation[1]?.body as any).expires_at).toBeGreaterThan(
    Date.now() + 29 * 86400000,
  );
  expect(wrapper.get('[aria-label="新建 API Token"]').attributes("type")).toBe(
    "password",
  );
  expect(
    (wrapper.get('[aria-label="新建 API Token"]').element as HTMLInputElement)
      .value,
  ).toBe(secret);
  expect(wrapper.text()).not.toContain(secret);
  await button("已保存，关闭").trigger("click");
  expect(wrapper.find('[aria-label="新建 API Token"]').exists()).toBe(false);
  await button("创建 Token").trigger("click");
  expect(
    (
      wrapper.get('input[placeholder="例如：每日巡检"]')
        .element as HTMLInputElement
    ).value,
  ).toBe("");
});
it("edits grants with revision control and revokes only after the concrete dialog action", async () => {
  const { wrapper, request, button } = await setup((_path, options) =>
    options ? { v: 1, token: grant } : structuredClone(data),
  );
  await button("编辑").trigger("click");
  await wrapper.get('[aria-label="执行命令"]').setValue(true);
  await wrapper.get("form").trigger("submit");
  await flushPromises();
  expect(request).toHaveBeenCalledWith(
    "/api-tokens/grant",
    expect.objectContaining({
      method: "PUT",
      body: expect.objectContaining({
        revision: 3,
        permissions: ["devices.read", "tasks.execute"],
        device_scope: ["one"],
      }),
    }),
  );
  await button("撤销").trigger("click");
  expect(
    request.mock.calls.filter(([, o]) => o?.method === "POST"),
  ).toHaveLength(0);
  await button("确认撤销").trigger("click");
  await flushPromises();
  expect(request).toHaveBeenCalledWith("/api-tokens/grant/revoke", {
    method: "POST",
    body: { v: 1 },
  });
  expect(wrapper.text()).toContain("令牌已撤销");
});
it("does not retry an uncertain token creation or expose a fabricated secret", async () => {
  const { wrapper, request, button } = await setup((_path, options) => {
    if (options) throw new ApiError("timeout");
    return structuredClone(data);
  });
  await button("创建 Token").trigger("click");
  await wrapper
    .get('input[placeholder="例如：每日巡检"]')
    .setValue("uncertain");
  await wrapper.get("form").trigger("submit");
  await flushPromises();
  expect(wrapper.text()).toContain("请求结果未确认");
  expect(button("创建").attributes("disabled")).toBeDefined();
  await wrapper.get("form").trigger("submit");
  await flushPromises();
  expect(
    request.mock.calls.filter(([, o]) => o?.method === "POST"),
  ).toHaveLength(1);
  expect(wrapper.find('[aria-label="新建 API Token"]').exists()).toBe(false);
});
it("blocks expired time and incomplete read_all permissions before submission", async () => {
  const { wrapper, request, button } = await setup();
  await button("创建 Token").trigger("click");
  await wrapper.get('[aria-label="查看他人任务"]').setValue(true);
  await wrapper.get("form").trigger("submit");
  await flushPromises();
  expect(wrapper.text()).toContain("需同时勾选");
  await wrapper.get('[aria-label="查看他人任务"]').setValue(false);
  await wrapper.get("select").setValue("custom");
  await wrapper
    .get('input[type="datetime-local"]')
    .setValue("2020-01-01T00:00");
  await wrapper.get("form").trigger("submit");
  await flushPromises();
  expect(wrapper.text()).toContain("未来一年内");
  expect(
    request.mock.calls.filter(([, o]) => o?.method === "POST"),
  ).toHaveLength(0);
});
it("shows API identity and failed request outcomes in audit", () => {
  const entry = {
    id: 1,
    at: 1,
    actor_id: "admin",
    device_id: null,
    task_id: null,
    action: "api_token.request",
    context: {
      source: "api" as const,
      api_token_id: "grant",
      api_token_name: "每日巡检",
    },
    detail: { status_code: 403 },
  };
  expect(auditSource(entry)).toBe("API Token · 每日巡检");
  expect(auditOutcome(entry)).toBe("失败 / 拒绝（403）");
});
