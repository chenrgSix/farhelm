<script setup lang="ts">
import DevicePicker from "./DevicePicker.vue";
import { computed, onBeforeUnmount, onMounted, ref } from "vue";
import {
  PASSWORD_HINT,
  PASSWORD_PATTERN,
  isAccountPassword,
} from "../password-policy";
import { api } from "../api/client";
import type {
  AccessManagement,
  Device,
  ManagedUser,
  ManagedRole,
  ManagedGroup,
  ManagedDeviceGroup,
  Permission,
} from "../api/types";
const props = defineProps<{
  currentUserId: string;
  devices: Device[];
  section?: "users" | "roles" | "groups";
}>();
const data = ref<AccessManagement>();
const tab = ref<"users" | "roles" | "groups">(props.section ?? "users");
const search = ref("");
const loading = ref(false),
  saving = ref(false),
  error = ref(""),
  notice = ref("");
const mode = ref<"user" | "role" | "group" | "password" | null>(null);
const editing = ref<{ id: string; revision: number; builtin?: boolean }>();
const formError = ref(""),
  uncertain = ref(false);
const initial = () => ({
  username: "",
  password: "",
  name: "",
  description: "",
  enabled: true,
  must_change_password: true,
  role_ids: [] as string[],
  group_ids: [] as string[],
  member_ids: [] as string[],
  permissions: [] as Permission[],
  all_devices: false,
  device_ids: [] as string[],
});
const draft = ref(initial());
let disposed = false;
const labels = {
  users: "用户",
  roles: "角色",
  groups: "用户组",
};
const title = computed(() =>
  mode.value === "password"
    ? "重置密码"
    : `${editing.value ? (editing.value.builtin ? "查看" : "编辑") : "创建"}${mode.value === "user" ? "用户" : mode.value === "role" ? "角色" : "用户组"}`,
);
const filteredUsers = computed(
  () =>
    data.value?.users.filter((u) =>
      `${u.username} ${u.role_names.join(" ")}`
        .toLowerCase()
        .includes(search.value.toLowerCase()),
    ) ?? [],
);
const filteredRoles = computed(
  () =>
    data.value?.roles.filter((r) =>
      `${r.name} ${r.description}`
        .toLowerCase()
        .includes(search.value.toLowerCase()),
    ) ?? [],
);
const filteredGroups = computed(
  () =>
    data.value?.groups.filter((g) =>
      `${g.name} ${g.description}`
        .toLowerCase()
        .includes(search.value.toLowerCase()),
    ) ?? [],
);
const adminGrant = computed(
  () =>
    draft.value.role_ids.includes("admin") ||
    data.value?.groups.some(
      (g) =>
        draft.value.group_ids.includes(g.id) && g.role_ids.includes("admin"),
    ),
);
const scope = () =>
  draft.value.all_devices ? ("*" as const) : [...draft.value.device_ids];
function names(ids: string[], kind: "roles" | "groups") {
  return (
    ids
      .map((id) => data.value?.[kind].find((x) => x.id === id)?.name ?? id)
      .join("、") || "未分配"
  );
}
function scopeLabel(value: "*" | string[]) {
  return value === "*"
    ? "全部设备"
    : value.length
      ? `${value.length} 台设备`
      : "无设备权限";
}
async function load() {
  if (loading.value) return;
  loading.value = true;
  error.value = "";
  try {
    const response = await api.request<AccessManagement>("/access");
    if (!disposed) data.value = response;
  } catch (e) {
    if (!disposed)
      error.value = e instanceof Error ? e.message : "读取用户权限失败";
  } finally {
    if (!disposed) loading.value = false;
  }
}
function open(
  kind: "user" | "role" | "group" | "password",
  item?: ManagedUser | ManagedRole | ManagedGroup,
) {
  if (saving.value || loading.value) return;
  mode.value = kind;
  editing.value = item
    ? {
        id: item.id,
        revision: item.revision,
        builtin: "builtin" in item ? item.builtin : false,
      }
    : undefined;
  draft.value = initial();
  formError.value = "";
  uncertain.value = false;
  if (item) {
    if ("username" in item)
      Object.assign(draft.value, {
        username: item.username,
        enabled: item.enabled,
        role_ids: [...item.role_ids],
        group_ids: [...item.group_ids],
      });
    else
      Object.assign(draft.value, {
        name: item.name,
        description: item.description,
      });
    if ("permissions" in item) draft.value.permissions = [...item.permissions];
    if ("member_ids" in item)
      Object.assign(draft.value, {
        member_ids: [...item.member_ids],
        role_ids: [...item.role_ids],
      });
    if ("device_scope" in item) {
      draft.value.all_devices = item.device_scope === "*";
      draft.value.device_ids = Array.isArray(item.device_scope)
        ? [...item.device_scope]
        : [];
    }
  }
}
function dismiss() {
  if (!saving.value) {
    mode.value = null;
    draft.value.password = "";
  }
}
function selectDeviceGroup(group: ManagedDeviceGroup, selected: boolean) {
  draft.value.device_ids = selected
    ? [...new Set([...draft.value.device_ids, ...group.device_ids])]
    : draft.value.device_ids.filter((id) => !group.device_ids.includes(id));
}
function permissionChanged() {
  const selected = new Set(draft.value.permissions);
  if (selected.size) selected.add("devices.read");
  if (selected.has("terminal.sudo")) selected.add("terminal.connect");
  if (selected.has("tasks.execute") || selected.has("tasks.read_all"))
    selected.add("tasks.read");
  if (selected.has("audit.read_all")) selected.add("audit.read");
  if (selected.has("recordings.read_all")) selected.add("recordings.read");
  draft.value.permissions = [...selected];
}
async function save() {
  if (saving.value || uncertain.value || editing.value?.builtin || !mode.value)
    return;
  if (
    (mode.value === "password" || (mode.value === "user" && !editing.value)) &&
    !isAccountPassword(draft.value.password)
  ) {
    formError.value = PASSWORD_HINT;
    return;
  }
  saving.value = true;
  formError.value = "";
  notice.value = "";
  const kind = mode.value,
    existing = editing.value;
  const common = { v: 1, ...(existing ? { revision: existing.revision } : {}) };
  let path = "",
    body: unknown;
  if (kind === "user") {
    path = "/users" + (existing ? `/${encodeURIComponent(existing.id)}` : "");
    body = {
      ...common,
      username: draft.value.username.trim(),
      enabled: draft.value.enabled,
      role_ids: [...draft.value.role_ids],
      group_ids: [...draft.value.group_ids],
      device_scope: scope(),
      ...(!existing
        ? {
            password: draft.value.password,
            must_change_password: draft.value.must_change_password,
          }
        : {}),
    };
  } else if (kind === "password") {
    path = `/users/${encodeURIComponent(existing!.id)}/password`;
    body = { ...common, password: draft.value.password };
  } else if (kind === "role") {
    path = "/roles" + (existing ? `/${encodeURIComponent(existing.id)}` : "");
    body = {
      ...common,
      name: draft.value.name.trim(),
      description: draft.value.description.trim(),
      permissions: [...draft.value.permissions],
    };
  } else {
    path = "/groups" + (existing ? `/${encodeURIComponent(existing.id)}` : "");
    body = {
      ...common,
      name: draft.value.name.trim(),
      description: draft.value.description.trim(),
      role_ids: [...draft.value.role_ids],
      member_ids: [...draft.value.member_ids],
      device_scope: scope(),
    };
  }
  try {
    await api.request(path, {
      method: existing && kind !== "password" ? "PUT" : "POST",
      body,
    });
    if (disposed) return;
    draft.value.password = "";
    mode.value = null;
    notice.value =
      "已保存。修改账号、角色、用户组或密码的受影响用户需要重新登录。";
    await load();
  } catch (e) {
    if (disposed) return;
    draft.value.password = "";
    formError.value = e instanceof Error ? e.message : "保存失败";
    uncertain.value = /ACCESS_REVISION_CONFLICT|请求超时|无法连接 API/.test(
      formError.value,
    );
    if (uncertain.value)
      formError.value += " 请关闭表单并刷新列表，核对最新状态后再编辑。";
  } finally {
    if (!disposed) saving.value = false;
  }
}
async function toggleUser(user: ManagedUser) {
  if (saving.value || loading.value || user.id === props.currentUserId) return;
  if (
    !window.confirm(
      `${user.enabled ? "禁用" : "启用"}用户“${user.username}”？该用户现有登录和终端连接会失效。`,
    )
  )
    return;
  saving.value = true;
  error.value = "";
  notice.value = "";
  try {
    await api.request(`/users/${encodeURIComponent(user.id)}`, {
      method: "PUT",
      body: {
        v: 1,
        revision: user.revision,
        username: user.username,
        enabled: !user.enabled,
        role_ids: user.role_ids,
        group_ids: user.group_ids,
        device_scope: user.device_scope,
      },
    });
    if (!disposed) {
      notice.value = "账号状态已更新。";
      await load();
    }
  } catch (e) {
    if (!disposed) error.value = e instanceof Error ? e.message : "更新失败";
  } finally {
    if (!disposed) saving.value = false;
  }
}
async function remove(
  kind: "roles" | "groups",
  item: ManagedRole | ManagedGroup,
) {
  if (saving.value || loading.value) return;
  if (
    !window.confirm(
      `删除${labels[kind]}“${item.name}”？${kind === "groups" ? "组成员继承的角色和设备权限将被撤销，现有登录和终端连接会失效。" : "正在分配使用的角色不能删除。"}`,
    )
  )
    return;
  saving.value = true;
  error.value = "";
  notice.value = "";
  try {
    await api.request(`/${kind}/${encodeURIComponent(item.id)}`, {
      method: "DELETE",
      body: { v: 1, revision: item.revision },
    });
    if (!disposed) {
      notice.value = "已删除。";
      await load();
    }
  } catch (e) {
    if (!disposed) error.value = e instanceof Error ? e.message : "删除失败";
  } finally {
    if (!disposed) saving.value = false;
  }
}
onMounted(load);
onBeforeUnmount(() => {
  disposed = true;
  draft.value.password = "";
});
</script>

<template>
  <section class="panel access-panel" aria-label="用户与权限管理">
    <div class="access-heading">
      <div>
        <h2>{{ props.section ? labels[props.section] : "用户与角色" }}</h2>
        <p class="muted">
          用户组组织人员，角色分配操作权限。设备与登录账号的新增授权统一在「访问授权」中配置。
        </p>
      </div>
      <button
        class="button secondary"
        :disabled="loading || saving || !!mode"
        @click="load"
      >
        刷新权限列表
      </button>
    </div>
    <p v-if="error" class="notice danger" role="alert">{{ error }}</p>
    <p v-if="notice" class="notice" role="status">{{ notice }}</p>
    <div
      v-if="!props.section"
      class="access-tabs"
      role="tablist"
      aria-label="权限管理分类"
    >
      <button
        v-for="key in ['users', 'roles', 'groups'] as const"
        :key="key"
        role="tab"
        :aria-selected="tab === key"
        :class="['button', tab === key ? 'primary' : 'secondary']"
        @click="
          tab = key;
          search = '';
        "
      >
        {{ labels[key] }} <span v-if="data">{{ data[key].length }}</span>
      </button>
    </div>
    <div class="access-toolbar">
      <input
        v-model="search"
        type="search"
        :aria-label="`搜索${labels[tab]}`"
        :placeholder="`搜索${labels[tab]}名称`"
      />
      <button
        class="button primary"
        :disabled="loading || saving || !data"
        @click="
          open(tab === 'users' ? 'user' : tab === 'roles' ? 'role' : 'group')
        "
      >
        创建{{ labels[tab] }}
      </button>
    </div>
    <p v-if="tab === 'roles'" class="muted">
      默认角色为管理员和普通用户，普通用户仅有查看权限。运维、审计权限可按需创建自定义角色。
    </p>
    <p v-if="loading && !data" class="muted">正在读取权限配置…</p>
    <div v-if="data" class="access-table">
      <table v-if="tab === 'users'">
        <thead>
          <tr>
            <th>账号</th>
            <th>状态</th>
            <th>生效角色</th>
            <th>用户组</th>
            <th>可访问设备</th>
            <th>操作</th>
          </tr>
        </thead>
        <tbody>
          <tr v-for="item in filteredUsers" :key="item.id">
            <td>
              <strong>{{ item.username }}</strong
              ><small v-if="item.id === currentUserId" class="muted"
                >（当前账号）</small
              >
            </td>
            <td>
              {{ item.enabled ? "启用" : "停用"
              }}<small v-if="item.must_change_password" class="muted"
                >待首次改密</small
              >
            </td>
            <td>{{ item.role_names.join("、") || "未分配" }}</td>
            <td>{{ names(item.group_ids, "groups") }}</td>
            <td>{{ scopeLabel(item.effective_device_scope) }}</td>
            <td>
              <div class="access-row-actions">
                <button
                  class="text-button"
                  :disabled="saving"
                  @click="open('user', item)"
                  :aria-label="`编辑用户 ${item.username}`"
                >
                  编辑
                </button>
                <button
                  class="text-button"
                  :disabled="saving"
                  @click="open('password', item)"
                  :aria-label="`重置密码 ${item.username}`"
                >
                  重置密码
                </button>
                <button
                  class="text-button"
                  :disabled="saving || item.id === currentUserId"
                  @click="toggleUser(item)"
                  :aria-label="`${item.enabled ? '禁用' : '启用'}用户 ${item.username}`"
                >
                  {{ item.enabled ? "禁用" : "启用" }}
                </button>
              </div>
            </td>
          </tr>
          <tr v-if="!filteredUsers.length">
            <td colspan="6" class="muted">没有匹配的用户</td>
          </tr>
        </tbody>
      </table>
      <table v-else-if="tab === 'roles'">
        <thead>
          <tr>
            <th>角色</th>
            <th>权限</th>
            <th>分配情况</th>
            <th>操作</th>
          </tr>
        </thead>
        <tbody>
          <tr v-for="item in filteredRoles" :key="item.id">
            <td>
              <strong>{{ item.name }}</strong
              ><small class="muted">{{
                item.builtin ? "内置角色" : item.description
              }}</small>
            </td>
            <td>
              {{
                item.id === "admin"
                  ? "全平台管理权限"
                  : item.permissions
                      .map(
                        (p) => data?.permissions.find((x) => x.id === p)?.label,
                      )
                      .join("、") || "无操作权限"
              }}
            </td>
            <td>
              {{ item.user_count }} 个直接用户 · {{ item.group_count }} 个用户组
            </td>
            <td>
              <div class="access-row-actions">
                <button
                  class="text-button"
                  :disabled="saving"
                  @click="open('role', item)"
                  :aria-label="`${item.builtin ? '查看' : '编辑'}角色 ${item.name}`"
                >
                  {{ item.builtin ? "查看" : "编辑" }}</button
                ><button
                  v-if="!item.builtin"
                  class="text-button"
                  :disabled="saving || !!item.user_count || !!item.group_count"
                  @click="remove('roles', item)"
                  :aria-label="`删除角色 ${item.name}`"
                >
                  删除
                </button>
              </div>
            </td>
          </tr>
          <tr v-if="!filteredRoles.length">
            <td colspan="4" class="muted">没有匹配的角色</td>
          </tr>
        </tbody>
      </table>
      <table v-else-if="tab === 'groups'">
        <thead>
          <tr>
            <th>用户组</th>
            <th>组角色</th>
            <th>成员</th>
            <th>设备范围</th>
            <th>操作</th>
          </tr>
        </thead>
        <tbody>
          <tr v-for="item in filteredGroups" :key="item.id">
            <td>
              <strong>{{ item.name }}</strong
              ><small class="muted">{{ item.description }}</small>
            </td>
            <td>{{ names(item.role_ids, "roles") }}</td>
            <td>{{ item.member_ids.length }} 人</td>
            <td>
              {{
                item.role_ids.includes("admin")
                  ? "全部设备（管理员）"
                  : scopeLabel(item.device_scope)
              }}
            </td>
            <td>
              <div class="access-row-actions">
                <button
                  class="text-button"
                  :disabled="saving"
                  @click="open('group', item)"
                  :aria-label="`编辑用户组 ${item.name}`"
                >
                  编辑</button
                ><button
                  class="text-button"
                  :disabled="saving"
                  @click="remove('groups', item)"
                  :aria-label="`删除用户组 ${item.name}`"
                >
                  删除
                </button>
              </div>
            </td>
          </tr>
          <tr v-if="!filteredGroups.length">
            <td colspan="5" class="muted">
              还没有匹配的用户组，可创建后批量分配角色和设备
            </td>
          </tr>
        </tbody>
      </table>
    </div>
    <p class="access-note muted">
      用户直接分配和所属组的角色权限取并集；设备范围也取并集。所有生效权限均适用于合并后的设备范围。设备组仅作可选分类标签，用于批量选择设备；调整标签不会自动改变授权。设备可加入多个组，也可不加入任何组，新设备默认未分组。管理员可管理所有设备和平台设置。
    </p>
    <Teleport to="body">
      <div
        v-if="mode"
        class="access-overlay"
        @click.self="dismiss"
        @keydown.esc="dismiss"
      >
        <section
          class="panel access-dialog"
          role="dialog"
          aria-modal="true"
          aria-labelledby="access-form-title"
        >
          <div class="access-heading">
            <h2 id="access-form-title">{{ title }}</h2>
            <button
              class="button secondary"
              type="button"
              :disabled="saving"
              @click="dismiss"
            >
              关闭表单
            </button>
          </div>
          <form @submit.prevent="save">
            <p v-if="formError" class="notice danger" role="alert">
              {{ formError }}
            </p>
            <fieldset :disabled="saving || !!editing?.builtin || uncertain">
              <template v-if="mode === 'user' || mode === 'password'">
                <label
                  >账号<input
                    v-model="draft.username"
                    :disabled="mode === 'password'"
                    required
                    maxlength="64"
                    pattern="[A-Za-z0-9][A-Za-z0-9_.@\-]{0,63}"
                    autocomplete="off"
                /></label>
                <p v-if="mode === 'user'" class="field-hint">
                  使用英文字母、数字、点、下划线、@ 或短横线，以字母或数字开头。
                </p>
                <label v-if="!editing || mode === 'password'"
                  >{{ mode === "password" ? "新密码" : "初始密码"
                  }}<input
                    v-model="draft.password"
                    type="password"
                    minlength="8"
                    :pattern="PASSWORD_PATTERN"
                    maxlength="1024"
                    required
                    autocomplete="new-password"
                /></label>
                <p v-if="!editing || mode === 'password'" class="field-hint">
                  {{ PASSWORD_HINT }}保存后无法查看密码。
                </p>
                <label v-if="mode === 'user' && !editing" class="access-check"
                  ><input
                    v-model="draft.must_change_password"
                    type="checkbox"
                  /><span
                    >首次登录时强制修改密码<small
                      >用户需先在网页设置自己的密码，之后才能使用设备和 SSH
                      入口。</small
                    ></span
                  ></label
                >
                <label v-if="mode === 'user'" class="access-check"
                  ><input
                    v-model="draft.enabled"
                    type="checkbox"
                    :disabled="editing?.id === currentUserId"
                  />启用账号</label
                >
              </template>
              <template v-if="mode === 'role' || mode === 'group'">
                <label
                  >{{ mode === "role" ? "角色名称" : "用户组名称"
                  }}<input v-model="draft.name" required maxlength="64"
                /></label>
                <label
                  >说明<textarea
                    v-model="draft.description"
                    maxlength="500"
                    rows="2"
                  ></textarea>
                </label>
              </template>
              <fieldset v-if="mode === 'role'" class="access-options">
                <legend>操作权限</legend>
                <p v-if="editing?.builtin" class="field-hint">
                  内置角色不可修改。{{
                    editing?.id === "admin"
                      ? "管理员还拥有用户、设备接入、升级和系统设置管理权限。"
                      : "可创建自定义角色选择需要的权限。"
                  }}
                </p>
                <label
                  v-for="permission in data?.permissions"
                  :key="permission.id"
                  class="access-check"
                  ><input
                    v-model="draft.permissions"
                    type="checkbox"
                    :value="permission.id"
                    :disabled="
                      (permission.id === 'terminal.connect' &&
                        draft.permissions.includes('terminal.sudo')) ||
                      (permission.id === 'devices.read' &&
                        draft.permissions.some((p) => p !== 'devices.read')) ||
                      (permission.id === 'tasks.read' &&
                        (draft.permissions.includes('tasks.execute') ||
                          draft.permissions.includes('tasks.read_all'))) ||
                      (permission.id === 'audit.read' &&
                        draft.permissions.includes('audit.read_all')) ||
                      (permission.id === 'recordings.read' &&
                        draft.permissions.includes('recordings.read_all'))
                    "
                    @change="permissionChanged"
                  /><span
                    >{{ permission.label
                    }}<small>{{ permission.description }}</small></span
                  ></label
                >
              </fieldset>
              <fieldset
                v-if="mode === 'user' || mode === 'group'"
                class="access-options"
              >
                <legend>
                  {{ mode === "user" ? "直接分配角色" : "组角色" }}
                </legend>
                <label
                  v-for="role in data?.roles"
                  :key="role.id"
                  class="access-check"
                  ><input
                    v-model="draft.role_ids"
                    type="checkbox"
                    :value="role.id"
                    :aria-label="`分配角色 ${role.name}`"
                  />{{ role.name
                  }}{{ role.id === "admin" ? "（全平台权限）" : "" }}</label
                >
              </fieldset>
              <fieldset v-if="mode === 'user'" class="access-options">
                <legend>所属用户组</legend>
                <p v-if="!data?.groups.length" class="field-hint">
                  尚无用户组，可先创建用户，再到用户组中添加成员。
                </p>
                <label
                  v-for="group in data?.groups"
                  :key="group.id"
                  class="access-check"
                  ><input
                    v-model="draft.group_ids"
                    type="checkbox"
                    :value="group.id"
                    :aria-label="`加入用户组 ${group.name}`"
                  />{{ group.name
                  }}<small>{{ names(group.role_ids, "roles") }}</small></label
                >
              </fieldset>
              <fieldset v-if="mode === 'group'" class="access-options">
                <legend>组成员</legend>
                <label
                  v-for="member in data?.users"
                  :key="member.id"
                  class="access-check"
                  ><input
                    v-model="draft.member_ids"
                    type="checkbox"
                    :value="member.id"
                    :aria-label="`组成员 ${member.username}`"
                  />{{ member.username
                  }}{{ member.enabled ? "" : "（停用）" }}</label
                >
              </fieldset>
              <div
                v-if="mode === 'user' || mode === 'group'"
                class="legacy-device-scope"
              >
                <p class="field-hint">
                  选择可访问的设备；角色决定是否可以连接终端及使用
                  sudo／root。已有精确账号规则继续生效，可在高级授权中维护。
                </p>
                <fieldset class="access-options">
                  <legend>允许访问的设备</legend>
                  <p v-if="adminGrant" class="field-hint">
                    管理员角色拥有全部设备权限，不受下方范围限制。
                  </p>
                  <label class="access-check"
                    ><input
                      v-model="draft.all_devices"
                      type="checkbox"
                    />全部设备（含以后添加的设备）</label
                  >
                  <div v-if="!draft.all_devices" class="access-device-list">
                    <strong>按设备组批量选择</strong
                    ><label
                      v-for="group in data?.device_groups"
                      :key="group.id"
                      class="access-check"
                      ><input
                        type="checkbox"
                        :checked="
                          group.device_ids.length > 0 &&
                          group.device_ids.every((id) =>
                            draft.device_ids.includes(id),
                          )
                        "
                        :indeterminate="
                          group.device_ids.some((id) =>
                            draft.device_ids.includes(id),
                          ) &&
                          !group.device_ids.every((id) =>
                            draft.device_ids.includes(id),
                          )
                        "
                        :disabled="!group.device_ids.length"
                        :aria-label="`批量选择设备组 ${group.name}`"
                        @change="
                          selectDeviceGroup(
                            group,
                            ($event.target as HTMLInputElement).checked,
                          )
                        "
                      />{{ group.name }}
                      <small>{{ group.device_ids.length }} 台</small></label
                    >
                    <p class="field-hint">
                      只勾选组内当前设备，保存后调整设备组不会自动改变授权。
                    </p>
                    <strong>已选设备与单台选择</strong>
                  </div>
                  <DevicePicker
                    v-if="!draft.all_devices"
                    v-model="draft.device_ids"
                    label="授权设备"
                    :seed="devices"
                    :disabled="saving"
                  />
                  <p class="field-hint">
                    未选择设备时，仅保留其他来源的设备授权。组角色与直接角色合并后，可用于所有已授权设备。
                  </p>
                </fieldset>
              </div>
            </fieldset>
            <p v-if="editing && !editing.builtin" class="field-hint">
              修改用户、角色或用户组授权会使受影响用户的现有登录和终端连接失效；设备标签不影响权限。当前管理员不能停用自己或移除自己的管理员权限。
            </p>
            <div class="access-form-actions">
              <button
                v-if="!editing?.builtin"
                class="button primary"
                type="submit"
                :disabled="saving || uncertain"
              >
                {{
                  saving ? "保存中…" : mode === "password" ? "重置密码" : "保存"
                }}</button
              ><button
                class="button secondary"
                type="button"
                :disabled="saving"
                @click="dismiss"
              >
                {{ editing?.builtin ? "关闭" : "取消" }}
              </button>
            </div>
          </form>
        </section>
      </div>
    </Teleport>
  </section>
</template>

<style scoped>
.access-panel {
  padding: 24px;
}
.access-heading,
.access-toolbar,
.access-row-actions,
.access-form-actions,
.access-tabs {
  display: flex;
  align-items: center;
  gap: 12px;
  flex-wrap: wrap;
}
.access-heading {
  justify-content: space-between;
  gap: 16px;
  margin-bottom: 20px;
}
.access-heading h2 {
  margin: 0;
}
.access-heading p {
  margin: 8px 0 0;
}
.access-toolbar {
  justify-content: space-between;
  margin: 20px 0;
}
.access-toolbar input {
  margin-top: 0;
  padding-block: 9px;
  max-width: 360px;
  flex: 1;
  min-width: 160px;
}
.access-table {
  overflow-x: auto;
}
.access-table table {
  width: 100%;
  min-width: 720px;
  white-space: normal;
}
.access-table td {
  max-width: 350px;
  overflow-wrap: anywhere;
}
.access-table td small {
  display: block;
  margin-top: 5px;
}
.access-row-actions {
  min-width: 150px;
}
.access-row-actions .text-button {
  white-space: nowrap;
}
.access-note {
  line-height: 1.65;
  margin: 20px 0 0;
  font-size: 13px;
}
.access-overlay {
  position: fixed;
  inset: 0;
  background: #0b1522a6;
  z-index: 80;
  display: flex;
  align-items: center;
  justify-content: center;
  padding: 24px;
}
.access-dialog {
  width: min(700px, 100%);
  max-height: calc(100dvh - 48px);
  overflow-y: auto;
  padding: 24px;
}
.access-dialog form,
.access-dialog fieldset {
  display: grid;
  gap: 14px;
  min-width: 0;
}
.access-dialog fieldset {
  border: 0;
  padding: 0;
  margin: 0;
}
.access-dialog label {
  display: grid;
  gap: 7px;
  margin: 0;
}
.access-dialog label > input:not([type="checkbox"]):not([type="radio"]),
.access-dialog label > select,
.access-dialog label > textarea {
  margin-top: 0;
}
.access-dialog .field-hint {
  margin: 0;
}
.access-dialog .access-options {
  border: 1px solid var(--border, #dbe2e8);
  padding: 14px;
  border-radius: 8px;
  gap: 10px;
}
.access-options legend {
  padding: 0 7px;
  font-weight: 600;
}
.access-dialog .access-check {
  display: flex;
  align-items: flex-start;
  gap: 9px;
  font-weight: 400;
}
.access-check input {
  width: 16px;
  min-width: 16px;
  height: 16px;
  margin: 3px 0 0;
}
.access-check small {
  display: block;
  color: var(--muted, #657080);
  font-size: 12px;
}
.access-device-list {
  display: grid;
  gap: 10px;
  max-height: 200px;
  overflow: auto;
}
.access-form-actions {
  justify-content: flex-end;
  padding-top: 8px;
}
.access-dialog textarea {
  width: 100%;
  resize: vertical;
  font: inherit;
}
@media (max-width: 640px) {
  .access-panel {
    padding: 16px;
  }
  .access-overlay {
    padding: 12px;
  }
  .access-dialog {
    padding: 16px;
    max-height: calc(100dvh - 24px);
  }
  .access-toolbar input {
    max-width: none;
  }
}
</style>
