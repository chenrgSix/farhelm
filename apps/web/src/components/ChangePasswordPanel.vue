<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, ref } from "vue";
import {
  PASSWORD_HINT,
  PASSWORD_PATTERN,
  isAccountPassword,
} from "../password-policy";
import { api, ApiError } from "../api/client";
defineProps<{ username: string }>();
const emit = defineEmits<{ close: []; changed: []; unconfirmed: [] }>();
const dialog = ref<HTMLDialogElement>();
const currentInput = ref<HTMLInputElement>();
const currentPassword = ref("");
const newPassword = ref("");
const confirmation = ref("");
const busy = ref(false);
const error = ref("");
const mismatch = computed(
  () => !!confirmation.value && newPassword.value !== confirmation.value,
);
const canSave = computed(
  () =>
    currentPassword.value.length > 0 &&
    isAccountPassword(newPassword.value) &&
    newPassword.value === confirmation.value &&
    currentPassword.value !== newPassword.value,
);
let disposed = false;
let previousFocus: HTMLElement | null = null;
onMounted(() => {
  previousFocus = document.activeElement as HTMLElement | null;
  dialog.value?.showModal();
  currentInput.value?.focus();
});
function clear() {
  currentPassword.value = newPassword.value = confirmation.value = "";
}
onBeforeUnmount(() => {
  disposed = true;
  clear();
  dialog.value?.close();
  if (previousFocus?.isConnected) previousFocus.focus();
});
function close() {
  if (!busy.value) emit("close");
}
async function save() {
  if (busy.value || !canSave.value) return;
  busy.value = true;
  error.value = "";
  try {
    await api.request("/me/password", {
      method: "POST",
      body: {
        v: 1,
        current_password: currentPassword.value,
        new_password: newPassword.value,
      },
    });
    clear();
    if (!disposed) emit("changed");
  } catch (e) {
    if (disposed) return;
    if (e instanceof ApiError && e.status === 0) {
      clear();
      emit("unconfirmed");
      return;
    }
    const message = e instanceof Error ? e.message : "修改密码失败";
    error.value = message.includes("CURRENT_PASSWORD_INCORRECT")
      ? "当前密码不正确，请重新输入。"
      : message.includes("PASSWORD_UNCHANGED")
        ? "新密码不能与当前密码相同。"
        : e instanceof ApiError && e.status === 429
          ? "尝试次数过多，请一分钟后再试。"
          : message;
    currentPassword.value = "";
  } finally {
    if (!disposed) {
      busy.value = false;
      if (error.value) {
        await nextTick();
        if (!disposed) currentInput.value?.focus();
      }
    }
  }
}
</script>

<template>
  <dialog
    ref="dialog"
    class="panel password-dialog"
    aria-labelledby="password-title"
    aria-describedby="password-effect"
    @cancel.prevent="close"
  >
    <div class="panel-heading">
      <div>
        <h2 id="password-title">修改密码</h2>
        <p class="muted">当前账号：{{ username }}</p>
      </div>
      <button
        class="icon-button"
        type="button"
        aria-label="关闭修改密码"
        :disabled="busy"
        @click="close"
      >
        ×
      </button>
    </div>
    <form @submit.prevent="save">
      <p id="password-effect" class="muted">
        修改后，本账号在所有浏览器和 SSH
        入口的登录都会失效，已有终端会断开。请先完成终端中的操作，再使用新密码重新登录。
      </p>
      <fieldset :disabled="busy">
        <label
          >当前密码<input
            ref="currentInput"
            v-model="currentPassword"
            name="current-password"
            type="password"
            autocomplete="current-password"
            required
            maxlength="1024"
        /></label>
        <label
          >新密码<input
            v-model="newPassword"
            name="new-password"
            type="password"
            autocomplete="new-password"
            required
            minlength="8"
            maxlength="1024"
            :pattern="PASSWORD_PATTERN"
            aria-describedby="password-length"
        /></label>
        <p id="password-length" class="field-hint">
          {{ PASSWORD_HINT }}新密码不能与当前密码相同。
        </p>
        <label
          >确认新密码<input
            v-model="confirmation"
            name="confirm-password"
            type="password"
            autocomplete="new-password"
            required
            minlength="8"
            maxlength="1024"
            :aria-invalid="mismatch"
        /></label>
        <p v-if="mismatch" class="text-warning" role="alert">
          两次输入的新密码不一致。
        </p>
      </fieldset>
      <p v-if="error" class="text-warning" role="alert">{{ error }}</p>
      <div class="password-actions">
        <button class="button" type="button" :disabled="busy" @click="close">
          取消
        </button>
        <button
          class="button primary"
          type="submit"
          :disabled="busy || !canSave"
        >
          {{ busy ? "正在修改…" : "确认修改" }}
        </button>
      </div>
    </form>
  </dialog>
</template>
<style scoped>
.password-dialog {
  width: min(520px, calc(100vw - 32px));
  max-height: calc(100dvh - 32px);
  overflow: auto;
  padding: 0;
  border: 1px solid #dae3e9;
  margin: auto;
}
.password-dialog::backdrop {
  background: #10202c80;
}
.panel-heading {
  padding: 20px 24px 12px;
  align-items: flex-start;
}
form {
  padding: 0 24px 24px;
  display: grid;
  gap: 16px;
}
p {
  margin: 0;
  overflow-wrap: anywhere;
}
fieldset {
  border: 0;
  padding: 0;
  margin: 0;
  min-width: 0;
  display: grid;
  gap: 12px;
}
label {
  display: grid;
  gap: 6px;
}
.password-actions {
  display: flex;
  justify-content: flex-end;
  gap: 10px;
}
@media (max-width: 600px) {
  .panel-heading {
    padding: 16px;
  }
  form {
    padding: 0 16px 16px;
  }
}
</style>
