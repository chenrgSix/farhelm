<script setup lang="ts">
import { onMounted, onBeforeUnmount, ref } from "vue";
import { api } from "../api/client";
import type {
  PlatformNetworkResponse,
  PlatformNetworkSettings,
} from "../api/types";
const emit = defineEmits<{ saved: [] }>();
const state = ref<PlatformNetworkResponse | null>(null),
  busy = ref(false),
  error = ref(""),
  message = ref("");
const enabled = ref(false),
  mode = ref<PlatformNetworkSettings["mode"]>("vpn_preferred"),
  vpnUrl = ref(""),
  vpnIp = ref(""),
  publicUrl = ref("");
let disposed = false,
  timer: ReturnType<typeof setTimeout> | undefined;
function fill(s: PlatformNetworkResponse) {
  state.value = s;
  enabled.value = s.settings.enabled;
  mode.value = s.settings.mode;
  const a = s.settings.agent ?? s.suggested_agent;
  vpnUrl.value = a?.vpn_url ?? s.platform_server_url;
  vpnIp.value = a?.vpn_ip ?? "";
  publicUrl.value = a?.public_url ?? s.platform_server_url;
}
function report(e: unknown) {
  const text = e instanceof Error ? e.message : String(e);
  const errors: Record<string, string> = {
    NETWORK_ROUTE_BUSY:
      "还有活跃终端或正在执行的任务，请结束后再修改统一网络策略。",
    NETWORK_ROUTE_CHANGED_RELOAD: "设置已被其他管理员修改，请重新加载后编辑。",
    VPN_LITERAL_PRIVATE_IP_REQUIRED:
      "平台内网入口需固定到私有 IP；HTTPS 地址使用域名时，请填写平台内网 / VPN IP。",
    VPN_IP_HOST_MISMATCH: "HTTPS 地址已使用 IP 时，连接 IP 须与其一致。",
    INVALID_NETWORK_URL:
      "请填写有效的 HTTPS 平台地址，不能包含路径、账号或查询参数。",
    DUPLICATE_NETWORK_ENDPOINT:
      "内网与公网入口相同时，须通过域名和指定的内网 IP 区分连接路径。",
    AGENT_NETWORK_ENDPOINT_REQUIRED:
      "请填写供 Agent 连接的平台内网 HTTPS 入口。",
  };
  error.value =
    Object.entries(errors).find(([code]) => text.includes(code))?.[1] ?? text;
}
async function load() {
  if (busy.value) return;
  busy.value = true;
  error.value = "";
  message.value = "";
  try {
    const s = await api.request<PlatformNetworkResponse>("/settings/network");
    if (!disposed) fill(s);
  } catch (e) {
    if (!disposed) report(e);
  } finally {
    busy.value = false;
  }
}
async function refresh() {
  try {
    const s = await api.request<PlatformNetworkResponse>("/settings/network");
    if (!disposed && !busy.value && state.value) {
      if (s.revision !== state.value.revision)
        error.value = "设置已被修改，请重新加载后编辑。";
      else state.value = s;
    }
  } catch {
  } finally {
    if (!disposed) timer = setTimeout(refresh, 5000);
  }
}
onMounted(async () => {
  await load();
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
    let agent = state.value.agent_enabled
      ? enabled.value
        ? {
            vpn_url: vpnUrl.value.trim(),
            ...(vpnIp.value.trim() ? { vpn_ip: vpnIp.value.trim() } : {}),
            public_url:
              mode.value === "vpn_preferred"
                ? publicUrl.value.trim() || null
                : null,
          }
        : state.value.settings.agent
      : null;
    if (agent && mode.value === "private_only")
      agent = { ...agent, public_url: null };
    const s = await api.request<PlatformNetworkResponse>("/settings/network", {
      method: "PUT",
      body: {
        v: 1,
        revision: state.value.revision,
        settings: { enabled: enabled.value, mode: mode.value, agent },
      },
    });
    if (disposed) return;
    fill(s);
    message.value =
      "已保存统一网络策略，现有和新增设备自动继承；在线 Agent 已通知，离线 Agent 重连后同步。";
    emit("saved");
  } catch (e) {
    if (!disposed) report(e);
  } finally {
    busy.value = false;
  }
}
</script>
<template>
  <section
    class="panel network-settings"
    aria-labelledby="network-settings-title"
  >
    <header class="panel-heading">
      <div>
        <h2 id="network-settings-title">平台网络策略</h2>
        <p class="muted">统一配置 VPN 优先或仅内网，所有设备自动继承</p>
      </div>
    </header>
    <form @submit.prevent="save">
      <p v-if="error" role="alert" class="notice danger">{{ error }}</p>
      <p v-if="message" role="status">{{ message }}</p>
      <fieldset v-if="state" :disabled="busy">
        <p v-if="state.legacy_devices" class="notice">
          检测到
          {{ state.legacy_devices }}
          台设备使用旧版单独策略。首次保存后由平台统一接管，已填的设备内网 IP
          会保留。
        </p>
        <label class="check"
          ><input v-model="enabled" type="checkbox" />启用统一网络策略</label
        >
        <p v-if="!enabled" class="muted">
          {{
            state.legacy_devices
              ? "尚未统一接管，旧配置继续生效。"
              : "设备沿用原接入地址。启用后只需在这里配置一次。"
          }}
        </p>
        <template v-if="enabled">
          <label
            >平台连接模式<select v-model="mode">
              <option value="vpn_preferred">VPN 优先、公网备用</option>
              <option value="private_only">仅内网 / VPN（禁止公网回退）</option>
            </select></label
          >
          <template v-if="state.agent_enabled">
            <h3>Agent 连接平台</h3>
            <label
              >平台内网 HTTPS 地址<input
                v-model="vpnUrl"
                required
                maxlength="2048"
                placeholder="https://farhelm.example.com"
            /></label>
            <label
              >平台内网 / VPN IP（地址为域名时必填）<input
                v-model="vpnIp"
                maxlength="45"
                placeholder="10.144.144.1"
            /></label>
            <label v-if="mode === 'vpn_preferred'"
              >平台公网备用地址（可选）<input
                v-model="publicUrl"
                maxlength="2048"
                placeholder="https://farhelm.example.com"
            /></label>
            <p class="muted">
              这里填写平台的入口，所有 Agent 共用。使用域名配合固定 VPN IP
              时沿用该域名的证书，Agent 仍会校验 HTTPS 身份。
            </p>
          </template>
          <p v-else class="muted">
            当前仅使用 SSH 接入设备，无需填写 Agent 平台地址或配置 HTTPS 证书。
          </p>
          <h3>SSH 连接设备</h3>
          <p class="muted">
            设备页只填目标机器的内网 / VPN
            IP；端口、账号、密钥和备用地址沿用该设备的 SSH 接入配置。
          </p>
          <p class="muted">
            {{
              mode === "private_only"
                ? "未配置内网地址或内网不可达时，不会尝试公网。"
                : "未填写设备内网 IP 时，使用 SSH 接入地址并显示原因；填写后优先内网，失败才尝试备用地址。"
            }}
          </p>
          <p class="muted">
            EasyTier 需先完成组网。内网恢复后，Agent
            等待终端和任务结束再切回，权限控制与会话录制继续生效。
          </p>
        </template>
        <p v-if="state.settings.enabled" class="muted">
          覆盖 {{ state.device_count }} 台设备；{{ state.pending_agents }} 台
          Agent 等待确认。
        </p>
      </fieldset>
      <p v-else>正在读取平台网络设置…</p>
      <div class="settings-actions">
        <button class="button primary" type="submit" :disabled="busy || !state">
          {{ busy ? "保存中…" : "保存平台网络策略" }}</button
        ><button
          class="button secondary"
          type="button"
          :disabled="busy"
          @click="load"
        >
          重新加载网络设置
        </button>
      </div>
    </form>
  </section>
</template>
<style scoped>
form {
  margin: 0;
  display: grid;
  gap: 16px;
}
fieldset {
  border: 0;
  margin: 0;
  padding: 0;
  display: grid;
  gap: 14px;
  min-width: 0;
}
label {
  display: grid;
  gap: 6px;
  font-size: 13px;
}
.check {
  display: flex;
  align-items: center;
}
.check input {
  width: auto;
}
input,
select {
  width: 100%;
  box-sizing: border-box;
  margin: 0;
}
h3,
p {
  margin: 0;
}
h3 {
  font-size: 15px;
  margin-top: 8px;
}
p {
  font-size: 13px;
  overflow-wrap: anywhere;
}
.settings-actions {
  display: flex;
  gap: 12px;
  flex-wrap: wrap;
}
.network-settings {
  padding: 24px;
  margin-top: 20px;
}
.panel-heading p {
  margin-top: 7px;
}
</style>
