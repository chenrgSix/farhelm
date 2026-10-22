import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { setImmediate as immediate } from "node:timers/promises";
import { buildServer } from "../src/server.js";
import { passwordHashAsync } from "../src/util.js";

test("password verification does not stall health requests and cannot authenticate a user disabled while queued", async () => {
  const root = mkdtempSync(join(tmpdir(), "farhelm-async-auth-"));
  execFileSync(
    "bash",
    ["../../deploy/dev/generate-tls.sh", join(root, "tls")],
    { stdio: "ignore" },
  );
  const server = await buildServer({
    dataDir: join(root, "data"),
    tlsCert: join(root, "tls/server.crt"),
    tlsKey: join(root, "tls/server.key"),
    adminUsername: "admin",
    adminPassword: "async-auth-password1",
  });
  try {
    const work = Promise.all(
      Array.from({ length: 16 }, () =>
        passwordHashAsync("queue-fixture-password1"),
      ),
    );
    let finished = false;
    const login = server.app
      .inject({
        method: "POST",
        url: "/api/v1/login",
        payload: { username: "admin", password: "async-auth-password1" },
      })
      .then((response) => {
        finished = true;
        return response;
      });
    await immediate();
    const health = await server.app.inject({ url: "/healthz" });
    assert.equal(health.statusCode, 200);
    assert.equal(finished, false);
    server.store.db
      .prepare("UPDATE users SET enabled=0 WHERE username='admin'")
      .run();
    const response = await login;
    assert.equal(response.statusCode, 401);
    assert.equal(response.json().error, "INVALID_CREDENTIALS");
    assert.equal(
      (
        server.store.db
          .prepare("SELECT COUNT(*) AS n FROM user_sessions")
          .get() as any
      ).n,
      0,
    );
    await work;
  } finally {
    await server.app.close();
    rmSync(root, { recursive: true, force: true });
  }
});
