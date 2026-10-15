import { describe, expect, it } from "vitest";
import {
  canExecute,
  CommandAttempt,
  outputPreview,
  parseCommand,
} from "../src/model";
import type { User } from "../src/api/types";
const input = {
  device_id: "device-1",
  argv: '["/usr/bin/printf","%s","$(touch /tmp/nope) | cat"]',
  cwd: "/tmp",
  timeout_ms: 1000,
  max_output_bytes: 1024,
  ttl_seconds: 300,
};
describe("command contract and authorization", () => {
  it("preserves exact argv without shell interpolation", () => {
    expect(parseCommand(input).argv).toEqual([
      "/usr/bin/printf",
      "%s",
      "$(touch /tmp/nope) | cat",
    ]);
    expect(parseCommand(input).v).toBe(1);
  });
  it.each([
    '"ls -al"',
    "{}",
    "[]",
    "[1]",
    '["ls",null]',
    '["ls","\\u0000"]',
    '["./run"]',
    '["printf","\\ud800"]',
    '[""]',
  ])("rejects invalid argv %s", (argv) =>
    expect(() => parseCommand({ ...input, argv })).toThrow(),
  );
  it("enforces cwd, time, byte limits, and safe integers", () => {
    for (const delta of [
      { cwd: "relative" },
      { timeout_ms: 99 },
      { timeout_ms: 3_600_001 },
      { ttl_seconds: 0 },
      { ttl_seconds: 1.1 },
      { max_output_bytes: -1 },
      { max_output_bytes: 1_048_577 },
    ])
      expect(() => parseCommand({ ...input, ...delta })).toThrow();
    expect(
      parseCommand({ ...input, max_output_bytes: 0 }).max_output_bytes,
    ).toBe(0);
    expect(() =>
      parseCommand({
        ...input,
        argv: JSON.stringify(["printf", "界".repeat(8192), "界".repeat(8192)]),
      }),
    ).toThrow();
  });
  it("does not authorize business/auditor or out-of-scope ops", () => {
    const user: User = {
      id: "u",
      username: "operator",
      role: "ops",
      device_scope: ["device-1"],
    };
    expect(canExecute(user, "device-1")).toBe(true);
    expect(canExecute(user, "device-2")).toBe(false);
    expect(canExecute({ ...user, role: "business", device_scope: "*" })).toBe(
      false,
    );
    expect(canExecute({ ...user, role: "auditor", device_scope: "*" })).toBe(
      false,
    );
    expect(canExecute({ ...user, role: "admin" }, "device-2")).toBe(true);
  });
  it("snapshots exact immutable request and retains retry key", () => {
    const request = parseCommand(input);
    const attempt = new CommandAttempt(request, "stable-key");
    request.argv[0] = "other";
    request.cwd = "/elsewhere";
    expect(attempt.request.argv[0]).toBe("/usr/bin/printf");
    expect(attempt.request.cwd).toBe("/tmp");
    expect(() => attempt.request.argv.push("new")).toThrow();
    attempt.state = "uncertain";
    expect(attempt.key).toBe("stable-key");
  });
});
describe("untrusted output preview", () => {
  it("escapes ANSI and bidi controls without interpreting HTML", () => {
    const bytes = new TextEncoder().encode(
      "<img src=x onerror=alert(1)>\x1b[31m\u202ehello\n",
    );
    expect(outputPreview(bytes).text).toBe(
      "<img src=x onerror=alert(1)>\\u001b[31m\\u202ehello\n",
    );
  });
  it("bounds preview while distinguishing raw bytes", () => {
    const bytes = new Uint8Array(70_000).fill(65);
    expect(outputPreview(bytes).truncated).toBe(true);
    expect(outputPreview(bytes).text.length).toBe(65_536);
    expect(bytes.byteLength).toBe(70_000);
  });
  it("tolerates binary output and invalid UTF-8", () =>
    expect(outputPreview(new Uint8Array([255, 0, 10])).text).toBe(
      "�\\u0000\n",
    ));
});
