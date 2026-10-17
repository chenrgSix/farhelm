# 服务端部署：一键安装与 Docker Compose

两种方式都包含构建后的 Vue 网页、API、Agent 接入和 SSH 统一入口；不需要单独启动 Vite，也不需要在平台服务器安装 Rust。默认启用 Agent + SSH、HTTPS、平台私有 CA 自动签发/续签。Agent 二进制和 JSON 清单仍在登录后通过「Agent 升级 → 升级包管理」上传。

部署前选择客户端可达的域名或 IP，例如 `10.10.0.10`；不要照抄示例地址。EasyTier 由部署者单独安装，地址和网络策略在系统设置配置。

## 方式一：Linux 一键安装

支持使用 systemd 的现代 glibc Linux，x86_64 / ARM64，建议 Debian 12+ / Ubuntu 22.04+。安装器自动准备必要命令、下载并校验 Node.js 24.21.0，使用普通 `farhelm` 用户构建前后端，配置 systemd 并执行健康检查。需要下载 GitHub 源码、Node.js 和 npm 依赖；不修改系统默认 Node，不需要预先安装 npm 或 Rust。

当前 GitHub 仓库是私有的。在目标服务器安装并登录 GitHub CLI（`gh auth login`）后，复制这一条命令，将 IP 改成自己的：

```bash
( installer="$(mktemp)" && trap 'rm -f "$installer"' EXIT && gh api -H 'Accept: application/vnd.github.raw+json' 'repos/chenrgSix/farhelm/contents/install.sh?ref=main' > "$installer" && bash "$installer" --host 10.10.0.10 )
```

脚本在提权前读取当前用户的 gh 凭据，通过临时 0600 文件传给安装过程；不把访问令牌放进命令参数、服务配置或日志。也支持 `GH_TOKEN` / `GITHUB_TOKEN` / `--token-file`。私有仓库不支持匿名 curl 安装；不会为部署而修改仓库可见性。

已经下载源码时，不需要 GitHub 登录：

```bash
sudo bash install.sh --source . --host 10.10.0.10
```

安装完成后：

```bash
sudo systemctl status farhelm
sudo cat /var/lib/farhelm/bootstrap-admin.json
sudo journalctl -u farhelm -f
```

- 网页：`https://10.10.0.10:8443`，SSH 网关：`10.10.0.10:2222`。
- 初始管理员默认 `admin`，随机密码保存在上面的 0600 文件中，不输出到服务日志。登录后可修改密码；文件保存的是初始凭据，修改密码后它不会更新，可自行安全删除。
- CA 公共证书：`/var/lib/farhelm/ca.crt`。通过可信运维渠道复制到管理员电脑并信任一次；不要复制 CA 私钥。新 Agent 的安装命令自动携带 CA。后续服务端证书续签不需要再次信任。
- 服务端程序及独立 Node：`/opt/farhelm/current`、`/opt/farhelm/runtime`。
- 环境配置：`/etc/farhelm/server.env`；持久化数据：`/var/lib/farhelm`。
- 已完成的安装再次执行会保留现状，不覆盖数据、不重置密码、不重启服务。这是安装器，不是无停机升级器。

可选参数：

```bash
# 修改网页/SSH 网关端口；绑定低端口时仅给服务授予端口绑定能力
sudo bash install.sh --source . --host farhelm.example.com --web-port 443 --ssh-port 2222

# 设备只通过 SSH 接入，保留 HTTP 网页管理，不生成 HTTPS 证书
sudo bash install.sh --source . --host 10.10.0.10 --ssh-only-http
```

未传 `--host` 时使用本机检测到的第一个 IP，无法检测时为 localhost；多网卡、NAT 或 VPN 场景应明确指定地址。内部 ACME HTTP 验证监听使用 8080，不可与网页或 SSH 网关端口重叠。安装器不会修改防火墙规则。

原生自启通过 `systemctl enable --now farhelm` 配置。源码下载和构建临时目录自动清理，前端 node_modules、npm 缓存和服务端开发依赖不会留在安装目录。安装失败不删除已经生成的数据；若已生成服务配置，可先查日志，再用 `systemctl restart farhelm` 恢复，不要删除数据库重新安装。

## 方式二：Docker Compose

主机安装 Docker Engine 和 Compose v2，Linux 上启用 Docker 开机启动。首次需要联网拉取基础镜像和 npm 依赖；镜像构建时完成前后端编译，运行时无需再安装依赖。

```bash
# 私有仓库先 gh auth login；或下载源码包后进入解压目录
gh repo clone chenrgSix/farhelm
cd farhelm
cp deploy/server/compose.env.example .env
```

编辑 `.env` 的 `FARHELM_PUBLIC_HOST` 为客户端可达的域名/IP，然后执行：

```bash
docker compose up -d --build --wait
```

网页默认 `https://你的域名或IP:8443`，SSH 网关默认 `2222`。

```bash
# 查看初始随机密码（不会出现在 docker compose logs）
docker compose exec server cat /var/lib/farhelm/bootstrap-admin.json

# 导出 CA 公共证书，在管理员电脑首次信任
docker compose cp server:/var/lib/farhelm/ca.crt ./farhelm-ca.crt

# 状态及日志
docker compose ps
docker compose logs -f server
```

Compose 使用非 root 用户、只读容器根文件系统、命名数据卷和 `restart: unless-stopped`。Docker 随开机启动后，容器会按重启策略自动恢复；手动停止的容器不会自行恢复，需再执行 `docker compose up -d`。[Docker 重启策略说明](https://docs.docker.com/engine/containers/start-containers-automatically/)

健康检查读取当前实际 HTTP/HTTPS 或本地管理套接字状态，HTTPS 校验证书；网页开关和协议从前端更改后无需改健康检查脚本。`up --wait` 等待健康状态，而非只等待容器进程创建。

HTTP + 设备仅 SSH 模式：首次启动前在 `.env` 设置：

```env
FLEET_DEVICE_ACCESS=ssh-only
FLEET_WEB_PROTOCOL=http
```

此时网页使用 `http://地址:8443`（也可修改 `FARHELM_WEB_PORT`），不会初始化 CA。数据卷已经初始化后，设备接入方式、网页开关和 HTTP/HTTPS 由「系统设置」维护；修改环境变量不会覆盖已保存设置，也不会重置管理员。

## 公网证书与端口

默认私有 CA 可立即在内网使用。需要浏览器公共信任时，在「系统设置 → HTTPS 证书」切换公网自动申请并配置域名/IP、邮箱及验证方式。先按[证书迁移说明](private-certificates.md)处理已有 Agent 的信任；不要直接把入口换成 Agent 尚不信任的证书。

- HTTP-01：公网 80 必须转发至平台内部 ACME 8080。Compose 可启用附加配置：

  ```bash
  docker compose -f compose.yaml -f deploy/server/compose.acme.yaml up -d --build --wait
  ```

- TLS-ALPN-01：公网 443 必须到达平台 TLS 入口。Compose 设置 `FARHELM_WEB_PORT=443`，或配置 TCP 转发。
- 网页、API、Agent 使用同一个入口。Nginx 如需放在前面，使用 TCP 转发才能继续由平台统一热加载证书。

详细步骤见[公网证书部署](production-certificates.md)。公开验证所需的公网端口与平台内部监听端口是两个概念。

## 数据、备份和更新

数据目录/卷包含设备、账号权限、SQLite 数据库、录制、上传的 Agent 包、SSH 主机密钥、加密凭据以及 CA 私钥，必须整体保留。**同一个数据目录只能运行一个平台实例。** 本安装入口只初始化新目录或继续自身未完成的初始化；不会自动接管其他部署的非空目录。

- 原生：保留 `/var/lib/farhelm`、`/etc/farhelm/server.env`；升级源码/程序时不要覆盖这些目录。
- Compose：默认卷为 `farhelm_farhelm-data`（使用 `-p` 会改变项目前缀）。普通 `docker compose down` 保留卷；**`down -v` 会删除数据，不用于更新**。更新源码后 `docker compose up -d --build --wait` 会重建容器并继续使用原卷。
- 备份时先停止平台，完整复制数据，完成后启动。不要只复制 SQLite 主文件而遗漏 WAL、录制、密钥和证书。
- 软件升级/容器重建会重启进程并中断正在使用的终端；证书日常续签仍使用现有热加载机制。两者不可混同。
- 当前不会自动清理已有录制和 Agent 发布版本；安装临时文件会清理，Docker 旧镜像/构建缓存按部署方策略清理，避免误删数据卷。

## 验证

`npm run test:server:bootstrap` 检查首次初始化、初始密码策略、CA 与账号持久化、HTTP 无证书启动、异常目录保护和中断恢复。`npm run test:server:compose` 使用隔离 Compose 项目和真实 sshd 检查网页/API、SSH 入口、终端录制及容器重建后的持久化；会清理测试项目和临时卷，不接触默认部署。

原生安装可用 `npm run test:server:native` 在一次性 Debian systemd 容器中复现：下载 Node、非 root 构建、实际安装、重启自启、连接录制、重复安装不重启及缓存清理。该测试容器为运行 systemd 使用 privileged，仅用于隔离测试，正式 Compose 不使用 privileged。测试依赖本机 Node 24+、项目 npm 依赖和 `farhelm-sshd-test:local` 测试镜像（可从 `tests/e2e/ssh-target/Dockerfile` 构建）。

如需同时验证真实 Agent，可在上述集成测试命令前设置 `FARHELM_TEST_AGENT_BIN=/绝对路径/farhelm-agent-linux-aarch64`（或与 Docker 主机架构匹配的 x86_64 包）。直接复用发布包，不重建 Rust 缓存。

2026-10-17 在 ARM64 Linux 容器实际验证：原生 systemd 安装和重启自启、Compose HTTPS / HTTP 首次启动和重建、网页静态资源及登录、真实 sshd 的网页终端与 SSH 网关录制、CA / SSH 主机密钥 / 管理员 / 设备 / 历史录制保留，以及发布版 Agent 的 HTTPS 信任和 PTY 录制。x86_64 安装路径已实现，未进行本次 x86_64 系统级验收；公网 CA 正式签发仍需在实际域名或公网 IP 环境验证。
