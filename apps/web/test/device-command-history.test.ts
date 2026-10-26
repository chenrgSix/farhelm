import { afterEach, expect, it, vi } from "vitest";
import { mount, flushPromises, type VueWrapper } from "@vue/test-utils";
import DeviceCommandHistory from "../src/components/DeviceCommandHistory.vue";
import { api } from "../src/api/client";
let wrapper: VueWrapper;
afterEach(() => {
  wrapper?.unmount();
  vi.restoreAllMocks();
});
function setup() {
  wrapper = mount(DeviceCommandHistory, {
    props: { deviceId: "one", deviceName: "主机" },
  });
}
async function dates(from = "2026-10-01T10:00", to = "2026-10-08T10:00") {
  const inputs = wrapper.findAll('input[type="datetime-local"]');
  await inputs[0]!.setValue(from);
  await inputs[1]!.setValue(to);
}
const button = (label: string) =>
  wrapper.findAll("button").find((b) => b.text() === label)!;
it("does not query on entry and refuses missing, reversed or over-seven-day ranges", async () => {
  const request = vi.spyOn(api, "request");
  setup();
  await flushPromises();
  expect(request).not.toHaveBeenCalled();
  expect(button("查询命令").attributes("disabled")).toBeDefined();
  await wrapper.get("form").trigger("submit");
  expect(request).not.toHaveBeenCalled();
  await dates("2026-10-01T10:00", "2026-10-08T10:01");
  expect(wrapper.text()).toContain("不能超过 7 天");
  await wrapper.get("form").trigger("submit");
  expect(request).not.toHaveBeenCalled();
  await dates("2026-10-08T10:00", "2026-10-01T10:00");
  expect(button("查询命令").attributes("disabled")).toBeDefined();
});
it("queries literal fuzzy filters with required dates, pages and links to the correct recording position", async () => {
  const session = {
    id: "session",
    device_id: "one",
    cols: 80,
    rows: 24,
    last_seq: 9,
  };
  const row = {
    id: 1,
    session_id: "session",
    actor_username: "alice",
    command: "docker ps",
    started_at: 1,
    ended_at: 2,
    exit_code: 0,
    recording_seq: 5,
    transport: "ssh",
    session_status: "CLOSED",
  };
  const request = vi.spyOn(api, "request").mockImplementation(async (path) =>
    path.startsWith("/terminal-sessions/")
      ? { session }
      : {
          commands: [row],
          page: { next_cursor: path.includes("cursor=") ? null : "next" },
        },
  );
  setup();
  await dates();
  await wrapper.get('input[type="search"]').setValue("docker 100%_");
  await wrapper.get('input[maxlength="128"]').setValue("alice");
  await wrapper.get("form").trigger("submit");
  await flushPromises();
  const url = request.mock.calls[0]![0];
  const q = new URLSearchParams(url.split("?")[1]);
  expect(q.get("q")).toBe("docker 100%_");
  expect(q.get("actor")).toBe("alice");
  expect(q.get("limit")).toBe("50");
  expect(Number(q.get("to")) - Number(q.get("from"))).toBe(604800000);
  await button("下一页").trigger("click");
  await flushPromises();
  expect(request.mock.calls.at(-1)![0]).toContain("cursor=next");
  await button("上一页").trigger("click");
  await flushPromises();
  expect(request.mock.calls.at(-1)![0]).not.toContain("cursor=");
  await button("定位回放").trigger("click");
  await flushPromises();
  expect(wrapper.emitted("replay")).toEqual([[session, 5]]);
  await wrapper.get('input[type="search"]').setValue("new");
  expect(wrapper.find("table").exists()).toBe(false);
});
it("drops a late response after filters or device change", async () => {
  let resolve!: (value: any) => void;
  vi.spyOn(api, "request").mockImplementation(
    () =>
      new Promise((r) => {
        resolve = r;
      }),
  );
  setup();
  await dates();
  await wrapper.get("form").trigger("submit");
  await wrapper.setProps({ deviceId: "two" });
  resolve({
    commands: [{ id: 1, command: "previous-device" }],
    page: { next_cursor: null },
  });
  await flushPromises();
  expect(wrapper.text()).not.toContain("previous-device");
});
