import { afterEach, expect, it, vi } from "vitest";
import { flushPromises, mount } from "@vue/test-utils";
import TerminalPanel from "../src/components/TerminalPanel.vue";
import { api } from "../src/api/client";
const mocks = vi.hoisted(() => ({
  term: undefined as any,
  ws: undefined as any,
}));
vi.mock("@xterm/xterm", () => ({
  Terminal: class {
    options: any;
    cols = 80;
    rows = 24;
    data: any;
    parser = { registerOscHandler() {} };
    constructor(options: any) {
      this.options = options;
      mocks.term = this;
    }
    loadAddon() {}
    open() {}
    reset() {}
    focus() {}
    dispose() {}
    onData(fn: any) {
      this.data = fn;
    }
    onBinary() {}
    onResize() {}
    write(_data: any, done: any) {
      done?.();
    }
  },
}));
vi.mock("@xterm/addon-fit", () => ({
  FitAddon: class {
    fit() {}
  },
}));
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});
async function mountTerminal() {
  vi.stubGlobal(
    "ResizeObserver",
    class {
      observe() {}
      disconnect() {}
    },
  );
  vi.stubGlobal(
    "WebSocket",
    class {
      static OPEN = 1;
      readyState = 1;
      bufferedAmount = 0;
      onopen: any;
      onmessage: any;
      onclose: any;
      send = vi.fn();
      close = vi.fn();
      constructor() {
        mocks.ws = this;
      }
    },
  );
  vi.spyOn(api, "request").mockResolvedValue({
    session_id: "session",
    ticket: "ticket",
  });
  const wrapper = mount(TerminalPanel, {
    props: { deviceId: "device", deviceName: "test" },
  });
  await flushPromises();
  const ws = mocks.ws;
  const receive = async (type: string, body = {}) => {
    ws.onmessage({ data: JSON.stringify({ v: 1, type, body }) });
    await flushPromises();
  };
  ws.onopen();
  return { wrapper, ws, receive };
}

it("shows a frequency warning before the terminal opens and keeps it visible after disconnect", async () => {
  const { wrapper, ws, receive } = await mountTerminal();
  try {
    const status = wrapper.get('[role="status"]');
    expect(status.text()).toBe("");
    const message = "你的账号在 1 分钟内频繁打开、关闭或断开终端。";
    await receive("terminal.activity_warning", { message });
    expect(status.text()).toBe(message);
    expect(ws.close).not.toHaveBeenCalled();
    await receive("terminal.ready", { backend: "agent" });
    expect(mocks.term.options.disableStdin).toBe(false);
    await receive("terminal.closed", {
      reason: "SSH_DISCONNECTED",
      audit_complete: false,
    });
    ws.onclose();
    await flushPromises();
    expect(status.text()).toBe(message);
    expect(wrapper.text()).toContain("连接已断开");
  } finally {
    wrapper.unmount();
  }
});

it("preserves the existing socket while reconnecting, blocks input and restores it only after resume", async () => {
  const { wrapper, ws, receive } = await mountTerminal();
  await receive("terminal.ready", { backend: "agent" });
  mocks.term.data("first");
  expect(ws.send).toHaveBeenCalled();
  ws.send.mockClear();
  await receive("terminal.reconnecting", { retry_until: Date.now() + 60000 });
  expect(wrapper.text()).toContain("正在自动重连");
  expect(wrapper.findAll("button").some((b) => b.text() === "重新连接")).toBe(
    false,
  );
  expect(mocks.term.options.disableStdin).toBe(true);
  mocks.term.data("discard");
  expect(ws.send).not.toHaveBeenCalled();
  expect(ws.close).not.toHaveBeenCalled();
  await receive("terminal.resumed");
  expect(mocks.ws).toBe(ws);
  expect(mocks.term.options.disableStdin).toBe(false);
  expect(wrapper.text()).toContain("已恢复原终端连接");
  ws.send.mockClear();
  mocks.term.data("next");
  expect(ws.send).toHaveBeenCalledOnce();
  await receive("terminal.reconnecting");
  ws.onclose();
  await flushPromises();
  expect(wrapper.text()).toContain("连接已断开");
  expect(wrapper.findAll("button").some((b) => b.text() === "重新连接")).toBe(
    true,
  );
  expect(mocks.term.options.disableStdin).toBe(true);
  wrapper.unmount();
});
