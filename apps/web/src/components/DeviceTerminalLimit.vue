<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref } from "vue";
import { api, ApiError } from "../api/client";
const props = defineProps<{ deviceId: string }>();
const emit = defineEmits<{ changed: [] }>();
type Setting = {
  v: 1;
  device_id: string;
  revision: number;
  limit: number | null;
  global_limit: number;
  effective_limit: number;
  source: "global" | "device";
  updated_at: number | null;
};
const state = ref<Setting>(),
  inherit = ref(true),
  limit = ref(4),
  busy = ref(false),
  conflict = ref(false),
  error = ref(""),
  notice = ref("");
let disposed = false;
const path = `/devices/${encodeURIComponent(props.deviceId)}/terminal-limit`;
const valid = computed(
  () =>
    inherit.value ||
    (Number.isInteger(limit.value) && limit.value >= 1 && limit.value <= 128),
);
const dirty = computed(
  () =>
    !!state.value && (inherit.value ? null : limit.value) !== state.value.limit,
);
function apply(result: Setting) {
  state.value = result;
  inherit.value = result.limit === null;
  limit.value = result.limit ?? result.global_limit;
  conflict.value = false;
}
async function load() {
  if (busy.value) return;
  busy.value = true;
  error.value = "";
  notice.value = "";
  try {
    const result = await api.request<Setting>(path);
    if (!disposed) apply(result);
  } catch (e) {
    if (!disposed)
      error.value = e instanceof Error ? e.message : "读取设备终端限额失败";
  } finally {
    if (!disposed) busy.value = false;
  }
}
async function save() {
  if (
    busy.value ||
    conflict.value ||
    !state.value ||
    !valid.value ||
    !dirty.value
  )
    return;
  busy.value = true;
  error.value = "";
  notice.value = "";
  try {
    const result = await api.request<Setting>(path, {
      method: "PUT",
      body: {
        v: 1,
        revision: state.value.revision,
        limit: inherit.value ? null : limit.value,
      },
    });
    if (disposed) return;
    apply(result);
    notice.value =
      result.limit === null ? "已恢复继承全局配置。" : "设备终端上限已保存。";
    emit("changed");
  } catch (e) {
    if (disposed) return;
    const text = e instanceof Error ? e.message : "保存失败";
    if (
      text.includes("DEVICE_TERMINAL_LIMIT_CHANGED_RELOAD") ||
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
  <section class="device-terminal-limit" aria-label="设备终端限额">
    <h3>终端连接上限</h3>
    <p class="field-hint">
      这台设备的网页终端和 SSH 终端共用限额，所有用户合计，包含等待连接的终端。
    </p>
    <p v-if="error" class="text-warning" role="alert">{{ error }}</p>
    <p v-if="notice" role="status">{{ notice }}</p>
    <form v-if="state" @submit.prevent="save">
      <fieldset :disabled="busy || conflict">
        <label class="inherit-limit"
          ><input
            v-model="inherit"
            aria-label="继承全局终端上限"
            type="checkbox"
          />继承全局配置（当前 {{ state.global_limit }}）</label
        >
        <label v-if="!inherit"
          >本设备终端上限<input
            v-model.number="limit"
            aria-label="本设备终端上限"
            type="number"
            min="1"
            max="128"
            step="1"
            required
        /></label>
        <p class="field-hint">
          当前已保存的生效上限：{{ state.effective_limit }}（{{
            state.source === "global" ? "继承全局" : "设备覆盖"
          }}）。{{
            inherit
              ? "全局默认值调整后会自动跟随。"
              : "可设 1–128，其他设备保持原配置。"
          }}
        </p>
      </fieldset>
      <p class="field-hint">
        保存后对新连接生效，不主动断开已有终端。单用户与平台总连接上限仍同时生效；提高上限需要支持此功能的新版
        Agent。
      </p>
      <div class="limit-actions">
        <button
          class="button primary"
          type="submit"
          :disabled="busy || conflict || !valid || !dirty"
        >
          {{ busy ? "保存中…" : "保存终端限额" }}</button
        ><button
          class="button secondary"
          type="button"
          :disabled="busy"
          @click="load"
        >
          重新加载终端限额
        </button>
      </div>
    </form>
    <button v-else-if="!busy" class="button secondary" @click="load">
      重新加载终端限额
    </button>
    <p v-else class="field-hint">正在读取终端限额…</p>
  </section>
</template>
<style scoped>
.device-terminal-limit h3 {
  margin: 0 0 12px;
}
.inherit-limit {
  display: flex;
  align-items: center;
  gap: 8px;
}
.inherit-limit input {
  width: auto;
}
.device-terminal-limit fieldset {
  border: 0;
  padding: 0;
  margin: 16px 0;
}
.limit-actions {
  display: flex;
  flex-wrap: wrap;
  gap: 12px;
}
.device-terminal-limit input[type="number"] {
  display: block;
  width: 160px;
  max-width: 100%;
  margin-top: 8px;
}
</style>
