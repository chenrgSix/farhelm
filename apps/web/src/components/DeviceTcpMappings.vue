<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref } from "vue";
import { api, ApiError } from "../api/client";
const props = defineProps<{ deviceId: string }>();
const emit = defineEmits<{ changed: [] }>();
type Config = {
  name: string;
  enabled: boolean;
  listen_host: string;
  listen_port: number;
  target_host: string;
  target_port: number;
  source_cidrs: string[];
};
type Mapping = Config & {
  id: string;
  revision: number;
  status: "disabled" | "listening" | "error";
  error: string | null;
  connections: number;
};
const mappings = ref<Mapping[]>([]),
  draft = ref<Config>(),
  editing = ref<{ id: string; revision: number }>(),
  sources = ref("");
const busy = ref(false),
  loaded = ref(false),
  conflict = ref(false),
  error = ref(""),
  notice = ref("");
let disposed = false;
const path = `/devices/${encodeURIComponent(props.deviceId)}/tcp-mappings`;
const messages: Record<string, string> = {
  MAPPING_PORT_IN_USE:
    "监听端口已被占用，请使用其他端口；修改同一端口的绑定地址时，请先停用原映射。",
  MAPPING_BIND_UNAVAILABLE:
    "此监听 IP 不属于平台所在主机或容器，请填写平台实际可绑定的 IP。",
  MAPPING_LISTEN_FAILED: "无法监听此地址或端口，请检查平台运行权限。",
  MAPPING_LISTENER_FAILED: "监听异常，请保存映射重试。",
  MAPPING_NOT_LISTENING: "当前未监听，可编辑并保存重试。",
  MAPPING_SOURCE_REQUIRED: "至少填写一个允许访问的来源 IP 或 CIDR。",
  INVALID_SOURCE_CIDR: "来源地址须为 IPv4、IPv6 或 CIDR 网段。",
  MAPPING_BIND_IP_REQUIRED: "监听地址须为平台可绑定的 IPv4 或 IPv6 地址。",
  INVALID_FORWARD_HOST: "请填写有效的目标 IP 或域名。",
  MAPPING_LIMIT: "映射数量已达上限（每设备 16 条，全平台 128 条）。",
  MAPPING_OWNER_DISABLED: "创建账号曾被停用。恢复账号权限后，请重新保存映射。",
  MAPPING_OWNER_DENIED:
    "创建账号权限曾失效。恢复管理员权限并完成密码修改后，请重新保存映射。",
  DEVICE_FORWARDING_DISABLED: "请确认「TCP 转发」已开启，再编辑并保存此映射。",
  DEVICE_REVOKED: "设备已撤销，映射已停止。",
};
const statusLabel = {
  disabled: "已停用",
  listening: "正在监听",
  error: "未监听",
};
const address = (host: string, port: number) =>
  `${host.includes(":") ? `[${host}]` : host}:${port}`;
const valid = computed(
  () =>
    !!draft.value?.name.trim() &&
    !!draft.value.listen_host.trim() &&
    !!draft.value.target_host.trim() &&
    sources.value.trim().length > 0 &&
    Number.isInteger(draft.value.listen_port) &&
    draft.value.listen_port >= 1024 &&
    draft.value.listen_port <= 65535 &&
    Number.isInteger(draft.value.target_port) &&
    draft.value.target_port >= 1 &&
    draft.value.target_port <= 65535,
);
async function fetchList() {
  const result = await api.request<{ v: 1; mappings: Mapping[] }>(path);
  if (!disposed) {
    mappings.value = result.mappings;
    loaded.value = true;
  }
}
function failure(e: unknown, mutation = false) {
  const text = e instanceof Error ? e.message : "操作失败";
  if (
    mutation &&
    (text.includes("MAPPING_CHANGED_RELOAD") ||
      (e instanceof ApiError && e.status === 0))
  ) {
    conflict.value = true;
    error.value =
      "配置已变更或保存结果尚未确认，请重新加载后核对，避免重复创建或覆盖配置。";
  } else {
    const key = Object.keys(messages).find((code) => text.includes(code));
    error.value = key ? messages[key]! : text;
  }
}
async function load() {
  if (busy.value) return;
  busy.value = true;
  error.value = notice.value = "";
  try {
    await fetchList();
    if (!disposed) {
      draft.value = undefined;
      editing.value = undefined;
      conflict.value = false;
    }
  } catch (e) {
    if (!disposed) failure(e);
  } finally {
    if (!disposed) busy.value = false;
  }
}
function edit(mapping?: Mapping) {
  if (busy.value || conflict.value) return;
  error.value = notice.value = "";
  editing.value = mapping
    ? { id: mapping.id, revision: mapping.revision }
    : undefined;
  draft.value = mapping
    ? {
        name: mapping.name,
        enabled: mapping.enabled,
        listen_host: mapping.listen_host,
        listen_port: mapping.listen_port,
        target_host: mapping.target_host,
        target_port: mapping.target_port,
        source_cidrs: [...mapping.source_cidrs],
      }
    : {
        name: "",
        enabled: false,
        listen_host: "127.0.0.1",
        listen_port: 11433,
        target_host: "",
        target_port: 1433,
        source_cidrs: [],
      };
  sources.value = draft.value.source_cidrs.join("\n");
}
async function save() {
  if (busy.value || conflict.value || !draft.value || !valid.value) return;
  busy.value = true;
  error.value = notice.value = "";
  try {
    const body = {
      v: 1,
      ...draft.value,
      name: draft.value.name.trim(),
      listen_host: draft.value.listen_host.trim(),
      target_host: draft.value.target_host.trim(),
      source_cidrs: sources.value.trim().split(/[\s,，]+/),
      ...(editing.value ? { revision: editing.value.revision } : {}),
    };
    await api.request(path + (editing.value ? `/${editing.value.id}` : ""), {
      method: editing.value ? "PUT" : "POST",
      body,
    });
    if (disposed) return;
    draft.value = undefined;
    editing.value = undefined;
    notice.value = "映射已保存。";
    emit("changed");
    await fetchList();
  } catch (e) {
    if (!disposed) failure(e, true);
  } finally {
    if (!disposed) busy.value = false;
  }
}
async function remove(mapping: Mapping) {
  if (busy.value || conflict.value) return;
  busy.value = true;
  error.value = notice.value = "";
  try {
    await api.request(`${path}/${mapping.id}`, {
      method: "DELETE",
      body: { v: 1, revision: mapping.revision },
    });
    if (disposed) return;
    if (editing.value?.id === mapping.id) {
      draft.value = undefined;
      editing.value = undefined;
    }
    notice.value = "映射已删除，相关连接已断开。";
    emit("changed");
    await fetchList();
  } catch (e) {
    if (!disposed) failure(e, true);
  } finally {
    if (!disposed) busy.value = false;
  }
}
onMounted(load);
onBeforeUnmount(() => {
  disposed = true;
});
</script>
<template>
  <section class="tcp-mappings" aria-label="设备端口映射">
    <h3>端口映射</h3>
    <p class="field-hint">
      在平台开放 TCP 端口，经本设备连接目标服务。客户端直接连接映射入口，无需
      SSH 登录；来源白名单决定哪些客户端可以接入，目标服务仍使用自己的账号认证。
    </p>
    <p class="field-hint">
      仅管理员配置，创建账号须保持启用和管理员权限。设备须先允许 TCP
      转发。修改、停用或删除映射会断开其已有连接。
    </p>
    <p v-if="error" role="alert" class="text-warning">{{ error }}</p>
    <p v-if="notice" role="status">{{ notice }}</p>
    <div class="mapping-actions">
      <button
        type="button"
        class="button primary"
        :disabled="busy || conflict || !loaded"
        @click="edit()"
      >
        新增映射
      </button>
      <button
        type="button"
        class="button secondary"
        :disabled="busy"
        @click="load"
      >
        重新加载映射
      </button>
    </div>
    <p v-if="!loaded && busy">正在读取映射…</p>
    <p v-else-if="loaded && !mappings.length" class="field-hint">
      尚未配置端口映射。
    </p>
    <article v-for="mapping in mappings" :key="mapping.id" class="mapping-card">
      <div class="mapping-title">
        <strong>{{ mapping.name }}</strong
        ><span
          >{{ statusLabel[mapping.status] }} ·
          {{ mapping.connections }} 个连接</span
        >
      </div>
      <p class="mapping-address">
        {{ address(mapping.listen_host, mapping.listen_port) }} →
        {{ address(mapping.target_host, mapping.target_port) }}
      </p>
      <p class="field-hint">允许来源：{{ mapping.source_cidrs.join("、") }}</p>
      <p v-if="mapping.error" class="text-warning">
        {{ messages[mapping.error] ?? mapping.error }}
      </p>
      <div class="mapping-actions">
        <button
          type="button"
          class="button secondary"
          :disabled="busy || conflict"
          @click="edit(mapping)"
        >
          编辑映射</button
        ><button
          type="button"
          class="button secondary"
          :disabled="busy || conflict"
          @click="remove(mapping)"
        >
          删除映射并断开
        </button>
      </div>
    </article>
    <form v-if="draft" @submit.prevent="save" class="mapping-form">
      <h4>{{ editing ? "编辑映射" : "新增映射" }}</h4>
      <fieldset :disabled="busy || conflict">
        <label
          >名称<input
            v-model="draft.name"
            aria-label="映射名称"
            maxlength="80"
            required
        /></label>
        <div class="mapping-grid">
          <label
            >平台监听 IP<input
              v-model="draft.listen_host"
              aria-label="平台监听 IP"
              placeholder="192.168.1.5"
              required
          /></label>
          <label
            >平台监听端口<input
              v-model.number="draft.listen_port"
              aria-label="平台监听端口"
              type="number"
              min="1024"
              max="65535"
              required
          /></label>
          <label
            >目标 IP 或域名<input
              v-model="draft.target_host"
              aria-label="目标 IP 或域名"
              placeholder="192.168.0.4"
              required
          /></label>
          <label
            >目标端口<input
              v-model.number="draft.target_port"
              aria-label="目标端口"
              type="number"
              min="1"
              max="65535"
              required
          /></label>
        </div>
        <p class="field-hint">
          目标由选中的设备访问。127.0.0.1
          监听仅供平台本机使用；供其他电脑连接时填写平台内网 IP，或用 0.0.0.0
          监听所有 IPv4 网卡。客户端使用平台实际 IP 和此监听端口。
        </p>
        <label
          >允许的来源 IP / CIDR<textarea
            v-model="sources"
            aria-label="允许的来源 IP / CIDR"
            rows="3"
            placeholder="192.168.1.20&#10;192.168.1.0/24"
            required
          />
        </label>
        <p class="field-hint">
          必填，每行一个，最多 64 项；支持 IPv4 和 IPv6。按平台实际看到的客户端
          IP 检查，经过 NAT 时可能是共享出口地址。
        </p>
        <label class="mapping-enable"
          ><input
            v-model="draft.enabled"
            aria-label="启用映射"
            type="checkbox"
          />启用映射</label
        >
      </fieldset>
      <p class="field-hint">
        容器部署还需发布对应 TCP
        端口，主机防火墙需允许访问；网页不会自动修改容器端口或防火墙。远程客户端需要加密时，请启用目标服务的
        TLS。
      </p>
      <div class="mapping-actions">
        <button
          type="submit"
          class="button primary"
          :disabled="busy || conflict || !valid"
        >
          {{ busy ? "保存中…" : "保存映射" }}</button
        ><button
          type="button"
          class="button secondary"
          :disabled="busy"
          @click="draft = undefined"
        >
          取消编辑
        </button>
      </div>
    </form>
  </section>
</template>
<style scoped>
.tcp-mappings h3,
.tcp-mappings h4 {
  margin: 0 0 12px;
}
.mapping-actions,
.mapping-title {
  display: flex;
  gap: 12px;
  flex-wrap: wrap;
  align-items: center;
}
.mapping-title {
  justify-content: space-between;
}
.mapping-actions {
  margin: 12px 0;
}
.mapping-card,
.mapping-form {
  border: 1px solid #d8e2e7;
  border-radius: 8px;
  padding: 16px;
  margin-top: 16px;
}
.mapping-address {
  font-family: monospace;
  overflow-wrap: anywhere;
}
.mapping-form fieldset {
  border: 0;
  padding: 0;
  margin: 0;
  min-width: 0;
  display: grid;
  gap: 12px;
}
.mapping-form label {
  display: grid;
  gap: 6px;
  min-width: 0;
}
.mapping-form input,
.mapping-form textarea {
  width: 100%;
  box-sizing: border-box;
}
.mapping-grid {
  display: grid;
  grid-template-columns: minmax(0, 1fr) 130px;
  gap: 12px;
}
.mapping-form .mapping-enable {
  display: flex;
  gap: 8px;
  align-items: center;
}
.mapping-enable input {
  width: auto;
}
@media (max-width: 600px) {
  .mapping-grid {
    grid-template-columns: minmax(0, 1fr);
  }
}
</style>
