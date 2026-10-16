<script setup lang="ts">
defineProps<{ id: string | null; username?: string | null }>();
</script>
<template>
  <span :title="id ? `账号 ID：${id}` : undefined" class="actor-identity">
    {{ username || (id ? "未知账号" : "系统 / 设备") }}
    <small v-if="id && !username" class="muted mono block">{{ id }}</small>
  </span>
</template>
<style scoped>
.actor-identity {
  overflow-wrap: anywhere;
}
</style>
