<script setup lang="ts">
import { onBeforeUnmount, onMounted, ref } from "vue";
import { api, ApiError } from "../api/client";
const fields = [
  { key: "per_user", label: "单用户并发连接上限", max: 128 },
  { key: "per_device", label: "单设备终端默认上限", max: 128 },
  { key: "terminal_total", label: "平台终端总上限", max: 1024 },
  { key: "ssh_total", label: "SSH 总连接上限", max: 1024 },
  { key: "ssh_per_ip", label: "单 IP SSH 连接上限", max: 1024 },
] as const;
type Limits = {
  v: 1;
  revision: number;
  updated_at: number | null;
  per_user: number;
  per_device: number;
  terminal_total: number;
  ssh_total: number;
  ssh_per_ip: number;
};
const current = ref<Limits>(),
  draft = ref<Limits>(),
  busy = ref(false),
  conflict = ref(false),
  error = ref(""),
  notice = ref("");
let disposed = false;
async function load() {
  if (busy.value) return;
  busy.value = true;
  error.value = "";
  notice.value = "";
  try {
    const result = await api.request<Limits>("/settings/connections");
    if (disposed) return;
    current.value = result;
    draft.value = { ...result };
    conflict.value = false;
  } catch (e) {
    if (!disposed)
      error.value = e instanceof Error ? e.message : "读取连接限额失败";
  } finally {
    if (!disposed) busy.value = false;
  }
}
async function save() {
  if (busy.value || conflict.value || !current.value || !draft.value) return;
  busy.value = true;
  error.value = "";
  notice.value = "";
  try {
    const result = await api.request<Limits>("/settings/connections", {
      method: "PUT",
      body: {
        v: 1,
        revision: current.value.revision,
        ...Object.fromEntries(fields.map((f) => [f.key, draft.value![f.key]])),
      },
    });
    if (disposed) return;
    current.value = result;
    draft.value = { ...result };
    notice.value = "连接限额已保存，对新连接立即生效。";
  } catch (e) {
    if (disposed) return;
    const text = e instanceof Error ? e.message : "保存失败";
    if (
      text.includes("SETTINGS_REVISION_CONFLICT") ||
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
  <section class="panel connection-limits" aria-label="连接限额">
    <h3>连接限额</h3>
    <p class="field-hint">
      单用户限额合计网页终端（含等待连接）和已认证的 SSH 连接，SSH
      设备菜单也占用一个连接。设备终端限额由所有用户共用，可在设备接入配置中单独覆盖。
    </p>
    <p class="field-hint">
      只调整 Farhelm 接纳的新连接，降低限额不会中断已有连接。SSH 总数及单 IP
      限额包括认证中的连接；提高设备上限需要支持此功能的新版 Agent。
    </p>
    <p v-if="error" role="alert" class="text-warning">{{ error }}</p>
    <p v-if="notice" role="status">{{ notice }}</p>
    <form v-if="draft" @submit.prevent="save">
      <fieldset :disabled="busy || conflict">
        <div class="limit-fields">
          <label v-for="field in fields" :key="field.key"
            >{{ field.label
            }}<input
              v-model.number="draft[field.key]"
              :aria-label="field.label"
              type="number"
              min="1"
              :max="field.max"
              step="1"
              required
          /></label>
        </div>
      </fieldset>
      <div class="limit-actions">
        <button
          class="button primary"
          type="submit"
          :disabled="busy || conflict"
        >
          {{ busy ? "保存中…" : "保存连接限额" }}</button
        ><button
          class="button secondary"
          type="button"
          :disabled="busy"
          @click="load"
        >
          重新加载连接限额
        </button>
      </div>
    </form>
    <button v-else-if="!busy" class="button secondary" @click="load">
      重新加载连接限额
    </button>
  </section>
</template>
<style scoped>
.connection-limits {
  padding: 24px;
}
.connection-limits h3 {
  margin: 0 0 10px;
}
.limit-fields {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(210px, 1fr));
  gap: 16px;
}
.limit-fields label {
  display: flex;
  flex-direction: column;
  gap: 8px;
}
.limit-fields input {
  width: 100%;
  min-width: 0;
}
.limit-actions {
  display: flex;
  gap: 12px;
  flex-wrap: wrap;
  margin-top: 16px;
}
fieldset {
  border: 0;
  padding: 0;
  margin: 16px 0 0;
  min-width: 0;
}
</style>
