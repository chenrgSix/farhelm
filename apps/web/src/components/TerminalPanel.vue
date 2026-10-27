<script setup lang="ts">
import { onBeforeUnmount, onMounted, ref } from "vue";
import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import "@xterm/xterm/css/xterm.css";
import { api } from "../api/client";
import type { TerminalSession } from "../api/types";
import SessionDuration from "./SessionDuration.vue";

const props = defineProps<{
  deviceId: string;
  deviceName: string;
  recording?: TerminalSession;
  recordingStartSeq?: number;
}>();
const emit = defineEmits<{ close: []; changed: [] }>();
const host = ref<HTMLDivElement>();
const state = ref("正在连接…");
const connected = ref(false);
const sudoAuto = ref(false);
const sudoAllowed = ref<boolean>();
const backend = ref<"agent" | "ssh" | undefined>(props.recording?.backend);
const error = ref("");
const records = ref<
  { seq: number; at: number; kind: string; data: Record<string, any> }[]
>([]);
const speed = ref(2);
const playing = ref(false);
const sudoErrors: Record<string, string> = {
  USER_CONNECTION_LIMIT:
    "该用户的并发连接数已达上限，请关闭其他网页终端或 SSH 连接。",
  DEVICE_TERMINAL_LIMIT: "该设备的终端数已达上限，请关闭其他会话。",
  TERMINAL_SESSION_LIMIT: "平台终端总数已达上限，请稍后重试。",
  TERMINAL_POLICY_NOT_SUPPORTED_UPDATE_AGENT:
    "当前 Agent 无法落实单用户 sudo 限制，请升级 Agent。",
  SSH_PRIVILEGE_POLICY_NOT_SUPPORTED:
    "目标 SSH 环境无法落实 sudo 限制，请联系管理员检查 Linux setpriv 支持。",
  SUDO_NOT_AUTHORIZED: "当前用户未获该设备的 sudo 授权。",
  TARGET_ACCOUNT_DENIED: "默认账号未授权或授权已变更，请联系管理员。",
  SUDO_PERMISSION_REQUIRED: "当前用户未获该设备的 sudo 授权。",
  SUDO_AGENT_REQUIRED:
    "sudo 切换需要在线 Agent；SSH 设备请使用其已配置的登录账号。",
  SUDO_NOT_SUPPORTED_UPDATE_AGENT: "此 Agent 尚不支持密码提权，请升级 Agent。",
  ACCOUNT_CONNECTION_REMOVED: "旧账号连接已移除，请刷新页面后使用普通连接。",
  ROOT_CONNECTION_MODE_REMOVED:
    "以 root 连接已移除，请使用普通连接后执行 sudo。",
  SUDO_PASSWORD_REQUIRED:
    "请保存 sudo 密码；使用免密 sudo 时请升级至 Agent 0.2.9 或更新版本。",
  INVALID_SUDO_PASSWORD:
    "已保存的 sudo 密码含不支持的换行或空字符，请重新配置。",
  SUDO_DISABLED:
    "Agent 尚未允许终端提权，请由管理员在设备接入配置的「默认登录账号 → 终端提权」中开启；旧 Agent 需先升级。",
  SUDO_AUTH_FAILED:
    "sudo 提权失败：请检查已保存的密码、账号的 sudo 权限及 sudo 安装情况。",
  SUDO_AUTH_TIMEOUT: "sudo 认证超时，请检查目标机器的认证配置后重试。",
};
function terminalError(value: string) {
  return (
    Object.entries(sudoErrors).find(([code]) => value.includes(code))?.[1] ??
    value
  );
}
let terminal: Terminal;
let fit: FitAddon;
let socket: WebSocket | undefined;
let observer: ResizeObserver | undefined;
let sessionId = "";
let disposed = false;
let generation = 0;
let pendingBytes = 0;
let playGeneration = 0;
let replayTimer: ReturnType<typeof setTimeout> | undefined;
let releaseDelay: (() => void) | undefined;

function send(type: string, body: unknown) {
  if (!connected.value || socket?.readyState !== WebSocket.OPEN) return;
  if (socket.bufferedAmount > 65536) {
    error.value = "连接繁忙，已断开终端。请检查设备后重新连接";
    socket.close();
    return;
  }
  socket.send(JSON.stringify({ v: 1, type, body }));
}
function input(bytes: Uint8Array) {
  for (let i = 0; i < bytes.length; i += 8192) {
    send("terminal.input", {
      data: btoa(String.fromCharCode(...bytes.subarray(i, i + 8192))),
    });
  }
}
function output(data: string) {
  const bytes = Uint8Array.from(atob(data), (c) => c.charCodeAt(0));
  pendingBytes += bytes.length;
  if (pendingBytes > 262144)
    throw new Error("输出速度过快，已断开终端。已保存的输出可在会话记录中查看");
  terminal.write(bytes, () => {
    pendingBytes -= bytes.length;
  });
}
function stopPlayback() {
  playGeneration++;
  clearTimeout(replayTimer);
  releaseDelay?.();
  releaseDelay = undefined;
  playing.value = false;
}
async function playback() {
  stopPlayback();
  const run = playGeneration;
  terminal.reset();
  terminal.resize(props.recording!.cols, props.recording!.rows);
  playing.value = true;
  let previous = records.value[0]?.at ?? 0;
  for (const event of records.value) {
    if (run !== playGeneration || disposed) return;
    const delay =
      event.seq <= (props.recordingStartSeq ?? 0)
        ? 0
        : Math.min(2000, Math.max(0, event.at - previous) / speed.value);
    previous = event.at;
    if (delay)
      await new Promise<void>((resolve) => {
        releaseDelay = resolve;
        replayTimer = setTimeout(resolve, delay);
      });
    if (run !== playGeneration || disposed) return;
    if (event.kind === "output") {
      await new Promise<void>((resolve) =>
        terminal.write(
          Uint8Array.from(atob(event.data.data), (c) => c.charCodeAt(0)),
          resolve,
        ),
      );
    } else if (event.kind === "resize")
      terminal.resize(event.data.cols, event.data.rows);
  }
  playing.value = false;
}
async function exportRecording() {
  try {
    await api.request(`/terminal-sessions/${props.recording!.id}/export`, {
      method: "POST",
      body: { v: 1 },
    });
    const url = URL.createObjectURL(
      new Blob(
        [
          JSON.stringify(
            { version: 1, session: props.recording, events: records.value },
            null,
            2,
          ),
        ],
        { type: "application/json" },
      ),
    );
    const a = document.createElement("a");
    a.href = url;
    a.download = `terminal-${props.recording!.id}.json`;
    a.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  } catch (e) {
    error.value = e instanceof Error ? e.message : "导出记录失败";
  }
}
async function connect() {
  if (props.recording || disposed) return;
  const run = ++generation;
  socket?.close();
  connected.value = false;
  terminal.options.disableStdin = true;
  terminal.reset();
  error.value = "";
  state.value = "正在连接…";
  sudoAuto.value = false;
  sudoAllowed.value = undefined;
  backend.value = undefined;
  fit.fit();
  try {
    const created = await api.request<{ session_id: string; ticket: string }>(
      "/terminal-sessions",
      {
        method: "POST",
        body: {
          v: 1,
          device_id: props.deviceId,
          cols: Math.max(20, Math.min(500, terminal.cols)),
          rows: Math.max(5, Math.min(200, terminal.rows)),
        },
      },
    );
    if (disposed || run !== generation) {
      void api
        .request(`/terminal-sessions/${created.session_id}/close`, {
          method: "POST",
          body: { v: 1 },
        })
        .catch(() => {});
      return;
    }
    sessionId = created.session_id;
    const url = new URL("/api/v1/terminal/ws", location.href);
    url.protocol = location.protocol === "https:" ? "wss:" : "ws:";
    const ws = new WebSocket(url);
    socket = ws;
    ws.onopen = () =>
      ws.send(
        JSON.stringify({
          v: 1,
          type: "terminal.attach",
          body: { session_id: created.session_id, ticket: created.ticket },
        }),
      );
    ws.onmessage = (event) => {
      if (disposed || run !== generation) return;
      try {
        const message = JSON.parse(event.data);
        if (message.type === "terminal.ready") {
          if (message.body.elevated === true)
            throw new Error("普通连接返回了非预期的提权会话，已断开终端。");
          connected.value = true;
          sudoAuto.value = message.body.sudo_auto === true;
          sudoAllowed.value = message.body.sudo_allowed;
          state.value = "已连接";
          backend.value = ["agent", "ssh"].includes(message.body.backend)
            ? message.body.backend
            : undefined;
          terminal.options.disableStdin = false;
          fit.fit();
          send("terminal.resize", {
            cols: Math.max(20, Math.min(500, terminal.cols)),
            rows: Math.max(5, Math.min(200, terminal.rows)),
          });
          terminal.focus();
          emit("changed");
        } else if (message.type === "terminal.output")
          output(message.body.data);
        else if (message.type === "terminal.closed") {
          state.value = ["SHELL_EXIT", "USER_DISCONNECTED"].includes(
            message.body.reason,
          )
            ? "会话已结束"
            : "连接已断开";
          if (
            !["SHELL_EXIT", "USER_DISCONNECTED"].includes(message.body.reason)
          )
            error.value =
              sudoErrors[message.body.reason] ??
              (
                {
                  SSH_HOST_KEY_MISMATCH:
                    "目标 SSH 主机指纹已变化，连接被拒绝。请由管理员核对主机身份和接入配置。",
                  SSH_AUTH_FAILED:
                    "目标 SSH 认证失败，请由管理员检查接入账号、密码或私钥。",
                  SSH_CONNECT_TIMEOUT:
                    "连接目标 SSH 服务超时，请检查地址、端口和网络。",
                  SSH_CONNECT_FAILED:
                    "连接目标 SSH 服务失败，请检查设备接入配置。",
                  SSH_PTY_FAILED:
                    "目标 SSH 服务未能创建交互终端，请检查目标账号的 Shell 权限。",
                } as Record<string, string>
              )[message.body.reason] ??
              "会话已中断，请核对设备状态后重新连接。已保存的输出可在终端会话中查看";
          connected.value = false;
          terminal.options.disableStdin = true;
        }
      } catch (e) {
        error.value = e instanceof Error ? e.message : "终端数据异常";
        ws.close();
      }
    };
    ws.onerror = () => {
      if (run === generation && !disposed)
        error.value = "无法建立终端连接，请检查服务端与设备状态";
    };
    ws.onclose = () => {
      if (run !== generation || disposed) return;
      if (connected.value || state.value === "正在连接…")
        state.value = "连接已断开";
      connected.value = false;
      terminal.options.disableStdin = true;
      emit("changed");
    };
  } catch (e) {
    if (disposed || run !== generation) return;
    error.value = terminalError(e instanceof Error ? e.message : "连接失败");
    state.value = "连接失败";
  }
}
function close() {
  send("terminal.close", {});
  socket?.close();
  emit("close");
}
onMounted(async () => {
  terminal = new Terminal({
    cursorBlink: true,
    disableStdin: true,
    fontSize: 14,
    fontFamily: '"SFMono-Regular", Consolas, "Liberation Mono", monospace',
    scrollback: 5000,
    allowProposedApi: false,
    theme: {
      background: "#111923",
      foreground: "#e4eaf1",
      cursor: "#74e0bc",
      selectionBackground: "#3b506a",
    },
  });
  fit = new FitAddon();
  terminal.loadAddon(fit);
  terminal.open(host.value!);
  fit.fit();
  terminal.parser.registerOscHandler(52, () => true);
  terminal.onData((text) => input(new TextEncoder().encode(text)));
  terminal.onBinary((text) =>
    input(Uint8Array.from(text, (c) => c.charCodeAt(0))),
  );
  terminal.onResize(({ cols, rows }) => {
    if (cols >= 20 && cols <= 500 && rows >= 5 && rows <= 200)
      send("terminal.resize", { cols, rows });
  });
  observer = new ResizeObserver(() => {
    if (!props.recording) fit.fit();
  });
  observer.observe(host.value!);
  if (!props.recording) {
    await connect();
    return;
  }
  state.value = props.recordingStartSeq
    ? "会话记录 · 已定位到命令"
    : "会话记录";
  try {
    let after = 0;
    while (!disposed) {
      const response = await api.request<{
        events: typeof records.value;
        next: number;
      }>(`/terminal-sessions/${props.recording.id}/recording?after=${after}`);
      if (disposed) return;
      records.value.push(
        ...response.events.filter(
          (event) =>
            props.recording!.last_seq === undefined ||
            event.seq <= props.recording!.last_seq,
        ),
      );
      if (
        !response.events.length ||
        response.next === after ||
        (props.recording.last_seq !== undefined &&
          response.next >= props.recording.last_seq)
      )
        break;
      after = response.next;
    }
    if (!disposed) await playback();
  } catch (e) {
    if (!disposed)
      error.value = e instanceof Error ? e.message : "读取记录失败";
  }
});
onBeforeUnmount(() => {
  disposed = true;
  generation++;
  stopPlayback();
  observer?.disconnect();
  socket?.close();
  terminal?.dispose();
  if (sessionId)
    void api
      .request(`/terminal-sessions/${sessionId}/close`, {
        method: "POST",
        body: { v: 1 },
      })
      .catch(() => {});
});
</script>
<template>
  <div class="terminal-overlay">
    <section
      class="terminal-window"
      role="dialog"
      aria-modal="true"
      :aria-label="`${recording ? '会话记录' : '终端'}：${deviceName}`"
    >
      <header class="terminal-heading">
        <div>
          <span class="terminal-lights" aria-hidden="true">● ● ●</span
          ><strong>{{ deviceName }}</strong
          ><span class="terminal-state" :class="{ connected }">{{ state }}</span
          ><span v-if="backend" class="terminal-state">{{
            backend === "ssh" ? "SSH 通道" : "Agent 通道"
          }}</span>
          <span v-if="connected && sudoAllowed === false" class="terminal-state"
            >sudo 已限制</span
          >
          <span v-if="connected && sudoAuto" class="terminal-state"
            >sudo 自动代填已启用</span
          >
        </div>
        <div class="terminal-actions">
          <template v-if="recording">
            <select v-model.number="speed" aria-label="回放速度">
              <option :value="1">1×</option>
              <option :value="2">2×</option>
              <option :value="8">8×</option>
            </select>
            <button
              class="button secondary small"
              :disabled="!records.length"
              @click="playing ? stopPlayback() : playback()"
            >
              {{ playing ? "停止回放" : "重新回放" }}
            </button>
            <button
              class="button secondary small"
              :disabled="!records.length"
              @click="exportRecording"
            >
              导出记录
            </button>
          </template>
          <button
            v-else-if="!connected && state !== '正在连接…'"
            class="button secondary small"
            @click="connect"
          >
            重新连接
          </button>
          <button
            class="button secondary small"
            aria-label="关闭终端"
            @click="close"
          >
            {{ connected ? "断开并关闭" : "关闭" }}
          </button>
        </div>
      </header>
      <div v-if="error" class="terminal-error" role="alert">{{ error }}</div>
      <div
        ref="host"
        class="terminal-screen"
        :class="{ 'terminal-recording': !!recording }"
        aria-label="终端输入与输出"
      ></div>
      <footer class="terminal-footer">
        <span v-if="!recording">Ctrl-C 中断 · Tab 补全 · 输入 exit 退出</span>
        <span v-else>按录制顺序回放，长时间停顿压缩至 2 秒</span>
        <span v-if="recording"
          >录制时长 <SessionDuration :session="recording"
        /></span>
        <span>{{
          recording
            ? recording.audit_complete
              ? "会话记录完整"
              : "录制可能不完整，仅展示已保存部分"
            : "会话输出自动记录"
        }}</span>
      </footer>
    </section>
  </div>
</template>
<style scoped>
.terminal-overlay {
  position: fixed;
  inset: 0;
  z-index: 100;
  background: #12202b80;
  display: flex;
  align-items: center;
  justify-content: center;
  padding: 32px;
}
.terminal-window {
  width: min(1280px, 100%);
  height: min(820px, 88vh);
  min-width: 0;
  display: flex;
  flex-direction: column;
  border: 1px solid #334554;
  border-radius: 12px;
  background: #111923;
  box-shadow: 0 24px 80px #0006;
  overflow: hidden;
}
.terminal-heading {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 16px;
  padding: 16px 20px;
  color: #e4eaf1;
  background: #1b2734;
}
.terminal-heading > div,
.terminal-actions {
  display: flex;
  align-items: center;
  gap: 12px;
}
.terminal-lights {
  color: #6b8b92;
  letter-spacing: 3px;
  font-size: 11px;
}
.terminal-state {
  font-size: 12px;
  color: #a8b6c4;
}
.terminal-state.connected {
  color: #74e0bc;
}
.terminal-screen {
  flex: 1;
  min-height: 0;
  min-width: 0;
  /* FitAddon measures this box; keep spacing outside its available dimensions. */
  margin: 16px;
  overflow: hidden;
}
.terminal-screen :deep(.xterm) {
  height: 100%;
}
.terminal-recording {
  overflow: auto;
}
.terminal-footer {
  display: flex;
  justify-content: space-between;
  gap: 12px;
  padding: 12px 20px;
  border-top: 1px solid #293848;
  color: #9baabb;
  font-size: 12px;
}
.terminal-error {
  padding: 12px 20px;
  color: #ffb2a5;
  background: #4a272b;
  font-size: 13px;
}
.terminal-actions select {
  width: 80px;
  padding-block: 4px;
  padding-left: 8px;
  color: #111923;
}
@media (max-width: 700px) {
  .terminal-overlay {
    padding: 8px;
  }
  .terminal-window {
    height: 95dvh;
  }
  .terminal-heading {
    align-items: flex-start;
    flex-direction: column;
    padding: 12px;
  }
  .terminal-heading > div {
    flex-wrap: wrap;
  }
  .terminal-lights {
    display: none;
  }
  .terminal-screen {
    margin: 8px;
  }
  .terminal-footer {
    flex-direction: column;
    padding: 10px 12px;
  }
}
</style>
