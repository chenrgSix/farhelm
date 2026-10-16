# 纯内网统一入口与自动证书

Farhelm 可在完全离线的内网创建本平台专用 CA，在「系统设置 → HTTPS 证书」选择「纯内网（平台私有 CA）」后，为指定域名或 IP 自动签发、续签 HTTPS 服务端证书。网页、API、Agent 的 HTTPS/WSS 共用一个入口和证书，不需要单独部署前端证书，也不需要公网域名、互联网连接或 HTTP 80 端口。

## 部署入口

先构建 `apps/server`、`apps/web`；服务端使用 Node 24+。设置 `FLEET_WEB_DIST` 指向构建后的 `apps/web/dist`，由 Farhelm 直接提供网页和 API。示例见 [内网环境配置](../deploy/server/private.env.example)、[systemd 服务](../deploy/server/farhelm.service)。系统设置的内网托管能力仅在已配置静态网页目录时开放。

可以直接对内网开放 Farhelm 的 HTTPS 8443 端口，访问 `https://farhelm.internal:8443`。需要标准 443 时，可使用 [Nginx TCP 转发示例](../deploy/nginx/farhelm-private.conf)，由 Farhelm 终止 TLS；Nginx 无需读取证书或在续签时 reload。内网 DNS / hosts 负责把域名指向该服务器。IP 入口也支持 IPv4、IPv6，表单中 IPv6 不加方括号，访问 URL 加方括号。

独立 Vite / Nginx HTTPS 入口的证书不会自动随本功能更新。正式内网部署应按上述方式统一入口，而不是把前端地址指向一个仍独立终止 TLS 的服务。SSH 网关的主机密钥另行管理，不使用 HTTPS CA。

## 首次初始化：只信任一份 CA

新部署没有受信 HTTPS 入口时，在服务器上先运行：

```sh
node scripts/init-private-tls.mjs /var/lib/farhelm
```

脚本需要已构建的服务端；应以 Farhelm 服务账号运行，或将生成目录的所有权交给该账号。它创建持久 CA 和用于 SSH 隧道的 `localhost` 初始化证书，输出 CA 公共证书路径、SHA-256 指纹及 TLS 配置路径。重复运行保留 CA 和已有证书；缺失、损坏或不匹配的身份文件不会被静默覆盖。

通过已有可信 SSH / 运维渠道，把 `/var/lib/farhelm/bootstrap-tls/ca.crt` 复制到管理员电脑，并核对指纹。此文件只有 CA 公共证书；不要分发 `certificates/private-ca.json`，其中含 CA 私钥。

- macOS：把 CA 导入钥匙串，并按组织规范设为 SSL 信任。
- Windows：导入「受信任的根证书颁发机构」，也可用域策略统一下发。
- Linux：导入系统或所用浏览器的信任库；使用独立证书库的浏览器需单独导入。

启动平台后，建立 `ssh -L 8443:127.0.0.1:8443 your-server`，通过 `https://localhost:8443` 登录。初始化证书与后续正式内网证书由同一持久 CA 签发，客户端已信任此 CA 后，无需第二次信任。此初始化入口仅用于配置，生产 Agent 地址不要填 localhost。

已有受信管理入口的部署，可以直接在系统设置创建并下载 CA，无需运行初始化脚本；切换前完成新 CA 的信任配置。

## Edge 已信任 CA 但仍提示证书错误

如果 macOS 已信任平台 CA，新启动的同版本 Edge 可正常访问，而原来的 Edge 仍提示 `NET::ERR_CERT_AUTHORITY_INVALID`，先核对两者访问的是同一入口、收到相同证书，并排除代理和 DNS 差异。新浏览器通过校验，不能替代对原浏览器的验证。

1. 在报错的 Edge 打开 `edge://policy`，检查 `CAPlatformIntegrationEnabled`。如果组织策略禁用系统证书集成，应由管理员处理；策略含义见 [Microsoft Edge 文档](https://learn.microsoft.com/en-us/deployedge/microsoft-edge-policies/caplatformintegrationenabled)。
2. 打开 `edge://certificate-manager`，在「本地证书」中检查「使用从操作系统导入的本地证书」（`Use imported local certificates from your operating system`）。使用系统中已信任的私有 CA 时，此项应开启。
3. 如果开关已开启且不受组织策略限制，可以关闭后立即重新开启，再刷新平台入口。这会重新应用浏览器的系统证书信任配置；操作结束时保持开启。若仍报错，继续核对该浏览器的证书列表和诊断日志，不把刷新开关视为所有证书错误的通用修复。
4. 在原浏览器中重新验证登录、网页终端、正常退出及录制回放，确认实际使用的浏览器已经恢复。

2026-10-16 在 macOS / Edge 155 的实际环境中验证：同一浏览器进程、同一服务端证书和 CA 保持不变，重新应用上述开关后 HTTPS 和 WSS 恢复正常。故障范围是该浏览器的系统证书信任状态，无需修改平台证书生成逻辑。网页代码无法代替浏览器执行证书信任管理；日常续签继续复用原 CA。

## 系统设置流程

1. 进入「HTTPS 证书」，选择「纯内网（平台私有 CA）」，填写统一入口域名或 IP，保存。无需联系邮箱及外部证书机构条款。
2. 如果还没有 CA，点击「创建内网 CA」，再下载 CA 并核对指纹，完成管理员电脑的首次信任。使用初始化脚本的部署会直接显示同一 CA。
3. 如果已有 Agent，先在同页点击「同步 CA 到已有 Agent / 重试」，等待全部就绪，再启用「自动申请和续签证书」并保存。页面自动显示申请状态、签发机构、服务端到期时间、续签计划、CA 指纹和 CA 到期时间。
4. 用配置的域名或 IP 打开统一 HTTPS 入口。在「Agent 接入设置」保存该入口地址，之后生成 Agent 安装命令。证书设置不会提前改写正在使用的 Agent 地址。

安装命令会把该入口当前使用的私有 CA 嵌入引导命令，curl 使用 `--cacert` 校验下载，安装完成后 Agent 使用 `/var/lib/farhelm-agent/ca.crt` 校验 HTTPS/WSS。无需在目标服务器单独手动复制 CA，也不会关闭 TLS 校验或把 CA 加入整个目标服务器的系统信任库。CA 私钥不会进入安装命令或接口响应。

安装命令保存生成时的地址和 CA 快照。更换 CA / 入口后应重新生成命令。已有 Agent 可在此页一键同步新 CA；只同步地址不会改变 CA 信任。日常服务端证书续签保持 CA 不变，不需要改 Agent 配置。

## 自动续签与恢复

平台 CA 有效期为 10 年，CA 私钥以 ECDSA P-384 生成；服务端使用新的 ECDSA P-256 私钥，证书有效期最长 90 天，含精确域名 / IP SAN、serverAuth 用途，不能签发下级 CA。签发使用 Node 原生 WebCrypto 和固定版本 [@peculiar/x509](https://github.com/PeculiarVentures/x509)，不调用外部网络或系统 openssl。

服务端每分钟检查，通常在剩余约 30 天时续签。文件原子写入后热加载，新 TLS 握手使用新证书，已有 HTTPS/WSS 终端连接继续运行。证书设置并发修改有版本检查；同一时间只运行一个签发任务。失败保留当前证书并退避重试，页面显示原因；关闭网页不影响后台续签。

管理员可在内网证书设置中点击「立即续签」，提前签发并热加载同一 CA 下的新证书，用于续签演练；无需修改系统时间或等待到期。此操作沿用 5 分钟冷却、配置版本检查、单任务限制和审计记录，仅对当前已托管的内网证书开放。「立即检查 / 重试」仍只在到期条件满足时续签。

CA **不会自动换根**：快到期时显示提示，剩余不足一天时停止签发。根 CA 到期或损坏必须由管理员恢复备份或安排新 CA 的信任迁移，不能承诺永久无需信任更新。服务端证书不会超出 CA 的有效期。

平台数据目录必须持久化并安全备份，包含 SQLite、`certificates/private-ca.json`、`certificates/active.json` 及备份证书。目录权限 0700、私钥文件 0600；同一个数据目录只运行一个实例。数据库记录 CA 指纹，CA 文件丢失时不会重新生成另一套密钥。数据目录包含签发能力，应仅由平台服务账号及受信运维人员访问。

模式切换或改域名不会自动下发 CA，需先执行下方同步流程。旧管理入口 / 前一个域名可在原证书有效期内继续使用；只为当前配置的入口续签，迁移应在旧证书到期前完成。停机期间不续签，重启会补检查；关闭自动续签后仍加载最后一份证书。

## 验证

- `npm --prefix apps/server test`：离线签发、DNS/IP 身份、续签保留 CA、激活失败回滚、根 CA 损坏与到期、权限及安装命令的 CA 快照。
- `npm run test:certificates:private`：实际执行生成的安装命令安装 Linux Agent，验证统一入口、完整 TLS 校验、后台定时续签、原终端及录制、Agent 新握手和重启持久化。使用隔离 Docker 容器和临时数据，测试证书缩短至 80 秒，生产配置不接受这个测试选项。
- `npm run test:certificates:private:browser`：真实浏览器操作设置和下载 CA，核对指纹、申请状态及移动端布局；使用已受信任的 `.dev/tls` 初始化入口，或通过 `FLEET_TEST_TLS_DIR` 指定。不会修改系统信任，不会忽略浏览器 TLS 错误；新根 CA 的具体分发和系统信任仍需在部署环境验证。

运行上述集成测试前构建前后端，提供 `.dev/agent-dist/farhelm-agent-linux-aarch64`、`farhelm-agent-build:arm64` Docker 镜像及 Playwright 浏览器。私有模式与公网 ACME 的测试相互独立。

## 已有 Agent：先同步 CA，再切换证书

Agent 0.2.4 起支持 `agent.trust.v1`。旧版先在「Agent 升级」页升级；系统设置会逐台标明旧版、等待上线、校验中、失败和已就绪。SSH 设备不参与此同步。

1. 保存内网域名 / IP 配置，保持自动申请关闭；创建并下载新 CA。管理员浏览器通过可信渠道首次信任该 CA。
2. 点击「同步 CA 到已有 Agent / 重试」。平台沿当前已验证的 WSS 连接下发 CA 公共证书、SHA-256 指纹及待启用域名的签名证书证明。Agent 校验证书链、域名 / IP 和有效期，追加保存并加载信任后回执。CA 私钥不会下发。
3. 全部非吊销 Agent 确认后，才允许启用新 CA 证书。离线设备上线后补同步；离线但已确认持久保存的设备无需等待。旧版、离线未确认或失败的设备会阻止首次切换，不能强制跳过。配置改动后应重新发起同步。
4. 正常续签保持同一 CA，不再等待设备回执。CA 同步不更改平台地址；地址有变时仍按原流程同步地址并验证可达性。

Agent 保留安装时的 CA 和旧信任，将新增 CA 保存到私有状态目录的 `platform-trust.json`（0600，原子替换并同步磁盘），不修改系统信任库、环境文件或现有终端。HTTP 客户端随即更新，重连 WSS、Agent 重启和后续升级均读取已保存 CA。最多额外保留 8 份 CA；保存失败、空间或权限问题会显示失败并保持原连接。文件损坏不会静默丢弃信任。

签名证明验证不替代网络探测，也不替浏览器安装 CA。本功能同步平台当前准备的私有 CA，不提供任意 CA 上传、自动换根或旧根清理。需要保留当前受信入口直到同步完成；旧入口已不可达时无法通过它远程修复信任。

`npm run test:certificates:ca-sync` 使用真实 Linux Agent 验证旧版升级、前端同步、未就绪禁止激活、切换期间 PTY / 录制保持、重新连接以及重启后的信任持久化。

迁移 E2E 需要 0.2.3 基线安装包与清单（`FLEET_AGENT_BASELINE_DIST_DIR`，默认 `.test-output/ca-baseline`），以及新版本安装包（`FLEET_AGENT_DIST_DIR`，默认 `.dev/agent-dist`）。测试不会更改当前平台数据、CA 或系统信任。
