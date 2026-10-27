# 交互终端

在设备页点击「连接终端」，即可直接输入 Shell 命令。每个会话有独立 PTY 和工作目录；支持管道、重定向、Tab、方向键、Ctrl-C、中文与窗口缩放。默认使用 `/bin/bash --noprofile --norc -i`，没有 Bash 时使用 `/bin/sh -i`。Agent 通道使用 Agent 的运行账号，无需在目标设备安装 SSH。同一设备可配置备用 SSH，Agent 不可用时新会话使用 SSH 配置的账号；现有会话不切换。详见[双通道配置](device-connections.md)。标准客户端可经[SSH 统一入口](ssh-gateway.md)使用同一终端和录制流程。

Bash 提示符显示真实用户名、主机名和当前目录，例如 `fleet@local-linux:~$`；执行 `cd /tmp` 后显示 `fleet@local-linux:/tmp$`。HOME 用 `~` 表示，目录随 Shell 工作目录自动更新。`/bin/sh` 回退模式显示当前目录。

「命令任务」继续保留原有持久化执行、幂等、取消与任务结果流程。终端输入不会自动重放；浏览器、Agent 或服务端断连后关闭会话，需要重新点击连接。设备访问凭据在现有 WSS 上续期，正常续期不会打断终端。

输入 `exit` 或点击「断开并关闭」后，会话显示「已结束」；意外断线、权限失效、录制失败等显示「已中断」。会话状态与录制完整性分别记录：主动关闭会停止采集，不保证保留尚未收到的尾部输出，回放仍提示录制可能不完整。已有 `USER_DISCONNECTED` 记录在启动时修正为「已结束」，原始原因、时间及录制和审计证据保持不变。

会话列表与回放窗口显示 `HH:MM:SS` 录制时长，按服务端 `created_at` 至 `ended_at` 计算，包含连接等待和空闲；活跃会话每秒更新，结束后固定，不受回放倍速和停顿压缩影响。服务端异常重启的结束时间是恢复时刻，该类会话的显示时长可能包含停机间隔，仍以录制不完整提示为准。

## 单设备逐条命令历史

设备详情页的「终端命令历史」汇总网页终端和 Farhelm SSH 入口的命令；设备「更多 → 终端命令历史」可进入。查询必须选择开始、结束时间，范围大于 0 且最多 7 × 24 小时；页面初次打开不发起历史查询。支持用户账号包含匹配／完整用户 ID、命令字面包含匹配（英文不区分大小写，`%`、`_` 不作为通配符）。每页 50 条，服务端 API 最多 100 条，游标绑定设备、用户和条件。

API：`GET /api/v1/devices/:id/terminal-commands?from=<毫秒>&to=<毫秒>&q=<命令>&actor=<用户>&limit=50&cursor=<游标>`。时间约束在服务端强制执行，管理员及 API Token 也不能省略或绕过。沿用 `recordings.read`、`recordings.read_all` 和设备范围授权；关联会话及回放接口独立重新鉴权。

记录包含平台用户、入口来源、服务端收到执行通知的时间、提交的命令行、Shell 返回的退出码和会话回放位置。「定位回放」先恢复该位置之前的终端内容，再从命令位置按正常速度播放。活跃会话回放只读取打开时的录制快照。断线或缺失完成通知时保留命令，退出码显示未确认，不推测成功。

新 Agent 的 Bash 以及 SSH 目标的 Bash／Zsh 使用仅当前会话生效的 Shell 执行钩子；不记录原始按键，不读取密码输入。Tab 补全、编辑、多行语句按 Shell 接受的命令行记录；一个含管道、分号或多条语句的提交算一条记录。sudo／read 的隐藏输入、编辑器、数据库客户端等程序内部输入不建立命令记录。识别到密码、令牌、认证参数、带密码 URL、heredoc 或过长命令时，整条命令在索引中隐藏，原始敏感命令文本不写入索引。原有 PTY 录制规则仍适用：用户显式回显、程序输出或在命令行上可见的敏感内容可能存在于会话回放中。

历史会话不回填；旧 Agent、不支持的 Shell、用户替换钩子或进入未接入采集的嵌套 Shell 时没有完整的逐条记录，仍保留会话录制。这里是 Shell 自报的操作历史，不是不可绕过的系统进程审计；不能把空查询结果解释为没有执行过命令。每会话最多 5000 条命令，命令元数据有界，随输出同事务持久化后才展示和 ACK。先升级平台，再更新 Agent 构建并重新连接；纯 SSH 目标只需更新平台并重新连接。

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

网页与 SSH 入口统一使用普通连接；显式 `account_id` API 连接也已移除；旧目标账号数据及历史录制仍保留。详见[账号兼容说明](device-connections.md#目标账号与登录切换方式)。

## 2026-10-26 普通连接与旧账号入口清理回归

移除 root 快捷连接和显式账号 API 后，本地使用 Node.js 24.21.0、当前源码构建的 Linux arm64 Agent 0.2.13、隔离 Docker 容器和 Playwright Chromium 验证：

- 服务端 205/205、前端 224/224、协议契约 387/387 通过；前后端类型检查、构建及全项目 Prettier 检查通过。
- 旧 `connection_mode: "root"` 返回明确错误且不创建会话；旧 `normal` 请求仍可用。显式 `account_id`（含默认 ID）返回 `ACCOUNT_CONNECTION_REMOVED`；普通连接的默认 root SSH 配置保持兼容，撤销默认授权后关闭会话。旧账号身份的录制、索引和导出继续可读。
- 真实普通终端保持非 root 身份，网页和平台 SSH 均可自动代填 sudo 密码；系统免密 sudo 无需保存密码。验证重复 sudo、错误密码、未授权用户不接收密码、撤权断连和设备提权开关。
- Chromium 验证普通连接、自动代填提示及命令执行，确认无高级账号菜单，并验证普通连接授权新增、权限核对及撤权断连；截图保存在 `.test-output/`。录制和审计中不包含测试密码。

在前后端构建完成、Linux Agent 二进制就绪后，本次端到端命令为：

```bash
FLEET_AGENT_BIN="$PWD/.dev/linux-target/debug/farhelm-agent" \
FLEET_TEST_SUDO_COMMANDS=1 FLEET_TEST_TERMINAL_SETTINGS=1 \
FLEET_TEST_BROWSER_CHANNEL=chromium node tests/e2e/target-accounts.mjs
```

结果见本地 `.test-output/target-accounts-e2e.json`。这是隔离环境中的本地验证，不代表 CI 或生产验收；本次未修改 Agent 源码，未重跑 Rust 单元测试或完整 Exec 故障矩阵。

## 2026-10-26 单设备命令历史验证

本次使用 Node.js 24.21.0、macOS 原生 Bash／Zsh PTY、当前源码构建的 Linux arm64 Agent、隔离 sshd 容器和 Chromium 验证：

- 服务端 205/205、前端 230/230、协议契约 383/383、Rust 57/57 通过；前后端构建、Prettier、Rust 格式和 clippy 检查通过。敏感参数规则最后调整后，相关解析测试 2/2 及服务端构建再次通过。
- 真实 Agent 与真实 SSH 目标均覆盖网页终端、Farhelm SSH 入口的命令索引、用户／时间过滤及回放位置；隐藏密码未进入索引或录制。普通连接、sudo 密码自动代填、免密 sudo 和高级账号回归通过。
- 原生 PTY 覆盖编辑后的命令、多行命令、失败退出码、隐藏输入与 SSH Shell 启动脚本。API 测试覆盖必选时间、7 天上限、用户和设备权限、游标绑定、模糊搜索及分页。
- 使用隔离的示例数据库进行浏览器界面验收：进入页面不查询，超出 7 天禁止查询，用户与命令组合过滤、50／7 条翻页和定位回放通过；桌面及 390px 手机布局检查通过。

本地证据保存在 `.test-output/terminal-e2e.json`、`target-accounts-e2e.json` 和 `command-history-*.png`。以上为本地隔离环境验证，不代表 CI 或生产验收；更新平台与 Agent 后需建立新会话，旧会话不回填命令。

## 连接限额

管理员在「系统设置 → 连接限额」配置 Farhelm 的单用户并发连接、单设备终端、平台终端总数、SSH 总连接及单 IP SSH 连接上限。默认分别为 4、4、32、64、16；其中单设备值是全局默认，未单独配置的设备自动继承。单用户及单设备可设 1–128，其他项可设 1–1024。各项上限同时生效，实际接纳数受最先达到的上限限制。

单用户计数跨登录令牌、网页和 SSH 共用：等待附着的网页票据占一个名额，认证完成的 SSH 连接（含设备选择菜单）占一个名额；SSH 选择设备后不会再次计数。单设备及平台终端数包含待连接和活动终端。SSH 总数与单 IP 数包含尚未完成认证的 TCP 连接，以限制握手资源。关闭、失败和票据过期后释放相应名额。

保存后新连接立即使用新限额，降低上限不会断开已有连接；提高单设备上限需同步升级 Agent，以免仍受旧 Agent 的 4 会话限制。配置持久化且保存带版本校验和审计。API 为管理员专用 `GET/PUT /api/v1/settings/connections`；PUT 提交 `v`、`revision`、`per_user`、`per_device`、`terminal_total`、`ssh_total`、`ssh_per_ip`。此配置不修改目标机 sshd、监听端口、路由或网络策略。


### 每台设备独立覆盖

在「设备总览 → 更多 → 接入配置 → 终端限额」中，默认勾选「继承全局配置」。取消勾选后可为当前设备设置 1–128 的终端上限；网页与 Farhelm SSH 入口、所有用户及待连接终端共用计数。独立覆盖值可高于或低于全局默认；单用户、平台终端总数及 SSH 入口总数仍同时生效。

保存只影响新连接，不主动断开已有终端。勾回继承并保存后立即恢复使用当前全局默认值，之后会自动跟随全局调整。界面分别显示全局默认、当前已保存的生效值和来源；设备离线时也能配置。纯 SSH、Agent 及备用 SSH 使用同一个设备上限。提高上限需要当前 Agent 已支持可配置的终端容量。

管理员通过 `GET/PUT /api/v1/devices/:id/terminal-limit` 读写。PUT 为 `{ "v": 1, "revision": 0, "limit": 6 }`；`limit: null` 恢复继承。响应包含 `global_limit`、`effective_limit` 和 `source`（`global` / `device`）。保存使用该设备独立版本，冲突必须重新加载；恢复继承保留版本，防止旧表单重新写回。配置和操作审计原子提交。升级时原有设备不生成覆盖值，不改普通连接、sudo、历史录制或网络配置。
