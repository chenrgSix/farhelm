# Farhelm · 遥舵 Web 控制台

Vue 3 + TypeScript + Vite。面板只从真实 `/api/v1` 读取数据；没有离线演示数据、默认账号、URL token 或本地持久化会话。

## 构建与测试

Node.js 24+。在本目录运行 `npm ci`、`npm test`、`npm run typecheck`、`npm run build`。
构建输出为 `dist/`，应通过服务端同源 HTTPS 静态服务或可信反向代理提供。服务端可设置 `FLEET_WEB_DIST=/absolute/path/apps/web/dist`（配置字段 `webDist`）。

开发时，在仓库根目录启动 HTTPS Vite 前端（需先准备 `.dev/tls` 开发证书和正在运行的后端）：

```sh
npm run dev:web
```

浏览器访问 `https://localhost:5173` 并一次性信任开发根证书；与 Docker Agent 共用入口时使用 `https://host.docker.internal:5173`，并配置宿主机解析。可同时设置 `FLEET_DEV_WEB_TLS_CERT` 和 `FLEET_DEV_WEB_TLS_KEY` 覆盖证书，详见[统一平台入口](../../docs/platform-entry.md)。代理涵盖 `/api/`、`/agent/` 和 `/healthz`，包括 Agent 的安装下载与 WSS 控制连接。仅本机开发允许 HTTP；远程控制台登录必须使用 HTTPS。Vite 到 API 的 TLS 始终校验，禁止 `secure:false` / `NODE_TLS_REJECT_UNAUTHORIZED=0`。未配置 API 代理时 API 缺失会显示明确错误，不会伪造数据。`dev:web` 对项目管理的开发证书每小时检查并提前 30 天续签，前后端热加载，已有终端连接保持；自定义证书仅热加载，不自动签发。

## 已实现

- 显式登录；Bearer session 只存当前页内存，刷新/退出后清除；服务端仍负责所有授权
- 角色与设备范围控制：管理员注册/撤销，admin/ops 授权 Exec，business/auditor 不提供任意 Exec
- 控制在线、私网数据可达、业务健康独立呈现，未采集为未知，刷新失败不冒充在线
- 设备健康检查面板：配置 HTTP/HTTPS、TCP、systemd，支持启停、删除、立即探测与最近结果；配置及探测由服务端授权并下发到目标 Agent
- 单次命令明确 argv JSON、cwd、执行超时、排队 TTL、合并输出硬上限，不自动拼接 Shell
- 提交中与成功后锁定重复点击；响应丢失后保留精确请求与原 Idempotency-Key，重试使用同一键；新任务须明确重新开始
- 真实任务、操作人、状态、取消请求、UNKNOWN、清理不确定和审计完整性；取消请求不等于执行已停止
- stdout/stderr 独立有界读取，校验大小与 SHA-256，最多预览 64 KiB。使用 Vue 文本节点，无 v-html/ANSI 解释，控制字符可见转义
- 审计筛选、明细与任务关联；输出读取仍由服务端记录查看审计
- 中文响应式页面，无 CDN、字体请求或运行时设计依赖

## 当前边界

- 单账号执行，命令与 Agent 共享主机权限；平台记录不代表端点强隔离
- 刷新/关闭页面会失去内存中的会话与幂等键；提交结果未确认时会提示保留页面，重新登录应先核对任务历史
- 读取输出是纯文本预览；二进制字节/非法 UTF-8 会被替代显示，中央原始对象不变
- 页面展示服务端当前返回的列表；尚无服务端分页、批量、私网健康采集、业务模板或任务自动重试
- 10 秒轮询，后台标签页暂停刷新；取消与输出读取不自动重试

Unit tests use isolated mocked API responses only; runtime never falls back to those test fixtures.
