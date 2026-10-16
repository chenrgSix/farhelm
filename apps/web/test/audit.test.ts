import { expect, it } from "vitest";
import { mount } from "@vue/test-utils";
import { readFileSync } from "node:fs";
import ActorIdentity from "../src/components/ActorIdentity.vue";
import AuditDetails from "../src/components/AuditDetails.vue";
import HistoryFilters from "../src/components/HistoryFilters.vue";
import { emptyHistoryFilters } from "../src/composables/useHistoryList";
import {
  auditActionLabels,
  auditFields,
  auditOutcome,
  auditSummary,
  auditSource,
} from "../src/audit";
import type { AuditEntry } from "../src/api/types";
const entry: AuditEntry = {
  id: 1,
  at: 1,
  actor_id: "user-id",
  actor_username: "operator",
  device_id: "device",
  device_name: "生产设备",
  task_id: "task",
  action: "task.created",
  detail: { argv: ["echo", "hello"], cwd: "/tmp", authorized: true },
  context: {
    source: "http",
    remote_address: "203.0.113.1",
    request_id: "req-1",
    method: "POST",
    route: "/api/v1/commands",
    user_agent: "Test browser",
  },
};
it("all registered audit events have Chinese names and unknown future events remain identifiable", () => {
  const schema = JSON.parse(
    readFileSync("../../contracts/v1/audit.schema.json", "utf8"),
  );
  for (const action of schema.properties.action.enum)
    expect(auditActionLabels[action]).toMatch(/[\u4e00-\u9fff]/);
  expect(auditOutcome({ ...entry, action: "future.event", detail: {} })).toBe(
    "已记录",
  );
});
it("shows a readable account name, with full identity retained for inspection and safe missing-account fallback", () => {
  const wrapper = mount(ActorIdentity, {
    props: { id: "opaque-id", username: "operator" },
  });
  expect(wrapper.text()).toBe("operator");
  expect(wrapper.attributes("title")).toContain("opaque-id");
  wrapper.unmount();
  const missing = mount(ActorIdentity, { props: { id: "deleted-id" } });
  expect(missing.text()).toContain("未知账号");
  expect(missing.text()).toContain("deleted-id");
  missing.unmount();
});
it("summarizes commands and results without claiming asynchronous requests succeeded", () => {
  expect(auditSummary(entry)).toContain("echo");
  expect(auditSummary(entry)).toContain("/tmp");
  expect(
    auditOutcome({
      ...entry,
      action: "task.finished",
      detail: {
        payload: { status: "FAILED", exit_code: 2, reason: "command failed" },
      },
    }),
  ).toBe("执行失败");
  expect(auditOutcome({ ...entry, action: "task.cancel_requested" })).toBe(
    "已请求",
  );
  expect(auditOutcome({ ...entry, action: "connection.tested" })).toBe(
    "已发起测试",
  );
  expect(
    auditOutcome({
      ...entry,
      action: "terminal.closed",
      detail: { reason: "AGENT_DISCONNECTED" },
    }),
  ).toBe("已中断");
  expect(
    auditSummary({
      ...entry,
      action: "user.login_failed",
      detail: { username: "admin" },
    }),
  ).toContain("未认证");
  expect(
    auditFields({
      ...entry,
      detail: { changes: { permissions: ["tasks.read_all"], enabled: false } },
    }),
  ).toEqual([
    { label: "权限（变更后）", value: "查看他人任务" },
    { label: "启用（变更后）", value: "否" },
  ]);
  expect(
    auditFields({
      ...entry,
      detail: { changes: { username: "admin", device_ids: ["ops"] } },
    }),
  ).toEqual([
    { label: "账号（变更后）", value: "admin" },
    { label: "设备（变更后）", value: "ops" },
  ]);
  expect(auditSource({ ...entry, context: null })).toBe("历史记录未采集来源");
});
it("renders useful details, source and raw evidence as escaped text", () => {
  const wrapper = mount(AuditDetails, {
    props: {
      entry: {
        ...entry,
        detail: { argv: ["echo", "<img src=x onerror=alert(1)>"], cwd: "/tmp" },
      },
    },
  });
  expect(wrapper.text()).toContain("来源地址");
  expect(wrapper.text()).toContain("请求编号");
  expect(wrapper.text()).toContain("工作目录");
  expect(wrapper.text()).toContain("原始记录 JSON");
  expect(wrapper.find("img").exists()).toBe(false);
  wrapper.unmount();
});
it("offers Chinese event filters while submitting the exact server event code", async () => {
  const wrapper = mount(HistoryFilters, {
    props: { kind: "audit", filters: emptyHistoryFilters(), devices: [] },
  });
  const select = wrapper.findAll("select").at(-1)!;
  expect(select.text()).toContain("账号登录");
  await select.setValue("user.login");
  await wrapper.get("form").trigger("submit");
  expect((wrapper.emitted("apply")![0]![0] as any).action).toBe("user.login");
  wrapper.unmount();
});
