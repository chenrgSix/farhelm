<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref } from "vue";
import { api, ApiError } from "../api/client";
const props = defineProps<{ deviceId: string }>();
const emit = defineEmits<{ changed: [] }>();
type Setting = {
  v: 1;
  device_id: string;
  enabled: boolean;
  revision: number;
  updated_at: number | null;
};
const state = ref<Setting>(),
  enabled = ref(false),
  busy = ref(false),
  conflict = ref(false),
  error = ref(""),
  notice = ref("");
let disposed = false;
const path = `/devices/${encodeURIComponent(props.deviceId)}/forwarding`;
const dirty = computed(
  () => !!state.value && enabled.value !== state.value.enabled,
);
function apply(result: Setting) {
  state.value = result;
  enabled.value = result.enabled;
  conflict.value = false;
}
async function load() {
  if (busy.value) return;
  busy.value = true;
  error.value = notice.value = "";
  try {
    const result = await api.request<Setting>(path);
    if (!disposed) apply(result);
  } catch (e) {
    if (!disposed)
      error.value = e instanceof Error ? e.message : "读取转发配置失败";
  } finally {
    if (!disposed) busy.value = false;
  }
}
async function save() {
  if (busy.value || conflict.value || !state.value || !dirty.value) return;
  busy.value = true;
  error.value = notice.value = "";
  try {
    const result = await api.request<Setting>(path, {
      method: "PUT",
      body: { v: 1, revision: state.value.revision, enabled: enabled.value },
    });
    if (disposed) return;
    apply(result);
    notice.value = result.enabled
      ? "已允许通过本设备转发。"
      : "已关闭转发，并断开本设备已有的转发连接。";
    emit("changed");
  } catch (e) {
    if (disposed) return;
    const text = e instanceof Error ? e.message : "保存失败";
    if (
      text.includes("DEVICE_FORWARDING_CHANGED_RELOAD") ||
      (e instanceof ApiError && e.status === 0)
    ) {
      conflict.value = true;
      error.value = "配置已变更或保存结果尚未确认，请重新加载后核对。";
    } else error.value = text;
  } finally {
    if (!disposed) busy.value = false;
  }
}
onMounted(load);
onBeforeUnmount(() => {
  disposed = true;
});
</script>
<template>
  <section class="device-forwarding" aria-label="设备 TCP 转发">
    <h3>TCP 转发</h3>
    <p class="field-hint">
      默认关闭。开启后，已有本设备连接权限的用户可通过它使用 SSH
      跳板（-J）和端口转发（-L / -D），访问本设备可达的 TCP 地址。
    </p>
    <p v-if="error" class="text-warning" role="alert">{{ error }}</p>
    <p v-if="notice" role="status">{{ notice }}</p>
    <form v-if="state" @submit.prevent="save">
      <fieldset :disabled="busy || conflict">
        <label
          ><input
            v-model="enabled"
            type="checkbox"
            aria-label="允许 TCP 转发"
          />允许 TCP 转发</label
        >
        <p class="field-hint">
          当前已保存：{{ state.enabled ? "允许转发" : "禁止转发" }}。同时适用于
          Agent、SSH 和备用
          SSH。关闭后立即断开本设备的已有转发，不影响普通终端。
        </p>
      </fieldset>
      <div class="forwarding-actions">
        <button
          class="button primary"
          type="submit"
          :disabled="busy || conflict || !dirty"
        >
          {{ busy ? "保存中…" : "保存转发配置" }}
        </button>
        <button
          class="button secondary"
          type="button"
          :disabled="busy"
          @click="load"
        >
          重新加载转发配置
        </button>
      </div>
    </form>
    <button v-else-if="!busy" class="button secondary" @click="load">
      重新加载转发配置
    </button>
    <p v-else class="field-hint">正在读取转发配置…</p>
  </section>
</template>
<style scoped>
.device-forwarding h3 {
  margin: 0 0 12px;
}
.device-forwarding label {
  display: flex;
  align-items: center;
  gap: 8px;
}
.device-forwarding input {
  width: auto;
}
.device-forwarding fieldset {
  border: 0;
  padding: 0;
  margin: 16px 0;
}
.forwarding-actions {
  display: flex;
  flex-wrap: wrap;
  gap: 12px;
}
</style>
