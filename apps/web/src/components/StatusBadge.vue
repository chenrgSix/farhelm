<script setup lang="ts">
import type { TaskStatus } from "../api/types";
import { statusLabels } from "../model";
defineProps<{ status: TaskStatus }>();
</script>
<template>
  <span class="status" :class="status.toLowerCase()">{{
    statusLabels[status] ?? status
  }}</span>
</template>
