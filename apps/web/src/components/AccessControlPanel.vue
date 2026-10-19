<script setup lang="ts">
import { ref } from "vue";
import type { Device } from "../api/types";
import AccessManagementPanel from "./AccessManagementPanel.vue";
import AccessAuthorizationsPanel from "./AccessAuthorizationsPanel.vue";
defineProps<{ currentUserId: string; devices: Device[]; deviceId?: string }>();
const emit = defineEmits<{ clearDevice: [] }>();
const tab = ref<"rules" | "users" | "groups" | "roles" | "effective">("rules");
const tabs = {
  rules: "访问授权",
  users: "用户",
  groups: "用户组",
  roles: "角色",
  effective: "权限核对",
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
    <p v-if="deviceId && tab === 'rules'" class="scope-notice">
      当前设备：{{
        devices.find((device) => device.id === deviceId)?.name ?? deviceId
      }}
      <button class="text-button" @click="emit('clearDevice')">
        查看全部设备授权
      </button>
    </p>
    <AccessAuthorizationsPanel
      v-if="tab === 'rules' || tab === 'effective'"
      :key="tab"
      :device-id="tab === 'rules' ? deviceId : undefined"
      :effective="tab === 'effective'"
    /><AccessManagementPanel
      v-else
      :key="tab"
      :current-user-id="currentUserId"
      :devices="devices"
      :section="tab"
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
