#!/usr/bin/env python3
"""Farhelm HTTP client; secrets are read inside the process and never printed."""
import argparse
import json
import os
from pathlib import Path
import re
import ssl
import sys
import time
import urllib.error
import urllib.parse
import urllib.request

TERMINAL = {"SUCCEEDED", "FAILED", "TIMED_OUT", "CANCELLED", "EXPIRED", "UNKNOWN"}
MAX_RESPONSE = 8 * 1024 * 1024


class ClientError(Exception):
    pass


class NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        raise ClientError("平台返回重定向；请核实 FARHELM_URL，凭据未转发到新地址")


class Client:
    def __init__(self):
        self.base = os.environ.get("FARHELM_URL", "").rstrip("/")
        parsed = urllib.parse.urlsplit(self.base)
        if (parsed.scheme not in {"http", "https"} or not parsed.hostname
                or parsed.username is not None or parsed.password is not None
                or parsed.query or parsed.fragment or self.base.endswith("/api/v1")
                or any(ord(c) < 33 for c in self.base)):
            raise ClientError("FARHELM_URL 应填写平台网页地址，不包含账号、查询参数或 /api/v1")
        secret_file = os.environ.get("FARHELM_API_TOKEN_FILE")
        try:
            if secret_file:
                with Path(secret_file).expanduser().open(encoding="utf-8") as stream:
                    self.secret = stream.read(4096).strip()
            else:
                self.secret = os.environ.get("FARHELM_API_TOKEN", "").strip()
        except OSError:
            raise ClientError("无法读取 FARHELM_API_TOKEN_FILE") from None
        if not re.fullmatch(r"fh_api_[A-Za-z0-9_-]{43}", self.secret):
            raise ClientError("请配置有效的 FARHELM_API_TOKEN_FILE 或 FARHELM_API_TOKEN")
        try:
            context = ssl.create_default_context(cafile=os.environ.get("FARHELM_CA_FILE") or None)
        except (OSError, ssl.SSLError):
            raise ClientError("无法加载 FARHELM_CA_FILE") from None
        self.opener = urllib.request.build_opener(NoRedirect(), urllib.request.HTTPSHandler(context=context))

    def request(self, method, path, body=None, key=None, raw=False, timeout=30):
        parsed = urllib.parse.urlsplit(path)
        if (not path.startswith("/") or path.startswith("//") or parsed.scheme
                or parsed.netloc or parsed.fragment or "\\" in path
                or any(ord(c) < 32 for c in path)
                or any(p in {".", ".."} for p in urllib.parse.unquote(parsed.path).split("/"))):
            raise ClientError("接口路径必须是 /devices 等相对 API 路径")
        if method == "POST" and parsed.path == "/commands" and not key:
            raise ClientError("创建任务必须提供 --idempotency-key；未知结果使用同一个键核实")
        headers = {"Authorization": "Bearer " + self.secret, "Accept": "application/json, application/octet-stream", "User-Agent": "Farhelm-Skill/1"}
        if key:
            if not re.fullmatch(r"[A-Za-z0-9_.:-]{1,128}", key):
                raise ClientError("幂等键只允许字母、数字及 _.:-，最长 128 个字符")
            headers["Idempotency-Key"] = key
        encoded = None
        if body is not None:
            encoded = json.dumps(body, ensure_ascii=False).encode("utf-8")
            headers["Content-Type"] = "application/json"
        req = urllib.request.Request(self.base + "/api/v1" + path, data=encoded, headers=headers, method=method)
        try:
            with self.opener.open(req, timeout=timeout) as response:
                data = response.read(MAX_RESPONSE + 1)
                if len(data) > MAX_RESPONSE:
                    raise ClientError("响应过大，请缩小查询或分页读取")
                if raw:
                    return data
                if response.headers.get_content_type() != "application/json":
                    raise ClientError("返回非 JSON 内容，请核实网页入口及 API 代理配置")
                return json.loads(data)
        except urllib.error.HTTPError as e:
            code = "REQUEST_FAILED"
            try:
                value = json.loads(e.read(4096)).get("error", "")
                if isinstance(value, str) and re.fullmatch(r"[A-Z0-9_]{1,100}", value):
                    code = value
            except (ValueError, AttributeError):
                pass
            raise ClientError(f"HTTP {e.code}: {code}") from None
        except (urllib.error.URLError, TimeoutError, OSError):
            raise ClientError("网络或证书校验失败；写操作结果可能未知，请核实后再操作，勿盲目重试") from None
        except (ValueError, UnicodeError):
            raise ClientError("响应不是有效 JSON") from None


def parser():
    p = argparse.ArgumentParser(description="Farhelm API（凭据仅从环境或文件读取）")
    sub = p.add_subparsers(dest="command", required=True)
    sub.add_parser("me")
    sub.add_parser("devices")
    request = sub.add_parser("request")
    request.add_argument("method", choices=["GET", "POST", "PUT"])
    request.add_argument("path")
    request.add_argument("--body-file", help="JSON 文件，- 表示标准输入")
    request.add_argument("--idempotency-key")
    listing = sub.add_parser("list")
    listing.add_argument("kind", choices=["tasks", "audit", "terminal-sessions"])
    listing.add_argument("--device-id")
    listing.add_argument("--cursor")
    listing.add_argument("--limit", type=int, default=50, choices=range(1, 101), metavar="1..100")
    execute = sub.add_parser("exec")
    execute.add_argument("device")
    execute.add_argument("--cwd", required=True)
    execute.add_argument("--idempotency-key", required=True)
    execute.add_argument("--timeout-ms", type=int, default=30000)
    execute.add_argument("--ttl-seconds", type=int, default=300)
    execute.add_argument("--max-output-bytes", type=int, default=1048576)
    wait = sub.add_parser("wait")
    wait.add_argument("task")
    wait.add_argument("--seconds", type=int, default=30, choices=range(1, 601), metavar="1..600")
    output = sub.add_parser("output")
    output.add_argument("task")
    output.add_argument("stream", choices=["stdout", "stderr"])
    recording = sub.add_parser("recording")
    recording.add_argument("session")
    recording.add_argument("--after", type=int, default=0)
    return p


def main(argv=None):
    args_raw = list(sys.argv[1:] if argv is None else argv)
    command_argv = []
    if args_raw and args_raw[0] == "exec" and "--" in args_raw:
        offset = args_raw.index("--")
        command_argv, args_raw = args_raw[offset + 1:], args_raw[:offset]
    p = parser()
    args = p.parse_args(args_raw)
    if args.command == "exec" and not command_argv:
        p.error("exec 需要 -- 后的可执行程序及参数")
    try:
        client = Client()
        esc = lambda value: urllib.parse.quote(value, safe="")
        if args.command in {"me", "devices"}:
            result = client.request("GET", "/" + args.command)
        elif args.command == "request":
            body = None
            if args.body_file:
                try:
                    body = json.loads(sys.stdin.read() if args.body_file == "-" else Path(args.body_file).read_text(encoding="utf-8"))
                except (OSError, ValueError):
                    raise ClientError("无法读取有效的 JSON 请求文件") from None
            elif args.method != "GET":
                body = {"v": 1}
            result = client.request(args.method, args.path, body, args.idempotency_key)
        elif args.command == "list":
            query = {"limit": args.limit}
            if args.device_id:
                query["device_id"] = args.device_id
            if args.cursor:
                query["cursor"] = args.cursor
            result = client.request("GET", "/" + args.kind + "?" + urllib.parse.urlencode(query))
        elif args.command == "exec":
            result = client.request("POST", "/commands", {"v": 1, "device_id": args.device, "argv": command_argv, "cwd": args.cwd, "timeout_ms": args.timeout_ms, "max_output_bytes": args.max_output_bytes, "ttl_seconds": args.ttl_seconds}, args.idempotency_key)
        elif args.command == "wait":
            end = time.monotonic() + args.seconds
            result = None
            while True:
                remaining = end - time.monotonic()
                if remaining <= 0:
                    break
                result = client.request("GET", "/tasks/" + esc(args.task), timeout=max(0.1, min(30, remaining)))
                if result.get("status") in TERMINAL:
                    break
                time.sleep(min(1, max(0, end - time.monotonic())))
        elif args.command == "output":
            sys.stdout.buffer.write(client.request("GET", "/tasks/" + esc(args.task) + "/output/" + args.stream, raw=True))
            return 0
        else:
            result = client.request("GET", "/terminal-sessions/" + esc(args.session) + "/recording?after=" + str(args.after))
        print(json.dumps(result, ensure_ascii=False, indent=2))
        return 0
    except ClientError as error:
        print(str(error), file=sys.stderr)
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
