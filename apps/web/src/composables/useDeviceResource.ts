import { onBeforeUnmount, ref, shallowRef, watch, type Ref } from "vue";
import { api, ApiError } from "../api/client";
import type { Device } from "../api/types";

export function useDeviceResource(id: Ref<string | null>) {
  const device = shallowRef<Device>();
  const loading = ref(false);
  const error = ref("");
  const updatedAt = ref<number | null>(null);
  let generation = 0;
  let running: Promise<void> | undefined;
  function reset() {
    generation++;
    running = undefined;
    device.value = undefined;
    loading.value = false;
    error.value = "";
    updatedAt.value = null;
  }
  function load(): Promise<void> {
    if (!id.value) return Promise.resolve();
    if (running) return running;
    const current = generation,
      deviceId = id.value;
    loading.value = true;
    running = (async () => {
      try {
        const value = await api.request<Device>(
          `/devices/${encodeURIComponent(deviceId)}`,
        );
        if (current !== generation) return;
        if (value.id !== deviceId) throw Error("设备详情响应不匹配");
        device.value = value;
        error.value = "";
        updatedAt.value = Date.now();
      } catch (e) {
        if (current !== generation) return;
        if (e instanceof ApiError && [401, 403, 404].includes(e.status))
          device.value = undefined;
        error.value = e instanceof Error ? e.message : "读取设备失败";
      } finally {
        if (current === generation) {
          loading.value = false;
          running = undefined;
        }
      }
    })();
    return running;
  }
  watch(id, reset, { flush: "sync" });
  onBeforeUnmount(reset);
  return { device, loading, error, updatedAt, load, reset };
}
