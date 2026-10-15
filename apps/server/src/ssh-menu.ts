import type { ServerChannel } from "ssh2";
import { RateLimiter } from "./util.js";

export const SSH_MENU_PAGE_SIZE = 25;
export interface SshDevicePage {
  devices: {
    id: string;
    name: string;
    status: "online" | "offline" | "unsupported";
  }[];
  hasMore: boolean;
}
// Device names are untrusted terminal text: remove controls, escape sequences,
// bidi overrides and line separators before displaying them outside a PTY.
const label = (value: string) =>
  value.replace(/[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/gu, "?");
export function createDeviceMenu(
  channel: ServerChannel,
  actions: {
    list(page: number): SshDevicePage;
    select(id: string): string | undefined;
    close(code: number): void;
  },
) {
  let active = true,
    page = 0,
    line = "",
    escape = 0,
    afterCR = false;
  let snapshot: SshDevicePage = { devices: [], hasMore: false };
  const rate = new RateLimiter();
  const prompt = "\r\n输入设备编号（r 刷新 / n 下一页 / p 上一页 / q 退出）：";
  function close(code: number) {
    active = false;
    actions.close(code);
  }
  function write(text: string) {
    if (!active) return;
    if (channel.writableLength > 65536) {
      close(1);
      return;
    }
    channel.write(text);
  }
  function show() {
    snapshot = actions.list(page);
    if (!snapshot.devices.length && page > 0) {
      page = 0;
      snapshot = actions.list(page);
    }
    write(
      `\r\n可访问设备 · 第 ${page + 1} 页\r\n` +
        (snapshot.devices.length
          ? snapshot.devices
              .map(
                (d, index) =>
                  `  ${index + 1}. ${label(d.name)} [${{ online: "在线", offline: "离线", unsupported: "不支持终端" }[d.status]}]  ${label(d.id)}\r\n`,
              )
              .join("")
          : "  暂无可访问设备，请联系管理员授权；可按 r 刷新。\r\n") +
        prompt,
    );
  }
  function submit() {
    rate.check("commands", 120);
    const value = line.trim().toLowerCase();
    line = "";
    write("\r\n");
    if (!active) return;
    if (value === "q") {
      close(0);
      return;
    }
    if (value === "r" || value === "n" || value === "p") {
      if (value === "r") page = 0;
      if (value === "n" && snapshot.hasMore) page++;
      if (value === "p" && page > 0) page--;
      show();
      return;
    }
    const selected = /^[1-9][0-9]?$/.test(value)
      ? snapshot.devices[Number(value) - 1]
      : undefined;
    if (!selected) {
      write("编号无效，请输入当前页显示的设备编号。" + prompt);
      return;
    }
    // Use the displayed immutable ID, never reinterpret the number in a new list.
    const error = actions.select(selected.id);
    if (error) {
      write(error + "\r\n");
      show();
    } else active = false;
  }
  function guarded(fn: () => void) {
    try {
      fn();
    } catch {
      write("\r\n设备列表暂不可用或登录权限已失效，请重新连接。\r\n");
      close(1);
    }
  }
  return {
    start() {
      guarded(show);
    },
    input(data: Buffer) {
      guarded(() => {
        rate.check("input", 1200);
        if (data.length > 4096) {
          close(1);
          return;
        }
        for (const byte of data) {
          if (!active) break;
          if (byte === 3 || byte === 4) {
            write("\r\n已退出设备选择。\r\n");
            close(0);
            break;
          }
          // Consume CSI/SS3 keys so arrow/function-key digits never select a device.
          if (escape) {
            if (escape === 1) escape = byte === 91 || byte === 79 ? 2 : 0;
            else if (byte >= 0x40 && byte <= 0x7e) escape = 0;
            continue;
          }
          if (byte === 27) {
            escape = 1;
            continue;
          }
          if (byte === 10 && afterCR) {
            afterCR = false;
            continue;
          }
          afterCR = byte === 13;
          if (byte === 13 || byte === 10) {
            submit();
            continue;
          }
          if (byte === 127 || byte === 8) {
            if (line.length) {
              line = line.slice(0, -1);
              write("\b \b");
            }
          } else if (byte === 21) {
            write("\b \b".repeat(line.length));
            line = "";
          } else if (byte >= 32) {
            if (line.length >= 32) {
              close(1);
              break;
            }
            const char = byte <= 126 ? String.fromCharCode(byte) : "?";
            line += char;
            write(char);
          }
        }
      });
    },
  };
}
