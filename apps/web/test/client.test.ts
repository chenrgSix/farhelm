import { afterEach, describe, expect, it, vi } from "vitest";
import { ApiClient } from "../src/api/client";
afterEach(() => vi.unstubAllGlobals());
const json = (data: unknown, status = 200) =>
  new Response(JSON.stringify(data), {
    status,
    headers: { "content-type": "application/json" },
  });
describe("same-origin in-memory API client", () => {
  it("sends bearer token only in headers and retained idempotency key", async () => {
    const fetch = vi.fn().mockResolvedValue(json({ task_id: "t" }));
    vi.stubGlobal("fetch", fetch);
    const client = new ApiClient();
    client.setToken("test-secret");
    await client.request("/commands", {
      method: "POST",
      body: { v: 1 },
      idempotencyKey: "same-key",
    });
    expect(fetch.mock.calls[0]![0]).toBe("/api/v1/commands");
    const options = fetch.mock.calls[0]![1]!;
    expect(options.headers.get("Authorization")).toBe("Bearer test-secret");
    expect(options.headers.get("Idempotency-Key")).toBe("same-key");
    expect(options.credentials).toBe("omit");
    expect(options.cache).toBe("no-store");
    expect(options.redirect).toBe("error");
    expect(localStorage.length).toBe(0);
    expect(sessionStorage.length).toBe(0);
  });
  it("never silently succeeds when API is absent or HTML", async () => {
    const fetch = vi
      .fn()
      .mockRejectedValueOnce(new TypeError("offline"))
      .mockResolvedValueOnce(new Response("<html>vite fallback</html>"));
    vi.stubGlobal("fetch", fetch);
    const client = new ApiClient();
    await expect(client.request("/devices")).rejects.toThrow("无法连接 API");
    await expect(client.request("/devices")).rejects.toThrow("非 JSON");
    expect(fetch).toHaveBeenCalledTimes(2);
  });
  it("expires authenticated session on 401 and clears header when told", async () => {
    const fetch = vi
      .fn()
      .mockResolvedValueOnce(json({ error: "expired" }, 401))
      .mockResolvedValueOnce(json({}));
    vi.stubGlobal("fetch", fetch);
    const client = new ApiClient();
    client.setToken("expired");
    client.onUnauthorized = vi.fn(() => client.setToken(null));
    await expect(client.request("/me")).rejects.toThrow("登录已失效");
    expect(client.onUnauthorized).toHaveBeenCalledOnce();
    await client.request("/login");
    expect(fetch.mock.calls[1]![1]!.headers.has("Authorization")).toBe(false);
  });
  it("refuses external and protocol-relative paths", async () => {
    const client = new ApiClient();
    await expect(client.request("//evil.test")).rejects.toThrow("无效");
    await expect(client.request("https://evil.test")).rejects.toThrow("无效");
  });
  it("bounds streaming output even without a Content-Length header", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(new Response(new Uint8Array(20))),
    );
    await expect(
      new ApiClient().output("/tasks/t/output/stdout", 10),
    ).rejects.toThrow("超过协议上限");
  });
});
it("uploads a File without JSON/base64 conversion and keeps auth in headers", async () => {
  const fetch = vi.fn().mockResolvedValue(json({ v: 1 }));
  vi.stubGlobal("fetch", fetch);
  const client = new ApiClient();
  client.setToken("test-token");
  const file = new File([new Uint8Array(128)], "agent");
  const manifest = { sha256: "a".repeat(64) };
  await client.upload("/agent-releases/" + manifest.sha256, file, manifest);
  const options = fetch.mock.calls[0]![1];
  expect(options.body).toBe(file);
  expect(options.headers.get("Content-Type")).toBe("application/octet-stream");
  expect(JSON.parse(options.headers.get("X-Agent-Manifest"))).toEqual(manifest);
  expect(options.headers.get("Authorization")).toBe("Bearer test-token");
  expect(options.redirect).toBe("error");
});
