<script setup lang="ts">
import { onBeforeUnmount, ref, watch } from "vue";
import { api } from "../api/client";
const props = defineProps<{
  revision: number;
  fingerprint: string;
  disabled: boolean;
}>();
type Device = {
  device_id: string;
  name: string;
  online: boolean;
  supported: boolean;
  status: string;
  reason: string | null;
  updated_at: number | null;
};
type State = {
  revision: number;
  fingerprint: string | null;
  all_ready: boolean;
  devices: Device[];
};
const state = ref<State>(),
  error = ref(""),
  busy = ref(false);
let disposed = false,
  generation = 0,
  timer: ReturnType<typeof setTimeout> | undefined;
const labels: Record<string, string> = {
  ready: "已保存并校验",
  checking: "正在校验和保存",
  failed: "同步失败",
  unsupported: "需先升级 Agent 至 0.2.4 或更高版本",
};
const reasons: Record<string, string> = {
  CERTIFICATE_INVALID: "证书链、域名或 CA 指纹校验失败",
  PERSIST_FAILED: "CA 保存失败，请检查 Agent 状态目录权限、空间及信任库容量",
  CONFIG_FAILED: "CA 已保存，但运行时加载未确认，请检查 Agent 日志后重试",
  TIMEOUT: "等待回执超时，请重试核对",
};
async function load(sync = false) {
  if (disposed || busy.value || (sync && props.disabled)) return;
  clearTimeout(timer);
  const run = ++generation;
  busy.value = true;
  try {
    const result = await api.request<State>(
      "/settings/certificate/agent-sync",
      sync ? { method: "POST", body: { v: 1, revision: props.revision } } : {},
    );
    if (disposed || run !== generation) return;
    state.value = result;
    error.value =
      result.revision !== props.revision ||
      result.fingerprint !== props.fingerprint
        ? "证书配置已变化，请重新加载上方配置。"
        : "";
  } catch (e) {
    if (!disposed && run === generation)
      error.value = e instanceof Error ? e.message : "读取 CA 同步状态失败";
  } finally {
    if (!disposed && run === generation) {
      busy.value = false;
      timer = setTimeout(() => void load(), 3000);
    }
  }
}
watch(
  () => [props.revision, props.fingerprint],
  () => {
    generation++;
    busy.value = false;
    state.value = undefined;
    void load();
  },
  { immediate: true },
);
onBeforeUnmount(() => {
  disposed = true;
  generation++;
  clearTimeout(timer);
});
</script>
<template>
  <section class="ca-sync" aria-labelledby="agent-ca-title">
    <h3 id="agent-ca-title">已有 Agent 的 CA 同步</h3>
    <p class="field-hint">
      先通过当前连接下发新 CA，Agent 校验证书链并保存后回执。保留旧
      CA，现有终端继续运行。未全部就绪时平台会阻止切换到新 CA；同一 CA
      的日常续签不受影响。
    </p>
    <button
      type="button"
      class="button secondary"
      :disabled="busy || disabled || revision < 1"
      @click="load(true)"
    >
      同步 CA 到已有 Agent / 重试
    </button>
    <p v-if="error" role="alert" class="text-warning">{{ error }}</p>
    <p
      v-else-if="state"
      :class="state.all_ready ? 'ready' : 'text-warning'"
      data-testid="ca-sync-summary"
    >
      {{
        state.all_ready
          ? "所有已有 Agent 均已就绪，可以切换证书"
          : `${state.devices.filter((d) => d.status === "ready").length} / ${state.devices.length} 台已就绪，请先完成同步或升级`
      }}
    </p>
    <ul v-if="state?.devices.length">
      <li v-for="device in state.devices" :key="device.device_id">
        <div>
          <strong>{{ device.name }}</strong
          ><span class="muted">{{ device.online ? "在线" : "离线" }}</span>
        </div>
        <span>{{
          labels[device.status] ??
          (device.online ? "等待同步" : "等待上线后补同步")
        }}</span>
        <p v-if="device.reason" class="field-hint">
          {{ reasons[device.reason] ?? device.reason }}
        </p>
      </li>
    </ul>
    <p class="field-hint">
      旧版 Agent 需在“Agent
      升级”页先批量升级。离线设备重新上线后自动补同步；已确认持久保存的设备无需一直在线。浏览器仍需由管理员单独信任新
      CA。
    </p>
  </section>
</template>
<style scoped>
.ca-sync {
  display: grid;
  gap: 12px;
  margin-top: 16px;
  padding-top: 18px;
  border-top: 1px solid #e0e8ec;
}
h3 {
  margin: 0;
  font-size: 15px;
}
p {
  margin: 0;
}
ul {
  list-style: none;
  margin: 0;
  padding: 0;
  display: grid;
  gap: 10px;
}
li {
  display: grid;
  gap: 6px;
  padding: 12px;
  background: #f3f7f9;
  border-radius: 8px;
  overflow-wrap: anywhere;
  font-size: 13px;
}
li div {
  display: flex;
  gap: 10px;
  flex-wrap: wrap;
}
.ready {
  color: #19705c;
}
</style>
