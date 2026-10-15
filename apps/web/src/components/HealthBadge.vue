<script setup lang="ts">
defineProps<{
  value: boolean | null | undefined;
  good?: string;
  bad?: string;
}>();
</script>
<template>
  <span
    class="health"
    :class="
      value === true ? 'healthy' : value === false ? 'offline' : 'unknown'
    "
    ><span class="dot"></span
    >{{
      value === true
        ? (good ?? "正常")
        : value === false
          ? (bad ?? "不可达")
          : "未知"
    }}</span
  >
</template>
