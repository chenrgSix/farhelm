<script setup lang="ts">
import { onMounted, ref } from "vue";
const emit = defineEmits<{
  close: [];
  select: [kind: "ssh" | "agent"];
}>();
const closeButton = ref<HTMLButtonElement>();
onMounted(() => closeButton.value?.focus());
</script>

<template>
  <div class="add-device-overlay" @keydown.esc="emit('close')">
    <section
      class="panel add-device-panel"
      role="dialog"
      aria-modal="true"
      aria-labelledby="add-device-title"
    >
      <header class="panel-heading">
        <div>
          <h2 id="add-device-title">添加设备</h2>
          <p class="muted">选择这台设备连接平台的方式</p>
        </div>
        <button
          ref="closeButton"
          class="icon-button"
          aria-label="关闭添加设备"
          @click="emit('close')"
        >
          ×
        </button>
      </header>
      <div class="access-options">
        <button
          class="access-option"
          aria-label="SSH 接入"
          @click="emit('select', 'ssh')"
        >
          <strong>SSH 接入 <span aria-hidden="true">→</span></strong>
          <span>设备已有 SSH 服务，无需安装 Agent</span>
          <small>配置地址、端口、账号和私钥，由平台连接设备。</small>
        </button>
        <button
          class="access-option"
          aria-label="Agent 接入"
          @click="emit('select', 'agent')"
        >
          <strong>Agent 接入 <span aria-hidden="true">→</span></strong>
          <span>在设备上运行 Agent，主动连接平台</span>
          <small
            >生成一键安装命令，执行后自动安装、注册设备，并支持健康检查和命令任务。</small
          >
        </button>
      </div>
    </section>
  </div>
</template>

<style scoped>
.add-device-overlay {
  position: fixed;
  inset: 0;
  z-index: 80;
  background: #10202c80;
  display: grid;
  place-items: center;
  padding: 20px;
}
.add-device-panel {
  width: min(650px, 100%);
  max-height: calc(100dvh - 40px);
  overflow: auto;
  padding: 24px;
}
.panel-heading {
  align-items: flex-start;
}
.panel-heading p {
  margin: 6px 0 0;
}
.access-options {
  display: grid;
  gap: 14px;
}
.access-option {
  display: grid;
  gap: 8px;
  width: 100%;
  padding: 20px;
  border: 1px solid #dce3e9;
  border-radius: 8px;
  text-align: left;
  background: white;
  color: #233449;
}
.access-option:hover,
.access-option:focus-visible {
  border-color: var(--teal);
  background: #f3faf8;
}
.access-option strong {
  display: flex;
  justify-content: space-between;
  font-size: 16px;
}
.access-option > span {
  font-size: 13px;
}
.access-option small {
  color: #687888;
  line-height: 1.7;
  font-size: 12px;
}
@media (max-width: 600px) {
  .add-device-overlay {
    padding: 10px;
  }
  .add-device-panel {
    padding: 18px;
    max-height: calc(100dvh - 20px);
  }
  .access-option {
    padding: 16px;
  }
}
</style>
