<script setup lang="ts">
import { computed, onMounted, onBeforeUnmount, ref } from "vue";
import { api, ApiError } from "../api/client";
import { formatTime } from "../model";
type Release = { arch: string; version: string; sha256: string; size: number };
type Device = {
  device_id: string;
  name: string;
  version: string | null;
  arch: string | null;
  sha256: string | null;
  supported: boolean;
  online: boolean;
};
type Job = {
  id: string;
  batch_id: string;
  device_id: string;
  arch: string;
  sha256: string;
  size: number;
  version: string;
  status: string;
  reason: string | null;
  created_at: number;
  updated_at: number;
};
type Snapshot = { releases: Release[]; devices: Device[]; jobs: Job[] };
type Request = {
  v: 1;
  request_id: string;
  concurrency: number;
  targets: { device_id: string; sha256: string }[];
};
const data = ref<Snapshot>({ releases: [], devices: [], jobs: [] }),
  selected = ref<string[]>([]),
  concurrency = ref(2),
  loading = ref(false),
  busy = ref(false),
  error = ref(""),
  loadError = ref(""),
  message = ref(""),
  pending = ref<Request>();
let disposed = false,
  timer: ReturnType<typeof setTimeout> | undefined;
const complete = (status: string) => ["SUCCEEDED", "FAILED"].includes(status);
const labels: Record<string, string> = {
  QUEUED: "等待上线 / 排队",
  DOWNLOADING: "下载并校验",
  WAITING_IDLE: "等待终端和任务结束",
  RESTARTING: "切换版本，等待上线",
  SUCCEEDED: "升级完成",
  FAILED: "升级失败",
  UNKNOWN: "结果待确认",
};
const reasons: Record<string, string> = {
  DOWNLOAD_FAILED: "下载或安装包校验失败，保留原版本",
  PACKAGE_INVALID: "安装包无效，保留原版本",
  PERSIST_FAILED: "无法保存升级状态",
  TRIAL_FAILED: "新版本未能确认在线，已回退原版本",
  BUSY_EXPIRED: "排队超过 24 小时，请重新发起",
  REVOKED: "设备已撤销",
  PACKAGE_MISSING: "安装包不可用",
  RESULT_UNCONFIRMED: "尚未收到确切结果，请等待设备回报，勿重复发起",
};
const target = (device: Device) =>
  data.value.releases.find((r) => r.arch === device.arch);
const active = (id: string) =>
  data.value.jobs.find((j) => j.device_id === id && !complete(j.status));
const downgrade = (d: Device) => {
  const next = target(d)?.version.split(".").map(Number);
  const current = d.version?.split(".").map(Number);
  if (!next || !current || current.length !== 3) return false;
  for (let i = 0; i < 3; i++)
    if (next[i] !== current[i]) return next[i]! < current[i]!;
  return false;
};
const eligible = (d: Device) =>
  d.supported &&
  !!target(d) &&
  !downgrade(d) &&
  target(d)!.sha256 !== d.sha256 &&
  !active(d.device_id);
const candidates = computed(() => data.value.devices.filter(eligible));
const allSelected = computed(
  () =>
    candidates.value.length > 0 &&
    candidates.value
      .slice(0, 100)
      .every((d) => selected.value.includes(d.device_id)),
);
function selectAll() {
  selected.value = allSelected.value
    ? []
    : candidates.value.slice(0, 100).map((d) => d.device_id);
}
function status(d: Device) {
  const job = active(d.device_id);
  return job
    ? labels[job.status]
    : !d.supported
      ? "需先更新基础版本"
      : !target(d)
        ? "暂无对应架构安装包"
        : downgrade(d)
          ? "当前版本高于发布版本"
          : target(d)!.sha256 === d.sha256
            ? "已是当前版本"
            : d.online
              ? "可升级"
              : "上线后升级";
}
async function load() {
  if (loading.value || disposed) return;
  loading.value = true;
  try {
    const value = await api.request<Snapshot>("/agent-upgrades");
    if (disposed) return;
    data.value = value;
    loadError.value = "";
    if (
      pending.value &&
      value.jobs.some((j) => j.batch_id === pending.value!.request_id)
    ) {
      pending.value = undefined;
      selected.value = [];
      message.value = "已确认升级批次，进度见下方记录。";
      error.value = "";
    }
    if (!pending.value && !busy.value)
      selected.value = selected.value.filter((id) =>
        value.devices.some((d) => d.device_id === id && eligible(d)),
      );
  } catch (e) {
    if (!disposed)
      loadError.value = e instanceof Error ? e.message : "读取升级状态失败";
  } finally {
    if (!disposed) {
      loading.value = false;
      if (timer) clearTimeout(timer);
      timer = setTimeout(() => void load(), 3000);
    }
  }
}
async function submit() {
  if (busy.value) return;
  if (!pending.value) {
    const devices = data.value.devices.filter(
      (d) => selected.value.includes(d.device_id) && eligible(d),
    );
    if (!devices.length) return;
    if (devices.length > 100) {
      error.value = "每批最多选择 100 台设备";
      return;
    }
    pending.value = {
      v: 1,
      request_id: crypto.randomUUID(),
      concurrency: concurrency.value,
      targets: devices.map((d) => ({
        device_id: d.device_id,
        sha256: target(d)!.sha256,
      })),
    };
  }
  const request = pending.value;
  busy.value = true;
  error.value = "";
  message.value = "";
  try {
    await api.request("/agent-upgrades", { method: "POST", body: request });
    if (disposed) return;
    pending.value = undefined;
    selected.value = [];
    message.value = `已创建升级批次，共 ${request.targets.length} 台。现有终端和任务结束后会自动升级。`;
    await load();
  } catch (e) {
    if (disposed) return;
    if (e instanceof ApiError && (e.status === 0 || e.status >= 500)) {
      error.value = "提交结果尚未确认，请点击“核对原批次”安全重试。";
    } else {
      pending.value = undefined;
      error.value = e instanceof Error ? e.message : "升级提交失败";
      await load();
    }
  } finally {
    if (!disposed) busy.value = false;
  }
}
onMounted(load);
onBeforeUnmount(() => {
  disposed = true;
  if (timer) clearTimeout(timer);
});
</script>
<template>
  <section class="panel upgrade-panel" aria-labelledby="upgrade-title">
    <div class="upgrade-heading">
      <div>
        <h2 id="upgrade-title">批量升级 Agent</h2>
        <p class="muted">保留设备身份、配置和记录，失败自动回退</p>
      </div>
      <button
        type="button"
        class="button secondary"
        :disabled="loading"
        @click="load"
      >
        刷新升级状态
      </button>
    </div>
    <p v-if="error || loadError" class="notice danger" role="alert">
      {{ error || loadError }}
    </p>
    <p v-if="message" class="upgrade-success" role="status">{{ message }}</p>
    <div class="release-list">
      <div v-for="release in data.releases" :key="release.arch">
        <strong>{{ release.arch }} · v{{ release.version }}</strong
        ><span class="muted"
          >{{ (release.size / 1048576).toFixed(1) }} MB · 构建
          {{ release.sha256.slice(0, 12) }}</span
        >
      </div>
    </div>
    <p v-if="!data.releases.length" class="notice">
      平台尚未发布可升级安装包，请先构建并发布对应架构的 Agent 安装包。
    </p>
    <p class="field-hint">
      每批最多 100
      台，选中设备后统一升级。开始升级后暂停新终端和命令，已有操作可继续完成；离线设备会排队。旧版
      Agent 需先更新一次基础程序，之后可直接在此升级，无需 sudo 密码。
    </p>
    <form @submit.prevent="submit">
      <fieldset :disabled="busy || !!pending">
        <div class="upgrade-actions">
          <label class="inline"
            ><input
              type="checkbox"
              :checked="allSelected"
              :disabled="!candidates.length"
              @change="selectAll"
            />全选可升级设备</label
          ><label class="inline"
            >同时升级
            <select v-model.number="concurrency">
              <option v-for="n in 5" :key="n" :value="n">{{ n }} 台</option>
            </select></label
          >
        </div>
        <div class="upgrade-table">
          <table>
            <thead>
              <tr>
                <th>选择</th>
                <th>设备</th>
                <th>当前版本</th>
                <th>目标版本</th>
                <th>状态</th>
              </tr>
            </thead>
            <tbody>
              <tr v-for="device in data.devices" :key="device.device_id">
                <td>
                  <input
                    v-model="selected"
                    type="checkbox"
                    :value="device.device_id"
                    :disabled="
                      !eligible(device) ||
                      (selected.length >= 100 &&
                        !selected.includes(device.device_id))
                    "
                    :aria-label="`选择 ${device.name}`"
                  />
                </td>
                <td>
                  <strong>{{ device.name }}</strong
                  ><small
                    >{{ device.online ? "在线" : "离线" }} ·
                    {{ device.arch ?? "架构未知" }}</small
                  >
                </td>
                <td>
                  {{ device.version ?? "未知"
                  }}<small>{{ device.sha256?.slice(0, 12) }}</small>
                </td>
                <td>{{ target(device)?.version ?? "—" }}</td>
                <td>{{ status(device) }}</td>
              </tr>
            </tbody>
          </table>
        </div>
      </fieldset>
      <div class="upgrade-actions">
        <span class="muted"
          >已选择 {{ pending?.targets.length ?? selected.length }} 台</span
        ><button
          type="submit"
          class="button primary"
          :disabled="busy || (!pending && !selected.length)"
        >
          {{ busy ? "正在提交…" : pending ? "核对原批次" : "升级所选设备" }}
        </button>
      </div>
    </form>
    <h3>升级记录</h3>
    <p v-if="!data.jobs.length" class="muted">暂无升级记录</p>
    <ul class="upgrade-jobs">
      <li v-for="job in data.jobs.slice(0, 100)" :key="job.id">
        <div>
          <strong>{{
            data.devices.find((d) => d.device_id === job.device_id)?.name ??
            job.device_id
          }}</strong
          ><span>→ {{ job.version }}</span
          ><time>{{ formatTime(job.created_at) }}</time>
        </div>
        <strong :class="job.status === 'SUCCEEDED' ? 'upgrade-success' : ''">{{
          labels[job.status] ?? job.status
        }}</strong>
        <p v-if="job.reason" class="field-hint">
          {{ reasons[job.reason] ?? job.reason }}
        </p>
      </li>
    </ul>
  </section>
</template>
<style scoped>
.upgrade-panel {
  padding: 24px;
}
.upgrade-heading,
.upgrade-actions {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 16px;
  flex-wrap: wrap;
}
.upgrade-heading h2 {
  margin: 0;
}
.upgrade-heading p {
  margin: 8px 0 0;
}
.release-list {
  display: flex;
  flex-wrap: wrap;
  gap: 12px;
  margin: 20px 0;
}
.release-list > div {
  display: grid;
  gap: 8px;
  padding: 14px;
  background: #f3f7f9;
  border-radius: 8px;
  font-size: 13px;
}
.upgrade-table {
  overflow: auto;
}
fieldset {
  border: 0;
  padding: 0;
  margin: 0;
  min-width: 0;
}
form {
  margin: 20px 0 28px;
}
.upgrade-actions {
  margin: 16px 0;
}
label.inline {
  display: flex;
  align-items: center;
  gap: 8px;
  font-size: 13px;
  margin: 0;
}
input[type="checkbox"] {
  width: 16px;
  height: 16px;
  margin: 0;
  accent-color: #147d76;
}
select {
  width: auto;
  margin: 0;
}
small {
  display: block;
  color: #7a8b98;
  margin-top: 6px;
}
.upgrade-success {
  color: #19705c;
}
.upgrade-jobs {
  list-style: none;
  margin: 0;
  padding: 0;
  display: grid;
  gap: 12px;
}
.upgrade-jobs li {
  display: grid;
  grid-template-columns: 1fr auto;
  gap: 10px;
  background: #f3f7f9;
  border-radius: 8px;
  padding: 14px;
  font-size: 13px;
  overflow-wrap: anywhere;
}
.upgrade-jobs li div {
  display: flex;
  flex-wrap: wrap;
  gap: 12px;
}
.upgrade-jobs time {
  color: #7a8b98;
}
.upgrade-jobs p {
  grid-column: 1/-1;
  margin: 0;
}
@media (max-width: 600px) {
  .upgrade-panel {
    padding: 16px;
  }
  .upgrade-jobs li {
    grid-template-columns: 1fr;
  }
}
</style>
