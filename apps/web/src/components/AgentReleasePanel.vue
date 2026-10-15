<script setup lang="ts">
import { ref, onMounted, onBeforeUnmount } from "vue";
import { api, ApiError } from "../api/client";
import { formatTime } from "../model";
type Manifest = {
  version: string;
  arch: string;
  sha256: string;
  size: number;
  upgrade_protocol: 1;
};
type Release = Omit<Manifest, "upgrade_protocol"> & {
  enabled: boolean;
  source: string;
  created_at: number;
};
const emit = defineEmits<{ changed: [] }>();
const releases = ref<Release[]>([]),
  manifest = ref<Manifest>(),
  binary = ref<File>(),
  busy = ref(false),
  loading = ref(false),
  changing = ref(""),
  error = ref(""),
  message = ref("");
let disposed = false,
  readGeneration = 0;
async function load() {
  if (loading.value) return;
  loading.value = true;
  try {
    const r = await api.request<{ releases: Release[] }>("/agent-releases");
    if (!disposed) releases.value = r.releases;
  } catch (e) {
    if (!disposed)
      error.value = e instanceof Error ? e.message : "读取安装包失败";
  } finally {
    if (!disposed) loading.value = false;
  }
}
async function selectManifest(event: Event) {
  const generation = ++readGeneration;
  manifest.value = undefined;
  error.value = "";
  message.value = "";
  const file = (event.target as HTMLInputElement).files?.[0];
  if (!file) return;
  try {
    if (file.size > 4096)
      throw Error("请选择构建生成的 JSON 版本清单（最大 4 KB）");
    const m = JSON.parse(await file.text());
    if (disposed || generation !== readGeneration) return;
    if (
      !m ||
      Object.keys(m).sort().join(",") !==
        "arch,sha256,size,upgrade_protocol,version" ||
      typeof m.version !== "string" ||
      !/^\d{1,6}\.\d{1,6}\.\d{1,6}$/.test(m.version) ||
      !["aarch64", "x86_64"].includes(m.arch) ||
      typeof m.sha256 !== "string" ||
      !/^[a-f0-9]{64}$/.test(m.sha256) ||
      !Number.isInteger(m.size) ||
      m.size < 64 ||
      m.size > 64 * 1024 * 1024 ||
      m.upgrade_protocol !== 1
    )
      throw Error("版本清单无效，请选择构建生成的 .json 文件");
    manifest.value = m;
  } catch (e) {
    if (!disposed && generation === readGeneration)
      error.value =
        e instanceof SyntaxError
          ? "版本清单不是有效的 JSON 文件"
          : e instanceof Error
            ? e.message
            : "读取版本清单失败";
  }
}
function selectBinary(event: Event) {
  binary.value = (event.target as HTMLInputElement).files?.[0];
  error.value = "";
  message.value = "";
}
async function upload() {
  if (busy.value || !manifest.value || !binary.value) return;
  const m = { ...manifest.value },
    file = binary.value;
  if (file.size !== m.size) {
    error.value = "安装包大小与版本清单不一致";
    return;
  }
  busy.value = true;
  error.value = "";
  message.value = "";
  try {
    const result = await api.upload<{ release: Release }>(
      `/agent-releases/${m.sha256}`,
      file,
      m,
    );
    if (disposed) return;
    message.value = `${m.version} · ${m.arch} 已保存${result.release.enabled ? "，可以选择此版本升级" : "，该包目前已停用"}。`;
    await load();
    emit("changed");
  } catch (e) {
    if (!disposed)
      error.value =
        e instanceof ApiError && (e.status === 0 || e.status >= 500)
          ? "上传结果未确认，可点击上传重试；同一安装包不会重复创建。"
          : e instanceof Error
            ? e.message
            : "上传失败";
  } finally {
    if (!disposed) busy.value = false;
  }
}
async function setEnabled(release: Release) {
  if (changing.value || busy.value) return;
  changing.value = release.sha256;
  error.value = "";
  message.value = "";
  try {
    await api.request(`/agent-releases/${release.sha256}`, {
      method: "POST",
      body: { v: 1, enabled: !release.enabled },
    });
    if (disposed) return;
    message.value = `${release.version} · ${release.arch} 已${release.enabled ? "停用" : "启用"}。`;
    await load();
    emit("changed");
  } catch (e) {
    if (!disposed) {
      error.value = e instanceof Error ? e.message : "更新失败";
      await load();
      emit("changed");
    }
  } finally {
    if (!disposed) changing.value = "";
  }
}
onMounted(load);
onBeforeUnmount(() => {
  disposed = true;
  readGeneration++;
});
</script>
<template>
  <section class="release-panel" aria-labelledby="release-title">
    <div class="release-heading">
      <div>
        <h3 id="release-title">升级包管理</h3>
        <p class="muted">上传后保留多个版本，升级时选择目标版本</p>
      </div>
      <button
        type="button"
        class="button secondary small"
        :disabled="loading"
        @click="load"
      >
        刷新安装包
      </button>
    </div>
    <p v-if="error" role="alert" class="notice danger">{{ error }}</p>
    <p v-if="message" role="status" class="release-success">{{ message }}</p>
    <form class="release-upload" @submit.prevent="upload">
      <fieldset :disabled="busy || !!changing">
        <label
          >版本清单（JSON）<input
            type="file"
            accept=".json,application/json"
            @change="selectManifest"
        /></label>
        <label>Agent 安装包<input type="file" @change="selectBinary" /></label>
        <p class="field-hint">
          选择同一次构建的 Linux 二进制文件和同名 .json 清单；单包最大 64
          MB。版本和架构相同的安装包不能覆盖。
        </p>
        <div v-if="manifest" class="release-preview">
          <strong>v{{ manifest.version }} · {{ manifest.arch }}</strong
          ><span>{{ (manifest.size / 1048576).toFixed(1) }} MB</span
          ><code>SHA-256 {{ manifest.sha256 }}</code>
        </div>
        <button
          type="submit"
          class="button secondary"
          :disabled="!manifest || !binary"
        >
          {{ busy ? "正在上传并校验…" : "上传安装包" }}
        </button>
      </fieldset>
    </form>
    <p v-if="!releases.length && !loading" class="muted">
      暂无安装包，上传后即可选择版本。
    </p>
    <div class="release-table">
      <table v-if="releases.length">
        <thead>
          <tr>
            <th>版本 / 架构</th>
            <th>大小 / 校验值</th>
            <th>入库时间</th>
            <th>状态</th>
            <th>操作</th>
          </tr>
        </thead>
        <tbody>
          <tr v-for="release in releases" :key="release.sha256">
            <td>
              <strong>{{ release.version }}</strong
              ><small>{{ release.arch }}</small>
            </td>
            <td>
              {{ (release.size / 1048576).toFixed(1) }} MB<small
                :title="release.sha256"
                >{{ release.sha256.slice(0, 12) }}</small
              >
            </td>
            <td>{{ formatTime(release.created_at) }}</td>
            <td>{{ release.enabled ? "可用" : "已停用" }}</td>
            <td>
              <button
                type="button"
                class="button secondary small"
                :disabled="busy || !!changing"
                :aria-label="`${release.enabled ? '停用' : '启用'} ${release.version} ${release.arch}`"
                @click="setEnabled(release)"
              >
                {{
                  changing === release.sha256
                    ? "保存中…"
                    : release.enabled
                      ? "停用"
                      : "启用"
                }}
              </button>
            </td>
          </tr>
        </tbody>
      </table>
    </div>
    <p v-if="releases.length" class="field-hint">
      停用后不再用于新的升级或安装，已经下发的任务和安装命令仍使用原包。
    </p>
  </section>
</template>
<style scoped>
.release-panel {
  margin: 24px 0;
  border-top: 1px solid #e5edf2;
  border-bottom: 1px solid #e5edf2;
  padding: 24px 0;
}
.release-heading {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  flex-wrap: wrap;
}
.release-heading h3 {
  margin: 0;
}
.release-heading p {
  margin: 8px 0 0;
}
.release-upload {
  margin: 20px 0;
}
fieldset {
  border: 0;
  margin: 0;
  padding: 0;
  min-width: 0;
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: 16px;
}
label {
  min-width: 0;
}
input[type="file"] {
  max-width: 100%;
  width: 100%;
  box-sizing: border-box;
  padding: 10px;
  font-size: 13px;
}
.field-hint,
.release-preview {
  grid-column: 1/-1;
}
.field-hint {
  margin: 0;
}
.release-preview {
  display: flex;
  flex-wrap: wrap;
  gap: 12px;
  background: #f3f7f9;
  border-radius: 8px;
  padding: 14px;
  font-size: 13px;
}
.release-preview code {
  display: block;
  width: 100%;
  overflow-wrap: anywhere;
  font-size: 11px;
}
.release-upload button {
  justify-self: start;
}
.release-table {
  max-height: 360px;
  overflow: auto;
  margin-bottom: 12px;
}
small {
  display: block;
  color: #7a8b98;
  margin-top: 6px;
}
.release-success {
  color: #19705c;
}
@media (max-width: 600px) {
  fieldset {
    grid-template-columns: 1fr;
  }
  .release-panel {
    padding: 16px 0;
  }
}
</style>
