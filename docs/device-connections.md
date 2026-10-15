# SSH 与 Agent 接入

管理员在设备页选择「添加 SSH 设备」或「注册 Agent」。已有 Agent 设备保持原有身份与历史；本版不把同一设备 ID 在两种方式间转换。两种设备共用网页终端、平台 SSH 入口、设备范围授权、会话额度、录制、时长、回放和导出。

```text
浏览器 / SSH 客户端 → 平台（认证、授权、录制） → WSS → Agent PTY
                                           → SSH → 目标 sshd / Shell
```

## 配置 SSH 设备

1. 点击「添加 SSH 设备」，填写名称、目标地址、端口、Linux 账号和私钥。平台服务端必须能访问该地址；`localhost` 指平台所在机器。
2. 目标账号的 `authorized_keys` 中配置对应公钥。粘贴 OpenSSH/PEM 私钥；加密私钥同时填写口令。目标端目前使用公钥认证，未开放目标密码认证、ssh-agent 转发或跳板链。
3. 点击「获取主机指纹」，与目标机器管理员提供的指纹核对后勾选确认；也可直接填写已知 SHA256 指纹。获取只读取主机公钥，在认证前断开，不提交登录凭据。扫描结果本身不证明主机可信，仍需核对。
4. 保存后点击「测试已保存连接」，验证网络、主机指纹和密钥认证；测试不创建 Shell、不执行命令。关闭面板后点击「连接终端」。

目标无需安装 Agent。SSH 客户端仍使用平台账号密码，例如 `ssh -tt -p 2222 -l admin 127.0.0.1`；菜单显示「SSH · 按需连接」。也支持 `平台用户名:设备ID` 直接连接。目标地址与私钥由平台使用，无需分发给操作人。

Agent 在线只代表 WSS 连接；SSH 不维持常驻连接，显示按需连接及上次检查/连接结果，不把历史成功当作实时在线。SSH 设备本版支持交互终端；持久化命令任务及 HTTP/TCP/systemd 健康检查仍要求 Agent，前端隐藏对应入口，服务端明确拒绝。

修改接入配置前需结束设备的活跃终端；revision 防止覆盖他人的修改。私钥留空保留原值；替换私钥时清除旧口令，必要时重新填写。主机指纹不一致会在认证前拒绝连接，不会自动接受新指纹。

## Agent 可选 sudo 密码

Agent 设备的「接入配置」可设置、替换或明确清除 sudo 密码。留空保留原值；没有配置也不影响 Agent 连接和普通终端。

目前仅管理员可配置，任何角色（包括管理员）都不能通过 API 读回明文。本版仅加密保管，不向 Agent 下发、不注入终端、不自动执行 sudo，也不改 Linux sudoers。后续可分别增加“使用密码”和“查看密码”授权；当前没有向其他用户授予这两项能力。原有 Shell 内手动 sudo 仍遵循目标系统权限。

## 凭据与录制

- 私钥、私钥口令和 sudo 密码使用 AES-256-GCM 保存，每次随机 nonce，以设备 ID 绑定 AAD。配置响应只有 `has_*` 标志，设备列表和审计不包含明文。
- 数据目录的 `credentials.key` 是独立 32 字节密钥，权限 0600。备份恢复须保留原密钥，建议与数据库备份分开保护。已有凭据时缺少密钥会阻止启动，不自动生成替代密钥。此加密不抵御平台主机与密钥一并失陷。
- 设备终端授权允许平台代用已保存的 SSH 私钥建立连接，不等于可查看私钥；配置权限与终端使用权限分开检查。
- 录制只保存 PTY 输出，不保存原始按键；终端回显仍会录制。SSH 输出与 Agent 共用 SQLite 提交后再转发的流程，录制失败会断开。上游入口 `transport` 与下游接入 `backend` 分别保存，历史会话默认 `backend=agent`。
- 目标 SSH 的 exit 通知表示 Shell 正常结束，异常网络断线标为中断。主动结束会话关闭 SSH 连接；不保证已脱离终端的后台进程全部退出。

## 本地验证

服务端测试使用真实 SSH 协议测试端验证凭据、指纹、权限、录制与原有 Agent 路径。真实 Linux 验证使用独立 OpenSSH 容器，不修改现有 Agent 容器：

```bash
docker build -t farhelm-sshd-test:local tests/e2e/ssh-target
npm --prefix apps/server run build
npm --prefix apps/web run build
npm run test:ssh:target
```

脚本使用临时凭据、数据库及仅绑定宿主 loopback 的 sshd，验证浏览器配置、桌面/手机布局、真实 Linux PTY、Ctrl-C、resize、中文、隐藏输入、录制回放和系统 OpenSSH 经平台菜单连接，结束后移除测试容器。Chromium 可用 `PLAYWRIGHT_BROWSERS_PATH` 或 `FLEET_CHROMIUM_BIN` 指定。结果位于 `.test-output/dual-access-*`，不等于 CI 或生产验收。
