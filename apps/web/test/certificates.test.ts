import { afterEach, expect, it, vi } from "vitest";
import { mount, flushPromises } from "@vue/test-utils";
import CertificateSettingsPanel from "../src/components/CertificateSettingsPanel.vue";
import { api, ApiError } from "../src/api/client";
afterEach(() => {
  vi.restoreAllMocks();
  vi.useRealTimers();
});
const initial = {
  v: 1,
  revision: 0,
  mode: "acme",
  acme_available: true,
  private_ca_available: true,
  private_ca: null,
  activation_ready: false,
  domain: "",
  email: "",
  enabled: false,
  tos_agreed: false,
  available: true,
  challenge_port: 8080,
  challenge_ready: true,
  status: "disabled",
  last_error: null,
  last_attempt_at: null,
  last_success_at: null,
  next_attempt_at: null,
  retry_allowed_at: null,
  certificate: {
    subject: "CN=localhost",
    issuer: "CN=Bootstrap CA",
    domains: "DNS:localhost",
    valid_from: 1700000000000,
    expires_at: 1900000000000,
    fingerprint: "test",
    renew_at: 1890000000000,
    managed: false,
    domain: null,
    expired: false,
  },
};
it("shows expiry, obtains consent and saves domain configuration exactly once", async () => {
  let resolve!: (value: unknown) => void;
  const request = vi
    .spyOn(api, "request")
    .mockResolvedValueOnce(initial)
    .mockImplementationOnce(
      () =>
        new Promise((r) => {
          resolve = r;
        }),
    );
  const w = mount(CertificateSettingsPanel, {
    global: { stubs: { AgentCASyncPanel: true } },
  });
  await flushPromises();
  expect(w.get('[data-testid="certificate-expiry"]').text()).not.toBe("");
  expect(w.findAll("button").some((b) => b.text() === "立即续签")).toBe(false);
  await w.get('[name="certificate-domain"]').setValue("fleet.example.com");
  await w.get('[name="certificate-email"]').setValue("ops@example.com");
  await w.get('[name="certificate-enabled"]').setValue(true);
  expect(w.get('button[type="submit"]').attributes("disabled")).toBeDefined();
  await w.get('[name="certificate-terms"]').setValue(true);
  await w.get("form").trigger("submit");
  await w.get("form").trigger("submit");
  expect(request).toHaveBeenCalledTimes(2);
  const body = {
    v: 1,
    revision: 0,
    mode: "acme",
    domain: "fleet.example.com",
    email: "ops@example.com",
    enabled: true,
    tos_agreed: true,
  };
  expect(request.mock.calls[1]).toEqual([
    "/settings/certificate",
    { method: "PUT", body },
  ]);
  resolve({ ...initial, ...body, revision: 1, status: "pending" });
  await flushPromises();
  expect(w.text()).toContain("等待申请");
  expect(w.get('[role="status"]').text()).toContain("后台");
  w.unmount();
});
it("polls issuance status without overwriting a draft and stops polling on unmount", async () => {
  vi.useFakeTimers();
  const request = vi
    .spyOn(api, "request")
    .mockResolvedValueOnce(initial)
    .mockResolvedValue({
      ...initial,
      status: "error",
      last_error: { code: "ACME_DNS_FAILED", message: "域名解析验证失败" },
    });
  const w = mount(CertificateSettingsPanel, {
    global: { stubs: { AgentCASyncPanel: true } },
  });
  await flushPromises();
  await w.get('[name="certificate-domain"]').setValue("unsaved.example.com");
  await vi.advanceTimersByTimeAsync(5000);
  await flushPromises();
  expect(
    w.get<HTMLInputElement>('[name="certificate-domain"]').element.value,
  ).toBe("unsaved.example.com");
  expect(w.text()).toContain("域名解析验证失败");
  w.unmount();
  const count = request.mock.calls.length;
  await vi.advanceTimersByTimeAsync(10000);
  expect(request).toHaveBeenCalledTimes(count);
});
it("preserves a stale draft and requires reload after a conflict", async () => {
  const request = vi
    .spyOn(api, "request")
    .mockResolvedValueOnce(initial)
    .mockRejectedValueOnce(new ApiError("CERTIFICATE_REVISION_CONFLICT", 409));
  const w = mount(CertificateSettingsPanel, {
    global: { stubs: { AgentCASyncPanel: true } },
  });
  await flushPromises();
  await w.get('[name="certificate-domain"]').setValue("fleet.example.com");
  await w.get('[name="certificate-email"]').setValue("ops@example.com");
  await w.get("form").trigger("submit");
  await flushPromises();
  expect(w.get('[role="alert"]').text()).toContain("其他管理员");
  expect(w.get('button[type="submit"]').attributes("disabled")).toBeDefined();
  await w.get("form").trigger("submit");
  expect(request).toHaveBeenCalledTimes(2);
  w.unmount();
});
it("external TLS is labeled accurately and cannot enable managed issuance", async () => {
  vi.spyOn(api, "request").mockResolvedValue({
    ...initial,
    available: false,
    acme_available: false,
    status: "external",
    challenge_port: null,
    challenge_ready: false,
  });
  const w = mount(CertificateSettingsPanel, {
    global: { stubs: { AgentCASyncPanel: true } },
  });
  await flushPromises();
  expect(w.text()).toContain("下方显示服务端证书");
  expect(
    w.get('[name="certificate-enabled"]').attributes("disabled"),
  ).toBeDefined();
  w.unmount();
});
it("ignores a stale status poll that resolves after a successful save", async () => {
  vi.useFakeTimers();
  let resolvePoll!: (value: unknown) => void;
  vi.spyOn(api, "request")
    .mockResolvedValueOnce(initial)
    .mockImplementationOnce(
      () =>
        new Promise((r) => {
          resolvePoll = r;
        }),
    )
    .mockResolvedValueOnce({
      ...initial,
      domain: "fleet.example.com",
      email: "ops@example.com",
      revision: 1,
    });
  const w = mount(CertificateSettingsPanel, {
    global: { stubs: { AgentCASyncPanel: true } },
  });
  await flushPromises();
  await vi.advanceTimersByTimeAsync(5000);
  await w.get('[name="certificate-domain"]').setValue("fleet.example.com");
  await w.get('[name="certificate-email"]').setValue("ops@example.com");
  await w.get("form").trigger("submit");
  await flushPromises();
  resolvePoll(initial);
  await flushPromises();
  expect(
    w.get<HTMLInputElement>('[name="certificate-domain"]').element.value,
  ).toBe("fleet.example.com");
  expect(w.find('[role="alert"]').exists()).toBe(false);
  w.unmount();
});
it("private mode requires preparing a CA before activation and does not ask for public CA consent", async () => {
  const saved = {
    ...initial,
    revision: 1,
    mode: "private",
    acme_available: false,
    domain: "farhelm.internal",
    available: true,
  };
  const ca = {
    subject: "CN=Farhelm Private CA",
    fingerprint: "AB:".repeat(31) + "AB",
    valid_from: 1700000000000,
    expires_at: 2000000000000,
    expired: false,
    expiring: false,
  };
  const request = vi
    .spyOn(api, "request")
    .mockResolvedValueOnce({
      ...initial,
      acme_available: false,
      available: false,
    })
    .mockResolvedValueOnce(saved)
    .mockResolvedValueOnce({
      ...saved,
      private_ca: ca,
      activation_ready: true,
    });
  const w = mount(CertificateSettingsPanel, {
    global: { stubs: { AgentCASyncPanel: true } },
  });
  await flushPromises();
  await w.get('[name="certificate-mode"]').setValue("private");
  await w.get('[name="certificate-domain"]').setValue("farhelm.internal");
  expect(w.find('[name="certificate-email"]').exists()).toBe(false);
  expect(w.find('[name="certificate-terms"]').exists()).toBe(false);
  expect(
    w.get('[name="certificate-enabled"]').attributes("disabled"),
  ).toBeDefined();
  await w.get("form").trigger("submit");
  await flushPromises();
  expect(request.mock.calls[1]![1]?.body).toMatchObject({
    mode: "private",
    domain: "farhelm.internal",
    enabled: false,
    email: "",
    tos_agreed: false,
  });
  await w
    .findAll("button")
    .find((b) => b.text() === "创建内网 CA")!
    .trigger("click");
  await flushPromises();
  expect(request.mock.calls[2]).toEqual([
    "/settings/certificate/ca",
    { method: "POST", body: { v: 1, revision: 1 } },
  ]);
  expect(w.get('[data-testid="ca-fingerprint"]').text()).toBe(ca.fingerprint);
  expect(
    w.get('[name="certificate-enabled"]').attributes("disabled"),
  ).toBeUndefined();
  await w.get('[name="certificate-enabled"]').setValue(true);
  expect(w.get('button[type="submit"]').attributes("disabled")).toBeUndefined();
  expect(w.text()).toContain("新 Agent 安装命令自动携带 CA");
  expect(w.text()).not.toContain("HTTP 验证入口");
  w.unmount();
});
it("changing certificate mode stops automatic activation until the new mode is saved", async () => {
  vi.spyOn(api, "request").mockResolvedValue({
    ...initial,
    enabled: true,
    tos_agreed: true,
  });
  const w = mount(CertificateSettingsPanel, {
    global: { stubs: { AgentCASyncPanel: true } },
  });
  await flushPromises();
  await w.get('[name="certificate-mode"]').setValue("private");
  expect(
    w.get<HTMLInputElement>('[name="certificate-enabled"]').element.checked,
  ).toBe(false);
  w.unmount();
});

it("manual private renewal uses its own action, blocks duplicate clicks and respects cooldown and drafts", async () => {
  const state = {
    ...initial,
    mode: "private",
    revision: 2,
    enabled: true,
    status: "valid",
    domain: "farhelm.internal",
    certificate: {
      ...initial.certificate,
      managed: true,
      domain: "farhelm.internal",
    },
  };
  let finish!: (value: unknown) => void;
  const request = vi
    .spyOn(api, "request")
    .mockResolvedValueOnce(state)
    .mockImplementationOnce(
      () =>
        new Promise((r) => {
          finish = r;
        }),
    );
  const w = mount(CertificateSettingsPanel, {
    global: { stubs: { AgentCASyncPanel: true } },
  });
  await flushPromises();
  const renew = () => w.findAll("button").find((b) => b.text() === "立即续签")!;
  await w.get('[name="certificate-domain"]').setValue("changed.internal");
  expect(renew().attributes("disabled")).toBeDefined();
  await w.get('[name="certificate-domain"]').setValue("farhelm.internal");
  await renew().trigger("click");
  await renew().trigger("click");
  expect(request).toHaveBeenCalledTimes(2);
  expect(request.mock.calls[1]).toEqual([
    "/settings/certificate/renew",
    { method: "POST", body: { v: 1, revision: 2 } },
  ]);
  finish({ ...state, retry_allowed_at: Date.now() + 300000 });
  await flushPromises();
  expect(renew().attributes("disabled")).toBeDefined();
  expect(w.get('[role="status"]').text()).toContain("同一 CA");
  w.unmount();
});

it.each(["8.8.8.8", "2606:4700:4700::1111"])(
  "saves public IP %s and displays scheduled renewal without CA import",
  async (domain) => {
    const state = {
      ...initial,
      domain,
      revision: 1,
      enabled: true,
      tos_agreed: true,
      status: "valid",
      certificate: { ...initial.certificate, managed: true, domain },
    };
    const request = vi
      .spyOn(api, "request")
      .mockResolvedValueOnce(initial)
      .mockResolvedValueOnce(state);
    const w = mount(CertificateSettingsPanel, {
      global: { stubs: { AgentCASyncPanel: true } },
    });
    await flushPromises();
    expect(w.text()).toContain("平台域名或公网 IP");
    await w.get('[name="certificate-domain"]').setValue(domain);
    await w.get('[name="certificate-email"]').setValue("ops@example.com");
    await w.get('[name="certificate-enabled"]').setValue(true);
    await w.get('[name="certificate-terms"]').setValue(true);
    await w.get("form").trigger("submit");
    await flushPromises();
    expect(request.mock.calls[1]![1]?.body).toMatchObject({
      domain,
      mode: "acme",
      enabled: true,
    });
    expect(w.get('[data-testid="ip-certificate-hint"]').text()).toContain(
      "160 小时",
    );
    expect(w.get('[data-testid="certificate-renewal"]').text()).not.toBe("");
    expect(w.text()).not.toContain("下载 CA 证书");
    w.unmount();
  },
);
it("explains private IP rejection and preserves the submitted draft", async () => {
  vi.spyOn(api, "request")
    .mockResolvedValueOnce(initial)
    .mockRejectedValueOnce(new ApiError("INVALID_CERTIFICATE_PUBLIC_IP", 400));
  const w = mount(CertificateSettingsPanel, {
    global: { stubs: { AgentCASyncPanel: true } },
  });
  await flushPromises();
  await w.get('[name="certificate-domain"]').setValue("192.168.1.1");
  await w.get('[name="certificate-email"]').setValue("ops@example.com");
  await w.get("form").trigger("submit");
  await flushPromises();
  expect(w.get('[role="alert"]').text()).toContain("平台私有 CA");
  expect(
    w.get<HTMLInputElement>('[name="certificate-domain"]').element.value,
  ).toBe("192.168.1.1");
  w.unmount();
});
