import { readFileSync, readdirSync } from "node:fs";
import { gzipSync } from "node:zlib";
import type { Permission } from "./permissions.js";

interface Operation {
  method: "GET" | "POST" | "PUT";
  path: string;
  summary: string;
  permission?: Permission;
  request?: string;
  response?: string;
  history?: "tasks" | "audit" | "sessions";
}
// Explicitly published operations. Adding an admin endpoint does not grant tokens access.
export const publicOperations: Operation[] = [
  {
    method: "GET",
    path: "/me",
    summary: "查看当前身份和令牌有效权限",
    response: "me-response",
  },
  { method: "GET", path: "/openapi.json", summary: "获取通用 API 文档" },
  {
    method: "GET",
    path: "/device-options",
    summary: "分页搜索授权设备的轻量选择项",
    permission: "devices.read",
    response: "device-options-response",
  },
  {
    method: "GET",
    path: "/devices",
    summary: "查询授权设备",
    permission: "devices.read",
    response: "devices-response",
  },
  {
    method: "GET",
    path: "/devices/:id",
    summary: "查询单台授权设备状态",
    permission: "devices.read",
    response: "device",
  },
  {
    method: "GET",
    path: "/devices/:id/disk",
    summary: "查看设备磁盘缓存与采集计划",
    permission: "devices.read",
    response: "device-disk-response",
  },
  {
    method: "POST",
    path: "/devices/:id/disk/collect",
    summary: "按需采集磁盘（服务端缓存与限流）",
    permission: "devices.read",
    request: "device-disk-collect-request",
    response: "device-disk-response",
  },
  {
    method: "GET",
    path: "/devices/:id/health-checks",
    summary: "查看健康检查",
    permission: "devices.read",
    response: "device-health-response",
  },
  {
    method: "PUT",
    path: "/devices/:id/health-checks",
    summary: "配置健康检查",
    permission: "health.manage",
    request: "health-config",
    response: "device-health-response",
  },
  {
    method: "POST",
    path: "/devices/:id/health-checks/run",
    summary: "触发健康检查",
    permission: "health.manage",
    request: "health-run-request",
    response: "revoke-response",
  },
  {
    method: "GET",
    path: "/devices/:id/network",
    summary: "查看设备网络状态",
    permission: "devices.read",
    response: "device-network-response",
  },
  {
    method: "GET",
    path: "/devices/:id/network-route",
    summary: "查看网络通道",
    permission: "devices.read",
    response: "network-route-response",
  },
  {
    method: "GET",
    path: "/devices/:id/network-probes",
    summary: "查看网络探测配置",
    permission: "devices.read",
    response: "network-probes-response",
  },
  {
    method: "PUT",
    path: "/devices/:id/network-probes",
    summary: "配置网络探测",
    permission: "network.manage",
    request: "network-probes-update",
    response: "network-probes-response",
  },
  {
    method: "POST",
    path: "/commands",
    summary: "创建 Agent 命令任务",
    permission: "tasks.execute",
    request: "commands",
    response: "command-response",
  },
  {
    method: "GET",
    path: "/tasks",
    summary: "查询命令任务",
    permission: "tasks.read",
    response: "tasks-response",
    history: "tasks",
  },
  {
    method: "GET",
    path: "/tasks/summary",
    summary: "统计全部可见任务中的进行中和待核对数量",
    permission: "tasks.read",
    response: "task-summary-response",
  },
  {
    method: "GET",
    path: "/tasks/:id",
    summary: "查询任务结果",
    permission: "tasks.read",
    response: "task-response",
  },
  {
    method: "POST",
    path: "/tasks/:id/cancel",
    summary: "取消本人任务",
    permission: "tasks.execute",
    response: "cancel-response",
  },
  {
    method: "GET",
    path: "/tasks/:task_id/output/:stream",
    summary: "读取任务输出",
    permission: "tasks.read",
  },
  {
    method: "GET",
    path: "/audit",
    summary: "查询操作审计",
    permission: "audit.read",
    response: "audit-response",
    history: "audit",
  },
  {
    method: "POST",
    path: "/terminal-sessions",
    summary: "创建录制终端及一次性连接票据",
    permission: "terminal.connect",
    request: "terminal-create",
    response: "terminal-created",
  },
  {
    method: "GET",
    path: "/terminal-sessions",
    summary: "查询终端会话",
    permission: "recordings.read",
    response: "terminal-sessions",
    history: "sessions",
  },
  {
    method: "POST",
    path: "/terminal-sessions/:id/close",
    summary: "结束本人终端会话",
    permission: "terminal.connect",
    response: "revoke-response",
  },
  {
    method: "GET",
    path: "/terminal-sessions/:id/recording",
    summary: "读取录制事件",
    permission: "recordings.read",
    response: "terminal-recording",
  },
  {
    method: "POST",
    path: "/terminal-sessions/:id/export",
    summary: "登记录制导出操作（内容通过 recording 分页获取）",
    permission: "recordings.read",
    response: "revoke-response",
  },
];

let document: unknown;
export function openApiDocument() {
  if (document) return document;
  const root = new URL("../../../contracts/v1/", import.meta.url);
  const schemas: Record<string, unknown> = {};
  function rewrite(value: any): any {
    if (Array.isArray(value)) return value.map(rewrite);
    if (!value || typeof value !== "object") return value;
    return Object.fromEntries(
      Object.entries(value)
        .filter(([k]) => k !== "$id" && k !== "$schema")
        .map(([key, v]) => [
          key,
          key === "$ref" && typeof v === "string" && v.includes(".schema.json")
            ? v.replace(
                /^(?:https:\/\/fleet.local\/contracts\/v1\/)?([^/#]+)\.schema\.json(?:#)?/,
                "#/components/schemas/$1",
              )
            : rewrite(v),
        ]),
    );
  }
  for (const file of readdirSync(root).filter((f) =>
    f.endsWith(".schema.json"),
  ))
    schemas[file.replace(".schema.json", "")] = rewrite(
      JSON.parse(readFileSync(new URL(file, root), "utf8")),
    );
  const id = { type: "string", minLength: 1, maxLength: 128 };
  const terminalSession = {
    type: "object",
    properties: {
      id,
      device_id: id,
      actor_id: id,
      status: { enum: ["OPENING", "OPEN", "CLOSED", "INTERRUPTED"] },
      created_at: { type: "integer" },
      ended_at: { type: ["integer", "null"] },
      audit_complete: { type: "integer" },
      backend: { enum: ["agent", "ssh"] },
      transport: { enum: ["web", "ssh"] },
    },
  };
  schemas["terminal-create"] = {
    type: "object",
    additionalProperties: false,
    required: ["v", "device_id", "cols", "rows"],
    not: { required: ["account_id", "connection_mode"] },
    properties: {
      v: { const: 1 },
      device_id: id,
      account_id: id,
      connection_mode: { enum: ["normal", "root"] },
      cols: { type: "integer", minimum: 20, maximum: 500 },
      rows: { type: "integer", minimum: 5, maximum: 200 },
    },
  };
  schemas["terminal-created"] = {
    type: "object",
    required: ["v", "session_id", "ticket", "expires_at"],
    properties: {
      v: { const: 1 },
      session_id: id,
      ticket: { type: "string" },
      expires_at: { type: "integer" },
    },
  };
  schemas["terminal-sessions"] = {
    type: "object",
    properties: {
      v: { const: 1 },
      sessions: { type: "array", items: terminalSession },
      page: {
        type: "object",
        properties: {
          limit: { type: "integer" },
          has_more: { type: "boolean" },
          next_cursor: { type: ["string", "null"] },
        },
      },
    },
  };
  schemas["terminal-recording"] = {
    type: "object",
    properties: {
      v: { const: 1 },
      session: terminalSession,
      next: { type: "integer" },
      events: {
        type: "array",
        items: {
          type: "object",
          properties: {
            seq: { type: "integer" },
            at: { type: "integer" },
            kind: { type: "string" },
            data: {},
          },
        },
      },
    },
  };
  const ref = (name: string) => {
    if (!schemas[name]) throw Error("Missing API schema: " + name);
    return { $ref: "#/components/schemas/" + name };
  };
  const paths: Record<string, any> = {};
  for (const op of publicOperations) {
    const path = "/api/v1" + op.path.replace(/:([a-z_]+)/g, "{$1}");
    const parameters: any[] = [...op.path.matchAll(/:([a-z_]+)/g)].map((m) => ({
      name: m[1],
      in: "path",
      required: true,
      schema:
        m[1] === "stream"
          ? { type: "string", enum: ["stdout", "stderr"] }
          : { type: "string" },
    }));
    if (
      ["/devices", "/device-options"].includes(op.path) &&
      op.method === "GET"
    ) {
      for (const [name, schema, description] of [
        [
          "page",
          { type: "integer", minimum: 1 },
          "页码，从 1 开始；超出末页时返回末页。传入任意查询参数即启用分页。",
        ],
        [
          "limit",
          { type: "integer", minimum: 1, maximum: 100, default: 50 },
          "每页设备数；无查询参数时保留完整列表。",
        ],
        [
          "q",
          { type: "string", maxLength: 256 },
          "搜索名称、ID、Agent 版本、IP 或组名（字面包含匹配）。",
        ],
        [
          "group",
          { type: "string", maxLength: 128 },
          "设备组 ID；__ungrouped__ 表示未分组。",
        ],
      ])
        parameters.push({
          name,
          in: "query",
          required: false,
          schema,
          description,
        });
    }
    if (op.path === "/device-options") {
      parameters.push({
        name: "purpose",
        in: "query",
        schema: { type: "string", enum: ["read", "exec"], default: "read" },
        description: "exec 额外要求 tasks.execute，仅返回未撤销的 Agent 设备。",
      });
      parameters.push({
        name: "ids",
        in: "query",
        schema: { type: "string", maxLength: 20000 },
        description:
          "最多 50 个设备 ID 的 JSON 数组，用于解析已有选择；仍应用当前权限。",
      });
      parameters.find((p) => p.name === "page").description =
        "页码，从 1 开始；本接口始终分页。";
      parameters.find((p) => p.name === "limit").description =
        "每页设备数，默认 50，最多 100；不返回设备运行状态。";
    }
    if (op.history)
      for (const name of [
        "limit",
        "cursor",
        "q",
        "device_id",
        "actor_id",
        "from",
        "to",
        op.history === "audit" ? "action" : "status",
      ])
        parameters.push({
          name,
          in: "query",
          schema: ["limit", "from", "to"].includes(name)
            ? {
                type: "integer",
                minimum: name === "limit" ? 1 : 0,
                ...(name === "limit" ? { maximum: 100 } : {}),
              }
            : { type: "string" },
        });
    if (op.path.endsWith("/recording"))
      parameters.push({
        name: "after",
        in: "query",
        schema: { type: "integer", minimum: 0 },
      });
    if (op.path === "/commands")
      parameters.push({
        name: "Idempotency-Key",
        in: "header",
        required: true,
        schema: { type: "string", minLength: 1, maxLength: 128 },
      });
    const binary = op.path.includes("/output/");
    (paths[path] ??= {})[op.method.toLowerCase()] = {
      summary: op.summary,
      description: op.permission
        ? `需要 ${op.permission}，并受令牌与所属用户当前设备范围约束。查看他人历史另需对应的 read_all 权限。`
        : "需要有效身份。",
      parameters,
      ...(op.method !== "GET"
        ? {
            requestBody: {
              required: true,
              content: {
                "application/json": {
                  schema: op.request
                    ? ref(op.request)
                    : {
                        type: "object",
                        additionalProperties: false,
                        required: ["v"],
                        properties: { v: { const: 1 } },
                      },
                },
              },
            },
          }
        : {}),
      responses: {
        "200": {
          description: "成功",
          content: {
            [binary ? "application/octet-stream" : "application/json"]: {
              schema: binary
                ? { type: "string", format: "binary" }
                : op.response
                  ? ref(op.response)
                  : {},
            },
          },
        },
        default: {
          description: "错误；401 凭据失效，403 无权限，409 冲突，429 限流",
          content: { "application/json": { schema: ref("error-response") } },
        },
      },
    };
  }
  document = {
    openapi: "3.1.0",
    info: {
      title: "Farhelm 通用 API",
      version: "1",
      description:
        "Bearer API Token。权限和设备范围取令牌与所属用户当前授权的交集。API Token 不可管理账号、系统设置或其他令牌。终端票据通过 /api/v1/terminal/ws 交换，沿用终端协议及会话录制。",
    },
    servers: [{ url: "/" }],
    security: [{ apiToken: [] }],
    paths,
    components: {
      securitySchemes: {
        apiToken: { type: "http", scheme: "bearer", bearerFormat: "fh_api_…" },
      },
      schemas,
    },
  };
  return document;
}

// Fixed source files only; the archive contains no deployment configuration or credentials.
export function skillArchive() {
  const chunks: Buffer[] = [];
  for (const file of ["SKILL.md", "scripts/farhelm.py", "references/api.md"]) {
    const data = readFileSync(
      new URL("../../../skills/farhelm-api/" + file, import.meta.url),
    );
    const header = Buffer.alloc(512);
    header.write("farhelm-api/" + file, 0, 100);
    header.write("0000644\0", 100);
    header.write("0000000\0", 108);
    header.write("0000000\0", 116);
    header.write(data.length.toString(8).padStart(11, "0") + "\0", 124);
    header.write("00000000000\0", 136);
    header.fill(32, 148, 156);
    header.write("0", 156);
    header.write("ustar\0", 257);
    header.write("00", 263);
    header.write(
      header
        .reduce((sum, n) => sum + n, 0)
        .toString(8)
        .padStart(6, "0") + "\0 ",
      148,
    );
    chunks.push(header, data, Buffer.alloc((512 - (data.length % 512)) % 512));
  }
  return gzipSync(Buffer.concat([...chunks, Buffer.alloc(1024)]));
}
