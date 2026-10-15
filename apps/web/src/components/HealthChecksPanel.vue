<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref } from "vue";
import { api } from "../api/client";
import type {
  Device,
  HealthCheck,
  HealthResponse,
  HealthResult,
  User,
} from "../api/types";
import { hasPermission, formatTime } from "../model";
const props = defineProps<{ device: Device; user: User }>();
const emit = defineEmits<{ close: []; changed: [] }>();
const checks = ref<HealthCheck[]>([]);
const results = ref<Record<string, HealthResult>>({});
const revision = ref(0);
const remoteRevision = ref(0);
const saved = ref("[]");
const loaded = ref(false);
const saving = ref(false);
const running = ref(false);
const online = ref(false);
const supported = ref(false);
const error = ref("");
const message = ref("");
const dirty = computed(() => JSON.stringify(checks.value) !== saved.value);
const editable = computed(
  () =>
    hasPermission(props.user ?? null, "health.manage", props.device.id) &&
    !props.device.revoked_at,
);
const path = `/devices/${encodeURIComponent(props.device.id)}/health-checks`;
let disposed = false;
let timer: ReturnType<typeof setInterval> | undefined;
let loading = false;
const labels = {
  healthy: "健康",
  unhealthy: "异常",
  unknown: "未知",
  disabled: "已停用",
};
const reasons: Record<string, string> = {
  OK: "检查通过",
  DISABLED: "已停用",
  DEVICE_OFFLINE: "设备离线，等待重新连接",
  AGENT_UPDATE_REQUIRED: "请更新 Agent 后启用探测",
  AWAITING_RESULT: "等待新结果（尚未探测或结果已过期）",
  HTTP_REQUEST_FAILED: "HTTP 连接或 TLS 校验失败",
  HTTP_STATUS_MISMATCH: "HTTP 状态码不符合预期",
  HTTP_BODY_MISMATCH: "响应未包含预期文本",
  HTTP_BODY_LIMIT: "响应正文超过 64 KiB 检查范围",
  HTTP_BODY_FAILED: "响应正文读取失败",
  TCP_CONNECT_FAILED: "TCP 端口连接失败",
  SERVICE_INACTIVE: "服务未运行或不存在",
  SYSTEMD_UNAVAILABLE: "当前设备无法使用 systemd 检查",
  TIMEOUT: "探测超时",
};
function report(e: unknown) {
  const text = e instanceof Error ? e.message : "操作失败";
  error.value = text.includes("HEALTH_CONFIG_CHANGED_RELOAD")
    ? "配置已被其他人修改，请重新加载后再保存"
    : text;
}
function apply(response: HealthResponse, replace: boolean) {
  if (response.revision < revision.value) return;
  online.value = response.device_online;
  supported.value = response.supported;
  remoteRevision.value = response.revision;
  results.value =
    replace || response.revision === revision.value || !dirty.value
      ? Object.fromEntries(response.checks.map((c) => [c.id, c.result]))
      : {};
  if (replace || (!dirty.value && response.revision !== revision.value)) {
    checks.value = response.checks.map(
      ({ result: _result, ...check }) => check,
    );
    revision.value = response.revision;
    saved.value = JSON.stringify(checks.value);
  }
  loaded.value = true;
}
async function load(replace = false) {
  if (loading) return;
  loading = true;
  try {
    const response = await api.request<HealthResponse>(path);
    if (!disposed) {
      apply(response, replace);
      error.value = "";
    }
  } catch (e) {
    if (!disposed) report(e);
  } finally {
    loading = false;
  }
}
function add() {
  checks.value.push({
    id: crypto.randomUUID(),
    name: "新健康检查",
    enabled: true,
    interval_secs: 30,
    timeout_ms: 3000,
    failure_threshold: 3,
    probe: { kind: "http", url: "", expected_status: 200, body_contains: "" },
  });
}
function changeProbe(check: HealthCheck, kind: string) {
  check.probe =
    kind === "tcp"
      ? { kind: "tcp", host: "127.0.0.1", port: 80 }
      : kind === "systemd"
        ? { kind: "systemd", unit: "" }
        : { kind: "http", url: "", expected_status: 200, body_contains: "" };
}
async function save() {
  if (saving.value || !editable.value) return;
  saving.value = true;
  error.value = "";
  message.value = "";
  try {
    const response = await api.request<HealthResponse>(path, {
      method: "PUT",
      body: { v: 1, revision: revision.value, checks: checks.value },
    });
    if (disposed) return;
    apply(response, true);
    message.value =
      response.device_online && response.supported
        ? "配置已保存，正在等待设备探测结果"
        : "配置已保存，设备上线并支持探测后自动生效";
    emit("changed");
  } catch (e) {
    if (!disposed) report(e);
  } finally {
    saving.value = false;
  }
}
async function run() {
  if (running.value || dirty.value || !editable.value) return;
  running.value = true;
  error.value = "";
  message.value = "";
  try {
    await api.request(path + "/run", {
      method: "POST",
      body: { v: 1, revision: revision.value },
    });
    if (!disposed) message.value = "已请求立即探测，结果稍后自动更新";
  } catch (e) {
    if (!disposed) report(e);
  } finally {
    running.value = false;
  }
}
onMounted(async () => {
  await load(true);
  if (!disposed)
    timer = setInterval(() => {
      if (!document.hidden && !saving.value) void load();
    }, 3000);
});
onBeforeUnmount(() => {
  disposed = true;
  clearInterval(timer);
});
</script>
<template>
  <div class="health-overlay">
    <section
      class="panel health-panel"
      role="dialog"
      aria-modal="true"
      :aria-label="`健康检查：${device.name}`"
    >
      <header class="panel-heading">
        <div>
          <h2>健康检查 · {{ device.name }}</h2>
          <p class="field-hint">
            由设备 Agent 执行，可检查设备自己的 localhost、端口和服务
          </p>
        </div>
        <button
          class="icon-button"
          aria-label="关闭健康检查"
          :disabled="saving"
          @click="emit('close')"
        >
          ×
        </button>
      </header>
      <div class="health-content">
        <p v-if="!loaded" class="muted">正在加载配置…</p>
        <template v-else>
          <div v-if="!online || !supported" class="notice warning">
            {{
              !online
                ? "设备离线。配置可以保存，上线后自动下发；业务健康保持未知。"
                : "当前 Agent 不支持健康探测，请更新 Agent。"
            }}
          </div>
          <p v-if="!editable" class="notice neutral">
            当前账号仅可查看；管理员和设备范围内的运维可以修改配置
          </p>
          <p v-if="!checks.length" class="health-empty">
            尚未配置健康检查，业务健康保持未知。
          </p>
          <form id="health-config-form" @submit.prevent="save">
            <article
              v-for="(check, index) in checks"
              :key="check.id"
              class="check-card"
            >
              <fieldset :disabled="!editable || saving">
                <div class="check-heading">
                  <label
                    >检查名称<input
                      v-model="check.name"
                      required
                      maxlength="80" /></label
                  ><label class="enabled-label"
                    ><input
                      v-model="check.enabled"
                      type="checkbox"
                    />启用检查</label
                  ><button
                    type="button"
                    class="text-button"
                    @click="checks.splice(index, 1)"
                  >
                    删除检查
                  </button>
                </div>
                <label
                  >检查类型<select
                    aria-label="检查类型"
                    :value="check.probe.kind"
                    @change="
                      changeProbe(
                        check,
                        ($event.target as HTMLSelectElement).value,
                      )
                    "
                  >
                    <option value="http">HTTP / HTTPS</option>
                    <option value="tcp">TCP 端口</option>
                    <option value="systemd">systemd 服务</option>
                  </select></label
                >
                <template v-if="check.probe.kind === 'http'">
                  <label
                    >检查地址<input
                      v-model="check.probe.url"
                      type="url"
                      required
                      maxlength="2048"
                      placeholder="http://127.0.0.1:8080/healthz"
                  /></label>
                  <div class="form-grid">
                    <label
                      >预期状态码<input
                        v-model.number="check.probe.expected_status"
                        type="number"
                        min="100"
                        max="599"
                        required /></label
                    ><label
                      >响应包含文本（可选）<input
                        v-model="check.probe.body_contains"
                        maxlength="256"
                        placeholder="留空则只检查状态码"
                    /></label>
                  </div>
                  <p class="field-hint">
                    校验 HTTPS 证书，不跟随重定向；文本检查最多读取 64 KiB
                    正文。地址中不支持账号密码。
                  </p>
                </template>
                <div v-else-if="check.probe.kind === 'tcp'" class="form-grid">
                  <label
                    >目标主机<input
                      v-model="check.probe.host"
                      required
                      maxlength="253"
                      placeholder="127.0.0.1" /></label
                  ><label
                    >目标端口<input
                      v-model.number="check.probe.port"
                      type="number"
                      min="1"
                      max="65535"
                      required
                  /></label>
                </div>
                <template v-else
                  ><label
                    >服务单元<input
                      v-model="check.probe.unit"
                      required
                      maxlength="200"
                      placeholder="nginx.service"
                      pattern="[a-zA-Z0-9_][a-zA-Z0-9_.@\-]*\.service"
                  /></label>
                  <p class="field-hint">
                    只读取运行状态，不启动或重启服务；没有 systemd
                    的设备显示未知。
                  </p></template
                >
                <div class="check-limits">
                  <label
                    >检查周期（秒）<input
                      v-model.number="check.interval_secs"
                      type="number"
                      min="5"
                      max="3600"
                      required /></label
                  ><label
                    >超时（毫秒）<input
                      v-model.number="check.timeout_ms"
                      type="number"
                      min="100"
                      :max="Math.min(30000, check.interval_secs * 1000)"
                      required /></label
                  ><label
                    >连续失败阈值<input
                      v-model.number="check.failure_threshold"
                      type="number"
                      min="1"
                      max="10"
                      required
                  /></label>
                </div>
              </fieldset>
              <div
                v-if="results[check.id]"
                class="check-result"
                :class="results[check.id]!.status"
                aria-live="polite"
              >
                <strong>{{ labels[results[check.id]!.status] }}</strong
                ><span>{{
                  reasons[results[check.id]!.reason] ?? "未知探测结果"
                }}</span
                ><span
                  >连续失败 {{ results[check.id]!.consecutive_failures }}/{{
                    check.failure_threshold
                  }}</span
                ><small
                  >最近探测
                  {{ formatTime(results[check.id]!.last_checked_at) }} · 耗时
                  {{ results[check.id]!.duration_ms ?? "—" }} ms</small
                >
              </div>
              <p v-else class="field-hint">保存后等待探测</p>
            </article>
            <button
              v-if="editable"
              type="button"
              class="button secondary small"
              :disabled="checks.length >= 8 || saving"
              @click="add"
            >
              添加检查
            </button>
          </form>
          <p class="field-hint">
            最多 8
            项。全部启用项通过才显示健康；达到失败阈值显示异常；未配置、未取得结果、结果过期或设备离线显示未知。
          </p>
          <p v-if="dirty" class="notice neutral">
            有未保存的修改，保存后才会下发到设备
          </p>
          <p v-if="remoteRevision !== revision" class="notice warning">
            远端配置已更新，请重新加载后修改
          </p>
        </template>
        <div v-if="error" class="notice danger" role="alert">{{ error }}</div>
        <div v-if="message" class="notice success" role="status">
          {{ message }}
        </div>
      </div>
      <footer class="health-actions">
        <button class="button secondary" :disabled="saving" @click="load(true)">
          重新加载配置</button
        ><button
          v-if="editable"
          class="button secondary"
          :disabled="
            !loaded ||
            saving ||
            running ||
            dirty ||
            !online ||
            !supported ||
            !checks.some((c) => c.enabled)
          "
          @click="run"
        >
          {{ running ? "正在请求…" : "立即探测" }}</button
        ><button
          v-if="editable"
          class="button primary"
          type="submit"
          form="health-config-form"
          :disabled="!loaded || saving || !dirty"
        >
          {{ saving ? "保存中…" : "保存配置" }}
        </button>
      </footer>
    </section>
  </div>
</template>
<style scoped>
.health-overlay {
  position: fixed;
  inset: 0;
  z-index: 90;
  background: #12202b80;
  display: flex;
  align-items: center;
  justify-content: center;
  padding: 24px;
}
.health-panel {
  width: min(850px, 100%);
  max-height: 92dvh;
  display: flex;
  flex-direction: column;
  margin: 0;
  min-height: 0;
}
.health-panel .panel-heading {
  flex-shrink: 0;
  gap: 16px;
  padding: 16px 20px;
  border-bottom: 1px solid var(--border);
}
.health-content {
  overflow: auto;
  padding: 20px;
}
.health-content > * + * {
  margin-top: 16px;
}
.health-empty {
  padding: 24px 0;
  color: var(--muted);
}
.check-card {
  padding: 18px;
  border: 1px solid var(--border);
  border-radius: 10px;
  margin-bottom: 16px;
}
.check-card fieldset {
  padding: 0;
  margin: 0;
  border: 0;
  display: grid;
  gap: 12px;
  min-width: 0;
}
.check-heading {
  display: flex;
  align-items: center;
  gap: 16px;
}
.check-heading > label:first-child {
  flex: 1;
  min-width: 0;
}
.check-heading .enabled-label {
  display: flex;
  align-items: center;
  gap: 6px;
  white-space: nowrap;
}
.enabled-label input {
  width: auto;
}
.check-limits {
  display: grid;
  grid-template-columns: repeat(3, minmax(0, 1fr));
  gap: 12px;
}
.check-result {
  margin-top: 16px;
  padding: 12px;
  background: #f4f7fa;
  border-radius: 6px;
  display: flex;
  flex-wrap: wrap;
  gap: 8px 16px;
  font-size: 12px;
}
.check-result small {
  width: 100%;
  color: var(--muted);
}
.check-result.healthy strong {
  color: #087f77;
}
.check-result.unhealthy strong {
  color: #bd4141;
}
.health-actions {
  display: flex;
  justify-content: flex-end;
  flex-wrap: wrap;
  gap: 10px;
  border-top: 1px solid var(--border);
  padding: 16px 20px;
}
@media (max-width: 700px) {
  .health-overlay {
    padding: 8px;
  }
  .health-panel {
    max-height: 96dvh;
  }
  .health-content {
    padding: 12px;
  }
  .check-card {
    padding: 12px;
  }
  .check-heading {
    flex-wrap: wrap;
  }
  .check-limits {
    grid-template-columns: 1fr;
  }
  .health-actions {
    padding: 12px;
  }
}
</style>
