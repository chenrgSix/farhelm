<script setup lang="ts">
import type { RuntimeSettings } from "../api/types";
defineProps<{ runtime: RuntimeSettings }>();
</script>
<template>
  <section class="panel deployment-panel" aria-label="平台运行方式">
    <h2>平台运行方式</h2>
    <dl>
      <dt>设备接入</dt>
      <dd>
        {{ runtime.device_access === "ssh-only" ? "仅 SSH" : "Agent 和 SSH" }}
      </dd>
      <dt>网页管理</dt>
      <dd>{{ runtime.web_enabled ? "已开启" : "已关闭" }}</dd>
      <dt>网页协议</dt>
      <dd>{{ runtime.web_protocol.toUpperCase() }}</dd>
    </dl>
    <p v-if="runtime.device_access === 'ssh-only'">
      设备通过 SSH 连接。设备管理、用户与权限、网页终端和会话录制均可使用。
    </p>
    <p v-if="runtime.web_protocol === 'http'">
      HTTP 无需 HTTPS 证书，浏览器与平台之间的数据不加密；请在可信内网使用。
    </p>
    <p class="muted">
      接入方式、网页开关和网页协议由部署配置独立控制，调整后重启平台生效。
    </p>
  </section>
</template>
<style scoped>
.deployment-panel {
  max-width: 820px;
  padding: 24px;
  margin-bottom: 20px;
}
dl {
  display: grid;
  grid-template-columns: 120px 1fr;
  gap: 12px;
}
dd {
  margin: 0;
}
p {
  line-height: 1.8;
}
</style>
