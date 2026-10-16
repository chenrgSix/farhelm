<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref } from "vue";
import { api, ApiError } from "../api/client";
const formatTime = (value: number) =>
  new Intl.DateTimeFormat("zh-CN", {
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
  }).format(value);

type State = {
  v: 1;
  revision: number;
  domain: string;
  email: string;
  enabled: boolean;
  tos_agreed: boolean;
  available: boolean;
  challenge_port: number | null;
  challenge_ready: boolean;
  status:
    | "external"
    | "disabled"
    | "pending"
    | "issuing"
    | "renewing"
    | "valid"
    | "error"
    | "expired";
  last_error: { code: string; message: string } | null;
  last_attempt_at: number | null;
  last_success_at: number | null;
  next_attempt_at: number | null;
  retry_allowed_at: number | null;
  certificate: {
    subject: string;
    issuer: string;
    domains: string;
    valid_from: number;
    expires_at: number;
    fingerprint: string;
    renew_at: number;
    managed: boolean;
    domain: string | null;
    expired: boolean;
  };
};
const state = ref<State>();
const domain = ref(""),
  email = ref("");
const enabled = ref(false),
  terms = ref(false),
  revision = ref(0);
const busy = ref(false),
  conflict = ref(false),
  error = ref(""),
  message = ref("");
const time = ref(Date.now());
let disposed = false,
  generation = 0,
  polling = false;
let timer: ReturnType<typeof setInterval> | undefined;
const states: Record<State["status"], string> = {
  external: "外部管理",
  disabled: "自动申请未启用",
  pending: "等待申请",
  issuing: "正在申请",
  renewing: "正在续签",
  valid: "证书有效",
  error: "申请 / 续签失败",
  expired: "证书已过期",
};
const issuing = computed(
  () => state.value?.status === "issuing" || state.value?.status === "renewing",
);
const dirty = computed(
  () =>
    !!state.value &&
    (domain.value !== state.value.domain ||
      email.value !== state.value.email ||
      enabled.value !== state.value.enabled ||
      terms.value !== state.value.tos_agreed),
);
const canCheck = computed(
  () =>
    !!state.value?.enabled &&
    state.value.available &&
    !issuing.value &&
    !busy.value &&
    !conflict.value &&
    !dirty.value &&
    (state.value.retry_allowed_at ?? 0) <= time.value,
);
function adopt(result: State) {
  state.value = result;
  revision.value = result.revision;
  domain.value = result.domain;
  email.value = result.email;
  enabled.value = result.enabled;
  terms.value = result.tos_agreed;
  conflict.value = false;
}
function explain(e: unknown) {
  const raw = e instanceof Error ? e.message : "证书设置操作失败";
  const hints: Record<string, string> = {
    CERTIFICATE_REVISION_CONFLICT:
      "配置已被其他管理员修改，请重新加载后再编辑。",
    INVALID_CERTIFICATE_DOMAIN:
      "请输入公网域名，例如 fleet.example.com，不包含 https://、端口或路径；暂不支持通配符和 IP。",
    INVALID_CERTIFICATE_EMAIL: "请输入有效的联系邮箱。",
    CERTIFICATE_TOS_REQUIRED: "启用前请阅读并同意 Let’s Encrypt 服务条款。",
    CERTIFICATE_MANAGEMENT_UNAVAILABLE:
      "当前部署未启用 Farhelm 证书托管，请按部署说明接通 HTTP 验证和 HTTPS 入口。",
    CERTIFICATE_BUSY: "证书申请正在进行，请等待完成；仍可关闭自动申请。",
    CERTIFICATE_RETRY_LATER: "申请过于频繁，请等待页面显示的重试时间。",
  };
  if (
    raw.includes("CERTIFICATE_REVISION_CONFLICT") ||
    (e instanceof ApiError && e.status === 0)
  )
    conflict.value = true;
  return Object.entries(hints).find(([key]) => raw.includes(key))?.[1] ?? raw;
}
async function load() {
  if (busy.value) return;
  busy.value = true;
  error.value = "";
  message.value = "";
  const request = ++generation;
  try {
    const result = await api.request<State>("/settings/certificate");
    if (!disposed && request === generation) adopt(result);
  } catch (e) {
    if (!disposed) error.value = explain(e);
  } finally {
    if (!disposed) busy.value = false;
  }
}
async function save() {
  if (busy.value || conflict.value || !state.value || !dirty.value) return;
  busy.value = true;
  error.value = "";
  message.value = "";
  ++generation;
  try {
    const result = await api.request<State>("/settings/certificate", {
      method: "PUT",
      body: {
        v: 1,
        revision: revision.value,
        domain: domain.value.trim(),
        email: email.value.trim(),
        enabled: enabled.value,
        tos_agreed: terms.value,
      },
    });
    if (!disposed) {
      adopt(result);
      message.value = result.enabled
        ? "已保存，平台将在后台申请或检查证书，结果自动刷新。"
        : "已保存，自动申请已关闭，当前证书继续保留。";
    }
  } catch (e) {
    if (!disposed) error.value = explain(e);
  } finally {
    if (!disposed) busy.value = false;
  }
}
async function check() {
  if (!canCheck.value) return;
  busy.value = true;
  error.value = "";
  message.value = "";
  ++generation;
  try {
    const result = await api.request<State>("/settings/certificate/check", {
      method: "POST",
      body: { v: 1, revision: revision.value },
    });
    if (!disposed) {
      state.value = result;
      message.value = "已安排检查；证书未到续签时间时继续使用当前证书。";
    }
  } catch (e) {
    if (!disposed) error.value = explain(e);
  } finally {
    if (!disposed) busy.value = false;
  }
}
async function poll() {
  time.value = Date.now();
  if (busy.value || polling || !state.value || disposed) return;
  const request = generation;
  polling = true;
  try {
    const result = await api.request<State>("/settings/certificate");
    if (disposed || request !== generation) return;
    if (result.revision !== revision.value) {
      conflict.value = true;
      error.value = "配置已被其他管理员修改，请重新加载后再编辑。";
    }
    state.value = result;
  } catch {
    if (!disposed && request === generation)
      error.value =
        "证书状态刷新失败，请检查连接或重新加载；尚未确认最新结果。";
  } finally {
    polling = false;
  }
}
onMounted(() => {
  void load();
  timer = setInterval(() => {
    void poll();
  }, 5000);
});
onBeforeUnmount(() => {
  disposed = true;
  ++generation;
  clearInterval(timer);
});
</script>

<template>
  <section class="panel certificate-panel" aria-labelledby="certificate-title">
    <div class="panel-heading">
      <div>
        <h2 id="certificate-title">HTTPS 证书</h2>
        <p class="muted">正式域名自动申请与续签 · Let’s Encrypt</p>
      </div>
      <span
        v-if="state"
        class="certificate-status"
        :class="{ danger: state.last_error || state.certificate.expired }"
        >{{ states[state.status] }}</span
      >
    </div>
    <p v-if="error" class="notice danger" role="alert">{{ error }}</p>
    <p v-if="message" class="certificate-success" role="status">
      {{ message }}
    </p>
    <template v-if="state">
      <div v-if="!state.available" class="notice">
        当前部署使用外部管理的 HTTPS 入口。可先保存域名；部署时启用 Farhelm
        证书托管后再打开自动申请。 下方显示服务端证书，独立 Nginx / Vite
        入口的证书由该入口管理。
      </div>
      <form @submit.prevent="save">
        <fieldset :disabled="busy">
          <label
            >平台域名<input
              v-model="domain"
              name="certificate-domain"
              required
              maxlength="253"
              placeholder="fleet.example.com"
              autocomplete="off"
              spellcheck="false"
          /></label>
          <label
            >联系邮箱<input
              v-model="email"
              name="certificate-email"
              type="email"
              required
              maxlength="254"
              placeholder="ops@example.com"
              autocomplete="off"
          /></label>
          <label class="check"
            ><input
              v-model="enabled"
              name="certificate-enabled"
              type="checkbox"
              :disabled="!state.available && !enabled"
            />自动申请和续签证书</label
          >
          <label class="check"
            ><input
              v-model="terms"
              name="certificate-terms"
              type="checkbox"
            />我同意
            <a
              href="https://letsencrypt.org/repository/"
              target="_blank"
              rel="noopener noreferrer"
              >Let’s Encrypt 服务条款</a
            >，允许将域名和联系邮箱提交给证书机构</label
          >
          <p class="field-hint">
            域名的 A / AAAA 记录需指向平台，公网 80 端口用于域名验证，443
            端口提供网页和 Agent 接入。当前支持单个公网域名，暂不支持通配符。
          </p>
          <p class="field-hint">
            证书签发后自动热加载，已有终端连接继续运行。更换域名前，请保留原入口直到
            Agent 完成迁移；平台访问地址仍在上方单独保存并同步。
          </p>
          <div class="certificate-actions">
            <button
              class="button primary"
              type="submit"
              :disabled="
                busy ||
                conflict ||
                !dirty ||
                (issuing && enabled) ||
                (enabled && !terms)
              "
            >
              {{ busy ? "处理中…" : "保存证书设置" }}
            </button>
            <button
              class="button secondary"
              type="button"
              :disabled="!canCheck"
              @click="check"
            >
              立即检查 / 重试
            </button>
          </div>
        </fieldset>
      </form>
      <div v-if="state.last_error" class="notice danger" role="alert">
        {{ state.last_error.message }} 申请失败不会替换当前证书。
      </div>
      <dl class="certificate-details">
        <div>
          <dt>当前证书</dt>
          <dd>
            {{
              state.certificate.managed
                ? state.certificate.domain
                : "部署提供的服务端证书"
            }}<strong v-if="state.certificate.expired" class="danger"
              >（已过期）</strong
            >
          </dd>
        </div>
        <div>
          <dt>签发机构</dt>
          <dd>{{ state.certificate.issuer }}</dd>
        </div>
        <div>
          <dt>有效期至</dt>
          <dd data-testid="certificate-expiry">
            {{ formatTime(state.certificate.expires_at) }}
          </dd>
        </div>
        <div>
          <dt>上次签发成功</dt>
          <dd>
            {{
              state.last_success_at
                ? formatTime(state.last_success_at)
                : "尚未签发"
            }}
          </dd>
        </div>
        <div>
          <dt>下次检查 / 重试</dt>
          <dd>
            {{
              state.next_attempt_at
                ? formatTime(state.next_attempt_at)
                : "自动申请未启用"
            }}
          </dd>
        </div>
        <div v-if="state.retry_allowed_at && state.retry_allowed_at > time">
          <dt>可手动重试时间</dt>
          <dd>{{ formatTime(state.retry_allowed_at) }}</dd>
        </div>
        <div v-if="state.available">
          <dt>HTTP 验证入口</dt>
          <dd>
            {{
              state.challenge_ready
                ? `已监听内部端口 ${state.challenge_port}，公网须映射到 80`
                : "监听未就绪"
            }}
          </dd>
        </div>
      </dl>
    </template>
    <p v-else-if="busy" class="muted">正在读取证书状态…</p>
    <button
      class="button secondary small"
      type="button"
      :disabled="busy"
      @click="load"
    >
      重新加载证书配置
    </button>
  </section>
</template>
<style scoped>
.certificate-panel {
  max-width: 820px;
  padding: 24px;
  margin-top: 20px;
}
.panel-heading {
  gap: 16px;
  flex-wrap: wrap;
}
.panel-heading p {
  margin: 7px 0 0;
}
.certificate-status {
  font-size: 13px;
  color: #19705c;
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
  font-size: 13px;
  font-weight: 600;
}
input:not([type="checkbox"]) {
  width: 100%;
  box-sizing: border-box;
  margin: 0;
}
.check {
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  gap: 8px;
  font-weight: 400;
}
.check input {
  width: auto;
  margin: 0;
}
.certificate-actions {
  display: flex;
  flex-wrap: wrap;
  gap: 10px;
}
p {
  margin: 0;
  line-height: 1.8;
}
.certificate-success {
  color: #19705c;
  margin-bottom: 16px;
}
.certificate-details {
  display: grid;
  gap: 12px;
  padding: 18px 0;
  border-top: 1px solid #e1e8ed;
}
.certificate-details > div {
  display: grid;
  grid-template-columns: 140px minmax(0, 1fr);
  gap: 12px;
  font-size: 13px;
}
dt {
  color: #536776;
}
dd {
  margin: 0;
  overflow-wrap: anywhere;
  white-space: pre-line;
}
.danger {
  color: #b4453a;
}
@media (max-width: 600px) {
  .certificate-panel {
    padding: 18px;
  }
  .certificate-details > div {
    grid-template-columns: 1fr;
    gap: 5px;
  }
}
</style>
