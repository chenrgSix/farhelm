<script setup lang="ts">
import { ref, watch } from "vue";
import type { Device } from "../api/types";
import AccessManagementPanel from "./AccessManagementPanel.vue";
import AccessAuthorizationsPanel from "./AccessAuthorizationsPanel.vue";
const props = defineProps<{
  currentUserId: string;
  devices: Device[];
  deviceId?: string;
}>();
const emit = defineEmits<{ clearDevice: [] }>();
const tab = ref<"rules" | "users" | "groups" | "roles" | "effective">(
  props.deviceId ? "rules" : "users",
);
const advanced = ref(!!props.deviceId);
watch(
  () => props.deviceId,
  (value) => {
    if (value) {
      tab.value = "rules";
      advanced.value = true;
    }
  },
);
const tabs = {
  users: "用户",
  groups: "用户组",
  roles: "角色",
};
</script>
<template>
  <div class="access-control">
    <nav class="control-tabs" aria-label="访问控制分类">
      <button
        v-for="(label, key) in tabs"
        :key="key"
        :class="['button', tab === key ? 'primary' : 'secondary']"
        :aria-current="tab === key ? 'page' : undefined"
        @click="tab = key"
      >
        {{ label }}
      </button>
    </nav>
    <details
      :open="advanced"
      @toggle="advanced = ($event.target as HTMLDetailsElement).open"
    >
      <summary>高级授权（兼容现有账号规则）</summary>
      <p class="field-hint">
        原有精确账号授权继续生效。日常授权在用户或用户组中选择设备，在角色中设置是否允许
        sudo／root 终端。
      </p>
      <button class="button secondary" @click="tab = 'rules'">访问授权</button>
      <button class="button secondary" @click="tab = 'effective'">
        权限核对
      </button>
    </details>
    <p v-if="deviceId && tab === 'rules'" class="scope-notice">
      当前设备：{{
        devices.find((device) => device.id === deviceId)?.name ?? deviceId
      }}
      <button class="text-button" @click="emit('clearDevice')">
        查看全部设备授权
      </button>
    </p>
    <AccessAuthorizationsPanel
      v-if="advanced && (tab === 'rules' || tab === 'effective')"
      :key="tab"
      :device-id="tab === 'rules' ? deviceId : undefined"
      :effective="tab === 'effective'"
    /><AccessManagementPanel
      v-else
      :key="tab"
      :current-user-id="currentUserId"
      :devices="devices"
      :section="tab === 'rules' || tab === 'effective' ? 'users' : tab"
    />
  </div>
</template>
<style scoped>
.control-tabs {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
  margin-bottom: 18px;
}
</style>
