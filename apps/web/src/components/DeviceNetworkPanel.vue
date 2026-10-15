<script setup lang="ts">
import { onBeforeUnmount, onMounted, ref } from "vue";
import { api } from "../api/client";
import type { Device, NetworkResponse } from "../api/types";
import { formatTime } from "../model";
const props = defineProps<{ device: Device }>();
const emit = defineEmits<{ close: [] }>();
const data = ref<NetworkResponse | null>(null);
const before = ref<number | null>(null);
const pages = ref<(number | null)[]>([]);
const error = ref("");
const busy = ref(false);
let disposed = false;
let timer: ReturnType<typeof setInterval> | undefined;
const reasons = {
  connection_lost: "与平台断连",
  connection_failed: "连接平台失败",
  agent_restart: "Agent 进程中断",
};
function duration(start: number, end: number) {
  const secs = Math.floor(Math.max(0, end - start) / 1000);
  return secs < 60
    ? `${secs} 秒`
    : secs < 3600
      ? `${Math.floor(secs / 60)} 分 ${secs % 60} 秒`
      : `${Math.floor(secs / 3600)} 时 ${Math.floor((secs % 3600) / 60)} 分`;
}
async function load(
  cursor = before.value,
  move: "next" | "back" | null = null,
) {
  if (busy.value) return;
  busy.value = true;
  try {
    const result = await api.request<NetworkResponse>(
      `/devices/${encodeURIComponent(props.device.id)}/network${cursor ? `?before=${cursor}` : ""}`,
    );
    if (disposed) return;
    if (move === "next") pages.value.push(before.value);
    if (move === "back") pages.value.pop();
    before.value = cursor;
    data.value = result;
    error.value = "";
  } catch (e) {
    if (!disposed)
      error.value = e instanceof Error ? e.message : "网络记录读取失败";
  } finally {
    busy.value = false;
  }
}
onMounted(async () => {
  await load();
  if (!disposed)
    timer = setInterval(() => {
      if (!document.hidden) void load();
    }, 5000);
});
onBeforeUnmount(() => {
  disposed = true;
  clearInterval(timer);
});
</script>
<template>
  <div class="network-overlay">
    <section
      class="panel network-panel"
      role="dialog"
      aria-modal="true"
      :aria-label="`网络记录：${device.name}`"
    >
      <header class="panel-heading">
        <div>
          <h2>网络记录 · {{ device.name }}</h2>
          <p class="field-hint">本机网卡地址与 Agent 观察到的连接中断</p>
        </div>
        <button
          class="icon-button"
          aria-label="关闭网络记录"
          @click="emit('close')"
        >
          ×
        </button>
      </header>
      <div class="network-content">
        <p v-if="error" class="error-banner" role="alert">
          {{ error }}（展示的数据可能已过期）
        </p>
        <p v-if="!data" class="muted">{{ busy ? "正在读取…" : "暂无数据" }}</p>
        <template v-else>
          <p v-if="!data.device_online" class="network-notice">
            当前平台连接离线。最后心跳：{{
              formatTime(data.last_seen)
            }}。断线详情将在 Agent 恢复连接后补传。
          </p>
          <p v-if="!data.supported" class="network-notice">
            {{
              data.device_online
                ? "当前 Agent 尚不支持网络记录，请升级至 0.2.2 或更新版本。"
                : "尚未收到网络上报；支持此功能的 Agent 上线后自动采集。"
            }}
          </p>
          <h3>本机 IP</h3>
          <p class="field-hint">
            采集时间：{{ formatTime(data.snapshot?.observed_at ?? null) }} · 每
            30 秒更新；不含回环地址。离线时显示最后上报的地址。
          </p>
          <p v-if="data.snapshot?.truncated" class="network-notice">
            网卡地址超过 128 个，当前展示前 128 个。
          </p>
          <div v-if="data.snapshot?.addresses.length" class="table-scroll">
            <table>
              <thead>
                <tr>
                  <th>网卡</th>
                  <th>IP 地址</th>
                  <th>协议</th>
                  <th>网卡状态</th>
                </tr>
              </thead>
              <tbody>
                <tr
                  v-for="a in data.snapshot.addresses"
                  :key="`${a.interface}:${a.address}`"
                >
                  <td>{{ a.interface }}</td>
                  <td class="mono">{{ a.address }}</td>
                  <td>{{ a.family === "ipv4" ? "IPv4" : "IPv6" }}</td>
                  <td>{{ a.up ? "启用" : "关闭" }}</td>
                </tr>
              </tbody>
            </table>
          </div>
          <p v-else class="muted">
            {{ data.snapshot ? "未发现非回环网卡地址" : "尚未采集到 IP 地址" }}
          </p>
          <h3>连接中断记录</h3>
          <p class="network-scroll-hint field-hint">
            左右滑动表格可查看完整时间记录
          </p>
          <p class="field-hint">
            记录的是与平台的连接状态。静默断线通常在最后一次响应后约 20
            秒被检测到；平台重启也可能造成断连。时间由 Agent
            本机时钟记录，无法据此确认整机断网。Agent
            进程中断仅标记重新启动时间，无法确定停机起点。
          </p>
          <div v-if="data.events.length" class="table-scroll">
            <table>
              <thead>
                <tr>
                  <th>事件</th>
                  <th>最后确认连接</th>
                  <th>检测 / 重启时间</th>
                  <th>恢复时间</th>
                  <th>检测后持续</th>
                </tr>
              </thead>
              <tbody>
                <tr v-for="event in data.events" :key="event.event_id">
                  <td>{{ reasons[event.reason] }}</td>
                  <td>{{ formatTime(event.last_contact_at) }}</td>
                  <td>{{ formatTime(event.detected_at) }}</td>
                  <td>{{ formatTime(event.recovered_at) }}</td>
                  <td>
                    {{
                      event.reason === "agent_restart"
                        ? "起点未知"
                        : duration(event.detected_at, event.recovered_at)
                    }}
                  </td>
                </tr>
              </tbody>
            </table>
          </div>
          <p v-else class="muted">暂无连接中断记录</p>
          <div class="network-pages">
            <button
              class="button small"
              :disabled="busy || !pages.length"
              @click="load(pages[pages.length - 1], 'back')"
            >
              上一页</button
            ><span class="muted">第 {{ pages.length + 1 }} 页</span
            ><button
              class="button small"
              :disabled="busy || !data.next_before"
              @click="load(data.next_before, 'next')"
            >
              更早记录
            </button>
          </div>
        </template>
      </div>
    </section>
  </div>
</template>
<style scoped>
.network-overlay {
  position: fixed;
  inset: 0;
  z-index: 100;
  background: #13253680;
  display: grid;
  place-items: center;
  padding: 24px;
}
.network-panel {
  width: min(1100px, 100%);
  max-height: 92dvh;
  display: flex;
  flex-direction: column;
  overflow: hidden;
}
.network-content {
  padding: 24px;
  overflow: auto;
  min-height: 0;
}
.network-panel .panel-heading {
  flex-shrink: 0;
  gap: 16px;
  padding: 16px 20px;
  border-bottom: 1px solid var(--border);
}
.network-scroll-hint {
  display: none;
}
.network-content h3 {
  margin: 24px 0 10px;
}
.network-content td {
  white-space: nowrap;
}
.network-notice {
  background: #fff6dc;
  color: #775018;
  border-radius: 8px;
  padding: 12px;
}
.network-pages {
  display: flex;
  gap: 16px;
  align-items: center;
  justify-content: flex-end;
  margin-top: 20px;
}
@media (max-width: 640px) {
  .network-scroll-hint {
    display: block;
  }
  .network-overlay {
    padding: 8px;
  }
  .network-panel {
    max-height: 96dvh;
  }
  .network-content {
    padding: 14px;
  }
}
</style>
