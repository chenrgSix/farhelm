# 交互终端

在设备页点击「连接终端」，即可直接输入 Shell 命令。每个会话有独立 PTY 和工作目录；支持管道、重定向、Tab、方向键、Ctrl-C、中文与窗口缩放。默认使用 `/bin/bash --noprofile --norc -i`，没有 Bash 时使用 `/bin/sh -i`。Agent 通道使用 Agent 的运行账号，无需在目标设备安装 SSH。同一设备可配置备用 SSH，Agent 不可用时新会话使用 SSH 配置的账号；现有会话不切换。详见[双通道配置](device-connections.md)。标准客户端可经[SSH 统一入口](ssh-gateway.md)使用同一终端和录制流程。

Bash 提示符显示真实用户名、主机名和当前目录，例如 `fleet@local-linux:~$`；执行 `cd /tmp` 后显示 `fleet@local-linux:/tmp$`。HOME 用 `~` 表示，目录随 Shell 工作目录自动更新。`/bin/sh` 回退模式显示当前目录。

「命令任务」继续保留原有持久化执行、幂等、取消与任务结果流程。终端输入不会自动重放；浏览器、Agent 或服务端断连后关闭会话，需要重新点击连接。设备访问凭据在现有 WSS 上续期，正常续期不会打断终端。

输入 `exit` 或点击「断开并关闭」后，会话显示「已结束」；意外断线、权限失效、录制失败等显示「已中断」。会话状态与录制完整性分别记录：主动关闭会停止采集，不保证保留尚未收到的尾部输出，回放仍提示录制可能不完整。已有 `USER_DISCONNECTED` 记录在启动时修正为「已结束」，原始原因、时间及录制和审计证据保持不变。

会话列表与回放窗口显示 `HH:MM:SS` 录制时长，按服务端 `created_at` 至 `ended_at` 计算，包含连接等待和空闲；活跃会话每秒更新，结束后固定，不受回放倍速和停顿压缩影响。服务端异常重启的结束时间是恢复时刻，该类会话的显示时长可能包含停机间隔，仍以录制不完整提示为准。

## 本地开发容器

本地容器使用 `deploy/dev/Dockerfile.agent` 中的普通用户 `fleet`，UID/GID 与启动者一致；HOME 和初始工作目录为 `/home/fleet`。该目录绑定到项目 `.dev/agent-home/`，可以直接 `touch t.txt`、编辑文件和创建目录，重建容器后文件保留。设备身份与 journal 仍保存在独立的 `.dev/agent/`。系统目录按正常 Linux 账号权限管理。

本地开发镜像安装 sudo，并为 `fleet` 配置免密 sudo。开发启动脚本显式设置 `FLEET_TERMINAL_ALLOW_PRIVILEGE_ESCALATION=1`，允许终端中的 `sudo -i` 进入容器内 root；Agent 自身仍以 `fleet` 运行，容器未启用 privileged，并配置 Docker `--init` 作为 PID 1。`exit` 返回 fleet。容器内安装的软件及 `/root` 文件不在持久化 home 目录中，重建容器后不会保留。

本地 sudo 使用 Agent 已提供的 PTY（`Defaults:fleet !use_pty`），避免嵌套终端和额外的 sudo 监控会话。

其他环境默认 `FLEET_TERMINAL_ALLOW_PRIVILEGE_ESCALATION=0`，PTY 设置 `no_new_privs`，禁止通过 setuid/文件 capabilities 提权。显式配置为 1 后，终端可以使用系统已授予的 sudo 权限；Agent 不自动为真实主机安装 sudo 或配置 sudoers。该选项只影响交互终端，命令任务仍强制 `no_new_privs`。若父进程已设置 `no_new_privs`，不能通过该选项解除，启动会明确报错。

已有本地服务端、`.dev/agent.env`、开发 CA 和 Linux Agent 二进制时，执行 `npm run dev:agent:container` 可以构建并更新本地容器。默认二进制路径为 `.dev/linux-target/debug/farhelm-agent`，可用 `FLEET_AGENT_BIN` 覆盖。该命令会结束当前本地终端会话，更新后重新连接。它核对现有容器的状态目录，不覆盖其他项目的容器。

开发容器及镜像名称为 `farhelm-agent`、`farhelm-agent-dev:local`。更新脚本也会识别旧名称 `linux-fleet-agent`，核对属于同一状态目录后再替换，避免两个 Agent 争用同一设备身份；容器内的账号与持久化路径沿用原值。

## 授权和录制

普通用户仅能查看本人在授权设备上的会话与录制。管理员和审计员可查看授权范围内所有用户的会话；自定义角色需要管理员显式勾选“查看他人会话与录制”。该权限不授予操作或结束他人终端的能力。列表、分页筛选、回放和导出统一按此规则校验。

- 只允许 admin 和设备范围内的 ops 建立终端；业务与审计角色不能执行。每次输入及定期检查平台会话、角色、设备范围和撤销状态。
- 浏览器通过已登录的 HTTPS API 创建会话，再使用有效期 30 秒、单次使用的票据，在 WebSocket 首帧绑定会话。票据不放 URL；服务端检查浏览器 Origin。开发代理需启用 WebSocket，并显式设置 `FLEET_CONSOLE_ORIGIN=https://localhost:5173`；`scripts/dev.sh` 已配置。
- 会话创建先事务保存身份和初始窗口。每段输出先提交 SQLite WAL/FULL，再展示并 ACK；Agent 等 ACK 后读取下一段。窗口变化在下发前记录，关闭及查看/导出也写审计。录制失败、输出乱序、队列超限或空间不足立即停止输入并请求关闭 PTY，保留已录部分并标记中断。
- 不保存原始按键，只保存 PTY 输出；关闭回显的密码输入不会进入录制。命令自行输出的敏感内容仍会出现在终端和记录中。
- 每设备、每用户最多 4 个会话，全局最多 32 个；单会话最长 1 小时、最多 8 MiB 原始输出和 100000 个录制事件。输入/输出块最多 8192 字节，传输队列有界。没有自动清理历史记录，开发者需要自行维护存储容量。
- 「终端会话」提供按时序回放和 JSON 导出；界面将长停顿压缩至 2 秒，导出保留真实时间戳、字节和窗口事件。中断记录明确显示不完整。

同 UID Shell 能够读取 Agent 身份和本地文件，不能宣称端点防篡改。关闭时清理同一 Linux session 下的普通前台/后台进程；主动 `setsid` 脱离的进程不在此范围，仍受 ADR-006 的边界约束。服务端重启只标记旧会话中断，不恢复或重放旧 Shell。

启用终端提权后，非 root Agent 不能直接向 root 子进程发送信号；普通 root 交互 Shell 通过 PTY 挂断结束。忽略挂断或转入后台的高权限进程可能继续运行，不保证 root 进程树强制清理。

## 验证方式

`npm run test:terminal` 使用真实 Rust Agent、TLS/WSS 和 SQLite，验证双用户独立会话、工作目录保持、Ctrl-C、窗口变化、中文跨帧、隐藏密码、录制和短期凭据不断线续期。先运行服务端构建和 Agent 构建。macOS 上可用已编译的 Linux Agent 配合 `FLEET_AGENT_DOCKER_IMAGE` 与 `FLEET_AGENT_BIN` 执行同一测试。

`npm run test:terminal:browser` 连接已经运行的本地开发实例，使用显式的 `FLEET_ADMIN_USER`/`FLEET_ADMIN_PASSWORD` 或 `FLEET_CREDENTIALS_FILE`，验证真实浏览器登录、连接、Tab、`cd`、Ctrl-C、中文、交互式 `top`、缩放、退出、回放与导出。需要 Playwright Chromium；`FLEET_CHROMIUM_BIN` 可指定已有浏览器。结果与截图写入忽略提交的 `.test-output/`。

对启用 sudo 的本地开发容器，可添加 `FLEET_TEST_TERMINAL_SUDO=1`，验证真实的 `sudo -i`、UID 0、`/root` 文件操作及 `exit` 返回 fleet。

本次在 macOS + OrbStack Linux arm64、Node 24、Rust 1.99 上验证。不是 CI 或生产验收。完整 P2 仍需验证 `vim`、真实存储/网络故障与压力；本地镜像没有安装 `vim`，不宣称已验证。

本次本地结果：服务端 8/8、前端 30/30、协议 131/131、Rust 25/25（23 个单元/实际进程测试和 2 个契约测试）通过；Rust clippy、格式检查和前后端构建通过。原有真实 Rust Exec 端到端 22/22 通过，新增终端端到端及 Chromium 操作、回放/导出通过。`.test-output/terminal-e2e.json`、`terminal-browser.json`、`terminal-sudo-rust.log` 和终端截图保留本地证据，不随 Git 提交私有运行状态。

目标账号可选择直接 SSH 登录或由 Agent 使用托管密码经 sudo 切换；网页与 SSH 入口统一校验授权并录制。需要 Agent 0.2.8+，详见[目标账号与登录方式](device-connections.md#目标账号与登录切换方式)。

## 2026-10-26 普通连接与兼容账号回归

移除 root 快捷连接后，本地使用 Node.js 24.21.0、当前源码构建的 Linux arm64 Agent 0.2.13、隔离 Docker 容器和 Playwright Chromium 验证：

- 服务端 192/192、前端 227/227、协议契约 382/382 通过；前后端类型检查、构建及全项目 Prettier 检查通过。
- 旧 `connection_mode: "root"` 返回明确错误且不创建会话；旧 `normal` 请求仍可用。默认 root SSH 及已授权高级账号继续兼容，撤销授权后关闭会话。
- 真实普通终端保持非 root 身份，网页和平台 SSH 均可自动代填 sudo 密码；系统免密 sudo 无需保存密码。验证重复 sudo、错误密码、未授权用户不接收密码、撤权断连和设备提权开关。
- Chromium 验证普通连接、自动代填提示及命令执行，通过高级入口连接已有账号；桌面与手机截图保存在 `.test-output/`。录制和审计中不包含测试密码。

在前后端构建完成、Linux Agent 二进制就绪后，本次端到端命令为：

```bash
FLEET_AGENT_BIN="$PWD/.dev/remove-root-verification/farhelm-agent" \
FLEET_TEST_SUDO_COMMANDS=1 FLEET_TEST_TERMINAL_SETTINGS=1 \
FLEET_TEST_BROWSER_CHANNEL=chromium node tests/e2e/target-accounts.mjs
```

结果见本地 `.test-output/target-accounts-e2e.json`。这是隔离环境中的本地验证，不代表 CI 或生产验收；本次未修改 Agent 源码，未重跑 Rust 单元测试或完整 Exec 故障矩阵。
