# Agent 一键安装

管理员点击「添加设备」→「Agent 接入」，在弹窗填写设备名称、普通 Linux 运行账号、命令有效期和启动方式。「平台服务端地址」由平台统一配置并自动带入，以只读方式展示，无需逐台填写。点击「生成安装命令」，复制整条命令到目标 Linux 的 Bash 终端执行。安装需要 root，普通账号执行时自动调用 sudo。

安装程序识别 x86_64 / aarch64，下载平台提供的静态 Agent，校验 SHA-256，创建不存在的运行账号，写入私有配置和状态目录，启动 Agent，再等待平台确认注册且在线。前端同时显示等待、已注册、在线、过期或撤销状态。上线后可使用网页终端、SSH 统一入口、录制、任务和健康检查。

- 默认自动选择启动方式：存在运行中的 systemd 时，安装 `farhelm-agent.service` 并启用开机启动；没有 systemd 时以后台进程运行，**后台模式没有重启恢复或开机自启保证**。可以在表单中明确指定模式。
- 目标需要 Linux、Bash、curl、base64、sha256sum、getent、runuser、flock、install、nohup、sed 等常用 GNU/Linux 工具；需要创建账号时还要有 useradd。最小容器若缺少工具，应先通过系统包管理器补齐。
- Agent 不能以 UID 0 执行任务。默认账号 `farhelm` 不存在时创建为锁定密码的系统账号，提供 Bash 和 HOME；已有普通账号保持现有配置。
- 「允许终端使用该账号已有的 sudo 权限」只控制终端能否使用目标系统已有的提权策略，不创建 sudoers、不设置密码、不授予额外权限；命令任务仍强制 `no_new_privs`。设备上线后，管理员可以在接入配置中保管可选 sudo 密码。
- 已有安装、配置或身份目录会导致安装停止，不覆盖、不升级、不重置设备身份。修复失败的已有安装应检查日志并重启，而不是反复生成新身份。

## 平台准备

构建两种架构的静态 Linux 安装包（需要 Docker，可在原生架构或 Docker 支持的仿真架构构建）：

```bash
npm run build:agent:installers
# 也可以只构建指定架构：bash scripts/build-agent-installers.sh amd64
```

默认输出到 `.dev/agent-dist/`，包含 `farhelm-agent-linux-x86_64` 和 `farhelm-agent-linux-aarch64`。构建使用锁定的 Cargo 依赖；目标服务器不需要 Rust、C 编译器或特定 glibc 版本。将包放入平台配置的目录，部署与当前服务端匹配的版本。

服务端配置：

```bash
export FLEET_AGENT_DIST_DIR=/srv/farhelm/agent-dist
export FLEET_PUBLIC_URL=https://fleet.example.com
# 私有 CA 才需要；公共受信证书可以省略。
export FLEET_AGENT_CA_CERT=/srv/farhelm/tls/ca.crt
```

`FLEET_PUBLIC_URL` 是平台统一管理的「平台服务端地址」，由部署管理员配置后重启服务生效。添加 Agent 时前端只读展示，生成命令始终使用服务端配置，不接受请求覆盖。未配置时禁止生成安装命令。地址必须是目标机器可访问且证书覆盖的 HTTPS origin，不能使用前端 Vite 的 HTTP 地址；本地开发脚本默认 localhost，只适用于目标和平台在同一机器。Docker Desktop / OrbStack 本地测试可用 `https://host.docker.internal:8443`，开发证书包含该主机名。实际远程 Linux 必须配置可达地址、HTTPS 证书及监听/防火墙，不能直接使用这个 Docker 专用名称。

未配置 `FLEET_AGENT_DIST_DIR` 时，独立服务默认读取 `./data/agent-dist`；`scripts/dev.sh` 读取 `.dev/agent-dist`。未找到支持架构的有效 ELF 安装包时，前端禁止生成命令；生成后更换安装包会使旧命令校验失败，应重新生成。

## 凭据和下载

生成命令仅限管理员。命令内包含一次性注册凭据和必要的公共 CA，关闭窗口后不再展示；数据库仅保存凭据摘要。默认有效期一小时，可选 10 分钟 / 24 小时。请勿分享命令或把它写入代码、公共日志。

引导命令通过 HTTPS 完整下载脚本，校验生成时固定的脚本 SHA-256 后才执行；脚本再校验对应架构的安装包。没有 `curl -k`、关闭证书验证或管道半下载执行。注册凭据通过临时私有文件传入 Authorization 头，不放进 URL。私有 CA 只用于本次下载及此 Agent，不修改目标系统全局信任。

脚本和安装包下载只接受未过期、未使用的安装凭据。注册后不能再下载新安装包；安装状态接口仅在原有效期内返回该次安装的状态。注册且上线后从持久化环境文件中删除一次性凭据，后续使用本地设备身份认证。已有设备身份恢复机制不变。

API：

- `GET /api/v1/agent-install/options`：管理员读取默认地址和可用架构。
- `POST /api/v1/agent-installations`：管理员生成命令，沿用 `enrollment.created` 审计事件。
- `GET /api/v1/agent-installations/:id`：管理员读取本次注册进度。
- `GET /api/agent/install.sh`、`GET /api/agent/packages/:machine`：安装凭据鉴权下载。
- `GET /api/agent/install-status`：安装脚本确认该设备已上线。

## 目标上的文件和维护

- `/usr/local/bin/farhelm-agent`：root 所有，可执行。
- `/etc/farhelm-agent/agent.env`：root 专用，0600；父目录 0700。
- `/var/lib/farhelm-agent`：运行账号所有，0700；包含设备身份、journal 和私有 CA。
- systemd：`systemctl status farhelm-agent`、`journalctl -u farhelm-agent`、`systemctl restart farhelm-agent`。
- 后台模式：root 读取 `/var/log/farhelm-agent.log`；重启前先检查 `/etc/farhelm-agent/background.pid` 对应进程，确认旧 Agent 已停止，再运行 `nohup /usr/local/libexec/farhelm-agent-background >/var/log/farhelm-agent.log 2>&1 &`。Agent 状态锁拒绝同时启动第二个实例。

不要删除或单独复制身份/journal 来重新安装；二者必须成对保留。该安装器不提供自动升级、卸载或设备迁移。

## 验证

`npm run test:agent:install` 使用独立 TLS 服务、真实浏览器和两个隔离 Linux 容器验证生成命令、双架构安装/注册/在线、普通账号、权限、凭据清理、拒绝覆盖、网页终端与录制。需要先构建服务端、两个安装包，以及 Playwright Chromium。此测试覆盖容器后台启动，不能等同于真实主机开机或 systemd 生命周期验收。
