import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { buildServer } from "../src/server.js";
import { hash } from "../src/util.js";
const root = mkdtempSync(join(tmpdir(), "farhelm-settings-test-"));
execFileSync("bash", ["../../deploy/dev/generate-tls.sh", join(root, "tls")], {
  stdio: "ignore",
});
async function fixture() {
  const dataDir = mkdtempSync(join(root, "data-")),
    distDir = join(dataDir, "packages");
  mkdirSync(distDir);
  const elf = Buffer.alloc(64);
  Buffer.from("7f454c460201", "hex").copy(elf);
  elf.writeUInt16LE(183, 18);
  writeFileSync(join(distDir, "farhelm-agent-linux-aarch64"), elf);
  const config = {
    dataDir,
    tlsCert: join(root, "tls/server.crt"),
    tlsKey: join(root, "tls/server.key"),
    adminUsername: "admin",
    adminPassword: "settings-test-password",
    agentInstall: {
      distDir,
      publicUrl: "https://initial.example.com",
      caCert: join(root, "tls/ca.crt"),
    },
  };
  const server = await buildServer(config);
  async function login(username = "admin") {
    return (
      await server.app.inject({
        method: "POST",
        url: "/api/v1/login",
        payload: { username, password: config.adminPassword },
      })
    ).json().access_token;
  }
  const admin = await login();
  const api = (
    method: "GET" | "PUT" | "POST",
    url: string,
    payload?: unknown,
    auth = admin,
  ) =>
    server.app.inject({
      method,
      url: "/api/v1" + url,
      payload,
      headers: { authorization: "Bearer " + auth },
    });
  return { ...server, config, api, login };
}
test("only admins can read or change settings; URLs and revisions are validated", async () => {
  const f = await fixture();
  try {
    assert.equal(
      (await f.api("GET", "/settings", undefined, "invalid")).statusCode,
      401,
    );
    for (const role of ["ops", "auditor", "business"] as const) {
      f.store.seedUser({
        username: role,
        password: f.config.adminPassword,
        role,
        deviceScope: "*",
      });
      const auth = await f.login(role);
      assert.equal(
        (await f.api("GET", "/settings/agent-sync", undefined, auth))
          .statusCode,
        403,
      );
      assert.equal(
        (
          await f.api(
            "POST",
            "/settings/agent-sync",
            { v: 1, revision: 1 },
            auth,
          )
        ).statusCode,
        403,
      );
      assert.equal(
        (await f.api("GET", "/settings", undefined, auth)).statusCode,
        403,
      );
      assert.equal(
        (
          await f.api(
            "PUT",
            "/settings",
            {
              v: 1,
              revision: 0,
              platform_server_url: "https://not-allowed.example.com",
            },
            auth,
          )
        ).statusCode,
        403,
      );
    }
    for (const url of [
      "",
      "http://example.com",
      "https://user:password@example.com",
      "https://example.com/path",
      "https://example.com?token=secret",
      "https://example.com#fragment",
      "https://exa\nmple.com",
    ]) {
      assert.equal(
        (
          await f.api("PUT", "/settings", {
            v: 1,
            revision: 0,
            platform_server_url: url,
          })
        ).statusCode,
        400,
      );
    }
    assert.equal(
      (
        await f.api("PUT", "/settings", {
          v: 1,
          platform_server_url: "https://example.com",
        })
      ).statusCode,
      400,
    );
    assert.equal(
      (
        await f.api("PUT", "/settings", {
          v: 1,
          revision: 0,
          platform_server_url: "https://example.com",
          unexpected: true,
        })
      ).statusCode,
      400,
    );
    assert.equal((await f.api("GET", "/settings")).json().revision, 0);
  } finally {
    await f.close();
  }
});
test("settings take effect immediately, preserve generated commands, reject stale saves and persist across restart", async () => {
  const f = await fixture();
  try {
    const before = (
      await f.api("POST", "/agent-installations", { v: 1, name: "old" })
    ).json();
    const secret = before.command
      .match(/[A-Za-z0-9+/=]{50,}/g)
      .map((s: string) => Buffer.from(s, "base64").toString())
      .find((s: string) => s.startsWith("Authorization: Bearer "))
      .slice("Authorization: Bearer ".length)
      .trim();
    const oldScript = (
      await f.app.inject({
        method: "GET",
        url: "/api/agent/install.sh",
        headers: { authorization: "Bearer " + secret },
      })
    ).body;
    const saved = await f.api("PUT", "/settings", {
      v: 1,
      revision: 0,
      platform_server_url: " https://NEW.example.com:443/ ",
    });
    assert.equal(saved.statusCode, 200);
    assert.equal(saved.json().platform_server_url, "https://new.example.com");
    assert.equal(saved.json().revision, 1);
    assert.ok(saved.json().updated_at > 0);
    assert.equal(
      (await f.api("GET", "/agent-install/options")).json().server_url,
      "https://new.example.com",
    );
    const next = (
      await f.api("POST", "/agent-installations", { v: 1, name: "new" })
    ).json();
    assert.equal(next.server_url, "https://new.example.com");
    assert.ok(
      next.command.includes("https://new.example.com/api/agent/install.sh"),
    );
    assert.equal(
      (
        await f.app.inject({
          method: "GET",
          url: "/api/agent/install.sh",
          headers: { authorization: "Bearer " + secret },
        })
      ).body,
      oldScript,
    );
    assert.ok(before.command.includes(hash(oldScript)));
    assert.equal(
      (
        await f.api("PUT", "/settings", {
          v: 1,
          revision: 0,
          platform_server_url: "https://stale.example.com",
        })
      ).statusCode,
      409,
    );
    const audit = (await f.api("GET", "/audit"))
      .json()
      .audit.filter((a: any) => a.action === "settings.updated");
    assert.equal(audit.length, 1);
    assert.deepEqual(audit[0].detail, {
      revision: 1,
      platform_server_url: "https://new.example.com",
    });
    assert.ok(audit[0].actor_id);
    f.store.db.exec(
      "CREATE TRIGGER fail_settings_audit BEFORE INSERT ON audit WHEN NEW.action='settings.updated' BEGIN SELECT RAISE(ABORT, 'test audit failure'); END;",
    );
    assert.equal(
      (
        await f.api("PUT", "/settings", {
          v: 1,
          revision: 1,
          platform_server_url: "https://must-rollback.example.com",
        })
      ).statusCode,
      500,
    );
    assert.equal(
      (await f.api("GET", "/settings")).json().platform_server_url,
      "https://new.example.com",
    );
    f.store.db.exec("DROP TRIGGER fail_settings_audit");
  } finally {
    await f.close();
  }
  const restarted = await buildServer({
    ...f.config,
    agentInstall: {
      ...f.config.agentInstall,
      publicUrl: "https://changed-environment.example.com",
    },
  });
  try {
    const login = (
      await restarted.app.inject({
        method: "POST",
        url: "/api/v1/login",
        payload: { username: "admin", password: f.config.adminPassword },
      })
    ).json();
    const options = await restarted.app.inject({
      method: "GET",
      url: "/api/v1/agent-install/options",
      headers: { authorization: "Bearer " + login.access_token },
    });
    assert.equal(options.json().server_url, "https://new.example.com");
  } finally {
    await restarted.close();
  }
});
