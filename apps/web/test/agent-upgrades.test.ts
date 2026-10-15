import { afterEach, expect, it, vi } from "vitest";
import { mount, flushPromises } from "@vue/test-utils";
import AgentUpgradePanel from "../src/components/AgentUpgradePanel.vue";
import { api, ApiError } from "../src/api/client";
afterEach(() => {
  vi.restoreAllMocks();
  vi.useRealTimers();
});
const release = {
  arch: "aarch64",
  version: "0.2.1",
  sha256: "b".repeat(64),
  size: 128,
};
const snapshot = {
  v: 1,
  releases: [release],
  devices: [
    {
      device_id: "one",
      name: "在线设备",
      version: "0.2.0",
      arch: "aarch64",
      sha256: "a".repeat(64),
      supported: true,
      online: true,
    },
    {
      device_id: "offline",
      name: "离线设备",
      version: "0.2.0",
      arch: "aarch64",
      sha256: "a".repeat(64),
      supported: true,
      online: false,
    },
    {
      device_id: "legacy",
      name: "旧设备",
      version: "0.1.0",
      arch: null,
      sha256: null,
      supported: false,
      online: true,
    },
  ],
  jobs: [],
};
it("selects capable devices including offline ones and submits one batch with bounded concurrency", async () => {
  const request = vi.spyOn(api, "request").mockResolvedValue(snapshot);
  const w = mount(AgentUpgradePanel, {
    global: { stubs: { AgentReleasePanel: true } },
  });
  await flushPromises();
  expect(
    w.get('[aria-label="选择 旧设备"]').attributes("disabled"),
  ).toBeDefined();
  expect(w.text()).toContain("需先更新基础版本");
  await w.get('input[type="checkbox"]').setValue(true);
  await w.get('[aria-label="同时升级数量"]').setValue("1");
  await w.get("form").trigger("submit");
  await flushPromises();
  const post = request.mock.calls.find((c) => c[1]?.method === "POST")!;
  expect(post[1]?.body).toMatchObject({
    v: 1,
    concurrency: 1,
    targets: [
      { device_id: "one", sha256: release.sha256 },
      { device_id: "offline", sha256: release.sha256 },
    ],
  });
  expect(w.text()).toContain("共 2 台");
  w.unmount();
});
it("retries a lost response with exactly the same batch id and stops polling after unmount", async () => {
  vi.useFakeTimers();
  const posts: unknown[] = [];
  const request = vi
    .spyOn(api, "request")
    .mockImplementation(async (_path, options) => {
      if (options?.method === "POST") {
        posts.push(options.body);
        if (posts.length === 1) throw new ApiError("lost", 0);
        return { v: 1, batch_id: (options.body as any).request_id } as any;
      }
      return snapshot as any;
    });
  const w = mount(AgentUpgradePanel, {
    global: { stubs: { AgentReleasePanel: true } },
  });
  await flushPromises();
  await w.get('[aria-label="选择 在线设备"]').setValue(true);
  await w.get("form").trigger("submit");
  await flushPromises();
  expect(w.text()).toContain("核对原批次");
  expect(w.get("fieldset").attributes("disabled")).toBeDefined();
  await w.get("form").trigger("submit");
  await flushPromises();
  expect(posts).toHaveLength(2);
  expect(posts[0]).toEqual(posts[1]);
  w.unmount();
  const count = request.mock.calls.length;
  await vi.advanceTimersByTimeAsync(6000);
  expect(request).toHaveBeenCalledTimes(count);
});
it("excludes devices newer than the published release from bulk selection", async () => {
  const value = structuredClone(snapshot);
  value.devices[0]!.version = "0.3.0";
  vi.spyOn(api, "request").mockResolvedValue(value);
  const w = mount(AgentUpgradePanel, {
    global: { stubs: { AgentReleasePanel: true } },
  });
  await flushPromises();
  expect(
    w.get('[aria-label="选择 在线设备"]').attributes("disabled"),
  ).toBeDefined();
  expect(w.text()).toContain("当前版本高于目标版本");
  w.unmount();
});
it("selects an explicit older release and clears selection when the target changes or lacks an architecture", async () => {
  const value = structuredClone(snapshot);
  value.releases.push({ ...release, version: "0.2.2", sha256: "c".repeat(64) });
  const request = vi.spyOn(api, "request").mockResolvedValue(value);
  const w = mount(AgentUpgradePanel, {
    global: { stubs: { AgentReleasePanel: true } },
  });
  await flushPromises();
  const picker = w.get(".target-version select");
  expect((picker.element as HTMLSelectElement).value).toBe("0.2.2");
  await w.get('[aria-label="选择 在线设备"]').setValue(true);
  await picker.setValue("0.2.1");
  expect(
    (w.get('[aria-label="选择 在线设备"]').element as HTMLInputElement).checked,
  ).toBe(false);
  await w.get('[aria-label="选择 在线设备"]').setValue(true);
  await w.get("form").trigger("submit");
  await flushPromises();
  expect(
    (request.mock.calls.find((c) => c[1]?.method === "POST")![1]?.body as any)
      .targets[0].sha256,
  ).toBe(release.sha256);
  w.unmount();
});
