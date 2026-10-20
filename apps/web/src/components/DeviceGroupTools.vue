<script setup lang="ts">
import { computed, onBeforeUnmount, ref, watch } from "vue";
import { api } from "../api/client";
import type { Device, ManagedDeviceGroup } from "../api/types";
const props = defineProps<{
  devices: Device[];
  admin: boolean;
  selectedIds: string[];
  visibleIds: string[];
  filter: string;
}>();
const emit = defineEmits<{
  "update:filter": [value: string];
  "update:selectedIds": [value: string[]];
  changed: [];
}>();
const groups = ref<ManagedDeviceGroup[]>([]),
  loading = ref(false),
  saving = ref(false),
  error = ref(""),
  notice = ref("");
const mode = ref<"manage" | "create" | "edit" | "add" | "remove" | null>(null);
const editing = ref<ManagedDeviceGroup>();
const draft = ref({ name: "", description: "", device_ids: [] as string[] });
const targets = ref<string[]>([]),
  tagIds = ref<string[]>([]),
  formError = ref(""),
  uncertain = ref(false);
let disposed = false,
  reloadPending = false;
const options = computed(() => {
  const values = new Map<string, string>();
  for (const d of props.devices)
    for (const g of d.device_groups ?? []) values.set(g.id, g.name);
  if (props.admin) for (const g of groups.value) values.set(g.id, g.name);
  return [...values]
    .map(([id, name]) => ({ id, name }))
    .sort((a, b) => a.name.localeCompare(b.name));
});
const hiddenCount = computed(
  () => props.selectedIds.filter((id) => !props.visibleIds.includes(id)).length,
);
const title = computed(
  () =>
    ({
      manage: "设备组管理",
      create: "创建设备组",
      edit: "编辑设备组",
      add: "批量添加标签",
      remove: "批量移除标签",
    })[mode.value ?? "manage"],
);
async function load() {
  if (!props.admin) return;
  if (loading.value) {
    reloadPending = true;
    return;
  }
  loading.value = true;
  error.value = "";
  try {
    const response = await api.request<{ device_groups: ManagedDeviceGroup[] }>(
      "/device-groups",
    );
    if (!Array.isArray(response.device_groups))
      throw new Error("设备组列表格式错误");
    if (!disposed) groups.value = response.device_groups;
  } catch (e) {
    if (!disposed)
      error.value = e instanceof Error ? e.message : "读取设备组失败";
  } finally {
    if (!disposed) {
      loading.value = false;
      if (reloadPending) {
        reloadPending = false;
        void load();
      }
    }
  }
}
function dismiss() {
  if (!saving.value) {
    mode.value = null;
    formError.value = "";
  }
}
async function manage() {
  mode.value = "manage";
  formError.value = "";
  await load();
}
function edit(item?: ManagedDeviceGroup) {
  if (saving.value || loading.value) return;
  editing.value = item;
  draft.value = {
    name: item?.name ?? "",
    description: item?.description ?? "",
    device_ids: [...(item?.device_ids ?? [])],
  };
  formError.value = "";
  uncertain.value = false;
  mode.value = item ? "edit" : "create";
}
async function batch(operation: "add" | "remove") {
  if (!props.selectedIds.length) return;
  targets.value = [...props.selectedIds];
  tagIds.value = [];
  formError.value = "";
  uncertain.value = false;
  mode.value = operation;
  await load();
}
async function save() {
  if (saving.value || loading.value || uncertain.value) return;
  const kind = mode.value;
  if (
    kind !== "create" &&
    kind !== "edit" &&
    kind !== "add" &&
    kind !== "remove"
  )
    return;
  if (
    (kind === "add" || kind === "remove") &&
    (!tagIds.value.length ||
      !targets.value.length ||
      targets.value.length > 1000)
  )
    return;
  saving.value = true;
  formError.value = "";
  notice.value = "";
  try {
    if (kind === "add" || kind === "remove") {
      const result = await api.request<{ changed_count: number }>(
        "/device-groups/batch",
        {
          method: "POST",
          body: {
            v: 1,
            operation: kind,
            device_ids: targets.value,
            group_ids: tagIds.value,
          },
        },
      );
      if (disposed) return;
      notice.value = `已为 ${targets.value.length} 台设备${kind === "add" ? "添加" : "移除"}标签，${result.changed_count} 项关联发生变化。`;
      mode.value = null;
    } else {
      await api.request(
        "/device-groups" +
          (editing.value ? `/${encodeURIComponent(editing.value.id)}` : ""),
        {
          method: editing.value ? "PUT" : "POST",
          body: {
            v: 1,
            ...(editing.value ? { revision: editing.value.revision } : {}),
            name: draft.value.name.trim(),
            description: draft.value.description.trim(),
            device_ids: draft.value.device_ids,
          },
        },
      );
      if (disposed) return;
      notice.value = "设备组已保存。";
      mode.value = "manage";
    }
    emit("changed");
    await load();
  } catch (e) {
    if (!disposed) {
      formError.value = e instanceof Error ? e.message : "保存失败";
      uncertain.value = /ACCESS_REVISION_CONFLICT|请求超时|无法连接 API/.test(
        formError.value,
      );
      if (uncertain.value)
        formError.value += " 请关闭窗口并刷新列表，核对最新状态后再操作。";
    }
  } finally {
    if (!disposed) saving.value = false;
  }
}
async function remove(group: ManagedDeviceGroup) {
  if (
    saving.value ||
    loading.value ||
    !window.confirm(
      `删除设备组“${group.name}”？设备仍保留，只移除该标签，不影响已有授权。`,
    )
  )
    return;
  saving.value = true;
  formError.value = "";
  notice.value = "";
  try {
    await api.request(`/device-groups/${encodeURIComponent(group.id)}`, {
      method: "DELETE",
      body: { v: 1, revision: group.revision },
    });
    if (!disposed) {
      if (props.filter === group.id) emit("update:filter", "");
      notice.value = "设备组已删除，设备和授权均保留。";
      emit("changed");
      await load();
    }
  } catch (e) {
    if (!disposed)
      formError.value = e instanceof Error ? e.message : "删除失败";
  } finally {
    if (!disposed) saving.value = false;
  }
}
watch(
  () => props.devices,
  () => {
    void load();
  },
  { immediate: true },
);
onBeforeUnmount(() => {
  disposed = true;
});
</script>
<template>
  <div class="device-group-tools">
    <div class="device-group-toolbar">
      <label class="device-group-filter"
        >设备组<select
          :value="filter"
          aria-label="按设备组筛选"
          @change="
            emit('update:filter', ($event.target as HTMLSelectElement).value)
          "
        >
          <option value="">全部设备</option>
          <option value="__ungrouped__">未分组</option>
          <option v-for="group in options" :key="group.id" :value="group.id">
            {{ group.name }}
          </option>
        </select></label
      >
      <button v-if="admin" class="button secondary" @click="manage">
        管理设备组
      </button>
      <template v-if="admin && selectedIds.length">
        <span class="selected-count"
          >已选 {{ selectedIds.length }} 台<span v-if="hiddenCount"
            >（{{ hiddenCount }} 台在当前筛选外）</span
          ></span
        >
        <button
          class="button secondary"
          :disabled="saving"
          @click="batch('add')"
        >
          添加标签</button
        ><button
          class="button secondary"
          :disabled="saving"
          @click="batch('remove')"
        >
          移除标签</button
        ><button class="text-button" @click="emit('update:selectedIds', [])">
          清空选择
        </button>
      </template>
    </div>
    <p v-if="notice" class="field-hint" role="status">{{ notice }}</p>
    <p v-if="error && !mode" class="notice danger" role="alert">
      {{ error }} <button class="text-button" @click="load">重试</button>
    </p>
    <Teleport to="body">
      <div
        v-if="mode"
        class="tag-overlay"
        @click.self="dismiss"
        @keydown.esc="dismiss"
      >
        <section
          class="panel tag-dialog"
          role="dialog"
          aria-modal="true"
          aria-labelledby="tag-dialog-title"
        >
          <header class="tag-heading">
            <h2 id="tag-dialog-title">{{ title }}</h2>
            <button
              class="button secondary"
              :disabled="saving"
              @click="dismiss"
            >
              关闭设备组窗口
            </button>
          </header>
          <p v-if="error || formError" class="notice danger" role="alert">
            {{ formError || error }}
          </p>
          <template v-if="mode === 'manage'">
            <p class="field-hint">
              设备组是可选标签，设备可加入多个组或不加入任何组。修改标签不改变用户授权。
            </p>
            <div class="tag-actions">
              <button
                class="button primary"
                :disabled="loading || saving"
                @click="edit()"
              >
                创建设备组</button
              ><button
                class="button secondary"
                :disabled="loading || saving"
                @click="load"
              >
                刷新设备组
              </button>
            </div>
            <div class="tag-table">
              <table>
                <thead>
                  <tr>
                    <th>设备组</th>
                    <th>设备数</th>
                    <th>操作</th>
                  </tr>
                </thead>
                <tbody>
                  <tr v-for="group in groups" :key="group.id">
                    <td>
                      <strong>{{ group.name }}</strong
                      ><small>{{ group.description }}</small>
                    </td>
                    <td>{{ group.device_ids.length }} 台</td>
                    <td class="tag-row-actions">
                      <button
                        class="text-button"
                        :disabled="loading || saving"
                        :aria-label="`编辑设备组 ${group.name}`"
                        @click="edit(group)"
                      >
                        编辑</button
                      ><button
                        class="text-button"
                        :disabled="loading || saving"
                        :aria-label="`删除设备组 ${group.name}`"
                        @click="remove(group)"
                      >
                        删除
                      </button>
                    </td>
                  </tr>
                </tbody>
              </table>
            </div>
            <p v-if="!groups.length" class="field-hint">
              {{
                loading
                  ? "正在读取设备组…"
                  : "还没有设备组，可创建标签后在设备列表批量添加。"
              }}
            </p>
          </template>
          <form v-else @submit.prevent="save">
            <fieldset :disabled="saving || loading || uncertain">
              <template v-if="mode === 'create' || mode === 'edit'">
                <label
                  >设备组名称<input
                    v-model="draft.name"
                    required
                    maxlength="64" /></label
                ><label
                  >说明<textarea
                    v-model="draft.description"
                    maxlength="500"
                    rows="2"
                  ></textarea>
                </label>
                <fieldset class="tag-options">
                  <legend>组内设备（可不选）</legend>
                  <div class="tag-device-list">
                    <label
                      v-for="device in devices"
                      :key="device.id"
                      class="tag-check"
                      ><input
                        v-model="draft.device_ids"
                        type="checkbox"
                        :value="device.id"
                        :aria-label="`组内设备 ${device.name}`"
                      />{{ device.name }}</label
                    >
                  </div>
                  <p v-if="!devices.length" class="field-hint">
                    当前没有设备，可先创建空设备组。
                  </p>
                </fieldset>
              </template>
              <template v-else>
                <p>
                  对已选的 {{ targets.length }} 台设备{{
                    mode === "add" ? "添加" : "移除"
                  }}以下标签：
                </p>
                <p v-if="targets.length > 1000" class="notice danger">
                  一次最多处理 1000 台设备，请缩小选择范围。
                </p>
                <fieldset class="tag-options">
                  <legend>选择标签（可多选）</legend>
                  <label
                    v-for="group in groups"
                    :key="group.id"
                    class="tag-check"
                    ><input
                      v-model="tagIds"
                      type="checkbox"
                      :value="group.id"
                      :aria-label="`批量标签 ${group.name}`"
                    />{{ group.name }}</label
                  >
                  <p v-if="!groups.length" class="field-hint">
                    还没有设备组，请先在“管理设备组”中创建。
                  </p>
                </fieldset>
                <p class="field-hint">
                  仅{{
                    mode === "add" ? "添加" : "移除"
                  }}所选标签，保留其他标签，不改变用户授权和终端连接。
                </p>
              </template>
            </fieldset>
            <footer class="tag-actions">
              <button
                class="button primary"
                type="submit"
                :disabled="
                  saving ||
                  loading ||
                  uncertain ||
                  ((mode === 'add' || mode === 'remove') &&
                    (!tagIds.length || targets.length > 1000))
                "
              >
                {{
                  saving
                    ? "保存中…"
                    : mode === "add"
                      ? "确认添加"
                      : mode === "remove"
                        ? "确认移除"
                        : "保存设备组"
                }}</button
              ><button
                class="button secondary"
                type="button"
                :disabled="saving"
                @click="
                  mode === 'create' || mode === 'edit'
                    ? (mode = 'manage')
                    : dismiss()
                "
              >
                取消
              </button>
            </footer>
          </form>
        </section>
      </div>
    </Teleport>
  </div>
</template>
<style scoped>
.device-group-tools {
  min-width: 0;
}
.device-group-toolbar,
.tag-heading,
.tag-actions {
  display: flex;
  align-items: center;
  gap: 12px;
  flex-wrap: wrap;
}
.device-group-filter {
  display: flex;
  align-items: center;
  gap: 10px;
  min-width: 0;
  margin: 0;
  white-space: nowrap;
}
.device-group-filter select {
  width: 180px;
  min-height: 42px;
  margin: 0;
}
.selected-count {
  font-size: 13px;
  color: var(--muted);
}
.tag-overlay {
  position: fixed;
  inset: 0;
  z-index: 80;
  background: #0b1522a6;
  display: flex;
  align-items: center;
  justify-content: center;
  padding: 24px;
}
.tag-dialog {
  width: min(720px, 100%);
  max-height: calc(100dvh - 48px);
  overflow-y: auto;
  padding: 24px;
}
.tag-heading {
  justify-content: space-between;
  margin-bottom: 20px;
}
.tag-heading h2 {
  margin: 0;
}
.tag-dialog form,
.tag-dialog fieldset {
  display: grid;
  gap: 14px;
  min-width: 0;
}
.tag-dialog fieldset {
  border: 0;
  padding: 0;
  margin: 0;
}
.tag-dialog label {
  display: grid;
  gap: 7px;
}
.tag-dialog .tag-options {
  border: 1px solid var(--border, #dbe2e8);
  padding: 14px;
  border-radius: 8px;
}
.tag-options legend {
  padding: 0 6px;
  font-weight: 600;
}
.tag-dialog .tag-check {
  display: flex;
  gap: 9px;
  align-items: center;
  font-weight: 400;
}
.tag-check input {
  width: 16px;
  min-width: 16px;
  height: 16px;
  margin: 0;
}
.tag-device-list {
  display: grid;
  gap: 10px;
  max-height: 240px;
  overflow: auto;
}
.tag-table {
  overflow: auto;
  margin: 16px 0;
}
.tag-table table {
  width: 100%;
}
.tag-table small {
  display: block;
  margin-top: 5px;
  color: var(--muted);
}
.tag-row-actions {
  white-space: nowrap;
}
.tag-row-actions button + button {
  margin-left: 12px;
}
.tag-actions {
  margin-top: 18px;
}
.tag-dialog textarea {
  font: inherit;
  resize: vertical;
  width: 100%;
}
@media (max-width: 640px) {
  .tag-overlay {
    padding: 12px;
  }
  .tag-dialog {
    padding: 16px;
    max-height: calc(100dvh - 24px);
  }
  .device-group-toolbar {
    align-items: stretch;
  }
  .device-group-filter {
    width: 100%;
  }
  .device-group-filter select {
    flex: 1;
    min-width: 0;
    max-width: 100%;
  }
}
</style>
