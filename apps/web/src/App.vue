<script setup lang="ts">
import { computed, defineAsyncComponent, onBeforeUnmount, ref } from "vue";
import { api } from "./api/client";
import { useListResource } from "./composables/useListResource";
import type {
  AuditEntry,
  Device,
  Task,
  User,
  TerminalSession,
} from "./api/types";
import {
  canExecute,
  hasPermission,
  formatTime,
  roleLabels,
  terminalStates,
} from "./model";
import HealthBadge from "./components/HealthBadge.vue";
import StatusBadge from "./components/StatusBadge.vue";
import ExecForm from "./components/ExecForm.vue";
import TaskDetail from "./components/TaskDetail.vue";
import DeviceNetworkPanel from "./components/DeviceNetworkPanel.vue";
import HealthChecksPanel from "./components/HealthChecksPanel.vue";
import SshConnectionPanel from "./components/SshConnectionPanel.vue";
import SessionDuration from "./components/SessionDuration.vue";
import DeviceConnectionPanel from "./components/DeviceConnectionPanel.vue";
import AddDevicePanel from "./components/AddDevicePanel.vue";
import AgentInstallPanel from "./components/AgentInstallPanel.vue";
import SystemSettingsPanel from "./components/SystemSettingsPanel.vue";
import CertificateSettingsPanel from "./components/CertificateSettingsPanel.vue";
import AgentUpgradePanel from "./components/AgentUpgradePanel.vue";
import DeviceGroupTools from "./components/DeviceGroupTools.vue";
import DeviceActions from "./components/DeviceActions.vue";
import AccessManagementPanel from "./components/AccessManagementPanel.vue";
const TerminalPanel = defineAsyncComponent(
  () => import("./components/TerminalPanel.vue"),
);

const user = ref<User | null>(null);
const username = ref("");
const password = ref("");
const loginBusy = ref(false);
const loginError = ref("");
type View =
  | "devices"
  | "tasks"
  | "audit"
  | "terminals"
  | "settings"
  | "upgrades"
  | "access";
const view = ref<View>("devices");
const closingSession = ref<string | null>(null);
const deviceList = useListResource<Device>("/devices", "devices");
const taskList = useListResource<Task>("/tasks", "tasks");
const auditList = useListResource<AuditEntry>("/audit", "audit");
const sessionList = useListResource<TerminalSession>(
  "/terminal-sessions",
  "sessions",
);
const devices = deviceList.items;
const tasks = taskList.items;
const audit = auditList.items;
const terminalSessions = sessionList.items;
const lists = {
  devices: deviceList,
  tasks: taskList,
  audit: auditList,
  terminals: sessionList,
};
const currentList = computed(() =>
  view.value in lists ? lists[view.value as keyof typeof lists] : null,
);
const sessionLoading = ref(false);
const sessionError = ref("");
const sessionUpdatedAt = ref<number | null>(null);
const refreshing = computed(
  () =>
    sessionLoading.value || refreshTargets().some((list) => list.loading.value),
);
const apiReady = computed(
  () =>
    !sessionError.value &&
    !!deviceList.updatedAt.value &&
    !deviceList.error.value,
);
const currentReady = computed(
  () =>
    !sessionError.value &&
    (currentList.value
      ? !!currentList.value.updatedAt.value && !currentList.value.error.value
      : !!sessionUpdatedAt.value),
);
const lastUpdated = computed(
  () =>
    currentList.value?.updatedAt.value ??
    (currentList.value ? null : sessionUpdatedAt.value),
);
const listError = computed(() => currentList.value?.error.value ?? "");
const taskError = taskList.error;
const tasksReady = computed(
  () => !sessionError.value && !!taskList.updatedAt.value && !taskError.value,
);
const terminalTarget = ref<{
  id: string;
  name: string;
  recording?: TerminalSession;
} | null>(null);
const deviceGroupFilter = ref("");
const selectedDeviceIds = ref<string[]>([]);
const sshTarget = ref<Device | null>(null);
const networkTarget = ref<Device | null>(null);
const healthTarget = ref<Device | null>(null);
const connectionTarget = ref<Device | undefined>();
const connectionOpen = ref(false);
const addDeviceOpen = ref(false);
const error = ref("");
const search = ref("");
const selectedTask = ref<Task | null>(null);
const loadingTask = ref(false);
const execOpen = ref(false);
const execDevice = ref("");
const enrollOpen = ref(false);
const installTarget = ref<Device>();
const revokeBusy = ref<string | null>(null);
let sessionGeneration = 0;
let taskGeneration = 0;
let refreshTimer: ReturnType<typeof setInterval> | undefined;
const navigation = computed(
  () =>
    [
      ...(hasPermission(user.value, "devices.read")
        ? [{ id: "devices", label: "设备总览", icon: "▦" } as const]
        : []),
      ...(hasPermission(user.value, "recordings.read")
        ? [{ id: "terminals", label: "终端会话", icon: ">_" } as const]
        : []),
      ...(hasPermission(user.value, "tasks.read")
        ? [{ id: "tasks", label: "任务中心", icon: "≡" } as const]
        : []),
      ...(hasPermission(user.value, "audit.read")
        ? [{ id: "audit", label: "操作审计", icon: "◷" } as const]
        : []),
      ...(user.value?.role === "admin"
        ? [
            { id: "upgrades", label: "Agent 升级", icon: "↑" } as const,
            { id: "settings", label: "系统设置", icon: "⚙" } as const,
            { id: "access", label: "用户与权限", icon: "♙" } as const,
          ]
        : []),
    ] as const,
);
const titles = {
  access: ["用户与权限", "管理账号、角色与用户组授权"],
  devices: ["设备总览", "连接状态清晰可见，每一次操作都有记录"],
  tasks: ["任务中心", "从授权到真实结果，追踪每条命令的生命周期"],
  audit: ["操作审计", "平台内操作、授权与输出查看的持久化记录"],
  terminals: ["终端会话", "查看连接记录与会话回放"],
  settings: ["系统设置", "管理平台配置，保存后立即生效"],
  upgrades: ["Agent 升级", "批量更新，跟踪每台设备的真实升级结果"],
};
const filteredDevices = computed(() =>
  devices.value.filter((d) => {
    const groupMatches =
      !deviceGroupFilter.value ||
      (deviceGroupFilter.value === "__ungrouped__"
        ? !d.device_groups?.length
        : d.device_groups?.some((g) => g.id === deviceGroupFilter.value));
    return (
      groupMatches &&
      `${d.name} ${d.id} ${d.device_groups?.map((g) => g.name).join(" ") ?? ""} ${d.agent_version ?? ""} ${(d.ip_addresses ?? []).join(" ")}`
        .toLowerCase()
        .includes(search.value.toLowerCase())
    );
  }),
);
const visibleDeviceIds = computed(() => filteredDevices.value.map((d) => d.id));
const allVisibleSelected = computed(
  () =>
    visibleDeviceIds.value.length > 0 &&
    visibleDeviceIds.value.every((id) => selectedDeviceIds.value.includes(id)),
);
const someVisibleSelected = computed(() =>
  visibleDeviceIds.value.some((id) => selectedDeviceIds.value.includes(id)),
);
function toggleVisibleDevices(selected: boolean) {
  selectedDeviceIds.value = selected
    ? [...new Set([...selectedDeviceIds.value, ...visibleDeviceIds.value])]
    : selectedDeviceIds.value.filter(
        (id) => !visibleDeviceIds.value.includes(id),
      );
}
function refreshDeviceTags() {
  void deviceList.load();
}
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
  view.value = "devices";
  password.value = "";
  for (const list of Object.values(lists)) list.reset();
  selectedDeviceIds.value = [];
  deviceGroupFilter.value = "";
  selectedTask.value = null;
  terminalTarget.value = null;
  healthTarget.value = null;
  networkTarget.value = null;
  connectionTarget.value = undefined;
  connectionOpen.value = false;
  addDeviceOpen.value = false;
  sshTarget.value = null;
  enrollOpen.value = false;
  installTarget.value = undefined;
  execOpen.value = false;
  sessionError.value = "";
  sessionUpdatedAt.value = null;
  sessionLoading.value = false;
  userRefresh = undefined;
  error.value = "";
  loginError.value = message;
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
    view.value = navigation.value[0]?.id ?? "devices";
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
let userRefresh: Promise<void> | undefined;
function refreshTargets() {
  const targets = [];
  if (hasPermission(user.value, "devices.read")) targets.push(deviceList);
  if (
    (view.value === "devices" || view.value === "tasks") &&
    hasPermission(user.value, "tasks.read")
  )
    targets.push(taskList);
  if (view.value === "audit" && hasPermission(user.value, "audit.read"))
    targets.push(auditList);
  if (
    view.value === "terminals" &&
    hasPermission(user.value, "recordings.read")
  )
    targets.push(sessionList);
  return targets;
}
function refreshUser() {
  if (userRefresh) return userRefresh;
  const generation = sessionGeneration;
  sessionLoading.value = true;
  userRefresh = (async () => {
    try {
      const freshUser = await api.request<User>("/me");
      if (generation !== sessionGeneration) return;
      user.value = freshUser;
      sessionError.value = "";
      sessionUpdatedAt.value = Date.now();
      const permissions = {
        devices: "devices.read",
        tasks: "tasks.read",
        audit: "audit.read",
        terminals: "recordings.read",
      } as const;
      for (const key of Object.keys(lists) as (keyof typeof lists)[])
        if (!hasPermission(freshUser, permissions[key])) lists[key].reset();
      if (!navigation.value.some((item) => item.id === view.value))
        view.value = navigation.value[0]?.id ?? "devices";
    } catch (e) {
      if (generation === sessionGeneration)
        sessionError.value = e instanceof Error ? e.message : "身份校验失败";
    } finally {
      if (generation === sessionGeneration) {
        sessionLoading.value = false;
        userRefresh = undefined;
      }
    }
  })();
  return userRefresh;
}
async function refresh() {
  if (!user.value) return;
  const generation = sessionGeneration;
  await refreshUser();
  if (generation !== sessionGeneration || !user.value || sessionError.value)
    return;
  await Promise.all(refreshTargets().map((list) => list.load()));
  if (generation === sessionGeneration) {
    selectedDeviceIds.value = selectedDeviceIds.value.filter((id) =>
      devices.value.some((d) => d.id === id),
    );
    if (view.value === "tasks" && selectedTask.value)
      await selectTask(selectedTask.value.task_id, true);
  }
}
async function selectTask(id: string, quiet = false) {
  const generation = ++taskGeneration;
  const session = sessionGeneration;
  if (!quiet) {
    loadingTask.value = true;
    switchView("tasks");
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
  view.value = "tasks";
  await refresh();
  await selectTask(id);
}
function switchView(id: View) {
  if (!navigation.value.some((item) => item.id === id)) return;
  view.value = id;
  search.value = "";
  error.value = "";
  void refresh();
}
function selectDeviceAccess(kind: "ssh" | "agent") {
  addDeviceOpen.value = false;
  if (kind === "ssh") {
    connectionTarget.value = undefined;
    connectionOpen.value = true;
  } else {
    installTarget.value = undefined;
    enrollOpen.value = true;
  }
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
function handleDeviceAction(kind: string, device: Device) {
  switch (kind) {
    case "terminal":
      terminalTarget.value = { id: device.id, name: device.name };
      break;
    case "connection":
      connectionTarget.value = device;
      connectionOpen.value = true;
      break;
    case "install":
      installTarget.value = device;
      enrollOpen.value = true;
      break;
    case "network":
      networkTarget.value = device;
      break;
    case "health":
      healthTarget.value = device;
      break;
    case "ssh":
      sshTarget.value = device;
      break;
    case "exec":
      openExec(device.id);
      break;
    case "revoke":
      void revoke(device);
      break;
  }
}
function deviceName(id: string) {
  return devices.value.find((d) => d.id === id)?.name ?? id;
}
onBeforeUnmount(() => {
  logout();
  api.onUnauthorized = undefined;
});
</script>
<template>
  <div v-if="!user" class="login-shell">
    <section class="login-story">
      <a class="brand" href="/" aria-label="Farhelm 遥舵首页"
        ><span class="brand-mark">f<span>•</span></span
        ><span>Farhelm<small>遥舵 · 设备管理控制台</small></span></a
      >
      <div class="story-main">
        <div class="eyebrow">CONNECTED. CONTROLLED. ACCOUNTABLE.</div>
        <h1>分散设备<br />一处掌控<span>。</span></h1>
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
        <div class="eyebrow">FARHELM CONSOLE</div>
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
        ><span>Farhelm<small>遥舵 · 设备管理控制台</small></span>
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
          }}<span
            v-if="item.id === 'tasks' && tasksReady && activeCount"
            class="nav-count"
            >{{ activeCount }}</span
          >
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
          ><small>{{
            user.role_names?.join(" / ") || roleLabels[user.role]
          }}</small>
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
          <HealthBadge
            :value="currentReady ? true : null"
            good="列表已更新"
          /><span class="muted small">{{
            lastUpdated ? `更新于 ${formatTime(lastUpdated)}` : "尚未获取数据"
          }}</span
          ><button
            v-if="
              view !== 'settings' && view !== 'upgrades' && view !== 'access'
            "
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
            <div class="eyebrow">FARHELM / {{ view.toUpperCase() }}</div>
            <h1>{{ titles[view][0] }}</h1>
            <p>{{ titles[view][1] }}</p>
          </div>
          <div class="heading-actions">
            <button
              v-if="user.role === 'admin' && view === 'devices'"
              class="button primary"
              :disabled="connectionOpen || addDeviceOpen || enrollOpen"
              @click="addDeviceOpen = true"
            >
              ＋ 添加设备
            </button>
            <button
              v-if="isExecAllowed && view === 'tasks'"
              class="button primary"
              :disabled="execOpen"
              @click="openExec()"
            >
              新建命令任务 <span aria-hidden="true">↗</span>
            </button>
          </div>
        </div>
        <div v-if="sessionError" class="notice danger" role="alert">
          身份校验刷新失败：{{ sessionError }}。当前数据可能已过期，请重试刷新。
        </div>
        <div v-if="listError" class="notice danger" role="alert">
          当前列表刷新失败：{{ listError
          }}<span v-if="lastUpdated">。保留上次成功读取的数据</span>。
          <span v-if="view === 'devices'">当前设备状态未知。</span>
        </div>
        <div
          v-if="view === 'devices' && taskError"
          class="notice danger"
          role="alert"
        >
          任务概况刷新失败：{{ taskError }}。设备连接状态与操作不受此错误影响。
        </div>
        <div v-if="error" class="notice danger" role="alert">
          {{ error }}
          <button class="text-button" @click="error = ''">关闭提示</button>
        </div>
        <section
          v-if="view === 'devices' && navigation.length"
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
            <span><span class="dot green"></span>Agent 在线</span
            ><strong
              >{{ apiReady ? onlineCount : "—" }}<small>台</small></strong
            >
            <p>Agent WSS 心跳状态，SSH 按需连接</p>
          </div>
          <div class="metric">
            <span>当前列表进行中</span
            ><strong
              >{{ tasksReady ? activeCount : "—" }}<small>条</small></strong
            >
            <p>排队、下发、接收或运行中</p>
          </div>
          <div class="metric">
            <span>当前列表待核对</span
            ><strong :class="unknownCount ? 'text-warning' : ''"
              >{{ tasksReady ? unknownCount : "—" }}<small>条</small></strong
            >
            <p>UNKNOWN 不会自动重跑</p>
          </div>
        </section>
        <p v-if="!navigation.length" class="notice">
          当前账号尚未分配操作权限，请联系管理员配置角色和设备范围。
        </p>
        <AccessManagementPanel
          v-if="view === 'access' && user.role === 'admin'"
          :current-user-id="user.id"
          :devices="devices"
        />
        <SystemSettingsPanel
          v-if="view === 'settings' && user.role === 'admin'"
          @saved="refresh"
        />
        <CertificateSettingsPanel
          v-if="view === 'settings' && user.role === 'admin'"
        />
        <AgentUpgradePanel
          v-if="view === 'upgrades' && user.role === 'admin'"
        />
        <div
          v-if="
            navigation.length &&
            view !== 'settings' &&
            view !== 'upgrades' &&
            view !== 'access'
          "
          class="content-grid"
          :class="{ 'with-exec': execOpen }"
        >
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
              <DeviceGroupTools
                v-if="view === 'devices'"
                :devices="devices"
                :admin="user.role === 'admin'"
                v-model:filter="deviceGroupFilter"
                v-model:selected-ids="selectedDeviceIds"
                :visible-ids="visibleDeviceIds"
                @changed="refreshDeviceTags"
              />
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
                  <h3>
                    {{
                      search || deviceGroupFilter
                        ? "没有匹配的设备"
                        : "还没有已授权设备"
                    }}
                  </h3>
                  <p>
                    {{
                      search || deviceGroupFilter
                        ? "尝试其他设备组、名称或设备 ID"
                        : user.role === "admin"
                          ? "点击“添加设备”，选择 SSH 或 Agent 接入"
                          : "请联系管理员完成设备注册与范围授权"
                    }}
                  </p>
                </div>
                <div v-else class="table-scroll">
                  <label
                    v-if="user.role === 'admin'"
                    class="mobile-device-selection"
                  >
                    <input
                      type="checkbox"
                      :checked="allVisibleSelected"
                      :indeterminate="
                        someVisibleSelected && !allVisibleSelected
                      "
                      @change="
                        toggleVisibleDevices(
                          ($event.target as HTMLInputElement).checked,
                        )
                      "
                    />选择当前筛选的全部设备
                  </label>
                  <table
                    class="device-table"
                    :class="{ 'has-selection': user.role === 'admin' }"
                  >
                    <thead>
                      <tr>
                        <th
                          v-if="user.role === 'admin'"
                          class="device-selection"
                        >
                          <input
                            type="checkbox"
                            aria-label="选择当前筛选的全部设备"
                            :checked="allVisibleSelected"
                            :indeterminate="
                              someVisibleSelected && !allVisibleSelected
                            "
                            @change="
                              toggleVisibleDevices(
                                ($event.target as HTMLInputElement).checked,
                              )
                            "
                          />
                        </th>
                        <th>设备</th>
                        <th>连接状态</th>
                        <th>私网数据</th>
                        <th>业务健康</th>
                        <th>最近心跳 / 检查</th>
                        <th>操作</th>
                      </tr>
                    </thead>
                    <tbody>
                      <tr v-for="device in filteredDevices" :key="device.id">
                        <td
                          v-if="user.role === 'admin'"
                          class="device-selection"
                        >
                          <input
                            v-model="selectedDeviceIds"
                            type="checkbox"
                            :value="device.id"
                            :aria-label="`选择设备 ${device.name}`"
                          />
                        </td>
                        <td class="device-primary">
                          <div class="device-name">
                            <span class="device-icon" aria-hidden="true"
                              >▤</span
                            >
                            <div>
                              <strong>{{ device.name }}</strong
                              ><small>{{
                                device.device_groups
                                  ?.map((g) => g.name)
                                  .join("、") || "未分组"
                              }}</small
                              ><small class="mono" :title="device.id"
                                >{{ device.id.slice(0, 12) }}… ·
                                {{
                                  device.connection_kind === "ssh"
                                    ? "SSH 接入"
                                    : (device.ssh_configured
                                        ? "Agent + 备用 SSH · "
                                        : "Agent · ") +
                                      (device.agent_version ?? "版本未知")
                                }}</small
                              >
                            </div>
                          </div>
                          <small
                            v-if="device.connection_kind !== 'ssh'"
                            class="muted mono"
                            :title="(device.ip_addresses ?? []).join(', ')"
                          >
                            {{ device.ip_addresses?.[0] ?? "IP 尚未上报"
                            }}{{
                              (device.ip_addresses?.length ?? 0) > 1
                                ? ` +${device.ip_addresses!.length - 1}`
                                : ""
                            }}
                          </small>
                          <span v-if="device.revoked_at" class="revoked"
                            >访问已撤销</span
                          >
                        </td>
                        <td data-label="连接状态">
                          <div
                            v-if="device.connection_kind === 'ssh'"
                            class="small"
                          >
                            <span>按需连接</span><br /><span class="muted">{{
                              device.ssh_status === "connected"
                                ? "上次连接成功"
                                : device.ssh_status === "failed"
                                  ? "上次连接失败"
                                  : "尚未测试"
                            }}</span>
                          </div>
                          <HealthBadge
                            v-else
                            :value="
                              apiReady
                                ? device.control_online && !device.revoked_at
                                : null
                            "
                            good="在线"
                            bad="离线"
                          />
                          <small
                            v-if="
                              device.connection_kind === 'agent' &&
                              device.ssh_configured
                            "
                            class="muted"
                          >
                            {{
                              device.terminal_backend === "ssh"
                                ? "终端将尝试备用 SSH"
                                : "已配置备用 SSH"
                            }}
                          </small>
                        </td>
                        <td data-label="私网数据">
                          <HealthBadge
                            :value="
                              apiReady ? device.private_data_reachable : null
                            "
                            good="可达"
                          />
                        </td>
                        <td data-label="业务健康">
                          <HealthBadge
                            :value="apiReady ? device.business_healthy : null"
                            good="健康"
                            bad="异常"
                          />
                        </td>
                        <td
                          class="small muted device-heartbeat"
                          data-label="最近心跳 / 检查"
                        >
                          {{
                            formatTime(
                              device.connection_kind === "ssh"
                                ? (device.ssh_checked_at ?? null)
                                : device.last_seen,
                            )
                          }}
                        </td>
                        <td class="device-actions-cell">
                          <DeviceActions
                            :device="device"
                            :user="user"
                            :ready="apiReady"
                            :revoking="revokeBusy === device.id"
                            :busy="{
                              terminal: !!terminalTarget,
                              connection: connectionOpen,
                              install: enrollOpen,
                              network: !!networkTarget,
                              health: !!healthTarget,
                              ssh: !!sshTarget,
                              exec: execOpen,
                              revoke: !!revokeBusy,
                            }"
                            @action="handleDeviceAction($event, device)"
                          />
                        </td>
                      </tr>
                    </tbody>
                  </table></div
              ></template>
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
                          <span>{{
                            session.transport === "ssh" ? "SSH" : "网页"
                          }}</span>
                          <small class="muted">
                            →
                            {{
                              session.backend === "ssh" ? "SSH 主机" : "Agent"
                            }}</small
                          >
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
          <span>FARHELM <span class="footer-dot">·</span> 开发版本</span
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
      <AddDevicePanel
        v-if="addDeviceOpen && user?.role === 'admin'"
        @close="addDeviceOpen = false"
        @select="selectDeviceAccess"
      />
      <AgentInstallPanel
        v-if="enrollOpen && user?.role === 'admin'"
        :key="installTarget?.id ?? 'new'"
        :device="installTarget"
        @close="
          enrollOpen = false;
          installTarget = undefined;
        "
        @added="refresh"
        @settings="
          enrollOpen = false;
          installTarget = undefined;
          switchView('settings');
        "
      />
      <DeviceConnectionPanel
        v-if="connectionOpen && user?.role === 'admin'"
        :key="connectionTarget?.id ?? 'new'"
        :device="connectionTarget"
        @close="
          connectionOpen = false;
          connectionTarget = undefined;
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
      <DeviceNetworkPanel
        v-if="networkTarget && user"
        :key="networkTarget.id"
        :device="networkTarget"
        :user="user"
        @close="networkTarget = null"
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

<style scoped>
.device-selection {
  width: 42px;
  min-width: 42px;
  padding-right: 4px;
}
.device-selection input {
  width: 16px;
  height: 16px;
  min-width: 16px;
  margin: 0;
  cursor: pointer;
}
.device-table .device-name small {
  font-size: 11px;
}
.mobile-device-selection {
  display: none;
}
@media (max-width: 800px) {
  .mobile-device-selection {
    display: flex;
    align-items: center;
    gap: 8px;
    margin: 0 14px 12px;
  }
  .mobile-device-selection input {
    width: 16px;
    height: 16px;
    margin: 0;
  }
  .device-table,
  .device-table tbody {
    display: block;
  }
  .device-table thead {
    display: none;
  }
  .device-table tbody {
    padding: 0 12px;
  }
  .device-table tbody tr {
    display: grid;
    grid-template-columns: repeat(2, minmax(0, 1fr));
    position: relative;
    margin-bottom: 12px;
    border: 1px solid var(--border);
    border-radius: 8px;
    overflow: hidden;
  }
  .device-table td {
    display: block;
    min-width: 0;
    border: 0;
    padding: 10px 14px;
    white-space: normal;
    font-size: 12px;
    overflow-wrap: anywhere;
  }
  .device-table td[data-label]::before {
    content: attr(data-label);
    display: block;
    color: #72808e;
    font-size: 12px;
    margin-bottom: 4px;
  }
  .device-table .device-primary,
  .device-table .device-heartbeat,
  .device-table .device-actions-cell {
    grid-column: 1 / -1;
  }
  .device-table.has-selection .device-primary {
    padding-left: 44px;
  }
  .device-table .device-selection {
    position: absolute;
    top: 16px;
    left: 14px;
    padding: 0;
    width: 16px;
    min-width: 16px;
  }
  .device-table .device-name {
    align-items: flex-start;
  }
  .device-table .device-name > div {
    min-width: 0;
  }
  .device-table .device-actions-cell {
    border-top: 1px solid var(--border);
  }
  .device-table :deep(.health) {
    font-size: 12px;
  }
}
</style>
