<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, ref, useId } from "vue";
import type { Device, User } from "../api/types";
import { canExecute, hasPermission } from "../model";

type Action =
  | "root"
  | "advanced-terminal"
  | "accounts"
  | "connection"
  | "install"
  | "network"
  | "health"
  | "ssh"
  | "exec"
  | "revoke";
const props = withDefaults(
  defineProps<{
    device: Device;
    user: User;
    ready: boolean;
    agentEnabled?: boolean;
    busy: Partial<Record<Action | "terminal", boolean>>;
    revoking: boolean;
  }>(),
  { agentEnabled: true },
);
const emit = defineEmits<{ action: [kind: Action | "terminal"] }>();
const open = ref(false);
const trigger = ref<HTMLButtonElement>();
const menu = ref<HTMLElement>();
const menuId = useId();
const position = ref({ top: "0px", left: "0px" });
const actions = computed(() => {
  const active = !props.device.revoked_at;
  const admin = props.user.role === "admin" && active;
  const agent =
    props.agentEnabled !== false && props.device.connection_kind !== "ssh";
  const options: { kind: Action; label: string; visible: boolean }[] = [
    { kind: "connection", label: "接入配置", visible: admin },
    {
      kind: "accounts",
      label: "高级账号（兼容）",
      visible: admin,
    },
    {
      kind: "install",
      label: "安装 Agent",
      visible: props.agentEnabled !== false && admin && !agent,
    },
    {
      kind: "advanced-terminal",
      label: "选择已有账号（高级）",
      visible:
        active &&
        hasPermission(props.user, "terminal.connect", props.device.id),
    },
    { kind: "network", label: "网络记录", visible: agent },
    { kind: "health", label: "健康检查", visible: agent },
    {
      kind: "ssh",
      label: "SSH 连接",
      visible:
        active &&
        hasPermission(props.user, "terminal.connect", props.device.id),
    },
    {
      kind: "exec",
      label: "命令任务",
      visible: active && agent && canExecute(props.user, props.device.id),
    },
    {
      kind: "revoke",
      label: props.revoking ? "撤销中…" : "撤销访问权限",
      visible: admin,
    },
  ];
  return options.filter((option) => option.visible);
});
function close(restoreFocus = false) {
  open.value = false;
  document.removeEventListener("pointerdown", outside);
  document.removeEventListener("scroll", place, true);
  window.removeEventListener("resize", place);
  if (restoreFocus) trigger.value?.focus();
}
function outside(event: Event) {
  if (
    !menu.value?.contains(event.target as Node) &&
    !trigger.value?.contains(event.target as Node)
  )
    close();
}
function place() {
  if (!open.value || !trigger.value || !menu.value) return;
  const anchor = trigger.value.getBoundingClientRect();
  const bounds = menu.value.getBoundingClientRect();
  position.value = {
    left: `${Math.max(8, Math.min(anchor.right - bounds.width, window.innerWidth - bounds.width - 8))}px`,
    top: `${Math.max(8, anchor.bottom + bounds.height + 8 <= window.innerHeight ? anchor.bottom + 6 : anchor.top - bounds.height - 6)}px`,
  };
}
async function toggle() {
  if (open.value) return close(true);
  open.value = true;
  await nextTick();
  place();
  await nextTick();
  if (!open.value || !menu.value) return;
  document.addEventListener("pointerdown", outside);
  document.addEventListener("scroll", place, true);
  window.addEventListener("resize", place);
  menu.value
    .querySelector<HTMLButtonElement>("button:not(:disabled)")
    ?.focus({ preventScroll: true });
}
function select(kind: Action) {
  close(true);
  emit("action", kind);
}
function keydown(event: KeyboardEvent) {
  if (event.key === "Escape") {
    event.preventDefault();
    event.stopPropagation();
    close(true);
  } else if (["ArrowDown", "ArrowUp", "Home", "End"].includes(event.key)) {
    event.preventDefault();
    const buttons = [
      ...menu.value!.querySelectorAll<HTMLButtonElement>(
        "button:not(:disabled)",
      ),
    ];
    const current = buttons.indexOf(
      document.activeElement as HTMLButtonElement,
    );
    const index =
      event.key === "Home"
        ? 0
        : event.key === "End"
          ? buttons.length - 1
          : (current + (event.key === "ArrowDown" ? 1 : -1) + buttons.length) %
            buttons.length;
    buttons[index]?.focus();
  }
}
function focusout(event: FocusEvent) {
  if (
    !menu.value?.contains(event.relatedTarget as Node) &&
    event.relatedTarget !== trigger.value
  )
    close();
}
onBeforeUnmount(() => close());
</script>

<template>
  <div class="device-actions">
    <button
      v-if="
        !device.revoked_at && hasPermission(user, 'terminal.connect', device.id)
      "
      class="button primary small"
      :disabled="
        !ready ||
        !(device.terminal_available ?? device.control_online) ||
        busy.terminal
      "
      @click="emit('action', 'terminal')"
    >
      连接终端
    </button>
    <button
      v-if="
        !device.revoked_at &&
        hasPermission(user, 'terminal.connect', device.id) &&
        hasPermission(user, 'terminal.sudo', device.id)
      "
      class="button secondary small"
      :disabled="
        !ready ||
        !(device.terminal_available ?? device.control_online) ||
        busy.root
      "
      style="grid-column: 1 / -1; grid-row: 2"
      @click="emit('action', 'root')"
    >
      以 root 连接
    </button>
    <button
      v-if="actions.length"
      ref="trigger"
      class="button secondary small"
      :aria-label="`更多操作：${device.name}`"
      aria-haspopup="menu"
      :aria-controls="menuId"
      :aria-expanded="open"
      @click="toggle"
      @keydown.down.prevent="!open && toggle()"
    >
      更多 <span aria-hidden="true">⌄</span>
    </button>
    <span v-if="!actions.length && device.revoked_at" class="muted small"
      >只读</span
    >
    <Teleport to="body">
      <div
        v-if="open"
        :id="menuId"
        ref="menu"
        role="menu"
        :aria-label="`设备操作：${device.name}`"
        class="device-action-menu"
        :style="position"
        @keydown="keydown"
        @focusout="focusout"
      >
        <button
          v-for="action in actions"
          :key="action.kind"
          role="menuitem"
          :class="{ 'danger-action': action.kind === 'revoke' }"
          :disabled="!ready || busy[action.kind]"
          @click="select(action.kind)"
        >
          {{ action.label }}
        </button>
      </div>
    </Teleport>
  </div>
</template>

<style scoped>
.device-actions {
  display: grid;
  grid-template-columns: max-content max-content;
  align-items: center;
  gap: 8px;
}
.device-actions > [aria-haspopup="menu"] {
  grid-column: 2;
  grid-row: 1;
}
.device-action-menu {
  position: fixed;
  z-index: 100;
  width: 188px;
  max-width: calc(100vw - 16px);
  max-height: calc(100vh - 16px);
  overflow-y: auto;
  padding: 6px;
  background: white;
  border: 1px solid var(--border);
  border-radius: 8px;
  box-shadow: 0 8px 28px #14253625;
}
.device-action-menu button {
  display: block;
  width: 100%;
  padding: 10px 12px;
  border: 0;
  border-radius: 4px;
  background: white;
  color: #415363;
  text-align: left;
  font-size: 13px;
}
.device-action-menu button:hover:not(:disabled),
.device-action-menu button:focus-visible {
  background: #edf6f4;
}
.device-action-menu .danger-action {
  color: #b83b42;
  margin-top: 4px;
  border-top: 1px solid var(--border);
  border-radius: 0 0 4px 4px;
}
</style>
