<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref } from "vue";
import { api, ApiError } from "../api/client";
import { formatTime } from "../model";
import AgentAddressSyncPanel from "./AgentAddressSyncPanel.vue";

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
const pageOrigin = window.location.origin;
const pageUsesHttps = window.location.protocol === "https:";
const normalizedUrl = computed(() => {
  try {
    return platformEntry(serverUrl.value);
  } catch {
    return "";
  }
});
function platformEntry(value: string) {
  const input = value.trim();
  if (!input || /[\x00-\x20\x7f]/.test(input))
    throw new Error("INVALID_PLATFORM_ADDRESS");
  let url: URL;
  try {
    url = new URL(input);
  } catch {
    throw new Error("INVALID_PLATFORM_ADDRESS");
  }
  if (url.protocol !== "https:") throw new Error("PLATFORM_HTTPS_REQUIRED");
  if (url.username || url.password) throw new Error("INVALID_PLATFORM_ADDRESS");
  return url.origin;
}
async function usePageAddress() {
  if (busy.value || !pageUsesHttps || !settings.value || conflict.value) return;
  serverUrl.value = pageOrigin;
  await save(true);
}
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
async function save(syncUnchanged = false) {
  if (busy.value || !settings.value || conflict.value) return;
  busy.value = true;
  error.value = "";
  message.value = "";
  let addressSaved = false;
  const previousRevision = settings.value.revision;
  try {
    const address = platformEntry(serverUrl.value);
    const result = await api.request<Settings>("/settings", {
      method: "PUT",
      body: {
        v: 1,
        revision: previousRevision,
        platform_server_url: address,
      },
    });
    if (disposed) return;
    settings.value = result;
    serverUrl.value = result.platform_server_url;
    addressSaved = true;
    emit("saved");
    const changed = result.revision !== previousRevision;
    if (syncUnchanged && !changed) {
      await api.request("/settings/agent-sync", {
        method: "POST",
        body: { v: 1, revision: result.revision },
      });
      if (disposed) return;
      message.value =
        "平台地址已保存，已发起未完成的 Agent 地址同步，请在下方查看结果。";
    } else {
      message.value = changed
        ? "已保存，新的安装命令将使用此地址，并已发起 Agent 地址同步，请在下方查看结果。"
        : "平台地址未变化，可在下方查看或重试 Agent 地址同步。";
    }
  } catch (e) {
    if (disposed) return;
    const raw = e instanceof Error ? e.message : "保存失败";
    if (raw.includes("SETTINGS_REVISION_CONFLICT")) {
      conflict.value = true;
      error.value = addressSaved
        ? "平台地址已保存，但配置随后被其他管理员修改。请重新加载配置后核对同步状态。"
        : "配置已被其他管理员修改。请重新加载配置后再编辑，避免覆盖他人的修改。";
    } else if (addressSaved) {
      if (e instanceof ApiError && e.status === 0) {
        conflict.value = true;
        error.value =
          "平台地址已保存，但同步请求结果尚未确认。请重新加载配置并核对下方同步状态后再操作。";
      } else {
        error.value =
          "平台地址已保存，但发起 Agent 地址同步失败，请在下方重试未完成的同步。";
      }
    } else if (
      raw.includes("INVALID_AGENT_SERVER_URL") ||
      raw.includes("INVALID_STRING") ||
      raw.includes("INVALID_PLATFORM_ADDRESS")
    ) {
      error.value =
        "请输入有效的 HTTPS 平台网页地址，例如 https://fleet.example.com，不能包含账号或密码。";
    } else if (raw.includes("PLATFORM_HTTPS_REQUIRED")) {
      error.value =
        "Agent 需要 HTTPS 入口。请使用已启用 HTTPS 的平台网页地址，HTTP 开发地址不能用于 Agent 接入。";
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
        <p class="muted">网页控制台与 Agent 共用同一个对外入口</p>
      </div>
    </div>
    <form @submit.prevent="save()">
      <p v-if="error" class="notice danger" role="alert">{{ error }}</p>
      <p v-if="message" class="settings-success" role="status">{{ message }}</p>
      <p v-if="!settings && busy" class="muted">正在读取系统设置…</p>
      <fieldset v-if="settings" :disabled="busy">
        <label
          >平台访问地址<input
            v-model="serverUrl"
            type="url"
            required
            maxlength="2048"
            placeholder="https://fleet.example.com"
            spellcheck="false"
            autocomplete="off"
            @input="message = ''"
        /></label>
        <div class="settings-address-actions">
          <button
            type="button"
            class="button secondary small"
            :disabled="busy || conflict || !pageUsesHttps"
            @click="usePageAddress"
          >
            使用当前网页地址并同步
          </button>
          <span class="field-hint">{{ pageOrigin }}</span>
        </div>
        <p class="field-hint">
          直接粘贴浏览器中的 HTTPS
          平台地址即可，自动保留域名和端口。网页服务需已接通 Agent
          转发，目标服务器也需能够访问这个地址；添加 Agent 时自动带入。
        </p>
        <p
          v-if="normalizedUrl && normalizedUrl !== serverUrl.trim()"
          class="field-hint"
        >
          将使用：{{ normalizedUrl }}（已去除页面路径和参数）
        </p>
        <p v-if="!pageUsesHttps" class="notice settings-scope">
          当前网页使用 HTTP，不能直接作为 Agent 入口。请填写已启用 HTTPS
          的平台网页地址。
        </p>
        <div class="notice settings-scope">
          保存后立即用于新生成的安装命令，并自动同步到支持此功能的
          Agent，无需重启平台。启用网络策略的设备由下方「平台网络策略」管理运行入口。已生成的安装命令保留原地址。
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
    <AgentAddressSyncPanel
      v-if="settings && settings.revision > 0"
      :revision="settings.revision"
    />
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
.settings-address-actions {
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  gap: 10px;
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
