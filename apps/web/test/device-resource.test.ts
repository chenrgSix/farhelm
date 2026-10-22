import { afterEach, expect, it, vi } from "vitest";
import { mount } from "@vue/test-utils";
import { ref } from "vue";
import { api, ApiError } from "../src/api/client";
import { useDeviceResource } from "../src/composables/useDeviceResource";

afterEach(() => vi.restoreAllMocks());
it("coalesces refreshes and ignores responses from a previous device or disposed page", async () => {
  const id = ref<string | null>("first");
  let resource!: ReturnType<typeof useDeviceResource>;
  const wrapper = mount({
    setup() {
      resource = useDeviceResource(id);
      return () => null;
    },
  });
  const replies: ((v: unknown) => void)[] = [];
  const request = vi
    .spyOn(api, "request")
    .mockImplementation(() => new Promise((resolve) => replies.push(resolve)));
  const first = resource.load();
  expect(resource.load()).toBe(first);
  id.value = "second";
  const second = resource.load();
  replies[1]!({ id: "second", name: "新设备" });
  await second;
  replies[0]!({ id: "first", name: "旧设备" });
  await first;
  expect(resource.device.value?.id).toBe("second");
  expect(request).toHaveBeenCalledTimes(2);
  const late = resource.load();
  wrapper.unmount();
  replies[2]!({ id: "second" });
  await late;
  expect(resource.device.value).toBeUndefined();
});

it("keeps data on network failures but removes it when permission is revoked", async () => {
  const id = ref<string | null>("device");
  let resource!: ReturnType<typeof useDeviceResource>;
  const wrapper = mount({
    setup() {
      resource = useDeviceResource(id);
      return () => null;
    },
  });
  vi.spyOn(api, "request")
    .mockResolvedValueOnce({ id: "device" })
    .mockRejectedValueOnce(new Error("offline"))
    .mockRejectedValueOnce(new ApiError("forbidden", 403));
  await resource.load();
  await resource.load();
  expect(resource.device.value?.id).toBe("device");
  expect(resource.error.value).toBe("offline");
  await resource.load();
  expect(resource.device.value).toBeUndefined();
  wrapper.unmount();
});
