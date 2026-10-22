import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { flushPromises, mount, type VueWrapper } from "@vue/test-utils";
import ChangePasswordPanel from "../src/components/ChangePasswordPanel.vue";
import App from "../src/App.vue";
import { api, ApiError } from "../src/api/client";
import { readTabSession } from "../src/tab-session";
let wrapper: VueWrapper | undefined;
beforeEach(() => {
  // jsdom does not implement the native dialog API.
  HTMLDialogElement.prototype.showModal = vi.fn(function (
    this: HTMLDialogElement,
  ) {
    this.open = true;
  });
  HTMLDialogElement.prototype.close = vi.fn(function (this: HTMLDialogElement) {
    this.open = false;
  });
});
afterEach(() => {
  window.history.replaceState(null, "", "/");
  wrapper?.unmount();
  wrapper = undefined;
  vi.restoreAllMocks();
  api.setToken(null);
  sessionStorage.clear();
});
async function fill(
  current = "old-personal-password1",
  next = "new-personal-password1",
  confirm = next,
) {
  await wrapper!.get('[name="current-password"]').setValue(current);
  await wrapper!.get('[name="new-password"]').setValue(next);
  await wrapper!.get('[name="confirm-password"]').setValue(confirm);
}
it("validates confirmation, prevents duplicate submits and sends only current and new passwords", async () => {
  let resolve!: (v: unknown) => void;
  const request = vi.spyOn(api, "request").mockImplementation(
    () =>
      new Promise((r) => {
        resolve = r;
      }),
  );
  wrapper = mount(ChangePasswordPanel, { props: { username: "operator" } });
  await fill(
    "old-personal-password1",
    " new-personal-password1 ",
    "different-password",
  );
  expect(
    wrapper.get('button[type="submit"]').attributes("disabled"),
  ).toBeDefined();
  expect(wrapper.get('[role="alert"]').text()).toContain("不一致");
  await wrapper
    .get('[name="confirm-password"]')
    .setValue(" new-personal-password1 ");
  await wrapper.get("form").trigger("submit");
  await wrapper.get("form").trigger("submit");
  expect(request).toHaveBeenCalledTimes(1);
  expect(request).toHaveBeenCalledWith("/me/password", {
    method: "POST",
    body: {
      v: 1,
      current_password: "old-personal-password1",
      new_password: " new-personal-password1 ",
    },
  });
  await wrapper.get("dialog").trigger("cancel");
  expect(wrapper.emitted("close")).toBeUndefined();
  resolve({ v: 1, ok: true });
  await flushPromises();
  expect(wrapper.emitted("changed")).toHaveLength(1);
  for (const input of wrapper.findAll<HTMLInputElement>("input"))
    expect(input.element.value).toBe("");
});
it("wrong current passwords keep the form open without claiming success; uncertain responses require login", async () => {
  const request = vi
    .spyOn(api, "request")
    .mockRejectedValueOnce(new ApiError("CURRENT_PASSWORD_INCORRECT", 400))
    .mockRejectedValueOnce(new ApiError("network timeout", 0));
  wrapper = mount(ChangePasswordPanel, { props: { username: "operator" } });
  await fill();
  await wrapper.get("form").trigger("submit");
  await flushPromises();
  expect(wrapper.get('[role="alert"]').text()).toContain("当前密码不正确");
  expect(wrapper.emitted("changed")).toBeUndefined();
  expect(
    wrapper.get<HTMLInputElement>('[name="current-password"]').element.value,
  ).toBe("");
  await fill();
  await wrapper.get("form").trigger("submit");
  await flushPromises();
  expect(request).toHaveBeenCalledTimes(2);
  expect(wrapper.emitted("unconfirmed")).toHaveLength(1);
});
it("an account without assigned permissions can open the form and returns to login after changing its password", async () => {
  const user = {
    id: "self",
    username: "empty-user",
    role: "business",
    permissions: [],
    role_names: [],
    device_scope: [],
  };
  const request = vi.spyOn(api, "request").mockImplementation(async (path) => {
    if (path === "/login") return { access_token: "token", user };
    if (path === "/me") return user;
    if (path === "/me/password") return { v: 1, ok: true };
    throw Error("unexpected " + path);
  });
  wrapper = mount(App);
  await wrapper.get('[name="username"]').setValue("empty-user");
  await wrapper.get('[name="password"]').setValue("old-personal-password1");
  await wrapper.get("form").trigger("submit");
  await flushPromises();
  expect(wrapper.text()).toContain("尚未分配操作权限");
  await wrapper.get(".account-password").trigger("click");
  await fill();
  await wrapper.get("dialog form").trigger("submit");
  await flushPromises();
  expect(wrapper.find("dialog").exists()).toBe(false);
  expect(wrapper.get('[role="status"]').text()).toContain("密码修改成功");
  expect(readTabSession()).toBeNull();
  expect(wrapper.get<HTMLInputElement>('[name="password"]').element.value).toBe(
    "",
  );
  expect(request.mock.calls.filter(([p]) => p === "/me/password")).toHaveLength(
    1,
  );
});

it("accepts eight-character mixed passwords and rejects missing letters, missing digits and short values", async () => {
  vi.spyOn(api, "request").mockResolvedValue({ v: 1, ok: true });
  wrapper = mount(ChangePasswordPanel, { props: { username: "operator" } });
  expect(wrapper.text()).toContain("至少 8 个字符");
  for (const value of ["abc1234", "abcdefgh", "12345678", "abcdefgh!"]) {
    await fill("legacy-password", value);
    expect(
      wrapper.get('button[type="submit"]').attributes("disabled"),
    ).toBeDefined();
  }
  for (const value of ["abcd1234", "ABCDEFG1", "a123456!"]) {
    await fill("legacy-password", value);
    expect(
      wrapper.get('button[type="submit"]').attributes("disabled"),
    ).toBeUndefined();
    expect(
      wrapper.get<HTMLInputElement>('[name="new-password"]').element.validity
        .patternMismatch,
    ).toBe(false);
  }
});

it("requires first-login password changes before loading business UI, including after reload", async () => {
  let required = true;
  const user = () => ({
    id: "first",
    username: "new-user",
    role: "admin",
    device_scope: "*",
    must_change_password: required,
  });
  const request = vi.spyOn(api, "request").mockImplementation(async (path) => {
    if (path === "/login")
      return { access_token: "first-login-token", user: user() };
    if (path === "/me") return user();
    if (path === "/me/password") {
      required = false;
      return { v: 1, ok: true };
    }
    if (path.startsWith("/devices")) return { devices: [] };
    if (path.startsWith("/tasks")) return { tasks: [] };
    if (path.startsWith("/device-groups")) return { device_groups: [] };
    throw Error("unexpected " + path);
  });
  wrapper = mount(App);
  await wrapper.get('[name="username"]').setValue("new-user");
  await wrapper.get('[name="password"]').setValue("Initial123");
  await wrapper.get("form").trigger("submit");
  await flushPromises();
  expect(wrapper.get("dialog h2").text()).toContain("首次登录");
  expect(wrapper.find("nav").exists()).toBe(false);
  expect(request.mock.calls.map(([p]) => p)).toEqual(["/login", "/me"]);
  expect(wrapper.find('[aria-label="关闭修改密码"]').exists()).toBe(false);
  await wrapper.get("dialog").trigger("cancel");
  expect(wrapper.find("dialog").exists()).toBe(true);
  wrapper.unmount();
  request.mockClear();
  wrapper = mount(App);
  await flushPromises();
  expect(wrapper.get("dialog h2").text()).toContain("首次登录");
  expect(request.mock.calls.map(([p]) => p)).toEqual(["/me"]);
  await fill("Initial123", "Personal456");
  await wrapper.get("dialog form").trigger("submit");
  await flushPromises();
  expect(readTabSession()).toBeNull();
  expect(wrapper.get('[role="status"]').text()).toContain("密码修改成功");
  await wrapper.get('[name="username"]').setValue("new-user");
  await wrapper.get('[name="password"]').setValue("Personal456");
  await wrapper.get("form").trigger("submit");
  await flushPromises();
  expect(wrapper.find("dialog").exists()).toBe(false);
  expect(wrapper.find("nav").exists()).toBe(true);
  expect(request.mock.calls.some(([p]) => p.startsWith("/devices"))).toBe(true);
});

it("allows a restricted user to log out, retaining the gate when logout fails", async () => {
  const user = {
    id: "first",
    username: "new-user",
    role: "business",
    device_scope: [],
    must_change_password: true,
  };
  let offline = true;
  vi.spyOn(api, "request").mockImplementation(async (path) => {
    if (path === "/login") return { access_token: "first-login-token", user };
    if (path === "/me") return user;
    if (path === "/logout") {
      if (offline) throw new ApiError("offline");
      return { v: 1, ok: true };
    }
    throw Error("unexpected " + path);
  });
  wrapper = mount(App);
  await wrapper.get('[name="username"]').setValue("new-user");
  await wrapper.get('[name="password"]').setValue("Initial123");
  await wrapper.get("form").trigger("submit");
  await flushPromises();
  const logout = () =>
    wrapper!.findAll("button").find((b) => b.text() === "退出登录")!;
  await logout().trigger("click");
  await flushPromises();
  expect(wrapper.get("dialog [role=alert]").text()).toContain(
    "未能确认服务端注销",
  );
  expect(readTabSession()).not.toBeNull();
  offline = false;
  await logout().trigger("click");
  await flushPromises();
  expect(wrapper.find("dialog").exists()).toBe(false);
  expect(readTabSession()).toBeNull();
});
