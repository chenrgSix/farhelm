<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref } from "vue";
import AgentCASyncPanel from "./AgentCASyncPanel.vue";
import { api, ApiError } from "../api/client";
withDefaults(defineProps<{ agentEnabled?: boolean }>(), { agentEnabled: true });
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
  mode: "acme" | "private";
  acme_available: boolean;
  private_ca_available: boolean;
  activation_ready: boolean;
  private_ca: {
    subject: string;
    fingerprint: string;
    valid_from: number;
    expires_at: number;
    expired: boolean;
    expiring: boolean;
  } | null;
  domain: string;
  additional_domains?: string[];
  email: string;
  enabled: boolean;
  tos_agreed: boolean;
  available: boolean;
  challenge_type: "http-01" | "tls-alpn-01";
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
const challengeType = ref<"http-01" | "tls-alpn-01">("http-01");
const mode = ref<"acme" | "private">("acme");
const available = computed(() =>
  mode.value === "private"
    ? state.value?.private_ca_available
    : state.value?.acme_available,
);
const domain = ref(""),
  additionalDomains = ref(""),
  email = ref("");
const additionalNames = computed(() =>
  additionalDomains.value.split(/[\s,，]+/).filter(Boolean),
);
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
    (mode.value !== state.value.mode ||
      challengeType.value !== state.value.challenge_type ||
      domain.value !== state.value.domain ||
      (mode.value === "private" &&
        JSON.stringify(additionalNames.value) !==
          JSON.stringify(state.value.additional_domains ?? [])) ||
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
  mode.value = result.mode;
  challengeType.value = result.challenge_type;
  domain.value = result.domain;
  additionalDomains.value = (result.additional_domains ?? []).join("\n");
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
      "请输入域名或公网 IP，不包含 https://、端口、路径或通配符；IPv6 不带方括号。",
    INVALID_CERTIFICATE_PUBLIC_IP:
      "请输入可从公网访问的 IP；内网、回环及保留地址请使用平台私有 CA。",
    INVALID_PRIVATE_CERTIFICATE_HOST:
      "请输入内网域名或 IP，不包含 https://、端口、路径或通配符。IPv6 不带方括号。",
    INVALID_CERTIFICATE_ADDITIONAL_DOMAINS:
      "最多填写 31 个附加域名或 IP，每行一个，不包含协议、端口或路径。",
    CERTIFICATE_ADDITIONAL_DOMAINS_PRIVATE_ONLY:
      "附加地址仅支持平台私有 CA 模式。",
    AGENT_CA_SYNC_INCOMPLETE:
      "已有 Agent 尚未全部确认信任新 CA。请先在下方完成 CA 同步；旧版 Agent 需先升级。",
    PRIVATE_CA_NOT_PREPARED: "请先创建并下载内网 CA，完成浏览器信任后再启用。",
    PRIVATE_CA_UNAVAILABLE: "内网 CA 文件缺失或损坏，请从备份恢复。",
    INVALID_CERTIFICATE_CHALLENGE: "请选择 HTTP-01 或 TLS-ALPN-01 验证。",
    ACME_TLS_UNAVAILABLE: "TLS 验证需要启用平台的 Agent 或网页 HTTPS 入口。",
    INVALID_CERTIFICATE_EMAIL: "请输入有效的联系邮箱。",
    CERTIFICATE_TOS_REQUIRED: "启用前请阅读并同意 Let’s Encrypt 服务条款。",
    CERTIFICATE_MANAGEMENT_UNAVAILABLE:
      "当前部署未启用 Farhelm 证书托管，请按部署说明接通验证入口和 HTTPS 入口。",
    CERTIFICATE_BUSY: "证书申请正在进行，请等待完成；仍可关闭自动申请。",
    PRIVATE_CERTIFICATE_RENEWAL_UNAVAILABLE:
      "立即续签仅适用于当前已托管的内网证书。",
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
        mode: mode.value,
        challenge_type: challengeType.value,
        domain: domain.value.trim(),
        ...(mode.value === "private"
          ? { additional_domains: additionalNames.value }
          : {}),
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
async function prepareCA() {
  if (busy.value || dirty.value || conflict.value) return;
  busy.value = true;
  error.value = "";
  message.value = "";
  ++generation;
  try {
    const result = await api.request<State>("/settings/certificate/ca", {
      method: "POST",
      body: { v: 1, revision: revision.value },
    });
    if (!disposed) {
      adopt(result);
      message.value = "CA 已创建。请下载并在管理电脑上信任，然后启用自动签发。";
    }
  } catch (e) {
    if (!disposed) error.value = explain(e);
  } finally {
    if (!disposed) busy.value = false;
  }
}
async function downloadCA() {
  if (busy.value) return;
  busy.value = true;
  error.value = "";
  try {
    const result = await api.request<{
      certificate_pem: string;
      fingerprint: string;
    }>("/settings/certificate/ca");
    if (disposed) return;
    if (result.fingerprint !== state.value?.private_ca?.fingerprint)
      throw new Error("CA 指纹已变化，请重新加载配置并核对。");
    const url = URL.createObjectURL(
      new Blob([result.certificate_pem], { type: "application/x-pem-file" }),
    );
    const link = document.createElement("a");
    link.href = url;
    link.download = "farhelm-private-ca.crt";
    link.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  } catch (e) {
    if (!disposed) error.value = explain(e);
  } finally {
    if (!disposed) busy.value = false;
  }
}
function changeMode() {
  enabled.value = false;
  terms.value = false;
  message.value = "";
}
async function check(renewNow = false) {
  if (!canCheck.value || (renewNow && state.value?.mode !== "private")) return;
  busy.value = true;
  error.value = "";
  message.value = "";
  ++generation;
  try {
    const result = await api.request<State>(
      `/settings/certificate/${renewNow ? "renew" : "check"}`,
      {
        method: "POST",
        body: { v: 1, revision: revision.value },
      },
    );
    if (!disposed) {
      state.value = result;
      message.value = renewNow
        ? "已安排立即续签，使用同一 CA 签发并热加载，结果自动刷新。"
        : "已安排检查；证书未到续签时间时继续使用当前证书。";
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
        <p class="muted">Agent HTTPS / 网页 HTTPS · 公网证书 / 内网私有 CA</p>
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
      <div v-if="!available" class="notice">
        当前部署使用外部管理的 HTTPS 入口。可先保存域名或公网 IP；部署时启用
        Farhelm 证书托管后再打开自动申请。 下方显示服务端证书，独立 Nginx / Vite
        入口的证书由该入口管理。
      </div>
      <form @submit.prevent="save">
        <fieldset :disabled="busy">
          <label
            >证书模式
            <select v-model="mode" name="certificate-mode" @change="changeMode">
              <option value="acme">公网证书（Let’s Encrypt）</option>
              <option value="private">纯内网（平台私有 CA）</option>
            </select>
          </label>
          <label
            >{{ mode === "private" ? "证书域名或 IP" : "平台域名或公网 IP"
            }}<input
              v-model="domain"
              name="certificate-domain"
              required
              maxlength="253"
              :placeholder="
                mode === 'private'
                  ? 'farhelm.internal 或 192.168.1.10'
                  : 'fleet.example.com 或公网 IP'
              "
              autocomplete="off"
              spellcheck="false"
          /></label>
          <label v-if="mode === 'private'">
            附加域名或 IP（可选）
            <textarea
              v-model="additionalDomains"
              name="certificate-additional-domains"
              rows="3"
              maxlength="7905"
              placeholder="192.168.1.5&#10;farhelm.internal"
              aria-describedby="certificate-additional-domains-hint"
              spellcheck="false"
            ></textarea>
            <span id="certificate-additional-domains-hint" class="field-hint">
              每行一个，最多 31
              个。公网和内网同时使用时，保留上方主地址，在此添加内网地址；同一张证书覆盖全部地址，自动续签时一并保留。
            </span>
          </label>
          <label v-if="mode === 'acme'"
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
              :disabled="
                !available ||
                (mode === 'private' &&
                  (!state.private_ca || !state.activation_ready))
              "
            />自动申请和续签证书</label
          >
          <label v-if="mode === 'acme'" class="check"
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
            >，允许将域名或 IP 和联系邮箱提交给证书机构</label
          >
          <label v-if="mode === 'acme'"
            >验证方式
            <select v-model="challengeType" name="certificate-challenge">
              <option value="http-01">HTTP-01（公网 80）</option>
              <option value="tls-alpn-01">
                TLS-ALPN-01（公网 443，无需 80）
              </option>
            </select>
          </label>
          <p
            v-if="mode === 'acme'"
            class="field-hint"
            data-testid="challenge-hint"
          >
            <template v-if="challengeType === 'http-01'">
              公网 80 需持续可达。端口已被其他 Web
              服务使用时，可将验证路径转发到平台的 HTTP 验证入口。
            </template>
            <template v-else>
              无需开放 80。公网 443 需通过 TCP 转发直达平台 TLS
              验证入口（见下方监听端口），保留 acme-tls/1 协议；普通 HTTPS
              反向代理不能代替此验证。
            </template>
            平台内部可监听其他端口，但公网验证端口由证书机构固定为 80 或
            443，不能任意修改。
          </p>
          <p v-if="mode === 'acme'" class="field-hint">
            支持单个公网域名、IPv4 或 IPv6。域名的 A / AAAA 记录需指向平台；IP
            无需域名解析。 暂不支持通配符和 DNS 验证。只有公网 IP 且 80、443
            均不可达时，无法自动申请公网证书。
          </p>
          <p
            v-if="mode === 'acme'"
            class="field-hint"
            data-testid="ip-certificate-hint"
          >
            公网 IP 证书由 Let’s Encrypt 签发，浏览器无需手动信任 CA。有效期约 6
            天（160 小时），平台按实际有效期提前自动续签；无需手动选择证书类型。
          </p>
          <p v-if="mode === 'private'" class="field-hint">
            无需公网和互联网连接。平台为 Agent HTTPS 自动签发和续签；网页选择
            HTTPS 时共用托管证书，选择 HTTP 时无需浏览器信任 CA。 内网 DNS 或
            hosts 需指向平台。新 Agent 安装命令自动携带 CA；更换 CA 前，已有
            Agent 请先在下方同步，全部就绪后再切换证书。
          </p>
          <p class="field-hint">
            证书签发后自动热加载，已有终端连接继续运行。更换域名或 IP
            需要迁移入口； IP
            地址变更前请安排迁移。平台访问地址仍在上方单独保存并同步。
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
                (enabled && mode === 'acme' && !terms)
              "
            >
              {{ busy ? "处理中…" : "保存证书设置" }}
            </button>
            <button
              class="button secondary"
              type="button"
              :disabled="!canCheck"
              @click="check(false)"
            >
              立即检查 / 重试
            </button>
            <button
              v-if="
                mode === 'private' &&
                state.certificate.managed &&
                state.certificate.domain === state.domain
              "
              class="button secondary"
              type="button"
              :disabled="!canCheck"
              @click="check(true)"
            >
              立即续签
            </button>
          </div>
        </fieldset>
      </form>
      <div v-if="mode === 'private'" class="private-ca-info">
        <p v-if="!state.private_ca" class="field-hint">
          保存内网配置后创建本平台专用 CA。CA 私钥仅保存在服务端。
        </p>
        <button
          v-if="!state.private_ca"
          class="button secondary"
          type="button"
          :disabled="
            busy || conflict || dirty || state.mode !== 'private' || !available
          "
          @click="prepareCA"
        >
          创建内网 CA
        </button>
        <template v-else>
          <button
            class="button secondary"
            type="button"
            :disabled="busy"
            @click="downloadCA"
          >
            下载 CA 证书
          </button>
          <dl class="certificate-details">
            <div>
              <dt>内网 CA</dt>
              <dd>{{ state.private_ca.subject }}</dd>
            </div>
            <div>
              <dt>CA 指纹（SHA-256）</dt>
              <dd data-testid="ca-fingerprint">
                {{ state.private_ca.fingerprint }}
              </dd>
            </div>
            <div>
              <dt>CA 有效期至</dt>
              <dd>{{ formatTime(state.private_ca.expires_at) }}</dd>
            </div>
          </dl>
          <p v-if="state.private_ca.expiring" class="notice danger">
            CA 已临近到期或过期，请安排 CA
            更换和客户端信任迁移。平台不会自动更换根 CA。
          </p>
          <AgentCASyncPanel
            v-if="agentEnabled"
            :revision="state.revision"
            :fingerprint="state.private_ca.fingerprint"
            :disabled="busy || dirty || conflict || state.mode !== 'private'"
          />
          <details>
            <summary>首次信任与独立入口说明</summary>
            <p class="field-hint">
              从当前可信管理入口下载 CA 并核对指纹。macOS
              导入钥匙串并设为信任；Windows 导入“受信任的根证书颁发机构”；Linux
              导入系统或浏览器的信任库。企业可统一下发。只信任
              CA，无需单独信任每次续签的服务端证书。
            </p>
            <p class="field-hint">
              CA 有效期 10 年，服务端证书每次签发最长 90 天、提前约 30
              天自动续签。根 CA 到期或丢失需要迁移信任，请备份平台数据目录。
            </p>
            <p class="field-hint">
              网页选择 HTTPS 时需首次信任 CA；网页选择 HTTP
              时无需浏览器信任。Agent 接入设置使用独立 HTTPS
              地址，安装命令自动携带 CA，续签同时更新所有托管 HTTPS 入口。独立
              Vite / Nginx HTTPS 入口不会因本设置自动更换证书。
            </p>
          </details>
        </template>
      </div>
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
          <dt>当前证书覆盖地址</dt>
          <dd data-testid="certificate-names">
            {{ state.certificate.domains }}
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
        <div v-if="state.certificate.managed">
          <dt>计划续签时间</dt>
          <dd data-testid="certificate-renewal">
            {{ formatTime(state.certificate.renew_at) }}
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
        <div v-if="state.available && state.mode === 'acme'">
          <dt>
            {{
              state.challenge_type === "tls-alpn-01"
                ? "TLS 验证入口"
                : "HTTP 验证入口"
            }}
          </dt>
          <dd>
            {{
              state.challenge_ready
                ? `已监听内部端口 ${state.challenge_port}，公网须映射到 ${state.challenge_type === "tls-alpn-01" ? 443 : 80}`
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
select,
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
.private-ca-info {
  display: grid;
  gap: 12px;
  margin: 18px 0;
}
summary {
  cursor: pointer;
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
