import { onBeforeUnmount, ref, shallowRef } from "vue";
import { api } from "../api/client";

/** Each list keeps its own last successful data and refresh status. */
export function useListResource<T>(
  path: string | (() => string),
  field: string,
) {
  const items = shallowRef<T[]>([]);
  const loading = ref(false);
  const error = ref("");
  const updatedAt = ref<number | null>(null);
  let generation = 0;
  let pending = false;
  let running: Promise<void> | undefined;

  function reset() {
    generation++;
    pending = false;
    running = undefined;
    items.value = [];
    loading.value = false;
    error.value = "";
    updatedAt.value = null;
  }

  function load(): Promise<void> {
    if (running) {
      pending = true;
      return running;
    }
    const current = generation;
    loading.value = true;
    running = (async () => {
      do {
        pending = false;
        try {
          const response = await api.request<Record<string, T[]>>(
            typeof path === "function" ? path() : path,
          );
          if (current !== generation) return;
          if (!Array.isArray(response[field]))
            throw new Error("API 列表响应格式错误");
          items.value = response[field];
          updatedAt.value = Date.now();
          error.value = "";
        } catch (e) {
          if (current !== generation) return;
          error.value = e instanceof Error ? e.message : "刷新失败";
        }
      } while (pending);
    })().finally(() => {
      if (current === generation) {
        loading.value = false;
        running = undefined;
      }
    });
    return running;
  }

  onBeforeUnmount(reset);
  return { items, loading, error, updatedAt, load, reset };
}
