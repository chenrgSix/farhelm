<script setup lang="ts">
import { computed, onBeforeUnmount, ref, watch } from "vue";
import type { TerminalSession } from "../api/types";

const props = defineProps<{
  session: Pick<TerminalSession, "created_at" | "ended_at">;
}>();
const now = ref(Date.now());
let timer: ReturnType<typeof setInterval> | undefined;
watch(
  () => [props.session.created_at, props.session.ended_at],
  () => {
    clearInterval(timer);
    now.value = Date.now();
    if (props.session.ended_at == null)
      timer = setInterval(() => {
        now.value = Date.now();
      }, 1000);
  },
  { immediate: true },
);
onBeforeUnmount(() => clearInterval(timer));
const duration = computed(() => {
  const elapsed =
    (props.session.ended_at ?? now.value) - props.session.created_at;
  if (!Number.isFinite(elapsed)) return "—";
  const seconds = Math.floor(Math.max(0, elapsed) / 1000);
  return [
    Math.floor(seconds / 3600),
    Math.floor(seconds / 60) % 60,
    seconds % 60,
  ]
    .map((part) => String(part).padStart(2, "0"))
    .join(":");
});
</script>
<template>
  <span
    class="session-duration"
    :aria-label="`录制时长 ${duration}`"
    title="按会话开始至结束时间计算，包含等待和空闲，不受回放倍速影响"
    >{{ duration }}</span
  >
</template>
<style scoped>
.session-duration {
  white-space: nowrap;
  font-variant-numeric: tabular-nums;
}
</style>
