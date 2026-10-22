<script setup lang="ts">
import { onBeforeUnmount, onMounted, ref } from "vue";
import { api } from "../api/client";
import type { Device, DeviceDisk, User } from "../api/types";
import { formatTime } from "../model";
import { diskBytes, diskPercent } from "../disk";
import { copyText } from "../clipboard";
import { routeHash } from "../navigation";
const props = defineProps<{ device: Device; user: User }>();
const emit = defineEmits<{ close: []; changed: [] }>();
const disk = ref<DeviceDisk>();
const interval = ref(24);
const busy = ref(false);
const error = ref("");
const notice = ref("");
const linkNotice = ref("");
async function copyLink() {
  try {
    await copyText(
      window.location.origin +
        window.location.pathname +
        window.location.search +
        routeHash({ view: "devices", deviceId: props.device.id }),
    );
    linkNotice.value = "设备链接已复制，打开后仍需登录并拥有设备权限。";
  } catch {
    linkNotice.value = "复制失败，可直接复制浏览器地址栏中的设备链接。";
  }
}
let disposed = false;
const endpoint = () => `/devices/${encodeURIComponent(props.device.id)}/disk`;
const reasons: Record<string, string> = {
  DEVICE_OFFLINE: "设备离线，暂时无法采集。",
  DEVICE_REVOKED: "设备访问已撤销。",
  DISK_AGENT_UPDATE_REQUIRED:
    "当前 Agent 不支持磁盘采集，请升级 Agent 或配置备用 SSH。",
  DISK_COLLECTION_TIMEOUT: "采集超时，稍后再试。",
  DISK_COLLECTION_FAILED: "磁盘采集失败，请检查设备上的 df 命令与访问权限。",
  DISK_OUTPUT_LIMIT: "文件系统信息超过采集上限。",
  DISK_NO_LOCAL_FILESYSTEM: "未发现可统计的本地持久文件系统。",
  SSH_HOST_KEY_MISMATCH: "SSH 主机指纹不匹配，请核对接入配置。",
  SSH_AUTH_FAILED: "SSH 认证失败，请检查接入凭据。",
  SSH_CONNECT_FAILED: "无法连接设备 SSH。",
  SSH_NOT_CONFIGURED: "设备尚未配置可用的 SSH 接入。",
  DEVICE_CONNECTION_CHANGED: "采集期间接入配置发生变化，请稍后重试。",
};
function apply(value: DeviceDisk) {
  disk.value = value;
  interval.value = value.interval_hours;
}
async function collect() {
  if (busy.value || props.device.revoked_at) return;
  if (
    !disk.value?.collecting &&
    disk.value?.cache_until &&
    disk.value.cache_until > Date.now()
  ) {
    notice.value = `正在使用缓存，可在 ${formatTime(disk.value.cache_until)} 后重新采集。`;
    return;
  }
  busy.value = true;
  error.value = "";
  notice.value = "";
  try {
    const value = await api.request<DeviceDisk>(`${endpoint()}/collect`, {
      method: "POST",
      body: { v: 1 },
      timeoutMs: 25000, // Covers two bounded SSH route attempts.
    });
    if (disposed) return;
    apply(value);
    emit("changed");
  } catch (e) {
    if (!disposed)
      error.value = e instanceof Error ? e.message : "读取磁盘失败";
  } finally {
    if (!disposed) busy.value = false;
  }
}
async function load() {
  busy.value = true;
  try {
    const value = await api.request<DeviceDisk>(endpoint());
    if (disposed) return;
    apply(value);
    busy.value = false;
    if (
      !props.device.revoked_at &&
      (value.collecting ||
        !value.cache_until ||
        value.cache_until <= Date.now())
    )
      await collect();
  } catch (e) {
    if (!disposed)
      error.value = e instanceof Error ? e.message : "读取设备详情失败";
  } finally {
    if (!disposed) busy.value = false;
  }
}
async function saveSchedule() {
  if (
    busy.value ||
    !disk.value ||
    props.user.role !== "admin" ||
    props.device.revoked_at
  )
    return;
  busy.value = true;
  error.value = "";
  notice.value = "";
  try {
    const value = await api.request<DeviceDisk>(`${endpoint()}/settings`, {
      method: "PUT",
      body: {
        v: 1,
        revision: disk.value.revision,
        interval_hours: Number(interval.value),
      },
    });
    if (!disposed) {
      apply(value);
      notice.value = "采集间隔已保存。";
    }
  } catch (e) {
    if (!disposed)
      error.value = e instanceof Error ? e.message : "保存采集间隔失败";
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
  <section class="device-detail" aria-label="设备详情">
    <div class="detail-navigation">
      <button class="button secondary" @click="emit('close')">
        ← 返回设备列表
      </button>
      <button class="button secondary" @click="copyLink">复制设备链接</button>
    </div>
    <p v-if="linkNotice" class="notice neutral" role="status">
      {{ linkNotice }}
    </p>
    <header class="detail-heading">
      <div>
        <p class="eyebrow">设备详情</p>
        <h2>{{ device.name }}</h2>
        <p class="muted mono">{{ device.id }}</p>
      </div>
      <span class="status-badge">{{
        device.revoked_at
          ? "访问已撤销"
          : device.connection_kind === "ssh"
            ? "SSH 按需连接"
            : device.control_online
              ? "Agent 在线"
              : "Agent 离线"
      }}</span>
    </header>
    <div v-if="$slots.actions" class="detail-actions" aria-label="设备快捷操作">
      <slot name="actions" />
    </div>
    <div class="detail-grid">
      <section class="panel disk-card" aria-label="磁盘总占用">
        <header class="panel-heading">
          <div>
            <h3>磁盘总占用</h3>
            <p class="field-hint">汇总本地持久文件系统</p>
          </div>
          <button
            class="button secondary small"
            :disabled="busy || !!device.revoked_at"
            @click="collect"
          >
            {{ busy ? "读取中…" : "刷新磁盘" }}
          </button>
        </header>
        <p v-if="error" role="alert" class="notice danger">{{ error }}</p>
        <p v-if="notice" class="notice neutral" role="status">{{ notice }}</p>
        <p v-if="disk?.last_error" class="notice warning" role="alert">
          {{ reasons[disk.last_error] ?? "采集失败，请稍后再试。"
          }}{{ disk.usage ? "下方保留上次成功结果。" : "" }}
        </p>
        <template v-if="disk?.usage">
          <div class="disk-headline">
            <strong
              >{{ diskPercent(disk.usage.used_bytes, disk.usage.total_bytes)
              }}<small>%</small></strong
            ><span>已用</span>
          </div>
          <meter
            :value="disk.usage.used_bytes"
            :max="disk.usage.total_bytes"
            :high="disk.usage.total_bytes * 0.85"
            :optimum="0"
            aria-label="磁盘已用比例"
          />
          <dl class="disk-totals">
            <div>
              <dt>总容量</dt>
              <dd>{{ diskBytes(disk.usage.total_bytes) }}</dd>
            </div>
            <div>
              <dt>已用</dt>
              <dd>{{ diskBytes(disk.usage.used_bytes) }}</dd>
            </div>
            <div>
              <dt>可用</dt>
              <dd>{{ diskBytes(disk.usage.available_bytes) }}</dd>
            </div>
          </dl>
          <p class="muted small">
            {{ disk.usage.filesystem_count }} 个文件系统 · 最近采集
            {{ formatTime(disk.checked_at)
            }}<span v-if="disk.stale"> · 数据可能已过期</span>
          </p>
        </template>
        <p v-else class="disk-empty">
          {{ busy ? "正在获取服务器磁盘信息…" : "暂无磁盘数据" }}
        </p>
        <p class="field-hint">
          不包含内存盘、网络盘、重复挂载和未挂载磁盘；容器部署以容器可见的文件系统为准。可用空间不含系统保留空间。
        </p>
        <p class="field-hint">
          结果缓存 5 分钟，多人查看共用一次采集；失败后冷却 1 分钟。
        </p>
      </section>
      <div class="detail-side">
        <section class="panel detail-card">
          <h3>接入信息</h3>
          <dl>
            <dt>接入方式</dt>
            <dd>
              {{
                device.connection_kind === "ssh"
                  ? "SSH"
                  : device.ssh_configured
                    ? "Agent / 备用 SSH"
                    : "Agent"
              }}
            </dd>
            <dt>Agent 版本</dt>
            <dd>{{ device.agent_version ?? "—" }}</dd>
            <dt>IP 地址</dt>
            <dd class="mono">
              {{ device.ip_addresses?.join("、") || "尚未上报" }}
            </dd>
            <dt>设备组</dt>
            <dd>
              {{
                device.device_groups?.map((g) => g.name).join("、") || "未分组"
              }}
            </dd>
          </dl>
        </section>
        <section v-if="disk" class="panel detail-card">
          <h3>定时采集</h3>
          <template v-if="user.role === 'admin' && !device.revoked_at"
            ><label for="disk-interval">采集间隔</label>
            <div class="schedule-controls">
              <select
                id="disk-interval"
                v-model.number="interval"
                :disabled="busy"
              >
                <option
                  v-for="hours in [24, 12, 8, 2, 1]"
                  :key="hours"
                  :value="hours"
                >
                  每 {{ hours }} 小时
                </option></select
              ><button
                class="button secondary"
                :disabled="busy || interval === disk.interval_hours"
                @click="saveSchedule"
              >
                保存
              </button>
            </div></template
          >
          <p v-else>每 {{ disk.interval_hours }} 小时采集一次</p>
          <p class="field-hint">
            下次计划：{{
              formatTime(disk.next_collection_at)
            }}。设备不可用时保留旧结果。
          </p>
        </section>
      </div>
    </div>
  </section>
</template>
<style scoped>
.device-detail {
  display: grid;
  gap: 24px;
}
.device-detail > button {
  justify-self: start;
}
.detail-navigation,
.detail-actions {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 12px;
}
.detail-heading {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 16px;
}
.detail-heading h2 {
  font-size: 28px;
  margin: 4px 0 8px;
  overflow-wrap: anywhere;
}
.detail-heading p {
  margin: 0;
  overflow-wrap: anywhere;
}
.eyebrow {
  color: var(--muted);
  font-size: 12px;
}
.detail-grid {
  display: grid;
  grid-template-columns: minmax(0, 1.7fr) minmax(260px, 1fr);
  gap: 20px;
  align-items: start;
}
.disk-card,
.detail-card {
  padding: 24px;
  min-width: 0;
}
.disk-card .panel-heading {
  padding: 0;
  margin-bottom: 24px;
}
.disk-headline {
  display: flex;
  align-items: baseline;
  gap: 12px;
  margin: 26px 0 12px;
}
.disk-headline strong {
  font-size: 52px;
  font-weight: 600;
}
.disk-headline small {
  font-size: 22px;
  margin-left: 3px;
}
meter {
  display: block;
  width: 100%;
  height: 16px;
  accent-color: #267a68;
}
.disk-totals {
  display: grid;
  grid-template-columns: repeat(3, 1fr);
  gap: 16px;
  margin: 26px 0;
}
dt {
  color: var(--muted);
  font-size: 13px;
}
dd {
  margin: 6px 0 18px;
  overflow-wrap: anywhere;
}
.disk-totals dd {
  font-size: 22px;
  font-weight: 600;
}
.detail-side {
  display: grid;
  gap: 20px;
}
.detail-card h3 {
  margin: 0 0 20px;
}
.schedule-controls {
  display: flex;
  gap: 8px;
  margin: 10px 0;
}
.schedule-controls select {
  min-width: 0;
  flex: 1;
}
.disk-empty {
  padding: 36px 0;
  color: var(--muted);
}
@media (max-width: 800px) {
  .detail-grid {
    grid-template-columns: 1fr;
  }
}
@media (max-width: 480px) {
  .disk-card,
  .detail-card {
    padding: 18px;
  }
  .disk-totals {
    gap: 8px;
  }
  .disk-totals dd {
    font-size: 16px;
  }
  .detail-heading {
    align-items: start;
    flex-direction: column;
  }
}
</style>
