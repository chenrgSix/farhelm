<script setup lang="ts">
import type { AuditEntry } from "../api/types";
import { auditFields, auditSummary } from "../audit";
defineProps<{ entry: AuditEntry }>();
</script>
<template>
  <p class="audit-summary" :title="auditSummary(entry)">
    {{ auditSummary(entry) }}
  </p>
  <details class="audit-details">
    <summary class="text-button">查看详情 #{{ entry.id }}</summary>
    <dl>
      <template v-if="entry.actor_id"
        ><dt>操作人 ID</dt>
        <dd>{{ entry.actor_id }}</dd></template
      >
      <template v-if="entry.device_id"
        ><dt>设备 ID</dt>
        <dd>{{ entry.device_id }}</dd></template
      >
      <template v-if="entry.task_id"
        ><dt>任务 ID</dt>
        <dd>{{ entry.task_id }}</dd></template
      >
      <template v-for="(field, index) in auditFields(entry)" :key="index"
        ><dt>{{ field.label }}</dt>
        <dd>{{ field.value }}</dd></template
      >
      <template v-if="entry.context?.remote_address"
        ><dt>来源地址</dt>
        <dd>{{ entry.context.remote_address }}</dd></template
      >
      <template v-if="entry.context?.request_id"
        ><dt>请求编号</dt>
        <dd>{{ entry.context.request_id }}</dd></template
      >
      <template v-if="entry.context?.route"
        ><dt>请求入口</dt>
        <dd>{{ entry.context.method }} {{ entry.context.route }}</dd></template
      >
      <template v-if="entry.context?.user_agent"
        ><dt>客户端</dt>
        <dd>{{ entry.context.user_agent }}</dd></template
      >
    </dl>
    <details>
      <summary class="text-button">原始记录 JSON</summary>
      <pre>{{ JSON.stringify(entry, null, 2) }}</pre>
    </details>
  </details>
</template>
<style scoped>
.audit-summary {
  margin: 0 0 6px;
  max-width: 440px;
  display: -webkit-box;
  -webkit-line-clamp: 2;
  -webkit-box-orient: vertical;
  overflow: hidden;
  overflow-wrap: anywhere;
  font-size: 12px;
}
.audit-details {
  min-width: 220px;
  max-width: 480px;
}
dl {
  display: grid;
  grid-template-columns: minmax(76px, auto) minmax(0, 1fr);
  gap: 7px 12px;
  margin: 12px 0;
  font-size: 12px;
}
dt {
  color: var(--muted);
}
dd {
  margin: 0;
  white-space: pre-wrap;
  overflow-wrap: anywhere;
}
pre {
  max-width: 480px;
  max-height: 360px;
  overflow: auto;
  white-space: pre-wrap;
  overflow-wrap: anywhere;
  font-size: 11px;
}
</style>
