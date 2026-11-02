import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import ssh2 from "ssh2";
import { createServer, type Socket, type AddressInfo } from "node:net";
import { SshTargets, fingerprint } from "../src/ssh-target.js";
import { randomUUID, generateKeyPairSync } from "node:crypto";
import { assertValid } from "../../../tests/contracts/validate.mjs";
import { buildServer } from "../src/server.js";

function scriptClient(
  app: Awaited<ReturnType<typeof buildServer>>,
  password: string,
) {
  const request = (
    method: "POST" | "GET" | "DELETE" | "PUT",
    url: string,
    auth?: string,
    body?: Record<string, unknown>,
    key?: string,
  ) =>
    app.app.inject({
      method,
      url: "/api/v1" + url,
      payload: body,
      headers: {
        ...(auth ? { authorization: "Bearer " + auth } : {}),
        ...(key ? { "idempotency-key": key } : {}),
      },
    });
  async function login(username: string) {
    const r = await request("POST", "/login", undefined, {
      username,
      password,
    });
    assert.equal(r.statusCode, 200, r.body);
    return r.json().access_token;
  }
  return { request, login };
}

test("设备操作员共用预设按钮，不能跨设备、更改脚本或使用自由命令", async () => {
  const dir = mkdtempSync(join(tmpdir(), "fh-device-scripts-"));
  const password = "test-password13";
  const config = {
    dataDir: dir,
    deviceAccess: "ssh-only" as const,
    webEnabled: true,
    webProtocol: "http" as const,
    adminUsername: "admin",
    adminPassword: password,
  };
  let app = await buildServer(config);
  const { request, login } = scriptClient(app, password);
  // Hold SSH negotiation to keep the reservation live until both accounts have tried.
  let hold = true;
  const sockets = new Set<Socket>();
  const target = createServer((socket) => {
    if (!hold) {
      socket.destroy();
      return;
    }
    sockets.add(socket);
    socket.once("close", () => sockets.delete(socket));
  });
  await new Promise<void>((resolve) => target.listen(0, "127.0.0.1", resolve));
  async function waitForFailure(id: string) {
    const until = Date.now() + 8000;
    while (app.store.task(id).status === "RUNNING" && Date.now() < until)
      await new Promise((r) => setTimeout(r, 20));
    assert.equal(app.store.task(id).status, "FAILED");
  }
  try {
    const admin = await login("admin");
    const d = await request("POST", "/ssh-devices", admin, {
      v: 1,
      name: "测试 SSH",
      ssh: {
        host: "127.0.0.1",
        port: (target.address() as AddressInfo).port,
        username: "nobody",
        fingerprint: "SHA256:" + "A".repeat(43),
        auth_method: "password",
      },
      ssh_password: "fixture-only",
    });
    assert.equal(d.statusCode, 200, d.body);
    const id = d.json().device_id,
      base = "/devices/" + id + "/scripts";
    const role = await request("POST", "/roles", admin, {
      v: 1,
      name: "脚本操作员",
      description: "只点预设按钮",
      permissions: ["scripts.run", "tasks.read", "devices.read"],
    });
    assert.equal(role.statusCode, 200, role.body);
    const groupRole = role.json().role.id;
    const accounts = ["alice", "bob", "outsider", "reader"];
    for (const name of accounts) {
      const user = app.store.seedUser({
        username: name,
        password,
        role: "business",
        deviceScope: name === "outsider" ? [] : [id],
      });
      if (name !== "reader")
        app.store.db
          .prepare("INSERT INTO user_roles(user_id,role_id) VALUES(?,?)")
          .run(user.id, groupRole);
    }
    const [alice, bob, outsider, reader] = await Promise.all(
      accounts.map(login),
    );
    const saved = await request("POST", base, admin, {
      v: 1,
      name: "检查状态",
      script: "printf 'ok\\n'",
    });
    assert.equal(saved.statusCode, 200, saved.body);
    const item = base + "/" + saved.json().id,
      run = item + "/run";
    for (const who of [alice, bob]) {
      const rows = (await request("GET", base, who)).json().scripts;
      assert.deepEqual(rows, [
        { id: saved.json().id, name: "检查状态", revision: 1 },
      ]);
      assert.equal(
        (
          await request("PUT", item, who, {
            v: 1,
            revision: 1,
            name: "changed",
            script: "id",
          })
        ).statusCode,
        403,
      );
    }
    assert.equal((await request("GET", base, reader)).statusCode, 403);
    assert.equal(
      (await request("POST", run, outsider, { v: 1, revision: 1 }, "deny"))
        .statusCode,
      403,
    );
    assert.equal(
      (await request("POST", run, reader, { v: 1, revision: 1 }, "deny"))
        .statusCode,
      403,
    );
    assert.equal(
      (
        await request(
          "POST",
          run,
          alice,
          { v: 1, revision: 1, script: "uname" },
          "tamper",
        )
      ).statusCode,
      400,
    );
    assert.equal(
      (await request("POST", "/commands", alice, { v: 1 })).statusCode,
      403,
    );
    assert.equal(
      (
        await request("POST", "/terminal-sessions", alice, {
          v: 1,
          device_id: id,
        })
      ).statusCode,
      403,
    );
    const key = randomUUID();
    const runs = await Promise.all(
      [1, 2].map(() => request("POST", run, alice, { v: 1, revision: 1 }, key)),
    );
    for (const res of runs) assert.equal(res.statusCode, 200, res.body);
    const task = runs[0]!.json().task_id;
    assert.equal(task, runs[1]!.json().task_id);
    assert.equal((await request("GET", "/tasks/" + task, bob)).statusCode, 403);
    const blocked = await request("POST", run, bob, { v: 1, revision: 1 }, key);
    assert.equal(blocked.statusCode, 409);
    const active = blocked.json().active_run;
    assert.equal(blocked.json().error, "SCRIPT_BUSY");
    assert.equal(active.task_id, task);
    assert.equal(active.actor_username, "alice");
    assert.equal(active.status, "RUNNING");
    assert.equal(active.backend, "ssh");
    assert.deepEqual(
      Object.keys(active).sort(),
      [
        "actor_username",
        "backend",
        "created_at",
        "device_id",
        "script_id",
        "status",
        "task_id",
      ].sort(),
    );
    assert.deepEqual(
      (await request("GET", base + "/activity", bob)).json().activity,
      [active],
    );
    assert.deepEqual((await request("GET", base, bob)).json().activity, [
      active,
    ]);
    assert.equal(
      (await request("GET", base + "/activity", outsider)).statusCode,
      403,
    );
    assert.equal(
      (await request("GET", base + "/activity", reader)).statusCode,
      403,
    );
    assert.equal(
      (await request("DELETE", item, admin, { v: 1, revision: 1 })).json()
        .error,
      "SCRIPT_BUSY",
    );
    assert.equal(
      (
        await request(
          "POST",
          item + "/runs/" + task + "/confirm-stopped",
          admin,
          { v: 1 },
        )
      ).json().error,
      "SCRIPT_REVIEW_NOT_ALLOWED",
    );
    const secondary = (
      await request("POST", base, admin, {
        v: 1,
        name: "独立按钮",
        script: "true",
      })
    ).json().id;
    const competing = await Promise.all(
      [alice, bob].map((token) =>
        request(
          "POST",
          base + "/" + secondary + "/run",
          token,
          { v: 1, revision: 1 },
          randomUUID(),
        ),
      ),
    );
    assert.deepEqual(competing.map((res) => res.statusCode).sort(), [200, 409]);
    const secondaryTask = competing
      .find((res) => res.statusCode === 200)!
      .json().task_id;
    assert.equal(
      competing.find((res) => res.statusCode === 409)!.json().active_run
        .task_id,
      secondaryTask,
    );
    hold = false;
    for (const socket of sockets) socket.destroy();
    await Promise.all([waitForFailure(task), waitForFailure(secondaryTask)]);
    assert.equal(
      (await request("GET", base + "/activity", bob)).json().activity.length,
      0,
    );
    const other = await request("POST", run, bob, { v: 1, revision: 1 }, key);
    assert.equal(other.statusCode, 200, other.body);
    assert.notEqual(other.json().task_id, task);
    const savedAgain = await request("PUT", item, admin, {
      v: 1,
      revision: 1,
      name: "新名称",
      script: "exit 7",
    });
    assert.equal(savedAgain.statusCode, 200, savedAgain.body);
    assert.equal(
      (await request("POST", run, bob, { v: 1, revision: 1 }, "old"))
        .statusCode,
      409,
    );
    assert.equal(
      (await request("DELETE", item, admin, { v: 1, revision: 1 })).statusCode,
      409,
    );
    await waitForFailure(other.json().task_id);
    assert.equal(
      (await request("GET", base, alice))
        .json()
        .runs.find((r: { id: string }) => r.id === task).name,
      "检查状态",
    );
    assert.equal(
      JSON.parse(app.store.task(task).result_json).reason,
      "SSH_CONNECT_FAILED",
    );
    assert.equal(
      app.store.db
        .prepare(
          "SELECT count(*) AS n FROM audit WHERE action='script.submitted'",
        )
        .get()?.n,
      3,
    );
    // A crash after dispatch must never replay a remote SSH script.
    await app.close();
    app = await buildServer(config);
    app.store.db
      .prepare("UPDATE tasks SET status='RUNNING',result_json=NULL WHERE id=?")
      .run(task);
    await app.close();
    app = await buildServer(config);
    assert.equal(app.store.task(task).status, "UNKNOWN");
    assert.equal(
      JSON.parse(app.store.task(task).result_json).reason,
      "SSH_SERVER_RESTARTED",
    );
    const recovered = scriptClient(app, password);
    const freshAdmin = await recovered.login("admin"),
      freshBob = await recovered.login("bob");
    const retry = () =>
      recovered.request(
        "POST",
        run,
        freshBob,
        { v: 1, revision: 2 },
        "after-review",
      );
    assert.equal((await retry()).json().active_run.status, "UNKNOWN");
    const confirm = (actor: string) =>
      recovered.request(
        "POST",
        item + "/runs/" + task + "/confirm-stopped",
        actor,
        { v: 1 },
      );
    assert.equal((await confirm(freshBob)).statusCode, 403);
    assert.equal((await confirm(freshAdmin)).statusCode, 200);
    hold = true;
    const next = await retry();
    assert.equal(next.statusCode, 200, next.body);
    assert.equal((await confirm(freshAdmin)).statusCode, 200);
    assert.deepEqual(
      (await recovered.request("GET", base + "/activity", freshBob))
        .json()
        .activity.map((r: { task_id: string }) => r.task_id),
      [next.json().task_id],
    );
    const reviewed = (await recovered.request("GET", "/audit", freshAdmin))
      .json()
      .audit.find(
        (r: { action: string }) => r.action === "script.stop_confirmed",
      );
    assertValid("audit", reviewed);
    assert.equal(reviewed.actor_username, "admin");
    assert.equal(reviewed.task_id, task);
    hold = false;
    for (const socket of sockets) socket.destroy();
    assert.equal(app.store.task(task).status, "UNKNOWN");
    assert.equal(
      app.store.db
        .prepare(
          "SELECT count(*) AS n FROM audit WHERE action='script.stop_confirmed' AND task_id=?",
        )
        .get(task)?.n,
      1,
    );
    await waitForFailure((await retry()).json().task_id);
    assert.equal(
      (
        await recovered.request("DELETE", item, freshAdmin, {
          v: 1,
          revision: 2,
        })
      ).statusCode,
      200,
    );
  } finally {
    await app.close();
    for (const socket of sockets) socket.destroy();
    await new Promise<void>((r) => target.close(() => r()));
    rmSync(dir, { force: true, recursive: true });
  }
});

test("配置人员按设备范围通过用户组维护按钮，运行和平台管理仍独立", async () => {
  const dir = mkdtempSync(join(tmpdir(), "fh-script-manage-")),
    password = "test-password13";
  const app = await buildServer({
    dataDir: dir,
    deviceAccess: "ssh-only",
    webEnabled: true,
    webProtocol: "http",
    adminUsername: "admin",
    adminPassword: password,
  });
  const { request, login } = scriptClient(app, password);
  try {
    const admin = await login("admin");
    const roleConfig = {
      v: 1,
      name: "脚本维护",
      description: "维护预设按钮",
      permissions: ["devices.read", "scripts.manage"],
    };
    const created = await request("POST", "/roles", admin, roleConfig);
    assert.equal(created.statusCode, 200, created.body);
    const role = created.json().role;
    const [assigned, other] = [randomUUID(), randomUUID()];
    for (const id of [assigned, other])
      app.store.db
        .prepare(
          "INSERT INTO devices(id,public_key,name,created_at) VALUES(?,?,?,?)",
        )
        .run(id, id, id, Date.now());
    const user = app.store.seedUser({
      username: "maintainer",
      password,
      role: "business",
      deviceScope: [],
    });
    app.store.db.prepare("DELETE FROM user_roles WHERE user_id=?").run(user.id);
    const group = await request("POST", "/groups", admin, {
      v: 1,
      name: "维护组",
      description: "",
      member_ids: [user.id],
      role_ids: [role.id],
      device_scope: [assigned],
    });
    assert.equal(group.statusCode, 200, group.body);
    const token = await login(user.username);
    const me = (await request("GET", "/me", token)).json();
    assert.deepEqual(me.permissions.sort(), ["devices.read", "scripts.manage"]);
    const base = "/devices/" + assigned + "/scripts",
      outside = "/devices/" + other + "/scripts";
    const config = { v: 1, name: "显示版本", script: "echo v1" };
    const added = await request("POST", base, token, config);
    assert.equal(added.statusCode, 200, added.body);
    const item = base + "/" + added.json().id;
    const listing = (await request("GET", base, token)).json();
    assert.equal(listing.scripts[0].script, config.script);
    assert.deepEqual(listing.runs, []);
    const updated = await request("PUT", item, token, {
      ...config,
      revision: 1,
      script: "echo v2",
    });
    assert.equal(updated.statusCode, 200, updated.body);
    assert.equal(
      (
        await request(
          "POST",
          item + "/run",
          token,
          { v: 1, revision: 2 },
          "blocked",
        )
      ).json().error,
      "SCRIPT_ACCESS_DENIED",
    );
    assert.equal((await request("GET", "/access", token)).statusCode, 403);
    assert.equal(
      (await request("GET", outside, token)).json().error,
      "DEVICE_SCOPE_DENIED",
    );
    assert.equal(
      (await request("POST", outside, token, config)).json().error,
      "DEVICE_SCOPE_DENIED",
    );
    const otherItem =
      outside + "/" + (await request("POST", outside, admin, config)).json().id;
    assert.equal(
      (
        await request("PUT", otherItem, token, { ...config, revision: 1 })
      ).json().error,
      "DEVICE_SCOPE_DENIED",
    );
    assert.equal(
      (await request("DELETE", otherItem, token, { v: 1, revision: 1 })).json()
        .error,
      "DEVICE_SCOPE_DENIED",
    );
    assert.equal(
      (await request("DELETE", item, token, { v: 1, revision: 2 })).statusCode,
      200,
    );
    assert.deepEqual(
      app.store.db
        .prepare(
          "SELECT action FROM audit WHERE actor_id=? AND device_id=? AND action LIKE 'script.%' ORDER BY id",
        )
        .all(user.id, assigned)
        .map((row) => row.action),
      ["script.created", "script.updated", "script.deleted"],
    );
    const revoke = await request("PUT", "/roles/" + role.id, admin, {
      ...roleConfig,
      revision: role.revision,
      permissions: ["devices.read"],
    });
    assert.equal(revoke.statusCode, 200, revoke.body);
    assert.notEqual(
      (await request("POST", base, token, config)).statusCode,
      200,
    );
    const fresh = await login(user.username);
    assert.equal(
      (await request("POST", base, fresh, config)).json().error,
      "SCRIPT_MANAGE_DENIED",
    );
    assert.equal((await request("GET", base, fresh)).statusCode, 403);
  } finally {
    await app.close();
    rmSync(dir, { force: true, recursive: true });
  }
});

test("SSH 执行区分退出码与提交后断线，发送脚本之前复核授权", async () => {
  const key = generateKeyPairSync("rsa", {
    modulusLength: 2048,
    privateKeyEncoding: { type: "pkcs1", format: "pem" },
    publicKeyEncoding: { type: "spki", format: "pem" },
  }).privateKey;
  const parsed = ssh2.utils.parseKey(key);
  assert.ok(!(parsed instanceof Error));
  const received: string[] = [];
  const ssh = new ssh2.Server({ hostKeys: [key] }, (client) => {
    client.on("error", () => {});
    client.on("authentication", (auth) =>
      auth.method === "password" ? auth.accept() : auth.reject(["password"]),
    );
    client.on("session", (accept) =>
      accept().on("exec", (open, _reject, info) => {
        assert.match(info.command, /setpriv --no-new-privs/);
        const channel = open();
        const chunks: Buffer[] = [];
        channel.on("data", (chunk) => chunks.push(chunk));
        channel.on("error", () => {});
        channel.on("end", () => {
          const script = Buffer.concat(chunks).toString();
          if (!script) return;
          received.push(script);
          if (script.includes("interrupt")) {
            client.end();
            return;
          }
          channel.write("output");
          channel.stderr.write("detail");
          channel.exit(7);
          channel.end();
        });
      }),
    );
  });
  await new Promise<void>((r) => ssh.listen(0, "127.0.0.1", r));
  const targets = new SshTargets();
  const config = {
    authMethod: "password" as const,
    host: "127.0.0.1",
    port: (ssh.address() as AddressInfo).port,
    username: "ops",
    password: "fixture",
    fingerprint: fingerprint(parsed.getPublicSSH()),
  };
  try {
    const run = (script: string, before = () => {}) =>
      targets.runScript(
        config,
        script,
        new AbortController().signal,
        false,
        before,
      );
    const result = await run("echo 'fixed command'");
    assert.equal(result.code, 7);
    assert.equal(result.stdout.toString(), "output");
    assert.equal(result.stderr.toString(), "detail");
    await assert.rejects(run("interrupt"), /SSH_SCRIPT_INTERRUPTED/);
    await assert.rejects(
      run("must never be sent", () => {
        throw new Error("SCRIPT_ACCESS_DENIED");
      }),
      /SCRIPT_ACCESS_DENIED/,
    );
    assert.equal(received.length, 2);
    assert.match(
      received[0]!,
      /^exec \/bin\/sh -c .*fixed command.* <\/dev\/null\n$/,
    );
    assert.equal(received[1], "exec /bin/sh -c 'interrupt' </dev/null\n");
  } finally {
    await targets.close();
    await new Promise<void>((r) => ssh.close(() => r()));
  }
});
