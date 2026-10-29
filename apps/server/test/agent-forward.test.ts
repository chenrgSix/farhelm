import { test } from "node:test";
import assert from "node:assert/strict";
import { once } from "node:events";
import { AgentForward } from "../src/agent-forward.js";
async function fixture() {
  const frames: { type: string; body: Record<string, unknown> }[] = [];
  const stream = new AgentForward("id", (type, body) => {
    frames.push({ type, body });
    return true;
  });
  stream.receive("tcp.opened", { forward_id: "id" });
  await stream.ready;
  return { stream, frames };
}
test("Agent TCP writer waits for each acknowledgement and sends EOF after the final write", async () => {
  const { stream, frames } = await fixture();
  try {
    let finished = false;
    stream.end(Buffer.alloc(20000, 17), () => (finished = true));
    assert.equal(frames.length, 1);
    for (let seq = 1; seq <= 3; seq++) {
      assert.equal(frames[seq - 1]!.type, "tcp.data");
      assert.equal(frames[seq - 1]!.body.seq, seq);
      stream.receive("tcp.ack", { forward_id: "id", seq });
    }
    await new Promise((r) => setImmediate(r));
    assert.ok(finished);
    assert.equal(frames[3]!.type, "tcp.end");
  } finally {
    stream.destroy();
  }
});
test("Agent TCP reader withholds acknowledgements at its buffer limit", async () => {
  const { stream, frames } = await fixture();
  try {
    for (let seq = 1; seq <= 2; seq++)
      stream.receive("tcp.data", {
        forward_id: "id",
        seq,
        data: Buffer.alloc(8192).toString("base64"),
      });
    assert.equal(frames.filter((f) => f.type === "tcp.ack").length, 1);
    assert.equal(stream.readableLength, 16384);
    stream.read(8192);
    await new Promise((r) => setImmediate(r));
    assert.equal(frames.filter((f) => f.type === "tcp.ack").length, 2);
  } finally {
    stream.destroy();
  }
});
test("Agent TCP rejects duplicate sequences and invalid data without affecting other streams", async () => {
  for (const body of [
    { seq: 2, data: "AA==" },
    { seq: 1, data: "???" },
    { seq: 1, data: Buffer.alloc(8193).toString("base64") },
  ]) {
    const { stream, frames } = await fixture();
    const failed = once(stream, "error");
    stream.receive("tcp.data", { forward_id: "id", ...body });
    await failed;
    assert.ok(stream.destroyed);
    assert.equal(frames.at(-1)!.type, "tcp.close");
  }
});
