# 前端列表与历史查询

设备、任务、审计及终端会话各自保存刷新状态、最后成功的数据和更新时间。设备页仅刷新设备及最近任务概况；历史页刷新当前历史查询和用于设备名称的设备清单。任务或审计列表失败不会使正常的设备连接失效，失败列表保留旧数据并明确提示。后台标签页暂停主列表轮询；会话失效仍统一退出并清理内存数据。

设备行保留「连接终端」和「更多」，菜单内保留原有接入配置、安装、网络、健康、SSH、命令任务及撤销操作，权限与禁用条件继续生效。手机清单使用卡片，保留勾选及批量标签操作。

## 历史查询

任务中心、操作审计和终端会话每页读取 50 条，提供下一页、上一页和返回首页。筛选在服务端执行，可查到原先最近 500 条任务/会话、1000 条审计之外的记录。切换页面保留各页的筛选条件；修改条件会返回首页。自动刷新保留当前游标，失败重试不会跳页。时间输入使用浏览器当前时区，转换为毫秒时间戳，包含起止时刻。

列表 API：`GET /api/v1/tasks`、`GET /api/v1/audit`、`GET /api/v1/terminal-sessions`。

| 参数 | 含义 |
| --- | --- |
| `limit` | 显式分页大小，1–100；前端使用 50 |
| `cursor` | 上一页返回的 `page.next_cursor`，作为不透明字符串原样传回 |
| `q` | 关键词，最多 256 字符，按字面子串匹配；支持 ID、设备名称、操作人账号/ID、命令内容或审计事件/关联任务 |
| `device_id` | 设备 ID，精确匹配 |
| `actor_id` | 操作人账号或用户 ID，精确匹配 |
| `status` | 任务状态或终端会话状态；审计不支持 |
| `action` | 审计事件类型，精确匹配；任务和会话不支持 |
| `from`、`to` | 毫秒时间戳，按任务/会话创建时间或审计时间筛选 |

响应保留原有 `v` 和列表字段，新增 `page: { limit, has_more, next_cursor }`。不传 `limit` 时继续使用原有默认大小：任务和会话 500、审计 1000，保持已有调用兼容。任务与会话按创建时间及 ID 倒序，审计按 ID 倒序；游标绑定账号、设备范围及查询条件。每次查询都先应用权限和设备范围，再筛选及分页。终端会话也先按设备范围筛选，避免范围外的新会话挤掉可见历史。

修改条件、账号或设备范围后不可复用旧游标；失效时返回 `INVALID_HISTORY_CURSOR`，应回到首页查询。游标用于定位分页，不授予访问权限。关键词查询使用绑定参数并转义通配符，`%`、`_` 按字面匹配。

## 验证

Node.js 24+ 下运行：

```sh
npm --prefix apps/server run typecheck
npm --prefix apps/server test
npm --prefix apps/web run typecheck
npm --prefix apps/web test
npm --prefix tests/contracts test
npm run format:check
npm run test:frontend
```

`test:frontend` 先构建前端，再通过 Playwright 使用独立浏览器资料、临时数据库和真实 Fastify API handler 检查桌面/手机布局、菜单键盘操作、局部刷新失败、历史查询及前后翻页。仅测试服务通过 loopback HTTP 提供页面，不读取现有开发数据、不联系真实 Agent、不执行设备命令；不等同于 TLS、终端通道或生产验收。浏览器使用 Playwright Chromium，或通过 `FLEET_CHROMIUM_BIN` 指定本机 Chromium 系浏览器。截图保存在 `.test-output/frontend-optimization/`。
