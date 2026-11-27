import { ApiError } from "./util.js";

const WINDOW_MS = 10 * 60_000;
const CREATION_LIMIT = 20;
const COOLDOWN_MS = 2 * 60_000;
const cooldownNotice = "禁止频繁创建和关闭连接会话。";

export const terminalActivityWarning = {
  message: `${cooldownNotice}该账号暂停新建终端 2 分钟。`,
};

export class TerminalCreationCooldownError extends ApiError {
  constructor(readonly retryAfterSeconds: number) {
    super(
      429,
      "TERMINAL_CREATION_COOLDOWN",
      `${cooldownNotice}请在 ${retryAfterSeconds} 秒后重试。`,
    );
  }
}

interface UserActivity {
  creations: number[];
  blockedUntil: number;
}

export class TerminalCreationCooldowns {
  private readonly users = new Map<string, UserActivity>();

  check(actorId: string, now: number) {
    const blockedUntil = this.users.get(actorId)?.blockedUntil ?? 0;
    if (blockedUntil > now)
      throw new TerminalCreationCooldownError(
        Math.ceil((blockedUntil - now) / 1000),
      );
  }

  // Called after a successful admission in the same synchronous path as check.
  record(actorId: string, now: number) {
    const creations = (this.users.get(actorId)?.creations ?? []).filter(
      (time) => time > now - WINDOW_MS,
    );
    creations.push(now);
    const reachedLimit = creations.length === CREATION_LIMIT;
    this.users.set(actorId, {
      creations: reachedLimit ? [] : creations,
      blockedUntil: reachedLimit ? now + COOLDOWN_MS : 0,
    });
    return reachedLimit;
  }

  prune(now = Date.now()) {
    for (const [actorId, { creations, blockedUntil }] of this.users) {
      if (
        blockedUntil <= now &&
        (creations.at(-1) ?? -Infinity) <= now - WINDOW_MS
      )
        this.users.delete(actorId);
    }
  }
}
