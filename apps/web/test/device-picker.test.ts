import { afterEach, expect, it, vi } from "vitest";
import { mount, flushPromises, type VueWrapper } from "@vue/test-utils";
import DevicePicker from "../src/components/DevicePicker.vue";
import { api, ApiError } from "../src/api/client";
const rows = Array.from({ length: 80 }, (_, i) => ({
  id: `d${i}`,
  name: `设备 ${i}`,
  connection_kind: "agent",
  revoked_at: null,
}));
let wrapper: VueWrapper<any> | undefined;
afterEach(() => {
  wrapper?.unmount();
  wrapper = undefined;
  vi.restoreAllMocks();
  vi.useRealTimers();
});
function response(path: string) {
  const params = new URLSearchParams(path.split("?")[1]);
  const ids = params.has("ids")
    ? (JSON.parse(params.get("ids")!) as string[])
    : null;
  const filtered = rows.filter(
    (d) =>
      (!ids || ids.includes(d.id)) &&
      (!params.get("q") || d.name.includes(params.get("q")!)) &&
      (!params.get("group") || d.id === "d79"),
  );
  const limit = Number(params.get("limit") ?? 50),
    pages = Math.max(1, Math.ceil(filtered.length / limit)),
    number = Math.min(Number(params.get("page") ?? 1), pages);
  return {
    v: 1,
    devices: filtered.slice((number - 1) * limit, number * limit),
    page: {
      number,
      limit,
      pages,
      total: filtered.length,
      visible_total: 80,
      groups: [{ id: "tail", name: "末页组" }],
    },
  };
}
function setup(
  extra: (path: string) => unknown = () => undefined,
  props: Record<string, unknown> = {},
) {
  const request = vi
    .spyOn(api, "request")
    .mockImplementation(async (path) => extra(path) ?? response(path));
  wrapper = mount(DevicePicker, {
    props: {
      modelValue: ["d79"],
      label: "测试设备",
      ...props,
      "onUpdate:modelValue": (ids) => {
        void wrapper!.setProps({ modelValue: ids });
      },
    },
  });
  return request;
}
async function click(text: string) {
  await wrapper!
    .findAll("button")
    .find((b) => b.text() === text)!
    .trigger("click");
  await flushPromises();
}
it("loads only on demand, selects the current page and preserves other pages across search and selected-only views", async () => {
  const request = setup();
  expect(request).not.toHaveBeenCalled();
  await click("选择测试设备");
  expect(wrapper!.findAll(".picker-options input")).toHaveLength(25);
  await wrapper!.get('[aria-label="选择当前页测试设备"]').setValue(true);
  await click("下一页");
  expect(wrapper!.text()).toContain("已选 26 台");
  await wrapper!.get('[aria-label="测试设备 设备 25"]').setValue(true);
  await wrapper!.get('[aria-label="选择当前页测试设备"]').setValue(true);
  await wrapper!.get('[aria-label="选择当前页测试设备"]').setValue(false);
  expect(wrapper!.props("modelValue")).toHaveLength(26);
  await wrapper!.get('[aria-label="测试设备分组"]').setValue("tail");
  await flushPromises();
  expect(
    wrapper!.get<HTMLInputElement>('[aria-label="测试设备 设备 79"]').element
      .checked,
  ).toBe(true);
  await wrapper!.get('[aria-label="仅看已选测试设备"]').setValue(true);
  await flushPromises();
  expect(wrapper!.text()).toContain("第 1 / 2 页");
  await wrapper!.get('[aria-label="移除已选 设备 79"]').setValue(false);
  await flushPromises();
  expect(wrapper!.props("modelValue")).not.toContain("d79");
  expect(wrapper!.props("modelValue")).toHaveLength(25);
  expect(
    request.mock.calls.every(([p]) => p.startsWith("/device-options?")),
  ).toBe(true);
});
it("ignores late pages after a new server search and keeps the explicit selection", async () => {
  vi.useFakeTimers();
  let resolve!: (value: unknown) => void;
  const request = setup((path) =>
    path.includes("page=2")
      ? new Promise((done) => {
          resolve = done;
        })
      : undefined,
  );
  await click("选择测试设备");
  await click("下一页");
  await wrapper!.get('[aria-label="测试设备搜索"]').setValue("设备 79");
  await vi.advanceTimersByTimeAsync(300);
  await flushPromises();
  resolve(response("/device-options?page=2&limit=25"));
  await flushPromises();
  expect(wrapper!.findAll(".picker-options input")).toHaveLength(1);
  expect(
    wrapper!.get<HTMLInputElement>('[aria-label="测试设备 设备 79"]').element
      .checked,
  ).toBe(true);
  expect(request.mock.calls.some(([p]) => p.includes("q="))).toBe(true);
});
it("retains unavailable selected IDs and offers explicit removal without exposing out-of-scope labels", async () => {
  setup(undefined, { modelValue: ["no-longer-visible"] });
  await click("选择测试设备");
  await wrapper!.get('[aria-label="仅看已选测试设备"]').setValue(true);
  await flushPromises();
  expect(wrapper!.text()).toContain("当前不可见或不可用");
  expect(wrapper!.props("modelValue")).toEqual(["no-longer-visible"]);
  await wrapper!
    .get('[aria-label="移除已选 no-longer-visible"]')
    .setValue(false);
  await flushPromises();
  expect(wrapper!.props("modelValue")).toEqual([]);
});
it("resolves one initial selection by ID, keeps it across pages and selects only one execution target", async () => {
  const request = setup(undefined, { multiple: false, purpose: "exec" });
  await flushPromises();
  expect(request.mock.calls[0]![0]).toContain("purpose=exec&ids=");
  expect(wrapper!.text()).toContain("设备 79");
  await click("选择测试设备");
  await click("下一页");
  await wrapper!.get('[aria-label="测试设备 设备 25"]').setValue(true);
  await flushPromises();
  expect(wrapper!.props("modelValue")).toEqual(["d25"]);
});
it("bounds selection, retains IDs on denied reads and does not fetch after closing a pending search", async () => {
  vi.useFakeTimers();
  let denied = false;
  const request = setup(
    () => {
      if (denied) throw new ApiError("forbidden", 403);
    },
    { max: 1 },
  );
  await click("选择测试设备");
  await wrapper!.get('[aria-label="测试设备 设备 0"]').setValue(true);
  expect(wrapper!.text()).toContain("最多选择 1 台");
  expect(
    wrapper!.get<HTMLInputElement>('[aria-label="测试设备 设备 0"]').element
      .checked,
  ).toBe(false);
  expect(wrapper!.props("modelValue")).toEqual(["d79"]);
  denied = true;
  await click("下一页");
  expect(wrapper!.text()).toContain("已有选择已保留");
  expect(wrapper!.findAll(".picker-options input")).toHaveLength(0);
  await wrapper!.get('[aria-label="测试设备搜索"]').setValue("later");
  await click("收起测试设备");
  request.mockClear();
  await vi.advanceTimersByTimeAsync(500);
  expect(request).not.toHaveBeenCalled();
});
