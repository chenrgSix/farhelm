# 内网 / VPN 优先与公网备用

在「系统设置 → 平台网络策略」统一设置模式和平台入口，现有与新增设备自动继承。管理员可以配置；其他用户只能查看其授权设备的网络状态。设备 ID、分组、权限和历史录制不变。无需升级已安装的 0.2.5 Agent。

## 配置

- **系统设置**：启用统一网络策略，选择「VPN 优先、公网备用」或「仅内网 / VPN」。供所有 Agent 使用的平台内网 HTTPS 地址、平台 VPN IP 和公网备用地址均只需配置一次。
- **设备总览 → 内网地址**：只填写这台机器的内网 / EasyTier IP。SSH 内网端口可选，留空沿用 SSH 接入端口；账号、密钥、主机指纹和公网备用地址均沿用原 SSH 接入配置。
- Agent 主动连接平台，单台机器的 VPN IP 不会被误当作平台目标。只使用 Agent 时，设备内网 IP 可以留空；平台到设备的 SSH 才需要它。
- 设备未显式填写内网 IP 时，可以沿用 SSH 接入配置中的私有 IP。若接入地址为公网或域名，VPN 优先模式使用该地址并显示「未配置设备内网 IP」；仅内网模式禁止连接，直到填写设备内网 IP。
- SSH-only 部署的统一网络设置不要求 Agent 地址或 HTTPS 证书。Agent+SSH 部署需要填写平台的 Agent HTTPS 入口。
- 内网连接固定到私有 IP（RFC1918、CGNAT、IPv6 ULA 或本机验证用回环地址）。Agent HTTPS 地址可使用证书域名，配合「平台内网 / VPN IP」固定 HTTP 与 WebSocket 连接目标，仍验证原证书域名，不依赖公网 DNS 解析。Agent 须事先信任 CA；HTTP 代理环境变量不会接管平台请求。
- 平台策略保存后，在线 Agent 自动收到新配置，离线 Agent 重连后同步。Agent 需要 0.2.5 或更新版本；确认前不从旧通道下发新任务或建立新 Agent 终端。修改统一策略要求没有活跃终端或已下发/执行中的任务；设备地址修改只检查该设备。版本号防止覆盖其他管理员的修改。
- Agent 接入设置中的地址同步会标明「由平台网络策略管理」，保留真实在线状态，并暂停重复的地址下发；停用网络策略后恢复常规地址同步。
- 停用统一网络策略后恢复原接入地址。Agent 安装/首次注册地址仍由「Agent 接入设置」管理，已注册设备的运行路径由统一网络策略管理。

## 旧版配置兼容

升级不会立即切换现有链路。旧的逐设备策略继续生效，设备 SSH 内网 IP / 端口自动保留；系统设置会显示待接管的设备数。管理员首次保存统一设置后，所有设备使用统一模式和平台入口，SSH 备用地址统一沿用设备接入配置。设备页面不再允许单独修改平台模式或平台 URL。

## 连接行为

Agent 将配置保存在原状态目录，连接前验证候选平台的 TLS、设备认证及平台实例身份。内网连接失败时，VPN 优先模式尝试配置的备用入口。已连接的 Agent 每 30 秒检查路径；在公网通道上连续三轮确认内网恢复后，等待任务、上传、下载及终端空闲再重连内网，不迁移已有 Shell 或重放输入。实际链路中断可能结束原会话，重新连接会创建新的录制会话。

SSH 每次新建连接均优先尝试内网，只在网络连接失败或超时时尝试备用。主机指纹不符、账号认证失败、PTY 打开失败不会回退；终端打开后也不会自动切换到另一台 Shell。网页终端和平台 SSH 入口共用相同选路、设备范围、账号权限、撤销检查与先录制后转发流程。

## EasyTier 的实际路径

平台不安装、启动、停止或改写 EasyTier。请先独立组网：Agent 到平台的状态由 Agent 采集；SSH 到设备的状态由平台主机采集。采集使用可配置的 `easytier-cli` 和 RPC 地址，或在指定 Docker 容器中执行该 CLI，并核对 Farhelm 实际出口网卡确实持有该 EasyTier 实例的虚拟地址。Linux 需要 `ip`（iproute2）；平台在 macOS 上读取 `route` 和网卡信息。仅执行固定只读命令，有超时和输出大小限制，不运行前端传入的 Shell。

- **P2P 直连 / 中继**：目标虚拟 IP 精确匹配且实际出口网卡吻合；不会仅凭安装了 EasyTier、网卡名称、私有 IP 或 ping 成功下结论。
- **未检测到 EasyTier 路径 / 路径未知**：CLI 不可用、RPC 不可达、多实例/子网代理或路由信息不足时如实显示；直连优先与延迟优先路径冲突时也保留未知。
- Agent 状态属于当前认证连接，断连后显示历史参考；SSH 显示最近建立连接时的观测，不把历史成功当实时在线。内网可用不等于业务健康，EasyTier 中继也不等于公网业务入口回退。

仅内网模式限制 Farhelm 的业务目标地址，不禁止 EasyTier 底层利用互联网、共享节点或中继。需要完全隔绝公网时，必须具备实际内网/专网链路，并在 EasyTier 和网络边界实施相应策略。公网备用路径如果依赖同一 VPN 的默认路由，也不能被视为独立灾备链路。

## 本机与 Docker 采集配置

需更新到包含本功能的服务端／Agent 构建；已发布的 v0.2.13 尚不识别这三个环境变量。

在**执行采集的进程**中设置以下部署环境变量：Agent 的采集配置放在设备端 Agent 环境中，SSH 路径的采集配置放在平台服务环境中。两端独立生效，平台不会把本机路径或容器名下发到其他设备；修改后重启相应进程。

| 环境变量 | 默认值 | 含义 |
| --- | --- | --- |
| `FLEET_EASYTIER_CLI` | `easytier-cli` | 可执行文件名或绝对路径，支持路径中的空格；不能填写 `sudo …`、Shell 命令或相对路径 |
| `FLEET_EASYTIER_RPC` | `127.0.0.1:15888` | `主机:端口`，IPv6 使用 `[::1]:15888`，不接受 URL、凭据或命令选项 |
| `FLEET_EASYTIER_CONTAINER` | 空 | 留空执行本机 CLI；填写明确的容器名或 ID 后，只在该容器中采集，不自动搜索或回退到其他实例 |

例如，本机 CLI 连接已对采集进程开放的 RPC：

```bash
FLEET_EASYTIER_CLI=/opt/easytier/easytier-cli
FLEET_EASYTIER_RPC=127.0.0.1:15889
FLEET_EASYTIER_CONTAINER=
```

EasyTier 单独运行于 Docker，且与 Linux 采集进程共享网络命名空间时：

```bash
FLEET_EASYTIER_CLI=/usr/local/bin/easytier-cli
FLEET_EASYTIER_RPC=127.0.0.1:15888
FLEET_EASYTIER_CONTAINER=easytier
```

容器模式中的 CLI 路径与 RPC 地址从 EasyTier 容器内部解释。采集进程需要可执行的 `docker`，以及管理员已经提供的 Docker daemon 访问权限；容器需提供可供采集进程数值 UID/GID 执行的 CLI、`cat`、`readlink` 和 `timeout`（支持 `-s KILL`）。采集始终显式传 `docker exec --user <当前有效 UID>:<当前有效 GID>`，没有 sudo、root 回退、`--privileged`、自动加组或 socket 权限修改。CLI 输出最多 1 MiB，容器内 CLI 超时 2 秒，Docker 客户端单次调用最多 4 秒；只停止本次诊断进程。EasyTier 容器建议启用 init，以及时回收超时后已结束的子进程；平台不会自动修改容器启动配置。

**网络证据仍取自 Farhelm 所在的位置。** Docker 模式先比对容器与采集进程的内核启动标识、网络命名空间，再在采集进程自身环境查询目标 IP 的系统出口，并比对 EasyTier 本机虚拟 IP。因此支持 Linux 宿主机采集 + EasyTier `network_mode: host`，以及 Farhelm 与 EasyTier 显式共享网络命名空间的部署。依据见 [Docker host 网络说明](https://docs.docker.com/engine/network/drivers/host/)和 [Docker exec 用户选项](https://docs.docker.com/reference/cli/docker/container/exec/)。

独立 bridge、子网代理、远程 Docker daemon、Docker Desktop 跨虚拟机等无法匹配网络空间的组合保留「路径未知」，即使容器内 CLI 显示 P2P，也不会用于证明 Farhelm 的路径。不自动修改网络模式、路由、RPC 监听或端口映射。管理员可选择本机 CLI 访问已开放 RPC，但仍需通过本机实际出口校验，RPC 可达本身不证明走了该 VPN。

平台 Compose 已透传这三个变量。默认服务镜像未包含 Docker/EasyTier CLI 与 iproute2，也不会自动挂载 Docker socket；需要容器采集时，由部署者按实际网络和权限准备工具及访问方式，原 Compose 默认网络不变。原有安装不设置变量时继续使用本机 CLI 和默认 RPC，无需数据或协议迁移。

采集配置错误、RPC 不可达、Docker 无权限、容器未运行、缺少容器工具、命名空间或出口不匹配均保留未知；本机 CLI／Docker 可执行文件不存在显示未检测到。诊断失败不会中断正常连接或改变 VPN／公网选路策略。

## 验证

服务端回归覆盖全局继承、新设备自动生效、设备地址与平台入口隔离、旧配置迁移、管理员写权限和设备范围、版本与认证连接绑定、SSH 内网优先/备用、禁止回退、身份拒绝、网页/SSH 入口及录制。Rust 测试覆盖持久化更新和重启、固定私网地址、EasyTier 路径证据。前端测试覆盖系统设置模式切换、设备仅提交本机 IP、SSH-only 无 HTTPS 字段、清除公网字段、只读用户和旧 Agent 提示。

`node tests/e2e/network-routes.mjs` 使用三个一次性 Linux 容器及独立 Docker 网络验证真实 EasyTier P2P / 中继、Agent 回退、持续终端的恢复等待、仅内网重启与 SSH 两种入口。需准备 Linux Agent、测试镜像与浏览器；不接触已有部署。在 ARM64 开发机上可执行 `bash tests/e2e/network-routes/build-image.sh` 构建测试镜像（需先有 `farhelm-agent-dev:local`）。通过 `FLEET_ROUTE_AGENT_BIN` 指定 Linux Agent 二进制；默认读取 `.dev/route-target/debug/farhelm-agent`。结果位于 `.test-output/network-routes-e2e.json`。真实跨地域 NAT、运营商限流及公网计费不由本地容器验收替代。

### Docker 采集回归

`tests/e2e/easytier-docker.mjs` 在一次性 Docker 网络中运行真实 EasyTier 2.6.4 和单独的采集容器，分别调用服务端 TypeScript 采集器与 Agent Rust 生产采集函数。覆盖自定义 CLI／RPC、共享网络空间、P2P／中继、错误出口、独立 bridge、不同容器、RPC 失败、Docker socket 无权限，以及容器内诊断超时。采集 UID 为 501；测试容器启用 init 以回收已结束的诊断进程，不改动现有容器或宿主机网络。

ARM64 开发环境准备方式：

```bash
bash tests/e2e/network-routes/build-image.sh
docker build -t farhelm-easytier-docker-test:local tests/e2e/easytier-docker
# 在 Linux 中使用当前源码编译 agent/examples/easytier-observe.rs，或使用项目的 Linux 构建容器：
# cargo build --manifest-path agent/Cargo.toml --locked --release --example easytier-observe
FLEET_EASYTIER_PROBE_BIN=/absolute/path/to/linux/easytier-observe npm run test:easytier:docker
```

脚本要求本地 Unix Docker socket，结果写入 `.test-output/easytier-docker.json`。这是采集器与真实 Docker/EasyTier 的集成验证，不替代完整业务链路、跨地域 NAT 或生产环境验收。

2026-10-26 本地验证：服务端 198/198、协议契约 382/382、Linux arm64 Rust 57/57（55 个单元测试及 2 个契约测试，串行）通过；服务端类型检查／构建、Rust release 构建、Clippy `--all-targets -- -D warnings`、Prettier、Rust fmt 和 Compose 配置检查通过。上述真实 Docker 采集集成测试通过。首次 Rust 并行运行中，未改动的单实例锁测试失败；该用例单独运行与全量串行复验均通过，未修改锁实现。本次未修改前端，也未重跑完整业务故障矩阵，不代表 CI 或生产验收。
