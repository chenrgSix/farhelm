"""Relay the Farhelm recorded terminal protocol over WebSocket."""

import base64
import json
import os
import re
import select
import shlex
import sys
import time
from contextlib import contextmanager, suppress
from urllib.parse import urlsplit, urlunsplit
from uuid import uuid4


class TerminalError(Exception):
    pass


def write_output(data):
    if data:
        sys.stdout.buffer.write(data)
        sys.stdout.buffer.flush()


class CommandOutput:
    """Extract the remote command status, including markers split across frames."""

    def __init__(self, command):
        if not command.strip() or any(ord(c) < 32 or ord(c) == 127 for c in command):
            raise TerminalError("--command 需要一条非空的单行 Shell 命令")
        nonce = uuid4().hex
        prefix = b"\x1e" + nonce.encode("ascii") + b":"
        self.marker = re.compile(re.escape(prefix) + rb"([0-9]{1,3})\x1f")
        self.tail_limit = len(prefix) + 3
        self.tail = b""
        self.exit_code = None
        script = (
            f"/bin/sh -c {shlex.quote(command)}; status=$?; "
            f'printf \'\\036{nonce}:%s\\037\' "$status"; exit "$status"'
        )
        self.input = ("exec /bin/sh -c " + shlex.quote(script) + "\r").encode("utf-8")
        # Keep the wrapped command within the Linux PTY's canonical line limit.
        if len(self.input) > 4096:
            raise TerminalError("--command 包装后超过终端的单行输入上限，请缩短命令")

    def feed(self, data):
        if self.exit_code is not None:
            write_output(data)
            return
        combined = self.tail + data
        marker = self.marker.search(combined)
        if marker:
            self.exit_code = int(marker[1])
            write_output(combined[: marker.start()] + combined[marker.end() :])
            self.tail = b""
        else:
            write_output(combined[: -self.tail_limit])
            self.tail = combined[-self.tail_limit :]

    def flush(self):
        write_output(self.tail)


@contextmanager
def raw_terminal(fd):
    if fd is None:
        yield
        return
    import termios
    import tty

    settings = termios.tcgetattr(fd)
    try:
        tty.setraw(fd)
        yield
    finally:
        termios.tcsetattr(fd, termios.TCSAFLUSH, settings)


def terminal_size(fd):
    if fd is not None:
        try:
            cols, rows = os.get_terminal_size(fd)
            return {"cols": max(20, min(cols, 500)), "rows": max(5, min(rows, 200))}
        except OSError:
            pass
    return {"cols": 80, "rows": 24}


def send(socket, kind, body):
    socket.send(json.dumps({"v": 1, "type": kind, "body": body}))


def send_input(socket, data):
    send(socket, "terminal.input", {"data": base64.b64encode(data).decode("ascii")})


def receive(socket, timeout):
    try:
        frame = socket.recv(timeout=timeout)
    except TimeoutError:
        return None
    try:
        message = json.loads(frame) if isinstance(frame, str) else None
    except ValueError:
        message = None
    if (
        not isinstance(message, dict)
        or message.get("v") != 1
        or not isinstance(message.get("type"), str)
        or not isinstance(message.get("body"), dict)
    ):
        raise TerminalError("平台返回了无效的终端消息")
    return message["type"], message["body"]


def relay(socket, fd, size, command, seconds):
    ready = False
    paused = False
    deadline = time.monotonic() + 30
    while True:
        remaining = None if deadline is None else deadline - time.monotonic()
        if remaining is not None and remaining <= 0:
            raise TerminalError("等待终端会话结束超时" if ready else "等待终端就绪超时")
        timeout = remaining
        if fd is not None:
            timeout = 0.05 if remaining is None else min(0.05, remaining)
        event = receive(socket, timeout)
        if event is not None:
            kind, body = event
            if kind == "terminal.ready" and not ready:
                ready = True
                deadline = None if seconds is None else time.monotonic() + seconds
                if command is not None:
                    send_input(socket, command.input)
            elif kind == "terminal.output":
                try:
                    data = base64.b64decode(body["data"], validate=True)
                except (KeyError, TypeError, ValueError):
                    raise TerminalError("平台返回了无效的终端输出") from None
                if command is None:
                    write_output(data)
                else:
                    command.feed(data)
            elif kind == "terminal.closed":
                return body.get("reason")
            elif kind == "terminal.activity_warning" and isinstance(
                body.get("message"), str
            ):
                print(re.sub(r"[\x00-\x1f\x7f]", "", body["message"]), file=sys.stderr)
            elif kind == "terminal.reconnecting":
                paused = True
                print("Agent 断开，正在等待恢复原终端。", file=sys.stderr)
            elif kind == "terminal.resumed":
                if fd is not None:
                    import termios

                    termios.tcflush(fd, termios.TCIFLUSH)
                paused = False
                print("原终端已恢复。", file=sys.stderr)
        if fd is not None and ready:
            if select.select([fd], [], [], 0)[0]:
                data = os.read(fd, 8192)
                if not data:
                    raise TerminalError("本地终端输入已关闭")
                if not paused:
                    send_input(socket, data)
            current_size = terminal_size(fd)
            if not paused and current_size != size:
                send(socket, "terminal.resize", current_size)
                size = current_size


def run_terminal(client, device, shell_command, seconds):
    try:
        from websockets import __version__
        from websockets.exceptions import InvalidStatus, WebSocketException
        from websockets.sync.client import ClientConnection, connect

        version = re.match(r"17\.(\d+)(?:\.|$)", __version__)
        if version is None or int(version[1]) < 4:
            raise ImportError
    except ImportError:
        raise TerminalError(
            "terminal 需要 Python 3.11+ 和 WebSocket 依赖，请安装 requirements-terminal.txt"
        ) from None

    class TerminalConnection(ClientConnection):
        def handshake(self, *args, **kwargs):
            try:
                return super().handshake(*args, **kwargs)
            except InvalidStatus as error:
                # Report the rejection before connect() can follow its Location.
                raise TerminalError(
                    f"WebSocket 握手失败（HTTP {error.response.status_code}）"
                ) from None

    fd = None
    command = None
    if shell_command is None:
        if os.name != "posix" or not (sys.stdin.isatty() and sys.stdout.isatty()):
            raise TerminalError(
                "交互模式需要 Linux 或 macOS 的本地终端，非交互调用请使用 --command"
            )
        fd = sys.stdin.fileno()
    else:
        command = CommandOutput(shell_command)
        seconds = 60 if seconds is None else seconds
    size = terminal_size(fd)
    base = urlsplit(client.base)
    secure = base.scheme == "https"
    origin = base.scheme + "://" + base.netloc
    url = urlunsplit(
        (
            "wss" if secure else "ws",
            base.netloc,
            base.path + "/api/v1/terminal/ws",
            "",
            "",
        )
    )
    created = client.request(
        "POST", "/terminal-sessions", {"v": 1, "device_id": device, **size}
    )
    session_id = created.get("session_id") if isinstance(created, dict) else None
    if not isinstance(session_id, str) or not re.fullmatch(
        r"[A-Za-z0-9_-]{1,128}", session_id
    ):
        raise TerminalError("平台未返回有效的终端会话 ID")
    closed = False
    try:
        ticket = created.get("ticket")
        if not isinstance(ticket, str) or not re.fullmatch(
            r"[A-Za-z0-9_-]{43}", ticket
        ):
            raise TerminalError("平台未返回有效的终端票据")
        with connect(
            url,
            origin=origin,
            ssl=client.context if secure else None,
            open_timeout=10,
            close_timeout=2,
            max_size=65536,
            compression=None,
            create_connection=TerminalConnection,
            legacy=False,
        ) as socket:
            # Only the ticket is sent over WebSocket, after the same-origin handshake.
            send(
                socket, "terminal.attach", {"session_id": session_id, "ticket": ticket}
            )
            with raw_terminal(fd):
                reason = relay(socket, fd, size, command, seconds)
                closed = True
        if reason != "SHELL_EXIT" and not (
            command is None and reason == "USER_DISCONNECTED"
        ):
            code = (
                reason
                if isinstance(reason, str) and re.fullmatch(r"[A-Z0-9_]{1,128}", reason)
                else "UNKNOWN"
            )
            raise TerminalError(f"终端会话 {session_id} 已中断（{code}）")
        if command is None:
            return 0
        if command.exit_code not in range(256):
            raise TerminalError(f"未收到命令退出状态，请核对会话 {session_id} 的录制")
        return command.exit_code
    except (WebSocketException, OSError, TimeoutError):
        raise TerminalError(
            f"终端连接失败，请核对平台入口、证书或会话 {session_id} 的记录"
        ) from None
    finally:
        if not closed:
            # A failed attach can leave a reserved session until its ticket expires.
            with suppress(Exception):
                client.request(
                    "POST",
                    f"/terminal-sessions/{session_id}/close",
                    {"v": 1},
                    timeout=3,
                )
        if command is not None:
            command.flush()
