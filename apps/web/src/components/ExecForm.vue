<script setup lang="ts">
import { computed, reactive, ref, onBeforeUnmount } from "vue";
import type { CommandResponse, Device, User } from "../api/types";
import { api } from "../api/client";
import { canExecute, CommandAttempt, parseCommand } from "../model";
const props = defineProps<{
  devices: Device[];
  user: User;
  initialDevice?: string;
}>();
const emit = defineEmits<{ created: [id: string]; close: [] }>();
const form = reactive({
  device_id: props.initialDevice ?? "",
  argv: '["/usr/bin/uptime"]',
  cwd: "/tmp",
  timeout_ms: 30000,
  max_output_bytes: 262144,
  ttl_seconds: 300,
});
const attempt = ref<CommandAttempt | null>(null);
const busy = ref(false);
const error = ref("");
const allowedDevices = computed(() =>
  props.devices.filter((d) => !d.revoked_at && canExecute(props.user, d.id)),
);
async function submit() {
  if (busy.value || attempt.value?.state === "confirmed") return;
  error.value = "";
  try {
    if (!attempt.value) {
      const request = parseCommand(form);
      if (!canExecute(props.user, request.device_id))
        throw new Error("当前账号无权在此设备执行命令");
      attempt.value = new CommandAttempt(request);
    }
    busy.value = true;
    attempt.value.state = "pending";
    const result = await api.request<CommandResponse>("/commands", {
      method: "POST",
      body: attempt.value.request,
      idempotencyKey: attempt.value.key,
    });
    attempt.value.state = "confirmed";
    attempt.value.taskId = result.task_id;
    emit("created", result.task_id);
  } catch (e) {
    error.value = e instanceof Error ? e.message : "提交失败";
    if (attempt.value) attempt.value.state = "uncertain";
  } finally {
    busy.value = false;
  }
}
function reset() {
  if (
    attempt.value?.state === "uncertain" &&
    !window.confirm(
      "上一次请求可能已经创建任务。请先核对任务中心；继续新建会使用新的幂等键，并可能再次执行相同命令。确定新建？",
    )
  )
    return;
  attempt.value = null;
  error.value = "";
}
function close() {
  if (
    attempt.value?.state === "uncertain" &&
    !window.confirm(
      "上次提交结果尚未确认。关闭后将失去本次重试键，请先在任务中心核对。仍然关闭？",
    )
  )
    return;
  emit("close");
}
function warnUnload(event: BeforeUnloadEvent) {
  if (attempt.value?.state === "uncertain" || busy.value) {
    event.preventDefault();
    event.returnValue = "";
  }
}
window.addEventListener("beforeunload", warnUnload);
onBeforeUnmount(() => window.removeEventListener("beforeunload", warnUnload));
</script>
<template>
  <section class="panel exec-panel" aria-labelledby="exec-title">
    <div class="panel-heading">
      <div>
        <div class="eyebrow">AUTHORIZED EXEC</div>
        <h2 id="exec-title">执行单条命令</h2>
      </div>
      <button
        class="icon-button"
        :disabled="busy"
        aria-label="关闭命令表单"
        @click="close"
      >
        ×
      </button>
    </div>
    <div class="notice neutral">
      单账号执行；命令与 Agent 共享主机权限，平台记录不等于端点强隔离
    </div>
    <form @submit.prevent="submit">
      <fieldset :disabled="busy || !!attempt">
        <label
          >目标设备<select v-model="form.device_id" required>
            <option value="" disabled>选择授权设备</option>
            <option
              v-for="device in allowedDevices"
              :key="device.id"
              :value="device.id"
            >
              {{ device.name }} ·
              {{ device.control_online ? "控制在线" : "控制离线" }}
            </option>
          </select></label
        >
        <label
          >程序与参数 · JSON 数组<textarea
            v-model="form.argv"
            class="mono"
            rows="3"
            spellcheck="false"
            required
            aria-describedby="argv-hint"
          ></textarea>
        </label>
        <p id="argv-hint" class="field-hint">
          每个参数独立传入，不自动拼接 Shell。管道、重定向和变量不会被展开
        </p>
        <label
          >工作目录<input
            v-model="form.cwd"
            class="mono"
            required
            maxlength="4096"
            placeholder="/tmp"
        /></label>
        <div class="form-grid">
          <label
            >执行超时（毫秒）<input
              v-model.number="form.timeout_ms"
              type="number"
              min="100"
              max="3600000"
              step="1"
              required /></label
          ><label
            >排队 TTL（秒）<input
              v-model.number="form.ttl_seconds"
              type="number"
              min="1"
              max="86400"
              step="1"
              required
          /></label>
        </div>
        <label
          >stdout + stderr 硬上限（字节）<input
            v-model.number="form.max_output_bytes"
            type="number"
            min="0"
            max="1048576"
            step="1"
            required
        /></label>
        <p class="field-hint">
          离线设备将在 TTL 内等待。输出超限需中止并标记审计状态，不会静默忽略
        </p>
      </fieldset>
      <div v-if="error" class="notice danger" role="alert">{{ error }}</div>
      <div v-if="attempt?.state === 'uncertain'" class="notice warning">
        提交结果尚未确认。重试会沿用相同幂等键与原始参数，避免重复创建任务；请勿通过刷新页面重试
      </div>
      <div v-if="attempt?.state === 'confirmed'" class="notice success">
        任务已创建：<span class="mono">{{ attempt.taskId }}</span
        >。已锁定本次提交，可在任务中心查看
      </div>
      <div v-if="attempt" class="field-hint mono">幂等键 {{ attempt.key }}</div>
      <div class="form-actions">
        <button
          v-if="attempt && !busy"
          type="button"
          class="button secondary"
          @click="reset"
        >
          新建另一条任务</button
        ><button
          class="button primary"
          type="submit"
          :disabled="
            busy || attempt?.state === 'confirmed' || !allowedDevices.length
          "
        >
          {{
            busy
              ? "正在提交…"
              : attempt?.state === "uncertain"
                ? "使用原请求重试"
                : attempt?.state === "confirmed"
                  ? "已提交"
                  : "确认创建并执行"
          }}
        </button>
      </div>
    </form>
  </section>
</template>
