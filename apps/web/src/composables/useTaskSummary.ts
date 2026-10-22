import { onBeforeUnmount, ref, shallowRef } from "vue";
import { api, ApiError } from "../api/client";

type TaskSummary = { v: 1; active: number; unknown: number };
export function useTaskSummary() {
  const data = shallowRef<TaskSummary>();
  const loading = ref(false),
    error = ref("");
  const updatedAt = ref<number | null>(null);
  let generation = 0,
    running: Promise<void> | undefined;
  function reset() {
    generation++;
    running = undefined;
    data.value = undefined;
    loading.value = false;
    error.value = "";
    updatedAt.value = null;
  }
  function load(): Promise<void> {
    if (running) return running;
    const current = generation;
    loading.value = true;
    running = (async () => {
      try {
        const value = await api.request<TaskSummary>("/tasks/summary");
        if (current !== generation) return;
        if (
          value.v !== 1 ||
          ![value.active, value.unknown].every(
            (n) => Number.isSafeInteger(n) && n >= 0,
          )
        )
          throw Error("任务统计响应格式错误");
        data.value = value;
        updatedAt.value = Date.now();
        error.value = "";
      } catch (e) {
        if (current !== generation) return;
        if (e instanceof ApiError && [401, 403].includes(e.status))
          data.value = undefined;
        error.value = e instanceof Error ? e.message : "读取任务统计失败";
      } finally {
        if (current === generation) {
          loading.value = false;
          running = undefined;
        }
      }
    })();
    return running;
  }
  onBeforeUnmount(reset);
  return { data, loading, error, updatedAt, load, reset };
}
