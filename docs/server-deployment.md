# 服务端部署：一键安装与 Docker Compose

两种方式都包含构建后的 Vue 网页、API、Agent 接入和 SSH 统一入口；Farhelm 直接提供 HTTP/HTTPS 网页、API 和独立 Agent HTTPS，无需安装 Nginx、单独启动 Vite 或安装 Rust。默认启用 Agent + SSH、HTTPS、平台私有 CA 自动签发/续签。Agent 二进制和 JSON 清单仍在登录后通过「Agent 升级 → 升级包管理」上传。

部署前选择客户端可达的域名或 IP，例如 `10.10.0.10`；不要照抄示例地址。EasyTier 由部署者单独安装，地址和网络策略在系统设置配置。

## 方式一：Linux 一键安装

支持使用 systemd 的现代 glibc Linux，x86_64 / ARM64，建议 Debian 12+ / Ubuntu 22.04+。安装器自动准备必要命令、下载并校验 Node.js 24.21.0，使用普通 `farhelm` 用户构建前后端，配置 systemd 并执行健康检查。需要下载 GitHub 源码、Node.js 和 npm 依赖；不修改系统默认 Node，不需要预先安装 npm 或 Rust。

当前 GitHub 仓库公开。复制下面的一条命令安装 v0.2.8，将 IP 改成自己的；命令已带 `--web-http`，直接启用 HTTP 网页和 HTTPS Agent：

```bash
( installer="$(mktemp)" && trap 'rm -f "$installer"' EXIT && curl --fail --silent --show-error --location --proto '=https' --proto-redir '=https' https://raw.githubusercontent.com/chenrgSix/farhelm/v0.2.8/install.sh -o "$installer" && bash "$installer" --ref v0.2.8 --host 10.10.0.10 --web-http )
```

不加 `--web-http` 时网页默认 HTTPS。私有仓库部署仍可先执行 `gh auth login`，通过 GitHub CLI 下载对应版本安装脚本。脚本在提权前读取当前用户的 gh 凭据，通过临时 0600 文件传给安装过程；不把访问令牌放进命令参数、服务配置或日志。也支持 `GH_TOKEN` / `GITHUB_TOKEN` / `--token-file`。私有仓库不支持匿名 curl 安装；不会为部署而修改仓库可见性。

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

- 网页：默认 `https://10.10.0.10:8443`，使用 `--web-http` 时为 `http://10.10.0.10:8443`；Agent 始终为 `https://10.10.0.10:8444`，SSH 网关为 `10.10.0.10:2222`。
- 初始管理员默认 `admin`，随机密码保存在上面的 0600 文件中，不输出到服务日志。登录后可修改密码；文件保存的是初始凭据，修改密码后它不会更新，可自行安全删除。
- CA 公共证书：`/var/lib/farhelm/ca.crt`。网页选择 HTTPS 时，通过可信运维渠道复制到管理员电脑并信任一次；HTTP 网页无需浏览器信任 CA。不要复制 CA 私钥。新 Agent 的安装命令自动携带 CA。后续服务端证书续签不需要再次信任。
- 服务端程序及独立 Node：`/opt/farhelm/current`、`/opt/farhelm/runtime`。
- 环境配置：`/etc/farhelm/server.env`；持久化数据：`/var/lib/farhelm`。
- 已完成的安装再次执行会保留现状，不覆盖数据、不重置密码、不重启服务。这是安装器，不是无停机升级器。

可选参数：

```bash
# 修改网页/SSH 网关端口；绑定低端口时仅给服务授予端口绑定能力
sudo bash install.sh --source . --host farhelm.example.com --web-port 443 --agent-port 8444 --ssh-port 2222

# HTTP 网页 + HTTPS Agent，Agent 的 CA 仍自动签发和续签
sudo bash install.sh --source . --host 10.10.0.10 --web-http

# 设备只通过 SSH 接入，保留 HTTP 网页管理，不生成 HTTPS 证书
sudo bash install.sh --source . --host 10.10.0.10 --ssh-only-http
```

未传 `--host` 时使用本机检测到的第一个 IP，无法检测时为 localhost；多网卡、NAT 或 VPN 场景应明确指定地址。内部 ACME HTTP 验证监听使用 8080，不可与网页、Agent 或 SSH 网关端口重叠。安装器不会修改防火墙规则。

原生自启通过 `systemctl enable --now farhelm` 配置。源码下载和构建临时目录自动清理，前端 node_modules、npm 缓存和服务端开发依赖不会留在安装目录。安装失败不删除已经生成的数据；若已生成服务配置，可先查日志，再用 `systemctl restart farhelm` 恢复，不要删除数据库重新安装。

## 方式二：Docker Compose

主机安装 Docker Engine 和 Compose v2，Linux 上启用 Docker 开机启动。首次需要联网拉取基础镜像和 npm 依赖；镜像构建时完成前后端编译，运行时无需再安装依赖。

```bash
# 也可下载 Release 源码包后进入解压目录
git clone --branch v0.2.8 https://github.com/chenrgSix/farhelm.git
cd farhelm/deploy
cp compose.env.example .env
```

以下 Compose 命令均在 `deploy/` 目录执行，使用该目录的 `compose.yml` 和 `.env`。编辑 `.env` 的 `FARHELM_PUBLIC_HOST` 为客户端可达的域名/IP，然后执行：

```bash
docker compose up -d --build --wait
```

网页默认 `https://你的域名或IP:8443`，Agent HTTPS 默认 `8444`（`FARHELM_AGENT_PORT`），SSH 网关默认 `2222`。

从仓库根目录操作时，显式指定 `--env-file deploy/.env -f deploy/compose.yml`，例如 `docker compose --env-file deploy/.env -f deploy/compose.yml up -d --build --wait`。从旧版根目录布局迁移时，将原根目录 `.env` 移到 `deploy/.env`；固定项目名 `farhelm` 和数据卷名保持不变，使用过 `-p` 的部署继续沿用原项目名。

```bash
# 查看初始随机密码（不会出现在 docker compose logs）
docker compose exec server cat /var/lib/farhelm/bootstrap-admin.json

# 网页使用 HTTPS 时导出 CA 公共证书，在管理员电脑首次信任
docker compose cp server:/var/lib/farhelm/ca.crt ./farhelm-ca.crt

# 状态及日志
docker compose ps
docker compose logs -f server
```

Compose 使用非 root 用户、只读容器根文件系统、命名数据卷和 `restart: unless-stopped`。Docker 随开机启动后，容器会按重启策略自动恢复；手动停止的容器不会自行恢复，需再执行 `docker compose up -d`。[Docker 重启策略说明](https://docs.docker.com/engine/containers/start-containers-automatically/)

健康检查分别检查网页的实际 HTTP/HTTPS 和 Agent HTTPS；两者关闭时检查本地管理套接字状态，HTTPS 校验证书；网页开关和协议从前端更改后无需改健康检查脚本。`up --wait` 等待健康状态，而非只等待容器进程创建。

HTTP 网页 + HTTPS Agent：首次启动前在 `deploy/.env` 设置：

```env
FARHELM_PUBLIC_HOST=10.10.0.10
FARHELM_WEB_PORT=8443
FARHELM_AGENT_PORT=8444
FARHELM_SSH_PORT=2222
FLEET_DEVICE_ACCESS=agent-ssh
FLEET_WEB_PROTOCOL=http
```

启动后访问 `http://10.10.0.10:8443`；Agent 使用 `https://10.10.0.10:8444`，安装命令自动携带 CA。浏览器不需要信任该 CA，Agent 的证书校验、后台自动续签和热加载继续运行。HTTP 网页不加密登录与终端流量，适用于受控内网或 VPN；跨不可信网络管理时选择 HTTPS。

| 入口 | 默认对外端口 | 用途 |
| --- | --- | --- |
| 网页 HTTP 或 HTTPS | 8443 | 登录、管理 API、网页终端、录制回放 |
| Agent HTTPS / WSS | 8444 | 安装下载、注册、认证、控制和任务传输；不提供管理 API |
| SSH 网关 | 2222 | 平台账号认证、设备选择、终端及录制；使用持久 SSH 主机密钥 |

端口号不会随网页 HTTP/HTTPS 切换而改变。仅开放网页端口不足以连接 Agent，目标设备必须能访问独立 Agent 端口。

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
  docker compose -f compose.yml -f compose.acme.yml up -d --build --wait
  ```

- TLS-ALPN-01：公网 443 必须到达平台 TLS 入口。启用 Agent 时设置 `FARHELM_AGENT_PORT=443`，或配置 TCP 转发至 Agent TLS 端口；仅 SSH + HTTPS 网页时转发至网页 TLS 端口。
- 网页/API 与 Agent 使用独立端口，HTTPS 证书由平台签发并同步热加载到两个监听器；续签不重启 Agent 或终端。已有外部代理的特殊部署可参考 [可选代理示例](../deploy/examples/nginx/README.md)。

详细步骤见[公网证书部署](production-certificates.md)。公开验证所需的公网端口与平台内部监听端口是两个概念。

## 数据、备份和更新

数据目录/卷包含设备、账号权限、SQLite 数据库、录制、上传的 Agent 包、SSH 主机密钥、加密凭据以及 CA 私钥，必须整体保留。**同一个数据目录只能运行一个平台实例。** 本安装入口只初始化新目录或继续自身未完成的初始化；不会自动接管其他部署的非空目录。

- 原生：保留 `/var/lib/farhelm`、`/etc/farhelm/server.env`；升级源码/程序时不要覆盖这些目录。
- Compose：默认卷为 `farhelm_farhelm-data`（使用 `-p` 会改变项目前缀）。普通 `docker compose down` 保留卷；**`down -v` 会删除数据，不用于更新**。更新源码后 `docker compose up -d --build --wait` 会重建容器并继续使用原卷。
- 备份时先停止平台，使用 `python3 scripts/backup.py /var/lib/farhelm /备份目录/新备份 --server-stopped`（在源码根目录执行），或完整备份停止后的数据卷。脚本会生成 SQLite 快照并保存 CA、证书、密钥、安装与运行配置，详细恢复步骤见[备份说明](runbooks/recovery.md)。
- 软件升级/容器重建会重启进程并中断正在使用的终端；证书日常续签仍使用现有热加载机制。两者不可混同。
- 当前不会自动清理已有录制和 Agent 发布版本；安装临时文件会清理，Docker 旧镜像/构建缓存按部署方策略清理，避免误删数据卷。

## 验证

`npm run test:server:backup` 检查备份后重新初始化入口、HTTPS 启动、账号与历史录制、原 CA 签发能力及失败清理。`npm run test:server:bootstrap` 检查首次初始化、初始密码策略、CA 与账号持久化、HTTP 无证书启动、异常目录保护和中断恢复。`npm run test:server:compose` 使用隔离 Compose 项目和真实 sshd 检查网页/API、SSH 入口、终端录制及容器重建后的持久化；会清理测试项目和临时卷，不接触默认部署。

原生安装可用 `npm run test:server:native` 在一次性 Debian systemd 容器中复现：下载 Node、非 root 构建、实际安装、重启自启、连接录制、重复安装不重启及缓存清理。该测试容器为运行 systemd 使用 privileged，仅用于隔离测试，正式 Compose 不使用 privileged。测试依赖本机 Node 24+、项目 npm 依赖和 `farhelm-sshd-test:local` 测试镜像（可从 `tests/e2e/ssh-target/Dockerfile` 构建）。

如需同时验证真实 Agent，可在上述集成测试命令前设置 `FARHELM_TEST_AGENT_BIN=/绝对路径/farhelm-agent-linux-aarch64`（或与 Docker 主机架构匹配的 x86_64 包）。直接复用发布包，不重建 Rust 缓存。

2026-10-17 在 ARM64 Linux 容器实际验证：原生 systemd 安装和重启自启、Compose HTTPS / HTTP 首次启动和重建、网页静态资源及登录、真实 sshd 的网页终端与 SSH 网关录制、CA / SSH 主机密钥 / 管理员 / 设备 / 历史录制保留，以及发布版 Agent 的 HTTPS 信任和 PTY 录制。x86_64 安装路径已实现，未进行本次 x86_64 系统级验收；公网 CA 正式签发仍需在实际域名或公网 IP 环境验证。

## 已有部署迁移

v0.2.8 更新服务端和网页，Agent 仍使用 v0.2.7，协议兼容；已有 Agent 无需为本次分离升级或重新注册。升级程序会重启服务，应先结束终端并停服备份，再保留原数据目录启动新版本。一键安装脚本不会覆盖已完成安装，不能当作升级命令。

1. 保留网页端口，另开放 Agent HTTPS 端口（默认 8444）；Compose 使用新版 `deploy/compose.yml`，原生部署检查 `FLEET_AGENT_PORT`。旧 HTTPS 网页入口暂时兼容 Agent。
2. 在「系统设置 → Agent 接入设置」点击「使用独立 Agent 地址并同步」，或填写实际可达的 `https://主机:Agent端口`。同步需等待活跃任务和终端结束，核对逐台同步结果及设备在线状态。NAT/外部代理应使用对外端口，并设置 `FLEET_AGENT_PUBLIC_PORT`；Compose 对应 `FARHELM_AGENT_PORT`。
3. 启用 VPN 网络策略时，同步更新策略中的平台 HTTPS 地址；确认离线设备的配置和旧安装命令也已安排迁移。
4. 在「系统设置 → 平台运行方式」保持「Agent 和 SSH」与网页开启，只将网页协议改为 HTTP，点击「保存并应用」。
5. **另开标签页**访问提示的 `http://主机:原网页端口`，登录后在两分钟内点击「确认保留此配置」。未确认或新入口失败会恢复原配置。确认后的选择写入 `deployment.json`，重启后继续使用；不需要修改环境变量。
6. 验证网页登录、设备在线、新建终端、SSH 入口和录制回放。Agent 地址仍须为 HTTPS；HTTP 管理入口会拒绝 Agent 接入。

在线 Agent 还在旧网页入口时，系统阻止切 HTTP 或关闭网页；离线 Agent 和已复制的旧安装命令不会因此自动改变地址，需保留旧入口至迁移完成。网页协议切换与回退不会关闭已经建立的终端连接，切换后从新地址登录继续管理；浏览器主动刷新/退出会按既有规则处理其终端，因此要保留活跃终端页面，用另一个标签页确认。外部代理或上级域名的 HSTS 强制 HTTPS 时，先调整对应入口，否则等待自动回退。改变设备接入方式或首次加载 TLS 仍需无活跃任务/终端再重载。

`npm run test:split-listeners` 在隔离环境使用真实 Linux Agent，验证 HTTP 网页 + HTTPS Agent、两种网页协议下的自动续签、持续 Web/SSH PTY、完整录制和入口隔离。默认复用 `.dev/agent-dist/farhelm-agent-linux-aarch64` 与 `farhelm-agent-dev:local`，可用 `FARHELM_TEST_AGENT_BIN` / `FARHELM_TEST_AGENT_IMAGE` 指定兼容的非 root Linux 测试镜像和二进制。
