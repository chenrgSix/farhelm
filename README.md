# Linux Fleet · P0/P1 本地最小版本

Rust/Tokio Agent + TypeScript/Fastify 单体 + Vue 3 + SQLite WAL + 本地输出对象目录。单设备授权 Exec 只有一条持久化任务链，支持可选 SSH 统一入口；不依赖 MQ、Redis、Kubernetes、tlog、auditd 或 EasyTierManager。

这是可在隔离 Linux 开发环境运行的 MVP，不是已经通过生产安全验收的发行版。现提供网页/SSH 交互终端、会话录制与回放；P2 完整验收和 P3 EasyTier 私网优先、公网回退仍有剩余工作。实际验证清单见 [测试报告](docs/test-report.md)和[终端验证](docs/terminal.md)。

设备页现可配置 HTTP/HTTPS、TCP 和 systemd 业务健康检查，由目标 Agent 定时执行；支持立即探测、失败阈值及结果过期，详见[健康检查](docs/health-checks.md)。EasyTier 私网可达仍未采集。

## 已确认的单账号边界

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
export FLEET_ADMIN_PASSWORD='请替换为你自己的至少12字符密码'
npm run dev
```

启动脚本只在项目 `.dev/` 下生成 7 天本地开发 CA、服务端证书和状态；不修改系统信任、账号、权限、systemd 或生产服务。控制台 http://127.0.0.1:5173 仅监听 loopback，Vite 把 API 代理到校验证书的 HTTPS 服务；Agent 通过 HTTPS/WSS 访问 https://localhost:8443。此 HTTP 控制台只供本机开发，不能暴露到网络。

浏览器直接访问 HTTPS 服务时，需要用户自行把 `.dev/tls/ca.crt` 加入受控开发信任或使用受信正式证书。请勿绕过浏览器证书警告、设置 `NODE_TLS_REJECT_UNAUTHORIZED=0` 或关闭 Agent TLS 校验。Agent 用 `FLEET_CA_CERT` 指定受信 CA，默认使用公共根证书。

登录 → 设备页 → 点击「连接终端」→ 像普通终端一样输入命令。连续命令共享 Shell 和工作目录，支持 Tab 补全、Ctrl-C、窗口缩放与中文。输入 `exit` 退出；「终端会话」可以查看回放与导出记录。运维角色仍受设备范围约束。

设备页「SSH 连接」提供标准客户端命令，使用平台账号和密码连接统一入口；目标设备通过 Agent 通道接入，无需开放 SSH。开发默认入口 `127.0.0.1:2222`；也可用 `ssh -tt -p 2222 -l admin 127.0.0.1` 登录后按编号选设备。功能和部署边界见 [SSH 统一入口](docs/ssh-gateway.md)。

原有「命令任务」保留用于需要超时、幂等重试和独立结果的操作，可输入 argv JSON 数组，例如 `["/usr/bin/uptime"]`。任务模式不自动拼接 Shell。`journalctl` 的可见范围取决于用户配置的系统账号，失败不会自动 sudo 或加组。

Ctrl-C 停止本次开发服务。数据保留以便重新启动验证。开发密码只在首次 bootstrap 创建管理员，不会在每次启动时重置已有账号密码。

## 独立配置

服务端：FLEET_HOST、FLEET_PORT、FLEET_DATA_DIR、FLEET_TLS_CERT、FLEET_TLS_KEY、FLEET_ADMIN_USER、FLEET_ADMIN_PASSWORD、FLEET_WEB_DIST。

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
