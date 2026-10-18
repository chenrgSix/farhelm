# 部署入口

Farhelm 自身提供网页、API、HTTPS 和 Agent 接入，网页管理默认 8443，可选 HTTP/HTTPS；Agent 使用独立 HTTPS 端口（默认 8444），SSH 网关使用 2222。正式部署不需要 Nginx。

## Docker Compose

在此目录执行：

```bash
cp compose.env.example .env
# 编辑 .env，将 FARHELM_PUBLIC_HOST 改为服务器的域名或 IP
docker compose up -d --build --wait
```

首次启动要使用 HTTP 网页 + HTTPS Agent，在 `.env` 设置 `FLEET_WEB_PROTOCOL=http` 并保留 `FLEET_DEVICE_ACCESS=agent-ssh`；网页访问 `http://你的服务器IP:8443`，Agent 使用 `https://你的服务器IP:8444`。已有环境从「系统设置 → 平台运行方式」切换并确认，不靠环境变量覆盖保存的配置。旧 Agent 先迁移独立地址，详见[升级迁移步骤](../docs/server-deployment.md#已有部署迁移)。

- `compose.yml`：正式部署，仅启动 Farhelm 服务，包含前端、自启策略和持久化数据卷。
- `compose.env.example`：环境模板，实际配置保存在本目录的 `.env`。
- `compose.acme.yml`：可选的 HTTP-01 端口映射；启用时运行 `docker compose -f compose.yml -f compose.acme.yml up -d --build --wait`。
- `server/`：Dockerfile、共享初始化脚本，以及手动 systemd 部署参考。
- `agent/`：Agent 安装包构建工具。
- `dev/`：已有本机开发环境的配置，不参与正式部署。
- `examples/nginx/`：已有外部代理时的可选示例，不参与默认安装。

Compose 从仓库根目录构建源码；项目名固定为 `farhelm`，默认数据卷仍是 `farhelm_farhelm-data`。从旧目录布局迁移时，将原根目录 `.env` 移至这里，并沿用原 `-p` 项目名（如有），无需迁移数据卷。不要使用 `down -v` 更新服务。

## Linux 一键安装

在仓库根目录执行：

```bash
sudo bash install.sh --source . --host 你的服务器IP
```

远程一条命令安装、初始密码、CA 信任、HTTP 模式和维护步骤见[完整部署说明](../docs/server-deployment.md)。
