# API 参考

基址为平台网页管理入口加 `/api/v1`。请求头 `Authorization: Bearer <API Token>`，写请求为 JSON，含 `v: 1`。Python 脚本自动设置公共头。完整 JSON Schema 可通过 `request GET /openapi.json` 获取。

| 操作                          | 方法与路径                                                                        | 权限               |
| ----------------------------- | --------------------------------------------------------------------------------- | ------------------ |
| 身份 / 有效权限               | `GET /me`                                                                         | 有效令牌           |
| 设备列表                      | `GET /devices`                                                                    | `devices.read`     |
| 健康检查 / 网络 / 通道 / 探测 | `GET /devices/:id/health-checks`、`/network`、`/network-route`、`/network-probes` | `devices.read`     |
| 配置健康检查                  | `PUT /devices/:id/health-checks`                                                  | `health.manage`    |
| 发起健康检查                  | `POST /devices/:id/health-checks/run`                                             | `health.manage`    |
| 配置网络探测                  | `PUT /devices/:id/network-probes`                                                 | `network.manage`   |
| 提交 Agent 任务               | `POST /commands`                                                                  | `tasks.execute`    |
| 任务列表 / 详情 / 输出        | `GET /tasks`、`/tasks/:id`、`/tasks/:id/output/stdout` 或 `stderr`                | `tasks.read`       |
| 取消本人任务                  | `POST /tasks/:id/cancel`                                                          | `tasks.execute`    |
| 审计                          | `GET /audit`                                                                      | `audit.read`       |
| 创建 / 结束本人终端           | `POST /terminal-sessions`、`/terminal-sessions/:id/close`                         | `terminal.connect` |
| 会话列表 / 录制               | `GET /terminal-sessions`、`/terminal-sessions/:id/recording`                      | `recordings.read`  |
| 登记录制导出                  | `POST /terminal-sessions/:id/export`                                              | `recordings.read`  |

`tasks.read_all`、`recordings.read_all`、`audit.read_all` 分别允许查看授权设备上他人的记录，需同时具备对应 `.read` 权限。它们不允许取消他人的任务、结束他人的终端。限定设备的令牌看不到范围外设备或无设备归属的平台审计。

分页列表可带 `limit=1..100`、`cursor`、`q`、`device_id`、`actor_id`、`from`、`to`（毫秒时间戳）。任务/会话可用 `status`，审计可用 `action`。响应 `page.has_more` 和 `page.next_cursor` 表示是否继续；翻页保持其余条件不变。设备列表一次返回全部授权设备。

健康检查修改先 GET 读取 `revision`，PUT 提交 `{v:1, revision, checks:[...]}`；运行检查提交 `{v:1, revision}`。网络探测修改也需先读取配置版本，按 OpenAPI 请求定义提交。409 表示重新读取后评估，不要自动覆盖别人的修改。

命令必须指定绝对 `cwd`；`argv` 是独立参数数组，不会自动解释管道或重定向。需 shell 语义时，在用户授权内显式传 `/bin/sh`, `-lc`, `命令`。必填 `timeout_ms`（100..3600000）、`max_output_bytes`（0..1048576）、`ttl_seconds`（1..86400），脚本提供默认值。每个逻辑操作使用一个 `Idempotency-Key`；同键同参数返回原任务，同键不同参数返回 409。

任务详情为顶层 `status` 和 `result`，成功状态为 `SUCCEEDED`；输出接口返回原始字节。`wait` 只做有时限的查询，超时返回最后观察到的状态，不会取消或重跑任务。

终端创建体 `{v:1,device_id,cols:80,rows:24}` 返回 `session_id`、一次性 `ticket` 和票据到期时间。使用同源 `Origin` 连接 `/api/v1/terminal/ws`，发送 `{v:1,type:"terminal.attach",body:{session_id,ticket}}`，随后遵循 OpenAPI 文档中的 `terminal-envelope` 协议。不要在 URL 放 Token 或票据。平台自动选择 Agent/SSH 后端并录制，票据兑换、输入和周期检查会重新验证权限。

录制分页参数 `after` 是上次返回的 `next` 序号，每页最多 128 条。开放会话可继续轮询；会话结束且没有新事件后完成读取。输出事件数据为 Base64。`POST .../export` 登记导出审计，不返回文件；内容仍由 recording 接口分页读取。不要把终端输入密码写进本地日志。

错误统一为 `{v:1,error:"CODE"}`：401 凭据过期、撤销或账号不可用；403 权限/设备范围不足或接口不对 Token 开放；409 配置冲突或设备不可执行；429 限流；503/507 为存储或服务暂不可用。未知写操作结果先核实，避免重复执行。
