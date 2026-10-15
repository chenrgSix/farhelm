<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref } from "vue";
import { api, ApiError } from "../api/client";
import { formatTime } from "../model";

type Settings = {
  v: 1;
  revision: number;
  platform_server_url: string;
  updated_at: number | null;
};
const emit = defineEmits<{ saved: [] }>();
const settings = ref<Settings>();
const serverUrl = ref("");
const busy = ref(false);
const error = ref("");
const message = ref("");
const conflict = ref(false);
let disposed = false;
const dirty = computed(
  () => serverUrl.value.trim() !== settings.value?.platform_server_url,
);
async function load() {
  if (busy.value) return;
  busy.value = true;
  error.value = "";
  message.value = "";
  try {
    const result = await api.request<Settings>("/settings");
    if (disposed) return;
    settings.value = result;
    serverUrl.value = result.platform_server_url;
    conflict.value = false;
  } catch (e) {
    if (!disposed)
      error.value = e instanceof Error ? e.message : "读取系统设置失败";
  } finally {
    if (!disposed) busy.value = false;
  }
}
async function save() {
  if (busy.value || !settings.value || conflict.value) return;
  busy.value = true;
  error.value = "";
  message.value = "";
  try {
    const result = await api.request<Settings>("/settings", {
      method: "PUT",
      body: {
        v: 1,
        revision: settings.value.revision,
        platform_server_url: serverUrl.value.trim(),
      },
    });
    if (disposed) return;
    settings.value = result;
    serverUrl.value = result.platform_server_url;
    message.value = "已保存，新的 Agent 安装命令会自动使用此地址。";
    emit("saved");
  } catch (e) {
    if (disposed) return;
    const raw = e instanceof Error ? e.message : "保存失败";
    if (raw.includes("SETTINGS_REVISION_CONFLICT")) {
      conflict.value = true;
      error.value =
        "配置已被其他管理员修改。请重新加载配置后再编辑，避免覆盖他人的修改。";
    } else if (
      raw.includes("INVALID_AGENT_SERVER_URL") ||
      raw.includes("INVALID_STRING")
    ) {
      error.value =
        "请输入有效的 HTTPS 地址，例如 https://fleet.example.com:8443，不包含账号、路径或查询参数。";
    } else if (e instanceof ApiError && e.status === 0) {
      conflict.value = true;
      error.value = "保存结果尚未确认，请重新加载配置核对后再操作。";
    } else error.value = raw;
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
  <section
    class="panel settings-panel"
    aria-labelledby="platform-settings-title"
  >
    <div class="panel-heading">
      <div>
        <h2 id="platform-settings-title">Agent 接入设置</h2>
        <p class="muted">统一管理 Agent 连接平台的地址</p>
      </div>
    </div>
    <form @submit.prevent="save">
      <p v-if="error" class="notice danger" role="alert">{{ error }}</p>
      <p v-if="message" class="settings-success" role="status">{{ message }}</p>
      <p v-if="!settings && busy" class="muted">正在读取系统设置…</p>
      <fieldset v-if="settings" :disabled="busy">
        <label
          >平台服务端地址<input
            v-model="serverUrl"
            type="url"
            required
            maxlength="2048"
            placeholder="https://fleet.example.com:8443"
            spellcheck="false"
            autocomplete="off"
            @input="message = ''"
        /></label>
        <p class="field-hint">
          填写目标服务器能够访问的 HTTPS 地址，证书须包含该主机名。添加 Agent
          时会自动带入。
        </p>
        <div class="notice settings-scope">
          保存后立即用于新生成的安装命令，无需重启服务。已生成的命令保留原地址；已有
          Agent 的连接地址需在对应服务器同步更新。
        </div>
        <p class="field-hint">
          此设置保存后会随平台数据持久化。{{
            settings.updated_at
              ? `上次保存：${formatTime(settings.updated_at)}`
              : "当前配置尚未在系统设置中保存。"
          }}
        </p>
      </fieldset>
      <div class="settings-actions">
        <button
          v-if="settings"
          type="submit"
          class="button primary"
          :disabled="
            busy ||
            conflict ||
            !serverUrl.trim() ||
            (!dirty && settings.revision > 0)
          "
        >
          {{ busy ? "处理中…" : "保存设置" }}
        </button>
        <button
          type="button"
          class="button secondary"
          :disabled="busy"
          @click="load"
        >
          重新加载配置
        </button>
      </div>
    </form>
  </section>
</template>

<style scoped>
.settings-panel {
  max-width: 820px;
  padding: 24px;
}
.panel-heading p {
  margin: 7px 0 0;
}
form,
fieldset {
  display: grid;
  gap: 16px;
}
fieldset {
  border: 0;
  padding: 0;
  margin: 0;
  min-width: 0;
}
label {
  display: grid;
  gap: 8px;
  margin: 0;
  font-size: 13px;
  font-weight: 600;
}
input {
  width: 100%;
  box-sizing: border-box;
  margin: 0;
}
p {
  margin: 0;
  overflow-wrap: anywhere;
}
.settings-scope {
  background: #f3f7f9;
  color: #536776;
  line-height: 1.8;
  margin: 0;
}
.settings-success {
  color: #19705c;
}
.settings-actions {
  display: flex;
  flex-wrap: wrap;
  gap: 10px;
  padding-top: 6px;
}
@media (max-width: 600px) {
  .settings-panel {
    padding: 18px;
  }
}
</style>
