import assert from "node:assert/strict";
import { test } from "node:test";
import { TerminalActivityWarnings } from "../src/terminal-activity.js";

test("terminal activity uses a rolling minute and independent account and operation counts", (t) => {
  const warnings = new TerminalActivityWarnings();
  const send = t.mock.fn(() => true);
  warnings.record("alice", "open", 0);
  for (const now of [55_000, 57_000, 59_000, 60_000]) {
    warnings.record("alice", "open", now);
    warnings.record("alice", "close", now);
    warnings.record("bob", "open", now);
  }
  warnings.deliver("alice", send, 60_000);
  warnings.deliver("bob", send, 60_000);
  assert.equal(send.mock.callCount(), 0);

  warnings.record("alice", "open", 61_000);
  warnings.deliver("alice", send, 61_000);
  assert.equal(send.mock.callCount(), 1);
  warnings.record("alice", "close", 62_000);
  warnings.deliver("alice", send, 62_000);
  warnings.deliver("bob", send, 62_000);
  assert.equal(send.mock.callCount(), 1);

  for (const now of [115_000, 117_000, 119_000, 120_000, 121_000])
    warnings.record("alice", "close", now);
  warnings.deliver("alice", send, 121_000);
  assert.equal(send.mock.callCount(), 2);
});

test("a warning stays pending after a failed delivery and expires after five minutes", (t) => {
  const warnings = new TerminalActivityWarnings();
  const send = t.mock.fn(() => true);
  for (const now of [1, 2, 3, 4, 5]) {
    warnings.record("alice", "close", now);
    warnings.record("bob", "close", now);
  }
  const disconnected = t.mock.fn(() => false);
  warnings.deliver("alice", disconnected, 5);
  assert.equal(disconnected.mock.callCount(), 1);
  warnings.prune(120_000);
  warnings.deliver("alice", send, 120_000);
  warnings.deliver("alice", send, 120_001);
  assert.equal(send.mock.callCount(), 1);

  warnings.prune(300_005);
  warnings.deliver("bob", send, 300_005);
  assert.equal(send.mock.callCount(), 1);
});
