import type { AuditEntry } from "./api/types";
import { formatTime, statusLabels } from "./model";

export const auditActionLabels: Record<string, string> = {
  "device.disk_requested": "请求磁盘采集",
  "device.disk_collected": "磁盘采集完成",
  "device.disk_failed": "磁盘采集失败",
  "device.terminal_limit_updated": "修改设备终端限额",
  "device.disk_schedule_updated": "修改磁盘采集间隔",
  "api_token.created": "创建 API Token",
  "api_token.updated": "修改 API Token 授权",
  "api_token.revoked": "撤销 API Token",
  "api_token.request": "API Token 调用",
  "network.platform_settings_updated": "修改平台网络策略",
  "network.device_address_updated": "修改设备内网地址",
  "network.route_configured": "修改设备网络策略",
  "network.route_changed": "网络通道状态变化",
  "network.route_selected": "选择终端网络通道",
  "user.bootstrap": "初始化账号",
  "user.login": "账号登录",
  "user.logout": "退出登录",
  "user.login_failed": "登录失败",
  "enrollment.created": "生成 Agent 安装凭据",
  "device.enrolled": "注册设备",
  "device.revoked": "撤销设备",
  "task.created": "创建命令任务",
  "task.cancel_requested": "请求取消任务",
  "output.viewed": "读取任务输出",
  "authorization.denied": "操作被拒绝",
  "task.accepted": "Agent 接收任务",
  "task.started": "任务开始执行",
  "task.finished": "任务执行结束",
  "access.authorization_created": "新增访问授权",
  "access.authorization_deleted": "删除访问授权",
  "access.sudo_configured": "配置设备 sudo 授权",
  "access.sudo_deleted": "删除设备 sudo 授权",
  "account.configured": "配置登录账号",
  "account.deleted": "删除登录账号",
  "terminal.privilege_requested": "修改 Agent 终端提权设置",
  "terminal.privilege_result": "Agent 终端提权应用结果",
  "terminal.created": "创建终端会话",
  "terminal.opened": "终端连接成功",
  "terminal.closed": "终端会话结束",
  "terminal.recording_viewed": "查看终端录制",
  "terminal.recording_exported": "导出终端录制",
  "health.configured": "修改健康检查",
  "health.run_requested": "发起健康检查",
  "connection.configured": "修改设备接入配置",
  "connection.host_key_scanned": "扫描 SSH 主机密钥",
  "connection.tested": "测试 SSH 连接",
  "settings.connections_updated": "修改连接限额",
  "settings.updated": "修改平台服务端地址",
  "settings.agent_sync": "Agent 地址同步结果",
  "settings.sync_requested": "发起 Agent 地址同步",
  "agent.upgrade_requested": "发起 Agent 升级",
  "agent.upgrade_status": "Agent 升级状态",
  "agent.release_uploaded": "上传 Agent 升级包",
  "agent.release_imported": "导入 Agent 版本",
  "agent.release_availability": "更改 Agent 版本可用状态",
  "network.probes_configured": "修改网络探测",
  "access.user_created": "创建账号",
  "access.user_updated": "修改账号与授权",
  "access.password_reset": "管理员重置密码",
  "access.password_changed": "修改本人密码",
  "access.role_created": "创建角色",
  "access.role_updated": "修改角色权限",
  "access.role_deleted": "删除角色",
  "access.group_created": "创建用户组",
  "access.group_updated": "修改用户组授权",
  "access.group_deleted": "删除用户组",
  "access.device_group_created": "创建设备组",
  "access.device_group_updated": "修改设备组",
  "access.device_group_deleted": "删除设备组",
  "access.device_tags_updated": "批量修改设备标签",
  "device.agent_enabled": "设备启用 Agent",
  "certificate.configured": "修改证书配置",
  "certificate.check_requested": "发起证书检查或续签",
  "certificate.issued": "证书签发成功",
  "certificate.failed": "证书签发失败",
  "certificate.ca_created": "创建内网 CA",
  "certificate.ca_sync_requested": "发起 CA 同步",
  "certificate.agent_ca_synced": "Agent CA 同步结果",
  "deployment.requested": "申请切换部署模式",
  "deployment.applied": "部署模式切换成功",
  "deployment.rolled_back": "部署模式已回滚",
  "user.password_change_failed": "本人改密验证失败",
};
const labels: Record<string, string> = {
  rule_id: "授权规则 ID",
  effect: "sudo 策略",
  sudo_allowed: "会话允许 sudo",
  sudo_enforced: "会话策略已落实",
  per_user: "单用户并发连接上限",
  per_device: "单设备终端默认上限",
  terminal_limit: "设备终端上限",
  effective_limit: "生效终端上限",
  terminal_total: "平台终端总上限",
  ssh_total: "SSH 总连接上限",
  ssh_per_ip: "单 IP SSH 连接上限",
  account_id: "登录账号 ID",
  subject_type: "授权对象类型",
  subject_id: "授权对象 ID",
  token_id: "Token ID",
  owner_id: "所属账号 ID",
  status_code: "HTTP 状态码",
  channel: "网络通道",
  vpn_ip: "内网 / VPN IP",
  ssh_port: "SSH 内网端口",
  endpoint: "连接地址",
  policy: "网络策略",
  network_route: "实际连接路径",
  action: "操作类型",
  argv: "命令参数",
  cwd: "工作目录",
  username: "账号",
  name: "名称",
  role: "角色",
  reason: "原因",
  status: "状态",
  exit_code: "退出码",
  audit_complete: "录制完整",
  authorized: "授权通过",
  session_id: "终端会话 ID",
  transport: "接入入口",
  backend: "设备通道",
  connection_kind: "设备接入方式",
  cols: "终端列数",
  rows: "终端行数",
  stream: "输出流",
  size: "字节数",
  sha256: "SHA-256",
  payload_hash: "任务校验值",
  event_id: "事件 ID",
  seq: "事件序号",
  after: "读取起始序号",
  last_seq: "最后事件序号",
  revision: "配置版本",
  version: "版本",
  target_version: "目标版本",
  agent_version: "Agent 版本",
  arch: "系统架构",
  release_id: "版本 ID",
  job_id: "升级任务 ID",
  target_id: "操作对象 ID",
  enabled: "启用",
  must_change_password: "首次登录强制改密",
  role_ids: "角色",
  group_ids: "用户组",
  allowed_users: "允许使用的用户",
  allowed_groups: "允许使用的用户组",
  allowed_roles: "允许使用的角色",
  member_ids: "成员",
  device_ids: "设备",
  device_scope: "设备范围",
  permissions: "权限",
  description: "说明",
  operation: "操作",
  group_id: "设备组 ID",
  changed_count: "变更数量",
  server_url: "平台地址",
  previous_url: "原平台地址",
  url: "地址",
  host: "主机",
  port: "端口",
  user: "系统账号",
  fingerprint: "证书/主机密钥指纹",
  method: "方式",
  elevated: "sudo 切换",
  route: "接口",
  mode: "模式",
  domain: "域名",
  hosts: "证书名称",
  domains: "域名",
  challenge_type: "证书验证方式",
  expires_at: "到期时间",
  not_after: "有效期至",
  started_at: "开始时间",
  finished_at: "结束时间",
  at: "发生时间",
  cleanup: "进程清理",
  revoked_sessions: "撤销登录数",
  checks: "健康检查",
  probes: "网络探测",
  interval_seconds: "探测间隔（秒）",
  timeout_ms: "超时（毫秒）",
  device_access: "设备接入",
  web_enabled: "网页管理启用",
  web_protocol: "网页协议",
};
const values: Record<string, string> = {
  ...statusLabels,
  AGENT_EXEC: "Agent 执行命令",
  admin: "管理员",
  ops: "运维人员",
  business: "普通用户",
  auditor: "审计员",
  web: "网页",
  ssh: "SSH",
  agent: "Agent",
  PERMISSION_DENIED: "没有相应权限",
  DEVICE_SCOPE_DENIED: "设备不在授权范围内",
  TASK_OWNER_REQUIRED: "只能取消本人创建的任务",
  TERMINAL_OWNER_REQUIRED: "只能结束本人的会话",
  USER_DISCONNECTED: "用户主动断开",
  SHELL_EXIT: "Shell 正常退出",
  USER_LOGOUT: "账号退出登录",
  SERVER_RESTART: "服务端重启",
  AGENT_DISCONNECTED: "Agent 断连",
  AUTHORIZATION_EXPIRED: "登录或权限已失效",
  BROWSER_DISCONNECTED: "网页连接断开",
  allow: "允许",
  deny: "明确禁止",
  add: "添加",
  remove: "移除",
  completed: "已完成",
  failed: "失败",
  pending: "等待处理",
  running: "执行中",
  succeeded: "成功",
  private: "内网 CA",
  acme: "公共 CA",
  manual: "手动配置",
  "devices.read": "查看设备",
  "terminal.connect": "连接终端",
  "terminal.sudo": "使用 sudo／特权账号",
  "tasks.read": "查看本人任务",
  "tasks.read_all": "查看他人任务",
  "tasks.execute": "执行命令",
  "recordings.read": "查看本人会话与录制",
  "recordings.read_all": "查看他人会话与录制",
  "audit.read": "查看本人操作审计",
  "audit.read_all": "查看他人操作审计",
  "health.manage": "管理健康检查",
  "network.manage": "管理网络探测",
};
function object(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}
function format(key: string, value: unknown): string {
  if (key === "terminal_limit" && value === null) return "继承全局";
  if (value === null || value === undefined) return "未记录";
  if (typeof value === "boolean") return value ? "是" : "否";
  if (
    typeof value === "number" &&
    ["at", "started_at", "finished_at", "expires_at", "not_after"].includes(key)
  )
    return formatTime(value);
  if (key === "device_scope" && value === "*") return "全部设备";
  if (key === "subject_type")
    return (
      (
        {
          user: "用户",
          group: "用户组",
          role: "角色",
          device_scope: "继承原设备授权",
        } as Record<string, string>
      )[String(value)] ?? String(value)
    );
  if (Array.isArray(value))
    return value.length
      ? key === "argv"
        ? JSON.stringify(value)
        : value
            .map((v) =>
              typeof v === "string"
                ? ["permissions", "role_ids"].includes(key) &&
                  Object.hasOwn(values, v)
                  ? values[v]!
                  : v
                : JSON.stringify(v),
            )
            .join("、")
      : "无";
  if (typeof value === "object") return JSON.stringify(value, null, 2);
  return typeof value === "string"
    ? [
        "action",
        "status",
        "role",
        "reason",
        "transport",
        "backend",
        "connection_kind",
        "operation",
        "effect",
        "mode",
        "cleanup",
      ].includes(key) && Object.hasOwn(values, value)
      ? values[value]!
      : value
    : String(value);
}
export function auditFields(entry: AuditEntry) {
  const detail = object(entry.detail);
  const fields: { label: string; value: string }[] = [];
  const append = (data: Record<string, unknown>, suffix = "") => {
    for (const [key, value] of Object.entries(data)) {
      if (key === "changes" || key === "payload") continue;
      fields.push({
        label: (labels[key] ?? key) + suffix,
        value: format(key, value),
      });
    }
  };
  append(detail);
  append(object(detail.payload));
  append(object(detail.changes), "（变更后）");
  return fields;
}
export function auditSummary(entry: AuditEntry): string {
  const detail = object(entry.detail),
    payload = object(detail.payload);
  if (entry.action === "user.login_failed")
    return `尝试账号：${String(detail.username ?? "未记录")}（未认证）`;
  if (Array.isArray(detail.argv))
    return `命令：${JSON.stringify(detail.argv)}${detail.cwd ? " · 目录：" + detail.cwd : ""}`;
  const reason = payload.reason ?? detail.reason;
  if (reason) return format("reason", reason);
  const changes = Object.keys(object(detail.changes));
  if (changes.length)
    return `变更：${changes.map((k) => labels[k] ?? k).join("、")}`;
  const selected = auditFields(entry).filter(
    (f) => !["任务校验值", "事件 ID", "SHA-256"].includes(f.label),
  );
  return (
    selected
      .slice(0, 3)
      .map((f) => `${f.label}：${f.value}`)
      .join(" · ") || "未记录额外参数"
  );
}
export function auditOutcome(entry: AuditEntry): string {
  if (entry.action === "api_token.request") {
    const code = Number(object(entry.detail).status_code);
    return code >= 400 ? `失败 / 拒绝（${code}）` : `成功（${code}）`;
  }
  const detail = object(entry.detail),
    payload = object(detail.payload);
  const status = payload.status ?? detail.status;
  if (typeof status === "string") return format("status", status);
  if (
    entry.action.endsWith("failed") ||
    entry.action === "authorization.denied"
  )
    return "失败 / 拒绝";
  if (entry.action === "deployment.rolled_back") return "已回滚";
  if (entry.action === "user.login") return "登录成功";
  if (entry.action === "user.logout") return "当前登录会话已撤销";
  if (entry.action === "terminal.privilege_result")
    return detail.reason ? "应用失败" : detail.enabled ? "已启用" : "已关闭";
  if (entry.action === "connection.tested") return "已发起测试";
  if (
    entry.action.startsWith("access.") ||
    entry.action.endsWith("configured") ||
    entry.action === "settings.updated" ||
    entry.action === "settings.connections_updated"
  )
    return "已保存";
  if (entry.action === "task.created") return "已创建";
  if (entry.action.endsWith("requested")) return "已请求";
  if (entry.action === "terminal.created") return "等待连接";
  if (entry.action === "terminal.closed")
    return ["USER_DISCONNECTED", "SHELL_EXIT"].includes(String(detail.reason))
      ? "已结束"
      : "已中断";
  if (entry.action === "terminal.opened") return "已连接";
  if (entry.action === "task.started") return "执行中";
  if (entry.action === "task.accepted") return "已接收";
  return "已记录";
}
export function auditSource(entry: AuditEntry) {
  if (!entry.context) return "历史记录未采集来源";
  return {
    http: "网页 / API",
    api: `API Token${entry.context.api_token_name ? " · " + entry.context.api_token_name : ""}`,
    ssh: "SSH 入口",
    agent: "Agent 上报",
    system: "后台事件",
  }[entry.context.source];
}
