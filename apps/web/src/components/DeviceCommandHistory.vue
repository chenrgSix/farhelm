<script setup lang="ts">
import {
  computed,
  onBeforeUnmount,
  onMounted,
  reactive,
  ref,
  watch,
} from "vue";
import { api } from "../api/client";
import { formatTime } from "../model";
import type { TerminalSession } from "../api/types";
const props = defineProps<{
  deviceId: string;
  deviceName: string;
  jumpKey?: number;
}>();
const panel = ref<HTMLElement>();
const jump = () => {
  if (props.jumpKey) panel.value?.scrollIntoView?.({ block: "start" });
};
onMounted(jump);
watch(() => props.jumpKey, jump, { flush: "post" });
const emit = defineEmits<{ replay: [session: TerminalSession, seq: number] }>();
type Command = {
  id: number;
  session_id: string;
  actor_username: string;
  command: string;
  redacted: number;
  started_at: number;
  ended_at: number | null;
  exit_code: number | null;
  recording_seq: number;
  transport: string;
  session_status: string;
};
const filters = reactive({ from: "", to: "", actor: "", q: "" });
const rows = ref<Command[]>([]);
const busy = ref(false),
  queried = ref(false),
  error = ref("");
const cursors = ref<(string | null)[]>([null]);
const next = ref<string | null>(null);
let generation = 0;
const rangeError = computed(() => {
  if (!filters.from || !filters.to) return "请选择开始和结束时间。";
  const from = new Date(filters.from).getTime(),
    to = new Date(filters.to).getTime();
  return !Number.isFinite(from) || !Number.isFinite(to) || from >= to
    ? "结束时间必须晚于开始时间。"
    : to - from > 7 * 86400000
      ? "单次查询时间范围不能超过 7 天。"
      : "";
});
function reset() {
  generation++;
  rows.value = [];
  queried.value = false;
  next.value = null;
  cursors.value = [null];
  busy.value = false;
  error.value = "";
}
watch([() => ({ ...filters }), () => props.deviceId], reset);
onBeforeUnmount(() => generation++);
function recent(days: number) {
  const local = (time: number) => {
    const d = new Date(time);
    return new Date(time - d.getTimezoneOffset() * 60000)
      .toISOString()
      .slice(0, 16);
  };
  const end = Math.ceil(Date.now() / 60000) * 60000;
  filters.from = local(end - days * 86400000);
  filters.to = local(end);
}
async function load(direction: "query" | "next" | "back" = "query") {
  if (rangeError.value) {
    error.value = rangeError.value;
    return;
  }
  const stack =
    direction === "query"
      ? [null]
      : direction === "next"
        ? [...cursors.value, next.value]
        : cursors.value.slice(0, -1);
  const run = ++generation;
  busy.value = true;
  error.value = "";
  const params = new URLSearchParams({
    from: String(new Date(filters.from).getTime()),
    to: String(new Date(filters.to).getTime()),
    limit: "50",
  });
  if (filters.q.trim()) params.set("q", filters.q.trim());
  if (filters.actor.trim()) params.set("actor", filters.actor.trim());
  if (stack.at(-1)) params.set("cursor", stack.at(-1)!);
  try {
    const data = await api.request<{
      commands: Command[];
      page: { next_cursor: string | null };
    }>(
      `/devices/${encodeURIComponent(props.deviceId)}/terminal-commands?${params}`,
    );
    if (run !== generation) return;
    rows.value = data.commands;
    next.value = data.page.next_cursor;
    cursors.value = stack;
    queried.value = true;
  } catch (e) {
    if (run === generation)
      error.value = e instanceof Error ? e.message : "查询失败";
  } finally {
    if (run === generation) busy.value = false;
  }
}
async function replay(row: Command) {
  const run = ++generation;
  busy.value = true;
  error.value = "";
  try {
    const data = await api.request<{ session: TerminalSession }>(
      `/terminal-sessions/${encodeURIComponent(row.session_id)}`,
    );
    if (run === generation) emit("replay", data.session, row.recording_seq);
  } catch (e) {
    if (run === generation)
      error.value = e instanceof Error ? e.message : "读取会话失败";
  } finally {
    if (run === generation) busy.value = false;
  }
}
</script>

<template>
  <section
    ref="panel"
    class="panel command-history"
    aria-label="单设备命令历史"
  >
    <h2>终端命令历史</h2>
    <p class="muted">
      {{ deviceName }} · 网页终端与 Farhelm SSH 入口。时间必选，单次最多 7
      天，每页 50 条。
    </p>
    <form @submit.prevent="load()" class="command-filters">
      <label
        >开始时间（必选）<input
          v-model="filters.from"
          type="datetime-local"
          required
      /></label>
      <label
        >结束时间（必选）<input
          v-model="filters.to"
          type="datetime-local"
          required
      /></label>
      <label
        >用户<input
          v-model="filters.actor"
          maxlength="128"
          placeholder="账号包含文字，或完整用户 ID"
      /></label>
      <label
        >命令模糊搜索<input
          v-model="filters.q"
          type="search"
          maxlength="256"
          placeholder="例如 docker、systemctl"
      /></label>
      <div class="command-buttons">
        <button type="button" class="button secondary small" @click="recent(1)">
          最近 24 小时
        </button>
        <button type="button" class="button secondary small" @click="recent(7)">
          最近 7 天
        </button>
        <button
          type="submit"
          class="button primary small"
          :disabled="busy || !!rangeError"
        >
          {{ busy ? "读取中…" : "查询命令" }}
        </button>
      </div>
    </form>
    <p v-if="rangeError" class="muted small">{{ rangeError }}</p>
    <p v-if="error" class="text-danger" role="alert">{{ error }}</p>
    <p v-if="!queried" class="muted">
      选择时间范围后查询。仅展示你有权查看的会话。
    </p>
    <p v-else-if="!rows.length" class="muted">
      此范围内没有匹配的命令。旧会话、不支持采集的 Shell 或未更新的 Agent
      可继续查看原会话回放。
    </p>
    <div v-if="rows.length" class="table-scroll">
      <table>
        <thead>
          <tr>
            <th>执行时间</th>
            <th>用户 / 来源</th>
            <th>命令</th>
            <th>结果</th>
            <th>会话</th>
          </tr>
        </thead>
        <tbody>
          <tr v-for="row in rows" :key="row.id">
            <td>{{ formatTime(row.started_at) }}</td>
            <td>
              {{ row.actor_username
              }}<small class="muted block">{{
                row.transport === "ssh" ? "SSH 入口" : "网页终端"
              }}</small>
            </td>
            <td>
              <pre class="command-text">{{ row.command }}</pre>
            </td>
            <td>
              {{
                row.exit_code !== null
                  ? `退出码 ${row.exit_code}`
                  : row.ended_at
                    ? "结果未确认"
                    : "执行中 / 等待返回"
              }}
            </td>
            <td>
              <button
                class="button secondary small"
                :disabled="busy"
                @click="replay(row)"
              >
                定位回放
              </button>
            </td>
          </tr>
        </tbody>
      </table>
      <div class="command-buttons">
        <span class="muted small"
          >第 {{ cursors.length }} 页 · 本页 {{ rows.length }} 条</span
        >
        <button
          class="button secondary small"
          :disabled="busy || cursors.length === 1"
          @click="load('back')"
        >
          上一页
        </button>
        <button
          class="button secondary small"
          :disabled="busy || !next"
          @click="load('next')"
        >
          下一页
        </button>
      </div>
    </div>
    <p class="muted small">
      仅记录新会话的 Bash / Zsh
      命令，旧会话不补录。密码提示和程序内输入不采集；进入其他 Shell
      后的命令可能缺失。已识别的敏感参数命令在列表中隐藏。
    </p>
  </section>
</template>

<style scoped>
.command-history {
  margin-top: 20px;
  padding: 22px;
}
.command-history h2 {
  margin-top: 0;
}
.command-filters {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: 12px;
}
.command-buttons {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 8px;
  grid-column: 1/-1;
  margin: 12px 0;
}
.command-text {
  white-space: pre-wrap;
  overflow-wrap: anywhere;
  max-width: 600px;
  min-width: 160px;
  font-size: 12px;
}
@media (max-width: 640px) {
  .command-filters {
    grid-template-columns: 1fr;
  }
  .command-history {
    padding: 16px;
  }
}
</style>
