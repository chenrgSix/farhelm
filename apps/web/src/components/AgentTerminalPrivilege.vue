<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref } from "vue";
import { api } from "../api/client";
interface Setting {
  revision: number;
  enabled: boolean | null;
  desired_enabled: boolean | null;
  online: boolean;
  supported: boolean | null;
  blocked: boolean;
  status: "unknown" | "pending" | "applied" | "failed";
  reason: string | null;
}
const props = defineProps<{ deviceId: string }>();
const emit = defineEmits<{ changed: [] }>();
const state = ref<Setting>();
const enabled = ref(false),
  busy = ref(false),
  error = ref("");
let disposed = false,
  timer: ReturnType<typeof setTimeout> | undefined;
const path = `/devices/${encodeURIComponent(props.deviceId)}/terminal-privilege`;
const reasons: Record<string, string> = {
  ACTIVE_TERMINALS: "请先结束此设备的 Agent 终端，再重试。",
  CONNECTION_HAS_ACTIVE_SESSIONS: "请先结束此设备的 Agent 终端，再重试。",
  NO_NEW_PRIVS:
    "系统服务禁止提权，需先由服务器管理员调整该服务的 NoNewPrivileges 配置。",
  TERMINAL_PRIVILEGE_NO_NEW_PRIVS:
    "系统服务禁止提权，需先由服务器管理员调整该服务的 NoNewPrivileges 配置。",
  PERSIST_FAILED: "Agent 保存失败，请检查其状态目录和磁盘空间后重试。",
  STALE_REVISION: "Agent 配置已更新，请刷新状态后重试。",
  REVISION_CONFLICT: "Agent 配置版本冲突，请刷新状态后重试。",
  TERMINAL_PRIVILEGE_CHANGED_RELOAD: "配置已被修改，请刷新状态后重试。",
  TERMINAL_PRIVILEGE_STATUS_PENDING:
    "正在等待 Agent 上报实际状态，请稍后重试。",
  TERMINAL_PRIVILEGE_NOT_SUPPORTED_UPDATE_AGENT:
    "请先升级 Agent 至 0.2.11 或更新版本。",
  DEVICE_OFFLINE: "Agent 已离线，请等待上线后重试。",
};
const editable = computed(
  () =>
    !!state.value?.online &&
    state.value.supported === true &&
    state.value.enabled !== null &&
    state.value.status !== "pending" &&
    !busy.value,
);
function apply(result: Setting) {
  state.value = result;
  enabled.value =
    result.status === "pending"
      ? (result.desired_enabled ?? result.enabled ?? false)
      : (result.enabled ?? false);
  if (
    (result.status === "pending" ||
      (result.online && result.supported && result.enabled === null)) &&
    !disposed
  )
    timer = setTimeout(load, 1500);
}
async function load() {
  clearTimeout(timer);
  error.value = "";
  try {
    const result = await api.request<Setting>(path);
    if (!disposed) apply(result);
  } catch (e) {
    if (!disposed) error.value = e instanceof Error ? e.message : String(e);
  }
}
async function save() {
  if (!editable.value) return;
  busy.value = true;
  error.value = "";
  try {
    const result = await api.request<Setting>(path, {
      method: "PUT",
      body: { v: 1, revision: state.value!.revision, enabled: enabled.value },
    });
    if (!disposed) {
      clearTimeout(timer);
      apply(result);
      emit("changed");
    }
  } catch (e) {
    if (!disposed) {
      const message = e instanceof Error ? e.message : String(e);
      error.value =
        Object.entries(reasons).find(([code]) => message.includes(code))?.[1] ??
        message;
    }
  } finally {
    if (!disposed) busy.value = false;
  }
}
onMounted(load);
onBeforeUnmount(() => {
  disposed = true;
  clearTimeout(timer);
});
</script>
<template>
  <section class="terminal-privilege" aria-label="Agent 终端提权">
    <h3>终端提权</h3>
    <p v-if="error" class="text-warning" role="alert">{{ error }}</p>
    <p v-if="!state && !error" class="field-hint">正在读取 Agent 的实际状态…</p>
    <template v-if="state">
      <label class="connection-check"
        ><input
          v-model="enabled"
          type="checkbox"
          :disabled="!editable || (state.blocked && !state.enabled)"
        />允许终端使用该账号已有的 sudo 权限</label
      >
      <p class="field-hint">
        仅控制这台设备的 Agent 终端。运行账号仍须已有 Linux sudo
        权限；需要密码时在下方保存 sudo 密码。修改前请结束此设备的 Agent 终端。
      </p>
      <p class="field-hint" role="status">
        Agent {{ state.online ? "实际状态" : "上次确认状态" }}：{{
          state.enabled === null
            ? "尚未确认"
            : state.enabled
              ? "已启用"
              : "未启用"
        }}。
        <template v-if="!state.online">Agent 离线，上线后可刷新状态。</template>
        <template v-else-if="state.supported === false"
          >需升级 Agent 至 0.2.11 或更新版本，升级平台后再升级 Agent。</template
        >
        <template v-else-if="state.status === 'pending'"
          >已请求{{ state.desired_enabled ? "开启" : "关闭" }}，等待 Agent
          确认…</template
        >
        <template v-else-if="state.status === 'failed'"
          >未能应用：{{ reasons[state.reason ?? ""] ?? state.reason }}</template
        >
        <template v-if="state.blocked">{{ reasons.NO_NEW_PRIVS }}</template>
      </p>
      <div class="privilege-actions">
        <button
          type="button"
          class="button secondary"
          :disabled="!editable || (state.blocked && enabled)"
          @click="save"
        >
          {{ busy ? "保存中…" : "保存提权设置" }}
        </button>
        <button
          type="button"
          class="text-button"
          :disabled="busy"
          @click="load"
        >
          刷新状态
        </button>
      </div>
    </template>
  </section>
</template>
<style scoped>
.terminal-privilege {
  padding: 16px;
  border: 1px solid var(--border);
  border-radius: 8px;
  margin: 16px 24px;
}
h3 {
  margin: 0 0 12px;
  font-size: 14px;
}
.connection-check {
  display: flex;
  align-items: center;
  gap: 8px;
  font-size: 13px;
}
.connection-check input {
  width: 16px;
  height: 16px;
}
.field-hint {
  color: #647886;
  font-size: 12px;
  line-height: 1.7;
}
.privilege-actions {
  display: flex;
  gap: 12px;
  align-items: center;
}
</style>
