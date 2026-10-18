<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref } from "vue";
import { api, ApiError } from "../api/client";
import type { Device, Permission } from "../api/types";
import type { ApiToken, ApiTokenList } from "../api/tokens";
import { copyText } from "../clipboard";
import { formatTime } from "../model";

const windowOrigin = window.location.origin;
const props = defineProps<{ currentUserId: string; devices: Device[] }>();
const data = ref<ApiTokenList>();
const loading = ref(false),
  busy = ref(false),
  downloading = ref(false);
const error = ref(""),
  formError = ref(""),
  notice = ref(""),
  uncertain = ref(false);
const search = ref(""),
  open = ref(false),
  editing = ref<ApiToken>();
const revoked = ref<ApiToken>();
const secret = ref(""),
  createdName = ref("");
const initial = () => ({
  name: "",
  permissions: ["devices.read"] as Permission[],
  all: false,
  device_ids: [] as string[],
  days: "30",
  expires: "",
});
const draft = ref(initial());
const now = ref(Date.now());
let disposed = false,
  timer: ReturnType<typeof setInterval> | undefined;
const downloads = new Set<string>();
const tokens = computed(
  () =>
    data.value?.tokens.filter((t) =>
      `${t.name} ${t.owner_username ?? ""} ${t.prefix}`
        .toLowerCase()
        .includes(search.value.toLowerCase()),
    ) ?? [],
);
const groups = computed(() => [
  ...new Map(
    props.devices.flatMap((d) =>
      (d.device_groups ?? []).map((g) => [g.id, g] as const),
    ),
  ).values(),
]);
const status = (t: ApiToken) =>
  t.revoked_at !== null
    ? "revoked"
    : t.expires_at <= now.value
      ? "expired"
      : t.status;
const statusLabels = {
  active: "有效",
  revoked: "已撤销",
  expired: "已到期",
  owner_disabled: "账号不可用",
};
const permissionLabel = (p: Permission) =>
  data.value?.permissions.find((v) => v.id === p)?.label ?? p;
const scopeLabel = (t: ApiToken) =>
  t.device_scope === "*"
    ? "全部设备（含新增）"
    : t.device_scope.length
      ? `${t.device_scope.length} 台指定设备`
      : "无设备权限";
const localDate = (timestamp: number) => {
  const d = new Date(timestamp);
  return new Date(timestamp - d.getTimezoneOffset() * 60000)
    .toISOString()
    .slice(0, 16);
};
async function load() {
  if (loading.value) return;
  loading.value = true;
  error.value = "";
  try {
    const result = await api.request<ApiTokenList>("/api-tokens");
    if (!disposed) {
      data.value = result;
      now.value = Date.now();
    }
  } catch (e) {
    if (!disposed)
      error.value = e instanceof Error ? e.message : "读取令牌失败";
  } finally {
    if (!disposed) loading.value = false;
  }
}
function show(item?: ApiToken) {
  if (busy.value) return;
  editing.value = item;
  draft.value = initial();
  formError.value = "";
  uncertain.value = false;
  notice.value = "";
  if (item)
    Object.assign(draft.value, {
      name: item.name,
      permissions: [...item.permissions],
      all: item.device_scope === "*",
      device_ids: item.device_scope === "*" ? [] : [...item.device_scope],
      days: "custom",
      expires: localDate(item.expires_at),
    });
  open.value = true;
}
function selectGroup(id: string, checked: boolean) {
  const ids = props.devices
    .filter((d) => d.device_groups?.some((g) => g.id === id))
    .map((d) => d.id);
  draft.value.device_ids = checked
    ? [...new Set([...draft.value.device_ids, ...ids])]
    : draft.value.device_ids.filter((id) => !ids.includes(id));
}
function groupSelected(id: string) {
  return props.devices
    .filter((d) => d.device_groups?.some((g) => g.id === id))
    .every((d) => draft.value.device_ids.includes(d.id));
}
async function save() {
  if (busy.value || uncertain.value) return;
  formError.value = "";
  const expires_at =
    draft.value.days === "custom"
      ? new Date(draft.value.expires).getTime()
      : Date.now() + Number(draft.value.days) * 86400000;
  if (
    !Number.isFinite(expires_at) ||
    expires_at <= Date.now() + 1000 ||
    expires_at > Date.now() + 366 * 86400000
  ) {
    formError.value = "请选择未来一年内的到期时间";
    return;
  }
  if (!draft.value.permissions.length) {
    formError.value = "至少选择一项权限";
    return;
  }
  for (const p of ["tasks", "recordings", "audit"])
    if (
      draft.value.permissions.includes((p + ".read_all") as Permission) &&
      !draft.value.permissions.includes((p + ".read") as Permission)
    ) {
      formError.value = "查看他人记录需同时勾选对应的查看本人权限";
      return;
    }
  busy.value = true;
  try {
    const result = await api.request<{
      v: 1;
      token: ApiToken;
      secret?: string;
    }>(
      editing.value
        ? `/api-tokens/${encodeURIComponent(editing.value.id)}`
        : "/api-tokens",
      {
        method: editing.value ? "PUT" : "POST",
        body: {
          v: 1,
          name: draft.value.name.trim(),
          permissions: draft.value.permissions,
          device_scope: draft.value.all ? "*" : draft.value.device_ids,
          expires_at,
          ...(editing.value ? { revision: editing.value.revision } : {}),
        },
      },
    );
    if (disposed) return;
    open.value = false;
    draft.value = initial();
    if (result.secret) {
      secret.value = result.secret;
      createdName.value = result.token.name;
    } else notice.value = "令牌授权已更新";
    await load();
  } catch (e) {
    if (disposed) return;
    formError.value = e instanceof Error ? e.message : "保存失败";
    if (!(e instanceof ApiError) || !e.status || e.status >= 500) {
      uncertain.value = true;
      formError.value =
        "请求结果未确认。请关闭表单并刷新列表核实；若创建已成功但未收到密钥，撤销该令牌后重新创建。";
    } else if (e.status === 409) {
      uncertain.value = true;
      formError.value += "，请刷新列表后重新操作";
    }
  } finally {
    if (!disposed) busy.value = false;
  }
}
async function revoke() {
  if (!revoked.value || busy.value) return;
  busy.value = true;
  formError.value = "";
  try {
    await api.request(
      `/api-tokens/${encodeURIComponent(revoked.value.id)}/revoke`,
      { method: "POST", body: { v: 1 } },
    );
    if (disposed) return;
    revoked.value = undefined;
    notice.value = "令牌已撤销";
    await load();
  } catch (e) {
    if (!disposed)
      formError.value =
        e instanceof Error ? e.message : "撤销失败，可刷新后核实";
  } finally {
    if (!disposed) busy.value = false;
  }
}
async function copy() {
  try {
    await copyText(secret.value);
    if (!disposed) notice.value = "Token 已复制";
  } catch {
    if (!disposed) notice.value = "复制失败，请选中密钥框手动复制";
  }
}
async function download(kind: "skill" | "openapi") {
  if (downloading.value) return;
  downloading.value = true;
  error.value = "";
  try {
    const content =
      kind === "skill"
        ? await api.output("/api-skill", 2 * 1024 * 1024)
        : JSON.stringify(await api.request("/openapi.json"), null, 2);
    if (disposed) return;
    const url = URL.createObjectURL(
      new Blob([content], {
        type: kind === "skill" ? "application/gzip" : "application/json",
      }),
    );
    downloads.add(url);
    const link = document.createElement("a");
    link.href = url;
    link.download =
      kind === "skill" ? "farhelm-api-skill.tar.gz" : "farhelm-openapi.json";
    link.click();
    setTimeout(() => {
      URL.revokeObjectURL(url);
      downloads.delete(url);
    }, 1000);
  } catch (e) {
    if (!disposed) error.value = e instanceof Error ? e.message : "下载失败";
  } finally {
    if (!disposed) downloading.value = false;
  }
}
onMounted(() => {
  void load();
  timer = setInterval(() => {
    now.value = Date.now();
  }, 10000);
});
onBeforeUnmount(() => {
  disposed = true;
  secret.value = "";
  clearInterval(timer);
  for (const url of downloads) URL.revokeObjectURL(url);
});
</script>

<template>
  <section class="panel tokens-panel">
    <div class="token-toolbar">
      <div>
        <h2>API Token</h2>
        <p class="muted">
          为脚本和 AI 创建独立凭据。有效权限始终受所属账号当前授权限制。
        </p>
      </div>
      <div class="token-actions">
        <button
          class="button secondary"
          :disabled="loading || busy"
          @click="load"
        >
          刷新
        </button>
        <button class="button" :disabled="!data || busy" @click="show()">
          创建 Token
        </button>
      </div>
    </div>
    <p v-if="error" class="error" role="alert">{{ error }}</p>
    <p v-if="notice && !secret" class="notice" role="status">{{ notice }}</p>
    <div class="integration-help">
      <p>
        API 地址：<code>{{ windowOrigin }}/api/v1</code>
      </p>
      <p class="muted">
        Skill 解压后放入 AI 客户端的技能目录，单独配置平台网页地址和
        Token；不需要 MCP。令牌不能管理账号、系统设置或其他令牌。
      </p>
      <div class="token-actions">
        <button
          class="button secondary small"
          :disabled="downloading"
          @click="download('skill')"
        >
          下载配套 Skill</button
        ><button
          class="button secondary small"
          :disabled="downloading"
          @click="download('openapi')"
        >
          下载 OpenAPI 文档
        </button>
      </div>
    </div>
    <label class="token-search"
      >搜索令牌<input
        v-model="search"
        placeholder="名称、所属账号或前缀"
        type="search"
    /></label>
    <p v-if="loading && !data" class="muted">正在加载…</p>
    <div v-else class="table-wrap token-table">
      <table>
        <thead>
          <tr>
            <th>令牌 / 所属账号</th>
            <th>授权</th>
            <th>状态 / 到期时间</th>
            <th>最近使用</th>
            <th>操作</th>
          </tr>
        </thead>
        <tbody>
          <tr v-for="item in tokens" :key="item.id">
            <td>
              <strong>{{ item.name }}</strong
              ><small>{{ item.owner_username ?? item.owner_id }}</small
              ><code>{{ item.prefix }}…</code>
            </td>
            <td>
              <p>{{ item.permissions.map(permissionLabel).join("、") }}</p>
              <small>{{ scopeLabel(item) }}</small>
            </td>
            <td>
              <span>{{ statusLabels[status(item)] }}</span
              ><small>{{ formatTime(item.expires_at) }}</small>
            </td>
            <td>
              {{ item.last_used_at ? formatTime(item.last_used_at) : "尚未使用"
              }}<small v-if="item.last_used_address">{{
                item.last_used_address
              }}</small>
            </td>
            <td>
              <div class="token-actions">
                <button
                  v-if="
                    item.owner_id === currentUserId && status(item) === 'active'
                  "
                  class="text-button"
                  :disabled="busy"
                  @click="show(item)"
                >
                  编辑</button
                ><button
                  v-if="item.revoked_at === null"
                  class="text-button danger"
                  :disabled="busy"
                  @click="
                    revoked = item;
                    formError = '';
                  "
                >
                  撤销
                </button>
              </div>
            </td>
          </tr>
          <tr v-if="!tokens.length">
            <td colspan="5" class="muted">暂无匹配的 API Token</td>
          </tr>
        </tbody>
      </table>
    </div>
  </section>
  <Teleport to="body">
    <div
      v-if="open"
      class="modal-backdrop"
      @keydown.esc="!busy && (open = false)"
    >
      <section
        class="panel token-dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby="api-token-title"
      >
        <h2 id="api-token-title">
          {{ editing ? "编辑 Token" : "创建 Token" }}
        </h2>
        <form @submit.prevent="save">
          <label
            >用途名称<input
              v-model="draft.name"
              required
              maxlength="64"
              autocomplete="off"
              :disabled="busy"
              placeholder="例如：每日巡检"
          /></label>
          <fieldset :disabled="busy">
            <legend>权限</legend>
            <label
              v-for="p in data?.permissions"
              :key="p.id"
              class="token-check"
              ><input
                v-model="draft.permissions"
                type="checkbox"
                :value="p.id"
                :aria-label="p.label"
              /><span
                >{{ p.label }}<small>{{ p.description }}</small></span
              ></label
            >
          </fieldset>
          <fieldset :disabled="busy">
            <legend>设备范围</legend>
            <label class="token-check"
              ><input
                v-model="draft.all"
                type="checkbox"
              />全部设备（包含将来新增的设备）</label
            >
            <template v-if="!draft.all"
              ><p class="muted">
                已选
                {{ draft.device_ids.length }}
                台。未选设备时无设备访问权限。设备组仅用于批量选择，保存后不会随标签变化。
              </p>
              <div v-if="groups.length" class="group-picks">
                <label
                  v-for="group in groups"
                  :key="group.id"
                  class="token-check"
                  ><input
                    type="checkbox"
                    :checked="groupSelected(group.id)"
                    :aria-label="`批量选择设备组 ${group.name}`"
                    @change="
                      selectGroup(
                        group.id,
                        ($event.target as HTMLInputElement).checked,
                      )
                    "
                  />{{ group.name }}</label
                >
              </div>
              <div class="device-picks">
                <label
                  v-for="device in devices"
                  :key="device.id"
                  class="token-check"
                  ><input
                    v-model="draft.device_ids"
                    type="checkbox"
                    :value="device.id"
                    :aria-label="`授权设备 ${device.name}`"
                  />{{ device.name }}</label
                >
              </div>
            </template>
          </fieldset>
          <label
            >有效期<select v-model="draft.days" :disabled="busy">
              <option value="7">7 天</option>
              <option value="30">30 天</option>
              <option value="90">90 天</option>
              <option value="365">365 天</option>
              <option value="custom">指定到期时间</option>
            </select></label
          >
          <label v-if="draft.days === 'custom'"
            >到期时间（本地时间）<input
              v-model="draft.expires"
              type="datetime-local"
              required
              :min="localDate(Date.now() + 60000)"
              :max="localDate(Date.now() + 366 * 86400000)"
              :disabled="busy"
          /></label>
          <p v-if="formError" class="error" role="alert">{{ formError }}</p>
          <div class="token-actions">
            <button
              class="button secondary"
              type="button"
              :disabled="busy"
              @click="open = false"
            >
              取消</button
            ><button class="button" :disabled="busy || uncertain">
              {{ busy ? "保存中…" : editing ? "保存授权" : "创建" }}
            </button>
          </div>
        </form>
      </section>
    </div>
    <div v-if="secret" class="modal-backdrop">
      <section
        class="panel token-dialog secret-dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby="api-token-secret-title"
      >
        <h2 id="api-token-secret-title">Token 已创建：{{ createdName }}</h2>
        <p>完整密钥仅在此显示一次。关闭后无法再次读取，请妥善保存。</p>
        <label
          >API Token<input
            type="password"
            :value="secret"
            readonly
            autocomplete="off"
            aria-label="新建 API Token"
        /></label>
        <p v-if="notice" role="status">{{ notice }}</p>
        <div class="token-actions">
          <button class="button" @click="copy">复制 Token</button
          ><button
            class="button secondary"
            @click="
              secret = '';
              notice = '';
            "
          >
            已保存，关闭
          </button>
        </div>
      </section>
    </div>
    <div v-if="revoked" class="modal-backdrop">
      <section
        class="panel token-dialog secret-dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby="api-token-revoke-title"
      >
        <h2 id="api-token-revoke-title">撤销 {{ revoked.name }}？</h2>
        <p>
          此密钥将立即失效，通过它建立的终端连接会关闭。已提交的命令任务保留原状态，可在任务中心单独取消。
        </p>
        <p v-if="formError" class="error" role="alert">{{ formError }}</p>
        <div class="token-actions">
          <button
            class="button secondary"
            :disabled="busy"
            @click="revoked = undefined"
          >
            取消</button
          ><button class="button danger" :disabled="busy" @click="revoke">
            {{ busy ? "撤销中…" : "确认撤销" }}
          </button>
        </div>
      </section>
    </div>
  </Teleport>
</template>

<style scoped>
.modal-backdrop {
  position: fixed;
  inset: 0;
  z-index: 120;
  background: #13222e88;
  display: flex;
  align-items: center;
  justify-content: center;
  padding: 16px;
}
.tokens-panel {
  padding: 24px;
}
h2 {
  margin: 0 0 12px;
}
.token-toolbar,
.token-actions {
  display: flex;
  gap: 12px;
  flex-wrap: wrap;
  align-items: center;
}
.token-toolbar {
  justify-content: space-between;
  margin-bottom: 20px;
}
.integration-help {
  background: var(--bg, #f5f8fa);
  padding: 16px;
  border-radius: 8px;
  margin-bottom: 20px;
  overflow-wrap: anywhere;
}
.integration-help p {
  margin-top: 0;
}
.token-search {
  display: grid;
  gap: 8px;
  max-width: 360px;
  margin-bottom: 20px;
}
.token-table {
  overflow-x: auto;
}
.token-table table {
  min-width: 840px;
  width: 100%;
  white-space: normal;
}
.token-table td {
  max-width: 340px;
  overflow-wrap: anywhere;
  vertical-align: top;
}
.token-table td p {
  margin: 0 0 6px;
}
small {
  display: block;
  color: var(--muted);
  margin-top: 6px;
  font-size: 12px;
}
.token-actions button {
  white-space: nowrap;
}
.token-dialog {
  padding: 24px;
  width: min(680px, calc(100vw - 32px));
  max-height: calc(100dvh - 40px);
  overflow-y: auto;
}
.token-dialog form,
.token-dialog label {
  display: grid;
  gap: 8px;
}
.token-dialog form {
  gap: 20px;
}
.token-dialog fieldset {
  border: 1px solid var(--line, #dce4e8);
  border-radius: 8px;
  padding: 16px;
  display: grid;
  gap: 12px;
}
.token-dialog .token-check {
  display: flex;
  align-items: flex-start;
  gap: 8px;
  font-weight: normal;
}
.token-check input {
  flex: 0 0 auto;
  width: 16px;
  margin: 3px 0 0;
}
.device-picks {
  max-height: 200px;
  overflow-y: auto;
  display: grid;
  gap: 10px;
}
.group-picks {
  display: flex;
  flex-wrap: wrap;
  gap: 12px;
  padding-bottom: 12px;
}
.secret-dialog {
  width: min(580px, calc(100vw - 32px));
}
.secret-dialog .token-actions {
  margin-top: 20px;
}
@media (max-width: 600px) {
  .tokens-panel,
  .token-dialog {
    padding: 16px;
  }
}
</style>
