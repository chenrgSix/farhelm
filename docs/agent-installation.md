# Agent 一键安装

管理员点击「添加设备」→「Agent 接入」，在弹窗填写设备名称、普通 Linux 运行账号、命令有效期和启动方式。「平台访问地址」默认带入「系统设置」中的 Agent HTTPS 地址，也可为本台设备手动填写局域网等可达的 HTTPS 地址，点击「恢复系统地址」可还原默认值。自定义地址仅用于本次安装和对应设备，不修改全局配置或其他设备。证书必须覆盖填写的域名或 IP，不能用公网 IP 的证书直接访问局域网 IP。点击「生成安装命令」，复制整条命令到目标 Linux 的 Bash 终端执行。安装需要 root，普通账号执行时自动调用 sudo。

公网和内网 IP 需要同时使用时，在「系统设置 → HTTPS 证书」的私有 CA 模式中保留公网主地址，把内网 IP 填入「附加域名或 IP」。等待新证书有效后再生成内网安装命令，详见[多地址配置步骤](private-certificates.md#公网和内网-ip-同时接入)。

安装程序识别 x86_64 / aarch64，下载平台提供的静态 Agent，校验 SHA-256，创建不存在的运行账号，写入私有配置和状态目录，启动 Agent，再等待平台确认注册且在线。前端同时显示等待、已注册、在线、过期或撤销状态。上线后可使用网页终端、SSH 统一入口、录制、任务和健康检查。

- 默认自动选择启动方式：存在运行中的 systemd 时，安装 `farhelm-agent.service` 并启用开机启动；没有 systemd 时以后台进程运行，**后台模式没有重启恢复或开机自启保证**。可以在表单中明确指定模式。
- 目标需要 Linux、Bash、curl、base64、sha256sum、getent、runuser、flock、install、nohup、sed 等常用 GNU/Linux 工具；需要创建账号时还要有 useradd。最小容器若缺少工具，应先通过系统包管理器补齐。
- Agent 不能以 UID 0 执行任务。默认账号 `farhelm` 不存在时创建为锁定密码的系统账号，提供 Bash 和 HOME；已有普通账号保持现有配置。
- 「允许终端使用该账号已有的 sudo 权限」只控制终端能否使用目标系统已有的提权策略，不创建 sudoers、不设置密码、不授予额外权限；命令任务仍强制 `no_new_privs`。设备上线后，管理员可以在接入配置中保管可选 sudo 密码。
- 已安装 Agent 0.2.11+ 可在「设备 → 更多 → 接入配置 → 默认登录账号 → 终端提权」修改开关，无需重装或编辑系统服务文件。需先结束该设备的 Agent 终端；平台显示实际状态及等待确认／失败原因，配置保存在 Agent 私有状态目录，重连和重启后保留。旧 Agent 的现有配置不自动改变，网页会提示先升级。先升级平台，再升级 Agent。系统服务若继承了 `NoNewPrivileges`，仍须由服务器管理员调整，网页不能绕过系统限制。
- Agent 0.2.12+ 的普通终端可自动代用已保存的 sudo 密码，Shell 仍保持普通账号身份。需平台与 Agent 均升级至 0.2.12，现有终端提权开关已启用，且当前用户通过原有用户／用户组／角色授权具备设备、默认登录账号和 `terminal.sudo` 权限。终端会显示「sudo 自动代填已启用」；授权撤销或凭据变更会关闭带代填能力的会话。
- 自动代填覆盖普通终端通过默认 PATH 执行的 `sudo`、`sudo -i`、`sudo su -` 等命令，不解析屏幕密码提示，也不向 PTY 写入密码。显式使用 `/usr/bin/sudo`、重设 PATH 或指定 `sudo -S` 时保持系统原有行为。密码只保存在会话内存和私有认证通道中，不写入命令参数、环境变量、录制或审计。关闭开关后新终端继续强制 `no_new_privs`；已有免密 sudo、root 入口和 SSH 登录方式保持原有逻辑。
- 已有安装、配置或身份目录会导致安装停止，不覆盖、不升级、不重置设备身份。修复失败的已有安装应检查日志并重启，而不是反复生成新身份。

## 已有 SSH 设备

在 SSH 设备行点击「安装 Agent」，使用同样的弹窗表单。设备名称沿用原值且只读；生成的命令绑定当前设备 ID，必须复制到对应目标服务器执行。上线后原设备启用 Agent 优先、SSH 备用，设备 ID、设备组标签、用户组/角色授权、历史录制不变。已打开的 SSH 会话不受影响。

注册时暂存 Agent 公钥，原设备仍为 SSH 接入；首次认证上线后才在事务内启用 Agent 并记录 `device.agent_enabled` 审计事件。命令过期、安装出错或 Agent 没有上线时，原 SSH 配置和接入方式不变。若前端提示「Agent 已注册，等待上线」，请检查目标的日志、网络及服务后启动现有 Agent；平台重启和注册命令过期不会清除已绑定身份。不要删除身份后重装。

同设备重新生成命令会作废之前未使用的命令；不同密钥不能重复绑定或覆盖已有 Agent 身份。已启用 Agent 的设备不提供此按钮，后续更新使用「Agent 升级」。

## 平台准备

优先从 [GitHub Release](https://github.com/chenrgSix/farhelm/releases) 下载对应架构的二进制及 JSON 清单，上传到「Agent 升级 → 升级包管理」。本次平台和 Agent 发布包均为 v0.2.14。Agent 命令历史需要本版构建，更新后请新建会话，旧历史不回填。旧 Agent v0.2.7 的普通连接继续兼容；使用普通终端的 sudo 密码自动代填请上传并升级本次 Agent 安装包（需 0.2.12+），启用终端提权，并确保运行账号已有相应 sudo 权限。

需要自行构建时，生成两种架构的静态 Linux 安装包（需要 Docker，可在原生架构或 Docker 支持的仿真架构构建）：

```bash
npm run build:agent:installers
# 也可以只构建指定架构：bash scripts/build-agent-installers.sh amd64
```

默认输出到 `.dev/agent-dist/`，包含 `farhelm-agent-linux-x86_64`、`farhelm-agent-linux-aarch64` 及对应 `.json` 版本清单。构建使用锁定的 Cargo 依赖；目标服务器不需要 Rust、C 编译器或特定 glibc 版本。管理员可在前端「Agent 升级 → 升级包管理」上传二进制和配套 JSON 清单；新安装命令自动使用各架构最高的可用版本，无需进入平台服务器放文件。原配置目录继续作为兼容导入来源。

服务端配置：

```bash
export FLEET_AGENT_DIST_DIR=/srv/farhelm/agent-dist
# 私有 CA 才需要；公共受信证书可以省略。
export FLEET_AGENT_CA_CERT=/srv/farhelm/tls/ca.crt
```

管理员登录前端，进入「系统设置」，填写「Agent HTTPS 地址」并点击「保存设置」。配置写入平台数据库，立即用于新生成的安装命令，无需重启，平台重启后仍会保留。仅管理员可读取和修改，修改记录写入审计；多人同时编辑时，旧版本保存会被拒绝，请重新加载后再编辑。添加 Agent 时默认使用当前配置，允许在安装弹窗中为单台设备覆盖。未配置默认地址时，也可以手动填写有效的 HTTPS 地址后生成安装命令。

`FLEET_PUBLIC_URL` 仅作为系统设置首次保存前的兼容默认值，可不设置；保存后数据库配置优先，之后无需修改环境变量。已生成的安装命令保留生成时的地址、脚本和包校验值；保存后自动向沿用系统地址的已有 Agent 同步新地址；安装时自定义地址的设备保留自己的入口，详见下方「已有 Agent 地址同步」。

点击「使用独立 Agent 地址并同步」会采用当前网页主机名和独立 Agent 对外端口（默认 8444），保存并同步；HTTP 网页也可使用此按钮。NAT / 外部代理场景填写目标设备实际可达、证书覆盖的 HTTPS origin，不能把 HTTP 网页地址填给 Agent。地址不变时可重试未完成的同步，逐设备结果在下方展示，见[网页与 Agent 接入地址](platform-entry.md)。

本地开发默认 localhost，只适用于目标和平台在同一机器。Docker Desktop / OrbStack 本地测试可用 `https://host.docker.internal:8444`；实际远程 Linux 必须配置可达地址、HTTPS 证书及监听/防火墙，不能照抄 Docker 专用名称。旧 HTTPS 网页入口迁移前仍兼容 Agent，但切网页 HTTP 前应先同步独立地址。

未配置 `FLEET_AGENT_DIST_DIR` 时，独立服务默认读取 `./data/agent-dist`；`scripts/dev.sh` 读取 `.dev/agent-dist`。未找到支持架构的有效 ELF 安装包时，前端禁止生成命令；版本库中的安装包按哈希固定，后续上传或停用不改变已生成命令；没有清单的历史目录包仍保留旧的哈希检查方式。

## 已有 Agent 地址同步

管理员保存平台访问地址后，平台通过已认证的 WSS 通道下发最新配置。系统设置中的「Agent 地址同步」显示每台设备的进度，并提供「重试未完成的同步」。仅 Agent 设备参与；SSH 设备不受影响。安装时自定义入口的设备始终以其单台地址作为同步目标，首次上线、平台重启、后续全局地址变更及同步重试均保留该入口。启用统一网络策略后，设备运行入口仍由该策略管理；停用策略后恢复单台自定义地址。只有管理员可以读取同步列表和发起重试，配置修改、重试和 Agent 的确认结果均有审计记录。

- Agent 使用现有 CA 信任校验证书，以原设备身份验证目标平台的 `server_instance`，并验证 WSS 通道；不可达、证书不匹配或不是同一平台时保留原地址。迁移不会跳过 TLS 校验，也不会自动更换受信 CA。
- 校验过程在后台运行，不阻塞心跳或终端输入。配置保存成功显示「已保存，等待终端结束」；有活动终端时继续使用原连接，结束后自动重连新地址，确认连接且持久保存后显示「已切换」。执行任务的本地 journal 和输出重放机制继续生效。
- 新地址保存在 Agent 私有 journal 的 `platform_address` 配置中，优先于原 `FLEET_SERVER_URL`，因此普通账号也可保存，无需修改 root 所有的环境文件。身份和 journal 必须一起保留；不能删除 journal 来“重置配置”。
- 目标连接失败会恢复之前的地址并报告失败；无法确定结果的超时显示待核对，不冒充已完成。最新版本和请求 ID 防止延迟回执覆盖更新的配置。
- 离线 Agent 在重新连接原入口后补同步；切换期间必须保留旧地址入口，直到所有设备完成。已失联且无法访问旧入口的机器无法远程接收新配置。
- 旧版 Agent 不支持此协议，会显示「需升级 Agent」，平台不会向它发送未知消息。先更新服务端，再升级 Agent 二进制并保留原身份和 journal。支持升级协议的设备可在前端「Agent 升级」批量更新，详见 [Agent 批量升级](agent-upgrades.md)。

API：`GET /api/v1/settings/agent-sync` 返回当前配置版本和逐设备状态；`POST /api/v1/settings/agent-sync` 接收 `v: 1` 和当前 `revision`，为未完成的设备重试，过期版本返回 409。正在校验、已保存和已完成的设备不会被重复启动迁移。

## 凭据和下载

生成命令仅限管理员。命令内包含一次性注册凭据和必要的公共 CA，关闭窗口后不再展示；数据库仅保存凭据摘要。默认有效期一小时，可选 10 分钟 / 24 小时。请勿分享命令或把它写入代码、公共日志。

引导命令通过 HTTPS 完整下载脚本，校验生成时固定的脚本 SHA-256 后才执行；脚本再校验对应架构的安装包。没有 `curl -k`、关闭证书验证或管道半下载执行。注册凭据通过临时私有文件传入 Authorization 头，不放进 URL。私有 CA 只用于本次下载及此 Agent，不修改目标系统全局信任。

脚本和安装包下载只接受未过期、未使用的安装凭据。注册后不能再下载新安装包；安装状态接口仅在原有效期内返回该次安装的状态。注册且上线后从持久化环境文件中删除一次性凭据，后续使用本地设备身份认证。已有设备身份恢复机制不变。

API：

- `GET /api/v1/settings`：管理员读取平台访问地址、配置版本及上次保存时间。
- `PUT /api/v1/settings`：管理员提交 `v: 1`、读取时的 `revision` 和 `platform_server_url`，成功后立即生效并记录 `settings.updated`；过期版本返回 409。
- `GET /api/v1/agent-install/options`：管理员读取当前地址和可用架构。
- `POST /api/v1/agent-installations`：管理员生成命令；新设备传 `name`，已有 SSH 设备传 `device_id`（名称取原设备值）。可选传入 `server_url`（HTTPS origin）覆盖本次安装入口，省略时使用系统地址。返回命令实际使用的 `server_url`，沿用 `enrollment.created` 审计事件。绑定命令会在审计中记录原设备 ID。
- `GET /api/v1/agent-installations/:id`：管理员读取本次注册进度。
- `GET /api/agent/install.sh`、`GET /api/agent/packages/:machine`：安装凭据鉴权下载。
- `GET /api/agent/install-status`：安装脚本确认该设备已上线。

## 目标上的文件和维护

- `/usr/local/bin/farhelm-agent`：root 所有，可执行。
- `/etc/farhelm-agent/agent.env`：root 专用，0600；父目录 0700。
- `/var/lib/farhelm-agent`：运行账号所有，0700；包含设备身份、journal 和私有 CA。
- systemd：`systemctl status farhelm-agent`、`journalctl -u farhelm-agent`、`systemctl restart farhelm-agent`。
- 后台模式：root 读取 `/var/log/farhelm-agent.log`；重启前先检查 `/etc/farhelm-agent/background.pid` 对应进程，确认旧 Agent 已停止，再运行 `nohup /usr/local/libexec/farhelm-agent-background >/var/log/farhelm-agent.log 2>&1 &`。Agent 状态锁拒绝同时启动第二个实例。

不要删除或单独复制身份/journal 来重新安装；二者必须成对保留。该安装器不覆盖已有安装。后续版本更新使用 [Agent 批量升级](agent-upgrades.md)；卸载和设备迁移需单独处理。

## 验证

`npm run test:agent:install` 使用独立 TLS 服务、真实浏览器和两个隔离 Linux 容器验证前端保存平台地址后立即生效、在线地址同步/活动终端保护/错误平台拒绝/重启持久化/离线补同步、生成命令、双架构安装/注册/在线、普通账号、权限、凭据清理、拒绝覆盖、网页终端与录制。需要先构建服务端、两个安装包，以及 Playwright Chromium。此测试覆盖容器后台启动，不能等同于真实主机开机或 systemd 生命周期验收。

`npm run test:ssh:install-agent` 验证 SSH 设备原地安装 Agent。本次在独立 Debian ARM64 容器、真实 Rust Agent、真实 sshd / OpenSSH 和 Chromium 上通过：过期命令失败不影响 SSH、前端绑定命令安装、保留同一设备 ID / 标签 / 用户组范围 / 加密凭据 / 历史录制、安装期间现有 SSH 会话不中断、新终端优先 Agent、停止 Agent 后新终端回退 SSH，两个通道均完成录制。桌面与手机宽度的表单均检查通过；该验证使用后台模式，不代表 systemd 或生产环境验收。
