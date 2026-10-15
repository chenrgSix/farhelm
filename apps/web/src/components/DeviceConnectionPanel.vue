<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref } from "vue";
import { api } from "../api/client";
import type { Device, DeviceConnection } from "../api/types";
const props = defineProps<{ device?: Device }>();
const emit = defineEmits<{ close: []; changed: [] }>();
const kind = props.device?.connection_kind ?? (props.device ? "agent" : "ssh");
const sshEnabled = ref(kind === "ssh");
const deviceId = ref(props.device?.id ?? "");
const name = ref(props.device?.name ?? "");
const host = ref("");
const port = ref(22);
const username = ref("");
const fingerprint = ref("");
const confirmed = ref(false);
const privateKey = ref("");
const passphrase = ref("");
const sudoPassword = ref("");
const clearSudo = ref(false);
const clearPassphrase = ref(false);
const state = ref<DeviceConnection | null>(null);
const loaded = ref(!props.device);
const busy = ref(false);
const error = ref("");
const message = ref("");
const saved = ref("");
let disposed = false;
const ssh = computed(() => ({
  host: host.value.trim(),
  port: Number(port.value),
  username: username.value.trim(),
  fingerprint: fingerprint.value.trim(),
}));
const dirty = computed(
  () =>
    sshEnabled.value !== !!state.value?.ssh ||
    (sshEnabled.value && JSON.stringify(ssh.value) !== saved.value) ||
    !!sudoPassword.value ||
    clearSudo.value ||
    !!privateKey.value ||
    !!passphrase.value ||
    clearPassphrase.value,
);
const path = computed(
  () => `/devices/${encodeURIComponent(deviceId.value)}/connection`,
);
const errors: Record<string, string> = {
  CONNECTION_CHANGED_RELOAD: "配置已被修改，请关闭面板并重新打开后再编辑。",
  CONNECTION_HAS_ACTIVE_SESSIONS:
    "这台设备仍有活跃终端，请先结束会话后再修改配置。",
  SSH_HOST_KEY_UNAVAILABLE:
    "未能获取 SSH 主机指纹，请检查地址、端口及平台到目标机器的网络。",
  SSH_HOST_KEY_MISMATCH:
    "目标主机指纹与保存的指纹不一致，连接已拒绝。请核对主机身份。",
  SSH_AUTH_FAILED:
    "SSH 认证失败，请检查系统账号、私钥和目标机器的 authorized_keys。",
  SSH_PRIVATE_KEY_INVALID_OR_PASSPHRASE_REQUIRED:
    "私钥格式或口令不正确；请填写私钥，加密私钥还需要口令。",
  SSH_CONNECT_FAILED: "无法连接目标 SSH 服务，请检查网络、端口和服务状态。",
  SSH_CONNECT_TIMEOUT: "连接目标 SSH 服务超时。",
};
function report(e: unknown) {
  const text = e instanceof Error ? e.message : String(e);
  error.value =
    Object.entries(errors).find(([code]) => text.includes(code))?.[1] ?? text;
}
function apply(result: DeviceConnection) {
  state.value = result;
  deviceId.value = result.device_id;
  sshEnabled.value = kind === "ssh" || !!result.ssh;
  if (result.ssh) {
    host.value = result.ssh.host;
    port.value = result.ssh.port;
    username.value = result.ssh.username;
    fingerprint.value = result.ssh.fingerprint;
    confirmed.value = true;
  }
  saved.value = JSON.stringify(ssh.value);
  privateKey.value = passphrase.value = sudoPassword.value = "";
  clearSudo.value = clearPassphrase.value = false;
  loaded.value = true;
}
onMounted(async () => {
  if (!props.device) return;
  try {
    const result = await api.request<DeviceConnection>(path.value);
    if (!disposed) apply(result);
  } catch (e) {
    if (!disposed) report(e);
  }
});
onBeforeUnmount(() => {
  disposed = true;
  privateKey.value = passphrase.value = sudoPassword.value = "";
});
async function scan() {
  if (busy.value) return;
  busy.value = true;
  error.value = "";
  message.value = "";
  try {
    const result = await api.request<{ fingerprint: string }>("/ssh/host-key", {
      method: "POST",
      body: { v: 1, host: ssh.value.host, port: ssh.value.port },
    });
    if (disposed) return;
    fingerprint.value = result.fingerprint;
    confirmed.value = false;
    message.value = "已获取指纹，请与目标机器提供的主机指纹核对后确认。";
  } catch (e) {
    if (!disposed) report(e);
  } finally {
    busy.value = false;
  }
}
async function save() {
  if (busy.value || !loaded.value) return;
  if (sshEnabled.value && !confirmed.value) {
    error.value = "请先核对并确认目标主机指纹。";
    return;
  }
  busy.value = true;
  error.value = "";
  message.value = "";
  const creating = !deviceId.value;
  const body: Record<string, unknown> = { v: 1 };
  if (creating) body.name = name.value.trim();
  else body.revision = state.value?.revision ?? 0;
  if (sshEnabled.value) {
    body.ssh = ssh.value;
    if (privateKey.value) body.private_key = privateKey.value;
    if (passphrase.value) body.passphrase = passphrase.value;
    else if (clearPassphrase.value) body.passphrase = null;
  } else if (state.value?.ssh) body.ssh = null;
  if (kind === "agent") {
    if (clearSudo.value) body.sudo_password = null;
    else if (sudoPassword.value) body.sudo_password = sudoPassword.value;
  }
  try {
    const result = await api.request<DeviceConnection>(
      creating ? "/ssh-devices" : path.value,
      { method: creating ? "POST" : "PUT", body },
    );
    if (disposed) return;
    apply(result);
    message.value =
      kind === "ssh"
        ? "配置已保存，可测试连接或关闭面板进入终端。"
        : sshEnabled.value
          ? "备用 SSH 已保存，连接时优先使用 Agent，不可用时尝试 SSH。"
          : "配置已保存。sudo 密码仅加密保管，不会自动填入终端。";
    emit("changed");
  } catch (e) {
    if (!disposed) report(e);
  } finally {
    busy.value = false;
  }
}
async function testConnection() {
  if (busy.value || dirty.value || !state.value?.ssh || !sshEnabled.value)
    return;
  busy.value = true;
  error.value = "";
  message.value = "";
  try {
    const result = await api.request<DeviceConnection & { ok: boolean }>(
      path.value + "/test",
      { method: "POST", body: { v: 1, revision: state.value.revision } },
    );
    if (disposed) return;
    apply(result);
    if (result.ok) message.value = "连接成功：主机指纹及 SSH 密钥认证已通过。";
    else report(result.last_error ?? "SSH_CONNECT_FAILED");
    emit("changed");
  } catch (e) {
    if (!disposed) report(e);
  } finally {
    busy.value = false;
  }
}
</script>

<template>
  <div class="connection-overlay">
    <section
      class="panel connection-panel"
      role="dialog"
      aria-modal="true"
      aria-labelledby="connection-heading"
    >
      <header class="panel-heading">
        <div>
          <h2 id="connection-heading">
            {{
              props.device ? `接入配置 · ${props.device.name}` : "添加 SSH 设备"
            }}
          </h2>
          <p class="muted">
            接入方式：{{
              kind === "ssh"
                ? "SSH · 无需安装 Agent"
                : "Agent · 设备主动连接平台"
            }}
          </p>
        </div>
        <button
          class="icon-button"
          aria-label="关闭接入配置"
          :disabled="busy"
          @click="emit('close')"
        >
          ×
        </button>
      </header>
      <form class="connection-form" @submit.prevent="save">
        <p v-if="error" class="text-warning" role="alert">{{ error }}</p>
        <p v-if="message" class="connection-message" role="status">
          {{ message }}
        </p>
        <p v-if="!loaded">正在读取配置…</p>
        <template v-else>
          <fieldset :disabled="busy">
            <template v-if="kind === 'agent'">
              <label class="connection-check"
                ><input
                  v-model="sshEnabled"
                  type="checkbox"
                  aria-label="启用备用 SSH"
                />启用备用 SSH</label
              >
              <p class="field-hint">
                同一设备优先通过 Agent 连接；Agent
                离线、心跳失效或不支持终端时，尝试备用 SSH。现有会话不切换通道。
              </p>
              <p v-if="!sshEnabled && state?.ssh" class="field-hint">
                保存后将移除备用 SSH 配置和私钥，保留 Agent 与 sudo 密码配置。
              </p>
            </template>
            <template v-if="sshEnabled">
              <label v-if="!props.device"
                >设备名称<input
                  v-model="name"
                  required
                  maxlength="128"
                  :disabled="!!deviceId"
                  autocomplete="off"
              /></label>
              <div class="connection-address">
                <label
                  >SSH 地址<input
                    v-model="host"
                    required
                    maxlength="253"
                    placeholder="192.168.1.10 或主机名"
                    autocomplete="off"
                    @input="confirmed = false"
                /></label>
                <label
                  >SSH 端口<input
                    v-model.number="port"
                    type="number"
                    required
                    min="1"
                    max="65535"
                    @input="confirmed = false"
                /></label>
              </div>
              <label
                >SSH 账号<input
                  v-model="username"
                  required
                  maxlength="128"
                  autocomplete="off"
                  placeholder="目标机器的 Linux 用户名"
              /></label>
              <label
                >SSH 私钥{{
                  state?.has_private_key ? "（已保存，留空保持不变）" : ""
                }}<textarea
                  v-model="privateKey"
                  :required="!state?.has_private_key"
                  rows="5"
                  maxlength="32768"
                  spellcheck="false"
                  autocomplete="off"
                  placeholder="粘贴 OpenSSH 或 PEM 格式私钥"
                />
              </label>
              <label
                >私钥口令（可选{{
                  state?.has_passphrase ? "，已保存" : ""
                }}）<input
                  v-model="passphrase"
                  type="password"
                  maxlength="1024"
                  autocomplete="new-password"
                  :disabled="clearPassphrase"
                  placeholder="仅加密私钥需要；更换私钥时重新填写"
              /></label>
              <label v-if="state?.has_passphrase" class="connection-check"
                ><input
                  v-model="clearPassphrase"
                  type="checkbox"
                />清除已保存的私钥口令</label
              >
              <div class="connection-host-key">
                <label
                  >主机指纹<input
                    v-model="fingerprint"
                    required
                    pattern="SHA256:[A-Za-z0-9+/]{43}"
                    placeholder="SHA256:…"
                    autocomplete="off"
                    @input="confirmed = false"
                /></label>
                <button
                  type="button"
                  class="button secondary small"
                  :disabled="!host || !port"
                  @click="scan"
                >
                  获取主机指纹
                </button>
                <p class="field-hint">
                  获取后请与目标机器的主机指纹核对。平台连接时会验证该指纹，变化时拒绝连接。
                </p>
                <label class="connection-check"
                  ><input
                    v-model="confirmed"
                    type="checkbox"
                    :disabled="!fingerprint"
                  />已核对目标主机指纹</label
                >
              </div>
              <p class="field-hint">
                私钥和口令加密保存，保存后不再返回浏览器。有设备终端权限的用户可通过平台连接，无需获知私钥。
              </p>
            </template>
            <template v-if="kind === 'agent'">
              <label
                >sudo 密码（可选{{
                  state?.has_sudo_password ? "，已保存" : ""
                }}）<input
                  v-model="sudoPassword"
                  type="password"
                  maxlength="1024"
                  autocomplete="new-password"
                  :disabled="clearSudo"
                  placeholder="目标 Linux 账号的 sudo 密码；留空保持不变"
              /></label>
              <label v-if="state?.has_sudo_password" class="connection-check"
                ><input
                  v-model="clearSudo"
                  type="checkbox"
                  aria-label="清除已保存的 sudo 密码"
                />清除已保存的 sudo 密码</label
              >
              <p class="field-hint">
                仅管理员可设置或替换，保存后不可查看。目前仅加密保管；后续再配置使用及查看权限，不会自动执行
                sudo。
              </p>
            </template>
          </fieldset>
          <div class="connection-actions">
            <button
              type="submit"
              class="button primary"
              :disabled="busy || (sshEnabled && !confirmed)"
            >
              {{ busy ? "处理中…" : "保存配置" }}
            </button>
            <button
              v-if="sshEnabled && deviceId"
              type="button"
              class="button secondary"
              :disabled="busy || dirty || !state?.ssh"
              @click="testConnection"
            >
              测试已保存连接
            </button>
            <button
              type="button"
              class="button secondary"
              :disabled="busy"
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
.connection-overlay {
  position: fixed;
  inset: 0;
  z-index: 80;
  background: #10202c80;
  display: grid;
  place-items: center;
  padding: 20px;
}
.connection-panel {
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
.connection-form {
  padding: 0 24px 24px;
  display: grid;
  gap: 16px;
}
fieldset {
  border: 0;
  margin: 0;
  padding: 0;
  display: grid;
  gap: 16px;
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
textarea {
  width: 100%;
  box-sizing: border-box;
  margin-top: 0;
}
textarea {
  resize: vertical;
  font-family: monospace;
}
.connection-address {
  display: grid;
  grid-template-columns: 1fr 120px;
  gap: 16px;
}
.connection-check {
  display: flex;
  align-items: center;
  font-weight: 400;
}
.connection-check input {
  width: auto;
}
.connection-host-key {
  display: grid;
  gap: 12px;
  border: 1px solid #d8e2e7;
  padding: 14px;
  border-radius: 8px;
}
.connection-host-key button {
  justify-self: start;
}
.connection-actions {
  display: flex;
  flex-wrap: wrap;
  gap: 10px;
  position: sticky;
  bottom: 0;
  background: white;
  padding: 12px 0;
  border-top: 1px solid #e4ebef;
}
.connection-message {
  color: #19705c;
}
p {
  margin: 0;
  overflow-wrap: anywhere;
}
@media (max-width: 600px) {
  .connection-overlay {
    padding: 10px;
  }
  .connection-panel {
    max-height: calc(100dvh - 20px);
  }
  .panel-heading {
    padding: 16px;
  }
  .connection-form {
    padding: 0 16px 16px;
  }
  .connection-address {
    grid-template-columns: 1fr 95px;
    gap: 10px;
  }
}
</style>
