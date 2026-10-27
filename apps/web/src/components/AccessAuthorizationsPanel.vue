<script setup lang="ts">
import {
  computed,
  nextTick,
  onBeforeUnmount,
  onMounted,
  ref,
  watch,
} from "vue";
import { api } from "../api/client";
import type { AccessManagement } from "../api/types";
const props = defineProps<{ deviceId?: string; effective?: boolean }>();
type Account = {
  id: string;
  device_id: string;
  name: string;
  username: string;
  method: string;
  is_default: boolean;
};
type Rule = {
  id: string;
  device_id: string;
  account_id: string;
  subject_type: string;
  subject_id: string | null;
  subject_name: string;
  legacy_scope: boolean;
  revision: number;
};
type SudoRule = {
  id: string;
  device_id: string;
  subject_type: string;
  subject_id: string;
  subject_name: string;
  effect: "allow" | "deny";
  origin: "explicit" | "legacy";
  legacy_roles: string[];
  revision: number;
};
type Resources = {
  devices: { id: string; name: string }[];
  accounts: Account[];
  rules: Rule[];
  sudo_rules?: SudoRule[];
};
const data = ref<Resources>(),
  people = ref<AccessManagement>();
const busy = ref(false),
  loading = ref(false),
  error = ref(""),
  notice = ref(""),
  editing = ref(false),
  search = ref("");
const device = ref(props.deviceId ?? ""),
  subjectType = ref("group"),
  subjectId = ref(""),
  effectiveUser = ref("");
const editingSudo = ref(false),
  sudoType = ref("user"),
  sudoSubject = ref(""),
  sudoDevice = ref(props.deviceId ?? ""),
  sudoEffect = ref("allow");
const sudoSubjects = computed(() =>
  sudoType.value === "user"
    ? (people.value?.users.map((u) => ({ id: u.id, name: u.username })) ?? [])
    : sudoType.value === "group"
      ? (people.value?.groups ?? [])
      : (people.value?.roles ?? []),
);
const sudoRules = computed(
  () =>
    data.value?.sudo_rules?.filter(
      (r) =>
        (!props.deviceId || r.device_id === props.deviceId) &&
        `${r.subject_name} ${deviceName(r.device_id)}`
          .toLowerCase()
          .includes(search.value.toLowerCase()),
    ) ?? [],
);
watch(sudoType, () => {
  sudoSubject.value = "";
  if (sudoType.value !== "user") sudoEffect.value = "allow";
});

const result = ref<{
  user: { username: string; role_names: string[] };
  accounts: (Account & {
    allowed: boolean;
    reasons: string[];
    missing: string[];
    sudo_allowed?: boolean;
    sudo_reason?: string;
    sudo_sources?: string[];
  })[];
}>();
let disposed = false,
  effectiveRequest = 0;
const subjects = computed(() =>
  subjectType.value === "user"
    ? (people.value?.users
        .filter((u) => u.enabled)
        .map((u) => ({ id: u.id, name: u.username })) ?? [])
    : subjectType.value === "group"
      ? (people.value?.groups ?? [])
      : (people.value?.roles ?? []),
);
const ordinaryAccounts = computed(
  () =>
    data.value?.accounts.filter(
      (a) => a.is_default && a.method === "default",
    ) ?? [],
);
const effectiveAccounts = computed(
  () =>
    result.value?.accounts.filter(
      (a) => a.is_default && a.method === "default",
    ) ?? [],
);
const deviceName = (id: string) =>
  data.value?.devices.find((d) => d.id === id)?.name ?? id;
const rules = computed(
  () =>
    data.value?.rules.filter(
      (r) =>
        ordinaryAccounts.value.some(
          (a) => a.id === r.account_id && a.device_id === r.device_id,
        ) &&
        (!props.deviceId || r.device_id === props.deviceId) &&
        `${r.subject_name} ${deviceName(r.device_id)}`
          .toLowerCase()
          .includes(search.value.toLowerCase()),
    ) ?? [],
);
const labels: Record<string, string> = {
  user: "用户",
  group: "用户组",
  role: "角色",
  device_scope: "兼容规则",
};
function report(e: unknown) {
  const text = e instanceof Error ? e.message : "请求失败";
  error.value = text.includes("AUTHORIZATION_CHANGED_RELOAD")
    ? "授权已变更，请刷新后重试。"
    : text.includes("INVALID_AUTHORIZATION_SUBJECT")
      ? "授权对象已变更，请刷新后重选。"
      : text;
}
async function load() {
  loading.value = true;
  error.value = "";
  try {
    const [resources, access] = await Promise.all([
      api.request<Resources>("/access-authorizations"),
      api.request<AccessManagement>("/access"),
    ]);
    if (disposed) return;
    data.value = resources;
    people.value = access;
    if (!device.value) device.value = resources.devices[0]?.id ?? "";
    if (!sudoDevice.value) sudoDevice.value = device.value;
  } catch (e) {
    if (!disposed) report(e);
  } finally {
    if (!disposed) loading.value = false;
  }
}
watch(subjectType, () => {
  subjectId.value = "";
});
watch(
  () => props.deviceId,
  (value) => {
    device.value = value ?? "";
  },
);
async function save() {
  if (
    busy.value ||
    !device.value ||
    (subjectType.value !== "device_scope" && !subjectId.value)
  )
    return;
  busy.value = true;
  error.value = "";
  notice.value = "";
  try {
    await api.request("/access-authorizations", {
      method: "POST",
      body: {
        v: 1,
        device_id: device.value,
        subject_type: subjectType.value,
        subject_id:
          subjectType.value === "device_scope" ? null : subjectId.value,
      },
    });
    if (disposed) return;
    editing.value = false;
    await load();
    notice.value = "访问授权已保存。操作权限仍由角色决定。";
  } catch (e) {
    if (!disposed) report(e);
  } finally {
    if (!disposed) busy.value = false;
  }
}
async function remove(rule: Rule) {
  if (
    busy.value ||
    !window.confirm(
      `删除「${rule.subject_name} → ${deviceName(rule.device_id)} → 普通连接」的授权？失去访问权限的终端会结束。`,
    )
  )
    return;
  busy.value = true;
  error.value = "";
  try {
    await api.request(`/access-authorizations/${encodeURIComponent(rule.id)}`, {
      method: "DELETE",
      body: { v: 1, revision: rule.revision },
    });
    if (!disposed) {
      await load();
      notice.value = "授权已删除。其他授权来源仍会生效。";
    }
  } catch (e) {
    if (!disposed) report(e);
  } finally {
    if (!disposed) busy.value = false;
  }
}
function editSudo(rule?: SudoRule) {
  editingSudo.value = true;
  if (rule) {
    sudoType.value = rule.subject_type;
    sudoDevice.value = rule.device_id;
    sudoEffect.value = rule.effect;
  }
  // The type watcher clears the subject on the next tick; preserve it afterwards.
  if (rule)
    nextTick(() => {
      sudoSubject.value = rule.subject_id;
    });
}
async function saveSudo() {
  if (busy.value || !sudoDevice.value || !sudoSubject.value) return;
  busy.value = true;
  error.value = "";
  const current = data.value?.sudo_rules?.find(
    (r) =>
      r.device_id === sudoDevice.value &&
      r.subject_type === sudoType.value &&
      r.subject_id === sudoSubject.value,
  );
  try {
    await api.request("/access-authorizations/sudo", {
      method: "POST",
      body: {
        v: 1,
        device_id: sudoDevice.value,
        subject_type: sudoType.value,
        subject_id: sudoSubject.value,
        effect: sudoEffect.value,
        revision: current?.revision ?? 0,
      },
    });
    if (disposed) return;
    editingSudo.value = false;
    await load();
    notice.value =
      "sudo 授权已保存，有效权限改变的终端会关闭，重新连接后生效。";
  } catch (e) {
    if (!disposed) report(e);
  } finally {
    if (!disposed) busy.value = false;
  }
}
async function removeSudo(rule: SudoRule) {
  if (
    busy.value ||
    !window.confirm(
      `删除「${rule.subject_name} → ${deviceName(rule.device_id)}」的 sudo 规则？迁移规则删除后不会自动恢复，其他来源仍可能生效。`,
    )
  )
    return;
  busy.value = true;
  error.value = "";
  try {
    await api.request(
      `/access-authorizations/sudo/${encodeURIComponent(rule.id)}`,
      { method: "DELETE", body: { v: 1, revision: rule.revision } },
    );
    if (disposed) return;
    await load();
    notice.value = "sudo 规则已删除，请在权限核对中查看最终结果。";
  } catch (e) {
    if (!disposed) report(e);
  } finally {
    if (!disposed) busy.value = false;
  }
}
async function inspect() {
  const request = ++effectiveRequest;
  result.value = undefined;
  error.value = "";
  if (!effectiveUser.value) return;
  try {
    const response = await api.request<typeof result.value>(
      `/access-authorizations/effective/${encodeURIComponent(effectiveUser.value)}`,
    );
    if (!disposed && request === effectiveRequest) result.value = response;
  } catch (e) {
    if (!disposed && request === effectiveRequest) report(e);
  }
}
watch(effectiveUser, inspect);
onMounted(load);
onBeforeUnmount(() => {
  disposed = true;
});
</script>
<template>
  <section
    class="panel authorizations-panel"
    :aria-label="effective ? '权限核对' : '设备访问授权'"
  >
    <div class="authorization-heading">
      <div>
        <h2>{{ effective ? "权限核对" : "设备访问授权" }}</h2>
        <p class="muted">
          {{
            effective
              ? "查看用户对每台设备的连接、sudo 最终授权及来源。"
              : "普通连接和 sudo 分别授权到设备。sudo 授权不新增设备访问范围，密码仅用于已授权会话的自动代填。"
          }}
        </p>
      </div>
      <button
        v-if="!effective"
        class="button primary"
        :disabled="loading || busy || !data?.devices.length"
        @click="editing = !editing"
      >
        {{ editing ? "收起表单" : "新增连接授权" }}
      </button>
    </div>
    <p v-if="error" class="notice danger" role="alert">{{ error }}</p>
    <p v-if="notice" class="notice" role="status">{{ notice }}</p>
    <p v-if="loading">正在读取授权…</p>
    <template v-if="effective">
      <label
        >核对用户<select v-model="effectiveUser" aria-label="核对用户">
          <option value="">请选择用户</option>
          <option v-for="user in people?.users" :key="user.id" :value="user.id">
            {{ user.username }}{{ user.enabled ? "" : "（已停用）" }}
          </option>
        </select></label
      >
      <template v-if="result"
        ><p>生效角色：{{ result.user.role_names.join("、") || "无" }}</p>
        <div class="authorization-table">
          <table>
            <thead>
              <tr>
                <th>设备</th>
                <th>结果</th>
                <th>授权来源</th>
                <th>sudo 授权</th>
              </tr>
            </thead>
            <tbody>
              <tr v-for="account in effectiveAccounts" :key="account.id">
                <td data-label="设备">
                  {{ deviceName(account.device_id) }}
                </td>
                <td data-label="结果">
                  {{
                    account.allowed
                      ? "允许使用"
                      : `不可使用：缺少 ${account.missing.join("、")}`
                  }}
                </td>
                <td data-label="授权来源">{{ account.reasons.join("；") }}</td>
                <td data-label="sudo 授权">
                  {{ account.sudo_allowed ? "允许 sudo" : "禁止 sudo"
                  }}<br /><small>{{
                    account.sudo_reason === "USER_DENIED"
                      ? "用户明确禁止，覆盖用户组和角色授权"
                      : account.sudo_sources?.join("；") ||
                        "未授予本设备 sudo 权限"
                  }}</small>
                </td>
              </tr>
            </tbody>
          </table>
        </div>
        <p v-if="!effectiveAccounts.length" class="muted">
          该用户没有匹配的普通连接授权。
        </p></template
      >
    </template>
    <template v-else>
      <form v-if="editing" class="authorization-form" @submit.prevent="save">
        <fieldset :disabled="busy">
          <div class="authorization-fields">
            <label
              >授权对象类型<select
                v-model="subjectType"
                aria-label="授权对象类型"
              >
                <option value="group">用户组</option>
                <option value="user">用户</option>
                <option value="role">角色</option>
                <option value="device_scope">继承原设备授权</option>
              </select></label
            ><label v-if="subjectType !== 'device_scope'"
              >授权对象<select
                v-model="subjectId"
                aria-label="授权对象"
                required
              >
                <option value="" disabled>
                  请选择{{ labels[subjectType] }}
                </option>
                <option
                  v-for="subject in subjects"
                  :key="subject.id"
                  :value="subject.id"
                >
                  {{ "username" in subject ? subject.username : subject.name }}
                </option>
              </select></label
            ><label
              >设备<select
                v-model="device"
                aria-label="设备"
                :disabled="!!props.deviceId"
                required
              >
                <option
                  v-for="item in data?.devices"
                  :key="item.id"
                  :value="item.id"
                >
                  {{ item.name }}
                </option>
              </select></label
            >
          </div>
          <p class="field-hint">
            授予该设备的普通连接使用权。连接终端需角色权限，sudo 需另行授权；
            「继承原设备授权」只沿用原用户／用户组的设备范围。
          </p>
          <button
            class="button primary"
            :disabled="
              busy || !device || (subjectType !== 'device_scope' && !subjectId)
            "
          >
            {{ busy ? "保存中…" : "保存连接授权" }}
          </button>
        </fieldset>
      </form>
      <div class="authorization-heading">
        <div>
          <h3>设备 sudo 授权</h3>
          <p class="field-hint">
            用户明确禁止优先于所有允许；未配置用户规则时继承用户组、角色或迁移来源。设备提权开关和
            Linux 系统权限仍是上限。
          </p>
        </div>
        <button
          class="button secondary"
          :disabled="busy || loading"
          @click="editingSudo ? (editingSudo = false) : editSudo()"
        >
          {{ editingSudo ? "收起 sudo 表单" : "配置 sudo 授权" }}
        </button>
      </div>
      <form
        v-if="editingSudo"
        class="authorization-form"
        aria-label="配置 sudo 授权"
        @submit.prevent="saveSudo"
      >
        <fieldset :disabled="busy">
          <div class="authorization-fields">
            <label
              >授权对象类型<select
                v-model="sudoType"
                aria-label="sudo 授权对象类型"
              >
                <option value="user">用户</option>
                <option value="group">用户组</option>
                <option value="role">角色</option>
              </select></label
            >
            <label
              >授权对象<select
                v-model="sudoSubject"
                aria-label="sudo 授权对象"
                required
              >
                <option value="" disabled>请选择授权对象</option>
                <option
                  v-for="subject in sudoSubjects"
                  :key="subject.id"
                  :value="subject.id"
                >
                  {{ subject.name }}
                </option>
              </select></label
            >
            <label
              >设备<select
                v-model="sudoDevice"
                aria-label="sudo 设备"
                :disabled="!!props.deviceId"
                required
              >
                <option
                  v-for="item in data?.devices"
                  :key="item.id"
                  :value="item.id"
                >
                  {{ item.name }}
                </option>
              </select></label
            >
            <label
              >sudo 策略<select v-model="sudoEffect" aria-label="sudo 策略">
                <option value="allow">允许 sudo</option>
                <option v-if="sudoType === 'user'" value="deny">
                  明确禁止 sudo（覆盖继承）
                </option>
              </select></label
            >
          </div>
          <p class="field-hint">
            只有已获普通连接权限的用户才能使用本授权。未保存密码时不代填，系统免密
            sudo 和手动输入密码仅在获授权会话中可用。
          </p>
          <button
            class="button primary"
            :disabled="busy || !sudoSubject || !sudoDevice"
          >
            保存 sudo 授权
          </button>
        </fieldset>
      </form>
      <div v-if="sudoRules.length" class="authorization-table">
        <table>
          <thead>
            <tr>
              <th>授权对象</th>
              <th>设备</th>
              <th>sudo 策略</th>
              <th>来源</th>
              <th>操作</th>
            </tr>
          </thead>
          <tbody>
            <tr v-for="rule in sudoRules" :key="rule.id">
              <td data-label="授权对象">{{ rule.subject_name }}</td>
              <td data-label="设备">{{ deviceName(rule.device_id) }}</td>
              <td data-label="sudo 策略">
                {{ rule.effect === "allow" ? "允许 sudo" : "明确禁止 sudo" }}
              </td>
              <td data-label="来源">
                {{
                  rule.origin === "legacy"
                    ? `原 sudo 权限自动迁移：${rule.legacy_roles.join("、")}`
                    : labels[rule.subject_type] + "授权"
                }}
              </td>
              <td data-label="操作">
                <button
                  class="text-button"
                  :disabled="busy"
                  @click="editSudo(rule)"
                >
                  修改 sudo</button
                ><button
                  class="text-button"
                  :disabled="busy"
                  @click="removeSudo(rule)"
                >
                  删除 sudo 规则
                </button>
              </td>
            </tr>
          </tbody>
        </table>
      </div>
      <p v-else-if="!loading" class="field-hint">
        没有匹配的 sudo
        授权。新授权默认不允许提权，旧权限已按原用户、设备范围自动迁移。
      </p>
      <label class="authorization-search"
        >搜索授权<input
          v-model="search"
          type="search"
          placeholder="搜索人员、用户组、角色或设备"
      /></label>
      <div v-if="rules.length" class="authorization-table">
        <table>
          <thead>
            <tr>
              <th>授权对象</th>
              <th>设备</th>
              <th>来源</th>
              <th>操作</th>
            </tr>
          </thead>
          <tbody>
            <tr v-for="rule in rules" :key="rule.id">
              <td data-label="授权对象">
                <small>{{ labels[rule.subject_type] }}</small
                ><br /><strong>{{ rule.subject_name }}</strong>
              </td>
              <td data-label="设备">
                {{ deviceName(rule.device_id) }}
              </td>
              <td data-label="来源">
                {{
                  rule.subject_type === "device_scope"
                    ? "保留原设备访问范围"
                    : rule.legacy_scope
                      ? "原连接授权，仍受原设备范围限制"
                      : "访问授权规则"
                }}
              </td>
              <td data-label="操作">
                <button
                  class="text-button"
                  :disabled="busy"
                  @click="remove(rule)"
                >
                  删除
                </button>
              </td>
            </tr>
          </tbody>
        </table>
      </div>
      <p v-else-if="!loading" class="muted">
        暂无匹配的授权。管理员始终拥有全平台访问权限。
      </p>
      <p class="field-hint">
        已有配置和授权原样保留，并标明来源。用户组成员及继承角色实时参与匹配；删除某条规则后，其他来源的授权仍可生效。
      </p>
    </template>
  </section>
</template>
<style scoped>
.authorizations-panel {
  padding: 24px;
}
.authorization-heading {
  display: flex;
  justify-content: space-between;
  align-items: flex-start;
  gap: 16px;
}
.authorization-heading h2 {
  margin: 0;
}
.authorization-heading p {
  margin: 8px 0 0;
}
.authorization-form {
  margin: 20px 0;
  padding: 16px;
  border: 1px solid var(--border);
  border-radius: 8px;
  background: #f8fafb;
}
.authorization-fields {
  display: grid;
  grid-template-columns: repeat(3, minmax(0, 1fr));
  gap: 12px;
}
.authorization-fields label {
  margin-top: 0;
}
.authorization-table {
  max-width: 100%;
  overflow-x: auto;
  margin: 20px 0;
}
.authorization-table table {
  min-width: 580px;
  width: 100%;
}
.authorization-table td {
  overflow-wrap: anywhere;
}
.authorization-search {
  max-width: 480px;
}
.authorization-form .button {
  margin-top: 12px;
}
@media (max-width: 700px) {
  .authorization-table table {
    min-width: 0;
  }
  .authorization-table thead {
    display: none;
  }
  .authorization-table tbody,
  .authorization-table tr,
  .authorization-table td {
    display: block;
    width: 100%;
  }
  .authorization-table tr {
    border: 1px solid var(--border);
    border-radius: 8px;
    margin-bottom: 12px;
    padding: 6px 0;
  }
  .authorization-table td {
    border: 0;
    padding: 8px 12px;
  }
  .authorization-table td::before {
    content: attr(data-label);
    display: block;
    color: var(--muted);
    font-size: 11px;
    margin-bottom: 4px;
  }
  .authorizations-panel {
    padding: 16px;
  }
  .authorization-heading {
    flex-direction: column;
  }
  .authorization-fields {
    grid-template-columns: 1fr;
  }
}
</style>
