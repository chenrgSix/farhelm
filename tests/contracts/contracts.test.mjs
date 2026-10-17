import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
  createHash,
  createPrivateKey,
  createPublicKey,
  sign,
  verify,
} from "node:crypto";
import test from "node:test";
import {
  schemaFiles,
  getValidator,
  validate,
  assertValid,
} from "./validate.mjs";

const root = new URL("../../contracts/v1/", import.meta.url);
const read = (name) => JSON.parse(readFileSync(new URL(name, root), "utf8"));
const base = "https://fleet.local/contracts/v1/";
const fixtures = read("fixtures/manifest.json");

for (const fixture of fixtures) {
  test(`${fixture.valid ? "accept" : "reject"} ${fixture.path}`, () => {
    const data = read("fixtures/" + fixture.path);
    const before = structuredClone(data);
    const validate = getValidator(base + fixture.schema);
    assert.equal(
      validate(data),
      fixture.valid,
      `${fixture.reason ?? ""}\n${JSON.stringify(validate.errors, null, 2)}`,
    );
    assert.deepEqual(
      data,
      before,
      "Validation must not strip fields, coerce types or insert defaults",
    );
  });
}

test("every public schema has at least one positive fixture", () => {
  for (const schema of schemaFiles.filter((x) => x !== "common.schema.json")) {
    assert.ok(
      fixtures.some((x) => x.schema === schema && x.valid),
      `No positive fixture for ${schema}`,
    );
  }
});

test("all concrete object declarations are closed", () => {
  function check(node, path) {
    if (!node || typeof node !== "object") return;
    if (node.type === "object")
      assert.equal(
        node.additionalProperties,
        false,
        `${path} must reject unknown fields`,
      );
    for (const [key, value] of Object.entries(node))
      check(value, path + "/" + key);
  }
  for (const name of schemaFiles) check(read(name), name);
});

test("unknown fields are rejected recursively in every positive fixture", () => {
  let checked = 0;
  function paths(node, at = []) {
    if (Array.isArray(node))
      return node.flatMap((value, i) => paths(value, [...at, i]));
    if (node && typeof node === "object")
      return [
        at,
        ...Object.entries(node).flatMap(([key, value]) =>
          paths(value, [...at, key]),
        ),
      ];
    return [];
  }
  for (const fixture of fixtures.filter((f) => f.valid)) {
    const data = read("fixtures/" + fixture.path);
    const validate = getValidator(base + fixture.schema);
    for (const path of paths(data)) {
      const mutated = structuredClone(data);
      let target = mutated;
      for (const key of path) target = target[key];
      target.__unexpected_contract_field = true;
      assert.equal(
        validate(mutated),
        false,
        `${fixture.path}/${path.join("/")} accepted an unknown field`,
      );
      checked++;
    }
  }
  assert.ok(checked >= 70, `Insufficient nested coverage: ${checked}`);
});

function canonicalize(value) {
  if (value === null || typeof value !== "object") {
    if (typeof value === "number")
      assert.ok(
        Number.isSafeInteger(value),
        "Only safe integers belong in task canonicalization",
      );
    if (typeof value === "string")
      assert.ok(
        value.isWellFormed(),
        "Canonical strings must be Unicode scalar values",
      );
    return JSON.stringify(value);
  }
  if (Array.isArray(value))
    return "[" + value.map(canonicalize).join(",") + "]";
  return (
    "{" +
    Object.keys(value)
      .sort()
      .map((k) => JSON.stringify(k) + ":" + canonicalize(value[k]))
      .join(",") +
    "}"
  );
}
const sha256 = (bytes) => createHash("sha256").update(bytes).digest("hex");
function taskHash(task) {
  const { payload_hash, ...immutable } = task;
  return sha256(Buffer.from(canonicalize(immutable), "utf8"));
}

test("canonical task fixture fixes exact UTF-8 bytes and SHA256", () => {
  const vector = read("fixtures/canonical-task.json");
  const { payload_hash, ...immutable } = vector.task;
  assert.equal(canonicalize(immutable), vector.canonical_utf8);
  assert.equal(
    Buffer.from(vector.canonical_utf8, "utf8").toString("hex"),
    vector.canonical_hex,
  );
  assert.equal(taskHash(vector.task), vector.payload_hash);
  assert.equal(payload_hash, vector.payload_hash);
  const reversed = Object.fromEntries(Object.entries(vector.task).reverse());
  assert.equal(
    taskHash(reversed),
    payload_hash,
    "Wire key order must not change hash",
  );
  assert.equal(
    taskHash({ ...vector.task, payload_hash: "0".repeat(64) }),
    payload_hash,
    "Hash must exclude its own field",
  );
  assert.notEqual(
    taskHash({ ...vector.task, argv: [...vector.task.argv, "changed"] }),
    payload_hash,
  );
  assert.notEqual(
    taskHash({ ...vector.task, actor_id: "different-actor" }),
    payload_hash,
  );
});

test("schema rejects non-interoperable strings and non-integer numeric limits", () => {
  const vector = read("fixtures/canonical-task.json");
  const validate = getValidator(base + "task.schema.json");
  assert.equal(
    validate({ ...vector.task, argv: ["/bin/echo", "\ud800"] }),
    false,
    "Reject lone high surrogate",
  );
  assert.equal(
    validate({ ...vector.task, argv: ["/bin/echo", "\udfff"] }),
    false,
    "Reject lone low surrogate",
  );
  assert.equal(
    validate({ ...vector.task, argv: ["/bin/echo", "😀"] }),
    true,
    "Permit a valid Unicode scalar",
  );
  assert.equal(validate({ ...vector.task, timeout_ms: 100.5 }), false);
});

function privateKey(seedHex) {
  return createPrivateKey({
    key: Buffer.from("302e020100300506032b657004220420" + seedHex, "hex"),
    format: "der",
    type: "pkcs8",
  });
}
function publicKey(rawHex) {
  return createPublicKey({
    key: Buffer.from("302a300506032b6570032100" + rawHex, "hex"),
    format: "der",
    type: "spki",
  });
}

test("Ed25519 matches RFC 8032 section 7.1 TEST 1 exactly", () => {
  const vector = read("fixtures/ed25519-rfc8032.json");
  const message = Buffer.from(vector.message_hex, "hex");
  const signature = Buffer.from(vector.signature_hex, "hex");
  const key = privateKey(vector.seed_hex);
  assert.equal(
    createPublicKey(key)
      .export({ format: "der", type: "spki" })
      .subarray(-32)
      .toString("hex"),
    vector.public_key_hex,
  );
  assert.equal(sign(null, message, key).toString("hex"), vector.signature_hex);
  assert.equal(
    verify(null, message, publicKey(vector.public_key_hex), signature),
    true,
  );
  assert.equal(
    verify(
      null,
      Buffer.from("changed"),
      publicKey(vector.public_key_hex),
      signature,
    ),
    false,
  );
});

function challengeBytes(f) {
  return Buffer.from(
    [
      "fleet-v1",
      f.server_instance,
      f.purpose,
      f.challenge_id,
      f.nonce,
      f.public_key,
      f.device_id,
      f.enrollment_token_sha256,
      String(f.expires_at),
      "",
    ].join("\n"),
    "utf8",
  );
}

test("challenge signatures bind exact fields, empty lines and terminal LF", () => {
  const fixture = read("fixtures/challenge-signatures.json");
  const key = publicKey(fixture.public_key_hex);
  for (const vector of fixture.cases) {
    const bytes = challengeBytes(vector.fields);
    const signature = Buffer.from(vector.signature, "base64");
    assert.equal(bytes.toString("utf8"), vector.signing_payload_utf8);
    assert.equal(bytes.toString("hex"), vector.signing_payload_hex);
    assert.equal(bytes.toString("base64"), vector.response.signing_payload);
    assert.equal(bytes.at(-1), 10, "Terminal LF is mandatory");
    assert.equal(
      vector.fields.nonce,
      Buffer.from(vector.fields.nonce, "base64").toString("base64"),
    );
    assert.equal(Buffer.from(vector.fields.nonce, "base64").length, 32);
    assert.equal(
      vector.fields.enrollment_token_sha256,
      vector.enrollment_token ? sha256(vector.enrollment_token) : "",
    );
    assert.equal(
      sign(null, bytes, privateKey(fixture.seed_hex)).toString("base64"),
      vector.signature,
    );
    assert.equal(verify(null, bytes, key, signature), true);
    assert.equal(
      verify(null, bytes.subarray(0, -1), key, signature),
      false,
      "Dropping final LF changes the signed bytes",
    );
    assert.equal(
      verify(
        null,
        Buffer.from(bytes.toString().replaceAll("\n", "\r\n")),
        key,
        signature,
      ),
      false,
      "CRLF is not canonical",
    );
    assert.equal(
      verify(
        null,
        Buffer.from(bytes.toString().replace("fleet-v1", "fleet-v2")),
        key,
        signature,
      ),
      false,
      "Domain separation is signed",
    );
    for (const field of Object.keys(vector.fields)) {
      const altered = {
        ...vector.fields,
        [field]:
          field === "expires_at"
            ? vector.fields[field] + 1
            : String(vector.fields[field]) + "x",
      };
      assert.equal(
        verify(null, challengeBytes(altered), key, signature),
        false,
        `${field} must be bound`,
      );
    }
  }
});

test("frame limit is UTF-8 bytes, a transport invariant beyond JSON Schema", () => {
  const frame = {
    v: 1,
    type: "task.assign",
    body: read("fixtures/canonical-task.json").task,
  };
  assert.ok(Buffer.byteLength(JSON.stringify(frame), "utf8") <= 65536);
  const unicode = "界".repeat(22000);
  assert.ok(unicode.length < 65536);
  assert.ok(Buffer.byteLength(unicode, "utf8") > 65536);
});

test("public helper accepts names and reports errors without mutating inputs", () => {
  const task = read("fixtures/canonical-task.json").task;
  assert.equal(validate("task", task), true);
  assert.equal(validate.errors, null);
  assert.equal(validate("task.schema.json", { ...task, uid: 0 }), false);
  assert.ok(validate.errors.length > 0);
  assert.strictEqual(assertValid("task", task), task);
  assert.throws(
    () => assertValid("task", { ...task, uid: 0 }),
    /contract mismatch/,
  );
  assert.throws(() => validate("nonexistent", {}), /Unknown Farhelm v1 schema/);
});

test("network probe rejection is an explicit bounded response", () => {
  const frame = {
    v: 1,
    type: "agent.network.probe.rejected",
    body: { revision: 2, code: "NETWORK_PROBE_CONFIG_REJECTED" },
  };
  assertValid("network-probe-envelope", frame);
  assertValid("network-probe-envelope", {
    ...frame,
    body: { ...frame.body, revision: null },
  });
  assert.equal(
    validate("network-probe-envelope", {
      ...frame,
      body: { ...frame.body, code: "untrusted error" },
    }),
    false,
  );
});
