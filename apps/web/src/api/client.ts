export class ApiError extends Error {
  readonly status: number;
  constructor(message: string, status = 0) {
    super(message);
    this.name = "ApiError";
    this.status = status;
  }
}

type RequestOptions = {
  method?: string;
  body?: unknown;
  idempotencyKey?: string;
  binary?: File;
  manifest?: unknown;
  timeoutMs?: number;
};

/** No localStorage, cookies, URL tokens, or automatic mutation retries. */
export class ApiClient {
  private token: string | null = null;
  onUnauthorized?: () => void;
  setToken(token: string | null) {
    this.token = token;
  }

  async request<T>(path: string, options: RequestOptions = {}): Promise<T> {
    const response = await this.fetch(path, options);
    if (
      !(response.headers.get("content-type") ?? "").includes("application/json")
    ) {
      throw new ApiError(
        "API 返回了非 JSON 内容，请检查服务端与同源代理配置",
        response.status,
      );
    }
    return (await response.json()) as T;
  }

  async upload<T>(path: string, file: File, manifest: unknown): Promise<T> {
    return this.request<T>(path, { method: "PUT", binary: file, manifest });
  }

  async output(
    path: string,
    limit = 1_048_576,
  ): Promise<Uint8Array<ArrayBuffer>> {
    const response = await this.fetch(path, {});
    const declared = Number(response.headers.get("content-length"));
    if (declared > limit) {
      await response.body?.cancel();
      throw new ApiError("输出对象超过协议上限");
    }
    if (!response.body) throw new ApiError("输出响应为空");
    const reader = response.body.getReader();
    const chunks: Uint8Array[] = [];
    let length = 0;
    try {
      while (true) {
        const { value, done } = await reader.read();
        if (done) break;
        length += value.byteLength;
        if (length > limit) {
          await reader.cancel();
          throw new ApiError("输出对象超过协议上限");
        }
        chunks.push(value);
      }
    } finally {
      reader.releaseLock();
    }
    const bytes = new Uint8Array(length);
    let offset = 0;
    for (const chunk of chunks) {
      bytes.set(chunk, offset);
      offset += chunk.byteLength;
    }
    return bytes;
  }

  private async fetch(
    path: string,
    options: RequestOptions,
  ): Promise<Response> {
    if (!path.startsWith("/") || path.startsWith("//"))
      throw new ApiError("无效 API 路径");
    const headers = new Headers({
      Accept: "application/json, application/octet-stream",
    });
    if (this.token) headers.set("Authorization", `Bearer ${this.token}`);
    if (options.body !== undefined)
      headers.set("Content-Type", "application/json");
    if (options.binary) {
      headers.set("Content-Type", "application/octet-stream");
      headers.set("X-Agent-Manifest", JSON.stringify(options.manifest));
    }
    if (options.idempotencyKey)
      headers.set("Idempotency-Key", options.idempotencyKey);
    let response: Response;
    try {
      response = await fetch(`/api/v1${path}`, {
        method: options.method ?? "GET",
        headers,
        body:
          options.binary ??
          (options.body === undefined
            ? undefined
            : JSON.stringify(options.body)),
        credentials: "omit",
        cache: "no-store",
        redirect: "error",
        signal: AbortSignal.timeout(
          options.timeoutMs ?? (options.binary ? 120_000 : 15_000),
        ),
      });
    } catch {
      throw new ApiError(
        "无法连接 API，或请求超时。命令可能已提交，请使用同一请求重试确认",
      );
    }
    if (!response.ok) {
      if (response.status === 401 && this.token) this.onUnauthorized?.();
      let reason = "";
      try {
        const body = await response.json();
        reason =
          typeof body.error === "string"
            ? body.error
            : typeof body.message === "string"
              ? body.message
              : "";
      } catch {
        /* Untrusted error body is optional. */
      }
      const upgradeHints: Record<string, string> = {
        DEPLOYMENT_REVISION_CONFLICT:
          "运行设置已被其他管理员修改，请刷新后重新编辑。",
        DEPLOYMENT_ACTIVE_TASKS: "有尚未结束的命令任务，请等待完成后再切换。",
        DEPLOYMENT_ACTIVE_TERMINALS:
          "有活跃终端，请先正常退出终端，再刷新并应用设置。",
        DEPLOYMENT_APPLYING: "运行设置正在切换或等待确认，请稍后重试。",
        DEPLOYMENT_HTTPS_NOT_READY: "没有可用的 HTTPS 证书，原配置已保留。",
        DEPLOYMENT_CERTIFICATE_HOST_MISMATCH:
          "HTTPS 证书不包含当前入口地址，请使用证书对应的域名。",
        DEPLOYMENT_WEB_NOT_READY: "未找到网页文件，请先部署前端构建产物。",
        DEPLOYMENT_CONFIG_NOT_READY:
          "部署条件不满足，请检查监听配置；关闭全部网页与 Agent 通道时必须保留 SSH 入口。",
        AGENT_HTTPS_REQUIRED: "Agent 接入需要 HTTPS，请调整网页协议。",
        CONFIRM_WEB_DISABLE_REQUIRED: "请先保存恢复命令并确认关闭网页管理。",
        INVALID_HISTORY_QUERY: "历史筛选条件无效，请核对时间范围和状态。",
        INVALID_HISTORY_CURSOR: "历史分页已失效，请返回首页重新查询。",
        DEVICE_GROUP_SIZE_LIMIT:
          "每个设备组最多包含 1000 台设备，请缩小选择范围。",
        EMPTY_TAG_SELECTION: "请选择设备和标签。",
        TASK_OWNER_REQUIRED:
          "只能取消本人创建的任务；管理员可取消其他人的任务。",
        TASK_READ_PERMISSION_REQUIRED: "请先授予查看本人任务权限。",
        AUDIT_READ_PERMISSION_REQUIRED: "请先授予查看本人操作审计权限。",
        RECORDING_READ_PERMISSION_REQUIRED:
          "查看他人会话与录制需要先授予查看本人会话与录制。",
        INVALID_PASSWORD_POLICY:
          "密码至少 8 个字符，必须同时包含英文字母和数字。",
        ACCESS_NAME_EXISTS: "该账号、角色或用户组名称已存在",
        ACCESS_REVISION_CONFLICT:
          "ACCESS_REVISION_CONFLICT：配置已被其他操作修改，请刷新后重新编辑",
        LAST_ADMIN_REQUIRED: "必须保留至少一个启用的管理员账号",
        SELF_ADMIN_REQUIRED: "不能停用当前账号或移除自己的管理员权限",
        BUILTIN_ROLE_READ_ONLY: "内置角色不可修改或删除，请创建自定义角色",
        ROLE_IN_USE: "角色仍被用户或用户组使用，请先取消分配",
        UNKNOWN_ACCESS_REFERENCE: "所选角色、用户组或设备已不存在，请刷新列表",
        INVALID_USERNAME:
          "账号只能包含字母、数字、点、下划线、@ 和短横线，并以字母或数字开头",
        DEVICE_READ_PERMISSION_REQUIRED: "请同时选择查看设备权限",
        ACCESS_ENTRY_LIMIT: "已达到用户、角色或用户组数量上限",

        AGENT_RELEASE_CONFLICT:
          "该版本和架构已有不同的安装包，请使用新的版本号",
        AGENT_PACKAGE_SIZE: "安装包大小与版本清单不一致",
        AGENT_PACKAGE_ARCH: "请选择版本清单对应架构的 Linux Agent 安装包",
        AGENT_PACKAGE_DIGEST: "安装包校验失败，请重新选择与清单配套的文件",
        AGENT_PACKAGE_PROTOCOL: "安装包不支持当前升级协议",
        INVALID_AGENT_MANIFEST: "版本清单不是有效的 JSON 文件",
        AGENT_UPLOAD_BUSY: "有其他安装包正在上传，请稍后重试",
        AGENT_UPGRADE_IN_PROGRESS:
          "设备正在升级，现有操作结束后自动切换，请稍后重试",
        AGENT_UPGRADE_NOT_SUPPORTED:
          "所选设备尚不支持远程升级，请先更新基础程序",
        AGENT_RELEASE_CHANGED: "发布版本已更新，请刷新升级状态后重新选择",
        AGENT_DOWNGRADE_NOT_ALLOWED: "设备版本高于已发布版本，不能降级",
      };
      if (upgradeHints[reason])
        throw new ApiError(upgradeHints[reason], response.status);
      const hints: Record<number, string> = {
        401: "登录已失效或凭据错误",
        403: "无权进行此操作",
        404: "资源不存在或无权查看",
        409: "请求冲突，请核对原任务",
        429: "请求过于频繁，请稍后重试",
      };
      throw new ApiError(
        `${hints[response.status] ?? `API 请求失败 (${response.status})`}${reason ? `：${reason.slice(0, 240)}` : ""}`,
        response.status,
      );
    }
    return response;
  }
}
export const api = new ApiClient();
