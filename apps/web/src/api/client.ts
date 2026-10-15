export class ApiError extends Error {
  readonly status: number;
  constructor(message: string, status = 0) {
    super(message);
    this.name = "ApiError";
    this.status = status;
  }
}

/** No localStorage, cookies, URL tokens, or automatic mutation retries. */
export class ApiClient {
  private token: string | null = null;
  onUnauthorized?: () => void;
  setToken(token: string | null) {
    this.token = token;
  }

  async request<T>(
    path: string,
    options: { method?: string; body?: unknown; idempotencyKey?: string } = {},
  ): Promise<T> {
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
    options: { method?: string; body?: unknown; idempotencyKey?: string },
  ): Promise<Response> {
    if (!path.startsWith("/") || path.startsWith("//"))
      throw new ApiError("无效 API 路径");
    const headers = new Headers({
      Accept: "application/json, application/octet-stream",
    });
    if (this.token) headers.set("Authorization", `Bearer ${this.token}`);
    if (options.body !== undefined)
      headers.set("Content-Type", "application/json");
    if (options.idempotencyKey)
      headers.set("Idempotency-Key", options.idempotencyKey);
    let response: Response;
    try {
      response = await fetch(`/api/v1${path}`, {
        method: options.method ?? "GET",
        headers,
        body:
          options.body === undefined ? undefined : JSON.stringify(options.body),
        credentials: "omit",
        cache: "no-store",
        redirect: "error",
        signal: AbortSignal.timeout(15_000),
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
