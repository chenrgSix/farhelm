<script setup lang="ts">
import { onBeforeUnmount, onMounted, ref } from "vue";
import { api, ApiError } from "../api/client";
import type { Task } from "../api/types";
import { statusLabels, terminalStates } from "../model";

const props = defineProps<{ url: string; name: string }>();
defineEmits<{ close: [] }>();
interface Page {
  stdout: string;
  stderr: string;
  next: number;
  status: Task["status"];
}
const stdout = ref(""),
  stderr = ref(""),
  status = ref<Task["status"]>("QUEUED");
const next = ref(0),
  text = ref(""),
  sending = ref(false),
  error = ref(""),
  sendError = ref("");
const streams = {
  stdout: { text: stdout, offset: 0, decoder: new TextDecoder() },
  stderr: { text: stderr, offset: 0, decoder: new TextDecoder() },
};
let draftSeq = 0;
let stopped = false,
  timer: ReturnType<typeof setTimeout> | undefined,
  pending: Promise<void> | undefined;
function schedule(ms: number) {
  clearTimeout(timer);
  if (!stopped && !sending.value)
    timer = setTimeout(() => {
      pending = update();
    }, ms);
}
async function update(input?: { seq: number; text: string }) {
  try {
    const page = await api.request<Page>(props.url, {
      method: "POST",
      body: {
        v: 1,
        stdout_offset: streams.stdout.offset,
        stderr_offset: streams.stderr.offset,
        ...(input ? { input } : {}),
      },
    });
    if (stopped) return;
    let more = false;
    for (const stream of ["stdout", "stderr"] as const) {
      const bytes = Uint8Array.from(atob(page[stream]), (c) => c.charCodeAt(0));
      const state = streams[stream];
      state.offset += bytes.length;
      state.text.value += state.decoder.decode(bytes, { stream: true });
      more ||= bytes.length === 8192;
    }
    if (input || (text.value && draftSeq !== page.next && page.next > 0)) {
      if (!input) sendError.value = "回答序号已改变，请按当前提示重新填写。";
      text.value = "";
      draftSeq = 0;
    }
    next.value = page.next;
    status.value = page.status;
    error.value = "";
    if (terminalStates.has(page.status) && !more) {
      stdout.value += streams.stdout.decoder.decode();
      stderr.value += streams.stderr.decoder.decode();
      stopped = true;
    } else schedule(more ? 0 : 700);
  } catch (e) {
    if (stopped) return;
    const msg = e instanceof Error ? e.message : "无法连接脚本";
    if (input) sendError.value = msg + "。请核对脚本输出后再决定是否发送。";
    else error.value = msg;
    next.value = 0;
    if (e instanceof ApiError && [401, 403, 404].includes(e.status)) {
      stopped = true;
      stdout.value = stderr.value = "";
    } else schedule(1200);
  }
}
async function send() {
  const seq = next.value,
    line = text.value;
  if (!seq || sending.value || stopped) return;
  sending.value = true;
  sendError.value = "";
  clearTimeout(timer);
  try {
    await pending;
    if (seq === next.value && (!line || draftSeq === seq) && !stopped)
      await update({ seq, text: line });
    else sendError.value = "输入状态已改变，请核对当前提示。";
  } finally {
    sending.value = false;
    schedule(0);
  }
}
onMounted(() => {
  pending = update();
});
onBeforeUnmount(() => {
  stopped = true;
  clearTimeout(timer);
});
</script>
<template>
  <section class="line-console" aria-label="逐行交互">
    <div class="header">
      <strong>{{ name }} · {{ statusLabels[status] }}</strong
      ><button type="button" class="text-button" @click="$emit('close')">
        关闭面板
      </button>
    </div>
    <p class="field-hint">
      运行时显示脚本输出。输入一行后按回车发送，空行也可以发送。
    </p>
    <pre aria-label="标准输出">{{ stdout || "等待脚本输出…" }}</pre>
    <pre v-if="stderr" aria-label="标准错误">{{ stderr }}</pre>
    <form v-if="!terminalStates.has(status)" @submit.prevent="send">
      <label
        >回答脚本<input
          v-model="text"
          @input="draftSeq = next"
          :disabled="!next || sending"
          maxlength="1024"
          autocomplete="off"
      /></label>
      <button class="button primary" type="submit" :disabled="!next || sending">
        发送回答
      </button>
    </form>
    <p v-if="error || sendError" class="notice warning" role="status">
      {{ sendError || error }}
    </p>
  </section>
</template>
<style scoped>
.line-console {
  min-width: 0;
  margin: 16px 0;
}
.header,
form {
  display: flex;
  align-items: center;
  gap: 10px;
  flex-wrap: wrap;
}
pre {
  max-height: 18rem;
  overflow: auto;
  white-space: pre-wrap;
  overflow-wrap: anywhere;
  padding: 10px;
  background: var(--surface);
}
</style>
