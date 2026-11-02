<script setup lang="ts">
import { onBeforeUnmount, onMounted, ref } from "vue";
import { api, ApiError } from "../api/client";
import type { CommandResponse, Device, Task, User } from "../api/types";
import { formatTime, statusLabels, terminalStates } from "../model";
import TaskDetail from "./TaskDetail.vue";

interface Button {
  id: string;
  name: string;
  revision: number;
  script?: string;
}
interface Recent {
  id: string;
  name: string;
  status: Task["status"];
  created_at: number;
}
const props = defineProps<{ device: Device; user: User }>();
const base = "/devices/" + encodeURIComponent(props.device.id) + "/scripts";
const buttons = ref<Button[]>([]),
  runs = ref<Recent[]>([]);
const draft = ref<Button>(),
  task = ref<Task>(),
  selected = ref(""),
  error = ref(""),
  notice = ref(""),
  busy = ref(false);
let generation = 0,
  disposed = false,
  timer: ReturnType<typeof setTimeout> | undefined;
type Attempt = { id: string; revision: number; key: string };
const retry = ref<Attempt>();
const storageKey =
  "farhelm.script-attempt." + props.user.id + "." + props.device.id;
function remember(attempt?: Attempt) {
  retry.value = attempt;
  try {
    if (attempt) sessionStorage.setItem(storageKey, JSON.stringify(attempt));
    else sessionStorage.removeItem(storageKey);
  } catch {
    /* The in-memory retry remains available if storage is disabled. */
  }
}
function clearAfterReview() {
  if (window.confirm("已核对任务记录？结束重试后再点击会创建新的任务。"))
    remember();
}

const message = (e: unknown) => (e instanceof Error ? e.message : "操作失败");
async function load() {
  const value = await api.request<{
    scripts: Button[];
    runs: Recent[];
  }>(base);
  if (disposed) return;
  buttons.value = value.scripts;
  runs.value = value.runs;
}
async function refresh() {
  error.value = "";
  try {
    await load();
    draft.value = undefined;
  } catch (e) {
    error.value = message(e);
  }
}
function edit(row?: Button) {
  error.value = notice.value = "";
  draft.value = row
    ? { ...row }
    : { id: "", name: "", script: "", revision: 0 };
}
async function change(remove = false) {
  const row = draft.value;
  if (busy.value || !row) return;
  if (
    remove &&
    !window.confirm("删除「" + row.name + "」？已有执行记录会保留。")
  )
    return;
  busy.value = true;
  error.value = notice.value = "";
  try {
    const revision = row.id ? { revision: row.revision } : {};
    await api.request(base + (row.id ? "/" + encodeURIComponent(row.id) : ""), {
      method: remove ? "DELETE" : row.id ? "PUT" : "POST",
      body: remove
        ? { v: 1, ...revision }
        : {
            v: 1,
            name: row.name.trim(),
            script: row.script,
            ...revision,
          },
    });
    draft.value = undefined;
    notice.value = remove ? "操作已删除。" : "操作已保存。";
    await load();
  } catch (e) {
    error.value = message(e);
  } finally {
    busy.value = false;
  }
}
function closeResult() {
  ++generation;
  clearTimeout(timer);
  selected.value = "";
  task.value = undefined;
}
async function inspect(id: string) {
  clearTimeout(timer);
  const serial = ++generation;
  if (selected.value !== id) task.value = undefined;
  selected.value = id;
  try {
    const value = await api.request<Task>("/tasks/" + encodeURIComponent(id));
    if (disposed || serial !== generation) return;
    task.value = value;
    const item = runs.value.find((r) => r.id === id);
    if (item) item.status = value.status;
    if (!terminalStates.has(value.status))
      timer = setTimeout(() => inspect(id), 1400);
  } catch (e) {
    if (serial === generation && !disposed) error.value = message(e);
  }
}
async function run(row: Button) {
  if (busy.value || (retry.value && retry.value.id !== row.id)) return;
  const previous = retry.value;
  if (
    !previous &&
    !window.confirm("在「" + props.device.name + "」执行「" + row.name + "」？")
  )
    return;
  const attempt = previous ?? {
    id: row.id,
    revision: row.revision,
    key: Array.from(crypto.getRandomValues(new Uint8Array(16)), (n) =>
      n.toString(16).padStart(2, "0"),
    ).join(""),
  };
  busy.value = true;
  error.value = notice.value = "";
  remember(attempt);
  try {
    const response = await api.request<CommandResponse>(
      base + "/" + encodeURIComponent(row.id) + "/run",
      {
        method: "POST",
        idempotencyKey: attempt.key,
        body: { v: 1, revision: attempt.revision },
      },
    );
    remember();
    notice.value = "已提交「" + row.name + "」。";
    await inspect(response.task_id);
    await load();
  } catch (e) {
    if (e instanceof ApiError && e.status > 0 && e.status < 500) remember();
    error.value = message(e);
  } finally {
    busy.value = false;
  }
}
onMounted(() => {
  try {
    const saved = JSON.parse(sessionStorage.getItem(storageKey) ?? "null");
    if (
      saved &&
      typeof saved.id === "string" &&
      Number.isSafeInteger(saved.revision) &&
      typeof saved.key === "string" &&
      /^[0-9a-f]{32}$/.test(saved.key)
    )
      retry.value = saved;
  } catch {
    /* No recoverable attempt in this tab. */
  }
  void refresh();
});
onBeforeUnmount(() => {
  disposed = true;
  closeResult();
});
</script>
<template>
  <section class="workbench panel" aria-label="设备操作台">
    <header class="panel-heading">
      <div>
        <h3>设备操作台</h3>
        <p class="field-hint">点击已配置的操作，查看执行结果和输出。</p>
      </div>
      <div class="controls">
        <button
          type="button"
          class="button secondary small"
          :disabled="busy"
          @click="refresh"
        >
          刷新操作台
        </button>
        <button
          v-if="user.role === 'admin'"
          type="button"
          class="button primary small"
          :disabled="busy"
          @click="edit()"
        >
          添加操作
        </button>
      </div>
    </header>
    <p v-if="error" role="alert" class="notice danger">{{ error }}</p>
    <p v-if="notice" role="status" class="notice neutral">{{ notice }}</p>
    <p v-if="retry && !busy" class="notice warning">
      提交结果待确认。可用原请求重试，或在任务中心核对。
      <button type="button" class="text-button" @click="clearAfterReview">
        已核对，结束重试
      </button>
    </p>
    <p v-if="!buttons.length" class="muted">
      {{
        user.role === "admin"
          ? "这台设备还没有配置操作。"
          : "当前没有可执行的操作。"
      }}
    </p>
    <ul v-else class="buttons">
      <li v-for="row in buttons" :key="row.id">
        <button
          class="button secondary"
          :disabled="busy || (!!retry && retry.id !== row.id)"
          @click="run(row)"
        >
          {{ retry?.id === row.id ? "重试 · " : "" }}{{ row.name }}
        </button>
        <button
          v-if="user.role === 'admin'"
          class="text-button"
          :disabled="busy"
          :aria-label="'配置 ' + row.name"
          @click="edit(row)"
        >
          配置
        </button>
      </li>
    </ul>
    <form v-if="draft" class="editor" @submit.prevent="change()">
      <fieldset :disabled="busy">
        <legend>{{ draft.id ? "配置操作" : "添加操作" }}</legend>
        <label
          >按钮名称<input
            v-model="draft.name"
            required
            maxlength="80"
            placeholder="例如：检查服务状态"
        /></label>
        <label
          >Shell 脚本<textarea
            v-model="draft.script"
            class="mono"
            rows="5"
            required
            maxlength="8192"
            spellcheck="false"
            placeholder="/bin/sh /opt/ops/check-service.sh"
          ></textarea>
        </label>
        <p class="field-hint">
          使用 /bin/sh，在 /tmp
          下执行。可以粘贴脚本，也可以调用设备上已有的脚本。每次执行限时 60 秒。
        </p>
        <p class="field-hint">
          拥有这台设备访问权限和「运行设备操作台」权限的同事可以执行此操作。
        </p>
        <div class="controls">
          <button class="button primary" type="submit">保存操作</button
          ><button
            class="button secondary"
            type="button"
            @click="draft = undefined"
          >
            取消
          </button>
          <button
            v-if="draft.id"
            class="button danger-outline"
            type="button"
            @click="change(true)"
          >
            删除操作
          </button>
        </div>
      </fieldset>
    </form>
    <div v-if="runs.length">
      <h4>我最近的执行</h4>
      <ul class="runs">
        <li v-for="item in runs" :key="item.id">
          <button class="text-button" @click="inspect(item.id)">
            {{ item.name }} · {{ statusLabels[item.status] }} ·
            {{ formatTime(item.created_at) }}
          </button>
        </li>
      </ul>
    </div>
    <TaskDetail
      v-if="task"
      :key="task.task_id"
      compact
      :operation-name="runs.find((item) => item.id === task?.task_id)?.name"
      :task="task"
      :user="user"
      @close="closeResult"
      @refresh="inspect(task.task_id)"
    />
  </section>
</template>
<style scoped>
.workbench {
  padding: 20px;
  min-width: 0;
}
.workbench .panel-heading {
  padding: 0;
  align-items: flex-start;
}
.workbench h3 {
  margin: 0;
}
.field-hint {
  margin: 6px 0;
}
.controls,
.buttons,
.buttons li {
  display: flex;
  align-items: center;
  gap: 10px;
  flex-wrap: wrap;
}
.buttons,
.runs {
  list-style: none;
  padding: 0;
}
.buttons li {
  padding: 6px;
  background: var(--surface);
  border: 1px solid var(--line);
  border-radius: 8px;
}
.editor {
  margin: 16px 0;
}
.editor fieldset {
  min-width: 0;
}
.editor legend {
  font-weight: 600;
}
.controls {
  margin-top: 8px;
}
.runs li {
  margin: 5px 0;
}
</style>
