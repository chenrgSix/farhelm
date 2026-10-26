import { test } from "node:test";
import assert from "node:assert/strict";
import { CommandStream, commandText } from "../src/terminal-commands.js";
const id = "11111111-2222-4333-8444-555555555555";
const marker = (s: string) => `\x1b]777;farhelm;${id};${s}\x07`;
test("shell metadata is framed across every byte boundary without changing terminal output", () => {
  const raw = Buffer.from(
    "中文前" +
      marker("R;bash") +
      marker("C;" + Buffer.from("echo 多行\n命令").toString("base64")) +
      "out\r\n" +
      marker("E;7") +
      "尾部",
  );
  for (let split = 0; split <= raw.length; split++) {
    const stream = new CommandStream(id);
    const events = [
      ...stream.push(raw.subarray(0, split)),
      ...stream.push(raw.subarray(split)),
    ];
    assert.equal(
      Buffer.concat(
        events.filter((e) => e.kind === "output").map((e) => e.data),
      ).toString(),
      "中文前out\r\n尾部",
    );
    assert.deepEqual(
      events.filter((e) => e.kind !== "output"),
      [
        { kind: "ready", shell: "bash" },
        { kind: "command", command: "echo 多行\n命令", redacted: false },
        { kind: "end", code: 7 },
      ],
    );
  }
  const stream = new CommandStream(id);
  assert.throws(
    () =>
      stream.push(Buffer.from(marker("C;" + "A".repeat(40000)).slice(0, -1))),
    /limit/,
  );
});
test("password arguments, credentials, heredocs and oversized lines are never indexed", () => {
  for (const line of [
    "curl -u user:hidden-value https://example.test",
    "curl -uuser:hidden-value https://example.test",
    "openssl -passin pass:hidden-value",
    "docker login -p hidden-value",
    "redis-cli -a hidden-value",
    "mysql -phidden-value",
    "TOKEN=hidden-value command",
    "sshpass -p hidden-value ssh host",
    "curl https://user:hidden-value@example.test",
    "cat << EOF\nhidden-value\nEOF",
    "echo " + "x".repeat(8193),
  ]) {
    const redacted = commandText(line);
    assert.equal(redacted.redacted, true);
    assert.ok(!redacted.command.includes("hidden-value"));
  }
  assert.deepEqual(commandText("docker ps --all"), {
    command: "docker ps --all",
    redacted: false,
  });
  assert.equal(commandText("docker run -p 80:80 nginx").redacted, false);
  assert.equal(
    new CommandStream(id).push(Buffer.from(marker("C;@@badbase64@@"))).length,
    0,
  );
});
