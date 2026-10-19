<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref, watch } from "vue";
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
type Resources = {
  devices: { id: string; name: string }[];
  accounts: Account[];
  rules: Rule[];
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
  selected = ref<string[]>([]),
  effectiveUser = ref("");
const result = ref<{
  user: { username: string; role_names: string[] };
  accounts: (Account & {
    allowed: boolean;
    reasons: string[];
    missing: string[];
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
const available = computed(
  () =>
    data.value?.accounts.filter(
      (a) =>
        a.device_id === device.value &&
        (subjectType.value !== "device_scope" || a.is_default),
    ) ?? [],
);
const deviceName = (id: string) =>
  data.value?.devices.find((d) => d.id === id)?.name ?? id;
const accountName = (id: string) => {
  const a = data.value?.accounts.find((a) => a.id === id);
  return a ? `${a.name} · ${a.username}` : id;
};
const rules = computed(
  () =>
    data.value?.rules.filter(
      (r) =>
        (!props.deviceId || r.device_id === props.deviceId) &&
        `${r.subject_name} ${deviceName(r.device_id)} ${accountName(r.account_id)}`
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
  } catch (e) {
    if (!disposed) report(e);
  } finally {
    if (!disposed) loading.value = false;
  }
}
watch(device, () => {
  selected.value = [];
});
watch(subjectType, () => {
  selected.value = [];
  subjectId.value = "";
});
watch(
  () => props.deviceId,
  (value) => {
    device.value = value ?? "";
  },
);
async function save() {
  if (busy.value) return;
  busy.value = true;
  error.value = "";
  notice.value = "";
  try {
    await api.request("/access-authorizations", {
      method: "POST",
      body: {
        v: 1,
        device_id: device.value,
        account_ids: selected.value,
        subject_type: subjectType.value,
        subject_id:
          subjectType.value === "device_scope" ? null : subjectId.value,
      },
    });
    if (disposed) return;
    editing.value = false;
    selected.value = [];
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
      `删除「${rule.subject_name} → ${deviceName(rule.device_id)} → ${accountName(rule.account_id)}」的授权？失去访问权限的终端会结束。`,
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
    :aria-label="effective ? '权限核对' : '访问授权'"
  >
    <div class="authorization-heading">
      <div>
        <h2>{{ effective ? "权限核对" : "访问授权" }}</h2>
        <p class="muted">
          {{
            effective
              ? "查看用户最终可用的登录账号、授权来源及缺失权限。"
              : "统一配置谁可以使用哪些设备上的哪些登录账号。角色决定可执行的操作，登录账号负责凭据和登录方式。"
          }}
        </p>
      </div>
      <button
        v-if="!effective"
        class="button primary"
        :disabled="loading || busy || !data?.devices.length"
        @click="editing = !editing"
      >
        {{ editing ? "收起表单" : "新增访问授权" }}
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
                <th>设备／登录账号</th>
                <th>结果</th>
                <th>授权来源</th>
              </tr>
            </thead>
            <tbody>
              <tr v-for="account in result.accounts" :key="account.id">
                <td data-label="设备／登录账号">
                  {{ deviceName(account.device_id) }}<br /><strong>{{
                    account.name
                  }}</strong>
                  · {{ account.username }}
                </td>
                <td data-label="结果">
                  {{
                    account.allowed
                      ? "允许使用"
                      : `不可使用：缺少 ${account.missing.join("、")}`
                  }}
                </td>
                <td data-label="授权来源">{{ account.reasons.join("；") }}</td>
              </tr>
            </tbody>
          </table>
        </div>
        <p v-if="!result.accounts.length" class="muted">
          该用户没有匹配的登录账号授权。
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
                <option value="device_scope">
                  继承原设备授权（仅默认账号）
                </option>
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
          <fieldset class="authorization-accounts">
            <legend>可使用的登录账号</legend>
            <label
              v-for="account in available"
              :key="account.id"
              class="authorization-check"
              ><input
                v-model="selected"
                type="checkbox"
                :value="account.id"
              />{{ account.name }} · {{ account.username
              }}<small>{{
                account.is_default
                  ? "沿用接入配置"
                  : account.method === "sudo"
                    ? "sudo 切换"
                    : "直接 SSH"
              }}</small></label
            >
          </fieldset>
          <p class="field-hint">
            新授权同时授予该设备的访问范围和所选账号使用权，不授予其他账号。终端连接及
            sudo／特权操作仍需相应角色权限。默认账号“继承原设备授权”只沿用旧设备范围，不会接纳仅通过新规则取得的设备范围。
          </p>
          <button class="button primary" :disabled="busy || !selected.length">
            {{ busy ? "保存中…" : "保存访问授权" }}
          </button>
        </fieldset>
      </form>
      <label class="authorization-search"
        >搜索授权<input
          v-model="search"
          type="search"
          placeholder="搜索人员、用户组、角色、设备或账号"
      /></label>
      <div v-if="rules.length" class="authorization-table">
        <table>
          <thead>
            <tr>
              <th>授权对象</th>
              <th>设备／登录账号</th>
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
              <td data-label="设备／登录账号">
                {{ deviceName(rule.device_id) }}<br />{{
                  accountName(rule.account_id)
                }}
              </td>
              <td data-label="来源">
                {{
                  rule.subject_type === "device_scope"
                    ? "保留原设备访问范围"
                    : rule.legacy_scope
                      ? "原账号授权，仍受原设备范围限制"
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
.authorization-accounts {
  max-height: 280px;
  overflow-y: auto;
  margin: 20px 0;
}
.authorization-accounts legend {
  font-weight: 600;
  margin-bottom: 8px;
}
.authorization-check {
  display: flex;
  align-items: center;
  gap: 8px;
  margin: 0;
  padding: 8px;
  overflow-wrap: anywhere;
}
.authorization-check input {
  width: 16px;
  height: 16px;
  margin: 0;
  flex: 0 0 16px;
  accent-color: var(--teal);
}
.authorization-check small {
  color: var(--muted);
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
