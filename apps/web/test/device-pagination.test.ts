import { afterEach, expect, it, vi } from "vitest";
import { mount, flushPromises, type VueWrapper } from "@vue/test-utils";
import App from "../src/App.vue";
import DeviceGroupTools from "../src/components/DeviceGroupTools.vue";
import { api } from "../src/api/client";
import { writeTabSession } from "../src/tab-session";

const admin = {
  id: "admin",
  username: "admin",
  role: "admin",
  device_scope: "*",
};
const rows = Array.from({ length: 120 }, (_, i) => ({
  id: `d${i}`,
  name: `Device ${i}`,
  control_online: false,
  revoked_at: null,
  last_seen: null,
  agent_version: null,
  business_healthy: null,
  private_data_reachable: null,
  device_groups: i === 119 ? [{ id: "last", name: "末页组" }] : [],
}));
let wrapper: VueWrapper | undefined;
afterEach(() => {
  wrapper?.unmount();
  wrapper = undefined;
  vi.restoreAllMocks();
  vi.useRealTimers();
  api.setToken(null);
  sessionStorage.clear();
  window.history.replaceState(null, "", "/");
});
async function setup(extra: (path: string) => unknown = () => undefined) {
  const request = vi.spyOn(api, "request").mockImplementation(async (path) => {
    const custom = extra(path);
    if (custom !== undefined) return custom;
    if (path === "/me") return admin;
    if (path.startsWith("/devices?")) {
      const p = new URLSearchParams(path.split("?")[1]);
      const filtered = rows.filter(
        (d) =>
          (!p.get("q") || d.name.includes(p.get("q")!)) &&
          (!p.get("group") ||
            d.device_groups.some((g) => g.id === p.get("group"))),
      );
      const limit = Number(p.get("limit")),
        pages = Math.max(1, Math.ceil(filtered.length / limit));
      const number = Math.min(Number(p.get("page")), pages);
      return {
        devices: filtered.slice((number - 1) * limit, number * limit),
        page: {
          number,
          limit,
          total: filtered.length,
          pages,
          visible_total: 120,
          groups: [{ id: "last", name: "末页组" }],
        },
      };
    }
    if (path === "/tasks") return { tasks: [] };
    if (path === "/device-groups") return { device_groups: [] };
    throw new Error(`Unexpected request: ${path}`);
  });
  writeTabSession({ token: "fixture", view: "devices" });
  wrapper = mount(App, { global: { stubs: { Teleport: true } } });
  await flushPromises();
  return request;
}
async function click(label: string) {
  await wrapper!
    .findAll("button")
    .find((b) => b.text() === label)!
    .trigger("click");
  await flushPromises();
}
it("selects only the current page, retains cross-page selections through refresh/filters and clears explicitly", async () => {
  const request = await setup();
  expect(wrapper!.findAll("tbody tr")).toHaveLength(50);
  expect(
    request.mock.calls.some(
      ([p]) => p === "/devices" || p === "/device-groups",
    ),
  ).toBe(false);
  expect(wrapper!.get('[aria-label="按设备组筛选"]').text()).toContain(
    "末页组",
  );
  await wrapper!.get('[aria-label="选择当前页设备"]').setValue(true);
  await click("下一页");
  expect(wrapper!.text()).toContain("50 台不在当前页");
  await wrapper!.get('[aria-label="选择设备 Device 50"]').setValue(true);
  await wrapper!.get('[aria-label="选择当前页设备"]').setValue(true);
  expect(wrapper!.text()).toContain("已选 100 台");
  await wrapper!.get('[aria-label="选择当前页设备"]').setValue(false);
  expect(wrapper!.text()).toContain("已选 50 台");
  await click("↻ 刷新");
  expect(wrapper!.text()).toContain("已选 50 台");
  await wrapper!.get('[aria-label="按设备组筛选"]').setValue("last");
  await flushPromises();
  expect(wrapper!.text()).toContain("第 1 / 1 页 · 共 1 台");
  expect(wrapper!.text()).toContain("已选 50 台");
  await wrapper!.get('[aria-label="选择设备 Device 119"]').setValue(true);
  await click("添加标签");
  expect(wrapper!.text()).toContain("对跨页已选的全部 51 台设备");
  await click("关闭设备组窗口");
  await click("清空选择");
  expect(wrapper!.text()).toContain("已选 0 台");
});
it("debounces server search, invalidates late page responses and resets selection when authorization changes", async () => {
  vi.useFakeTimers();
  let late!: (v: unknown) => void,
    restrict = false;
  const request = await setup((path) => {
    if (path === "/me" && restrict)
      return { ...admin, role: "ops", device_scope: [] };
    if (path === "/devices?page=2&limit=50")
      return new Promise((resolve) => {
        late = resolve;
      });
  });
  await wrapper!.get('[aria-label="选择设备 Device 0"]').setValue(true);
  await click("下一页");
  request.mockClear();
  await wrapper!.get('[aria-label="筛选当前列表"]').setValue("Device 119");
  await vi.advanceTimersByTimeAsync(299);
  expect(request).not.toHaveBeenCalled();
  await vi.advanceTimersByTimeAsync(1);
  await flushPromises();
  expect(request).toHaveBeenCalledWith("/devices?page=1&limit=50&q=Device+119");
  late({
    devices: [rows[50]],
    page: {
      number: 2,
      limit: 50,
      total: 120,
      pages: 3,
      visible_total: 120,
      groups: [],
    },
  });
  await flushPromises();
  expect(wrapper!.findAll("tbody tr")).toHaveLength(1);
  expect(wrapper!.text()).not.toContain("Device 50");
  expect(wrapper!.text()).toContain("已选 1 台");
  restrict = true;
  await click("↻ 刷新");
  expect(wrapper!.text()).toContain("已选 0 台");
  expect(wrapper!.find('[aria-label="选择设备 Device 119"]').exists()).toBe(
    false,
  );
});
it("resets to page one when page size changes", async () => {
  await setup();
  await click("下一页");
  await click("下一页");
  expect(wrapper!.text()).toContain("第 3 / 3 页");
  await wrapper!.get('[aria-label="每页设备数"]').setValue(100);
  await flushPromises();
  expect(wrapper!.findAll("tbody tr")).toHaveLength(100);
  expect(wrapper!.text()).toContain("第 1 / 2 页");
});
it("loads all membership choices only when editing and preserves off-page members", async () => {
  const group = {
    id: "all",
    name: "跨页组",
    description: "",
    revision: 1,
    device_ids: ["d0", "d119"],
  };
  const request = vi
    .spyOn(api, "request")
    .mockImplementation(async (path, options) => {
      if (options) return {} as any;
      if (path === "/devices") return { devices: rows };
      if (path === "/device-groups") return { device_groups: [group] };
      throw Error(path);
    });
  wrapper = mount(DeviceGroupTools, {
    props: {
      devices: rows.slice(0, 50),
      paged: true,
      admin: true,
      selectedIds: [],
      visibleIds: [],
      filter: "",
    },
    global: { stubs: { Teleport: true } },
  });
  expect(request).not.toHaveBeenCalled();
  await click("管理设备组");
  await wrapper!.get('[aria-label="编辑设备组 跨页组"]').trigger("click");
  await flushPromises();
  expect(
    wrapper!.get<HTMLInputElement>('[aria-label="组内设备 Device 119"]').element
      .checked,
  ).toBe(true);
  await wrapper!.get('[aria-label="组内设备 Device 0"]').setValue(false);
  await wrapper!.get("form").trigger("submit");
  await flushPromises();
  expect(request).toHaveBeenCalledWith("/device-groups/all", {
    method: "PUT",
    body: {
      v: 1,
      revision: 1,
      name: "跨页组",
      description: "",
      device_ids: ["d119"],
    },
  });
});

it("blocks group writes if complete membership choices fail to load", async () => {
  const request = vi.spyOn(api, "request").mockImplementation(async (path) => {
    if (path === "/device-groups") return { device_groups: [] };
    throw new Error("完整设备列表读取失败");
  });
  wrapper = mount(DeviceGroupTools, {
    props: {
      devices: rows.slice(0, 50),
      paged: true,
      admin: true,
      selectedIds: [],
      visibleIds: [],
      filter: "",
    },
    global: { stubs: { Teleport: true } },
  });
  await click("管理设备组");
  await click("创建设备组");
  expect(wrapper.text()).toContain("完整设备列表读取失败");
  expect(
    wrapper.get('button[type="submit"]').attributes("disabled"),
  ).toBeDefined();
  await wrapper.get("form").trigger("submit");
  expect(request.mock.calls.every(([, options]) => !options)).toBe(true);
});
