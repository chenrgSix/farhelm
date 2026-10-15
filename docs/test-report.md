# Linux Fleet P0/P1 验证报告

日期：2026-10-14。范围：授权的云端隔离 Linux 开发环境。没有部署用户设备、没有重启生产服务或变更系统账号/权限。

## 验证环境

Linux 6.18.44 x86_64；Node.js 24.19.0；Rust/Cargo 1.99.0；真实 SQLite WAL/FULL；测试自建 CA，TLS 验证始终启用。测试环境不依赖 SSH、EasyTier、MQ 或 Redis。npm/Cargo 锁文件随源码交付。

## 最终结果

- TypeScript 服务端 typecheck：通过
- Vue typecheck 与生产 bundle：通过
- 服务端集成：5/5 通过
- Vue API/model/component：30/30 通过
- JSON Schema/协议/RFC8032/哈希契约：125/125 通过，33 个严格 schema、116 个正反例fixture
- Rust：23/23 通过（21 个单元/真实 Linux 子进程测试 + 2 个跨语言fixture）
- Rust fmt、clippy --all-targets --locked -- -D warnings：通过
- Prettier format:check：通过
- 真实 Rust→HTTPS/WSS→Exec→审计端到端：debug和release二进制分别全量通过21个业务/故障场景（每次Node测试器统计22/22，含外层总测试）
- 一键 dev.sh 启动 smoke：通过，含可信 HTTPS health、真实 Rust WSS、Vue loopback 页面、带认证的 HTTPS代理
- TypeScript/Vue/Rust release构建：通过，优化后Rust二进制约5.5 MiB（源码包不含编译产物）
- 真实 Chromium 浏览器/截图：未验证，见下方限制

完整命令输出见 [聚合验证](test-evidence/check.log)、[debug端到端](test-evidence/e2e.log)、[release端到端](test-evidence/e2e-release.log)、[启动验证](test-evidence/dev-startup.log)。测试日志是具体执行证据，不把计划中的验收项当作已通过。

## 已通过的真实 Rust 端到端场景

1. TLS 未信任 CA 拒绝；未经登录不得读设备
2. Rust 自身错误 CA 拒绝并且没有创建设备
3. Rust 真实注册、WSS心跳；私网/业务状态保持未知
4. stdout/stderr、非零退出码、平台操作人和持久化审计
5. HTTP幂等键 + 三次相同task_id投递，副作用只发生一次；同幂等键改内容409
6. 丢finished ACK、主动断WSS，结果重传不重复执行
7. 命令运行跨短期token续期和原token到期，进程继续且副作用不重跑
8. 非UTF-8/零字节输出及stdout/stderr并行，原始字节完全匹配
9. 单并发，副作用顺序验证
10. 超时普通fork后代停止；不伪称setsid后代强清理
11. 运行中取消，区分请求与真实结果；当前能力边界返回UNKNOWN/incomplete
12. 输出硬限额停止并标audit_complete=false，保留有界前缀
13. 业务、审计、跨设备ops任意Exec均403
14. RUNNING持久化后崩溃，重启UNKNOWN，未spawn命令也不盲目重跑
15. spawn后崩溃，重启UNKNOWN并核对残留进程边界
16. ACCEPTED后、输出封存后、finished事务后故障点：分别恢复执行/UNKNOWN/重放完成，不重复副作用
17. 离线TTL过期不上线补跑
18. Rust注册回复丢失后，原密钥证明持有恢复同一设备，无二次注册
19. 测试客户端攻击：错误Ed25519签名、挑战重放拒绝；按公钥恢复原身份
20. 停服一致备份到新目录，逐文件SHA校验，恢复后任务、审计、输出和Agent身份连接保持
21. 撤销关闭旧连接且拒绝再次认证

主链路全部使用编译后的真实Rust二进制。第19项属于明确标记的协议攻击测试客户端，不冒充Rust执行证据。API返回的关键设备/任务/结果结构同时通过共享JSON Schema校验。

## Rust与服务端额外验证

Rust验证同一身份单实例锁、身份/journal缺失拒绝、不可变任务hash与冲突去重、ACK身份匹配、原子事件顺序、环境清理、no_new_privs、防PID复用盲杀、输出上限和采集文件创建失败时不spawn。setsid逃逸用例实际证明无法保证全部子树清理，结果保持UNKNOWN/incomplete，测试自行核对并清理逃逸进程。

服务端覆盖真实可信HTTPS对象上传与WSS、短token到期、新连接替代旧连接、错误版本/大帧拒绝、乱序事件拒绝且无状态回退、丢ACK后的幂等再确认、输出hash和设备归属、撤销、静态路径穿越/符号链接阻止、未知API不回退到SPA，以及用户创建与bootstrap审计同事务失败回滚。

## 已知未验证与未实现

- Chromium因云命令沙箱不允许所需Unix socket无法启动；可用的放行尝试也在环境初始化失败。未绕过系统/TLS限制，未声称实测浏览器视觉、手机布局或输出截图；保留可重跑浏览器脚本
- Vue 30项测试在jsdom，不等同真实浏览器交互或视觉验收
- 仅本地CA/loopback；真实公网域名、NAT、TLS反代、断WAN、代理和50–500设备重连洪峰未验收
- 没有物理断电、真实磁盘耗尽、文件系统损坏的完整故障矩阵。已验证注入崩溃点和采集不可写/输出上限，但不把这些当作全部存储故障
- 单账号是用户选择，已说明同UID可读密钥/改本地状态/干扰采集；未实现强UID隔离、受控特权启动器或cgroup子树约束
- 暂无保留期/自动GC/用户管理UI/SSO/MFA/加密对象存储/独立防篡改见证；本地输出和去重墓碑保留，磁盘低水位拒绝新执行
- P2 PTY/强制时序录像、P3 EasyTier探测/私网优先、公网数据配额策略、P4批量/模板/调度、P5可选SSH/升级/规模与安全审查均未交付
- 备份为明确停服方案，不宣称在线数据库与文件快照原子一致
- 商用依赖许可证/SBOM/漏洞审查和生产安全审计未完成

## 运行中修正

首次扩展备份测试曾因测试HTTP客户端复用服务重启前的keep-alive socket出现ECONNRESET。测试改为显式新连接后，完整固定版本端到端22/22通过；没有跳过恢复验证。最终结果只以修正后的全量运行计。
