<script setup lang="ts">
import { computed, ref, watch } from "vue";
import type { Task, User } from "../api/types";
import { api } from "../api/client";
import {
  canExecute,
  formatBytes,
  formatTime,
  outputPreview,
  terminalStates,
} from "../model";
import StatusBadge from "./StatusBadge.vue";
const props = defineProps<{ task: Task; user: User }>();
const emit = defineEmits<{ refresh: []; close: [] }>();
const cancelBusy = ref(false);
const cancelRequested = ref(false);
const error = ref("");
const output = ref<
  Record<string, { text: string; truncated: boolean; bytes: number }>
>({});
const loadingOutput = ref<string | null>(null);
let outputGeneration = 0;
watch(
  () => props.task.task_id,
  () => {
    outputGeneration++;
    output.value = {};
    error.value = "";
    cancelRequested.value = false;
    loadingOutput.value = null;
  },
);
const cancelAllowed = computed(
  () =>
    canExecute(props.user, props.task.device_id) &&
    !terminalStates.has(props.task.status),
);
async function cancel() {
  if (cancelBusy.value || !cancelAllowed.value) return;
  if (
    !window.confirm(
      "请求停止这条任务？取消请求需要 Agent 确认清理，提交请求不代表命令已经停止。",
    )
  )
    return;
  cancelBusy.value = true;
  error.value = "";
  try {
    await api.request(
      `/tasks/${encodeURIComponent(props.task.task_id)}/cancel`,
      { method: "POST", body: { v: 1 } },
    );
    cancelRequested.value = true;
    emit("refresh");
  } catch (e) {
    error.value = e instanceof Error ? e.message : "取消失败";
  } finally {
    cancelBusy.value = false;
  }
}
async function readOutput(stream: "stdout" | "stderr") {
  const artifact = props.task.result?.[stream];
  if (!artifact?.sha256 || loadingOutput.value) return;
  const generation = outputGeneration;
  loadingOutput.value = stream;
  error.value = "";
  try {
    const bytes = await api.output(
      `/tasks/${encodeURIComponent(props.task.task_id)}/output/${stream}`,
    );
    const hash = Array.from(
      new Uint8Array(await crypto.subtle.digest("SHA-256", bytes)),
      (b) => b.toString(16).padStart(2, "0"),
    ).join("");
    if (hash !== artifact.sha256 || bytes.length !== artifact.size)
      throw new Error(
        "输出对象大小或 SHA-256 与任务记录不符，未展示不可信内容",
      );
    if (generation === outputGeneration)
      output.value[stream] = { ...outputPreview(bytes), bytes: bytes.length };
  } catch (e) {
    if (generation === outputGeneration)
      error.value = e instanceof Error ? e.message : "输出读取失败";
  } finally {
    if (generation === outputGeneration) loadingOutput.value = null;
  }
}
</script>
<template>
  <section class="panel task-detail" aria-labelledby="task-title">
    <div class="panel-heading">
      <div>
        <div class="eyebrow">EXECUTION RECORD</div>
        <h2 id="task-title">任务详情 <StatusBadge :status="task.status" /></h2>
      </div>
      <button
        class="icon-button"
        aria-label="关闭任务详情"
        @click="emit('close')"
      >
        ×
      </button>
    </div>
    <div v-if="task.status === 'UNKNOWN'" class="notice warning">
      <strong>执行结果不确定</strong
      ><br />原命令可能已生效，禁止盲目重跑。请核对设备与原始证据后再决定是否创建新任务
    </div>
    <div v-if="task.result?.cleanup === 'unconfirmed'" class="notice warning">
      无法确认全部进程清理。即使控制连接恢复，也不能据此认为命令或后代进程已停止
    </div>
    <dl class="detail-grid">
      <dt>任务 ID</dt>
      <dd class="mono">{{ task.task_id }}</dd>
      <dt>设备 ID</dt>
      <dd class="mono">{{ task.device_id }}</dd>
      <dt>平台操作人</dt>
      <dd class="mono">{{ task.actor_id }}</dd>
      <dt>程序与参数</dt>
      <dd>
        <pre class="inline-code">{{ JSON.stringify(task.argv, null, 2) }}</pre>
      </dd>
      <dt>工作目录</dt>
      <dd class="mono">{{ task.cwd }}</dd>
      <dt>创建时间</dt>
      <dd>{{ formatTime(task.created_at) }}</dd>
      <dt>排队截止</dt>
      <dd>{{ formatTime(task.expires_at) }}</dd>
      <dt>执行超时</dt>
      <dd>{{ task.timeout_ms }} ms</dd>
      <dt>输出硬上限</dt>
      <dd>{{ formatBytes(task.max_output_bytes) }}</dd>
      <dt>不可变请求哈希</dt>
      <dd class="mono hash">{{ task.payload_hash }}</dd>
    </dl>
    <div class="result-summary">
      <div>
        <span>退出码</span><strong>{{ task.result?.exit_code ?? "—" }}</strong>
      </div>
      <div>
        <span>审计完整性</span
        ><strong
          :class="task.result?.audit_complete === false ? 'text-danger' : ''"
          >{{
            task.result == null
              ? "待完成"
              : task.result.audit_complete
                ? "完整"
                : "不完整"
          }}</strong
        >
      </div>
      <div>
        <span>结束时间</span
        ><strong class="small">{{
          formatTime(task.result?.finished_at)
        }}</strong>
      </div>
    </div>
    <div v-if="task.result?.audit_complete === false" class="notice danger">
      审计记录不完整。已捕获输出不代表全部输出，请核对以下原因与清理状态
    </div>
    <dl v-if="task.result" class="detail-grid compact">
      <dt>开始时间</dt>
      <dd>{{ formatTime(task.result.started_at) }}</dd>
      <dt>结束原因</dt>
      <dd class="mono">{{ task.result.reason ?? "无" }}</dd>
      <dt>清理证据</dt>
      <dd>
        {{
          task.result.cleanup === "process_group"
            ? "进程组已处理（不保证逃逸后代）"
            : task.result.cleanup === "not_started"
              ? "尚未启动进程"
              : "未确认"
        }}
      </dd>
    </dl>
    <div v-if="error" class="notice danger" role="alert">{{ error }}</div>
    <div
      v-for="stream in ['stdout', 'stderr'] as const"
      :key="stream"
      class="output-section"
    >
      <div class="output-heading">
        <h3 class="mono">{{ stream }}</h3>
        <span class="muted small">{{
          task.result?.[stream]?.size != null
            ? formatBytes(task.result[stream]!.size)
            : "暂无输出对象"
        }}</span
        ><button
          class="button small secondary"
          :disabled="!task.result?.[stream]?.sha256 || !!loadingOutput"
          @click="readOutput(stream)"
        >
          {{ loadingOutput === stream ? "读取中…" : "读取输出 · 留痕" }}
        </button>
      </div>
      <pre class="output-text" :data-stream="stream">{{
        output[stream]?.text || (output[stream] ? "（空输出）" : "输出尚未读取")
      }}</pre>
      <p v-if="output[stream]" class="field-hint">
        已核对对象大小与 SHA-256 · {{ task.result?.[stream]?.sha256 }}
      </p>
      <p v-if="output[stream]?.truncated" class="field-hint">
        仅预览前 64 KiB；完整对象共
        {{ formatBytes(output[stream]!.bytes) }}，已校验
        SHA-256，预览截断不代表审计丢失
      </p>
    </div>
    <p class="field-hint">
      输出按纯文本展示；控制字符转义，无效 UTF-8
      使用替代字符。每次读取都会记录审计
    </p>
    <div v-if="task.events?.length" class="timeline">
      <h3>持久化事件</h3>
      <div v-for="event in task.events" :key="event.event_id">
        <span class="mono">#{{ event.seq }}</span
        ><strong>{{ event.kind }}</strong
        ><span>{{ formatTime(event.at) }}</span>
      </div>
    </div>
    <div class="form-actions">
      <span v-if="task.cancel_requested || cancelRequested" class="field-hint"
        >已请求取消，等待 Agent 的真实结束与清理结果</span
      ><button
        v-if="cancelAllowed"
        class="button danger-outline"
        :disabled="cancelBusy || !!task.cancel_requested || cancelRequested"
        @click="cancel"
      >
        {{
          cancelBusy
            ? "请求中…"
            : task.cancel_requested || cancelRequested
              ? "等待取消确认"
              : "请求取消任务"
        }}
      </button>
    </div>
  </section>
</template>
