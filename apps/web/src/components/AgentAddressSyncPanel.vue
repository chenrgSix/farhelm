<script setup lang="ts">
import { onBeforeUnmount, ref, watch } from "vue";
import { api } from "../api/client";
const props = defineProps<{ revision: number }>();
type Device = {
  device_id: string;
  name: string;
  revision: number;
  server_url: string;
  status: string;
  reason: string | null;
  online: boolean;
  updated_at: number;
};
const devices = ref<Device[]>([]),
  error = ref(""),
  busy = ref(false);
let disposed = false,
  generation = 0,
  timer: ReturnType<typeof setTimeout> | undefined;
const labels: Record<string, string> = {
  checking: "校验新地址",
  applied: "已切换",
  failed: "同步失败",
  unsupported: "需升级 Agent",
};
const reasons: Record<string, string> = {
  PROBE_FAILED: "新地址不可达，或证书、平台身份校验失败；保留原地址",
  PERSIST_FAILED: "无法保存配置；保留原地址",
  CONNECT_FAILED: "切换连接失败，已恢复原地址",
  TIMEOUT: "等待回执超时，结果尚未确认，可重新同步核对",
};
function label(d: Device) {
  return d.status === "pending"
    ? d.online
      ? "等待下发"
      : "等待上线"
    : d.status === "saved"
      ? d.online
        ? "已保存，等待终端结束"
        : "已保存，等待重连"
      : (labels[d.status] ?? "状态未知");
}
async function load(retry = false) {
  if (busy.value || disposed || props.revision < 1) return;
  if (timer) clearTimeout(timer);
  const run = ++generation;
  busy.value = true;
  try {
    const value = await api.request<{ revision: number; devices: Device[] }>(
      "/settings/agent-sync",
      retry ? { method: "POST", body: { v: 1, revision: props.revision } } : {},
    );
    if (disposed || run !== generation) return;
    devices.value = value.devices;
    error.value = "";
    if (value.revision !== props.revision)
      error.value = "平台配置已变化，请重新加载上方配置后再操作。";
  } catch (e) {
    if (!disposed && run === generation)
      error.value = e instanceof Error ? e.message : "读取同步状态失败";
  } finally {
    if (!disposed && run === generation) {
      busy.value = false;
      timer = setTimeout(() => void load(), 3000);
    }
  }
}
watch(
  () => props.revision,
  () => {
    generation++;
    busy.value = false;
    devices.value = [];
    void load();
  },
  { immediate: true },
);
onBeforeUnmount(() => {
  disposed = true;
  generation++;
  if (timer) clearTimeout(timer);
});
</script>
<template>
  <section class="sync-panel" aria-labelledby="agent-sync-title">
    <div class="sync-heading">
      <h3 id="agent-sync-title">Agent 地址同步</h3>
      <button
        type="button"
        class="button secondary small"
        :disabled="busy || !!error"
        @click="load(true)"
      >
        重试未完成的同步
      </button>
    </div>
    <p class="field-hint">
      先校验证书、平台身份和连接，再保存地址。正在使用的终端结束后自动切换；失败时继续使用原地址。离线设备重新上线后补同步，请保留旧地址入口直至全部完成。旧版
      Agent 需先升级。
    </p>
    <p v-if="error" role="alert" class="text-warning">{{ error }}</p>
    <p v-if="!devices.length && !error" class="muted">
      {{ busy ? "正在读取同步状态…" : "暂无需要同步的 Agent 设备" }}
    </p>
    <ul v-else class="sync-devices">
      <li v-for="device in devices" :key="device.device_id">
        <div>
          <strong>{{ device.name }}</strong
          ><span class="muted">{{ device.online ? "在线" : "离线" }}</span>
        </div>
        <span
          :class="{
            'text-warning':
              device.status === 'failed' || device.status === 'unsupported',
          }"
          >{{ label(device) }}</span
        >
        <p v-if="device.reason" class="field-hint">
          {{ reasons[device.reason] ?? device.reason }}
        </p>
      </li>
    </ul>
  </section>
</template>
<style scoped>
.sync-panel {
  margin-top: 24px;
  padding-top: 24px;
  border-top: 1px solid #e0e8ec;
}
.sync-heading {
  display: flex;
  justify-content: space-between;
  align-items: center;
  gap: 12px;
  flex-wrap: wrap;
  margin-bottom: 12px;
}
h3 {
  margin: 0;
  font-size: 15px;
}
.sync-devices {
  list-style: none;
  padding: 0;
  margin: 16px 0 0;
  display: grid;
  gap: 12px;
}
li {
  display: grid;
  grid-template-columns: 1fr auto;
  gap: 8px;
  padding: 12px;
  background: #f3f7f9;
  border-radius: 8px;
  font-size: 13px;
  overflow-wrap: anywhere;
}
li div {
  display: flex;
  gap: 10px;
  flex-wrap: wrap;
  min-width: 0;
}
li p {
  grid-column: 1 / -1;
  margin: 0;
}
@media (max-width: 600px) {
  li {
    grid-template-columns: 1fr;
  }
}
</style>
