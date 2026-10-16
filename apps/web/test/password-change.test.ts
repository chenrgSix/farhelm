import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { flushPromises, mount, type VueWrapper } from "@vue/test-utils";
import ChangePasswordPanel from "../src/components/ChangePasswordPanel.vue";
import App from "../src/App.vue";
import { api, ApiError } from "../src/api/client";
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
  wrapper?.unmount();
  wrapper = undefined;
  vi.restoreAllMocks();
  api.setToken(null);
});
async function fill(
  current = "old-personal-password",
  next = "new-personal-password",
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
    "old-personal-password",
    " new-personal-password ",
    "different-password",
  );
  expect(
    wrapper.get('button[type="submit"]').attributes("disabled"),
  ).toBeDefined();
  expect(wrapper.get('[role="alert"]').text()).toContain("不一致");
  await wrapper
    .get('[name="confirm-password"]')
    .setValue(" new-personal-password ");
  await wrapper.get("form").trigger("submit");
  await wrapper.get("form").trigger("submit");
  expect(request).toHaveBeenCalledTimes(1);
  expect(request).toHaveBeenCalledWith("/me/password", {
    method: "POST",
    body: {
      v: 1,
      current_password: "old-personal-password",
      new_password: " new-personal-password ",
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
  await wrapper.get('[name="password"]').setValue("old-personal-password");
  await wrapper.get("form").trigger("submit");
  await flushPromises();
  expect(wrapper.text()).toContain("尚未分配操作权限");
  await wrapper.get(".account-password").trigger("click");
  await fill();
  await wrapper.get("dialog form").trigger("submit");
  await flushPromises();
  expect(wrapper.find("dialog").exists()).toBe(false);
  expect(wrapper.get('[role="status"]').text()).toContain("密码修改成功");
  expect(wrapper.get<HTMLInputElement>('[name="password"]').element.value).toBe(
    "",
  );
  expect(request.mock.calls.filter(([p]) => p === "/me/password")).toHaveLength(
    1,
  );
});
