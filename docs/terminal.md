# 交互终端

在设备页点击「连接终端」，即可直接输入 Shell 命令。每个会话有独立 PTY 和工作目录；支持管道、重定向、Tab、方向键、Ctrl-C、中文与窗口缩放。默认使用 `/bin/bash --noprofile --norc -i`，没有 Bash 时使用 `/bin/sh -i`。使用 Agent 的非 root 账号，不安装 SSH 或修改系统账号。

「命令任务」继续保留原有持久化执行、幂等、取消与任务结果流程。终端输入不会自动重放；浏览器、Agent 或服务端断连后关闭会话，需要重新点击连接。设备访问凭据在现有 WSS 上续期，正常续期不会打断终端。

## 授权和录制

- 只允许 admin 和设备范围内的 ops 建立终端；业务与审计角色不能执行。每次输入及定期检查平台会话、角色、设备范围和撤销状态。
- 浏览器通过已登录的 HTTPS API 创建会话，再使用有效期 30 秒、单次使用的票据，在 WebSocket 首帧绑定会话。票据不放 URL；服务端检查浏览器 Origin。开发代理需启用 WebSocket，并显式设置 `FLEET_CONSOLE_ORIGIN=http://127.0.0.1:5173`；`scripts/dev.sh` 已配置。
- 会话创建先事务保存身份和初始窗口。每段输出先提交 SQLite WAL/FULL，再展示并 ACK；Agent 等 ACK 后读取下一段。窗口变化在下发前记录，关闭及查看/导出也写审计。录制失败、输出乱序、队列超限或空间不足立即停止输入并请求关闭 PTY，保留已录部分并标记中断。
- 不保存原始按键，只保存 PTY 输出；关闭回显的密码输入不会进入录制。命令自行输出的敏感内容仍会出现在终端和记录中。
- 每设备、每用户最多 4 个会话，全局最多 32 个；单会话最长 1 小时、最多 8 MiB 原始输出和 100000 个录制事件。输入/输出块最多 8192 字节，传输队列有界。没有自动清理历史记录，开发者需要自行维护存储容量。
- 「终端会话」提供按时序回放和 JSON 导出；界面将长停顿压缩至 2 秒，导出保留真实时间戳、字节和窗口事件。中断记录明确显示不完整。

同 UID Shell 能够读取 Agent 身份和本地文件，不能宣称端点防篡改。关闭时清理同一 Linux session 下的普通前台/后台进程；主动 `setsid` 脱离的进程不在此范围，仍受 ADR-006 的边界约束。服务端重启只标记旧会话中断，不恢复或重放旧 Shell。

## 验证方式

`npm run test:terminal` 使用真实 Rust Agent、TLS/WSS 和 SQLite，验证双用户独立会话、工作目录保持、Ctrl-C、窗口变化、中文跨帧、隐藏密码、录制和短期凭据不断线续期。先运行服务端构建和 Agent 构建。macOS 上可用已编译的 Linux Agent 配合 `FLEET_AGENT_DOCKER_IMAGE` 与 `FLEET_AGENT_BIN` 执行同一测试。

`npm run test:terminal:browser` 连接已经运行的本地开发实例，使用显式的 `FLEET_ADMIN_USER`/`FLEET_ADMIN_PASSWORD` 或 `FLEET_CREDENTIALS_FILE`，验证真实浏览器登录、连接、Tab、`cd`、Ctrl-C、中文、交互式 `top`、缩放、退出、回放与导出。需要 Playwright Chromium；`FLEET_CHROMIUM_BIN` 可指定已有浏览器。结果与截图写入忽略提交的 `.test-output/`。

本次在 macOS + OrbStack Linux arm64、Node 24、Rust 1.99 上验证。不是 CI 或生产验收。完整 P2 仍需验证 `vim`、真实存储/网络故障与压力；本地镜像没有安装 `vim`，不宣称已验证。

本次本地结果：服务端 8/8、前端 30/30、协议 131/131、Rust 24/24（22 个单元/实际进程测试和 2 个契约测试）通过；Rust clippy、格式检查和前后端构建通过。原有真实 Rust Exec 端到端 22/22 通过，新增终端端到端及 Chromium 操作、回放/导出通过。`.test-output/terminal-e2e.json`、`terminal-browser.json`、`terminal-rust-final.log` 和终端截图保留本地证据，不随 Git 提交私有运行状态。
