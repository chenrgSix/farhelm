import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setImmediate as immediate } from "node:timers/promises";
import {
  passwordHash,
  passwordVerify,
  passwordHashAsync,
  passwordVerifyAsync,
  hash,
} from "../src/util.js";
import { readVerifiedFile } from "../src/verified-file.js";

test("async password work stays interoperable, yields to I/O and bounds queued requests", async () => {
  const old = passwordHash("existing-password1");
  assert.equal(await passwordVerifyAsync("existing-password1", old), true);
  assert.equal(await passwordVerifyAsync("incorrect", old), false);
  const encoded = await passwordHashAsync("new-password1");
  assert.equal(passwordVerify("new-password1", encoded), true);
  let complete = false;
  const pending = Array.from({ length: 18 }, () =>
    passwordHashAsync("bounded-password1"),
  );
  const completion = Promise.all(pending).then(() => {
    complete = true;
  });
  await assert.rejects(passwordHashAsync("over-capacity1"), {
    code: "PASSWORD_AUTH_BUSY",
  });
  await immediate();
  assert.equal(complete, false, "password work must let the event loop run");
  await completion;
  assert.ok(await passwordHashAsync("capacity-recovered1"));
});

test("asynchronous package snapshots reject truncation/corruption and remain immutable after replacement", async () => {
  const root = await mkdtemp(join(tmpdir(), "farhelm-verified-file-"));
  try {
    const path = join(root, "package"),
      bytes = Buffer.alloc(2 * 1024 * 1024, 42);
    await writeFile(path, bytes);
    const snapshot = await readVerifiedFile(path, bytes.length, hash(bytes));
    assert.deepEqual(snapshot, bytes);
    await writeFile(path, Buffer.alloc(bytes.length, 43));
    assert.deepEqual(snapshot, bytes);
    await assert.rejects(readVerifiedFile(path, bytes.length, hash(bytes)), {
      code: "AGENT_PACKAGE_CHANGED",
    });
    await writeFile(path, bytes.subarray(0, 100));
    await assert.rejects(readVerifiedFile(path, bytes.length, hash(bytes)), {
      code: "AGENT_PACKAGE_CHANGED",
    });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
