const WINDOW_MS = 60_000;
const WARNING_THRESHOLD = 5;
const PENDING_WARNING_MS = 5 * WINDOW_MS;

export const terminalActivityWarning = {
  message:
    "你的账号在 1 分钟内频繁打开、关闭或断开终端。请检查网络连接和客户端的自动重连设置。",
};

interface UserActivity {
  open: number[];
  close: number[];
  lastActivityAt: number;
  lastDeliveredAt: number;
  pendingUntil: number;
}

export class TerminalActivityWarnings {
  private readonly users = new Map<string, UserActivity>();

  record(actorId: string, kind: "open" | "close", now = Date.now()) {
    const activity = this.users.get(actorId) ?? {
      open: [],
      close: [],
      lastActivityAt: now,
      lastDeliveredAt: Number.NEGATIVE_INFINITY,
      pendingUntil: 0,
    };
    const times = activity[kind].filter((time) => time > now - WINDOW_MS);
    times.push(now);
    activity[kind] = times.slice(-WARNING_THRESHOLD);
    activity.lastActivityAt = now;
    if (
      times.length >= WARNING_THRESHOLD &&
      now - activity.lastDeliveredAt >= WINDOW_MS
    )
      activity.pendingUntil = now + PENDING_WARNING_MS;
    this.users.set(actorId, activity);
  }

  deliver(actorId: string, send: () => boolean, now = Date.now()) {
    const activity = this.users.get(actorId);
    if (!activity || activity.pendingUntil <= now || !send()) return;
    activity.lastDeliveredAt = now;
    activity.pendingUntil = 0;
  }

  prune(now = Date.now()) {
    for (const [actorId, activity] of this.users) {
      if (
        activity.pendingUntil <= now &&
        Math.max(activity.lastActivityAt, activity.lastDeliveredAt) <=
          now - WINDOW_MS
      )
        this.users.delete(actorId);
    }
  }
}
