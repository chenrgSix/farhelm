# 正式环境自动管理 HTTPS 证书

管理员在「系统设置 → HTTPS 证书」配置平台域名、联系邮箱，阅读并勾选 Let’s Encrypt 服务条款，然后启用「自动申请和续签证书」并保存。平台异步申请证书；页面每 5 秒刷新申请状态、签发机构、完整到期时间、下次检查 / 重试时间和失败原因，关闭网页不影响续签。

支持单个公网域名（含 IDN 转换）、Let’s Encrypt 正式环境和 HTTP-01 验证。域名 A / AAAA 记录都应指向平台，公网 **80 端口**必须能访问验证服务，**443 端口**提供 HTTPS。只开放 443、仅内网可解析的域名、IP 地址和通配符暂不支持自动签发。验证要求见 [Let’s Encrypt HTTP-01 文档](https://letsencrypt.org/docs/challenge-types/#http-01-challenge)。请先核对 DNS、防火墙和端口映射，再启用申请；没有可用 IPv6 入口时不要保留 AAAA 记录。

## 入口部署

Farhelm 必须实际终止公网 TLS，才能让签发的新证书立即用于网页和 Agent。推荐非特权 Farhelm 进程监听内部 8443 / 8080，由 Nginx **TCP 转发**发布 443 / 80。示例文件：

- [server.env.example](../deploy/server/server.env.example)：服务配置，域名在网页设置，不写死在环境变量里。
- [farhelm.service](../deploy/server/farhelm.service)：systemd 服务示例，部署方按实际 Node 路径、用户和目录安装。
- [farhelm-acme.conf](../deploy/nginx/farhelm-acme.conf)：包含于 Nginx 顶层的 `stream {}` 配置，需要启用 stream 模块，不能放在 `http {}` 中。

先安装 Node 24+ 与项目依赖，构建 `apps/server`、`apps/web`，把平台数据和安装包置于持久化目录并授予 Farhelm 服务用户读写权限。`FLEET_WEB_DIST` 必须指向构建后的网页目录。systemd 示例假设程序位于 `/opt/farhelm`，数据位于 `/var/lib/farhelm`，环境文件 `/etc/farhelm/server.env` 应限制为部署管理员可读，首次使用时替换示例管理员密码。已有数据库不重复创建初始管理员。

这里 Nginx 不读取证书，也不解密 TLS；签发 / 续签不需要 Nginx reload，HTTPS/WSS 均由 Farhelm 热加载。原 [farhelm.conf](../deploy/nginx/farhelm.conf) 是 Nginx 自行终止 HTTPS 的另一种部署方式，继续由外部签发器管理证书，**不能与自动托管示例同时占用 80 / 443**。在原模式仅更新后端证书不会更新 Nginx 的公网证书；切换架构时需安排一次入口维护。TCP 代理配置依据 [Nginx stream proxy 文档](https://nginx.org/en/docs/stream/ngx_stream_proxy_module.html)。

也可让 Farhelm 直接监听 443，HTTP 验证监听 80；部署方需给服务绑定低端口的权限，并调整监听地址、防火墙及服务限制。不要为了绑定端口把整个平台进程改为 root。

## 第一次配置

首次尚无公网证书时，保留现有受信 HTTPS 管理入口，或者通过 SSH 隧道访问受信的 localhost 初始化证书。`FLEET_TLS_CERT`、`FLEET_TLS_KEY` 是此初始化证书；必须可读，不能关闭 TLS 校验绕过初始化。

新部署可先在服务器上运行 `node scripts/dev-tls.mjs init /var/lib/farhelm/bootstrap-tls`，通过已有可信 SSH 通道取回 `ca.crt` 并核对指纹，在管理电脑信任该受约束的本地 CA，再建立 `ssh -L 8443:127.0.0.1:8443 your-server` 并访问 `https://localhost:8443`。只复制 CA 公共证书，私钥保留服务器，初始化目录交给 Farhelm 服务用户所有。此 CA 只用于初始化管理连接，不签发公网域名证书，也不分发给正式 Agent。公网入口的证书由 Let’s Encrypt 签发。

启用部署参数 `FLEET_ACME_ENABLED=1` 后启动服务，在系统设置填写域名和邮箱，开启自动申请。此开关是一次性的部署能力配置；后续域名和自动申请开关都由网页维护。未启用托管的开发 / 外部入口仍能保存域名草稿，页面明确显示「外部管理」，证书信息指服务端证书，不冒充独立 Nginx / Vite 的公网状态。

申请成功后，用新的 HTTPS 域名访问网页，确认登录和终端连接正常，再在「Agent 接入设置」点击「使用当前网页地址并同步」。证书设置不会提前改写 Agent 地址。初始化 SNI 入口保留；更换已托管域名时，临时保留上一个域名的证书和 SNI 身份（跨重启保留），但只为当前配置域名续签，旧域名证书到期前必须完成迁移。一次只保留一个旧托管域名。

公网 Agent 使用内置公共根证书，部署时不要设置 `FLEET_CA_CERT` / `FLEET_AGENT_CA_CERT` 为初始化或私有 CA；自动托管模式会拒绝这种冲突配置。已经安装并固定信任私有 CA 的 Agent 不会自动扩大信任范围，迁移到公网证书前需更新其信任配置；现有地址同步校验失败会保留原地址。正常公网证书续签保持相同域名，Agent 无需改配置。

## 续签和故障处理

后台每分钟检查，到证书有效期的最后三分之一（最长提前 30 天）续签，兼容证书机构缩短证书期限。有效期按签发结果显示，不写死为 90 天。按钮「立即检查 / 重试」不会对仍未到续签时间的证书重复申请。

申请任务隔离执行，单次最多 5 分钟；HTTP-01 仅在验证期间响应当前域名的随机验证 token，其他 HTTP 请求返回 404，不通过明文提供管理 API。成功后检查域名、私钥、证书链和有效期，以权限 0600 原子保存到数据目录的 `certificates/active.json`，热更新 TLS 上下文；旧 HTTPS/WSS 连接保持，新握手使用新证书。`previous.json` 保留上一份证书，账户私钥 `account.key` 持久保存，目录权限 0700。不要将这些文件提交到版本库或公开下载。

失败保留现用证书，按 1 / 2 / 4 / 8 / 16 / 24 小时退避重试，遵守证书机构的 Retry-After；人工重试至少间隔 5 分钟，改配置或重启不能绕过机构冷却时间。失败原因和下次重试时间会显示在页面并写入审计。关闭自动申请可取消进行中的任务，并继续使用当前证书，但此后不会自动续签。冲突配置要求重新加载；只有管理员可读写此设置，任何 API 都不返回私钥。

数据目录需持久化并按敏感数据备份，单个数据目录只运行一个 Farhelm 实例；多副本共享证书的部署暂不支持。停机期间不续签，恢复后检查并补申请；已有证书即使过期也不会阻止 HTTP-01 恢复，但恢复前新 HTTPS 连接会被客户端拒绝。端口长期不可达或 CA 长期失败时，原证书仍可能到期，应关注页面失败状态。

## 本地验证

`npm run test:acme` 使用隔离的 [Pebble 测试 CA](https://github.com/letsencrypt/pebble) 和 Docker Linux Agent：执行真实 HTTP-01 验证，签发短期测试证书，等待后台自动续签，检查 TLS 指纹、已有 PTY 和录制、Agent 新连接及服务重启后的证书恢复。需要 `ghcr.io/letsencrypt/pebble:2.8.0`、`farhelm-agent-build:arm64`、`.dev/agent-dist/farhelm-agent-linux-aarch64` 和已构建的服务端 / 网页。测试显式信任测试 CA，保留 TLS 校验，不向 Let’s Encrypt 正式环境发送申请。

本地测试不能代替正式域名 DNS、公网端口及正式 CA 签发验收；首次正式申请应在实际部署后从设置页面执行。

依赖审计说明：当前固定的 `acme-client@5.4.0` 间接安装 `node-forge`，npm 官方审计对它的旧 RSA 签名验证实现报告 [GHSA-86w9-cpqp-85rv](https://github.com/advisories/GHSA-86w9-cpqp-85rv)（连带上层依赖共 2 个 high 条目）。本实现只加载客户端的原生 crypto 子模块，不加载或调用 legacy forge 模块；证书链及密钥检查使用 Node/OpenSSL。上游尚未提供该依赖的修复版本，审计告警仍保留，不使用降级或隐藏告警处理。
