<script setup lang="ts">
import { onBeforeUnmount, onMounted, ref } from "vue";
import { api } from "../api/client";
type Account = {
  id: string;
  name: string;
  username: string;
  method: "default" | "ssh" | "sudo";
  is_default?: boolean;
  revision: number;
  allowed_users: string[];
  allowed_groups: string[];
  allowed_roles: string[];
};
const props = defineProps<{
  deviceId: string;
  deviceName: string;
  manage?: boolean;
}>();
const emit = defineEmits<{
  close: [];
  selected: [account?: Account];
  changed: [];
  connection: [];
  authorize: [];
}>();
const accounts = ref<Account[]>([]);
const formOpen = ref(false);
const loaded = ref(false),
  busy = ref(false),
  error = ref(""),
  message = ref("");
const editing = ref<Account>();
const name = ref(""),
  username = ref("root"),
  method = ref<"ssh" | "sudo">("sudo"),
  password = ref(""),
  key = ref(""),
  passphrase = ref("");
const path = `/devices/${encodeURIComponent(props.deviceId)}/accounts`;
let disposed = false;
const errors: Record<string, string> = {
  CONNECTION_HAS_ACTIVE_SESSIONS: "设备仍有活跃终端，请先结束会话再修改账号。",
  TARGET_ACCOUNT_CHANGED_RELOAD: "账号已被修改，请重新打开面板后编辑。",
  SSH_NOT_CONFIGURED: "请先在设备接入配置中设置 SSH 地址和主机指纹。",
  SUDO_AGENT_REQUIRED:
    "sudo 切换目前需要 Agent 接入，源账号为 Agent 的运行账号。",
  SUDO_PASSWORD_REQUIRED: "请填写源账号的 sudo 密码。",
  INVALID_SUDO_PASSWORD: "密码不能包含换行或空字符。",
  SSH_PRIVATE_KEY_REQUIRED: "请填写目标账号的 SSH 私钥。",
  SSH_PRIVATE_KEY_INVALID_OR_PASSPHRASE_REQUIRED: "SSH 私钥或私钥口令无效。",
  INVALID_ACCOUNT_USERS: "所选用户已停用或不存在，请重新打开面板。",
  INVALID_ACCOUNT_GROUPS: "所选用户组不存在，请重新打开面板。",
  INVALID_ACCOUNT_ROLES: "所选角色不存在，请重新打开面板。",
};
function report(e: unknown) {
  const text = e instanceof Error ? e.message : "请求失败";
  error.value =
    Object.entries(errors).find(([code]) => text.includes(code))?.[1] ?? text;
}
async function load() {
  try {
    const result = await api.request<{
      accounts: Account[];
    }>(`/devices/${encodeURIComponent(props.deviceId)}/login-accounts`);
    if (disposed) return;
    accounts.value = result.accounts;
    loaded.value = true;
    if (
      !props.manage &&
      result.accounts.length === 1 &&
      result.accounts[0]!.is_default
    )
      emit("selected", result.accounts[0]);
  } catch (e) {
    if (!disposed) report(e);
  }
}
function edit(account?: Account) {
  editing.value = account;
  name.value = account?.name ?? "";
  username.value = account?.username ?? "root";
  method.value = account?.method === "ssh" ? "ssh" : "sudo";
  formOpen.value = true;
  password.value = key.value = passphrase.value = "";
  error.value = message.value = "";
}
async function save() {
  if (busy.value) return;
  busy.value = true;
  error.value = message.value = "";
  try {
    await api.request(editing.value ? `${path}/${editing.value.id}` : path, {
      method: editing.value ? "PUT" : "POST",
      body: {
        v: 1,
        ...(editing.value ? { revision: editing.value.revision } : {}),
        name: name.value.trim(),
        username: username.value.trim(),
        method: method.value,
        ...(method.value === "sudo"
          ? password.value
            ? { sudo_password: password.value }
            : {}
          : {
              ...(key.value ? { private_key: key.value } : {}),
              ...(passphrase.value ? { passphrase: passphrase.value } : {}),
            }),
      },
    });
    if (disposed) return;
    edit();
    formOpen.value = false;
    await load();
    message.value = "登录账号已保存，密码和私钥不会返回浏览器。";
    emit("changed");
  } catch (e) {
    if (!disposed) report(e);
  } finally {
    if (!disposed) busy.value = false;
  }
}
async function remove(account: Account) {
  if (
    busy.value ||
    !window.confirm(
      `删除登录账号「${account.name}」？只删除平台配置，不删除 Linux 账号。`,
    )
  )
    return;
  busy.value = true;
  error.value = "";
  try {
    await api.request(`${path}/${account.id}`, {
      method: "DELETE",
      body: { v: 1, revision: account.revision },
    });
    if (disposed) return;
    edit();
    formOpen.value = false;
    await load();
    emit("changed");
  } catch (e) {
    if (!disposed) report(e);
  } finally {
    if (!disposed) busy.value = false;
  }
}
onMounted(load);
onBeforeUnmount(() => {
  disposed = true;
  password.value = key.value = passphrase.value = "";
});
</script>
<template>
  <div class="accounts-overlay" @keydown.esc="!busy && emit('close')">
    <section
      class="accounts-panel"
      role="dialog"
      aria-modal="true"
      :aria-label="`${manage ? '登录账号管理' : '选择登录账号'}：${deviceName}`"
    >
      <header>
        <h2>
          {{ manage ? "登录账号管理" : "选择登录账号" }} · {{ deviceName }}
        </h2>
        <button
          class="icon-button"
          aria-label="关闭账号窗口"
          :disabled="busy"
          @click="emit('close')"
        >
          ×
        </button>
      </header>
      <p v-if="error" class="notice danger" role="alert">{{ error }}</p>
      <p v-if="message" role="status">{{ message }}</p>
      <p v-if="!loaded && !error">正在读取账号…</p>
      <div v-if="loaded" class="account-list">
        <div v-for="account in accounts" :key="account.id" class="account-row">
          <div>
            <strong>{{ account.name }}</strong>
            <p>
              {{ account.username }} ·
              {{
                account.is_default
                  ? "沿用设备接入配置，支持 Agent／SSH 原有通道"
                  : account.method === "sudo"
                    ? "从 Agent 运行账号经 sudo 切换"
                    : "直接 SSH 登录"
              }}
            </p>
          </div>
          <template v-if="manage && account.is_default"
            ><button
              class="text-button"
              :disabled="busy"
              @click="emit('connection')"
            >
              配置默认账号
            </button></template
          >
          <template v-else-if="manage"
            ><button
              class="text-button"
              :disabled="busy"
              @click="edit(account)"
            >
              编辑</button
            ><button
              class="text-button"
              :disabled="busy"
              @click="remove(account)"
            >
              删除
            </button></template
          >
          <button
            v-else
            class="button primary small"
            @click="emit('selected', account)"
          >
            连接
          </button>
        </div>
      </div>
      <p v-if="loaded && !accounts.length && !manage" class="notice">
        尚未获授任何登录账号，请联系管理员。
      </p>
      <div v-if="manage && loaded" class="account-tools">
        <button class="button primary" :disabled="busy" @click="edit()">
          新增登录账号</button
        ><button
          class="button secondary"
          :disabled="busy"
          @click="emit('authorize')"
        >
          管理访问授权
        </button>
      </div>
      <p v-if="manage" class="field-hint">
        这里管理登录身份与凭据。谁能使用哪些账号，统一在「访问控制 →
        访问授权」中配置；默认账号沿用现有接入凭据。
      </p>
      <form v-if="manage && loaded && formOpen" @submit.prevent="save">
        <h3>{{ editing ? "编辑登录账号" : "新增登录账号" }}</h3>
        <fieldset :disabled="busy">
          <label
            >账号名称<input
              v-model="name"
              required
              maxlength="128"
              placeholder="例如：生产 root 运维"
          /></label>
          <label
            >目标 Linux 账号<input
              v-model="username"
              required
              maxlength="32"
              pattern="[a-z_][a-z0-9_\-]{0,31}"
          /></label>
          <label
            >登录／切换方式<select v-model="method">
              <option value="sudo">sudo 切换（源账号为 Agent 运行账号）</option>
              <option value="ssh">直接 SSH 登录</option>
            </select></label
          >
          <template v-if="method === 'sudo'">
            <label
              >源账号的 sudo 密码<input
                v-model="password"
                type="password"
                autocomplete="new-password"
                maxlength="1024"
                :placeholder="
                  editing
                    ? '留空保留已保存的密码'
                    : '留空使用设备接入配置中已保存的 sudo 密码'
                "
            /></label>
            <p class="field-hint">
              Agent 须支持账号切换并启用终端提权。源账号须已有切换到目标账号的
              sudo 权限。
            </p>
          </template>
          <template v-else>
            <label
              >SSH 私钥<textarea
                v-model="key"
                rows="4"
                autocomplete="off"
                :required="!editing || editing.method !== method"
                placeholder="编辑时留空保留原私钥"
              />
            </label>
            <label
              >私钥口令（可选）<input
                v-model="passphrase"
                type="password"
                autocomplete="new-password"
            /></label>
            <p class="field-hint">
              地址、端口和主机指纹沿用设备的 SSH 接入配置；私钥应对应目标账号。
            </p>
          </template>
        </fieldset>
        <div class="form-actions">
          <button class="button primary" :disabled="busy">
            {{ busy ? "保存中…" : "保存登录账号" }}</button
          ><button
            type="button"
            class="button secondary"
            :disabled="busy"
            @click="formOpen = false"
          >
            取消编辑
          </button>
        </div>
      </form>
    </section>
  </div>
</template>
<style scoped>
.accounts-overlay {
  position: fixed;
  inset: 0;
  z-index: 120;
  background: #10243280;
  display: grid;
  place-items: center;
  padding: 16px;
}
.accounts-panel {
  width: min(720px, 100%);
  max-height: calc(100dvh - 32px);
  overflow: auto;
  background: white;
  border-radius: 12px;
  padding: 24px;
}
header,
.account-row,
.form-actions {
  display: flex;
  align-items: center;
  gap: 12px;
}
header {
  justify-content: space-between;
}
h2 {
  margin: 0;
  font-size: 18px;
}
h3 {
  margin: 20px 0 12px;
}
.account-list {
  display: grid;
  gap: 12px;
  margin: 20px 0;
}
.account-row {
  padding: 12px;
  border: 1px solid #dce6eb;
  border-radius: 8px;
}
.account-row div {
  flex: 1;
  min-width: 0;
  overflow-wrap: anywhere;
}
.account-row p {
  font-size: 12px;
  color: #627786;
  margin: 6px 0 0;
}
fieldset {
  border: 0;
  margin: 0;
  padding: 0;
  display: grid;
  gap: 12px;
}
label {
  display: grid;
  gap: 6px;
  font-size: 13px;
  font-weight: 600;
}
input,
select,
textarea {
  width: 100%;
  padding: 10px;
  border: 1px solid #d3dfe5;
  border-radius: 6px;
  font: inherit;
}
.field-hint {
  font-size: 12px;
  color: #647886;
  line-height: 1.7;
  margin: 0;
}
.account-tools {
  display: flex;
  gap: 12px;
  flex-wrap: wrap;
  margin: 16px 0;
}
.form-actions {
  margin-top: 16px;
  flex-wrap: wrap;
}
@media (max-width: 600px) {
  .accounts-panel {
    padding: 16px;
  }
  .account-row {
    flex-wrap: wrap;
  }
}
</style>
