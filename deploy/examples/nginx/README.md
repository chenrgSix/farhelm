# 可选 Nginx 代理示例

这些文件用于已有 Nginx 的环境，不是一键安装或 Docker Compose 的依赖。新部署按 [deploy/README.md](../../README.md) 由 Farhelm 直接提供网页和 HTTPS。

- `farhelm-acme.conf`：公网 TCP 透传，证书由 Farhelm 统一管理。
- `farhelm-private.conf`：内网 TCP 透传，证书由 Farhelm 私有 CA 管理。
- `farhelm.conf`：已有 Nginx 自行终止 HTTPS 的参考配置，入口证书由外部维护。

前两份配置需要 stream 模块，放在 Nginx 顶层；第三份放在 http 上下文。不要将三份配置同时用于同一端口。现有环境迁移时保留原入口，完成证书信任和 Agent 地址同步后再切换。
