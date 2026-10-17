# 本机开发环境的统一 HTTPS 入口

本页仅说明已有的本机开发转发环境。正式一键安装和 [deploy/compose.yml](../deploy/compose.yml) 直接运行 Farhelm，不需要启动这里的 Nginx 容器。

当前本机使用 `https://host.docker.internal:5173/`。Docker Desktop 的 `farhelm-entry` 只做 TCP 转发到宿主机 Farhelm HTTPS 8443；网页静态文件、API、Agent HTTPS/WSS 都由 Farhelm 提供并使用系统设置中托管的同一张证书。SSH 网关仍为 2222，不使用 HTTPS 证书。

## 启动与维护

前提是 Docker Desktop 已启动，Farhelm 后端已监听本机 8443，且 `FLEET_WEB_DIST` 指向本仓库的 `apps/web/dist`。本机域名仍使用已配置的 hosts 解析。后端数据目录 `.dev/server` 必须保留，其中含平台私有 CA、证书和设备数据。

```sh
# 前端修改后更新静态网页，不需要另起 Vite。
npm --prefix apps/web run build
# 5173 上不能同时运行 Vite。
docker compose -f deploy/dev/compose.entry.yaml up -d
# 查看入口状态。
docker compose -f deploy/dev/compose.entry.yaml ps
```

入口只绑定 `127.0.0.1:5173`，适用于当前 Docker Desktop 本机环境。`restart: unless-stopped` 会随 Docker 恢复；后端仍按现有方式启动。证书仅由后端签发和热加载，Nginx 不保存私钥，续签无需重启入口。

## CA 与切换顺序

浏览器需要首次信任平台私有 CA；macOS 应为当前用户设置标准 SSL 用途的根 CA 信任，不使用按域名限定的 `security -s` 信任记录；Chromium 会跳过这类记录，即使系统 `security verify-cert` 显示成功。标准 SSL 根信任会覆盖该 CA 为其他域名签发的 HTTPS 证书；从域名限定信任改为标准 SSL 根信任前，须得到管理员对该范围的明确授权。CA 公共证书保存在 `.dev/unified-entry/ca.crt`，也可以在系统设置下载。此文件不含私钥。日常服务端续签不改变 CA。

迁移现有环境时，先备份数据库和原配置，在系统设置保存私有模式、创建 CA，先让已有 Agent 全部同步并确认，再启用证书。替换 5173 上的 Vite 之前，可以通过平台地址同步让 Agent 暂时连接已验证的 `https://host.docker.internal:8443`，待新入口正常后再同步回 5173；地址迁移会等待活跃终端结束。最后从 5173 验证登录、终端输入输出、退出和录制。

统一入口故障时可直接访问已使用相同证书的 `https://host.docker.internal:8443/`。应通过平台设置迁移地址，勿删除 Agent 身份或手工覆盖信任文件。需要恢复 Vite 开发模式时，先将 Agent 迁移到有效入口，再停用本转发容器；独立 Vite 使用自己的证书，不会自动跟随平台私有 CA 续签。

Chromium 的 macOS 信任实现明确跳过带 `kSecTrustSettingsPolicyString` 的记录，详见 [官方实现](https://raw.githubusercontent.com/chromium/chromium/main/net/cert/internal/trust_store_mac.cc)。迁移时必须先用正常校验证书的实际浏览器验证后端入口，再停用旧网页入口。
