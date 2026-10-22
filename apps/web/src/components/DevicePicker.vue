<script setup lang="ts">
import { computed, onBeforeUnmount, ref, watch } from "vue";
import { api } from "../api/client";
import type { DeviceOption, DevicePage } from "../api/types";
import { useListResource } from "../composables/useListResource";

const props = withDefaults(
  defineProps<{
    modelValue: string[];
    label: string;
    multiple?: boolean;
    purpose?: "read" | "exec";
    seed?: DeviceOption[];
    disabled?: boolean;
    max?: number;
    emptyLabel?: string;
  }>(),
  { multiple: true, purpose: "read", max: 1000, emptyLabel: "未选择" },
);
const emit = defineEmits<{ "update:modelValue": [ids: string[]] }>();
const open = ref(false),
  search = ref(""),
  query = ref(""),
  group = ref("");
const number = ref(1),
  selectedOnly = ref(false),
  notice = ref("");
const known = ref<Record<string, DeviceOption>>({});
const groups = ref<DevicePage["groups"]>([]);
const limit = 25;
let timer: ReturnType<typeof setTimeout> | undefined,
  generation = 0,
  disposed = false;
const selectedSlice = computed(() =>
  props.modelValue.slice((number.value - 1) * limit, number.value * limit),
);
const resource = useListResource<DeviceOption, DevicePage>(() => {
  const params = new URLSearchParams({
    page: selectedOnly.value ? "1" : String(number.value),
    limit: String(limit),
    purpose: props.purpose,
  });
  if (selectedOnly.value)
    params.set("ids", JSON.stringify(selectedSlice.value));
  else {
    if (query.value) params.set("q", query.value);
    if (group.value) params.set("group", group.value);
  }
  return `/device-options?${params}`;
}, "devices");
const rows = resource.items;
const pages = computed(() =>
  selectedOnly.value
    ? Math.max(1, Math.ceil(props.modelValue.length / limit))
    : (resource.page.value?.pages ?? 1),
);
const hiddenCount = computed(
  () =>
    props.modelValue.filter((id) => !rows.value.some((d) => d.id === id))
      .length,
);
const allChecked = computed(
  () =>
    !!rows.value.length &&
    rows.value.every((d) => props.modelValue.includes(d.id)),
);
const someChecked = computed(() =>
  rows.value.some((d) => props.modelValue.includes(d.id)),
);
const selectedLabel = computed(() =>
  props.modelValue[0]
    ? (known.value[props.modelValue[0]]?.name ?? props.modelValue[0])
    : props.emptyLabel,
);
watch(
  () => props.seed,
  (values) => {
    for (const value of values ?? []) known.value[value.id] = value;
  },
  { immediate: true },
);
watch(rows, (values) => {
  for (const value of values) known.value[value.id] = value;
});
watch(resource.page, (page) => {
  if (!page) return;
  groups.value = page.groups;
  if (!selectedOnly.value) number.value = page.number;
});
watch(resource.error, (error) => {
  if (error) known.value = {};
});
// Resolve a single initial selection without downloading all devices. Never prune IDs on a partial response.
watch(
  () => props.modelValue[0],
  async (id) => {
    const current = ++generation;
    if (props.multiple || !id || known.value[id]) return;
    try {
      const result = await api.request<{ devices: DeviceOption[] }>(
        `/device-options?purpose=${props.purpose}&ids=${encodeURIComponent(JSON.stringify([id]))}`,
      );
      if (!disposed && current === generation)
        for (const d of result.devices) known.value[d.id] = d;
    } catch {
      /* The opened picker offers an explicit retry; retain the selected ID. */
    }
  },
  { immediate: true },
);
function reload() {
  resource.reset();
  if (open.value) void resource.load();
}
function apply() {
  clearTimeout(timer);
  query.value = search.value.trim();
  number.value = 1;
  reload();
}
watch(search, () => {
  clearTimeout(timer);
  timer = setTimeout(apply, 300);
});
watch([group, selectedOnly], apply);
watch(
  () => props.modelValue,
  () => {
    if (selectedOnly.value && open.value) {
      number.value = Math.min(number.value, pages.value);
      reload();
    }
  },
);
function toggleOpen() {
  if (props.disabled) return;
  open.value = !open.value;
  if (open.value) {
    query.value = search.value.trim();
    number.value = 1;
    reload();
  } else {
    clearTimeout(timer);
    resource.reset();
  }
}
function page(to: number) {
  if (resource.loading.value || props.disabled) return;
  number.value = to;
  reload();
}
function select(ids: string[], checked: boolean) {
  if (props.disabled) return false;
  const next = checked
    ? [...new Set([...props.modelValue, ...ids])]
    : props.modelValue.filter((id) => !ids.includes(id));
  if (checked && props.multiple && next.length > props.max) {
    notice.value = `最多选择 ${props.max} 台设备。`;
    return false;
  }
  notice.value = "";
  emit(
    "update:modelValue",
    props.multiple ? next : checked ? ids.slice(0, 1) : [],
  );
  return true;
}
function change(ids: string[], event: Event) {
  const input = event.target as HTMLInputElement;
  if (!select(ids, input.checked)) {
    input.checked = ids.every((id) => props.modelValue.includes(id));
    input.indeterminate =
      !input.checked && ids.some((id) => props.modelValue.includes(id));
  }
}
onBeforeUnmount(() => {
  disposed = true;
  generation++;
  clearTimeout(timer);
});
</script>

<template>
  <div class="device-picker" role="group" :aria-label="label">
    <div class="picker-heading">
      <button
        type="button"
        class="button secondary small"
        :disabled="disabled"
        :aria-expanded="open"
        @click="toggleOpen"
      >
        {{ open ? "收起" : "选择" }}{{ label }}
      </button>
      <span v-if="multiple" role="status"
        >已选 {{ modelValue.length }} 台<span v-if="open && hiddenCount"
          >（{{ hiddenCount }} 台不在当前页）</span
        ></span
      >
      <span v-else class="picker-selected" role="status">{{
        selectedLabel
      }}</span>
      <button
        v-if="modelValue.length"
        type="button"
        class="text-button"
        :disabled="disabled"
        @click="emit('update:modelValue', [])"
      >
        清空{{ label }}
      </button>
    </div>
    <section v-if="open" class="picker-content">
      <div class="picker-filters">
        <input
          v-model="search"
          type="search"
          maxlength="256"
          placeholder="搜索名称、ID、IP、版本或组名"
          :aria-label="`${label}搜索`"
          :disabled="disabled || selectedOnly"
          @keydown.enter.prevent="apply"
        />
        <select
          v-model="group"
          :aria-label="`${label}分组`"
          :disabled="disabled || selectedOnly"
        >
          <option value="">全部设备组</option>
          <option value="__ungrouped__">未分组</option>
          <option v-for="g in groups" :key="g.id" :value="g.id">
            {{ g.name }}
          </option>
        </select>
        <label v-if="multiple" class="picker-check"
          ><input
            v-model="selectedOnly"
            type="checkbox"
            :disabled="disabled"
            :aria-label="`仅看已选${label}`"
          />仅看已选</label
        >
      </div>
      <p v-if="resource.error.value" role="alert">
        设备选项读取失败：{{ resource.error.value }}。已有选择已保留。<button
          type="button"
          class="text-button"
          @click="reload"
        >
          重试设备选项
        </button>
      </p>
      <p v-if="notice" role="alert">{{ notice }}</p>
      <p v-if="resource.loading.value" role="status">正在读取设备选项…</p>
      <template v-else>
        <label
          v-if="multiple && rows.length && !selectedOnly"
          class="picker-check"
          ><input
            type="checkbox"
            :checked="allChecked"
            :indeterminate="someChecked && !allChecked"
            :disabled="disabled"
            :aria-label="`选择当前页${label}`"
            @change="
              change(
                rows.map((d) => d.id),
                $event,
              )
            "
          />选择当前页</label
        >
        <div class="picker-options">
          <label
            v-for="device in rows"
            v-if="!selectedOnly"
            :key="device.id"
            class="picker-check"
            ><input
              :type="multiple ? 'checkbox' : 'radio'"
              :checked="modelValue.includes(device.id)"
              :disabled="disabled"
              :aria-label="`${label} ${device.name}`"
              @change="change([device.id], $event)"
            /><span
              >{{ device.name
              }}<small
                >{{ device.id
                }}{{ device.revoked_at ? " · 已撤销" : "" }}</small
              ></span
            ></label
          >
          <label
            v-for="id in selectedSlice"
            v-else
            :key="id"
            class="picker-check"
            ><input
              type="checkbox"
              checked
              :disabled="disabled"
              :aria-label="`移除已选 ${known[id]?.name ?? id}`"
              @change="select([id], false)"
            /><span
              >{{ known[id]?.name ?? id
              }}<small v-if="!rows.some((d) => d.id === id)"
                >当前不可见或不可用；可手动移除</small
              ></span
            ></label
          >
        </div>
        <p v-if="!rows.length && !selectedOnly && !resource.error.value">
          没有匹配的设备。
        </p>
      </template>
      <div class="picker-pagination">
        <span
          >第 {{ number }} / {{ pages }} 页 · 每页 {{ limit }} 台<span
            v-if="!selectedOnly && resource.page.value"
          >
            · 共 {{ resource.page.value.total }} 台</span
          ></span
        >
        <button
          type="button"
          class="button secondary small"
          :disabled="disabled || resource.loading.value || number <= 1"
          @click="page(number - 1)"
        >
          上一页
        </button>
        <button
          type="button"
          class="button secondary small"
          :disabled="disabled || resource.loading.value || number >= pages"
          @click="page(number + 1)"
        >
          下一页
        </button>
      </div>
      <p v-if="multiple" class="field-hint">
        切换页码或筛选保留选择；全选和取消全选仅作用于当前页。
      </p>
    </section>
  </div>
</template>
<style scoped>
.device-picker {
  min-width: 0;
  width: 100%;
}
.picker-heading,
.picker-pagination,
.picker-filters {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 8px;
}
.picker-heading {
  font-size: 12px;
}
.picker-selected {
  overflow-wrap: anywhere;
}
.picker-content {
  margin-top: 10px;
  padding: 12px;
  border: 1px solid var(--border);
  border-radius: 8px;
}
.picker-filters input[type="search"] {
  flex: 1;
  min-width: 160px;
  width: auto;
}
.picker-filters select {
  width: auto;
  max-width: 100%;
}
.picker-options {
  max-height: 240px;
  overflow: auto;
  margin: 10px 0;
  display: grid;
  gap: 8px;
}
.device-picker .picker-check {
  display: flex;
  align-items: center;
  gap: 8px;
  margin: 0;
  font-weight: 400;
}
.device-picker .picker-check input {
  width: 16px;
  height: 16px;
  min-width: 16px;
  margin: 0;
}
.picker-check span {
  min-width: 0;
  overflow-wrap: anywhere;
}
.picker-check small {
  display: block;
  color: var(--muted);
  font-size: 11px;
}
.picker-pagination {
  font-size: 12px;
}
</style>
