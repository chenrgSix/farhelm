import { afterEach, expect, it } from "vitest";
import { flushPromises, mount, type VueWrapper } from "@vue/test-utils";
import DeviceActions from "../src/components/DeviceActions.vue";
import type { Device, User } from "../src/api/types";
const device: Device = {
  id: "one",
  name: "生产设备",
  connection_kind: "agent",
  control_online: true,
  private_data_reachable: null,
  business_healthy: null,
  last_seen: null,
  revoked_at: null,
  agent_version: "0.2.3",
};
const user: User = {
  id: "admin",
  username: "admin",
  role: "admin",
  device_scope: "*",
};
let wrapper: VueWrapper;
afterEach(() => {
  wrapper?.unmount();
});
function setup(overrides = {}) {
  wrapper = mount(DeviceActions, {
    attachTo: document.body,
    props: {
      device,
      user,
      ready: true,
      busy: {},
      revoking: false,
      ...overrides,
    },
  });
}
async function open() {
  await wrapper.get('[aria-haspopup="menu"]').trigger("click");
  await flushPromises();
  return document.querySelector<HTMLElement>('[role="menu"]')!;
}
it("keeps secondary operations in a menu and restores focus after selecting", async () => {
  setup();
  expect(wrapper.findAll("button").map((b) => b.text())).toEqual([
    "连接终端",
    "更多",
  ]);
  const menu = await open();
  expect(menu).not.toBeNull();
  expect(menu.textContent).not.toMatch(/高级账号|选择已有账号/);
  expect(document.activeElement?.textContent).toBe("接入配置");
  const exec = [...menu.querySelectorAll<HTMLButtonElement>("button")].find(
    (b) => b.textContent === "命令任务",
  )!;
  exec.click();
  await flushPromises();
  expect(wrapper.emitted("action")).toEqual([["exec"]]);
  expect(document.querySelector('[role="menu"]')).toBeNull();
  expect(document.activeElement).toBe(
    wrapper.get('[aria-haspopup="menu"]').element,
  );
});
it("supports arrows and Escape while skipping disabled actions", async () => {
  setup({ busy: { network: true } });
  const menu = await open();
  document.dispatchEvent(new Event("scroll"));
  window.dispatchEvent(new Event("resize"));
  await flushPromises();
  expect(
    wrapper.get('[aria-haspopup="menu"]').attributes("aria-expanded"),
  ).toBe("true");
  document.activeElement!.dispatchEvent(
    new KeyboardEvent("keydown", { key: "ArrowDown", bubbles: true }),
  );
  expect(document.activeElement?.textContent).toBe("健康检查");
  menu.dispatchEvent(
    new KeyboardEvent("keydown", { key: "ArrowDown", bubbles: true }),
  );
  expect(document.activeElement?.textContent).toBe("SSH 连接");
  menu.dispatchEvent(
    new KeyboardEvent("keydown", { key: "Escape", bubbles: true }),
  );
  await flushPromises();
  expect(
    wrapper.get('[aria-haspopup="menu"]').attributes("aria-expanded"),
  ).toBe("false");
  expect(document.activeElement).toBe(
    wrapper.get('[aria-haspopup="menu"]').element,
  );
});
it("preserves permission and stale-data restrictions", async () => {
  setup({
    user: { ...user, role: "business", permissions: ["devices.read"] },
    ready: false,
  });
  const menu = await open();
  expect(menu.textContent).not.toMatch(
    /接入配置|命令任务|撤销访问权限|SSH 连接/,
  );
  expect(wrapper.text()).not.toContain("连接终端");
  expect([...menu.querySelectorAll("button")].every((b) => b.disabled)).toBe(
    true,
  );
});

it("keeps one ordinary connection action with or without sudo permission", async () => {
  setup({ user: { ...user, role: "ops", permissions: ["terminal.connect"] } });
  expect(wrapper.text()).not.toContain("以 root 连接");
  await wrapper.setProps({
    user: {
      ...user,
      role: "ops",
      permissions: ["terminal.connect", "terminal.sudo"],
    },
  });
  expect(wrapper.text()).not.toContain("以 root 连接");
  await wrapper
    .findAll("button")
    .find((b) => b.text() === "连接终端")!
    .trigger("click");
  expect(wrapper.emitted("action")).toEqual([["terminal"]]);
});
