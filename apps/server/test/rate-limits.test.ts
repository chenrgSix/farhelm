import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildServer } from "../src/server.js";

async function fixture(t: test.TestContext) {
  const dataDir = mkdtempSync(join(tmpdir(), "farhelm-rate-"));
  const s = await buildServer({
    dataDir,
    deviceAccess: "ssh-only",
    webProtocol: "http",
    adminUsername: "admin",
    adminPassword: "RateLimit123",
  });
  t.after(async () => {
    await s.close();
    rmSync(dataDir, { recursive: true, force: true });
  });
  return s.app;
}

test("IP-rejected HTTP traffic does not exhaust the global budget", async (t) => {
  const app = await fixture(t);
  for (let i = 0; i < 10001; i++) {
    const r = await app.inject({ url: "/healthz", remoteAddress: "192.0.2.1" });
    assert.equal(r.statusCode, i < 1000 ? 200 : 429);
  }
  assert.equal(
    (await app.inject({ url: "/healthz", remoteAddress: "192.0.2.2" }))
      .statusCode,
    200,
  );
});

test("malformed and IP-rejected logins leave capacity for another source", async (t) => {
  const app = await fixture(t);
  for (let i = 0; i < 101; i++) {
    const r = await app.inject({
      method: "POST",
      url: "/api/v1/login",
      payload: {},
      remoteAddress: "192.0.2.1",
    });
    assert.equal(r.statusCode, 400);
  }
  for (let i = 0; i < 101; i++) {
    const r = await app.inject({
      method: "POST",
      url: "/api/v1/login",
      payload: { username: `missing-${i}`, password: "wrong" },
      remoteAddress: "192.0.2.1",
    });
    assert.equal(r.statusCode, i < 20 ? 401 : 429);
  }
  const r = await app.inject({
    method: "POST",
    url: "/api/v1/login",
    payload: { username: "admin", password: "RateLimit123" },
    remoteAddress: "192.0.2.2",
  });
  assert.equal(r.statusCode, 200);
});

test("username-rejected logins do not consume the global password budget", async (t) => {
  const app = await fixture(t);
  for (let i = 0; i < 101; i++) {
    const r = await app.inject({
      method: "POST",
      url: "/api/v1/login",
      payload: { username: "missing", password: "wrong" },
      remoteAddress: `192.0.2.${i + 1}`,
    });
    assert.equal(r.statusCode, i < 10 ? 401 : 429);
  }
  const r = await app.inject({
    method: "POST",
    url: "/api/v1/login",
    payload: { username: "admin", password: "RateLimit123" },
    remoteAddress: "192.0.2.200",
  });
  assert.equal(r.statusCode, 200);
});
