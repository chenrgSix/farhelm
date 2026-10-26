import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFileSync, existsSync } from "node:fs";
import { terminalShell } from "../src/terminal-shell.js";
const token = "11111111-2222-4333-8444-555555555555";
for (const mode of ["agent", "bash", "zsh"]) {
  const shell = mode === "zsh" ? "/bin/zsh" : "/bin/bash";
  test(
    `actual ${mode} PTY: accepted lines, editing, multiline, status and hidden input`,
    { skip: !existsSync(shell) },
    () => {
      const result = JSON.parse(
        execFileSync("python3", ["../../tests/e2e/command-shell.py"], {
          input: JSON.stringify({
            shell,
            ...(mode === "agent"
              ? {
                  hook: readFileSync(
                    "../../lib/terminal-command-hooks.bash",
                    "utf8",
                  ),
                }
              : { script: terminalShell(token) }),
          }),
          timeout: 20000,
          encoding: "utf8",
        }),
      );
      assert.equal(result.hidden_input_absent, true);
      assert.equal(
        result.commands.filter((c: string) => c === "false").length,
        1,
      );
    },
  );
}
