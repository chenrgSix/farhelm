<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref } from "vue";
import { api } from "../api/client";
import { hasPermission, formatTime } from "../model";
import type {
  Device,
  User,
  NetworkProbeConfig,
  NetworkProbeResponse,
} from "../api/types";
const props = defineProps<{ device: Device; user?: User }>();
const data = ref<NetworkProbeResponse | null>(null);
const draft = ref<NetworkProbeConfig>({
  revision: 0,
  enabled: false,
  interval_secs: 30,
  timeout_ms: 3000,
  failure_threshold: 3,
  targets: [],
});
const saved = ref("");
const loaded = ref(false);
const saving = ref(false);
const loading = ref(false);
const error = ref("");
const message = ref("");
const cursor = ref<number | null>(null);
const pages = ref<(number | null)[]>([]);
const editable = computed(
  () =>
    !!props.user &&
    hasPermission(props.user ?? null, "network.manage", props.device.id) &&
    !props.device.revoked_at,
);
const dirty = computed(
  () => loaded.value && JSON.stringify(draft.value) !== saved.value,
);
const remoteChanged = computed(
  () => data.value && data.value.config.revision !== draft.value.revision,
);
const path = `/devices/${encodeURIComponent(props.device.id)}/network-probes`;
const labels = {
  healthy: "网络探测正常",
  platform_unreachable: "平台连接异常，其他目标可达",
  partial_unreachable: "部分探测目标不可达",
  checking: "探测失败，等待连续确认",
  targets_unreachable: "探测目标异常，平台仍可达",
  suspected_offline: "疑似网络故障：所有目标均不可达",
  disabled: "探测已停用",
};
const reasons: Record<string, string> = {
  TCP_CONNECTED: "TCP 连接成功",
  HTTP_RESPONSE: "收到 HTTP 响应",
  CONNECT_FAILED: "TCP / DNS 连接失败",
  HTTP_OR_TLS_FAILED: "HTTP / DNS / TLS 连接失败",
  TIMEOUT: "超时",
};
let disposed = false;
let generation = 0;
let timer: ReturnType<typeof setInterval> | undefined;
function apply(result: NetworkProbeResponse, replace = false) {
  data.value = result;
  if (replace || !dirty.value) {
    draft.value = structuredClone(result.config);
    saved.value = JSON.stringify(draft.value);
  }
  loaded.value = true;
}
function report(e: unknown) {
  const text = e instanceof Error ? e.message : "操作失败";
  error.value = text.includes("NETWORK_PROBE_CONFIG_CHANGED_RELOAD")
    ? "配置已被其他人修改，请重新加载配置后再保存"
    : text;
}
async function load(
  before = cursor.value,
  move: "next" | "back" | null = null,
  replace = false,
) {
  if (loading.value || saving.value) return;
  loading.value = true;
  const gen = ++generation;
  try {
    const result = await api.request<NetworkProbeResponse>(
      path + (before ? `?before=${before}` : ""),
    );
    if (disposed || gen !== generation) return;
    if (move === "next") pages.value.push(cursor.value);
    if (move === "back") pages.value.pop();
    cursor.value = before;
    apply(result, replace);
    error.value = "";
  } catch (e) {
    if (!disposed && gen === generation) report(e);
  } finally {
    if (gen === generation) loading.value = false;
  }
}
async function save() {
  if (saving.value || !editable.value || !dirty.value || remoteChanged.value)
    return;
  saving.value = true;
  generation++;
  loading.value = false;
  error.value = "";
  message.value = "";
  try {
    const result = await api.request<NetworkProbeResponse>(path, {
      method: "PUT",
      body: { v: 1, config: JSON.parse(JSON.stringify(draft.value)) },
    });
    if (disposed) return;
    apply(result, true);
    cursor.value = null;
    pages.value = [];
    message.value = "配置已保存";
  } catch (e) {
    if (!disposed) report(e);
  } finally {
    saving.value = false;
  }
}
onMounted(async () => {
  await load();
  if (!disposed)
    timer = setInterval(() => {
      if (!document.hidden) void load();
    }, 5000);
});
onBeforeUnmount(() => {
  disposed = true;
  generation++;
  clearInterval(timer);
});
</script>
<template>
  <section class="probe-section" aria-label="网络连通性探测">
    <h3>网络连通性探测</h3>
    <p v-if="error" class="error-banner" role="alert">{{ error }}</p>
    <p v-if="message" role="status" class="probe-message">{{ message }}</p>
    <template v-if="data">
      <p v-if="data.config_error" class="error-banner" role="alert">
        探测配置无效或被 Agent
        拒绝，请修改探测地址或参数后重新保存。原有效配置保留，平台连接不受影响。
      </p>
      <p class="probe-status">
        {{
          !data.config.enabled
            ? "探测未启用"
            : data.result_fresh && data.result
              ? labels[data.result.status]
              : "等待最新探测结果"
        }}
      </p>
      <p class="field-hint">
        {{
          data.device_online
            ? "平台连接在线"
            : "平台连接离线，Agent 在本机继续探测，恢复后补传"
        }}
        ·
        {{
          !data.config_error && data.applied_revision === data.config.revision
            ? "Agent 已确认配置"
            : "配置等待 Agent 确认"
        }}<span v-if="data.device_online && !data.supported">
          · 需要 Agent 0.2.3 或更新版本</span
        >
      </p>
      <p v-if="data.result && !data.result_fresh" class="field-hint">
        上次记录：{{ labels[data.result.status] }}（{{
          formatTime(data.result.observed_at)
        }}，仅作历史参考）
      </p>
      <p class="field-hint">
        平台失联、其他目标可达时，说明仍有网络连接。多个独立目标连续失败时标为疑似网络故障，DNS、防火墙或目标自身故障也可能导致失败。
      </p>
      <details class="probe-config" :open="!data.config.enabled && editable">
        <summary>探测配置{{ editable ? "" : "（仅查看）" }}</summary>
        <form @submit.prevent="save">
          <fieldset :disabled="!editable || saving">
            <label class="probe-enabled"
              ><input
                v-model="draft.enabled"
                type="checkbox"
              />启用网络探测</label
            >
            <div class="probe-limits">
              <label
                >探测间隔（秒）<input
                  v-model.number="draft.interval_secs"
                  type="number"
                  min="5"
                  max="3600"
                  required
              /></label>
              <label
                >单次超时（毫秒）<input
                  v-model.number="draft.timeout_ms"
                  type="number"
                  min="100"
                  :max="Math.min(10000, draft.interval_secs * 1000)"
                  required
              /></label>
              <label
                >连续失败次数<input
                  v-model.number="draft.failure_threshold"
                  type="number"
                  min="1"
                  max="10"
                  required
              /></label>
            </div>
            <p class="field-hint">
              启用时填写 2–5 个独立目标，建议覆盖网关和不同外部地址。支持
              https://example.com、http://10.0.0.1、tcp://1.1.1.1:443。HTTP
              任意响应状态均视为可达；不跟随重定向。
            </p>
            <div
              v-for="(_, index) in draft.targets"
              :key="index"
              class="probe-target"
            >
              <label
                >探测地址 {{ index + 1
                }}<input
                  v-model="draft.targets[index]"
                  type="text"
                  maxlength="512"
                  placeholder="https://example.com 或 tcp://网关IP:端口"
                  required /></label
              ><button
                v-if="editable"
                type="button"
                class="text-button"
                :aria-label="`删除探测地址 ${index + 1}`"
                @click="draft.targets.splice(index, 1)"
              >
                删除
              </button>
            </div>
            <button
              v-if="editable"
              type="button"
              class="button small"
              :disabled="draft.targets.length >= 5"
              @click="draft.targets.push('')"
            >
              添加探测地址
            </button>
          </fieldset>
          <p v-if="remoteChanged" class="probe-message">
            配置已更新，你的编辑尚未保存。请重新加载配置。
          </p>
          <div v-if="editable" class="probe-actions">
            <button
              type="button"
              class="button small"
              :disabled="saving || loading"
              @click="load(cursor, null, true)"
            >
              重新加载配置</button
            ><button
              type="submit"
              class="button primary small"
              :disabled="
                saving ||
                !dirty ||
                remoteChanged ||
                (draft.enabled && draft.targets.length < 2)
              "
            >
              {{ saving ? "正在保存…" : "保存探测配置" }}
            </button>
          </div>
        </form>
      </details>
      <details v-if="data.result" class="probe-evidence">
        <summary>
          最近一次探测详情 · {{ formatTime(data.result.observed_at) }}
        </summary>
        <p class="field-hint">
          配置版本 {{ data.result.revision }} · 当时平台{{
            data.result.platform_connected ? "已连接" : "未连接"
          }}
          · 连续全部失败 {{ data.result.consecutive_failures }} 次
        </p>
        <ul>
          <li v-for="r in data.result.results" :key="r.target">
            <code>{{ r.target }}</code
            >：{{ reasons[r.reason] ?? r.reason }} · {{ r.duration_ms }} ms
          </li>
        </ul>
      </details>
      <h4>探测状态变化记录</h4>
      <p class="field-hint">
        保留每次状态变化及当时各目标的结果；未变化的定时探测更新最近结果。
      </p>
      <p v-if="!data.events.length" class="muted">暂无探测记录</p>
      <details
        v-for="event in data.events"
        :key="event.sample_id"
        class="probe-evidence"
      >
        <summary>
          {{ formatTime(event.observed_at) }} · {{ labels[event.status] }}
        </summary>
        <p class="field-hint">
          配置版本 {{ event.revision }} · 当时平台{{
            event.platform_connected ? "已连接" : "未连接"
          }}
          · 连续全部失败 {{ event.consecutive_failures }} 次
        </p>
        <ul>
          <li v-for="r in event.results" :key="r.target">
            <code>{{ r.target }}</code
            >：{{ reasons[r.reason] ?? r.reason }} · {{ r.duration_ms }} ms
          </li>
        </ul>
      </details>
      <div v-if="pages.length || data.next_before" class="probe-actions">
        <button
          type="button"
          class="button small"
          :disabled="loading || saving || !pages.length"
          @click="load(pages[pages.length - 1], 'back')"
        >
          上一页探测记录</button
        ><span>第 {{ pages.length + 1 }} 页</span
        ><button
          type="button"
          class="button small"
          :disabled="loading || saving || !data.next_before"
          @click="load(data.next_before, 'next')"
        >
          更早探测记录
        </button>
      </div>
    </template>
    <p v-else class="muted">
      {{ loading ? "正在读取探测配置…" : "尚未获取探测配置" }}
    </p>
  </section>
</template>
<style scoped>
.probe-section {
  border-top: 1px solid var(--border);
  margin-top: 20px;
  padding-top: 4px;
}
.probe-status {
  font-weight: 600;
  margin: 12px 0;
}
.probe-config,
.probe-evidence {
  border: 1px solid var(--border);
  border-radius: 8px;
  padding: 14px;
  margin: 12px 0;
}
summary {
  cursor: pointer;
  font-weight: 600;
}
form {
  margin-top: 16px;
}
fieldset {
  border: 0;
  padding: 0;
  margin: 0;
  min-width: 0;
}
.probe-enabled {
  display: flex;
  gap: 8px;
  align-items: center;
}
.probe-enabled input {
  width: auto;
}
.probe-limits {
  display: grid;
  grid-template-columns: repeat(3, 1fr);
  gap: 14px;
  margin: 16px 0;
}
label {
  display: grid;
  gap: 6px;
}
.probe-target {
  display: flex;
  align-items: end;
  gap: 12px;
  margin: 12px 0;
}
.probe-target label {
  flex: 1;
  min-width: 0;
}
.probe-actions {
  display: flex;
  flex-wrap: wrap;
  justify-content: flex-end;
  gap: 12px;
  align-items: center;
  margin-top: 16px;
}
.probe-message {
  padding: 10px;
  background: #eef6f4;
}
li {
  overflow-wrap: anywhere;
  margin-top: 8px;
}
h4 {
  margin: 20px 0 8px;
}
@media (max-width: 640px) {
  .probe-limits {
    grid-template-columns: 1fr;
  }
}
</style>
