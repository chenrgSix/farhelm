import assert from "node:assert/strict";
import { test } from "node:test";
import { TerminalCreationCooldowns } from "../src/terminal-activity.js";

test("twenty creations in a rolling ten minutes trigger a cooldown for that account", () => {
  const cooldowns = new TerminalCreationCooldowns();
  assert.equal(cooldowns.record("alice", 0), false);
  for (let i = 0; i < 18; i++) {
    assert.equal(cooldowns.record("alice", 1000 + i), false);
    assert.equal(cooldowns.record("bob", 1000 + i), false);
  }
  cooldowns.check("alice", 600_000);
  assert.equal(cooldowns.record("alice", 600_000), false);
  cooldowns.check("alice", 600_001);
  assert.equal(cooldowns.record("alice", 600_001), true);
  assert.throws(() => cooldowns.check("alice", 600_001), {
    statusCode: 429,
    code: "TERMINAL_CREATION_COOLDOWN",
    retryAfterSeconds: 120,
  });
  cooldowns.check("bob", 600_001);
  assert.equal(cooldowns.record("bob", 600_001), false);
});

test("cooldown reports remaining time and starts a new count after two minutes", () => {
  const cooldowns = new TerminalCreationCooldowns();
  const triggeredAt = 1000;
  for (let i = 1; i <= 20; i++) {
    cooldowns.check("alice", triggeredAt);
    assert.equal(cooldowns.record("alice", triggeredAt), i === 20);
  }
  cooldowns.prune(triggeredAt + 60_000);
  assert.throws(() => cooldowns.check("alice", triggeredAt + 60_000), {
    retryAfterSeconds: 60,
  });
  assert.throws(() => cooldowns.check("alice", triggeredAt + 119_999), {
    retryAfterSeconds: 1,
  });
  const resumedAt = triggeredAt + 120_000;
  cooldowns.check("alice", resumedAt);
  for (let i = 1; i <= 20; i++) {
    cooldowns.check("alice", resumedAt);
    assert.equal(cooldowns.record("alice", resumedAt), i === 20);
  }
  cooldowns.prune(resumedAt + 120_000);
  cooldowns.check("alice", resumedAt + 120_000);
});
