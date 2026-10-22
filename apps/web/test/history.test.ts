import { afterEach, expect, it, vi } from "vitest";
import { flushPromises, mount, type VueWrapper } from "@vue/test-utils";
import App from "../src/App.vue";
import HistoryFilters from "../src/components/HistoryFilters.vue";
import { emptyHistoryFilters } from "../src/composables/useHistoryList";
import { api } from "../src/api/client";

let wrapper: VueWrapper;
afterEach(() => {
  window.history.replaceState(null, "", "/");
  wrapper?.unmount();
  vi.restoreAllMocks();
  api.setToken(null);
  sessionStorage.clear();
});
const user = {
  id: "admin",
  username: "admin",
  role: "admin",
  device_scope: "*",
};
const task = (id: string) => ({
  task_id: id,
  device_id: "one",
  actor_id: "admin",
  action: "exec",
  argv: ["/bin/echo", id],
  cwd: "/tmp",
  created_at: 1000,
  expires_at: 2000,
  timeout_ms: 1000,
  max_output_bytes: 1000,
  payload_hash: "a".repeat(64),
  status: "SUCCEEDED",
  result: null,
});
async function setup(
  history: (query: URLSearchParams) => unknown,
  detail?: (id: string) => unknown,
) {
  const request = vi.spyOn(api, "request").mockImplementation(async (path) => {
    if (path === "/login") return { access_token: "test", user };
    if (path === "/me") return user;
    if (path.split("?")[0] === "/devices") return { devices: [] };
    if (path === "/tasks/summary") return { v: 1, active: 0, unknown: 0 };
    if (path === "/tasks") return { tasks: [] };
    if (path.startsWith("/tasks?"))
      return history(new URLSearchParams(path.split("?")[1]));
    if (path.startsWith("/tasks/"))
      return detail?.(path.slice(7)) ?? task(path.slice(7));
    return { device_groups: [] };
  });
  wrapper = mount(App);
  await wrapper.get('input[name="username"]').setValue("admin");
  await wrapper.get('input[name="password"]').setValue("password");
  await wrapper.get("form").trigger("submit");
  await flushPromises();
  await wrapper
    .findAll("nav button")
    .find((b) => b.text().includes("任务中心"))!
    .trigger("click");
  await flushPromises();
  return request;
}
function button(name: string) {
  return wrapper.findAll("button").find((b) => b.text() === name)!;
}

it("queries the server, pages backward and resets the cursor when criteria change", async () => {
  const request = await setup((query) => ({
    tasks: [
      task(
        query.get("q") || (query.has("cursor") ? "older-page" : "newest-page"),
      ),
    ],
    page: {
      limit: 50,
      has_more: !query.has("cursor"),
      next_cursor: query.has("cursor") ? null : "next",
    },
  }));
  expect(wrapper.text()).toContain("newest-page");
  await button("下一页").trigger("click");
  await flushPromises();
  expect(wrapper.text()).toContain("older-page");
  expect(wrapper.text()).toContain("第 2 页");
  await button("上一页").trigger("click");
  await flushPromises();
  expect(wrapper.text()).toContain("newest-page");
  await button("下一页").trigger("click");
  await flushPromises();
  await wrapper
    .get('.history-filters input[type="search"]')
    .setValue("older-than-500");
  await wrapper.get(".history-filters").trigger("submit");
  await flushPromises();
  expect(wrapper.text()).toContain("older-than-500");
  expect(wrapper.text()).toContain("第 1 页");
  const query = new URLSearchParams(
    request.mock.calls.at(-1)![0].split("?")[1],
  );
  expect(query.get("q")).toBe("older-than-500");
  expect(query.has("cursor")).toBe(false);
});

it("ignores a late response from the previous query", async () => {
  let resolve!: (response: unknown) => void;
  await setup((query) =>
    query.get("q") === "slow"
      ? new Promise((done) => {
          resolve = done;
        })
      : {
          tasks: [task(query.get("q") || "first")],
          page: { limit: 50, has_more: false, next_cursor: null },
        },
  );
  await wrapper.get('.history-filters input[type="search"]').setValue("slow");
  await wrapper.get(".history-filters").trigger("submit");
  await flushPromises();
  await wrapper.get('.history-filters input[type="search"]').setValue("latest");
  await wrapper.get(".history-filters").trigger("submit");
  await flushPromises();
  resolve({
    tasks: [task("slow")],
    page: { limit: 50, has_more: true, next_cursor: "wrong" },
  });
  await flushPromises();
  expect(wrapper.text()).toContain("latest");
  expect(
    wrapper
      .findAll(".task-link")
      .map((b) => b.text())
      .join(),
  ).not.toContain("slow");
  expect(button("下一页").attributes("disabled")).toBeDefined();
});

it("validates time ranges before querying and clears all criteria", async () => {
  wrapper = mount(HistoryFilters, {
    props: { kind: "audit", filters: emptyHistoryFilters(), devices: [] },
  });
  const times = wrapper.findAll('input[type="datetime-local"]');
  await times[0]!.setValue("2026-10-16T12:00");
  await times[1]!.setValue("2026-10-15T12:00");
  await wrapper.get("form").trigger("submit");
  expect(wrapper.emitted("apply")).toBeUndefined();
  expect(wrapper.text()).toContain("结束时间不能早于开始时间");
  await button("重置条件").trigger("click");
  expect(wrapper.emitted("apply")).toEqual([[emptyHistoryFilters()]]);
});

it("does not let a list refresh replace a pending task selection", async () => {
  let resolve!: (value: unknown) => void;
  const request = await setup(
    () => ({
      tasks: [task("first"), task("second")],
      page: { limit: 50, has_more: false, next_cursor: null },
    }),
    (id) =>
      id === "second"
        ? new Promise((done) => {
            resolve = done;
          })
        : task(id),
  );
  await wrapper.findAll(".task-link")[0]!.trigger("click");
  await flushPromises();
  await wrapper.findAll(".task-link")[1]!.trigger("click");
  await flushPromises();
  await button("↻ 刷新").trigger("click");
  await flushPromises();
  expect(
    request.mock.calls.filter(([path]) => path === "/tasks/first"),
  ).toHaveLength(1);
  resolve(task("second"));
  await flushPromises();
  expect(wrapper.get(".task-detail").text()).toContain("second");
});
