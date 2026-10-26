# SSH 与 Agent 接入

管理员在设备页点击「添加设备」，再选择「SSH 接入」或「Agent 接入」，两种方式均使用弹窗表单。SSH 方式填写连接配置；Agent 方式填写安装信息并生成一条命令，复制到目标 Linux 执行后自动安装、注册并启动，详情见 [Agent 一键安装](agent-installation.md)。已有 Agent 设备可直接添加备用 SSH，保持同一个设备 ID、设备组、授权、身份与历史，不创建第二台设备。独立 SSH 设备仍可用于没有安装 Agent 的机器。两种设备共用网页终端、平台 SSH 入口、设备范围授权、会话额度、录制、时长、回放和导出。

```text
浏览器 / SSH 客户端 → 平台（认证、授权、录制） → WSS → Agent PTY
                                           → SSH → 目标 sshd / Shell
```

## 配置 SSH 设备

1. 点击「添加设备」→「SSH 接入」，填写名称、目标地址、端口、Linux 账号，并选择「私钥」或「账号密码」认证。平台服务端必须能访问该地址；`localhost` 指平台所在机器。
2. 私钥认证：在目标账号的 `authorized_keys` 中配置对应公钥，粘贴 OpenSSH/PEM 私钥；加密私钥同时填写口令。账号密码认证：填写目标 Linux 账号的 SSH 登录密码，目标 sshd 必须允许 password 认证；不支持交互式多因素认证、ssh-agent 转发或跳板链。
3. 点击「获取主机指纹」，与目标机器管理员提供的指纹核对后勾选确认；也可直接填写已知 SHA256 指纹。获取只读取主机公钥，在认证前断开，不提交登录凭据。扫描结果本身不证明主机可信，仍需核对。
4. 保存后点击「测试已保存连接」，验证网络、主机指纹和所选 SSH 认证；测试不创建 Shell、不执行命令。关闭面板后点击「连接终端」。

目标无需安装 Agent。SSH 客户端仍使用平台账号密码，例如 `ssh -tt -p 2222 -l admin 127.0.0.1`；菜单显示「SSH · 按需连接」。也支持 `平台用户名:设备ID` 直接连接。目标地址与登录凭据由平台使用，无需分发给操作人。

Agent 在线只代表 WSS 连接；SSH 不维持常驻连接，显示按需连接及上次检查/连接结果，不把历史成功当作实时在线。SSH 设备本版支持交互终端；持久化命令任务及 HTTP/TCP/systemd 健康检查仍要求 Agent，前端隐藏对应入口，服务端明确拒绝。

修改接入配置前需结束设备的活跃终端；revision 防止覆盖他人的修改。同一种认证方式下，密码或私钥留空保留原值；替换私钥时清除旧口令，必要时重新填写。切换认证方式必须填写新凭据，保存成功后清除旧方式的凭据，不自动回退到另一种认证。主机指纹不一致会在认证前拒绝连接，不会自动接受新指纹。

## 为已有 SSH 设备安装 Agent

管理员在 SSH 设备行点击「安装 Agent」，填写运行账号、启动方式和有效期，生成命令并在该设备上执行。设备名称只读，平台地址自动带入。命令绑定原设备 ID，不通过名称或 IP 猜测设备归属，也不会新增设备。

生成命令、下载失败、注册未完成或 Agent 尚未上线时，设备仍使用原 SSH。只有 Agent 证明持有注册密钥并发送有效上线消息后，平台才将其设为 Agent 设备，保留原 SSH 地址、账号、私钥、主机指纹及配置版本作为备用；设备组标签、用户/用户组授权、历史任务和录制仍属于同一 ID。已打开的 SSH 会话继续运行，新会话按 Agent 优先规则选择通道。

命令过期且尚未注册时可重新生成，新的命令会使该设备之前未使用的安装命令失效。已注册但未上线时，请检查并启动目标 Agent 服务，无需重复安装；原身份在平台重启及命令过期后仍有效。安装需要目标 root 或 sudo 权限，平台不会自动通过 SSH 执行命令。详见 [安装与维护](agent-installation.md)。

## 为 Agent 配置备用 SSH

管理员打开「设备总览 → 接入配置」，勾选「启用备用 SSH」，填写目标地址、端口、账号、密码或私钥及主机指纹，保存并测试连接。步骤与独立 SSH 设备相同；sudo 密码与 SSH 凭据分别维护。取消勾选并保存会删除备用 SSH 配置及其登录密码、私钥和口令，保留 Agent 身份及 sudo 密码。

网页终端、平台 SSH 入口的直连和设备选择菜单使用同一规则：新会话创建时，Agent 已连接、心跳有效且支持交互终端则优先使用 Agent；否则，有备用配置时尝试 SSH，没有配置则提示 Agent 离线或需更新。SSH 主机指纹不匹配、认证失败或连接失败会明确报错，不忽略指纹或改用未经配置的目标。SSH 仍为按需连接，配置存在不代表目标实时可达。

会话创建后固定通道。Agent 掉线会结束原 Agent 会话，重新连接才尝试备用 SSH；Agent 恢复后新会话重新优先使用 Agent，已打开的 SSH 会话继续使用 SSH。不会迁移 Shell、重放按键或恢复原工作目录。终端窗口和历史记录显示实际通道，两个通道共用同一设备范围、角色权限、额度、撤销规则和录制流程；SSH 使用配置的目标账号，其 Linux 权限可能与 Agent 运行账号不同。

设备仍是 Agent 设备，继续支持健康检查、网络记录、命令任务和升级。这些功能不自动转由 SSH 执行；Agent 升级期间对新 Agent 终端的限制仍有效，Agent 不可用时备用 SSH 可用于排查恢复，不受未确认升级批次阻塞。

接口沿用 `PUT /api/v1/devices/:id/connection`：`ssh.auth_method` 可选 `private_key` 或 `password`；新配置省略时默认私钥，更新时省略保留原认证方式。私钥模式提交 `private_key` 和可选 `passphrase`；密码模式提交 `ssh_password`，不可混用。响应通过 `has_ssh_password` 表示是否已保存 SSH 密码。Agent 可另外提交独立的 `sudo_password`。省略字段保留已有值，`ssh:null` 仅允许 Agent 设备明确删除备用配置；所有变更均要求管理员、最新 revision 且设备没有活跃会话。`connection_kind` 保留 `agent`，设备列表新增 `ssh_configured` 和当前预计使用的 `terminal_backend`。无需数据库迁移或重装 Agent，已有 Agent / SSH 设备保持原有行为。

## Agent 可选 sudo 密码

Agent 设备的「接入配置」可设置、替换或明确清除 sudo 密码。留空保留原值；没有配置也不影响 Agent 连接和普通终端。

仅管理员可配置，任何角色（包括管理员）都不能通过 API 读回明文。普通 Agent 终端在用户执行 sudo 时自动代填此密码，需要 Agent 0.2.12+、设备允许终端提权、默认账号授权和 `terminal.sudo` 权限。终端初始身份仍是 Agent 运行账号；Linux sudoers 不会被改写。系统免密 sudo 无需保存密码。旧 API 显式指定的 sudo 切换账号仍按原权限使用托管密码或免密 sudo（后者需要 Agent 0.2.9+），网页和 SSH 入口不再提供账号选择。

纯 SSH、备用 SSH 和不支持自动代填的旧 Agent 继续提供普通终端，但不会接收代填密码；sudo 按目标系统原有方式认证。显式 `sudo -S`、绝对路径 `/usr/bin/sudo` 和覆盖 PATH 的命令不使用自动代填。

## 凭据与录制

- SSH 登录密码、私钥、私钥口令和 sudo 密码使用 AES-256-GCM 保存，每次随机 nonce，以设备 ID 绑定 AAD。配置响应只有 `has_*` 标志，设备列表和审计不包含明文。
- 数据目录的 `credentials.key` 是独立 32 字节密钥，权限 0600。备份恢复须保留原密钥，建议与数据库备份分开保护。已有凭据时缺少密钥会阻止启动，不自动生成替代密钥。此加密不抵御平台主机与密钥一并失陷。
- 设备终端授权允许平台代用已保存的 SSH 登录凭据建立连接，不等于可查看密码或私钥；配置权限与终端使用权限分开检查。
- 录制只保存 PTY 输出，不保存原始按键；终端回显仍会录制。SSH 输出与 Agent 共用 SQLite 提交后再转发的流程，录制失败会断开。上游入口 `transport` 与下游接入 `backend` 分别保存，历史会话默认 `backend=agent`。
- 目标 SSH 的 exit 通知表示 Shell 正常结束，异常网络断线标为中断。主动结束会话关闭 SSH 连接；不保证已脱离终端的后台进程全部退出。

## 本地验证

服务端测试使用真实 SSH 协议测试端验证凭据、指纹、权限、录制与原有 Agent 路径。真实 Linux 验证使用独立 OpenSSH 容器，不修改现有 Agent 容器：

```bash
docker build -t farhelm-sshd-test:local tests/e2e/ssh-target
npm --prefix apps/server run build
npm --prefix apps/web run build
npm run test:ssh:target
FLEET_TEST_SSH_PASSWORD=1 npm run test:ssh:target
FLEET_TEST_SSH_PASSWORD=1 npm run test:ssh:backup
npm run test:ssh:backup # 同一个已存在的 Agent 设备配置备用 SSH
```

脚本使用临时凭据、数据库及仅绑定宿主 loopback 的 sshd，验证浏览器配置、桌面/手机布局、真实 Linux PTY、Ctrl-C、resize、中文、隐藏输入、录制回放和系统 OpenSSH 经平台菜单连接，结束后移除测试容器。Chromium 可用 `PLAYWRIGHT_BROWSERS_PATH` 或 `FLEET_CHROMIUM_BIN` 指定。结果位于 `.test-output/dual-access-*`，不等于 CI 或生产验收。

双通道服务端测试覆盖 Agent 优先、离线/心跳过期/不支持终端时回退、恢复后保留已有 SSH 会话、主机指纹失败、同设备权限与撤销、凭据删除和原 ID 不变。其中 Agent 使用协议测试端，SSH 使用真实 SSH 协议端；`test:ssh:backup` 另以真实 Linux OpenSSH 验证备用 SSH 的前端配置、网页终端、平台 SSH 菜单、录制和回放。

## 目标账号与登录／切换方式

网页只提供「连接终端」，平台 SSH 选择设备后直接普通连接；指定设备的 SSH 命令也直接连接。Agent 使用其运行账号，SSH 使用接入配置中的登录账号。需要提权时在会话内执行 sudo，保留密码自动代填和系统免密 sudo，详见上文。默认账号仍须通过原访问授权检查；仅获授权旧附加账号的用户不会自动获得普通连接权限。

默认登录账号、SSH 凭据和 sudo 密码在「接入配置」维护。网页的高级账号管理与选择入口、SSH 第二级账号菜单均已移除。已有目标账号记录、加密凭据、精确授权及历史录制保留，不删除、不合并到默认账号，也不自动选择任一旧账号。

为兼容已有脚本，账号配置 API 和 `POST /api/v1/terminal-sessions` 的显式 `account_id` 请求保留原行为：直接 SSH 或 Agent sudo 切换仍须通过账号、设备、角色及特权权限检查，失败不会换用其他账号。旧凭据不返回浏览器；历史回放仍可读取原账号身份。此兼容 API 不用于当前网页或平台 SSH 入口。

账号配置 API 的版本校验、活跃会话保护和授权撤销规则不变；普通连接继续校验默认账号权限，不恢复已撤销授权。平台不会创建 Linux 用户或改写 sudoers、SSH 接入配置、网络策略。

验证：`npm run test:target-accounts` 在隔离 Linux 容器中使用真实 Agent 和 sudo，覆盖网页普通连接、SSH 选设备后直接连接、sudo 密码代填和免密 sudo、旧账号存在时的连接行为、旧 API 鉴权兼容及录制密码排除。需要先构建 Linux Agent，可用 `FLEET_AGENT_BIN` 指定；测试镜像默认 `farhelm-agent-dev:local`。不修改已有部署。
