<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref } from "vue";
import { api } from "../api/client";
import type { Device, User } from "../api/types";
const props = defineProps<{ device: Device; user: User }>();
const emit = defineEmits<{ close: [] }>();
const gateway = ref<{
  enabled: boolean;
  host: string | null;
  port: number | null;
  fingerprint: string | null;
} | null>(null);
const error = ref("");
const copied = ref(false);
let disposed = false;
onBeforeUnmount(() => {
  disposed = true;
});
onMounted(async () => {
  try {
    const result = await api.request<NonNullable<typeof gateway.value>>("/ssh");
    if (!disposed) gateway.value = result;
  } catch (e) {
    if (!disposed)
      error.value = e instanceof Error ? e.message : "读取 SSH 入口失败";
  }
});
const quote = (value: string) => "'" + value.replaceAll("'", "'\\''") + "'";
const command = computed(() =>
  gateway.value?.enabled
    ? `ssh -tt -p ${gateway.value.port} -l ${quote(props.user.username + ":" + props.device.id)} -- ${quote(gateway.value.host ?? location.hostname.replace(/^\[|\]$/g, ""))}`
    : "",
);
async function copy() {
  try {
    await navigator.clipboard.writeText(command.value);
    copied.value = true;
  } catch {
    error.value = "无法访问剪贴板，请选中命令手动复制";
  }
}
</script>

<template>
  <div class="ssh-overlay" @keydown.esc="emit('close')">
    <section
      class="panel ssh-panel"
      role="dialog"
      aria-modal="true"
      aria-labelledby="ssh-heading"
    >
      <div class="panel-heading">
        <div>
          <h2 id="ssh-heading">SSH 连接 · {{ device.name }}</h2>
          <p class="muted">通过平台入口连接这台设备</p>
        </div>
        <button
          class="icon-button"
          aria-label="关闭 SSH 连接说明"
          @click="emit('close')"
        >
          ×
        </button>
      </div>
      <div class="ssh-content">
        <p v-if="error" class="text-warning" role="alert">{{ error }}</p>
        <p v-if="!gateway && !error">正在读取连接信息…</p>
        <p v-else-if="gateway && !gateway.enabled">
          SSH 入口尚未启用，请联系平台管理员开启。
        </p>
        <template v-else-if="gateway?.enabled">
          <p>在本地终端执行下方命令，密码使用当前平台账号的登录密码。</p>
          <pre class="ssh-command" tabindex="0">{{ command }}</pre>
          <button class="button primary" @click="copy">
            {{ copied ? "已复制" : "复制连接命令" }}
          </button>
          <p class="muted">客户端用户名：{{ user.username }}:{{ device.id }}</p>
          <p>首次连接时，请核对平台主机指纹：</p>
          <code class="ssh-fingerprint">{{ gateway.fingerprint }}</code>
          <p
            v-if="device.connection_kind !== 'ssh' && !device.control_online"
            class="text-warning"
          >
            设备当前离线，Agent 恢复连接后才能进入终端。
          </p>
          <p class="muted">
            支持交互式 Shell、Ctrl-C 和窗口缩放，使用{{
              device.connection_kind === "ssh"
                ? "管理员配置的目标 SSH 账号"
                : "设备上 Agent 的系统账号"
            }}。操作录制和时长可在「终端会话」查看。
          </p>
          <p class="muted">
            当前仅支持密码登录的交互终端；SFTP、SCP、远程命令模式和端口转发尚未开放。
          </p>
        </template>
      </div>
    </section>
  </div>
</template>
<style scoped>
.ssh-overlay {
  position: fixed;
  inset: 0;
  z-index: 80;
  background: #10202c80;
  display: grid;
  place-items: center;
  padding: 20px;
}
.ssh-panel {
  width: min(720px, 100%);
  max-height: calc(100dvh - 40px);
  overflow: auto;
}
.ssh-panel .panel-heading {
  padding: 20px 24px 16px;
  align-items: flex-start;
}
.ssh-content {
  padding: 0 24px 24px;
  display: grid;
  gap: 16px;
}
.ssh-content p {
  margin: 0;
  overflow-wrap: anywhere;
}
.ssh-command {
  white-space: pre-wrap;
  overflow-wrap: anywhere;
  background: #121b25;
  color: #eef3f8;
  border-radius: 8px;
  padding: 16px;
  margin: 0;
}
.ssh-fingerprint {
  overflow-wrap: anywhere;
}
.ssh-content .button {
  justify-self: start;
}
@media (max-width: 600px) {
  .ssh-overlay {
    padding: 10px;
  }
  .ssh-panel .panel-heading {
    padding: 16px;
  }
  .ssh-content {
    padding: 0 16px 16px;
  }
}
</style>
