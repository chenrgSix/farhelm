# 网页与 Agent 共用平台入口

「系统设置 → 平台访问地址」填写的是目标服务器可访问的 **HTTPS 平台入口**，可以直接使用浏览器中的网页地址。它既可以是同时提供网页和 API 的 Farhelm 服务，也可以是转发到 Farhelm 的前端 Web 服务。用户无需填写后端内部地址或端口。

例如网页位于 `https://fleet.example.com/devices?group=prod`，粘贴后会提示并保存 `https://fleet.example.com`。HTTPS 页面也可点击「使用当前网页地址并同步」，一键保存当前网页的域名和端口，并自动发起 Agent 地址同步，无需再次点击「保存设置」。地址不变时重试未完成的同步；正在校验、已保存和已切换的 Agent 不会重复迁移。保存成功仅表示配置已持久化，实际同步结果请查看下方逐设备状态；保存冲突或结果不确定时须先重新加载配置。设备安装表单自动带入该值。后台接口的字段名仍为 `platform_server_url`，继续接受规范化的 HTTPS origin，原有配置兼容。

这里的转发由前端 **Web 服务** 完成，不依赖某个用户打开浏览器。浏览器关闭后 Agent 仍保持连接。前端入口需同时提供网页、API 和 Agent WebSocket；单纯把 Vue 静态文件上传到不支持 API 转发的网站不能作为 Agent 入口。当前支持从域名根路径部署，子目录中的页面链接只用于提取域名和端口。

## 同一个 Farhelm 服务提供网页

构建网页后设置 `FLEET_WEB_DIST=/absolute/path/apps/web/dist`。Farhelm 会在同一个 HTTPS 地址提供网页、API、安装包和 WebSocket。此时浏览器访问的 HTTPS 地址本身就是平台入口，不需要额外代理；监听地址、证书及端口须允许目标服务器访问。

## 独立前端 Web 服务

仓库提供 [Nginx 配置](../deploy/nginx/farhelm.conf)，放入 Nginx 的 `http {}` 配置范围。修改域名、证书、静态目录及后端连接地址：

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

macOS 浏览器需要显式信任开发证书。为兼容 Chromium，可在当前用户钥匙串中仅将当前服务端证书设为 SSL 信任：

```sh
security add-trusted-cert -r trustAsRoot -p ssl \
  -k "$HOME/Library/Keychains/login.keychain-db" .dev/tls/server.crt
```

这只信任当前非 CA 服务器证书，仍校验有效期和证书覆盖的主机名；换证后需重新添加信任。不要使用 `-s host.docker.internal` 设置按域名限定的 CA 信任来替代：Chromium 会忽略这种信任条目，见 [Chromium 的 macOS 信任处理](https://chromium.googlesource.com/chromium/src/+/main/net/cert/internal/trust_store_mac.cc)。Agent 继续使用原有 CA 验证服务端。

如果启用了系统代理，在当前网络的代理例外中追加 `host.docker.internal`，保留已有代理和例外。否则浏览器可能把该本地域名交给外部代理，表现为连接被关闭；代理软件重新设置系统配置后也需核对该例外。命令行测试可对单次请求使用 `curl --noproxy host.docker.internal --cacert .dev/tls/ca.crt https://host.docker.internal:5173/healthz`。

hosts 和钥匙串修改可能要求系统授权；开发启动脚本不会自动执行这些操作。开发证书仅有效 7 天，过期后需续签并更新相应信任配置。真正远程的机器需要可达域名或 IP，不能照抄开发回环地址。

## 验证

先构建前后端，准备 `.dev/agent-dist` 中的真实 Linux 安装包、Playwright Chromium、`farhelm-sshd-test:local` 测试镜像及 `nginx:stable-alpine`，运行 `npm run test:platform-entry`。

测试分别启动临时 HTTPS Vite 和 Nginx 入口，使用显式 CA 校验 HTTPS 请求，读取网页并验证 API / Agent 路由；真实 Linux Agent 的安装包下载、注册、上线及 PTY 均经过前端入口。HTTPS 客户端也通过相同入口创建终端、进行 WebSocket Origin 校验并读取录制，分别覆盖 Agent 和 SSH 通道。浏览器表单交互使用独立的本机 HTTP 开发监听器验证粘贴链接、保存及安装流程；不会通过忽略证书错误来冒充浏览器 HTTPS 信任验收。
