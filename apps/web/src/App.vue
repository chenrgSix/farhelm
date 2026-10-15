<script setup lang="ts">
import { computed, defineAsyncComponent, onBeforeUnmount, ref } from "vue";
import { api } from "./api/client";
import type {
  AuditEntry,
  Device,
  Task,
  User,
  TerminalSession,
} from "./api/types";
import { canExecute, formatTime, roleLabels, terminalStates } from "./model";
import HealthBadge from "./components/HealthBadge.vue";
import StatusBadge from "./components/StatusBadge.vue";
import ExecForm from "./components/ExecForm.vue";
import TaskDetail from "./components/TaskDetail.vue";
import HealthChecksPanel from "./components/HealthChecksPanel.vue";
import SshConnectionPanel from "./components/SshConnectionPanel.vue";
import SessionDuration from "./components/SessionDuration.vue";
const TerminalPanel = defineAsyncComponent(
  () => import("./components/TerminalPanel.vue"),
);

const user = ref<User | null>(null);
const username = ref("");
const password = ref("");
const loginBusy = ref(false);
const loginError = ref("");
type View = "devices" | "tasks" | "audit" | "terminals";
const view = ref<View>("devices");
const closingSession = ref<string | null>(null);
const terminalSessions = ref<TerminalSession[]>([]);
const terminalTarget = ref<{
  id: string;
  name: string;
  recording?: TerminalSession;
} | null>(null);
const devices = ref<Device[]>([]);
const sshTarget = ref<Device | null>(null);
const healthTarget = ref<Device | null>(null);
const tasks = ref<Task[]>([]);
const audit = ref<AuditEntry[]>([]);
const refreshing = ref(false);
const apiReady = ref(false);
const error = ref("");
const lastUpdated = ref<number | null>(null);
const search = ref("");
const selectedTask = ref<Task | null>(null);
const loadingTask = ref(false);
const execOpen = ref(false);
const execDevice = ref("");
const enrollOpen = ref(false);
const enrollmentName = ref("");
const enrollmentTtl = ref(3600);
const enrollment = ref<{ enrollment_token: string; expires_at: number } | null>(
  null,
);
const enrollmentBusy = ref(false);
const enrollmentError = ref("");
const revokeBusy = ref<string | null>(null);
let sessionGeneration = 0;
let taskGeneration = 0;
let refreshTimer: ReturnType<typeof setInterval> | undefined;
const navigation = [
  { id: "devices", label: "设备总览", icon: "▦" },
  { id: "terminals", label: "终端会话", icon: ">_" },
  { id: "tasks", label: "任务中心", icon: "≡" },
  { id: "audit", label: "操作审计", icon: "◷" },
] as const;
const titles = {
  devices: ["设备总览", "连接状态清晰可见，每一次操作都有记录"],
  tasks: ["任务中心", "从授权到真实结果，追踪每条命令的生命周期"],
  audit: ["操作审计", "平台内操作、授权与输出查看的持久化记录"],
  terminals: ["终端会话", "查看连接记录与会话回放"],
};
const filteredDevices = computed(() =>
  devices.value.filter((d) =>
    `${d.name} ${d.id} ${d.agent_version ?? ""}`
      .toLowerCase()
      .includes(search.value.toLowerCase()),
  ),
);
const filteredTasks = computed(() =>
  tasks.value.filter((t) =>
    `${t.task_id} ${t.device_id} ${t.actor_id} ${t.argv.join(" ")} ${t.status}`
      .toLowerCase()
      .includes(search.value.toLowerCase()),
  ),
);
const filteredAudit = computed(() =>
  audit.value.filter((a) =>
    `${a.action} ${a.actor_id} ${a.device_id} ${a.task_id}`
      .toLowerCase()
      .includes(search.value.toLowerCase()),
  ),
);
const filteredSessions = computed(() =>
  terminalSessions.value.filter((s) =>
    `${deviceName(s.device_id)} ${s.actor_id} ${s.id}`
      .toLowerCase()
      .includes(search.value.toLowerCase()),
  ),
);
const onlineCount = computed(
  () => devices.value.filter((d) => d.control_online && !d.revoked_at).length,
);
const activeCount = computed(
  () => tasks.value.filter((t) => !terminalStates.has(t.status)).length,
);
const unknownCount = computed(
  () => tasks.value.filter((t) => t.status === "UNKNOWN").length,
);
const isExecAllowed = computed(() => canExecute(user.value));

function logout(message = "") {
  sessionGeneration++;
  taskGeneration++;
  api.setToken(null);
  user.value = null;
  password.value = "";
  devices.value = [];
  tasks.value = [];
  audit.value = [];
  selectedTask.value = null;
  terminalTarget.value = null;
  healthTarget.value = null;
  sshTarget.value = null;
  terminalSessions.value = [];
  enrollment.value = null;
  enrollOpen.value = false;
  execOpen.value = false;
  apiReady.value = false;
  error.value = "";
  lastUpdated.value = null;
  loginError.value = message;
  refreshing.value = false;
  loadingTask.value = false;
  search.value = "";
  if (refreshTimer) clearInterval(refreshTimer);
}
api.onUnauthorized = () =>
  logout("登录已失效，请重新登录。若此前命令提交结果不明，请先核对任务中心");
async function login() {
  if (loginBusy.value) return;
  loginBusy.value = true;
  loginError.value = "";
  try {
    if (
      location.protocol !== "https:" &&
      !["localhost", "127.0.0.1", "[::1]"].includes(location.hostname)
    )
      throw new Error("请通过 HTTPS 打开控制台后登录");
    const response = await api.request<{ access_token: string; user: User }>(
      "/login",
      {
        method: "POST",
        body: { username: username.value, password: password.value },
      },
    );
    if (!response.access_token || !response.user?.id)
      throw new Error("登录响应格式错误");
    api.setToken(response.access_token);
    const verified = await api.request<User>("/me");
    if (!["admin", "ops", "business", "auditor"].includes(verified.role))
      throw new Error("账号角色无效");
    user.value = verified;
    sessionGeneration++;
    await refresh();
    if (user.value)
      refreshTimer = setInterval(() => {
        if (!document.hidden && user.value) void refresh();
      }, 10_000);
  } catch (e) {
    logout(e instanceof Error ? e.message : "登录失败");
  } finally {
    password.value = "";
    loginBusy.value = false;
  }
}
async function closeTerminalSession(session: TerminalSession) {
  if (closingSession.value) return;
  closingSession.value = session.id;
  try {
    await api.request(
      `/terminal-sessions/${encodeURIComponent(session.id)}/close`,
      { method: "POST", body: { v: 1 } },
    );
    await refresh();
  } catch (e) {
    error.value = e instanceof Error ? e.message : "关闭会话失败";
  } finally {
    closingSession.value = null;
  }
}
async function refresh() {
  if (!user.value || refreshing.value) return;
  const generation = sessionGeneration;
  refreshing.value = true;
  try {
    const [deviceResponse, taskResponse, auditResponse, terminalResponse] =
      await Promise.all([
        api.request<{ devices: Device[] }>("/devices"),
        api.request<{ tasks: Task[] }>("/tasks"),
        api.request<{ audit: AuditEntry[] }>("/audit"),
        api.request<{ sessions: TerminalSession[] }>("/terminal-sessions"),
      ]);
    if (generation !== sessionGeneration) return;
    if (
      !Array.isArray(deviceResponse.devices) ||
      !Array.isArray(taskResponse.tasks) ||
      !Array.isArray(auditResponse.audit) ||
      !Array.isArray(terminalResponse.sessions)
    )
      throw new Error("API 列表响应格式错误");
    devices.value = deviceResponse.devices;
    tasks.value = taskResponse.tasks;
    audit.value = auditResponse.audit;
    terminalSessions.value = terminalResponse.sessions;
    apiReady.value = true;
    lastUpdated.value = Date.now();
    error.value = "";
    if (selectedTask.value) await selectTask(selectedTask.value.task_id, true);
  } catch (e) {
    if (generation === sessionGeneration) {
      apiReady.value = false;
      error.value = e instanceof Error ? e.message : "刷新失败";
    }
  } finally {
    if (generation === sessionGeneration) refreshing.value = false;
  }
}
async function selectTask(id: string, quiet = false) {
  const generation = ++taskGeneration;
  const session = sessionGeneration;
  if (!quiet) {
    loadingTask.value = true;
    view.value = "tasks";
    search.value = "";
  }
  try {
    const task = await api.request<Task>(`/tasks/${encodeURIComponent(id)}`);
    if (generation === taskGeneration && session === sessionGeneration)
      selectedTask.value = task;
  } catch (e) {
    if (session === sessionGeneration)
      error.value = e instanceof Error ? e.message : "任务读取失败";
  } finally {
    if (generation === taskGeneration) loadingTask.value = false;
  }
}
function openExec(id = "") {
  execDevice.value = id;
  execOpen.value = true;
}
async function onCreated(id: string) {
  await refresh();
  await selectTask(id);
}
function switchView(id: View) {
  view.value = id;
  search.value = "";
}
async function createEnrollment() {
  if (enrollmentBusy.value || enrollment.value || user.value?.role !== "admin")
    return;
  enrollmentBusy.value = true;
  enrollmentError.value = "";
  const generation = sessionGeneration;
  try {
    if (
      !Number.isInteger(enrollmentTtl.value) ||
      enrollmentTtl.value < 60 ||
      enrollmentTtl.value > 86400
    )
      throw new Error("令牌有效期必须是 60–86400 秒");
    const token = await api.request<{
      enrollment_token: string;
      expires_at: number;
    }>("/enrollment-tokens", {
      method: "POST",
      body: {
        v: 1,
        ...(enrollmentName.value.trim()
          ? { name: enrollmentName.value.trim() }
          : {}),
        ttl_seconds: enrollmentTtl.value,
      },
    });
    if (generation === sessionGeneration) {
      enrollment.value = token;
      await refresh();
    }
  } catch (e) {
    if (generation === sessionGeneration)
      enrollmentError.value = e instanceof Error ? e.message : "创建失败";
  } finally {
    enrollmentBusy.value = false;
  }
}
function closeEnrollment() {
  enrollment.value = null;
  enrollmentName.value = "";
  enrollmentError.value = "";
  enrollOpen.value = false;
}
async function revoke(device: Device) {
  if (
    user.value?.role !== "admin" ||
    revokeBusy.value ||
    !window.confirm(
      `撤销设备「${device.name}」的访问权限？旧连接将被关闭，后续认证被拒绝。此操作不会证明正在运行的命令已停止。`,
    )
  )
    return;
  revokeBusy.value = device.id;
  try {
    await api.request(`/devices/${encodeURIComponent(device.id)}/revoke`, {
      method: "POST",
      body: { v: 1 },
    });
    await refresh();
  } catch (e) {
    error.value = e instanceof Error ? e.message : "撤销失败";
  } finally {
    revokeBusy.value = null;
  }
}
function deviceName(id: string) {
  return devices.value.find((d) => d.id === id)?.name ?? id;
}
onBeforeUnmount(() => {
  if (refreshTimer) clearInterval(refreshTimer);
  api.setToken(null);
  api.onUnauthorized = undefined;
});
</script>
<template>
  <div v-if="!user" class="login-shell">
    <section class="login-story">
      <a class="brand" href="/" aria-label="Linux Fleet 首页"
        ><span class="brand-mark">f<span>•</span></span
        ><span>linux fleet<small>设备管理控制台</small></span></a
      >
      <div class="story-main">
        <div class="eyebrow">CONNECTED. CONTROLLED. ACCOUNTABLE.</div>
        <h1>设备在远方<br />掌控在此刻<span>。</span></h1>
        <p>
          主动连接，授权执行，结果留痕。<br />为每一台 Linux
          设备建立清晰的操作记录。
        </p>
        <div class="connection-art" aria-hidden="true">
          <span class="art-node">01</span><span class="art-line"></span
          ><span class="art-core">F</span><span class="art-line"></span
          ><span class="art-node">02</span>
        </div>
      </div>
      <div class="story-foot">
        <span class="dot"></span>P0 / P1 · 最小纵向链路
      </div>
    </section>
    <main class="login-main">
      <div class="login-card">
        <div class="eyebrow">FLEET CONSOLE</div>
        <h2>登录控制台</h2>
        <p class="muted">使用管理员配置的平台账号继续</p>
        <form @submit.prevent="login">
          <label
            >账号<input
              v-model="username"
              name="username"
              autocomplete="username"
              required
              maxlength="128"
              autofocus
              placeholder="输入平台账号" /></label
          ><label
            >密码<input
              v-model="password"
              name="password"
              type="password"
              autocomplete="current-password"
              required
              maxlength="1024"
              placeholder="输入密码"
          /></label>
          <div v-if="loginError" class="notice danger" role="alert">
            {{ loginError }}
          </div>
          <button class="button primary login-button" :disabled="loginBusy">
            {{ loginBusy ? "正在验证…" : "登录 →" }}
          </button>
        </form>
        <p class="login-note">
          会话仅保留在当前页面内存中，刷新页面需重新登录。没有默认账号或公共密码
        </p>
        <div class="login-footer">
          <span>HTTPS / WSS</span><span>身份与设备范围校验</span>
        </div>
      </div>
    </main>
  </div>
  <div v-else class="app-shell">
    <aside class="sidebar">
      <div class="brand">
        <span class="brand-mark">f<span>•</span></span
        ><span>linux fleet<small>设备管理控制台</small></span>
      </div>
      <div class="nav-label">工作空间</div>
      <nav aria-label="主导航">
        <button
          v-for="item in navigation"
          :key="item.id"
          :class="{ active: view === item.id }"
          :aria-current="view === item.id ? 'page' : undefined"
          @click="switchView(item.id)"
        >
          <span class="nav-icon" aria-hidden="true">{{ item.icon }}</span
          >{{ item.label
          }}<span v-if="item.id === 'tasks' && activeCount" class="nav-count">{{
            activeCount
          }}</span>
        </button>
      </nav>
      <div class="sidebar-note">
        <div class="eyebrow">REMOTE TERMINAL</div>
        <strong>连接设备，直接操作</strong>
        <p>终端会话与命令任务均保留操作记录</p>
      </div>
      <div class="account">
        <span class="avatar">{{
          user.username.slice(0, 1).toUpperCase()
        }}</span>
        <div>
          <strong>{{ user.username }}</strong
          ><small>{{ roleLabels[user.role] }}</small>
        </div>
        <button
          class="icon-button"
          aria-label="退出登录"
          title="退出登录"
          @click="logout()"
        >
          ↪
        </button>
      </div>
    </aside>
    <div class="workspace">
      <header class="topbar">
        <div class="breadcrumb">
          工作空间 <span>/</span> {{ titles[view][0] }}
        </div>
        <div class="topbar-right">
          <HealthBadge :value="apiReady ? true : null" good="API 可用" /><span
            class="muted small"
            >{{
              lastUpdated ? `更新于 ${formatTime(lastUpdated)}` : "尚未获取数据"
            }}</span
          ><button
            class="button secondary small"
            :disabled="refreshing"
            @click="refresh"
          >
            {{ refreshing ? "刷新中…" : "↻ 刷新" }}
          </button>
        </div>
      </header>
      <main class="main-content">
        <div class="page-heading">
          <div>
            <div class="eyebrow">LINUX FLEET / {{ view.toUpperCase() }}</div>
            <h1>{{ titles[view][0] }}</h1>
            <p>{{ titles[view][1] }}</p>
          </div>
          <div class="heading-actions">
            <button
              v-if="user.role === 'admin' && view === 'devices'"
              class="button secondary"
              :disabled="enrollmentBusy"
              @click="enrollOpen ? closeEnrollment() : (enrollOpen = true)"
            >
              ＋ 注册设备</button
            ><button
              v-if="isExecAllowed && view === 'tasks'"
              class="button primary"
              :disabled="execOpen"
              @click="openExec()"
            >
              新建命令任务 <span aria-hidden="true">↗</span>
            </button>
          </div>
        </div>
        <div v-if="error" class="notice danger" role="alert">
          {{ error
          }}<span v-if="lastUpdated"
            >。下方为上次成功读取的数据；当前连接状态未知</span
          >
        </div>
        <section
          v-if="view === 'devices'"
          class="metric-grid"
          aria-label="设备概况"
        >
          <div class="metric">
            <span>授权范围内设备</span
            ><strong
              >{{ lastUpdated ? devices.length : "—" }}<small>台</small></strong
            >
            <p>来自已认证的设备清单</p>
          </div>
          <div class="metric">
            <span><span class="dot green"></span>控制连接在线</span
            ><strong
              >{{ apiReady ? onlineCount : "—" }}<small>台</small></strong
            >
            <p>公网 WSS 心跳状态</p>
          </div>
          <div class="metric">
            <span>当前列表进行中</span
            ><strong
              >{{ lastUpdated ? activeCount : "—" }}<small>条</small></strong
            >
            <p>排队、下发、接收或运行中</p>
          </div>
          <div class="metric">
            <span>当前列表待核对</span
            ><strong :class="unknownCount ? 'text-warning' : ''"
              >{{ lastUpdated ? unknownCount : "—" }}<small>条</small></strong
            >
            <p>UNKNOWN 不会自动重跑</p>
          </div>
        </section>
        <section
          v-if="enrollOpen && user.role === 'admin'"
          class="panel enrollment"
        >
          <div class="panel-heading">
            <div>
              <div class="eyebrow">DEVICE ENROLLMENT</div>
              <h2>创建一次性注册令牌</h2>
            </div>
            <button
              class="icon-button"
              aria-label="关闭注册令牌"
              :disabled="enrollmentBusy"
              @click="closeEnrollment"
            >
              ×
            </button>
          </div>
          <div v-if="!enrollment">
            <p class="muted">
              令牌绑定一次设备注册授权。请通过安全渠道交给设备管理员，勿粘贴到日志或代码仓库
            </p>
            <form class="enroll-form" @submit.prevent="createEnrollment">
              <label
                >备注名称<input
                  v-model="enrollmentName"
                  maxlength="128"
                  placeholder="例如：测试设备 / 华东" /></label
              ><label
                >有效期（秒）<input
                  v-model.number="enrollmentTtl"
                  type="number"
                  min="60"
                  max="86400"
                  required /></label
              ><button class="button primary" :disabled="enrollmentBusy">
                {{ enrollmentBusy ? "创建中…" : "生成令牌" }}
              </button>
            </form>
          </div>
          <div v-else class="notice warning">
            <strong>请现在保存令牌；关闭此面板后不再展示</strong
            ><label
              >一次性注册令牌<textarea
                class="mono token-value"
                :value="enrollment.enrollment_token"
                readonly
                spellcheck="false"
                rows="2"
              ></textarea>
            </label>
            <p>
              有效至
              {{
                formatTime(enrollment.expires_at)
              }}。令牌泄漏可能导致未授权设备注册
            </p>
          </div>
          <div v-if="enrollmentError" class="notice danger" role="alert">
            {{ enrollmentError }}
          </div>
        </section>
        <div class="content-grid" :class="{ 'with-exec': execOpen }">
          <div class="content-primary">
            <section class="panel list-panel">
              <div class="list-toolbar">
                <div>
                  <h2>
                    {{
                      view === "devices"
                        ? "设备清单"
                        : view === "tasks"
                          ? "执行历史"
                          : view === "terminals"
                            ? "终端会话"
                            : "审计记录"
                    }}<span class="count">{{
                      view === "devices"
                        ? devices.length
                        : view === "tasks"
                          ? tasks.length
                          : view === "terminals"
                            ? terminalSessions.length
                            : audit.length
                    }}</span>
                  </h2>
                  <p v-if="view === 'devices'" class="field-hint">
                    控制、私网与业务状态独立判断；未采集的状态为未知
                  </p>
                  <p v-else-if="view === 'audit'" class="field-hint">
                    仅展示当前角色与设备范围允许访问的服务端记录
                  </p>
                </div>
                <label class="search-label"
                  ><span class="sr-only">筛选当前列表</span
                  ><input
                    v-model="search"
                    type="search"
                    :placeholder="
                      view === 'devices'
                        ? '搜索设备名称或 ID'
                        : '搜索 ID、操作人或内容'
                    "
                    aria-label="筛选当前列表"
                /></label>
              </div>
              <div v-if="!lastUpdated" class="empty-state">
                <span class="empty-icon">◌</span>
                <h3>{{ refreshing ? "正在连接服务端" : "尚未读取到数据" }}</h3>
                <p>
                  {{
                    refreshing
                      ? "获取授权范围内的真实设备与任务"
                      : "请检查 API 服务与同源代理配置后刷新"
                  }}
                </p>
              </div>
              <template v-else-if="view === 'devices'"
                ><div v-if="!filteredDevices.length" class="empty-state">
                  <span class="empty-icon">▦</span>
                  <h3>{{ search ? "没有匹配的设备" : "还没有已授权设备" }}</h3>
                  <p>
                    {{
                      search
                        ? "尝试其他名称或设备 ID"
                        : user.role === "admin"
                          ? "创建注册令牌，在授权设备上启动 Agent 后将在这里出现"
                          : "请联系管理员完成设备注册与范围授权"
                    }}
                  </p>
                </div>
                <div v-else class="table-scroll">
                  <table>
                    <thead>
                      <tr>
                        <th>设备</th>
                        <th>控制连接</th>
                        <th>私网数据</th>
                        <th>业务健康</th>
                        <th>最近心跳</th>
                        <th>操作</th>
                      </tr>
                    </thead>
                    <tbody>
                      <tr v-for="device in filteredDevices" :key="device.id">
                        <td>
                          <div class="device-name">
                            <span class="device-icon" aria-hidden="true"
                              >▤</span
                            >
                            <div>
                              <strong>{{ device.name }}</strong
                              ><small class="mono" :title="device.id"
                                >{{ device.id.slice(0, 12) }}… ·
                                {{ device.agent_version ?? "版本未知" }}</small
                              >
                            </div>
                          </div>
                          <span v-if="device.revoked_at" class="revoked"
                            >访问已撤销</span
                          >
                        </td>
                        <td>
                          <HealthBadge
                            :value="
                              apiReady
                                ? device.control_online && !device.revoked_at
                                : null
                            "
                            good="在线"
                            bad="离线"
                          />
                        </td>
                        <td>
                          <HealthBadge
                            :value="
                              apiReady ? device.private_data_reachable : null
                            "
                            good="可达"
                          />
                        </td>
                        <td>
                          <HealthBadge
                            :value="apiReady ? device.business_healthy : null"
                            good="健康"
                            bad="异常"
                          />
                        </td>
                        <td class="small muted">
                          {{ formatTime(device.last_seen) }}
                        </td>
                        <td>
                          <div class="row-actions">
                            <button
                              class="text-button"
                              :disabled="!apiReady || !!healthTarget"
                              @click="healthTarget = device"
                            >
                              健康检查
                            </button>
                            <button
                              v-if="
                                canExecute(user, device.id) &&
                                !device.revoked_at
                              "
                              class="button primary small"
                              :disabled="
                                !apiReady ||
                                !device.control_online ||
                                !!terminalTarget
                              "
                              @click="
                                terminalTarget = {
                                  id: device.id,
                                  name: device.name,
                                }
                              "
                            >
                              连接终端
                            </button>
                            <button
                              v-if="
                                canExecute(user, device.id) &&
                                !device.revoked_at
                              "
                              class="text-button"
                              :disabled="!apiReady || !!sshTarget"
                              @click="sshTarget = device"
                            >
                              SSH 连接
                            </button>
                            <button
                              v-if="
                                canExecute(user, device.id) &&
                                !device.revoked_at
                              "
                              class="text-button"
                              :disabled="execOpen"
                              @click="openExec(device.id)"
                            >
                              命令任务</button
                            ><button
                              v-if="user.role === 'admin' && !device.revoked_at"
                              class="text-button muted"
                              :disabled="!!revokeBusy"
                              @click="revoke(device)"
                            >
                              {{
                                revokeBusy === device.id ? "撤销中" : "撤销"
                              }}</button
                            ><span
                              v-if="!canExecute(user) || device.revoked_at"
                              class="muted small"
                              >只读</span
                            >
                          </div>
                        </td>
                      </tr>
                    </tbody>
                  </table>
                </div></template
              >
              <template v-else-if="view === 'tasks'"
                ><div v-if="!filteredTasks.length" class="empty-state">
                  <span class="empty-icon">≡</span>
                  <h3>{{ search ? "没有匹配的任务" : "暂无执行记录" }}</h3>
                  <p>授权执行后，真实任务与持久化结果将在这里显示</p>
                </div>
                <div v-else class="table-scroll">
                  <table>
                    <thead>
                      <tr>
                        <th>任务 / 命令</th>
                        <th>设备 / 操作人</th>
                        <th>状态</th>
                        <th>审计</th>
                        <th>创建时间</th>
                      </tr>
                    </thead>
                    <tbody>
                      <tr
                        v-for="task in filteredTasks"
                        :key="task.task_id"
                        :class="{
                          selected: selectedTask?.task_id === task.task_id,
                        }"
                      >
                        <td>
                          <button
                            class="task-link"
                            @click="selectTask(task.task_id)"
                          >
                            <strong class="mono">{{
                              task.argv.join(" ")
                            }}</strong
                            ><small class="mono">{{ task.task_id }}</small>
                          </button>
                        </td>
                        <td>
                          <strong class="small">{{
                            deviceName(task.device_id)
                          }}</strong
                          ><small class="mono muted block">{{
                            task.actor_id
                          }}</small>
                        </td>
                        <td>
                          <StatusBadge :status="task.status" /><small
                            v-if="
                              task.cancel_requested &&
                              !terminalStates.has(task.status)
                            "
                            class="block muted"
                            >已请求取消</small
                          >
                        </td>
                        <td>
                          <span
                            class="small"
                            :class="
                              task.result?.audit_complete === false
                                ? 'text-danger'
                                : 'muted'
                            "
                            >{{
                              !task.result
                                ? "待完成"
                                : task.result.audit_complete
                                  ? "完整"
                                  : "不完整"
                            }}</span
                          >
                        </td>
                        <td class="small muted">
                          {{ formatTime(task.created_at) }}
                        </td>
                      </tr>
                    </tbody>
                  </table>
                </div></template
              >
              <template v-else-if="view === 'terminals'">
                <div v-if="!filteredSessions.length" class="empty-state">
                  <span class="empty-icon">&gt;_</span>
                  <h3>暂无终端会话</h3>
                  <p>在设备页点击“连接终端”即可开始操作</p>
                </div>
                <div v-else class="table-scroll">
                  <table>
                    <thead>
                      <tr>
                        <th>设备 / 会话</th>
                        <th>操作人</th>
                        <th>连接时间</th>
                        <th>录制时长</th>
                        <th>连接方式</th>
                        <th>状态</th>
                        <th>操作</th>
                      </tr>
                    </thead>
                    <tbody>
                      <tr v-for="session in filteredSessions" :key="session.id">
                        <td>
                          <strong>{{ deviceName(session.device_id) }}</strong
                          ><small class="mono muted block"
                            >{{ session.id.slice(0, 12) }}…</small
                          >
                        </td>
                        <td class="mono small">{{ session.actor_id }}</td>
                        <td class="small muted">
                          {{ formatTime(session.created_at) }}
                        </td>
                        <td class="small">
                          <SessionDuration :session="session" />
                        </td>
                        <td>
                          {{ session.transport === "ssh" ? "SSH" : "网页" }}
                        </td>
                        <td>
                          <span
                            :class="
                              session.status === 'INTERRUPTED'
                                ? 'text-warning'
                                : 'muted'
                            "
                            >{{
                              session.status === "OPEN"
                                ? "已连接"
                                : session.status === "OPENING"
                                  ? "连接中"
                                  : session.status === "CLOSED"
                                    ? "已结束"
                                    : "已中断"
                            }}</span
                          >
                        </td>
                        <td>
                          <button
                            class="text-button"
                            :disabled="!session.ended_at || !!terminalTarget"
                            @click="
                              terminalTarget = {
                                id: session.device_id,
                                name: deviceName(session.device_id),
                                recording: session,
                              }
                            "
                          >
                            查看回放
                          </button>
                          <button
                            v-if="
                              !session.ended_at &&
                              (user.role === 'admin' ||
                                user.id === session.actor_id)
                            "
                            class="text-button"
                            :disabled="!!closingSession"
                            @click="closeTerminalSession(session)"
                          >
                            {{
                              closingSession === session.id
                                ? "正在结束…"
                                : "结束会话"
                            }}
                          </button>
                        </td>
                      </tr>
                    </tbody>
                  </table>
                </div>
              </template>
              <template v-else
                ><div v-if="!filteredAudit.length" class="empty-state">
                  <span class="empty-icon">◷</span>
                  <h3>{{ search ? "没有匹配的记录" : "暂无可见审计记录" }}</h3>
                  <p>平台操作、授权决定和输出查看会在此留痕</p>
                </div>
                <div v-else class="table-scroll">
                  <table>
                    <thead>
                      <tr>
                        <th>时间 / 事件</th>
                        <th>操作人</th>
                        <th>设备 / 任务</th>
                        <th>详细记录</th>
                      </tr>
                    </thead>
                    <tbody>
                      <tr v-for="entry in filteredAudit" :key="entry.id">
                        <td>
                          <strong class="small">{{ entry.action }}</strong
                          ><small class="muted block">{{
                            formatTime(entry.at)
                          }}</small>
                        </td>
                        <td class="mono small">
                          {{ entry.actor_id ?? "系统 / 设备" }}
                        </td>
                        <td class="small">
                          <span>{{
                            entry.device_id ? deviceName(entry.device_id) : "—"
                          }}</span
                          ><button
                            v-if="entry.task_id"
                            class="text-button mono block"
                            @click="selectTask(entry.task_id)"
                          >
                            {{ entry.task_id.slice(0, 12) }}…
                          </button>
                        </td>
                        <td>
                          <details>
                            <summary class="text-button">
                              查看记录 #{{ entry.id }}
                            </summary>
                            <pre class="audit-json">{{
                              JSON.stringify(entry.detail ?? {}, null, 2)
                            }}</pre>
                          </details>
                        </td>
                      </tr>
                    </tbody>
                  </table>
                </div></template
              >
              <div class="table-footer">
                <span>{{
                  view === "tasks"
                    ? "最近最多 500 条可见任务"
                    : view === "terminals"
                      ? "最近最多 500 条可见会话"
                      : view === "audit"
                        ? "最近最多 1000 条可见审计记录"
                        : "仅显示当前账号可见设备"
                }}</span
                ><span
                  >10 秒自动刷新 ·
                  {{ Intl.DateTimeFormat().resolvedOptions().timeZone }}</span
                >
              </div>
            </section>
            <p v-if="loadingTask" class="muted">正在读取任务详情…</p>
            <TaskDetail
              v-if="view === 'tasks' && selectedTask"
              :key="selectedTask.task_id"
              :task="selectedTask"
              :user="user"
              @refresh="refresh"
              @close="
                selectedTask = null;
                taskGeneration++;
              "
            />
          </div>
          <ExecForm
            v-if="execOpen"
            :key="execDevice"
            :devices="devices"
            :user="user"
            :initial-device="execDevice"
            @close="execOpen = false"
            @created="onCreated"
          />
        </div>
        <footer class="page-footer">
          <span>LINUX FLEET <span class="footer-dot">·</span> 开发版本</span
          ><span>只审计经过平台的操作</span>
        </footer>
      </main>
      <TerminalPanel
        v-if="terminalTarget"
        :key="terminalTarget.recording?.id ?? terminalTarget.id"
        :device-id="terminalTarget.id"
        :device-name="terminalTarget.name"
        :recording="terminalTarget.recording"
        @close="
          terminalTarget = null;
          refresh();
        "
        @changed="refresh"
      />
      <SshConnectionPanel
        v-if="sshTarget && user"
        :key="sshTarget.id"
        :device="sshTarget"
        :user="user"
        @close="sshTarget = null"
      />
      <HealthChecksPanel
        v-if="healthTarget && user"
        :key="healthTarget.id"
        :device="healthTarget"
        :user="user"
        @close="
          healthTarget = null;
          refresh();
        "
        @changed="refresh"
      />
    </div>
  </div>
</template>
