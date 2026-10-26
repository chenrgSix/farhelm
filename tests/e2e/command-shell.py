"""Real local PTY verification; isolated HOME, no user profiles or network."""
import base64
import errno
import json
import os
import pty
import re
import select
import signal
import sys
import tempfile
import time

config = json.load(sys.stdin)
token = "11111111-2222-4333-8444-555555555555"
with tempfile.TemporaryDirectory(prefix="farhelm-shell-test-") as home:
    child, master = pty.fork()
    if child == 0:
        env = dict(os.environ, HOME=home, SHELL=config["shell"], TERM="xterm-256color")
        env.pop("ZDOTDIR", None)
        if config.get("hook"):
            env.update(PROMPT_COMMAND=config["hook"], FARHELM_COMMAND_TOKEN=token)
            os.execve(config["shell"], [config["shell"], "--noprofile", "--norc", "-i"], env)
        else:
            os.execve("/bin/sh", ["sh", "-c", config["script"]], env)
    raw = bytearray()
    def read_until(predicate, timeout=6):
        end = time.monotonic() + timeout
        while time.monotonic() < end:
            if predicate(bytes(raw)):
                return
            if select.select([master], [], [], 0.05)[0]:
                try:
                    data = os.read(master, 65536)
                except OSError as exc:
                    if exc.errno == errno.EIO:
                        break
                    raise
                if not data:
                    break
                raw.extend(data)
        if not predicate(bytes(raw)):
            raise AssertionError("PTY timed out: " + repr(bytes(raw)[-1500:]))
    def markers():
        return re.findall(rb"\x1b\]777;farhelm;" + token.encode() + rb";([^\x07]*)\x07", bytes(raw))
    def ends():
        return len([m for m in markers() if m.startswith(b"E;")])
    def run(line):
        previous = ends()
        os.write(master, line.encode() + b"\r")
        read_until(lambda _: ends() > previous)
    try:
        read_until(lambda data: b";R;" in data)
        run("printf 'hello-command\\n'")
        run("false")
        run("echo discarded\x15echo edited")
        run("printf '%s\\n' 'multi\nline'")
        previous = ends()
        os.write(master, b"read -s hidden; printf 'hidden-finished\\n'\r")
        # Wait for the shell start marker, not a guessed password-prompt delay.
        before = len([m for m in markers() if m.startswith(b"C;")])
        read_until(lambda _: len([m for m in markers() if m.startswith(b"C;")]) > before)
        # The command hook precedes read enabling no-echo; wait for terminal flags.
        import termios
        deadline = time.monotonic() + 3
        while termios.tcgetattr(master)[3] & termios.ECHO:
            if time.monotonic() > deadline:
                raise AssertionError("read did not disable echo")
            time.sleep(0.01)
        os.write(master, b"do-not-record-hidden-value\r")
        read_until(lambda _: ends() > previous)
        run("printf 'after-hidden\\n'")
        os.write(master, b"exit\r")
        read_until(lambda data: any(m.startswith(b"C;") and base64.b64decode(m[2:]) == b"exit" for m in markers()))
        commands = [base64.b64decode(m[2:]).decode() for m in markers() if m.startswith(b"C;")]
        codes = [int(m[2:]) for m in markers() if m.startswith(b"E;")]
        assert "do-not-record-hidden-value" not in str(commands)
        assert b"do-not-record-hidden-value" not in raw
        assert "echo edited" in commands and not any("discarded" in c for c in commands)
        assert any("multi\nline" in c for c in commands)
        assert "false" in commands and codes[commands.index("false")] == 1
        print(json.dumps({"commands": commands, "codes": codes, "hidden_input_absent": True}))
    finally:
        try:
            os.kill(child, signal.SIGKILL)
        except ProcessLookupError:
            pass
        os.close(master)
        os.waitpid(child, 0)
