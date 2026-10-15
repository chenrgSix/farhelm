import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { writeFileSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { createRequire } from "node:module";
const require = createRequire(import.meta.url);
const ssh2 = require("../../apps/server/node_modules/ssh2");
export async function checkSsh({ server, deviceId, temp, until, steps }) {
  const port = server.ssh.info().port;
  const key = ssh2.utils.parseKey(
    readFileSync(join(temp, "server/ssh_host_ed25519_key")),
  );
  const knownHosts = join(temp, "known_hosts");
  writeFileSync(
    knownHosts,
    `[127.0.0.1]:${port} ${key.type} ${key.getPublicSSH().toString("base64")}\n`,
    { mode: 0o600 },
  );
  const askpass = join(temp, "askpass");
  // Isolated test credential; never uses an existing deployment's admin password.
  writeFileSync(
    askpass,
    "#!/bin/sh\nprintf '%s\\n' 'isolated-terminal-e2e-password'\n",
    { mode: 0o700 },
  );
  const child = spawn(
    "ssh",
    [
      "-tt",
      "-F",
      "/dev/null",
      "-o",
      "StrictHostKeyChecking=yes",
      "-o",
      `UserKnownHostsFile=${knownHosts}`,
      "-o",
      "PreferredAuthentications=password",
      "-o",
      "PubkeyAuthentication=no",
      "-o",
      "NumberOfPasswordPrompts=1",
      "-o",
      "ConnectTimeout=5",
      "-p",
      String(port),
      "-l",
      `admin:${deviceId}`,
      "--",
      "127.0.0.1",
    ],
    {
      env: {
        ...process.env,
        SSH_ASKPASS: askpass,
        SSH_ASKPASS_REQUIRE: "force",
        DISPLAY: process.env.DISPLAY || ":0",
      },
      stdio: ["pipe", "pipe", "pipe"],
    },
  );
  child.stdout.setEncoding("utf8");
  let text = "",
    error = "";
  child.stdout.on("data", (data) => {
    text += data.toString();
  });
  child.stderr.on("data", (data) => {
    error += data.toString();
  });
  child.stdin.on("error", () => {});
  const closed = once(child, "close");
  const input = (value) => child.stdin.write(value);
  const wait = (needle) =>
    until(() => text.includes(needle), needle + ": " + error, 10000);
  const client = new ssh2.Client();
  client.on("error", () => {});
  try {
    await until(
      () => /[$#] $/m.test(text),
      "OpenSSH real shell: " + error,
      10000,
    );
    const row = server.store.db
      .prepare(
        "SELECT * FROM terminal_sessions WHERE transport='ssh' AND ended_at IS NULL",
      )
      .get();
    assert.ok(row);
    input("stty -echo;cd /tmp;pwd;printf '\\136SSH_READY\\136\\n'\r");
    await wait("^SSH_READY^");
    assert.ok(text.includes("/tmp\r\n"));
    input("printf '\\136SSH_WAIT\\136\\n';sleep 30\r");
    await wait("^SSH_WAIT^");
    input("\x03");
    input("printf '中%.0s' {1..2000};printf '\\n\\136SSH_UNICODE\\136\\n'\r");
    await wait("^SSH_UNICODE^");
    assert.ok(text.includes("中".repeat(2000)));
    input(
      "read -s -p 'SSH password: ' value;printf '\\n\\136SSH_SECRET_DONE\\136\\n'\r",
    );
    await wait("SSH password: ");
    input("not-in-ssh-recording\r");
    await wait("^SSH_SECRET_DONE^");
    // Device token renewal must leave this same SSH/PTY session intact.
    await new Promise((r) => setTimeout(r, 3000));
    input("printf '\\136SSH_RENEWED\\136\\n';exit\r");
    await wait("^SSH_RENEWED^");
    const [code] = await closed;
    assert.equal(code, 0, error);
    const result = server.store.db
      .prepare("SELECT * FROM terminal_sessions WHERE id=?")
      .get(row.id);
    assert.equal(result.status, "CLOSED");
    assert.equal(result.audit_complete, 1);
    const events = server.store.db
      .prepare(
        "SELECT * FROM terminal_recordings WHERE session_id=? ORDER BY seq",
      )
      .all(row.id);
    const recording = Buffer.concat(
      events
        .filter((e) => e.kind === "output")
        .map((e) => Buffer.from(JSON.parse(e.data).data, "base64")),
    ).toString();
    assert.ok(recording.includes("中".repeat(2000)));
    assert.ok(recording.includes("^SSH_RENEWED^"));
    assert.equal(recording.includes("not-in-ssh-recording"), false);
    steps.push(
      "real OpenSSH with pinned host key: platform login, Rust PTY cwd/Ctrl-C/Unicode, token renewal, exit and durable recording without hidden password",
    );
    const ready = once(client, "ready");
    client.connect({
      host: "127.0.0.1",
      port,
      username: `operator:${deviceId}`,
      password: "isolated-terminal-e2e-password",
      hostVerifier: (raw) => raw.equals(key.getPublicSSH()),
    });
    await ready;
    const stream = await new Promise((resolve, reject) =>
      client.shell({ rows: 24, cols: 80 }, (err, stream) =>
        err ? reject(err) : resolve(stream),
      ),
    );
    let resized = "";
    stream.on("data", (chunk) => {
      resized += chunk.toString();
    });
    await until(() => resized.includes("$ "), "second SSH prompt");
    stream.setWindow(42, 132, 0, 0);
    stream.write("stty -echo;stty size;printf '\\136SSH_SIZE\\136\\n'\r");
    await until(() => resized.includes("^SSH_SIZE^"), "real SSH resize");
    assert.ok(resized.includes("42 132\r\n"), resized);
    const disconnected = once(stream, "close");
    stream.write("exit\r");
    await disconnected;
    steps.push(
      "SSH window-change reaches real Linux PTY; scoped operator can connect",
    );
  } finally {
    client.destroy();
    if (child.exitCode === null) child.kill("SIGKILL");
  }
}
