# SSH 接入与网页管理

## 在系统设置中切换

管理员进入 **系统设置 → 平台运行方式**，可分别选择设备接入方式（Agent 和 SSH / 仅 SSH）、网页管理开关、HTTP / HTTPS，然后“保存并应用”。无需再修改这三个环境变量或手动重启进程。当前 HTTP 入口仍可管理设备、账号权限、网页终端与录制。

- 首次启动使用环境变量作为默认值，此后以数据目录中的 `deployment.json` 为准；升级已有部署时自动沿用原来的选项。备份时请连同数据目录一起保存。
- HTTPS 使用现有部署证书或平台管理的有效证书；没有证书、证书过期或域名不匹配时会拒绝切换。平台管理的证书无需重新设置 TLS 环境变量。Agent 通道仍要求 HTTPS。
- 单独切换网页协议或开关时，只调整网页监听，Agent、SSH 和已建立的终端保持连接。变更设备接入方式或首次加载 TLS 时需要重载，存在活跃终端或命令任务则拒绝；此类重载的试运行期间暂停新建终端。设备、账号权限、历史录制和 SSH 主机密钥保留。
- 网页保持开启的切换先试运行 **2 分钟**。进入提示的新地址，登录后在系统设置点击“确认保留此配置”；未确认、启动失败或试运行期间平台重启，都会恢复原配置。网页关闭是显式确认后的持久设置，不要求网页确认。
- 开关改变平台自身的监听协议和网页路由，监听地址与端口沿用部署配置。外部反向代理仍需保持协议一致。HTTPS 切回 HTTP 的响应会清除该主机的 HSTS；浏览器的上级域名 HSTS 或代理重定向需由对应部署处理，无法访问时等待自动回退。

关闭网页前，界面要求保存恢复命令。在平台服务器的项目目录中，由运行服务的系统账号执行：

```sh
node apps/server/dist/enable-web.js --data-dir /path/to/farhelm-data
```

该命令通过数据目录内 `deployment.sock`（目录 0700、socket 0600）重新开启网页，无需修改环境变量。返回网页后应在两分钟内确认。恢复通道只接受本机请求，不监听 TCP，且只能开启网页；管理员 API 的读、保存和确认操作仍需管理员身份。

API：`GET/PUT /api/v1/settings/deployment`，`POST /api/v1/settings/deployment/confirm`。保存与确认携带 `revision` 防止覆盖其他管理员的操作；变更和回退写入审计。启动尚未完成的切换会按日志恢复上次配置，而不会继续一个未经确认的设置。

## 首次部署的默认配置

设备仅使用 SSH，并不要求关闭网页。首次启动时，以下三个部署配置分别控制设备接入、网页开关及 HTTP/HTTPS 协议：

| 配置 | 取值及默认行为 |
| --- | --- |
| `FLEET_DEVICE_ACCESS` | `agent-ssh`（默认）或 `ssh-only`；后者关闭 Agent 注册、认证及控制通道，已有双接入设备沿原 ID 使用 SSH |
| `FLEET_WEB_ENABLED` | `1`（默认）开启网页管理，`0` 关闭网页管理 |
| `FLEET_WEB_PROTOCOL` | `https`（默认）或 `http`；HTTP 网页无需证书，可同时启用 Agent；Agent 接入单独使用 HTTPS |
| `FLEET_WEB_DIST` | 网页构建产物目录，开启网页时指向 `apps/web/dist` |
| `FLEET_HOST` / `FLEET_PORT` | 管理监听地址/端口，默认 `127.0.0.1`，一键安装/Compose 默认 8443，手动 SSH-only HTTP 默认 8080 |
| `FLEET_AGENT_PORT` / `FLEET_AGENT_PUBLIC_PORT` | 独立 Agent HTTPS 监听端口与对外端口，默认 8444；证书由平台管理 |
| `FLEET_SSH_HOST` / `FLEET_SSH_PORT` | SSH 入口地址/端口；仅 SSH 设备接入默认启用 2222。网页开启时可显式设端口为 `0` 关闭 SSH 入口，仅使用网页终端 |
| `FLEET_DATA_DIR` | 持久目录，保存原设备、凭据、账号权限、录制和 SSH 主机密钥 |

已有运行配置时请在系统设置中保存并应用；这三个环境变量只作为首次启动的默认值。变更设备接入方式前结束活跃终端。同一数据目录只能运行一个平台实例。

| 设备接入 | 网页开关 | 协议 | 结果 |
| --- | --- | --- | --- |
| `ssh-only` | `1` | `http` | HTTP 网页管理 + SSH 入口，无 HTTPS 证书、CA 或 Agent |
| `ssh-only` | `1` | `https` | HTTPS 网页管理 + SSH 入口，网页需要证书，目标设备无需 CA |
| `ssh-only` | `0` | 任意 | SSH 入口 + 本机 Unix 管理套接字，无 HTTP/HTTPS TCP 管理入口 |
| `agent-ssh` | `1` | `http` | HTTP 网页管理、独立 HTTPS Agent 和可选 SSH 入口 |
| `agent-ssh` | `1` | `https` | HTTPS 网页管理、独立 HTTPS Agent 和可选 SSH 入口 |
| `agent-ssh` | `0` | 任意 | 关闭网页页面，保留供 Agent 使用的 HTTPS API；仍需要证书 |

原 `FLEET_MODE=ssh-only` 保留“设备仅 SSH、网页关闭”的兼容预设，新变量可独立覆盖。新部署建议使用上面三个明确配置，避免将“只用 SSH 接入”理解为“关闭网页”。

## 无证书的 HTTP 网页管理

需要 Linux 或 macOS、Node.js 24+，目标设备运行 sshd 并允许平台使用已配置私钥登录。无需构建或安装 Agent。

```bash
npm --prefix apps/server ci
npm --prefix apps/web ci
npm --prefix apps/server run build
npm --prefix apps/web run build
export FLEET_DEVICE_ACCESS=ssh-only
export FLEET_WEB_ENABLED=1
export FLEET_WEB_PROTOCOL=http
export FLEET_WEB_DIST="$PWD/apps/web/dist"
export FLEET_HOST=127.0.0.1
export FLEET_PORT=8080
export FLEET_DATA_DIR=/var/lib/farhelm
export FLEET_SSH_HOST=127.0.0.1
export FLEET_SSH_PORT=2222
export FLEET_ADMIN_USER=admin
export FLEET_ADMIN_PASSWORD='请替换为至少8位且含英文字母和数字的密码'
node apps/server/dist/index.js
```

访问 `http://127.0.0.1:8080`，使用平台账号登录，即可添加 SSH 设备、管理设备组、账号、角色和用户组，以及使用网页终端和查看会话录制。终端通过同源 `ws://` 连接；仅传输协议变化，认证、一次性终端票据、权限范围、动态撤权和录制保持一致。系统设置不再请求不可用的 Agent 或证书接口。没有 SSH 配置的旧 Agent 设备需要在原设备的「接入配置」补充 SSH，不需要新建设备。

HTTP 不加密浏览器与平台之间的密码、终端和录制流量，适用于可信内网；默认只绑定本机。远程访问可显式修改监听地址，也可保留 HTTPS 网页协议。即使 HTTP 网页通过代理提供，也应保持 API 与终端 WebSocket 同源；只有配置的 `FLEET_CONSOLE_ORIGIN` 可作为额外允许来源。

本组合不读取 HTTPS 证书、CA、托管证书文件或 Agent 安装配置，不启动证书续签；残留的旧证书配置不会阻止启动。已签发证书及 Agent 数据保留在原数据目录，恢复原模式可继续使用。浏览器若曾为同一域名缓存 HSTS，可能自动将 HTTP 升级为 HTTPS；本机切换可使用 `http://127.0.0.1`，或使用单独的 HTTP 管理域名。

可用 [SSH + HTTP 配置](../deploy/server/ssh-only.env.example) 配合现有 [systemd 服务](../deploy/server/farhelm.service)。已有数据库沿用原用户及密码，不会被环境变量重置。只关闭网页时将 `FLEET_WEB_ENABLED=0`，参考 [无网页配置](../deploy/server/ssh-only-headless.env.example)。开发用 Vite 的 `FLEET_DEV_API_TARGET` 也支持 HTTP 上游。

SSH 入口使用原平台账号密码：

```bash
ssh -tt -p 2222 -l admin platform-host
ssh -tt -p 2222 -l 'admin:设备ID' platform-host
```

首次启用自动生成 `<dataDir>/ssh_host_ed25519_key`（0600），后续启动复用；损坏时拒绝启动，不自动更换身份。首次连接核对日志中的主机指纹，后续由客户端 `known_hosts` 检查。目标主机指纹也必须固定核验。平台 SSH 主机密钥、目标登录私钥与 HTTPS CA 相互独立。

## 无网页时管理设备、用户和录制

关闭网页且设备仅用 SSH 时，平台提供 `<FLEET_DATA_DIR>/admin.sock`，权限 0600，仅运行平台的本机账号或 root 可访问。它通过 Unix 套接字复用原管理 API，仍需平台登录及角色授权；**不会绑定任何明文 HTTP TCP 端口**，也不会因为拿到文件访问权限而跳过平台认证。无需额外证书，浏览器不能直接访问此套接字。

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

可在停服后用同一数据目录调整设备接入方式或网页开关，保留设备 ID、用户、角色、用户组、设备标签和历史录制。已配置备用 SSH 的 Agent 设备可沿原 ID 使用 SSH；仅有 Agent 的设备在此模式中无法连接。切换运行模式需要重启，因此先结束活跃终端；不能用两个进程同时打开同一数据目录。

启动会检查已有本机管理套接字：运行中拒绝重复启动，异常退出留下的旧套接字可自动恢复；普通文件、符号链接或其他用户的套接字不会被覆盖。恢复 Agent 接入时设置 `FLEET_DEVICE_ACCESS=agent-ssh` 并提供 Agent 的 HTTPS 配置（网页协议可独立选择）；网页是否开启仍由 `FLEET_WEB_ENABLED` 控制。旧 `FLEET_MODE=ssh-only` 是关闭网页的兼容预设，显式的新配置优先。

SSH PTY、设备菜单、权限动态校验和录制使用与完整模式相同的流程。仍不开放 SFTP/SCP、端口转发、任意 SSH exec 或免审计通道。依赖 Agent 的命令任务、健康和网络采集、Agent 升级在本模式不可用。

## 验证

```bash
npm --prefix apps/server test
npm --prefix apps/server run build
docker build -t farhelm-sshd-test:local tests/e2e/ssh-target
npm run test:ssh:only
npm run test:ssh:web
```

端到端测试使用独立临时数据库与 Linux OpenSSH 容器，通过实际服务端启动入口运行，无 HTTPS 证书、网页或 Agent。验证系统 OpenSSH 的严格主机指纹检查、用户组设备筛选、越权拒绝、撤权断连、隐藏输入不录制、正常结束及完整录制，并检查正常重启和异常退出后的主机密钥及数据保持。结果保存在 `.test-output/ssh-only-e2e.json`；不会修改当前开发平台。

`test:ssh:web` 另验证 HTTP 网页：设备接入配置、创建角色/用户组/账号、按组授权、权限拒绝、真实 SSH 网页终端、录制回放和普通 HTTP 下复制 SSH 命令。使用独立数据库、无 Agent 的 Linux sshd 和 Chromium，不修改当前平台。可用 `FLEET_CHROMIUM_BIN` 指定本机 Chromium。结果为 `.test-output/ssh-web-e2e.json`。
