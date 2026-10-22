import { afterEach, expect, it, vi } from "vitest";
import { mount, flushPromises } from "@vue/test-utils";
import { useTaskSummary } from "../src/composables/useTaskSummary";
import { api, ApiError } from "../src/api/client";
afterEach(() => vi.restoreAllMocks());
it("coalesces reads, isolates late responses after reset and clears unauthorized counts", async () => {
  let resource!: ReturnType<typeof useTaskSummary>, done!: (v: unknown) => void;
  const request = vi.spyOn(api, "request").mockImplementationOnce(
    () =>
      new Promise((resolve) => {
        done = resolve;
      }) as any,
  );
  const wrapper = mount({
    setup() {
      resource = useTaskSummary();
      return () => null;
    },
  });
  const pending = resource.load();
  void resource.load();
  expect(request).toHaveBeenCalledTimes(1);
  resource.reset();
  request.mockResolvedValueOnce({ v: 1, active: 2, unknown: 1 });
  await resource.load();
  done({ v: 1, active: 999, unknown: 999 });
  await pending;
  await flushPromises();
  expect(resource.data.value?.active).toBe(2);
  request.mockRejectedValueOnce(new ApiError("forbidden", 403));
  await resource.load();
  expect(resource.data.value).toBeUndefined();
  expect(resource.error.value).toContain("forbidden");
  wrapper.unmount();
});
