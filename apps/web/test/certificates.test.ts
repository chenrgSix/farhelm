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
  const w = mount(CertificateSettingsPanel);
  await flushPromises();
  expect(w.get('[data-testid="certificate-expiry"]').text()).not.toBe("");
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
  const w = mount(CertificateSettingsPanel);
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
  const w = mount(CertificateSettingsPanel);
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
    status: "external",
    challenge_port: null,
    challenge_ready: false,
  });
  const w = mount(CertificateSettingsPanel);
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
  const w = mount(CertificateSettingsPanel);
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
