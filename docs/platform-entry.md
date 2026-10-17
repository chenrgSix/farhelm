# 网页与 Agent 共用平台入口

新部署使用[一键安装或 Docker Compose](server-deployment.md)，Farhelm 直接提供网页、API 和 HTTPS，无需独立前端代理。本文保留已有外部代理和本地开发入口的配置说明。

「系统设置 → 平台访问地址」填写的是目标服务器可访问的 **HTTPS 平台入口**，可以直接使用浏览器中的网页地址。它既可以是同时提供网页和 API 的 Farhelm 服务，也可以是转发到 Farhelm 的前端 Web 服务。用户无需填写后端内部地址或端口。

例如网页位于 `https://fleet.example.com/devices?group=prod`，粘贴后会提示并保存 `https://fleet.example.com`。HTTPS 页面也可点击「使用当前网页地址并同步」，一键保存当前网页的域名和端口，并自动发起 Agent 地址同步，无需再次点击「保存设置」。地址不变时重试未完成的同步；正在校验、已保存和已切换的 Agent 不会重复迁移。保存成功仅表示配置已持久化，实际同步结果请查看下方逐设备状态；保存冲突或结果不确定时须先重新加载配置。设备安装表单自动带入该值。后台接口的字段名仍为 `platform_server_url`，继续接受规范化的 HTTPS origin，原有配置兼容。

这里的转发由前端 **Web 服务** 完成，不依赖某个用户打开浏览器。浏览器关闭后 Agent 仍保持连接。前端入口需同时提供网页、API 和 Agent WebSocket；单纯把 Vue 静态文件上传到不支持 API 转发的网站不能作为 Agent 入口。当前支持从域名根路径部署，子目录中的页面链接只用于提取域名和端口。

## 同一个 Farhelm 服务提供网页

构建网页后设置 `FLEET_WEB_DIST=/absolute/path/apps/web/dist`。Farhelm 会在同一个 HTTPS 地址提供网页、API、安装包和 WebSocket。此时浏览器访问的 HTTPS 地址本身就是平台入口，不需要额外代理；监听地址、证书及端口须允许目标服务器访问。

## 独立前端 Web 服务

已有 Nginx 部署可使用 [可选配置](../deploy/examples/nginx/farhelm.conf)，放入 Nginx 的 `http {}` 配置范围。修改域名、证书、静态目录及后端连接地址：

- `server_name`：前端的对外域名；`ssl_certificate` / `ssl_certificate_key`：覆盖该域名的证书链和密钥。
- `root`：构建后的 `apps/web/dist`。
- `proxy_pass`：后端内部 HTTPS 地址，示例为同机 `https://127.0.0.1:8443`。独立主机部署时同时限制后端的可访问网络。
- `proxy_ssl_name`：后端证书覆盖的主机名；`proxy_ssl_trusted_certificate`：签发后端证书的受信 CA。代理到后端始终校验证书，不设置 `proxy_ssl_verify off`。

配置同时转发 `/api/`、`/agent/` 和 `/healthz`，涵盖安装下载、注册认证、文件上传、升级下载、网页终端、Agent 控制及地址同步探测。保留请求路径和外部 Host，显式传递 WebSocket Upgrade / Connection 头，关闭缓存和代理重试，支持长连接。WebSocket 配置依据 [Nginx 官方说明](https://nginx.org/en/docs/http/websocket.html)，上游 TLS 验证见 [代理模块文档](https://nginx.org/en/docs/http/ngx_http_proxy_module.html#proxy_ssl_verify)。

安装命令中的 CA 必须信任 **前端入口** 的证书：前端使用公共受信证书时可省略 `FLEET_AGENT_CA_CERT`；使用私有 CA 时设置为前端 CA 或包含所需 CA 的证书包。它与 Nginx 验证后端所用的 CA 可以不同。已安装 Agent 使用私有 CA 时不会自动改为信任另一个 CA；迁移入口时保留兼容证书链或先更新目标的受信 CA。现有地址同步仍会校验平台身份和新连接，失败保留旧入口。

外部只需发布前端 HTTPS 入口，平台账号、设备范围、会话录制仍由后端执行。平台的 SSH 客户端入口属于独立 TCP 服务，继续使用其配置的 SSH 端口。

## 本地开发

`npm run dev` 现在默认启动 HTTPS 前端；已有服务端和开发证书时，可单独运行 `npm run dev:web`。默认入口为 `https://localhost:5173`，监听 `127.0.0.1`，使用 `.dev/tls/server.crt`、`server.key` 和 `ca.crt`。可通过 `FLEET_DEV_WEB_PORT` 修改端口；端口被占用时直接失败，不会静默换端口。也可显式指定证书和上游：

```sh
NODE_EXTRA_CA_CERTS=/absolute/path/.dev/tls/ca.crt \
FLEET_DEV_API_TARGET=https://localhost:8443 \
FLEET_DEV_WEB_TLS_CERT=/absolute/path/.dev/tls/server.crt \
FLEET_DEV_WEB_TLS_KEY=/absolute/path/.dev/tls/server.key \
npm run dev:web
```

Vite 会提供 HTTPS 网页并转发 API、Agent WebSocket 和健康接口；必须同时设置前端证书与密钥。代理保留外部 Host 以便网页终端校验 Origin，上游 TLS 名称固定为 `FLEET_DEV_API_TARGET` 中的主机名。证书必须显式受信，不自动修改系统信任或跳过验证。

`127.0.0.1` / `localhost` 只指访问者自身。Docker Desktop / OrbStack 中的目标 Agent 可用证书覆盖的 `https://host.docker.internal:5173` 访问本机 HTTPS 前端。宿主机浏览器也应打开这一地址，才可直接使用「使用当前网页地址并同步」。如果宿主机不能解析该名称，可在宿主机 `/etc/hosts` 添加 `127.0.0.1 host.docker.internal`；容器仍使用 Docker 自带的宿主机解析，不修改容器 hosts。

macOS 浏览器需要一次性信任稳定的开发根证书，用于后续自动续签：

```sh
security add-trusted-cert -r trustRoot -p ssl \
  -k "$HOME/Library/Keychains/login.keychain-db" .dev/tls/ca.crt
```

新生成的根证书在 X.509 `nameConstraints` 中限制 `localhost`、`host.docker.internal`、`127.0.0.1` 和 `::1`，不能用于外部域名。不要只信任 `server.crt`，否则换证后浏览器需重新确认；也不要使用 `-s host.docker.internal` 设置系统层面的按域名信任限制，Chromium 会忽略这种信任条目，见 [Chromium 的 macOS 信任处理](https://chromium.googlesource.com/chromium/src/+/main/net/cert/internal/trust_store_mac.cc)。Agent 使用同一稳定 CA 验证续签后的服务端证书。

如果启用了系统代理，在当前网络的代理例外中追加 `host.docker.internal`，保留已有代理和例外。否则浏览器可能把该本地域名交给外部代理，表现为连接被关闭；代理软件重新设置系统配置后也需核对该例外。命令行测试可对单次请求使用 `curl --noproxy host.docker.internal --cacert .dev/tls/ca.crt https://host.docker.internal:5173/healthz`。

hosts 和钥匙串修改可能要求系统授权；开发启动脚本不会自动执行这些操作。服务端证书由下方续签流程维护；自定义外部证书由部署方管理；Farhelm 托管的公网证书见 [正式证书自动管理](production-certificates.md)。真正远程的机器需要可达域名或 IP，不能照抄开发回环地址。

## 自动续签与热加载

新建开发环境的根证书有效期为 10 年，服务器证书为 90 天。`npm run dev:web` 在启动时和每小时检查项目管理的证书，剩余有效期不超过 30 天时，使用原 CA 和服务器私钥签发新证书。`npm run dev` 在启动后端前也检查一次，以处理关机或休眠期间证书过期的情况；无需打开浏览器或依赖 Codex 定时任务。

签发前核对 `managed.json` 中的 CA 指纹和私钥，签发后检查证书链、主机名、有效期与密钥匹配，最后原子替换服务器证书，并保留 `server.previous.crt`。并发检查使用进程锁，已退出的签发进程遗留锁可恢复。签发失败保留原证书并记录错误，下一轮检查重试；更换了 CA 或 CA 剩余寿命不足 90 天时拒绝自动签发，要求显式迁移信任。

前后端每 5 秒检查证书文件，调用 TLS `setSecureContext` 热加载有效证书；已有 HTTPS/WSS/终端连接继续使用原连接，新的握手使用新证书。无效或不匹配的证书文件不会覆盖当前 TLS 上下文，修复文件后会继续加载。行为依据 [Node.js TLS 热加载接口](https://nodejs.org/docs/latest-v24.x/api/tls.html#serversetsecurecontextoptions)。后端支持文件路径证书的热加载，直接传入 PEM/Buffer 的测试或嵌入式配置不监听文件。

自动签发仅处理 `server.crt`、`server.key` 和同目录 `managed.json` 标记的开发证书；不改写自定义生产证书。设置 `FLEET_DEV_TLS_AUTO_RENEW=0` 可关闭自动签发，热加载仍可供外部签发程序使用。正式域名可使用独立的 [ACME 自动证书管理](production-certificates.md)，在系统设置配置域名、查看状态及有效期；开发 CA 不参与公网证书签发。

手动检查或验证一次换证：

```sh
npm run dev:tls:renew
# 显式强制签发一次，服务无需重启：
npm run dev:tls:renew -- .dev/tls --force
npm run test:tls
```

### 从旧 7 天证书迁移

先准备长期根证书，保留旧 CA 的公钥和主体；当前证书和连接此时不变。macOS 中先信任候选根证书，再激活：

```sh
node scripts/dev-tls.mjs prepare-migration .dev/tls
security add-trusted-cert -r trustRoot -p ssl \
  -k "$HOME/Library/Keychains/login.keychain-db" .dev/tls/ca-next.crt
node scripts/dev-tls.mjs activate-migration .dev/tls
```

激活前在 `tls/backups/` 保存旧证书。CA 文件保留 inode，兼容当前 Docker 的只读文件挂载；设备身份、设备 ID 和业务数据不变。首次启用此版本需要在终端空闲时更新运行中的前后端，并让 Agent 重新读取长期 CA；以后续签无需重启服务、容器或重新信任。已有安装命令内的 CA 是生成时快照，迁移后新安装请重新生成命令。

证书自动续签依赖运行中的 HTTPS 前端；服务停机期间不会签发，恢复启动时补检查。根证书本身的到期或丢失需要一次新的信任迁移，不会静默生成另一套密钥。

## 验证

先构建前后端，准备 `.dev/agent-dist` 中的真实 Linux 安装包、Playwright Chromium、`farhelm-sshd-test:local` 测试镜像及 `nginx:stable-alpine`，运行 `npm run test:platform-entry`。

测试分别启动临时 HTTPS Vite 和 Nginx 入口，使用显式 CA 校验 HTTPS 请求，读取网页并验证 API / Agent 路由；真实 Linux Agent 的安装包下载、注册、上线及 PTY 均经过前端入口。HTTPS 客户端也通过相同入口创建终端、进行 WebSocket Origin 校验并读取录制，分别覆盖 Agent 和 SSH 通道。浏览器表单交互使用独立的本机 HTTP 开发监听器验证粘贴链接、保存及安装流程；不会通过忽略证书错误来冒充浏览器 HTTPS 信任验收。

本机有运行中的真实 Linux Agent、已受信的 HTTPS 页面和管理员凭据时，可验证“打开终端期间换证”：

```sh
FLEET_TEST_RENEW_TLS=1 FLEET_CREDENTIALS_FILE=.dev/admin-credentials.json \
  npm run test:tls:browser
```

该测试会显式续签当前开发证书，确认前后端均呈现新证书、原终端继续输出且录制完整，再启动全新浏览器进程验证登录和新的 Agent 终端。测试始终保留 TLS 校验。

纯内网私有化部署使用 [平台私有 CA](private-certificates.md)，由服务端同时提供网页、API 和 Agent 接入。首次信任根 CA 后，服务端自动续签并热加载，新 Agent 安装自动携带 CA，无需公网验证。
