# SSH 统一入口

用户用标准 SSH 客户端连接 Farhelm 服务端，认证平台账号、检查设备授权后，按接入方式创建 PTY：Agent 设备使用出站 WSS，SSH 设备由平台通过配置的账号和私钥连接目标 sshd。Agent 模式无需目标 sshd；SSH 模式无需安装 Agent。配置与凭据管理见[双接入说明](device-connections.md)。当前为受审计的交互终端转接，不转发任意 SSH 通道。

```text
OpenSSH / SSH 客户端 ── SSH ── Farhelm 服务端 ── 已认证 WSS ── Agent PTY
浏览器终端          ── WSS ────────┘
                                      └── SSH（固定主机指纹）── 目标 sshd
```

## 使用

设备页点击「SSH 连接」，可以查看并复制完整命令和平台主机指纹。用户名是 `平台用户名:设备ID`；也接受全局唯一的设备名，重复名称拒绝连接。密码使用平台账号密码。首次连接核对面板里的 SHA256 主机指纹，后续由客户端 known_hosts 检查变化。

```bash
ssh -tt -p 2222 -l 'admin:local-linux' -- 127.0.0.1
```

也可以只填写平台用户名，登录后再选择设备：

```bash
ssh -tt -p 2222 -l admin 127.0.0.1
```

输入平台密码后显示有操作权限、尚未撤销的设备，标明在线/离线/不支持终端。输入当前页的编号并回车连接；`r` 刷新、`n` 下一页、`p` 上一页、`q` 或 Ctrl-C/Ctrl-D 退出。每页最多 25 台，重复设备名通过显示的设备 ID 区分。离线设备选择失败后保留菜单，可以改选其他设备。

刷新和连接时重新检查登录有效期与当前权限；选择绑定刚才显示的设备 ID，列表变化不会让同一编号误连其他设备。菜单最长保留 5 分钟，选择成功后开始原有终端计时和录制；列表、选择按键不计入 Agent 终端录制。一次 SSH 连接选择一台设备；设备有额外获授权目标账号时，再选择目标账号。退出目标 Shell 后连接结束。

支持交互式 Shell、Ctrl-C、Tab、窗口缩放和中文。必须请求 PTY，使用固定 xterm-256color 和默认 PTY 模式，忽略客户端环境变量。运行身份与网页终端一致：Agent 设备使用 Agent 的 Linux 账号；SSH 设备使用配置的目标 SSH 账号及其默认 Shell。未指定目标账号时，sudo 取决于目标系统权限，Agent 模式还受终端提权选项控制。配置了目标账号后，SSH 入口和网页共用账号授权及直接 SSH／Agent sudo 切换方式，密码和私钥不返回客户端，详见[目标账号](device-connections.md#目标账号与登录切换方式)。

网页「终端会话」区分 SSH/网页来源，并统一展示状态、录制时长、回放和导出；管理员或原操作者可点击「结束会话」断开活跃连接。输入 `exit` 正常结束，意外 SSH/Agent 断线显示中断。SSH 退出码 0 表示会话传输正常结束，不提供 Shell 内最后一条命令/进程的退出码；自动化请继续使用命令任务。

## 不使用 HTTPS 的部署

设备仅用 SSH 时，设置 `FLEET_DEVICE_ACCESS=ssh-only`。保留网页管理可用 `FLEET_WEB_ENABLED=1`、`FLEET_WEB_PROTOCOL=http`，无需 HTTPS 证书或 CA；显式设置 `FLEET_WEB_ENABLED=0` 才关闭网页。SSH 主机密钥自动生成并持久保存，详见 [SSH 接入与网页管理](ssh-only.md)。

## 服务端配置

| 环境变量                | 含义                                                    |
| ----------------------- | ------------------------------------------------------- |
| `FLEET_SSH_PORT`        | 监听端口；不设置或 `0` 关闭；例如 `2222`                |
| `FLEET_SSH_HOST`        | 绑定地址，默认同 `FLEET_HOST`，默认本机回环             |
| `FLEET_SSH_PUBLIC_HOST` | 前端命令显示的域名/IP；默认当前网页主机名               |
| `FLEET_SSH_PUBLIC_PORT` | 前端显示的外部端口；默认实际监听端口，用于 NAT/端口映射 |

`npm run dev` 默认只在 `127.0.0.1:2222` 启用，设置 `FLEET_SSH_PORT=0` 可关闭。正式配置须重新启动服务端生效。公开入口需要 TCP 层直接转发/端口映射，普通 HTTPS 反向代理不能代理 SSH。修改绑定地址和防火墙后，其他用户连接平台地址，无须访问 Agent IP。

首次启用生成 `<FLEET_DATA_DIR>/ssh_host_ed25519_key`（0600），重启复用；应与平台数据一并备份，丢失/更换会触发客户端主机身份变化提示。HTTPS 证书与 SSH 主机密钥各自独立。

## 权限和边界

仅 admin 或有设备范围的 ops 可开 Shell；business/auditor 不可操作。SSH 和 HTTPS 共用密码验证、登录限速、用户/设备权限，SSH 内部登录凭据不会发给客户端，断连后清除。每次输入、输出和每秒定时检查权限/会话有效性；撤销设备、变更范围/角色或到期会关闭现有会话。Shell 创建前再次检查权限，防止认证后权限变化。

录制、存储失败关闭、输出序列校验及额度与网页终端共用。输出在 SQLite 提交后才传给 SSH 客户端并 ACK Agent；不保存原始按键。SSH 全局最多 64 个 TCP 连接、每 IP 16 个，握手/认证限时 10 秒，认证后须在 30 秒内请求 Shell（带目标时进入终端，不带目标时显示菜单），每个连接一个目标 Shell。终端共用每用户/设备 4、全局 32、单次 1 小时等限额。慢客户端超过发送缓存限制会中断，不无限堆积数据。

当前只有密码认证的交互终端；未实现 SSH 公钥/SSO/MFA、SFTP/SCP、`ssh host command`、VS Code Remote SSH 所需的 exec/转发、TCP/Unix socket/X11/ssh-agent 转发，这些请求明确拒绝。不能宣称与 Warpgate 全功能兼容。

“用户只能经平台访问”的网络前提：Agent 主机原有 SSH 等管理入口必须由部署者关闭或限制来源，不向使用者发放直连凭据。这次功能不自动更改机器防火墙。拥有任意 Shell（尤其 sudo）的人仍可能在目标主机建立其他连接；同 UID 身份/文件访问与进程清理边界仍见[终端说明](terminal.md)。

## 验证

`npm --prefix apps/server test` 覆盖真实 SSH 协议与模拟 Agent：密码、角色/范围、撤销、重复名称、指纹持久化、录制、权限变更、乱序、断线和禁止的请求。

`npm run test:terminal` 在隔离状态目录中启动真实 Rust Agent，同时回归网页协议和 SSH。通过系统 OpenSSH（固定 known_hosts 和仅测试用 askpass）验证实际 Linux Shell、工作目录、Ctrl-C、中文、隐藏密码、凭据续期、正常退出与录制；用 SSH 客户端库验证真实 PTY 窗口缩放。macOS 下可配置 `FLEET_AGENT_DOCKER_IMAGE=rust:bookworm` 和 `FLEET_AGENT_BIN` 使用已构建 Linux Agent。测试不访问已有设备凭据，也不改变现有设备配置。

`npm run test:ssh:browser` 连接已运行的本地开发实例，凭据参数同终端浏览器测试，验证连接命令复制/指纹、手机布局、真实 SSH Shell、时长更新、网页结束 SSH 会话及回放。截图和结果保存在 `.test-output/ssh-*`。本地验证不等于 CI、外网部署或第三方 SSH 客户端全量兼容验收。

同一 Agent 设备可配置备用 SSH，直连和菜单选择都在新会话创建时优先使用心跳有效、支持终端的 Agent，否则尝试备用 SSH。菜单显示「备用 SSH · 按需连接」；不增加第二个设备条目，现有会话保持原通道，权限和录制仍归属同一设备。配置方法见[双通道配置](device-connections.md)。
