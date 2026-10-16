# 仅 SSH 模式

设置 `FLEET_MODE=ssh-only` 后，Farhelm 只对网络开放 SSH 入口。平台、SSH 客户端和目标设备都不需要 HTTPS 证书或 CA，也不需要安装 Agent。目标设备需运行 sshd，并允许平台使用已配置的私钥登录。

```text
SSH 客户端 → Farhelm SSH 入口 → 目标 sshd
                 │
                 ├─ 平台账号、角色、用户组和设备范围校验
                 └─ 终端输出录制、审计和历史保存
```

## 启动

需要 Linux 或 macOS、Node.js 24+ 和服务端依赖；无需构建网页或 Agent。

```bash
npm --prefix apps/server ci
npm --prefix apps/server run build
export FLEET_MODE=ssh-only
export FLEET_DATA_DIR=/var/lib/farhelm
export FLEET_SSH_HOST=0.0.0.0
export FLEET_SSH_PORT=2222
export FLEET_ADMIN_USER=admin
export FLEET_ADMIN_PASSWORD='请替换为你自己的至少12字符密码'
node apps/server/dist/index.js
```

也可把 [仅 SSH 环境配置](../deploy/server/ssh-only.env.example) 保存为 `/etc/farhelm/server.env`，配合现有 [systemd 服务](../deploy/server/farhelm.service) 使用。首次启动生成管理员；已有数据库沿用原用户及密码，不会被环境变量重置。

| 配置 | 行为 |
| --- | --- |
| `FLEET_MODE` | 默认 `full` 保持原 HTTPS/网页/Agent 模式；显式 `ssh-only` 开启本模式，其他值拒绝启动 |
| `FLEET_SSH_HOST` | 默认 `FLEET_HOST`，未设置时为 `127.0.0.1`；远程接入需配置实际绑定地址 |
| `FLEET_SSH_PORT` | 本模式默认 `2222`，必须为 1–65535，不能使用 `0` 关闭唯一网络入口 |
| `FLEET_DATA_DIR` | 持久目录；保存账号、加密目标凭据、录制、SSH 主机密钥和本机管理套接字 |

本模式不读取 HTTPS 证书、CA、托管证书文件、网页目录和 Agent 安装配置，不启动 HTTPS 或 ACME 监听/续签。旧环境中残留的这些变量不会导致尝试读取证书。数据目录路径应简短，`<FLEET_DATA_DIR>/admin.sock` 的 UTF-8 路径长度不能超过 100 字节。

启动日志显示 SSH 主机指纹。首次启用自动生成 `<FLEET_DATA_DIR>/ssh_host_ed25519_key`，权限 0600，后续启动复用；损坏时拒绝启动，不自动更换身份。目录权限为 0700。应备份整个数据目录，包含 `credentials.key` 和 SQLite 数据，保留设备、权限、录制与主机身份。

连接方式与完整模式一致，使用**平台账号密码**：

```bash
# 显示该用户有权使用的设备，再按编号选择。
ssh -tt -p 2222 -l admin platform-host
# 直接连接指定设备。
ssh -tt -p 2222 -l 'admin:设备ID' platform-host
```

首次连接核对启动日志中的 SSH 指纹，后续由客户端 `known_hosts` 检查。目标主机指纹也必须固定核验；平台 SSH 主机密钥和目标登录私钥均与 HTTPS CA 无关。

## 无网页时管理设备、用户和录制

平台同时提供 `<FLEET_DATA_DIR>/admin.sock`，权限 0600，仅运行平台的本机账号或 root 可访问。它通过 Unix 套接字复用原管理 API，仍需平台登录及角色授权；**不会绑定任何明文 HTTP TCP 端口**，也不会因为拿到文件访问权限而跳过平台认证。无需额外证书，浏览器不能直接访问此套接字。

以下示例使用 curl 和 jq，以平台运行账号执行。先在权限 0700 的私有目录创建 `login.json`，内容为平台账号和密码，例如 `{"username":"admin","password":"你的平台密码"}`，文件权限设为 0600。不要把真实凭据提交到 Git。

```bash
SOCK=/var/lib/farhelm/admin.sock
PRIVATE=/path/to/your/private-admin-directory
umask 077
# 获取会话并将认证头存入私有文件，避免把密码或令牌写进命令行参数。
curl --fail-with-body --silent --show-error --unix-socket "$SOCK" \
  -H 'Content-Type: application/json' --data-binary @"$PRIVATE/login.json" \
  http://localhost/api/v1/login > "$PRIVATE/session.json"
jq -r '"header = \"Authorization: Bearer \(.access_token)\""' \
  "$PRIVATE/session.json" > "$PRIVATE/curl-auth.conf"

# 读取设备、账号/角色/用户组、SSH 指纹和录制列表。
curl --fail --silent --show-error --unix-socket "$SOCK" \
  --config "$PRIVATE/curl-auth.conf" http://localhost/api/v1/devices
curl --fail --silent --show-error --unix-socket "$SOCK" \
  --config "$PRIVATE/curl-auth.conf" http://localhost/api/v1/access
curl --fail --silent --show-error --unix-socket "$SOCK" \
  --config "$PRIVATE/curl-auth.conf" http://localhost/api/v1/ssh
curl --fail --silent --show-error --unix-socket "$SOCK" \
  --config "$PRIVATE/curl-auth.conf" http://localhost/api/v1/terminal-sessions
```

添加目标设备：将目标 SSH 地址、账号、已核对的主机 SHA256 指纹和私钥准备为私有 JSON 文件。目标目前使用私钥认证，不支持目标账号密码认证；加密私钥可附加 `passphrase`。

```bash
jq -n --rawfile key /path/to/target_private_key \
  '{v:1,name:"linux-01",ssh:{host:"192.168.1.20",port:22,username:"ops",fingerprint:"替换为已核对的SHA256指纹"},private_key:$key}' \
  > "$PRIVATE/device.json"
curl --fail-with-body --silent --show-error --unix-socket "$SOCK" \
  --config "$PRIVATE/curl-auth.conf" -H 'Content-Type: application/json' \
  --data-binary @"$PRIVATE/device.json" http://localhost/api/v1/ssh-devices
```

其余接口复用原协议：`POST /api/v1/users`、`POST /api/v1/roles`、`POST /api/v1/groups`、`PUT /api/v1/devices/:id/connection` 等，见[用户与分组授权](access-control.md)和[接入配置](device-connections.md)。修改角色或设备范围仍会立即撤销不再获授权的活跃 SSH 会话。

通过 `GET /api/v1/terminal-sessions/:id/recording?after=0` 读取录制，每页最多 128 条事件，使用响应 `next` 作为下次 `after`，直到事件为空。录制里的 `output` 数据为 Base64，按事件顺序解码；不要把录制输出直接当作本机 Shell 命令执行。操作完成后删除本次创建的凭据、会话和认证头临时文件。

## 切换与边界

可在停服后用同一数据目录从完整模式切到本模式，保留设备 ID、用户、角色、用户组、设备标签和历史录制。已配置备用 SSH 的 Agent 设备可沿原 ID 使用 SSH；仅有 Agent 的设备在此模式中无法连接。切换运行模式需要重启，因此先结束活跃终端；不能用两个进程同时打开同一数据目录。

启动会检查已有本机管理套接字：运行中拒绝重复启动，异常退出留下的旧套接字可自动恢复；普通文件、符号链接或其他用户的套接字不会被覆盖。恢复完整模式时设置 `FLEET_MODE=full` 并提供原 HTTPS 配置。

SSH PTY、设备菜单、权限动态校验和录制使用与完整模式相同的流程。仍不开放 SFTP/SCP、端口转发、任意 SSH exec 或免审计通道。依赖 Agent 的命令任务、健康和网络采集、Agent 升级在本模式不可用。

## 验证

```bash
npm --prefix apps/server test
npm --prefix apps/server run build
docker build -t farhelm-sshd-test:local tests/e2e/ssh-target
npm run test:ssh:only
```

端到端测试使用独立临时数据库与 Linux OpenSSH 容器，通过实际服务端启动入口运行，无 HTTPS 证书、网页或 Agent。验证系统 OpenSSH 的严格主机指纹检查、用户组设备筛选、越权拒绝、撤权断连、隐藏输入不录制、正常结束及完整录制，并检查正常重启和异常退出后的主机密钥及数据保持。结果保存在 `.test-output/ssh-only-e2e.json`；不会修改当前开发平台。
