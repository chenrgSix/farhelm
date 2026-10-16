<script setup lang="ts">
import { computed, onMounted, onBeforeUnmount, ref } from "vue";
import { api } from "../api/client";
import type {
  Device,
  DeviceNetworkRoute,
  DeviceConnection,
  NetworkPolicy,
} from "../api/types";
import { routeDescription, routeReasons } from "../network-route";
const props = defineProps<{ device: Device; admin: boolean }>();
const emit = defineEmits<{ close: []; changed: [] }>();
const state = ref<DeviceNetworkRoute | null>(null),
  busy = ref(false),
  error = ref(""),
  message = ref("");
const enabled = ref(false),
  mode = ref<NetworkPolicy["mode"]>("vpn_preferred");
const vpnUrl = ref(""),
  vpnIp = ref(""),
  publicUrl = ref(""),
  vpnHost = ref(""),
  vpnPort = ref(22),
  publicHost = ref(""),
  publicPort = ref(22);
const path = `/devices/${encodeURIComponent(props.device.id)}/network-route`;
const isAgent = computed(() => props.device.connection_kind !== "ssh");
const hasSsh = computed(
  () => props.device.connection_kind === "ssh" || props.device.ssh_configured,
);
let disposed = false,
  timer: ReturnType<typeof setTimeout> | undefined;
function fill(s: DeviceNetworkRoute) {
  state.value = s;
  enabled.value = !!s.policy;
  mode.value = s.policy?.mode ?? "vpn_preferred";
  vpnUrl.value = s.policy?.agent?.vpn_url ?? "";
  vpnIp.value = s.policy?.agent?.vpn_ip ?? "";
  publicUrl.value = s.policy?.agent?.public_url ?? "";
  vpnHost.value = s.policy?.ssh?.vpn_host ?? "";
  vpnPort.value = s.policy?.ssh?.vpn_port ?? 22;
  publicHost.value = s.policy?.ssh?.public_host ?? "";
  publicPort.value = s.policy?.ssh?.public_port ?? 22;
}
const errors: Record<string, string> = {
  NETWORK_ROUTE_BUSY:
    "这台设备还有终端或正在执行的任务，请结束后再修改网络策略。",
  NETWORK_ROUTE_CHANGED_RELOAD: "配置已被其他管理员修改，请重新打开后编辑。",
  VPN_LITERAL_PRIVATE_IP_REQUIRED:
    "内网入口必须是固定私有 IP；HTTPS 地址使用域名时，请填写内网/VPN 连接 IP。",
  VPN_IP_HOST_MISMATCH: "HTTPS 地址已填写 IP 时，连接 IP 须与其一致。",
  INVALID_NETWORK_URL:
    "Agent 地址须为 HTTPS 地址，不能包含账号、路径或查询参数。",
  PUBLIC_FALLBACK_FORBIDDEN: "仅内网模式不能配置公网备用地址。",
  DUPLICATE_NETWORK_ENDPOINT: "内网与备用入口不能相同。",
  NETWORK_ENDPOINT_REQUIRED: "请配置内网入口。",
};
function report(e: unknown) {
  const text = e instanceof Error ? e.message : String(e);
  error.value =
    Object.entries(errors).find(([code]) => text.includes(code))?.[1] ?? text;
}
async function refresh() {
  try {
    const s = await api.request<DeviceNetworkRoute>(path);
    if (!disposed && !busy.value) {
      if (state.value && s.revision !== state.value.revision) {
        error.value = "配置已被修改，请重新打开面板后编辑。";
      } else state.value = s;
    }
  } catch {
  } finally {
    if (!disposed) timer = setTimeout(refresh, 5000);
  }
}
onMounted(async () => {
  try {
    fill(await api.request<DeviceNetworkRoute>(path));
    if (props.admin && hasSsh.value && !state.value?.policy) {
      const c = await api.request<DeviceConnection>(
        `/devices/${props.device.id}/connection`,
      );
      publicHost.value = c.ssh?.host ?? "";
      publicPort.value = c.ssh?.port ?? 22;
    }
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
    const policy: NetworkPolicy | null = enabled.value
      ? {
          mode: mode.value,
          agent: isAgent.value
            ? {
                vpn_url: vpnUrl.value.trim(),
                ...(vpnIp.value.trim() ? { vpn_ip: vpnIp.value.trim() } : {}),
                public_url:
                  mode.value === "vpn_preferred" && publicUrl.value.trim()
                    ? publicUrl.value.trim()
                    : null,
              }
            : null,
          ssh: hasSsh.value
            ? {
                vpn_host: vpnHost.value.trim(),
                vpn_port: Number(vpnPort.value),
                public_host:
                  mode.value === "vpn_preferred" && publicHost.value.trim()
                    ? publicHost.value.trim()
                    : null,
                public_port:
                  mode.value === "vpn_preferred" && publicHost.value.trim()
                    ? Number(publicPort.value)
                    : null,
              }
            : null,
        }
      : null;
    const result = await api.request<DeviceNetworkRoute>(path, {
      method: "PUT",
      body: { v: 1, revision: state.value.revision, policy },
    });
    if (disposed) return;
    fill(result);
    message.value =
      isAgent.value && enabled.value
        ? "策略已保存，等待 Agent 确认；确认前新 Agent 终端和任务不会通过旧通道执行。"
        : "网络策略已保存，下次连接时生效。";
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
          <h2 id="route-heading">网络策略 · {{ device.name }}</h2>
          <p class="muted">Agent 与 SSH 共用设备权限和会话录制</p>
        </div>
        <button
          class="icon-button"
          aria-label="关闭网络策略"
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
            <p v-if="isAgent">
              <strong>Agent：</strong
              >{{ state.agent?.connected ? "当前连接" : "离线 / 尚未确认" }} ·
              {{ routeDescription(state.agent) }}<br /><span
                v-if="state.agent?.reason"
                >{{
                  routeReasons[state.agent.reason] ?? state.agent.reason
                }}</span
              >
            </p>
            <p v-if="hasSsh">
              <strong>SSH 最近连接：</strong>{{ routeDescription(state.ssh) }}
            </p>
            <p v-if="state.ssh?.reason">
              {{ routeReasons[state.ssh.reason] ?? state.ssh.reason }}
            </p>
            <p
              v-if="state.policy && isAgent && !state.agent_applied"
              class="text-warning"
            >
              {{
                state.agent_supported === false
                  ? "Agent 不支持网络策略，请先升级至 0.2.5 或更新版本。"
                  : "等待 Agent 持久保存策略并连接指定入口。"
              }}
            </p>
            <p class="muted">
              EasyTier 路径按实际路由采集；未知表示信息不足。SSH
              状态为最近连接的检测结果。
            </p>
          </div>
          <form v-if="admin" @submit.prevent="save">
            <fieldset :disabled="busy">
              <label class="check"
                ><input
                  v-model="enabled"
                  type="checkbox"
                />启用设备网络策略</label
              >
              <p v-if="!enabled" class="muted">
                沿用平台服务端地址及 SSH 接入配置中的地址。
              </p>
              <template v-if="enabled"
                ><label
                  >连接模式<select v-model="mode">
                    <option value="vpn_preferred">VPN 优先、公网备用</option>
                    <option value="private_only">
                      仅内网 / VPN（禁止公网回退）
                    </option>
                  </select></label
                >
                <template v-if="isAgent"
                  ><h3>Agent 到平台</h3>
                  <label
                    >平台内网 HTTPS 地址<input
                      v-model="vpnUrl"
                      required
                      placeholder="https://10.144.144.1:8443"
                      maxlength="2048" /></label
                  ><label
                    >内网/VPN 连接 IP（地址为域名时必填）<input
                      v-model="vpnIp"
                      placeholder="10.144.144.1"
                      maxlength="45" /></label
                  ><label v-if="mode === 'vpn_preferred'"
                    >平台公网备用地址（可选）<input
                      v-model="publicUrl"
                      placeholder="https://farhelm.example.com"
                      maxlength="2048"
                  /></label>
                  <p class="muted">
                    HTTPS 地址可沿用证书域名，指定连接 IP
                    后固定走内网，不使用该域名的公网解析。证书须匹配 HTTPS
                    地址，Agent 须信任 CA。不会自动安装或修改 EasyTier。
                  </p></template
                >
                <template v-if="hasSsh"
                  ><h3>平台到目标 SSH</h3>
                  <div class="route-address">
                    <label
                      >SSH 内网 IP<input
                        v-model="vpnHost"
                        required
                        placeholder="10.144.144.2"
                        maxlength="45" /></label
                    ><label
                      >内网端口<input
                        v-model.number="vpnPort"
                        required
                        type="number"
                        min="1"
                        max="65535"
                    /></label>
                  </div>
                  <div v-if="mode === 'vpn_preferred'" class="route-address">
                    <label
                      >SSH 公网备用地址（可选）<input
                        v-model="publicHost"
                        maxlength="253" /></label
                    ><label
                      >备用端口<input
                        v-model.number="publicPort"
                        type="number"
                        min="1"
                        max="65535"
                    /></label>
                  </div>
                  <p class="muted">
                    两个地址必须对应同一台设备，沿用接入配置的账号、密钥和主机指纹。内网身份校验失败不会尝试公网。
                  </p></template
                >
                <p class="muted">
                  VPN 优先模式会自动重试内网，Agent
                  在连续恢复并空闲后切回。现有终端不迁移
                  Shell；链路故障后可重新连接。仅内网模式失败时保持离线。
                </p></template
              >
              <button class="button primary" type="submit">
                {{ busy ? "保存中…" : "保存网络策略" }}
              </button>
            </fieldset>
          </form>
          <p v-else class="muted">
            仅管理员可修改网络策略。当前模式：{{
              state.policy?.mode === "private_only"
                ? "仅内网 / VPN"
                : state.policy
                  ? "VPN 优先、公网备用"
                  : "沿用原配置"
            }}。
          </p>
        </template>
        <p v-else>正在读取网络策略…</p>
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
