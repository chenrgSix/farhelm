<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, ref } from "vue";
import { api } from "../api/client";
import { formatTime } from "../model";

const emit = defineEmits<{ close: []; added: [] }>();
const name = ref("");
const serverUrl = ref("");
const runUser = ref("farhelm");
const ttl = ref(3600);
const startMode = ref("auto");
const allowSudo = ref(false);
const architectures = ref<string[]>([]);
const loaded = ref(false);
const busy = ref(false);
const error = ref("");
const copied = ref(false);
const commandField = ref<HTMLTextAreaElement>();
const firstField = ref<HTMLInputElement>();
const result = ref<{ id: string; command: string; expires_at: number }>();
const status = ref("waiting");
const statusError = ref("");
let disposed = false;
let pollTimer: ReturnType<typeof setTimeout> | undefined;
const statusText = computed(
  () =>
    ({
      waiting: "等待目标服务器执行安装命令…",
      registered: "设备已注册，等待 Agent 上线…",
      online: "设备已注册并在线，可以关闭窗口后连接终端。",
      expired: "安装命令已过期，请重新生成。",
      revoked: "设备已被撤销。",
    })[status.value],
);
const isLoopback = computed(() => {
  try {
    return ["localhost", "127.0.0.1", "[::1]"].includes(
      new URL(serverUrl.value).hostname,
    );
  } catch {
    return false;
  }
});
function message(e: unknown) {
  const raw = e instanceof Error ? e.message : "请求失败";
  if (raw.includes("AGENT_PACKAGES_UNAVAILABLE"))
    return "平台尚未准备 Agent 安装包，请联系管理员。";
  if (raw.includes("INVALID_AGENT_SERVER_URL"))
    return "平台地址必须是 HTTPS 地址，不包含路径、账号或查询参数。";
  if (raw.includes("INVALID_AGENT_USER"))
    return "请输入普通 Linux 账号名，不能使用 root。";
  return raw;
}
async function load() {
  error.value = "";
  try {
    const options = await api.request<{
      server_url: string;
      architectures: string[];
    }>("/agent-install/options");
    if (disposed) return;
    serverUrl.value = options.server_url;
    architectures.value = options.architectures;
    loaded.value = true;
    await nextTick();
    firstField.value?.focus();
  } catch (e) {
    if (!disposed) error.value = message(e);
  }
}
async function poll() {
  if (disposed || !result.value) return;
  try {
    const response = await api.request<{ status: string }>(
      `/agent-installations/${result.value.id}`,
    );
    if (disposed) return;
    status.value = response.status;
    statusError.value = "";
    if (["online", "expired", "revoked"].includes(response.status)) {
      if (response.status === "online") emit("added");
      return;
    }
  } catch {
    if (!disposed) statusError.value = "暂时无法读取注册进度，正在重试。";
  }
  if (!disposed) pollTimer = setTimeout(poll, 2000);
}
async function generate() {
  if (
    busy.value ||
    !loaded.value ||
    !architectures.value.length ||
    result.value
  )
    return;
  busy.value = true;
  error.value = "";
  try {
    const response = await api.request<{
      id: string;
      command: string;
      expires_at: number;
    }>("/agent-installations", {
      method: "POST",
      body: {
        v: 1,
        name: name.value.trim(),
        server_url: serverUrl.value.trim(),
        run_user: runUser.value.trim(),
        ttl_seconds: ttl.value,
        start_mode: startMode.value,
        allow_sudo: allowSudo.value,
      },
    });
    if (disposed) return;
    result.value = response;
    status.value = "waiting";
    void poll();
  } catch (e) {
    if (!disposed) error.value = message(e);
  } finally {
    if (!disposed) busy.value = false;
  }
}
async function copy() {
  try {
    await navigator.clipboard.writeText(result.value!.command);
    if (!disposed) copied.value = true;
  } catch {
    commandField.value?.focus();
    commandField.value?.select();
    error.value = "浏览器未允许自动复制，已选中命令，请手动复制。";
  }
}
onMounted(load);
onBeforeUnmount(() => {
  disposed = true;
  clearTimeout(pollTimer);
  result.value = undefined;
});
</script>

<template>
  <div class="install-overlay" @keydown.esc="!busy && emit('close')">
    <section
      class="panel install-panel"
      role="dialog"
      aria-modal="true"
      aria-labelledby="agent-install-title"
    >
      <header class="panel-heading">
        <div>
          <h2 id="agent-install-title">添加设备 · Agent 接入</h2>
          <p class="muted">生成安装命令，在目标 Linux 服务器执行后自动注册。</p>
        </div>
        <button
          class="icon-button"
          aria-label="关闭 Agent 接入"
          :disabled="busy"
          @click="emit('close')"
        >
          ×
        </button>
      </header>
      <form class="install-form" @submit.prevent="generate">
        <p v-if="error" class="text-warning" role="alert">{{ error }}</p>
        <p v-if="!loaded && !error">正在读取安装配置…</p>
        <button
          v-if="!loaded && error"
          type="button"
          class="button secondary"
          @click="load"
        >
          重试
        </button>
        <template v-if="loaded && !result">
          <fieldset :disabled="busy">
            <label
              >设备名称<input
                ref="firstField"
                v-model="name"
                required
                maxlength="128"
                placeholder="例如：生产服务器 / 华东"
                autocomplete="off"
            /></label>
            <label
              >平台地址<input
                v-model="serverUrl"
                type="url"
                required
                placeholder="https://fleet.example.com"
                maxlength="2048"
            /></label>
            <p class="field-hint">
              填写目标服务器可访问的 HTTPS
              地址，证书须包含该主机名。安装命令会自动携带平台配置的 CA。
            </p>
            <p v-if="isLoopback" class="text-warning">
              当前是本机地址。安装到其他服务器时，请改成目标服务器能够访问的平台地址。
            </p>
            <div class="install-columns">
              <label
                >运行账号<input
                  v-model="runUser"
                  required
                  pattern="[a-z_][a-z0-9_\-]{0,31}"
                  maxlength="32"
                  autocomplete="off"
              /></label>
              <label
                >命令有效期<select v-model.number="ttl">
                  <option :value="600">10 分钟</option>
                  <option :value="3600">1 小时</option>
                  <option :value="86400">24 小时</option>
                </select></label
              >
            </div>
            <p class="field-hint">
              使用普通 Linux 账号；不存在时自动创建。安装需要 root 或 sudo
              权限。
            </p>
            <label
              >启动方式<select v-model="startMode">
                <option value="auto">自动选择（优先 systemd）</option>
                <option value="systemd">systemd 服务 · 开机自启</option>
                <option value="background">
                  后台运行 · 适用于容器，无开机自启
                </option>
              </select></label
            >
            <label class="install-check"
              ><input
                v-model="allowSudo"
                type="checkbox"
              />允许终端使用该账号已有的 sudo 权限</label
            >
            <p class="field-hint">
              不会设置密码或修改 sudoers。设备上线后可在「接入配置」中保存可选
              sudo 密码。
            </p>
            <p v-if="architectures.length" class="field-hint">
              自动识别架构，平台已提供：{{ architectures.join("、") }}。目标需要
              Bash、curl 和常用 Linux 系统工具。
            </p>
            <p v-else class="text-warning" role="alert">
              平台尚未准备 Agent 安装包，请联系管理员。
            </p>
          </fieldset>
          <div class="install-actions">
            <button
              class="button primary"
              :disabled="busy || !architectures.length"
            >
              {{ busy ? "生成中…" : "生成安装命令" }}</button
            ><button
              type="button"
              class="button secondary"
              :disabled="busy"
              @click="emit('close')"
            >
              取消
            </button>
          </div>
        </template>
        <template v-if="result">
          <p>
            <strong>{{ name }}</strong> · {{ runUser }} · {{ serverUrl }}
          </p>
          <label
            >安装命令<textarea
              ref="commandField"
              :value="result.command"
              readonly
              rows="7"
              spellcheck="false"
              autocomplete="off"
            />
          </label>
          <p class="field-hint">
            复制整条命令到目标服务器执行。包含一次性注册凭据，请勿分享；关闭窗口后不再展示。有效至
            {{ formatTime(result.expires_at) }}。
          </p>
          <p class="install-status" role="status">{{ statusText }}</p>
          <p v-if="statusError" class="text-warning">{{ statusError }}</p>
          <div class="install-actions">
            <button
              type="button"
              class="button primary"
              :disabled="
                status === 'expired' ||
                status === 'online' ||
                status === 'revoked'
              "
              @click="copy"
            >
              {{ copied ? "已复制安装命令" : "复制安装命令" }}
            </button>
            <button
              v-if="status === 'expired'"
              type="button"
              class="button secondary"
              @click="
                result = undefined;
                copied = false;
              "
            >
              重新填写
            </button>
            <button
              type="button"
              class="button secondary"
              @click="emit('close')"
            >
              完成
            </button>
          </div>
        </template>
      </form>
    </section>
  </div>
</template>

<style scoped>
.install-overlay {
  position: fixed;
  inset: 0;
  z-index: 80;
  background: #10202c80;
  display: grid;
  place-items: center;
  padding: 20px;
}
.install-panel {
  width: min(720px, 100%);
  max-height: calc(100dvh - 40px);
  overflow: auto;
}
.panel-heading {
  padding: 20px 24px 12px;
  align-items: flex-start;
  position: sticky;
  top: 0;
  background: white;
  z-index: 2;
  border-bottom: 1px solid #e4ebef;
}
.panel-heading p {
  margin-top: 7px;
}
.install-form {
  padding: 0 24px 24px;
  display: grid;
  gap: 16px;
}
fieldset {
  border: 0;
  margin: 0;
  padding: 0;
  display: grid;
  gap: 14px;
  min-width: 0;
}
label {
  display: grid;
  gap: 7px;
  font-size: 13px;
  font-weight: 600;
  min-width: 0;
  margin: 0;
}
input,
textarea,
select {
  width: 100%;
  box-sizing: border-box;
  margin-top: 0;
}
textarea {
  resize: vertical;
  font: 12px/1.6 monospace;
  overflow-wrap: anywhere;
}
.install-columns {
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: 16px;
}
.install-check {
  display: flex;
  align-items: center;
  font-weight: 400;
}
.install-check input {
  width: auto;
}
.install-actions {
  display: flex;
  flex-wrap: wrap;
  gap: 10px;
  position: sticky;
  bottom: -24px;
  background: white;
  padding: 12px 0;
  border-top: 1px solid #e4ebef;
}
.install-status {
  color: #19705c;
}
p {
  margin: 0;
  overflow-wrap: anywhere;
}
@media (max-width: 600px) {
  .install-overlay {
    padding: 10px;
  }
  .install-panel {
    max-height: calc(100dvh - 20px);
  }
  .panel-heading {
    padding: 16px;
  }
  .install-form {
    padding: 0 16px 16px;
  }
  .install-columns {
    grid-template-columns: 1fr;
  }
  .install-actions {
    bottom: -16px;
  }
}
</style>
