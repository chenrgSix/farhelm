import { computed, ref } from "vue";
import { useListResource } from "./useListResource";

export const emptyHistoryFilters = () => ({
  q: "",
  device_id: "",
  actor_id: "",
  status: "",
  action: "",
  from: "",
  to: "",
});
export type HistoryFilters = ReturnType<typeof emptyHistoryFilters>;

export function useHistoryList<T>(path: string, field: string) {
  const filters = ref(emptyHistoryFilters());
  const cursor = ref<string | null>(null);
  const previous = ref<(string | null)[]>([]);
  const resource = useListResource<T>(() => {
    const params = new URLSearchParams({ limit: "50" });
    for (const [key, value] of Object.entries(filters.value))
      if (value)
        params.set(
          key,
          key === "from" || key === "to"
            ? String(new Date(value).getTime())
            : value,
        );
    if (cursor.value) params.set("cursor", cursor.value);
    return `${path}?${params}`;
  }, field);
  const number = computed(() => previous.value.length + 1);
  const filtered = computed(() => Object.values(filters.value).some(Boolean));
  function apply(value: HistoryFilters) {
    filters.value = { ...value };
    cursor.value = null;
    previous.value = [];
    resource.reset();
    void resource.load();
  }
  function next() {
    if (resource.loading.value || !resource.page.value?.next_cursor) return;
    previous.value.push(cursor.value);
    cursor.value = resource.page.value.next_cursor;
    resource.reset();
    void resource.load();
  }
  function back() {
    if (resource.loading.value || !previous.value.length) return;
    cursor.value = previous.value.pop()!;
    resource.reset();
    void resource.load();
  }
  function first() {
    if (resource.loading.value) return;
    cursor.value = null;
    previous.value = [];
    resource.reset();
    void resource.load();
  }
  function reset() {
    filters.value = emptyHistoryFilters();
    cursor.value = null;
    previous.value = [];
    resource.reset();
  }
  return {
    resource,
    filters,
    number,
    filtered,
    apply,
    next,
    back,
    first,
    reset,
  };
}
