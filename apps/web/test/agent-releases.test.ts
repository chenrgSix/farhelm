import { afterEach, expect, it, vi } from "vitest";
import { mount, flushPromises } from "@vue/test-utils";
import AgentReleasePanel from "../src/components/AgentReleasePanel.vue";
import { api, ApiError } from "../src/api/client";
afterEach(() => vi.restoreAllMocks());
const manifest = {
  version: "0.3.0",
  arch: "aarch64",
  sha256: "a".repeat(64),
  size: 128,
  upgrade_protocol: 1,
};
const release = {
  version: manifest.version,
  arch: manifest.arch,
  sha256: manifest.sha256,
  size: 128,
  enabled: true,
  source: "upload",
  created_at: 1,
};
async function choose(w: ReturnType<typeof mount>, index: number, file: File) {
  const input = w.findAll('input[type="file"]')[index]!;
  Object.defineProperty(input.element, "files", {
    configurable: true,
    value: [file],
  });
  await input.trigger("change");
  await flushPromises();
}
const jsonFile = (body: unknown) => {
  const file = new File([JSON.stringify(body)], "agent.json");
  Object.defineProperty(file, "text", {
    value: async () => JSON.stringify(body),
  });
  return file;
};
it("reads manifest, uploads raw file and exact metadata once, then refreshes versions", async () => {
  vi.spyOn(api, "request").mockResolvedValue({ releases: [] });
  let resolve!: (v: any) => void;
  const upload = vi
    .spyOn(api, "upload")
    .mockImplementation(() => new Promise((r) => (resolve = r)));
  const w = mount(AgentReleasePanel);
  await flushPromises();
  const binary = new File([new Uint8Array(128)], "agent-linux-aarch64");
  await choose(w, 0, jsonFile(manifest));
  await choose(w, 1, binary);
  expect(w.text()).toContain("v0.3.0 · aarch64");
  await w.get("form").trigger("submit");
  await w.get("form").trigger("submit");
  expect(upload).toHaveBeenCalledTimes(1);
  expect(upload).toHaveBeenCalledWith(
    "/agent-releases/" + manifest.sha256,
    binary,
    manifest,
  );
  resolve({ v: 1, release });
  await flushPromises();
  expect(w.emitted("changed")).toHaveLength(1);
  expect(w.text()).toContain("已保存");
  w.unmount();
});
it("rejects invalid manifests and mismatched sizes before uploading; lost responses allow the same safe retry", async () => {
  vi.spyOn(api, "request").mockResolvedValue({ releases: [] });
  const upload = vi
    .spyOn(api, "upload")
    .mockRejectedValueOnce(new ApiError("lost", 0))
    .mockResolvedValue({ release });
  const w = mount(AgentReleasePanel);
  await flushPromises();
  await choose(w, 0, jsonFile({ ...manifest, arch: "other" }));
  expect(w.text()).toContain("版本清单无效");
  await choose(w, 0, jsonFile(manifest));
  await choose(w, 1, new File(["short"], "agent"));
  await w.get("form").trigger("submit");
  expect(w.text()).toContain("大小与版本清单不一致");
  expect(upload).not.toHaveBeenCalled();
  await choose(w, 1, new File([new Uint8Array(128)], "agent"));
  await w.get("form").trigger("submit");
  await flushPromises();
  expect(w.text()).toContain("上传结果未确认");
  await w.get("form").trigger("submit");
  await flushPromises();
  expect(upload).toHaveBeenCalledTimes(2);
  expect(upload.mock.calls[0]).toEqual(upload.mock.calls[1]);
  w.unmount();
});
it("disables a release with an explicit desired state and refreshes after uncertainty", async () => {
  const request = vi
    .spyOn(api, "request")
    .mockResolvedValueOnce({ releases: [release] })
    .mockRejectedValueOnce(new ApiError("lost", 0))
    .mockResolvedValueOnce({ releases: [{ ...release, enabled: false }] });
  const w = mount(AgentReleasePanel);
  await flushPromises();
  await w.get('[aria-label="停用 0.3.0 aarch64"]').trigger("click");
  await flushPromises();
  expect(request.mock.calls[1]).toEqual([
    "/agent-releases/" + manifest.sha256,
    { method: "POST", body: { v: 1, enabled: false } },
  ]);
  expect(w.find('[aria-label="启用 0.3.0 aarch64"]').exists()).toBe(true);
  w.unmount();
});
