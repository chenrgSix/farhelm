<script setup lang="ts">
import { computed } from "vue";
import type { AuditEntry } from "../api/types";
import { auditSource, mappingClient } from "../audit";
import ActorIdentity from "./ActorIdentity.vue";
const props = defineProps<{ entry: AuditEntry }>();
const client = computed(() => mappingClient(props.entry));
</script>
<template>
  <template v-if="client">
    <strong>客户端身份未认证</strong>
    <small class="muted block">来源 IP：{{ client.source }}</small>
    <small class="muted block">映射创建人：{{ client.owner }}</small>
  </template>
  <template v-else>
    <ActorIdentity :id="entry.actor_id" :username="entry.actor_username" />
    <small class="muted block">{{ auditSource(entry) }}</small>
    <small v-if="entry.context?.remote_address" class="muted mono block">{{
      entry.context.remote_address
    }}</small>
  </template>
</template>
