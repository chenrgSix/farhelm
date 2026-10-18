# Farhelm · 遥舵

管理员可在 **API Token** 页面为脚本和 AI 创建独立凭据，配置权限、设备范围和有效期，下载配套 Skill 与 OpenAPI 文档。所有调用继续受用户授权约束并保留审计，详见 [通用 API 与 Skill](docs/api-tokens.md)。

**分散设备，一处掌控。** Linux 设备连接、授权操作、健康检查与执行审计控制台，当前预览版为 **v0.2.8**（Agent 沿用 v0.2.7）。

Rust/Tokio Agent + TypeScript/Fastify 单体 + Vue 3 + SQLite WAL + 本地输出对象目录。单设备授权 Exec 只有一条持久化任务链，支持可选 SSH 统一入口；不依赖 MQ、Redis、Kubernetes、tlog、auditd 或 EasyTierManager。

这是可在隔离 Linux 开发环境运行的 MVP，不是已经通过生产安全验收的发行版。现提供网页/SSH 交互终端、会话录制与回放；现已支持平台统一配置 [VPN 优先、公网备用或仅内网](docs/network-routes.md)，并采集实际 EasyTier P2P / 中继路径；P2/P3 完整生产验收仍有剩余工作。实际验证清单见 [测试报告](docs/test-report.md)和[终端验证](docs/terminal.md)。

设备页现可配置 HTTP/HTTPS、TCP 和 systemd 业务健康检查，由目标 Agent 定时执行；支持立即探测、失败阈值及结果过期，详见[健康检查](docs/health-checks.md)。网络通道与 EasyTier 路径独立于业务健康显示，详见[网络策略](docs/network-routes.md)。

Agent 自动采集本机网卡 IPv4 / IPv6，并在本地记录与平台断连的检测、恢复时间，恢复后补传。设备页「网络记录」可查看 IP 和中断历史；需要 Agent 0.2.2 或更新版本。详见[网络记录](docs/agent-network.md)。

Agent 0.2.3 起可在设备「网络记录」中配置多个网络探测地址、间隔、超时及连续失败阈值。平台断开后仍独立探测、保存并补传证据，区分平台连接异常、部分目标异常和疑似网络故障。

设备支持 **Agent / SSH 两种接入**，同一 Agent 设备可在「接入配置」添加备用 SSH，新终端优先使用 Agent，不可用时尝试备用 SSH，沿用设备 ID、授权与录制。已有 SSH 设备可点击「安装 Agent」，执行绑定原设备的安装命令，上线后自动使用 Agent 优先、原 SSH 备用，失败不影响 SSH。管理员可在前端添加 SSH 设备，配置地址、端口、账号、私钥和主机指纹；未安装 Agent 的机器也可通过网页终端及平台 SSH 入口操作，保留会话录制。Agent 可选 sudo 密码目前仅支持管理员加密保存，暂不提供查看或自动使用。详见[双接入配置](docs/device-connections.md)。

管理员现可在「用户与权限」创建账号、自定义角色和用户组，分配角色及具体设备范围。设备页的「管理设备组」支持创建、编辑、删除标签，列表支持按组筛选及多选设备批量添加、移除标签。设备组是便于批量选择的可选标签，可重叠、可为空，新设备默认不入组；调整标签不影响已有授权。详见[用户与分组授权](docs/access-control.md)。

平台将网页协议与 Agent 接入独立配置：网页可选 HTTP/HTTPS（默认端口 8443），Agent 使用独立 HTTPS 端口 8444，CA 与证书继续自动管理。系统设置中可切换网页协议，已有终端及录制保留；旧 Agent 先同步独立地址再切换。**设备仅用 SSH** 与 **关闭网页管理** 也独立配置：设置 `FLEET_DEVICE_ACCESS=ssh-only`、`FLEET_WEB_ENABLED=1`、`FLEET_WEB_PROTOCOL=http` 即可使用无需证书的 HTTP 网页，管理设备、账号权限和录制，并保留网页终端及 SSH 入口。只有显式设置 `FLEET_WEB_ENABLED=0` 才关闭网页。SSH 主机密钥自动生成并持久保存，详见 [SSH 接入与网页管理](docs/ssh-only.md)。

服务端支持 [Linux 一键安装与 Docker Compose 部署](docs/server-deployment.md)，两种方式均直接提供前端、API 和 HTTPS，无需 Nginx。Compose 配置位于 [deploy/compose.yml](deploy/compose.yml)，在 `deploy/` 目录启动，包含持久化数据和自动启动配置。

## 项目名称与兼容性

项目名称为 **Farhelm（遥舵）**，npm 包为 `farhelm`、`@farhelm/server`、`@farhelm/web`，Rust Agent 包及可执行文件为 `farhelm-agent`。

GitHub 仓库为 [chenrgSix/farhelm](https://github.com/chenrgSix/farhelm)，本地项目目录统一使用 `farhelm/`。新环境可用 `git clone https://github.com/chenrgSix/farhelm.git` 获取代码，然后进入 `farhelm/` 执行下方命令。

现有 `FLEET_*` 环境变量、服务端 `fleet.sqlite` 数据库文件、开发容器中的 `fleet` 账号和路径继续沿用。v1 签名域 `fleet-v1`、JSON Schema 的 `https://fleet.local/contracts/v1/` 标识与公开测试向量保持兼容；这些是已有配置、数据和协议的固定标识。历史验证日志保留当时的名称和输出。

## 目标 Linux 单账号边界

用户自行配置一个非 root Linux 账号，Agent 和 Exec 使用该账号。服务端用真实平台用户 ID 记录操作者、设备、任务、argv、cwd、结果和输出。业务/审计角色不能任意 Exec，运维还需设备范围授权。

同 UID 的命令能够读 Agent 私钥、修改本地 journal/outbox、干扰采集；服务器已经收到的记录不会因本地删日志消失，但服务器录制并不能自动解决端点被篡改或冒用身份的问题。仅向可信运维开放任意 Exec。这不是双账号隔离、沙箱或防绕过审计，详见 [ADR-006](docs/adr/0006.md)。

普通进程组支持 TERM→KILL 和回收，但 setsid/double-fork 后代可以逃逸。因此在本版本中，强制超时/取消可能返回 UNKNOWN + cleanup-unconfirmed，而不是假称所有后代均已消失。UNKNOWN 永不自动重跑。

## 本地启动

需要 Linux x86_64、Node.js 24+、Rust/Cargo 1.99+（本次验证 1.99.0）、C 编译工具、OpenSSL、Python 3。依赖来自 npm/crates.io。不要用 root 启动 Agent 的 Exec 后端。

```bash
npm ci
npm --prefix apps/server ci
npm --prefix apps/web ci
npm --prefix tests/contracts ci
cargo build --manifest-path agent/Cargo.toml --locked
export FLEET_ADMIN_USER=admin
export FLEET_ADMIN_PASSWORD='请替换为至少8位且含英文字母和数字的密码'
npm run dev
```

启动脚本只在项目 `.dev/` 下生成长期本地开发 CA、可自动续签的服务端证书和状态；不修改系统信任、账号、权限、systemd 或生产服务。控制台 https://localhost:5173 默认仅监听 loopback，Vite 把 API、Agent WebSocket 和健康接口代理到校验证书的 HTTPS 服务；Agent 通过独立 HTTPS/WSS 入口 https://localhost:8444 接入。已有服务端时可单独运行 `npm run dev:web` 启动 HTTPS 前端，不会重启服务端或 Agent。Docker Agent 与宿主机浏览器共用入口时使用 `https://host.docker.internal:5173`，本机解析与证书信任配置见[统一平台入口](docs/platform-entry.md)。

已有目录更名时，应先停止本地服务，连同 `.dev/` 一起移动，并从新目录重新启动。Docker 的绑定挂载保存绝对路径，开发容器也需要重新创建并指向新目录；重新创建前保留容器内自行安装的工具及文件。保留原有 Agent 状态目录和服务端数据库，即可继续使用已有设备身份、配置和会话录制。

本地根证书有效期为 10 年，并限制仅签发给本地开发地址；服务端证书有效期为 90 天，HTTPS 前端启动时和每小时检查，剩余 30 天时自动续签，前后端热加载且不关闭已有连接。旧 7 天证书需先完成一次根证书信任迁移，见[自动续签](docs/platform-entry.md#自动续签与热加载)。浏览器直接访问 HTTPS 服务时，需要用户自行把 `.dev/tls/ca.crt` 加入受控开发信任或使用受信正式证书。请勿绕过浏览器证书警告、设置 `NODE_TLS_REJECT_UNAUTHORIZED=0` 或关闭 Agent TLS 校验。Agent 用 `FLEET_CA_CERT` 指定受信 CA，默认使用公共根证书。

登录 → 设备页 → 点击「连接终端」→ 像普通终端一样输入命令。连续命令共享 Shell 和工作目录，支持 Tab 补全、Ctrl-C、窗口缩放与中文。输入 `exit` 退出；「终端会话」可以查看回放与导出记录。运维角色仍受设备范围约束。

管理员在「系统设置 → Agent 接入设置」配置 Agent HTTPS 地址，或点击「使用独立 Agent 地址并同步」，采用当前主机名和独立 Agent 端口。网页使用 HTTP 时仍可管理自动证书与 CA。旧 HTTPS 网页入口保留兼容，迁移步骤见[服务端部署](docs/server-deployment.md)。设置立即生效并持久保存；添加 Agent 时自动带入，并自动同步到支持此功能的在线 Agent；终端结束后切换，失败保留原地址，前端可查看逐台结果。

管理员可在「Agent 升级」上传安装包及版本清单，管理多版本、停用或启用包，再选择目标版本和设备批量更新，支持并发限制、离线排队、现有终端完成后切换、失败回退和逐台结果。新版运行账号无需 sudo；更早的 Agent 首次需更新一次基础程序。见 [Agent 批量升级](docs/agent-upgrades.md)。

「添加设备」的 SSH 和 Agent 接入均为弹窗表单。Agent 可生成一条安装命令，在目标 Linux 执行后自动安装、注册并启动；平台先用 `npm run build:agent:installers` 准备 ARM64 / x86_64 静态安装包。地址、CA、运行账号和 systemd/容器启动说明见 [Agent 一键安装](docs/agent-installation.md)。

设备页「SSH 连接」提供标准客户端命令，使用平台账号和密码连接统一入口；目标设备按配置使用 Agent 通道或 SSH 接入。开发默认入口 `127.0.0.1:2222`；也可用 `ssh -tt -p 2222 -l admin 127.0.0.1` 登录后按编号选设备。功能和部署边界见 [SSH 统一入口](docs/ssh-gateway.md)。

原有「命令任务」保留用于需要超时、幂等重试和独立结果的操作，可输入 argv JSON 数组，例如 `["/usr/bin/uptime"]`。任务模式不自动拼接 Shell。`journalctl` 的可见范围取决于用户配置的系统账号，失败不会自动 sudo 或加组。

Ctrl-C 停止本次开发服务。数据保留以便重新启动验证。开发密码只在首次 bootstrap 创建管理员，不会在每次启动时重置已有账号密码。

## 独立配置

服务端：FLEET_HOST、FLEET_PORT、FLEET_AGENT_PORT、FLEET_AGENT_PUBLIC_PORT、FLEET_WEB_PROTOCOL、FLEET_DATA_DIR、FLEET_TLS_CERT、FLEET_TLS_KEY、FLEET_ADMIN_USER、FLEET_ADMIN_PASSWORD、FLEET_WEB_DIST。

Agent：FLEET_SERVER_URL（HTTPS origin）、FLEET_CA_CERT、FLEET_STATE_DIR（绝对路径）、FLEET_ENROLLMENT_TOKEN（首次注册）、FLEET_DEVICE_NAME、FLEET_EXECUTION_BACKEND（same-uid 或 disabled）、FLEET_HEARTBEAT_MS。

身份与 journal 必须成对保留。丢失一方会停止自动恢复，需要人工核对，不能自动生成新身份继续旧任务。注册码只存摘要，一次性使用；原密钥可证明持有权恢复已注册的同一设备。访问 token 短期有效、只进 Authorization 头，撤销会关闭旧连接并拒绝新认证。

## 数据和可靠性

- 服务端先写任务、真实操作人、授权结果和创建审计，之后才下发
- Agent 先事务写 journal + accepted outbox，后 ACK；RUNNING 在 spawn 前落盘
- 每设备并发 1，单实例身份锁；相同 ID 永久去重，同 ID 异 payload 拒绝
- HTTP Idempotency-Key 绑定用户与请求内容；重试不生成新的副作用任务
- 输出边读边落盘，经独立 HTTPS 上传，SHA-256/大小校验、fsync/rename后建立索引；finished 只在所需对象已持久化后 ACK
- ACK 丢失重传同一事件，Agent 只在逐事件 ACK 后删 outbox；任务墓碑不删除
- 重启发现 RUNNING → UNKNOWN，绝不因为消息重投重新执行
- 输出硬限额会停止任务，保存已捕获部分并标 audit_complete=false；UI 预览截断与原始审计不完整分开
- WSS 最大 64 KiB；输出对象最大 1 MiB/任务配置限额；无无限 WSS 输出
- SQLite WAL + synchronous=FULL、foreign_keys、busy_timeout；实际断电保证仍依赖底层文件系统

## 发布包

GitHub Release 提供 Linux ARM64（aarch64）与 x86_64 Agent、各自的 JSON 清单、源码 ZIP 和 `SHA256SUMS`。Agent 二进制与同架构 JSON 清单配对上传到前端「Agent 升级」即可管理和批量安装。源码 ZIP 包含当前提交的逐文件校验清单，不包含本地 `.dev/`、凭据或未提交文件。

维护者在干净提交上执行 `npm run package:source`，导出到 `.dev/releases/v<版本>/`；不会修改源码树。预览版仍需在目标部署环境自行完成验收。变更见 [CHANGELOG](CHANGELOG.md)。

## 开发与测试

```bash
npm --prefix apps/server run typecheck
npm --prefix apps/server test
npm --prefix apps/web run typecheck
npm --prefix apps/web test
npm --prefix apps/web run build
npm --prefix tests/contracts test
cargo test --manifest-path agent/Cargo.toml --locked
npm run test:e2e
npm run test:terminal # 先构建服务端和真实 Linux Agent
# 可选：需本机可运行 Chromium（FLEET_CHROMIUM_BIN 可覆盖路径）
npm run test:browser
# 针对已启动的本地实例，显式提供管理员凭据
FLEET_ADMIN_USER=admin FLEET_ADMIN_PASSWORD='你的本地密码' npm run test:terminal:browser
```

端到端测试启动真正的 Rust 可执行文件、TLS Fastify/WSS、SQLite 和 Linux 子进程，不用 JavaScript Agent 冒充。纯协议攻击测试会使用测试客户端，报告中单独标明。测试证书、账号、数据均为临时本地数据，不含真实生产密钥。故障注入须显式 FLEET_TEST_MODE=1，仅接受 loopback 测试服务。

## 目录与下一步

- `agent/`：身份、TLS/WSS、journal/outbox、Exec/清理、输出对象
- `apps/server/`：用户/设备认证、RBAC、任务状态机、持久化审计、输出索引
- `apps/web/`：登录、设备、任务、结果、审计
- `contracts/v1/`、`tests/contracts/`：JSON Schema、正反例、跨语言签名/哈希契约
- `tests/e2e/`：真实 Agent 集成与故障测试
- `deploy/dev/`、`scripts/`：本地 TLS 和启动/备份工具
- `docs/adr/`、`docs/acceptance/`：决策和 P0–P5 验收目标

[P0–P5 里程碑](docs/architecture.md) · [恢复与备份](docs/runbooks/recovery.md) · [协议](PROTOCOL.md)

未经用户另行授权，不部署真实设备、不重启生产服务、不改系统账号/权限。正式域名、SSO/MFA、权限配置管理、保留策略、加密/外部防篡改审计、强进程隔离、规模压测与依赖许可证审查仍是上线前工作。项目发布许可证由用户决定；当前源码不包含对外发布授权。

正式环境可在「系统设置 → HTTPS 证书」配置域名或公网 IPv4 / IPv6 和邮箱，启用 Let’s Encrypt 自动申请及续签，并查看状态、到期时间、计划续签时间和失败重试计划。公网 IP 自动使用短期证书，续签热加载保留 Agent 和终端连接。默认由 Farhelm 直接提供 HTTPS；已有外部代理时可选用 TCP 转发，详见[正式证书部署](docs/production-certificates.md)。

纯内网部署支持 [私有 CA 自动签发与续签](docs/private-certificates.md)：在系统设置配置域名或 IP，网页和 Agent 使用独立端口，Agent 始终使用 HTTPS；网页选择 HTTP 时无需浏览器信任 CA，选择 HTTPS 时共用托管证书。新安装的 Agent 自动携带 CA；浏览器首次信任后，日常服务端证书续签无需再次授权。

管理员可在系统设置的“平台运行方式”中直接切换设备接入、网页开关和 HTTP/HTTPS，支持试运行确认与失败回退，详见 [SSH 设备接入与网页管理](docs/ssh-only.md)。
