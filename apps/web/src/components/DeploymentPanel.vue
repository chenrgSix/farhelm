<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref } from "vue";
import { api } from "../api/client";
import type { RuntimeSettings } from "../api/types";
import { copyText } from "../clipboard";
const props = defineProps<{ runtime: RuntimeSettings }>();
const emit = defineEmits<{ saved: [] }>();
type State = {
  v: 1;
  revision: number;
  settings: RuntimeSettings;
  state: "idle" | "applying" | "awaiting_confirmation" | "rolled_back";
  entry_url: string | null;
  rollback_url: string | null;
  confirm_by: number | null;
  last_error: string | null;
  active_terminals: number;
  https_ready: boolean;
  agent_https_port?: number;
  agents_on_web?: number;
  web_reload_supported?: boolean;
  recovery_command: string;
};
const state = ref<State>();
const form = ref<RuntimeSettings>({ ...props.runtime });
const confirmedDisable = ref(false),
  busy = ref(false),
  error = ref(""),
  message = ref("");
const now = ref(Date.now());
const pending = computed(
  () =>
    state.value?.state === "applying" ||
    state.value?.state === "awaiting_confirmation",
);
const dirty = computed(
  () =>
    state.value &&
    JSON.stringify(form.value) !== JSON.stringify(state.value.settings),
);
const needsHttps = computed(
  () =>
    form.value.device_access === "agent-ssh" ||
    (form.value.web_enabled && form.value.web_protocol === "https"),
);
const migrationRequired = computed(
  () =>
    form.value.device_access === "agent-ssh" &&
    (!form.value.web_enabled || form.value.web_protocol === "http") &&
    !!state.value?.agents_on_web,
);
const needsRestart = computed(
  () =>
    form.value.device_access !== state.value?.settings.device_access ||
    (form.value.web_protocol === "https" && !state.value?.web_reload_supported),
);
const remaining = computed(() =>
  state.value?.confirm_by
    ? Math.max(0, Math.ceil((state.value.confirm_by - now.value) / 1000))
    : 120,
);
let disposed = false,
  polling = false;
async function load(silent = false) {
  if (polling || busy.value) return;
  polling = true;
  try {
    const result = await api.request<State>("/settings/deployment");
    if (disposed) return;
    if (!result.settings) throw Error("运行设置暂不可用，请刷新后重试");
    const changed =
      state.value?.revision !== result.revision ||
      state.value?.state !== result.state;
    state.value = result;
    if (result.state === "rolled_back") message.value = "";
    if (!silent || changed) form.value = { ...result.settings };
    error.value = "";
    if (changed) emit("saved");
  } catch (e) {
    if (!disposed && !silent)
      error.value = e instanceof Error ? e.message : "读取运行设置失败";
  } finally {
    polling = false;
  }
}
async function save() {
  if (!state.value || !dirty.value || busy.value || pending.value) return;
  busy.value = true;
  error.value = "";
  message.value = "";
  try {
    const result = await api.request<State>("/settings/deployment", {
      method: "PUT",
      body: {
        v: 1,
        revision: state.value.revision,
        settings: { ...form.value },
        entry_origin: window.location.origin,
        confirm_web_disable: confirmedDisable.value,
      },
    });
    if (disposed) return;
    state.value = result;
    confirmedDisable.value = false;
    message.value = result.settings.web_enabled
      ? "正在应用。请在新入口的系统设置中确认保留配置；2 分钟内未确认将自动恢复原设置。"
      : "正在关闭网页管理，SSH 入口继续保留。重新开启网页请在平台服务器执行下面的恢复命令。";
  } catch (e) {
    if (!disposed) error.value = e instanceof Error ? e.message : "保存失败";
  } finally {
    if (!disposed) busy.value = false;
  }
}
async function confirm() {
  if (!state.value || busy.value) return;
  busy.value = true;
  error.value = "";
  try {
    const result = await api.request<State>("/settings/deployment/confirm", {
      method: "POST",
      body: { v: 1, revision: state.value.revision },
    });
    if (disposed) return;
    state.value = result;
    form.value = { ...result.settings };
    message.value = "配置已生效并保存，平台重启后继续使用。";
    emit("saved");
  } catch (e) {
    if (!disposed) error.value = e instanceof Error ? e.message : "确认失败";
  } finally {
    if (!disposed) busy.value = false;
  }
}
async function copyRecovery() {
  try {
    await copyText(state.value!.recovery_command);
    message.value = "恢复命令已复制，请在平台服务器的项目目录中执行。";
  } catch {
    error.value = "复制失败，请手动复制恢复命令。";
  }
}
const timer = setInterval(() => {
  now.value = Date.now();
  if (pending.value && state.value?.settings.web_enabled) void load(true);
}, 1000);
onMounted(() => load());
onBeforeUnmount(() => {
  disposed = true;
  clearInterval(timer);
});
</script>
<template>
  <section class="panel deployment-panel" aria-label="平台运行方式">
    <h2>平台运行方式</h2>
    <p>管理员可保存并应用以下设置，平台重启后仍然生效。</p>
    <p v-if="error" class="notice danger" role="alert">{{ error }}</p>
    <p v-if="message" role="status">{{ message }}</p>
    <p v-if="state?.last_error" class="notice" role="status">
      上次切换未完成，已恢复原设置（{{
        state.last_error === "CONFIRMATION_TIMEOUT"
          ? "新入口未及时确认"
          : state.last_error === "APPLY_INTERRUPTED"
            ? "切换期间服务重启"
            : "新配置启动失败"
      }}）。
    </p>
    <div v-if="pending" class="notice">
      <template v-if="state?.settings.web_enabled">
        <p>
          应用后入口：<a
            v-if="state.entry_url"
            :href="state.entry_url"
            target="_blank"
            rel="noopener noreferrer"
            >{{ state.entry_url }}</a
          >
        </p>
        <p>请在新入口登录并进入“系统设置”确认；未确认会自动回退。</p>
        <button
          v-if="state?.state === 'awaiting_confirmation'"
          type="button"
          class="button primary"
          :disabled="busy"
          @click="confirm"
        >
          确认保留此配置（{{ remaining }} 秒）
        </button>
        <p v-if="state.rollback_url">
          回退入口：<a
            :href="state.rollback_url"
            target="_blank"
            rel="noopener noreferrer"
            >{{ state.rollback_url }}</a
          >
        </p>
      </template>
      <p v-else>网页关闭后无法在此页操作，请使用下方本机恢复命令重新开启。</p>
    </div>
    <form @submit.prevent="save">
      <fieldset :disabled="!state || busy || pending">
        <div class="deployment-options">
          <label
            >设备接入方式
            <select v-model="form.device_access" aria-label="设备接入方式">
              <option value="agent-ssh">Agent 和 SSH</option>
              <option value="ssh-only">仅 SSH</option>
            </select>
          </label>
          <label
            >网页管理
            <select v-model="form.web_enabled" aria-label="网页管理">
              <option :value="true">开启</option>
              <option :value="false">关闭</option>
            </select>
          </label>
          <label
            >网页协议
            <select v-model="form.web_protocol" aria-label="网页协议">
              <option value="http">HTTP</option>
              <option value="https">HTTPS</option>
            </select>
          </label>
        </div>
        <p v-if="form.device_access === 'ssh-only'">
          设备通过 SSH
          连接。开启网页管理后，可继续管理设备、账号权限、网页终端和会话录制。
        </p>
        <p v-if="form.web_protocol === 'http'">
          网页 HTTP 无需浏览器信任证书，网页通信不加密。
        </p>
        <p v-if="state?.agent_https_port && form.device_access === 'agent-ssh'">
          Agent 使用独立 HTTPS 入口（端口
          {{ state.agent_https_port }}），不随网页协议切换；证书和 CA
          继续由平台管理。
        </p>
        <p v-if="migrationRequired" class="notice danger">
          仍有 {{ state?.agents_on_web }} 个 Agent 使用旧网页入口。请先在下方
          Agent 接入设置中保存独立地址并同步，再切换 HTTP 或关闭网页。
        </p>
        <p
          v-if="needsHttps && state && !state.https_ready"
          class="notice danger"
        >
          当前没有可用的 HTTPS 证书。请先准备有效证书，再切换；不会关闭现有 HTTP
          入口。
        </p>
        <p v-if="!form.web_enabled">
          关闭网页会停止网页管理；Agent 接入启用时仍保留 HTTPS Agent 通道，SSH
          入口不受此开关控制。
        </p>
        <label v-if="!form.web_enabled" class="ack"
          ><input
            v-model="confirmedDisable"
            type="checkbox"
          />我已保存本机恢复命令，确认关闭网页管理</label
        >
        <p v-if="state?.active_terminals && needsRestart" class="notice">
          当前有 {{ state.active_terminals }} 个活跃终端，请结束后刷新再切换。
        </p>
        <p class="muted">
          网页设置单独应用，已有 Agent 和 SSH
          会话继续运行；变更设备接入方式或首次加载证书时需要重载，请先结束活跃任务和终端。
          HTTP/HTTPS 切换后在新入口登录确认；2
          分钟内未确认会恢复原网页设置。有外部代理时，代理协议也需匹配。
        </p>
        <div class="actions">
          <button
            type="submit"
            class="button primary"
            :disabled="
              !dirty ||
              migrationRequired ||
              (needsHttps && !state?.https_ready) ||
              (!!state?.active_terminals && needsRestart) ||
              (!form.web_enabled && !confirmedDisable)
            "
          >
            保存并应用
          </button>
        </div>
      </fieldset>
    </form>
    <button
      type="button"
      class="button secondary"
      :disabled="busy || polling"
      @click="load()"
    >
      刷新运行设置
    </button>
    <details v-if="state">
      <summary>关闭网页后的恢复方式</summary>
      <p>
        在平台服务器的项目目录执行，然后打开网页，在系统设置中确认保留配置。
      </p>
      <code>{{ state.recovery_command }}</code>
      <button
        type="button"
        class="button secondary small"
        @click="copyRecovery"
      >
        复制恢复命令
      </button>
    </details>
  </section>
</template>
<style scoped>
.deployment-panel {
  padding: 24px;
  margin-bottom: 20px;
}
fieldset {
  border: 0;
  margin: 0;
  padding: 0;
  display: grid;
  gap: 14px;
}
label {
  display: grid;
  gap: 8px;
  margin: 0;
}
.deployment-options {
  display: grid;
  grid-template-columns: repeat(3, minmax(0, 1fr));
  gap: 16px;
  margin: 20px 0 4px;
}
select {
  margin: 0;
  padding-block: 9px;
  padding-left: 9px;
}
.ack {
  display: flex;
  align-items: center;
}
.ack input {
  width: auto;
}
p {
  line-height: 1.8;
  margin: 4px 0;
}
.actions,
details {
  margin: 16px 0;
}
code {
  display: block;
  white-space: pre-wrap;
  overflow-wrap: anywhere;
  margin: 12px 0;
}
@media (max-width: 800px) {
  .deployment-options {
    grid-template-columns: 1fr;
  }
}
@media (max-width: 600px) {
  .deployment-panel {
    padding: 18px;
  }
}
</style>
