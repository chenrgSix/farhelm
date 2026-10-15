# 恢复、证据和备份

## Agent断线

不重发新的 task_id。Agent保留当前执行，重连后顺序补传 accepted/started/finished；输出先上传，完成事件后上传。服务端 EVENT_GAP不ACK，Agent继续重传最早未确认事件，不允许状态回退。未收到结果只是等待，不因单纯失联自动写 UNKNOWN。

## Agent崩溃

保留 identity.key、journal.sqlite3 及 WAL、artifacts 目录。重启前不要删除或重置任何文件。ACCEPTED可按TTL继续，RUNNING保守变UNKNOWN，不自动执行第二遍。保留原输出和进程证据，残留PID必须核对starttime不能盲杀复用PID。同账号模式不能保证主动逃逸后代，人工核对副作用后才另建新任务。

## 输出与服务端故障

先查存储剩余量、权限及日志；服务端仅对已落盘文件和已提交事件ACK。缺失/损坏已索引对象会导致启动对账拒绝，避免把丢失输出当完整审计。不要用删除索引或改任务状态掩盖故障。孤儿对象可暂留；本MVP不自动GC未确认数据。

## 一致备份（本版本停服方案）

本地开发停止服务后运行：

```bash
python3 scripts/backup.py .dev/server /path/to/new-backup --server-stopped
```

脚本使用SQLite backup API，不复制活跃WAL文件，然后复制objects、已存在的 `credentials.key`（设备凭据加密密钥）和 `ssh_host_ed25519_key`（SSH 入口身份），并写SHA-256清单；数据库及私钥文件权限为0600。已有设备凭据但缺少加密密钥时拒绝备份。备份包含解密能力，必须受控保存，若另存加密密钥也应确保恢复时配回原密钥。--server-stopped是操作员确认，脚本不能验证所有外部写入者；本版本不宣称在线文件/数据库快照原子性。生产停服属于须另行获准的操作。

恢复到全新目录，核对manifest每个文件，使用该目录启动独立服务，确认任务、事件、输出SHA和审计可读取。恢复后server_instance保持原值，Agent不会把新服务器冒认成原服务器。不同环境的管理员/会话/设备密钥数据为敏感数据，备份需受控保存，不上传到未知服务。

## 权限与身份

撤销设备关闭现有连接，旧token不能再用。若怀疑单账号命令读到了Agent私钥，应撤销旧设备并经用户批准重新注册，不能仅重启Agent。系统账号与权限由用户配置，本项目没有自动sudo、添加组或重启任何生产服务。
