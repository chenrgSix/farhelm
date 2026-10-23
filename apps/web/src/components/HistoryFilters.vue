<script setup lang="ts">
import DevicePicker from "./DevicePicker.vue";
import { computed, ref, watch } from "vue";
import type { Device } from "../api/types";
import { statusLabels } from "../model";
import { auditActionLabels } from "../audit";
import {
  emptyHistoryFilters,
  type HistoryFilters,
} from "../composables/useHistoryList";
const props = defineProps<{
  kind: "tasks" | "audit" | "terminals";
  filters: HistoryFilters;
  devices: Device[];
}>();
const emit = defineEmits<{ apply: [filters: HistoryFilters] }>();
const draft = ref({ ...props.filters });
const error = ref("");
watch(
  () => props.filters,
  (value) => {
    draft.value = { ...value };
    error.value = "";
  },
);
const statuses = computed(() =>
  props.kind === "tasks"
    ? statusLabels
    : {
        OPENING: "正在连接",
        OPEN: "已连接",
        CLOSED: "已结束",
        INTERRUPTED: "中断",
      },
);
function apply() {
  const { from, to } = draft.value;
  if (
    (from && !Number.isFinite(new Date(from).getTime())) ||
    (to && !Number.isFinite(new Date(to).getTime())) ||
    (from && to && new Date(from).getTime() > new Date(to).getTime())
  ) {
    error.value = "请输入有效时间，结束时间不能早于开始时间。";
    return;
  }
  error.value = "";
  emit("apply", {
    ...draft.value,
    q: draft.value.q.trim(),
    actor_id: draft.value.actor_id.trim(),
    action: draft.value.action.trim(),
  });
}
function clear() {
  draft.value = emptyHistoryFilters();
  apply();
}
</script>

<template>
  <form
    class="history-filters"
    aria-label="历史查询条件"
    @submit.prevent="apply"
  >
    <label
      >关键词<input
        v-model="draft.q"
        type="search"
        maxlength="256"
        placeholder="搜索 ID、设备名称或内容"
    /></label>
    <DevicePicker
      label="历史设备"
      :multiple="false"
      empty-label="全部可见设备"
      :seed="devices"
      :model-value="draft.device_id ? [draft.device_id] : []"
      @update:model-value="draft.device_id = $event[0] ?? ''"
    />
    <label
      >操作人账号或 ID<input
        v-model="draft.actor_id"
        maxlength="128"
        placeholder="精确匹配账号或 ID"
    /></label>
    <label v-if="kind !== 'audit'"
      >状态<select v-model="draft.status">
        <option value="">全部状态</option>
        <option v-for="(label, value) in statuses" :key="value" :value="value">
          {{ label }}
        </option>
      </select></label
    >
    <label v-else
      >事件类型<select v-model="draft.action">
        <option value="">全部事件</option>
        <option
          v-for="(label, action) in auditActionLabels"
          :key="action"
          :value="action"
        >
          {{ label }}
        </option>
        <option
          v-if="draft.action && !auditActionLabels[draft.action]"
          :value="draft.action"
        >
          {{ draft.action }}
        </option>
      </select></label
    >
    <label>开始时间<input v-model="draft.from" type="datetime-local" /></label>
    <label>结束时间<input v-model="draft.to" type="datetime-local" /></label>
    <div class="history-filter-actions">
      <button class="button primary small" type="submit">查询历史</button
      ><button class="button secondary small" type="button" @click="clear">
        重置条件</button
      ><span class="muted small">按当前时区查询，包含起止时间</span>
    </div>
    <p v-if="error" class="text-danger" role="alert">{{ error }}</p>
  </form>
</template>

<style scoped>
.history-filters {
  padding: 0 22px 18px;
  display: grid;
  grid-template-columns: repeat(3, minmax(0, 1fr));
  gap: 12px;
  border-bottom: 1px solid var(--border);
}
.history-filters label {
  margin: 0;
}
.history-filters input,
.history-filters select {
  padding-block: 8px;
  padding-left: 10px;
  font-size: 12px;
}
.history-filters input {
  padding-right: 10px;
}
.history-filter-actions {
  grid-column: 1/-1;
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  gap: 10px;
}
.history-filters p {
  grid-column: 1/-1;
}
@media (max-width: 800px) {
  .history-filters {
    grid-template-columns: repeat(2, minmax(0, 1fr));
    padding: 0 16px 16px;
  }
}
@media (max-width: 560px) {
  .history-filters {
    grid-template-columns: 1fr;
  }
}
</style>
