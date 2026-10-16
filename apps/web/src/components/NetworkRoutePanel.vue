<script setup lang="ts">
import { computed, onMounted, onBeforeUnmount, ref } from "vue";
import { api } from "../api/client";
import type { Device, DeviceNetworkRoute } from "../api/types";
import { routeDescription, routeReasons } from "../network-route";
const props = defineProps<{ device: Device; admin: boolean }>();
const emit = defineEmits<{ close: []; changed: []; settings: [] }>();
const state = ref<DeviceNetworkRoute | null>(null),
  busy = ref(false),
  error = ref(""),
  message = ref("");
const vpnIp = ref(""),
  sshPort = ref<number | string>("");
const path = `/devices/${encodeURIComponent(props.device.id)}/network-route`;
const isAgent = computed(() => props.device.connection_kind !== "ssh");
const hasSsh = computed(
  () => props.device.connection_kind === "ssh" || props.device.ssh_configured,
);
const mode = computed(() =>
  !state.value?.policy
    ? "沿用接入地址"
    : state.value.policy.mode === "private_only"
      ? "仅内网 / VPN"
      : "VPN 优先、公网备用",
);
let disposed = false,
  timer: ReturnType<typeof setTimeout> | undefined;
function fill(s: DeviceNetworkRoute) {
  state.value = s;
  vpnIp.value = s.addresses.vpn_ip ?? "";
  sshPort.value = s.addresses.ssh_port ?? "";
}
function report(e: unknown) {
  const text = e instanceof Error ? e.message : String(e);
  error.value = text.includes("NETWORK_ROUTE_BUSY")
    ? "这台设备还有活跃终端或执行任务，请结束后再修改内网地址。"
    : text.includes("NETWORK_ROUTE_CHANGED_RELOAD")
      ? "地址已被其他管理员修改，请重新打开后编辑。"
      : text.includes("VPN_LITERAL_PRIVATE_IP_REQUIRED")
        ? "请填写有效的私有 IP，例如 10.144.144.2。"
        : text;
}
async function refresh() {
  try {
    const s = await api.request<DeviceNetworkRoute>(path);
    if (!disposed && !busy.value) {
      if (state.value && s.address_revision !== state.value.address_revision)
        error.value = "地址已被修改，请重新打开面板后编辑。";
      else state.value = s;
    }
  } catch {
  } finally {
    if (!disposed) timer = setTimeout(refresh, 5000);
  }
}
onMounted(async () => {
  try {
    const s = await api.request<DeviceNetworkRoute>(path);
    if (!disposed) fill(s);
  } catch (e) {
    if (!disposed) report(e);
  }
  if (!disposed) timer = setTimeout(refresh, 5000);
});
onBeforeUnmount(() => {
  disposed = true;
  clearTimeout(timer);
});
async function save() {
  if (busy.value || !state.value) return;
  busy.value = true;
  error.value = "";
  message.value = "";
  try {
    const result = await api.request<DeviceNetworkRoute>(path, {
      method: "PUT",
      body: {
        v: 1,
        revision: state.value.address_revision,
        vpn_ip: vpnIp.value.trim() || null,
        ssh_port:
          hasSsh.value && sshPort.value !== "" ? Number(sshPort.value) : null,
      },
    });
    if (disposed) return;
    fill(result);
    message.value =
      "设备内网地址已保存，网络模式与平台入口由系统设置统一管理。";
    emit("changed");
  } catch (e) {
    if (!disposed) report(e);
  } finally {
    busy.value = false;
  }
}
</script>
<template>
  <div class="route-overlay">
    <section
      class="panel route-panel"
      role="dialog"
      aria-modal="true"
      aria-labelledby="route-heading"
    >
      <header class="panel-heading">
        <div>
          <h2 id="route-heading">设备内网地址 · {{ device.name }}</h2>
          <p class="muted">仅配置这台机器的地址，网络策略统一继承平台设置</p>
        </div>
        <button
          class="icon-button"
          aria-label="关闭内网地址"
          :disabled="busy"
          @click="emit('close')"
        >
          ×
        </button>
      </header>
      <div class="route-content">
        <p v-if="error" role="alert" class="text-warning">{{ error }}</p>
        <p v-if="message" role="status">{{ message }}</p>
        <template v-if="state">
          <div class="route-status">
            <p>
              <strong
                >{{
                  state.source === "legacy" ? "旧设备策略" : "平台网络策略"
                }}：</strong
              >{{ mode }}
            </p>
            <p v-if="state.source === 'legacy'" class="text-warning">
              这台设备的旧配置暂时保留；管理员在系统设置保存统一策略后自动接管。
            </p>
            <p v-if="isAgent">
              <strong>Agent：</strong
              >{{ state.agent?.connected ? "当前连接" : "离线 / 尚未确认" }} ·
              {{ routeDescription(state.agent) }}
            </p>
            <p v-if="state.agent?.reason">
              {{ routeReasons[state.agent.reason] ?? state.agent.reason }}
            </p>
            <p v-if="hasSsh">
              <strong>SSH 最近连接：</strong>{{ routeDescription(state.ssh) }}
            </p>
            <p v-if="state.ssh?.reason">
              {{ routeReasons[state.ssh.reason] ?? state.ssh.reason }}
            </p>
            <p
              v-if="state.blocked_reason === 'SSH_VPN_IP_REQUIRED'"
              class="text-warning"
            >
              仅内网模式需要这台设备的内网 IP，配置后才能通过 SSH 连接。
            </p>
            <p
              v-else-if="
                state.blocked_reason === 'AGENT_PLATFORM_ENDPOINT_REQUIRED'
              "
              class="text-warning"
            >
              请先在系统设置填写 Agent 的平台内网入口。
            </p>
            <p
              v-else-if="state.policy && isAgent && !state.agent_applied"
              class="text-warning"
            >
              {{
                state.agent_supported === false
                  ? "Agent 不支持网络策略，请先升级至 0.2.5 或更新版本。"
                  : "等待 Agent 确认平台网络策略。"
              }}
            </p>
            <button
              v-if="admin"
              type="button"
              class="text-button"
              @click="emit('settings')"
            >
              前往平台网络设置
            </button>
          </div>
          <form v-if="admin" @submit.prevent="save">
            <fieldset :disabled="busy">
              <label
                >本机内网 / VPN IP<input
                  v-model="vpnIp"
                  placeholder="10.144.144.2"
                  maxlength="45"
              /></label>
              <p class="muted">
                填写这台机器在内网或 EasyTier 中的 IP，不是平台 IP。留空时，SSH
                会使用接入配置中已有的私有 IP。
              </p>
              <p v-if="isAgent" class="muted">
                Agent 主动连接系统设置中的平台入口；仅使用 Agent 时，这里的 IP
                可留空。
              </p>
              <details v-if="hasSsh">
                <summary>SSH 内网端口（可选）</summary>
                <label
                  >SSH 内网端口<input
                    v-model="sshPort"
                    type="number"
                    min="1"
                    max="65535"
                    placeholder="沿用 SSH 接入端口"
                /></label>
              </details>
              <p v-if="hasSsh && state.ssh_fallback" class="muted">
                SSH 备用地址：{{ state.ssh_fallback.host }}:{{
                  state.ssh_fallback.port
                }}，沿用设备接入配置的账号、密钥与主机指纹。
              </p>
              <button type="submit" class="button primary">
                {{ busy ? "保存中…" : "保存内网地址" }}
              </button>
            </fieldset>
          </form>
          <p v-else class="muted">仅管理员可修改设备内网地址和平台网络设置。</p>
          <p class="muted">
            EasyTier 路径按实际路由采集；未知表示信息不足。SSH
            显示最近连接时的检测结果。
          </p>
        </template>
        <p v-else>正在读取设备网络信息…</p>
      </div>
    </section>
  </div>
</template>
<style scoped>
.route-overlay {
  position: fixed;
  inset: 0;
  z-index: 90;
  background: #10202c80;
  display: grid;
  place-items: center;
  padding: 16px;
}
.route-panel {
  width: min(700px, 100%);
  max-height: calc(100dvh - 32px);
  overflow: auto;
}
.panel-heading {
  padding: 20px;
  align-items: flex-start;
}
.route-content {
  padding: 0 20px 20px;
  display: grid;
  gap: 16px;
}
.route-status {
  padding: 14px;
  background: #f3f6f8;
  border-radius: 8px;
  display: grid;
  gap: 8px;
}
fieldset {
  border: 0;
  padding: 0;
  margin: 0;
  display: grid;
  gap: 14px;
  min-width: 0;
}
label {
  display: grid;
  gap: 6px;
  margin: 0;
  font-size: 13px;
}
.check {
  display: flex;
  align-items: center;
}
.check input {
  width: auto;
}
.route-address {
  display: grid;
  grid-template-columns: minmax(0, 1fr) 100px;
  gap: 12px;
}
p {
  margin: 0;
  font-size: 13px;
  overflow-wrap: anywhere;
}
h3 {
  margin: 8px 0 0;
  font-size: 15px;
}
input,
select {
  width: 100%;
  box-sizing: border-box;
}
button[type="submit"] {
  justify-self: start;
}
</style>
