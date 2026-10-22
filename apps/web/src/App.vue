<script setup lang="ts">
import {
  computed,
  defineAsyncComponent,
  onBeforeUnmount,
  onMounted,
  ref,
  watch,
} from "vue";
import {
  readAppRoute,
  routeHash,
  type View,
  type AppRoute,
} from "./navigation";
import { diskPercent } from "./disk";
import { api, ApiError } from "./api/client";
import { readTabSession, writeTabSession } from "./tab-session";
import { useDeviceResource } from "./composables/useDeviceResource";
import { useTaskSummary } from "./composables/useTaskSummary";
import { useListResource } from "./composables/useListResource";
import {
  useHistoryList,
  type HistoryFilters as HistoryCriteria,
} from "./composables/useHistoryList";
import HistoryFilters from "./components/HistoryFilters.vue";
import type {
  AuditEntry,
  Device,
  DevicePage,
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
import ActorIdentity from "./components/ActorIdentity.vue";
import AuditDetails from "./components/AuditDetails.vue";
import { auditActionLabels, auditOutcome, auditSource } from "./audit";
import NetworkRoutePanel from "./components/NetworkRoutePanel.vue";
import NetworkSettingsPanel from "./components/NetworkSettingsPanel.vue";
import { routeDescription, routeReasons } from "./network-route";
import DeviceNetworkPanel from "./components/DeviceNetworkPanel.vue";
import HealthChecksPanel from "./components/HealthChecksPanel.vue";
import SshConnectionPanel from "./components/SshConnectionPanel.vue";
import SessionDuration from "./components/SessionDuration.vue";
import DeviceConnectionPanel from "./components/DeviceConnectionPanel.vue";
import AddDevicePanel from "./components/AddDevicePanel.vue";
import AgentInstallPanel from "./components/AgentInstallPanel.vue";
import DeploymentPanel from "./components/DeploymentPanel.vue";
import SystemSettingsPanel from "./components/SystemSettingsPanel.vue";
import CertificateSettingsPanel from "./components/CertificateSettingsPanel.vue";
import AgentUpgradePanel from "./components/AgentUpgradePanel.vue";
import DeviceGroupTools from "./components/DeviceGroupTools.vue";
import DeviceActions from "./components/DeviceActions.vue";
import ChangePasswordPanel from "./components/ChangePasswordPanel.vue";
import ApiTokensPanel from "./components/ApiTokensPanel.vue";
import AccessControlPanel from "./components/AccessControlPanel.vue";
const DeviceDetail = defineAsyncComponent(
  () => import("./components/DeviceDetail.vue"),
);
const initialRoute = readAppRoute();
const detailDeviceId = ref<string | null>(initialRoute?.deviceId ?? null);
const detailResource = useDeviceResource(detailDeviceId);
const detailDevice = detailResource.device;

const TargetAccountsPanel = defineAsyncComponent(
  () => import("./components/TargetAccountsPanel.vue"),
);
const TerminalPanel = defineAsyncComponent(
  () => import("./components/TerminalPanel.vue"),
);

const user = ref<User | null>(null);
const agentEnabled = computed(
  () => user.value?.runtime?.device_access !== "ssh-only",
);
const httpsEnabled = computed(
  () => agentEnabled.value || user.value?.runtime?.web_protocol !== "http",
);
const pageUsesHttps = window.location.protocol === "https:";
const username = ref("");
const password = ref("");
const loginBusy = ref(false);
const loginError = ref("");
const loginNotice = ref("");
const restorePending = ref(!!readTabSession());
const restoreBusy = ref(false);
const restoreError = ref("");
const sessionStorageAvailable = ref(true);
const passwordOpen = ref(false);
const view = ref<View>(initialRoute?.view ?? "devices");
let navigationReady = false;
const closingSession = ref<string | null>(null);
const deviceList = useListResource<Device>("/devices", "devices");
const devicePageNumber = ref(1);
const devicePageLimit = ref(50);
const appliedDeviceSearch = ref("");
const deviceGroupOptions = ref<DevicePage["groups"]>([]);
const pagedDevices = useListResource<Device, DevicePage>(() => {
  const params = new URLSearchParams({
    page: String(devicePageNumber.value),
    limit: String(devicePageLimit.value),
  });
  if (appliedDeviceSearch.value) params.set("q", appliedDeviceSearch.value);
  if (deviceGroupFilter.value) params.set("group", deviceGroupFilter.value);
  return `/devices?${params}`;
}, "devices");
watch(pagedDevices.page, (page) => {
  if (page) {
    devicePageNumber.value = page.number;
    deviceGroupOptions.value = page.groups;
  }
});
const overviewTaskList = useTaskSummary();
const taskHistory = useHistoryList<Task>("/tasks", "tasks");
const auditHistory = useHistoryList<AuditEntry>("/audit", "audit");
const sessionHistory = useHistoryList<TerminalSession>(
  "/terminal-sessions",
  "sessions",
);
const taskList = taskHistory.resource;
const auditList = auditHistory.resource;
const sessionList = sessionHistory.resource;
const currentHistory = computed(() =>
  view.value === "tasks"
    ? taskHistory
    : view.value === "audit"
      ? auditHistory
      : view.value === "terminals"
        ? sessionHistory
        : null,
);
const historyState = computed(() => ({
  kind:
    view.value === "audit"
      ? ("audit" as const)
      : view.value === "terminals"
        ? ("terminals" as const)
        : ("tasks" as const),
  filters: currentHistory.value?.filters.value ?? taskHistory.filters.value,
  number: currentHistory.value?.number.value ?? 1,
  hasMore: currentHistory.value?.resource.page.value?.has_more ?? false,
  loading: currentHistory.value?.resource.loading.value ?? false,
  filtered: currentHistory.value?.filtered.value ?? false,
  count: currentHistory.value?.resource.items.value.length ?? 0,
}));
function applyHistoryFilters(filters: HistoryCriteria) {
  currentHistory.value?.apply(filters);
}
const devices = computed(() =>
  deviceList.updatedAt.value
    ? deviceList.items.value
    : pagedDevices.items.value,
);
const tasks = taskList.items;
const audit = auditList.items;
const terminalSessions = sessionList.items;
const lists = {
  devices: pagedDevices,
  tasks: taskList,
  audit: auditList,
  terminals: sessionList,
};
const currentList = computed(() =>
  view.value === "devices" && detailDeviceId.value
    ? detailResource
    : view.value in lists
      ? lists[view.value as keyof typeof lists]
      : null,
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
    !!pagedDevices.updatedAt.value &&
    !pagedDevices.error.value,
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
const deviceError = pagedDevices.error;
const taskError = overviewTaskList.error;
const tasksReady = computed(
  () =>
    !sessionError.value &&
    !!overviewTaskList.updatedAt.value &&
    !taskError.value,
);
const authorizationDevice = ref<string>();
const connectionTab = ref<"endpoint" | "account">("endpoint");
const accountTarget = ref<{ device: Device; manage: boolean } | null>(null);
const terminalTarget = ref<{
  id: string;
  name: string;
  recording?: TerminalSession;
  elevated?: boolean;
  connectionMode?: "normal" | "root";
  accountId?: string;
  username?: string;
} | null>(null);
const deviceGroupFilter = ref("");
const selectedDeviceIds = ref<string[]>([]);
const sshTarget = ref<Device | null>(null);
const networkTarget = ref<Device | null>(null);
const networkRouteTarget = ref<Device | null>(null);
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
let restoreAttempt = 0;
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
            ...(agentEnabled.value
              ? [{ id: "upgrades", label: "Agent 升级", icon: "↑" } as const]
              : []),
            { id: "settings", label: "系统设置", icon: "⚙" } as const,
            { id: "access", label: "访问控制", icon: "♙" } as const,
            { id: "api", label: "API Token", icon: "⌘" } as const,
          ]
        : []),
    ] as const,
);
const titles = {
  api: ["API Token", "管理 API 凭据与授权，接入脚本和 AI Skill"],
  access: ["访问控制", "组织人员、分配操作权限，统一管理设备与登录账号授权"],
  devices: ["设备总览", "连接状态清晰可见，每一次操作都有记录"],
  tasks: ["任务中心", "从授权到真实结果，追踪每条命令的生命周期"],
  audit: ["操作审计", "平台内操作、授权与输出查看的持久化记录"],
  terminals: ["终端会话", "查看连接记录与会话回放"],
  settings: ["系统设置", "查看平台运行方式，管理接入与证书设置"],
  upgrades: ["Agent 升级", "批量更新，跟踪每台设备的真实升级结果"],
};
let deviceSearchTimer: ReturnType<typeof setTimeout> | undefined;
function applyDeviceFilters() {
  clearTimeout(deviceSearchTimer);
  appliedDeviceSearch.value = search.value.trim();
  devicePageNumber.value = 1;
  pagedDevices.reset();
  if (
    user.value &&
    !user.value.must_change_password &&
    view.value === "devices" &&
    !detailDeviceId.value &&
    hasPermission(user.value, "devices.read")
  )
    void pagedDevices.load();
}
watch(search, () => {
  clearTimeout(deviceSearchTimer);
  deviceSearchTimer = setTimeout(applyDeviceFilters, 300);
});
watch([deviceGroupFilter, devicePageLimit], applyDeviceFilters);
function changeDevicePage(number: number) {
  if (pagedDevices.loading.value) return;
  devicePageNumber.value = number;
  pagedDevices.reset();
  void pagedDevices.load();
}
const filteredDevices = pagedDevices.items;
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
  deviceList.reset();
  void pagedDevices.load();
}
const filteredTasks = tasks;
const filteredAudit = audit;
const filteredSessions = terminalSessions;
const onlineCount = computed(
  () =>
    filteredDevices.value.filter((d) => d.control_online && !d.revoked_at)
      .length,
);
const activeCount = computed(() => overviewTaskList.data.value?.active ?? 0);
const unknownCount = computed(() => overviewTaskList.data.value?.unknown ?? 0);
const isExecAllowed = computed(
  () => agentEnabled.value && canExecute(user.value),
);

const logoutBusy = ref(false);
async function logout() {
  if (logoutBusy.value) return;
  logoutBusy.value = true;
  const generation = sessionGeneration;
  try {
    await api.request("/logout", { method: "POST", body: { v: 1 } });
    if (generation === sessionGeneration) clearSession();
  } catch {
    if (generation === sessionGeneration)
      error.value = "未能确认服务端注销，请重试退出登录。";
  } finally {
    logoutBusy.value = false;
  }
}
function clearSession(message = "", preserveSaved = false) {
  navigationReady = false;
  restoreAttempt++;
  restorePending.value = false;
  restoreBusy.value = false;
  restoreError.value = "";
  if (!preserveSaved) writeTabSession(null);
  sessionGeneration++;
  taskGeneration++;
  api.setToken(null);
  user.value = null;
  passwordOpen.value = false;
  loginNotice.value = "";
  view.value = "devices";
  password.value = "";
  for (const list of Object.values(lists)) list.reset();
  deviceList.reset();
  devicePageNumber.value = 1;
  appliedDeviceSearch.value = "";
  clearTimeout(deviceSearchTimer);
  deviceGroupOptions.value = [];
  overviewTaskList.reset();
  detailResource.reset();
  taskHistory.reset();
  auditHistory.reset();
  sessionHistory.reset();
  selectedDeviceIds.value = [];
  deviceGroupFilter.value = "";
  selectedTask.value = null;
  terminalTarget.value = null;
  accountTarget.value = null;
  authorizationDevice.value = undefined;
  connectionTab.value = "endpoint";
  healthTarget.value = null;
  networkTarget.value = null;
  detailDeviceId.value = null;
  networkRouteTarget.value = null;
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
  clearSession(
    "登录已失效，请重新登录。若此前命令提交结果不明，请先核对任务中心",
  );
function passwordChanged() {
  clearSession();
  loginNotice.value = "密码修改成功，请使用新密码重新登录。";
}
function passwordUnconfirmed() {
  clearSession(
    "未能确认密码是否已修改，请先尝试用新密码登录；若失败，再使用原密码。请勿重复提交修改请求。",
  );
}
async function establishSession(
  verified: User,
  token: string,
  preferredView?: string,
) {
  if (
    !verified?.id ||
    !["admin", "ops", "business", "auditor"].includes(verified.role)
  )
    throw new ApiError("登录身份无效，请重新登录", 401);
  navigationReady = false;
  user.value = verified;
  const requested = readAppRoute();
  const target =
    navigation.value.find(
      (item) => item.id === (requested?.view ?? preferredView),
    )?.id ??
    navigation.value[0]?.id ??
    "devices";
  navigateTo(
    {
      view: target,
      deviceId:
        target === "devices" && requested?.view === "devices"
          ? requested.deviceId
          : null,
    },
    true,
  );
  sessionStorageAvailable.value = writeTabSession({ token, view: view.value });
  sessionGeneration++;
  if (verified.must_change_password) return;
  await refresh();
  if (user.value) {
    navigationReady = true;
    if (refreshTimer) clearInterval(refreshTimer);
    refreshTimer = setInterval(() => {
      if (!document.hidden && user.value) void refresh(true);
    }, 10_000);
  }
}
async function restoreLogin() {
  if (restoreBusy.value) return;
  const saved = readTabSession();
  if (!saved) {
    restorePending.value = false;
    return;
  }
  const attempt = ++restoreAttempt;
  restoreBusy.value = true;
  restoreError.value = "";
  api.setToken(saved.token);
  try {
    const verified = await api.request<User>("/me");
    if (attempt !== restoreAttempt) return;
    await establishSession(verified, saved.token, saved.view);
    if (attempt === restoreAttempt) restorePending.value = false;
  } catch (e) {
    if (attempt !== restoreAttempt) return;
    if (e instanceof ApiError && e.status === 401)
      clearSession("登录已失效，请重新登录。");
    else
      restoreError.value = "暂时无法校验登录状态，请检查网络或服务端后重试。";
  } finally {
    if (attempt === restoreAttempt) restoreBusy.value = false;
  }
}
watch([view, detailDeviceId], ([page]) => {
  const saved = user.value ? readTabSession() : null;
  if (saved)
    sessionStorageAvailable.value = writeTabSession({ ...saved, view: page });
  if (user.value && navigationReady) void refresh();
});
onMounted(() => {
  window.addEventListener("popstate", restoreRoute);
  window.addEventListener("hashchange", restoreRoute);
  if (restorePending.value) void restoreLogin();
});
async function login() {
  if (loginBusy.value) return;
  loginBusy.value = true;
  const generation = sessionGeneration;
  loginError.value = "";
  loginNotice.value = "";
  try {
    const response = await api.request<{ access_token: string; user: User }>(
      "/login",
      {
        method: "POST",
        body: { username: username.value, password: password.value },
      },
    );
    if (generation !== sessionGeneration) return;
    if (!response.access_token || !response.user?.id)
      throw new Error("登录响应格式错误");
    api.setToken(response.access_token);
    const verified = await api.request<User>("/me");
    if (generation !== sessionGeneration) return;
    await establishSession(verified, response.access_token);
  } catch (e) {
    if (generation === sessionGeneration)
      clearSession(e instanceof Error ? e.message : "登录失败");
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
function refreshTargets(poll = false) {
  const targets = [];
  if (hasPermission(user.value, "devices.read")) {
    if (
      view.value === "devices" &&
      (!detailDeviceId.value ||
        hasPermission(user.value, "devices.read", detailDeviceId.value))
    )
      targets.push(detailDeviceId.value ? detailResource : pagedDevices);
    else if (
      ["tasks", "audit", "terminals", "access", "api"].includes(view.value) &&
      (!poll || !deviceList.updatedAt.value)
    )
      targets.push(deviceList);
  }
  if (hasPermission(user.value, "tasks.read")) {
    if (view.value === "devices" && !detailDeviceId.value)
      targets.push(overviewTaskList);
    if (view.value === "tasks") targets.push(taskList);
  }
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
      const scopeChanged =
        JSON.stringify([
          user.value?.role,
          user.value?.device_scope,
          user.value?.permissions,
        ]) !==
        JSON.stringify([
          freshUser.role,
          freshUser.device_scope,
          freshUser.permissions,
        ]);
      if (scopeChanged) {
        overviewTaskList.reset();
        deviceList.reset();
        pagedDevices.reset();
        devicePageNumber.value = 1;
        deviceGroupOptions.value = [];
        selectedDeviceIds.value = [];
        detailResource.reset();
      }
      user.value = freshUser;
      if (
        detailDeviceId.value &&
        !hasPermission(freshUser, "devices.read", detailDeviceId.value)
      ) {
        detailResource.reset();
        detailResource.error.value = "设备不存在或无权查看";
      }
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
      if (!hasPermission(freshUser, "tasks.read")) overviewTaskList.reset();
      if (!navigation.value.some((item) => item.id === view.value))
        navigateTo(
          { view: navigation.value[0]?.id ?? "devices", deviceId: null },
          true,
        );
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
async function refresh(poll = false) {
  if (!user.value || user.value.must_change_password) return;
  const generation = sessionGeneration;
  await refreshUser();
  if (
    generation !== sessionGeneration ||
    !user.value ||
    user.value.must_change_password ||
    sessionError.value
  )
    return;
  await Promise.all(refreshTargets(poll === true).map((list) => list.load()));
  if (generation === sessionGeneration) {
    if (view.value === "tasks" && selectedTask.value && !loadingTask.value)
      await selectTask(selectedTask.value.task_id, true);
  }
}
async function selectTask(id: string, quiet = false) {
  const generation = ++taskGeneration;
  const session = sessionGeneration;
  if (!quiet) {
    loadingTask.value = true;
    if (view.value !== "tasks") switchView("tasks");
  }
  try {
    const task = await api.request<Task>(`/tasks/${encodeURIComponent(id)}`);
    if (generation === taskGeneration && session === sessionGeneration)
      selectedTask.value = task;
  } catch (e) {
    if (session === sessionGeneration && generation === taskGeneration)
      error.value = e instanceof Error ? e.message : "任务读取失败";
  } finally {
    if (generation === taskGeneration) loadingTask.value = false;
  }
}
function openExec(id = "") {
  execDevice.value = id;
  if (!detailDeviceId.value) void deviceList.load();
  execOpen.value = true;
}
async function onCreated(id: string) {
  navigateTo({ view: "tasks", deviceId: null });
  await refresh();
  await selectTask(id);
}
function navigateTo(route: AppRoute, replace = false) {
  view.value = route.view;
  detailDeviceId.value = route.deviceId;
  const hash = routeHash(route);
  if (window.location.hash !== hash)
    window.history[replace ? "replaceState" : "pushState"](
      null,
      "",
      window.location.pathname + window.location.search + hash,
    );
}
function restoreRoute() {
  const requested = readAppRoute() ?? { view: "devices", deviceId: null };
  const route: AppRoute =
    user.value && !navigation.value.some((item) => item.id === requested.view)
      ? { view: navigation.value[0]?.id ?? "devices", deviceId: null }
      : requested;
  navigateTo(route, true);
}
function openDevice(id: string) {
  navigateTo({ view: "devices", deviceId: id });
}
function switchView(id: View) {
  if (!navigation.value.some((item) => item.id === id)) return;
  const unchanged = view.value === id && !detailDeviceId.value;
  navigateTo({ view: id, deviceId: null });
  if (id !== "access") authorizationDevice.value = undefined;
  error.value = "";
  if (unchanged) void refresh();
}
function selectDeviceAccess(kind: "ssh" | "agent") {
  addDeviceOpen.value = false;
  if (kind === "ssh") {
    connectionTarget.value = undefined;
    connectionTab.value = "endpoint";
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
    case "root":
      terminalTarget.value = {
        id: device.id,
        name: device.name,
        connectionMode: kind === "root" ? "root" : "normal",
        ...(kind === "root" ? { username: "root" } : {}),
      };
      break;
    case "advanced-terminal":
      accountTarget.value = { device, manage: false };
      break;
    case "accounts":
      accountTarget.value = { device, manage: true };
      break;
    case "connection":
      connectionTab.value = "endpoint";
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
  clearTimeout(deviceSearchTimer);
  window.removeEventListener("popstate", restoreRoute);
  window.removeEventListener("hashchange", restoreRoute);
  clearSession("", true);
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
        <div v-if="restorePending" class="session-restore" aria-live="polite">
          <h2>{{ restoreBusy ? "正在恢复登录…" : "恢复登录" }}</h2>
          <p v-if="!restoreError" class="muted">正在校验会话，请稍候</p>
          <p v-else class="notice danger" role="alert">{{ restoreError }}</p>
          <button
            v-if="restoreError"
            class="button primary"
            :disabled="restoreBusy"
            @click="restoreLogin"
          >
            重试恢复登录
          </button>
        </div>
        <template v-else>
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
            <div v-if="loginNotice" class="notice" role="status">
              {{ loginNotice }}
            </div>
            <div v-if="loginError" class="notice danger" role="alert">
              {{ loginError }}
            </div>
            <button class="button primary login-button" :disabled="loginBusy">
              {{ loginBusy ? "正在验证…" : "登录 →" }}
            </button>
          </form>
          <p class="login-note">
            当前标签页刷新后可恢复登录，会话过期需重新登录。不会保存账号密码
          </p>
        </template>
        <div class="login-footer">
          <span>{{ pageUsesHttps ? "HTTPS / WSS" : "HTTP / WS" }}</span
          ><span>身份与设备范围校验</span>
        </div>
      </div>
    </main>
  </div>
  <main v-else-if="user.must_change_password" class="first-password-screen">
    <ChangePasswordPanel
      :username="user.username"
      required
      :logout-busy="logoutBusy"
      @logout="logout"
      @changed="passwordChanged"
      @unconfirmed="passwordUnconfirmed"
    >
      <p v-if="error" class="notice danger" role="alert">{{ error }}</p>
    </ChangePasswordPanel>
  </main>
  <div v-else class="app-shell">
    <ChangePasswordPanel
      v-if="passwordOpen"
      :username="user.username"
      @close="passwordOpen = false"
      @changed="passwordChanged"
      @unconfirmed="passwordUnconfirmed"
    />
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
      <button class="text-button account-password" @click="passwordOpen = true">
        修改密码
      </button>
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
          :disabled="logoutBusy"
        >
          ↪
        </button>
      </div>
    </aside>
    <div class="workspace">
      <header class="topbar">
        <div class="breadcrumb">
          工作空间 <span>/</span>
          {{
            view === "devices" && detailDeviceId ? "设备详情" : titles[view][0]
          }}
        </div>
        <div class="topbar-right">
          <HealthBadge
            :value="currentReady ? true : null"
            :good="
              detailDeviceId
                ? '设备已更新'
                : currentList
                  ? '列表已更新'
                  : '会话有效'
            "
          /><span class="muted small">{{
            lastUpdated ? `更新于 ${formatTime(lastUpdated)}` : "尚未获取数据"
          }}</span
          ><button
            v-if="
              view !== 'settings' &&
              view !== 'upgrades' &&
              view !== 'access' &&
              view !== 'api'
            "
            class="button secondary small"
            :disabled="refreshing"
            @click="refresh()"
          >
            {{ refreshing ? "刷新中…" : "↻ 刷新" }}
          </button>
        </div>
      </header>
      <main class="main-content">
        <div v-if="!sessionStorageAvailable" class="notice" role="status">
          浏览器未允许保存标签页会话，本次登录可正常使用，刷新后需重新登录。
        </div>
        <div
          v-if="!(view === 'devices' && detailDeviceId)"
          class="page-heading"
        >
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
          {{ detailDeviceId ? "设备详情读取失败" : "当前列表刷新失败" }}：{{
            listError
          }}<span v-if="lastUpdated">。保留上次成功读取的数据</span>。
          <span v-if="view === 'devices'">当前设备状态未知。</span>
        </div>
        <div
          v-if="
            ['tasks', 'audit', 'terminals', 'access', 'api'].includes(view) &&
            deviceError
          "
          class="notice danger"
          role="alert"
        >
          设备信息刷新失败：{{
            deviceError
          }}。设备名称可能已过期，当前页面的独立查询仍可继续。
        </div>
        <div
          v-if="view === 'devices' && !detailDeviceId && taskError"
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
          v-if="view === 'devices' && navigation.length && !detailDeviceId"
          class="metric-grid"
          aria-label="设备概况"
        >
          <div class="metric">
            <span>授权范围内设备</span
            ><strong
              >{{
                lastUpdated
                  ? (pagedDevices.page.value?.visible_total ??
                    filteredDevices.length)
                  : "—"
              }}<small>台</small></strong
            >
            <p>来自已认证的设备清单</p>
          </div>
          <div class="metric">
            <span><span class="dot green"></span>本页 Agent 在线</span
            ><strong
              >{{ apiReady ? onlineCount : "—" }}<small>台</small></strong
            >
            <p>Agent WSS 心跳状态，SSH 按需连接</p>
          </div>
          <div class="metric">
            <span>任务进行中</span
            ><strong
              >{{ tasksReady ? activeCount : "—" }}<small>条</small></strong
            >
            <p>全部可见任务中的排队、下发、接收或运行中</p>
          </div>
          <div class="metric">
            <span>任务待核对</span
            ><strong :class="unknownCount ? 'text-warning' : ''"
              >{{ tasksReady ? unknownCount : "—" }}<small>条</small></strong
            >
            <p>全部可见任务中的 UNKNOWN，不会自动重跑</p>
          </div>
        </section>
        <p v-if="!navigation.length" class="notice">
          当前账号尚未分配操作权限，请联系管理员配置角色和设备范围。
        </p>
        <ApiTokensPanel
          v-if="view === 'api' && user.role === 'admin'"
          :current-user-id="user.id"
          :devices="devices"
        />
        <AccessControlPanel
          v-if="view === 'access' && user.role === 'admin'"
          :current-user-id="user.id"
          :devices="devices"
          :device-id="authorizationDevice"
          @clear-device="authorizationDevice = undefined"
        />
        <DeploymentPanel
          v-if="view === 'settings' && user.role === 'admin' && user.runtime"
          :runtime="user.runtime"
          @saved="refresh"
        />
        <SystemSettingsPanel
          v-if="view === 'settings' && user.role === 'admin' && agentEnabled"
          @saved="refresh"
        />
        <NetworkSettingsPanel
          v-if="view === 'settings' && user.role === 'admin'"
          @saved="refresh"
        />
        <CertificateSettingsPanel
          v-if="view === 'settings' && user.role === 'admin' && httpsEnabled"
          :agent-enabled="agentEnabled"
        />
        <AgentUpgradePanel
          v-if="view === 'upgrades' && user.role === 'admin'"
        />
        <section
          v-if="view === 'devices' && detailDeviceId && !detailDevice"
          class="panel detail-unavailable"
        >
          <button class="button secondary" @click="switchView('devices')">
            ← 返回设备列表
          </button>
          <p>
            {{
              detailResource.loading.value
                ? "正在读取设备详情…"
                : "无法显示设备详情，可返回设备列表或刷新重试。"
            }}
          </p>
        </section>
        <DeviceDetail
          v-if="view === 'devices' && detailDevice"
          :key="detailDevice.id"
          :device="detailDevice"
          :user="user"
          @close="switchView('devices')"
          @changed="refresh"
        >
          <template #actions>
            <DeviceActions
              :device="detailDevice"
              :user="user"
              :ready="currentReady"
              :agent-enabled="agentEnabled"
              :revoking="revokeBusy === detailDevice.id"
              :busy="{
                terminal: !!terminalTarget,
                root: !!terminalTarget,
                connection: connectionOpen,
                install: enrollOpen,
                network: !!networkTarget,
                health: !!healthTarget,
                ssh: !!sshTarget,
                exec: execOpen,
                revoke: !!revokeBusy,
              }"
              @action="handleDeviceAction($event, detailDevice)"
            />
            <button
              v-if="agentEnabled && detailDevice.connection_kind !== 'ssh'"
              class="button secondary"
              :disabled="!currentReady || !!healthTarget"
              @click="handleDeviceAction('health', detailDevice)"
            >
              健康检查
            </button>
            <button
              v-if="agentEnabled && detailDevice.connection_kind !== 'ssh'"
              class="button secondary"
              :disabled="!currentReady || !!networkTarget"
              @click="handleDeviceAction('network', detailDevice)"
            >
              网络记录
            </button>
          </template>
        </DeviceDetail>
        <div
          v-if="
            navigation.length &&
            !(view === 'devices' && detailDeviceId) &&
            view !== 'settings' &&
            view !== 'upgrades' &&
            view !== 'access' &&
            view !== 'api'
          "
          class="content-grid"
          :class="{ 'with-exec': execOpen }"
        >
          <div class="content-primary">
            <section class="panel list-panel">
              <div
                class="list-toolbar"
                :class="{ 'device-list-heading': view === 'devices' }"
              >
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
                        ? (pagedDevices.page.value?.total ??
                          filteredDevices.length)
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
                  <p v-else-if="view === 'tasks'" class="field-hint">
                    {{
                      hasPermission(user, "tasks.read_all")
                        ? "可查看授权设备上所有用户的任务及输出"
                        : "仅展示本人在授权设备上的任务及输出"
                    }}
                  </p>
                  <p v-else-if="view === 'terminals'" class="field-hint">
                    {{
                      user.role === "admin" ||
                      hasPermission(user, "recordings.read_all")
                        ? "可查看授权设备上所有用户的会话与录制"
                        : "仅展示本人在授权设备上的会话与录制"
                    }}
                  </p>
                  <p v-else-if="view === 'audit'" class="field-hint">
                    {{
                      hasPermission(user, "audit.read_all")
                        ? "可查看本人及授权范围内其他用户的操作审计"
                        : "仅展示本人的操作审计"
                    }}
                  </p>
                </div>
              </div>
              <HistoryFilters
                v-if="currentHistory"
                :key="historyState.kind"
                :kind="historyState.kind"
                :filters="historyState.filters"
                :devices="devices"
                @apply="applyHistoryFilters"
              />
              <div v-if="view === 'devices'" class="device-list-filters">
                <DeviceGroupTools
                  :key="
                    user.id +
                    JSON.stringify([
                      user.role,
                      user.device_scope,
                      user.permissions,
                    ])
                  "
                  :devices="filteredDevices"
                  :group-options="deviceGroupOptions"
                  paged
                  :admin="user.role === 'admin'"
                  v-model:filter="deviceGroupFilter"
                  v-model:selected-ids="selectedDeviceIds"
                  :visible-ids="visibleDeviceIds"
                  @changed="refreshDeviceTags"
                />
                <label class="search-label"
                  ><span class="sr-only">筛选当前列表</span
                  ><input
                    v-model="search"
                    type="search"
                    placeholder="搜索名称、ID、IP、版本或组名"
                    maxlength="256"
                    @keydown.enter="applyDeviceFilters"
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
                          ? agentEnabled
                            ? "点击“添加设备”，选择 SSH 或 Agent 接入"
                            : "点击“添加设备”，配置 SSH 接入"
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
                    />选择当前页设备
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
                            aria-label="选择当前页设备"
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
                        <th>网络通道</th>
                        <th>业务健康</th>
                        <th>磁盘占用</th>
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
                              <button
                                class="device-detail-link"
                                :aria-label="`查看设备详情：${device.name}`"
                                @click="openDevice(device.id)"
                              >
                                {{ device.name }}</button
                              ><small>{{
                                device.device_groups
                                  ?.map((g) => g.name)
                                  .join("、") || "未分组"
                              }}</small
                              ><small class="mono" :title="device.id"
                                >{{ device.id.slice(0, 12) }}… ·
                                {{
                                  !agentEnabled
                                    ? device.ssh_configured ||
                                      device.connection_kind === "ssh"
                                      ? "SSH 接入"
                                      : "尚未配置 SSH"
                                    : device.connection_kind === "ssh"
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
                            v-if="
                              agentEnabled && device.connection_kind !== 'ssh'
                            "
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
                            v-if="
                              !agentEnabled || device.connection_kind === 'ssh'
                            "
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
                              agentEnabled &&
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
                        <td data-label="网络通道" class="small">
                          <template v-if="device.network_route">
                            <span v-if="device.connection_kind !== 'ssh'"
                              >Agent
                              {{
                                device.network_route.agent?.connected
                                  ? "当前"
                                  : "最近"
                              }}：{{
                                routeDescription(device.network_route.agent)
                              }}</span
                            >
                            <small
                              v-if="
                                device.connection_kind === 'ssh' ||
                                device.ssh_configured
                              "
                              class="block"
                              >SSH 最近：{{
                                routeDescription(device.network_route.ssh)
                              }}</small
                            >
                            <small
                              v-if="device.network_route.agent?.reason"
                              class="muted block"
                              >{{
                                routeReasons[
                                  device.network_route.agent.reason
                                ] ?? device.network_route.agent.reason
                              }}</small
                            >
                            <small
                              v-if="device.network_route.ssh?.reason"
                              class="muted block"
                              >{{
                                routeReasons[device.network_route.ssh.reason] ??
                                device.network_route.ssh.reason
                              }}</small
                            >
                            <small class="muted block">{{
                              device.network_route.policy?.mode ===
                              "private_only"
                                ? "仅内网 / VPN"
                                : device.network_route.policy
                                  ? "VPN 优先、公网备用"
                                  : "沿用原配置"
                            }}</small>
                          </template>
                          <button
                            class="text-button"
                            :disabled="!apiReady"
                            @click="networkRouteTarget = device"
                          >
                            {{
                              user.role === "admin" ? "内网地址" : "网络详情"
                            }}
                          </button>
                        </td>
                        <td data-label="业务健康">
                          <HealthBadge
                            :value="apiReady ? device.business_healthy : null"
                            good="健康"
                            bad="异常"
                          />
                        </td>
                        <td data-label="磁盘占用">
                          <button
                            class="device-detail-link"
                            :title="
                              device.disk_usage
                                ? `最近采集 ${formatTime(device.disk_usage.checked_at)}`
                                : '查看设备详情后采集'
                            "
                            @click="openDevice(device.id)"
                          >
                            {{
                              device.disk_usage
                                ? `${diskPercent(device.disk_usage.used_bytes, device.disk_usage.total_bytes)}%`
                                : "查看磁盘"
                            }}</button
                          ><small
                            v-if="device.disk_usage?.stale"
                            class="muted block"
                            >旧数据</small
                          >
                        </td>
                        <td
                          class="small muted device-heartbeat"
                          data-label="最近心跳 / 检查"
                        >
                          {{
                            formatTime(
                              !agentEnabled || device.connection_kind === "ssh"
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
                            :agent-enabled="agentEnabled"
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
                  <h3>
                    {{
                      historyState.filtered ? "没有匹配的任务" : "暂无执行记录"
                    }}
                  </h3>
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
                          ><small class="muted block"
                            ><ActorIdentity
                              :id="task.actor_id"
                              :username="task.actor_username"
                          /></small>
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
                  <h3>
                    {{
                      historyState.filtered ? "没有匹配的会话" : "暂无终端会话"
                    }}
                  </h3>
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
                        <td class="small">
                          <ActorIdentity
                            :id="session.actor_id"
                            :username="session.actor_username"
                          />
                        </td>
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
                  <h3>
                    {{
                      historyState.filtered
                        ? "没有匹配的记录"
                        : "暂无可见审计记录"
                    }}
                  </h3>
                  <p>平台操作、授权决定和输出查看会在此留痕</p>
                </div>
                <div v-else class="table-scroll">
                  <table class="audit-table">
                    <thead>
                      <tr>
                        <th>时间 / 事件</th>
                        <th>操作人 / 来源</th>
                        <th>操作对象</th>
                        <th>结果 / 详情</th>
                      </tr>
                    </thead>
                    <tbody>
                      <tr v-for="entry in filteredAudit" :key="entry.id">
                        <td>
                          <strong class="small">{{
                            auditActionLabels[entry.action] ?? entry.action
                          }}</strong
                          ><small class="muted block">{{
                            formatTime(entry.at)
                          }}</small
                          ><small class="muted mono block">{{
                            entry.action
                          }}</small>
                        </td>
                        <td class="small">
                          <ActorIdentity
                            :id="entry.actor_id"
                            :username="entry.actor_username"
                          /><small class="muted block">{{
                            auditSource(entry)
                          }}</small
                          ><small
                            v-if="entry.context?.remote_address"
                            class="muted mono block"
                            >{{ entry.context.remote_address }}</small
                          >
                        </td>
                        <td class="small">
                          <strong>{{
                            entry.target_name ||
                            entry.device_name ||
                            (entry.device_id
                              ? deviceName(entry.device_id)
                              : "平台 / 账号")
                          }}</strong>
                          <button
                            v-if="entry.task_id"
                            class="text-button mono block"
                            @click="selectTask(entry.task_id)"
                          >
                            {{ entry.task_id.slice(0, 12) }}…
                          </button>
                        </td>
                        <td>
                          <span class="audit-outcome">{{
                            auditOutcome(entry)
                          }}</span
                          ><AuditDetails :entry="entry" />
                        </td>
                      </tr>
                    </tbody>
                  </table></div
              ></template>
              <div class="table-footer">
                <template v-if="currentHistory">
                  <span role="status"
                    >第 {{ historyState.number }} 页 · 本页
                    {{ historyState.count }} 条 · 每页 50 条</span
                  >
                  <div class="history-pagination" aria-label="历史分页">
                    <button
                      class="button secondary small"
                      :disabled="
                        historyState.loading || historyState.number === 1
                      "
                      @click="currentHistory.first()"
                    >
                      返回首页
                    </button>
                    <button
                      class="button secondary small"
                      :disabled="
                        historyState.loading || historyState.number === 1
                      "
                      @click="currentHistory.back()"
                    >
                      上一页
                    </button>
                    <button
                      class="button secondary small"
                      :disabled="historyState.loading || !historyState.hasMore"
                      @click="currentHistory.next()"
                    >
                      下一页
                    </button>
                  </div>
                </template>
                <template v-else-if="view === 'devices'">
                  <span role="status"
                    >第 {{ devicePageNumber }} /
                    {{ pagedDevices.page.value?.pages ?? devicePageNumber }} 页
                    · 共
                    {{
                      pagedDevices.page.value?.total ?? filteredDevices.length
                    }}
                    台 · 已选 {{ selectedDeviceIds.length }} 台</span
                  >
                  <div class="history-pagination" aria-label="设备分页">
                    <label
                      >每页
                      <select v-model="devicePageLimit" aria-label="每页设备数">
                        <option :value="25">25 台</option>
                        <option :value="50">50 台</option>
                        <option :value="100">100 台</option>
                      </select></label
                    >
                    <button
                      class="button secondary small"
                      :disabled="
                        pagedDevices.loading.value || devicePageNumber === 1
                      "
                      @click="changeDevicePage(1)"
                    >
                      首页
                    </button>
                    <button
                      class="button secondary small"
                      :disabled="
                        pagedDevices.loading.value || devicePageNumber === 1
                      "
                      @click="changeDevicePage(devicePageNumber - 1)"
                    >
                      上一页
                    </button>
                    <button
                      class="button secondary small"
                      :disabled="
                        pagedDevices.loading.value ||
                        !pagedDevices.page.value ||
                        devicePageNumber >= pagedDevices.page.value.pages
                      "
                      @click="changeDevicePage(devicePageNumber + 1)"
                    >
                      下一页
                    </button>
                  </div>
                </template>
                <span v-else>仅显示当前账号可见设备</span
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
        </div>
        <ExecForm
          v-if="execOpen"
          :key="execDevice"
          :devices="detailDevice ? [detailDevice] : devices"
          :user="user"
          :initial-device="execDevice"
          @close="execOpen = false"
          @created="onCreated"
        />
        <footer class="page-footer">
          <span>FARHELM <span class="footer-dot">·</span> 开发版本</span
          ><span>只审计经过平台的操作</span>
        </footer>
      </main>
      <TargetAccountsPanel
        v-if="accountTarget"
        :device-id="accountTarget.device.id"
        :device-name="accountTarget.device.name"
        :manage="accountTarget.manage"
        @close="accountTarget = null"
        @connection="
          connectionTarget = accountTarget!.device;
          connectionTab = 'account';
          connectionOpen = true;
          accountTarget = null;
        "
        @authorize="
          authorizationDevice = accountTarget!.device.id;
          accountTarget = null;
          switchView('access');
        "
        @selected="
          (account) => {
            terminalTarget = {
              id: accountTarget!.device.id,
              name: accountTarget!.device.name,
              accountId: account?.id,
              username: account?.username,
              elevated: account?.method === 'sudo',
            };
            accountTarget = null;
          }
        "
      />
      <TerminalPanel
        v-if="terminalTarget"
        :key="terminalTarget.recording?.id ?? terminalTarget.id"
        :device-id="terminalTarget.id"
        :device-name="terminalTarget.name"
        :recording="terminalTarget.recording"
        :elevated="terminalTarget.elevated"
        :connection-mode="terminalTarget.connectionMode"
        :account-id="terminalTarget.accountId"
        :username="terminalTarget.username"
        @close="
          terminalTarget = null;
          refresh();
        "
        @changed="refresh"
      />
      <AddDevicePanel
        v-if="addDeviceOpen && user?.role === 'admin'"
        :agent-enabled="agentEnabled"
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
        :agent-enabled="agentEnabled"
        :initial-tab="connectionTab"
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
      <NetworkRoutePanel
        v-if="networkRouteTarget && user"
        :device="networkRouteTarget"
        :admin="user.role === 'admin'"
        @close="networkRouteTarget = null"
        @settings="
          networkRouteTarget = null;
          switchView('settings');
        "
        @changed="refresh()"
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
.detail-unavailable {
  display: grid;
  gap: 16px;
  justify-items: start;
  padding: 24px;
}
.device-detail-link {
  border: 0;
  background: transparent;
  padding: 0;
  color: #236d60;
  font: inherit;
  font-weight: 600;
  text-align: left;
  cursor: pointer;
}
.device-detail-link:hover {
  text-decoration: underline;
}
.device-detail-link:focus-visible {
  outline: 2px solid currentColor;
  outline-offset: 3px;
}
@media (min-width: 801px) {
  .device-table .device-actions-cell,
  .device-table th:last-child {
    position: sticky;
    right: 0;
    background: #fff;
    box-shadow: -6px 0 8px #fff;
  }
}
.audit-table td {
  vertical-align: top;
}
@media (max-width: 800px) {
  .audit-table,
  .audit-table tbody {
    display: block;
    width: 100%;
    min-width: 0;
  }
  .audit-table thead {
    display: none;
  }
  .audit-table tr {
    display: block;
    padding: 14px 16px;
    border-bottom: 1px solid var(--border);
  }
  .audit-table td {
    display: block;
    padding: 6px 0;
    border: 0;
    white-space: normal;
    overflow-wrap: anywhere;
  }
  .audit-table td:nth-child(2)::before {
    content: "操作人 / 来源";
  }
  .audit-table td:nth-child(3)::before {
    content: "操作对象";
  }
  .audit-table td:nth-child(4)::before {
    content: "结果 / 详情";
  }
  .audit-table td::before {
    display: block;
    margin-bottom: 4px;
    color: var(--muted);
    font-size: 11px;
  }
  .audit-table :deep(.audit-details) {
    min-width: 0;
    max-width: 100%;
  }
}

.audit-outcome {
  display: inline-block;
  margin-bottom: 6px;
  font-size: 12px;
  font-weight: 600;
}
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
.history-pagination label {
  display: flex;
  align-items: center;
  gap: 6px;
  margin: 0;
}
.history-pagination select {
  width: auto;
  min-height: 32px;
  margin: 0;
  padding: 4px 8px;
}
.history-pagination {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
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
