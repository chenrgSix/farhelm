<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref } from "vue";
import { api, ApiError } from "../api/client";
import type { CommandResponse, Device, Task, User } from "../api/types";
import {
  hasPermission,
  formatTime,
  statusLabels,
  terminalStates,
} from "../model";
import TaskDetail from "./TaskDetail.vue";

interface Button {
  id: string;
  name: string;
  revision: number;
  script?: string;
}
interface ActiveRun {
  script_id: string;
  task_id: string;
  actor_username: string;
  status: Task["status"];
  created_at: number;
  backend: "agent" | "ssh";
}
interface Recent {
  id: string;
  name: string;
  status: Task["status"];
  created_at: number;
}
const props = defineProps<{ device: Device; user: User }>();
const base = "/devices/" + encodeURIComponent(props.device.id) + "/scripts";
const canManage = computed(() =>
  hasPermission(props.user, "scripts.manage", props.device.id),
);
const canRun = computed(() =>
  hasPermission(props.user, "scripts.run", props.device.id),
);
const buttons = ref<Button[]>([]),
  runs = ref<Recent[]>([]);
const activeRuns = ref<ActiveRun[]>([]);
const activityKnown = ref(false),
  activityError = ref("");
const byScript = computed(() => {
  const groups = new Map<string, ActiveRun[]>();
  for (const run of activeRuns.value) {
    const group = groups.get(run.script_id);
    if (group) group.push(run);
    else groups.set(run.script_id, [run]);
  }
  return groups;
});
let activityVersion = 0,
  pollTimer: ReturnType<typeof setInterval> | undefined,
  polling = false;
function setActivity(version: number, rows: ActiveRun[]) {
  if (disposed || version !== activityVersion) return;
  if (!Array.isArray(rows)) {
    activityKnown.value = false;
    activityError.value = "服务端未提供脚本执行状态，请刷新或检查服务端版本。";
    return;
  }
  activeRuns.value = rows;
  activityKnown.value = true;
  activityError.value = "";
}
async function refreshActivity() {
  const version = ++activityVersion;
  try {
    const result = await api.request<{ activity: ActiveRun[] }>(
      base + "/activity",
    );
    setActivity(version, result.activity);
  } catch (e) {
    if (disposed || version !== activityVersion) return;
    if (e instanceof ApiError && [401, 403].includes(e.status))
      activeRuns.value = [];
    activityKnown.value = false;
    activityError.value = "无法确认执行状态，恢复连接后可再次运行。";
  }
}
async function pollActivity() {
  if (document.hidden || polling || disposed) return;
  polling = true;
  try {
    await refreshActivity();
  } finally {
    polling = false;
  }
}
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
  const version = ++activityVersion;
  const value = await api.request<{
    scripts: Button[];
    runs: Recent[];
    activity: ActiveRun[];
  }>(base);
  if (disposed) return;
  buttons.value = value.scripts;
  runs.value = value.runs;
  setActivity(version, value.activity);
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
async function confirmStopped(run: ActiveRun) {
  if (busy.value || !canManage.value || run.status !== "UNKNOWN") return;
  if (
    !window.confirm(
      `已在设备上核实 ${run.actor_username} 的任务 ${run.task_id} 确实停止？解除后允许再次运行。`,
    )
  )
    return;
  busy.value = true;
  error.value = notice.value = "";
  try {
    await api.request(
      base +
        "/" +
        encodeURIComponent(run.script_id) +
        "/runs/" +
        encodeURIComponent(run.task_id) +
        "/confirm-stopped",
      { method: "POST", body: { v: 1 } },
    );
    notice.value = "已记录停止确认。";
  } catch (e) {
    error.value = message(e);
  } finally {
    await refreshActivity();
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
  if (
    !canRun.value ||
    !activityKnown.value ||
    byScript.value.has(row.id) ||
    busy.value ||
    (retry.value && retry.value.id !== row.id)
  )
    return;
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
    if (e instanceof ApiError && e.status === 409) await refreshActivity();
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
  pollTimer = setInterval(pollActivity, 2000);
  document.addEventListener("visibilitychange", pollActivity);
});
onBeforeUnmount(() => {
  disposed = true;
  clearInterval(pollTimer);
  document.removeEventListener("visibilitychange", pollActivity);
  closeResult();
});
</script>
<template>
  <section class="workbench panel" aria-label="设备操作台">
    <header class="panel-heading">
      <div>
        <h3>设备操作台</h3>
        <p class="field-hint">
          {{
            canRun
              ? "点击已配置的操作，查看执行结果和输出。"
              : "配置这台设备的操作按钮和脚本，供操作员使用。"
          }}
        </p>
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
          v-if="canManage"
          type="button"
          class="button primary small"
          :disabled="busy"
          @click="edit()"
        >
          添加操作
        </button>
      </div>
    </header>
    <p v-if="activityError" class="notice warning" role="status">
      {{ activityError }}
    </p>
    <p v-if="error" role="alert" class="notice danger">{{ error }}</p>
    <p v-if="notice" role="status" class="notice neutral">{{ notice }}</p>
    <p v-if="canRun && retry && !busy" class="notice warning">
      提交结果待确认。可用原请求重试，或在任务中心核对。
      <button type="button" class="text-button" @click="clearAfterReview">
        已核对，结束重试
      </button>
    </p>
    <p v-if="!buttons.length" class="muted">
      {{ canManage ? "这台设备还没有配置操作。" : "当前没有可执行的操作。" }}
    </p>
    <ul v-else class="buttons">
      <li v-for="row in buttons" :key="row.id">
        <button
          v-if="canRun"
          class="button secondary"
          :disabled="
            !activityKnown ||
            byScript.has(row.id) ||
            busy ||
            (!!retry && retry.id !== row.id)
          "
          @click="run(row)"
        >
          {{ retry?.id === row.id ? "重试 · " : "" }}{{ row.name }}
        </button>
        <span v-else>{{ row.name }}</span>
        <button
          v-if="canManage"
          class="text-button"
          :disabled="busy"
          :aria-label="'配置 ' + row.name"
          @click="edit(row)"
        >
          配置
        </button>
        <div
          v-for="active in byScript.get(row.id)"
          :key="active.task_id"
          class="script-activity"
          role="status"
        >
          <strong
            >{{ active.actor_username }} ·
            {{
              active.status === "UNKNOWN"
                ? "结果待核对，已锁定"
                : statusLabels[active.status]
            }}</strong
          >
          <small
            >{{ active.backend === "ssh" ? "SSH" : "Agent" }} · 提交于
            {{ formatTime(active.created_at) }}</small
          >
          <small class="mono">任务 {{ active.task_id }}</small>
          <button
            v-if="canManage && active.status === 'UNKNOWN'"
            type="button"
            class="text-button"
            :disabled="busy"
            @click="confirmStopped(active)"
          >
            已核实停止，解除占用
          </button>
        </div>
      </li>
    </ul>
    <form v-if="canManage && draft" class="editor" @submit.prevent="change()">
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
.script-activity {
  flex-basis: 100%;
  display: grid;
  gap: 3px;
  justify-items: start;
  color: var(--muted);
  overflow-wrap: anywhere;
}
.script-activity strong {
  color: var(--navy);
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
