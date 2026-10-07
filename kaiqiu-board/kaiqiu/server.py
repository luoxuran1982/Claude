"""本机 HTTP 服务：只监听 127.0.0.1，随机端口，每次启动一个随机令牌。"""
from __future__ import annotations

import base64
import json
import logging
import os
import secrets
import subprocess
import sys
import threading
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import quote, urlparse

from . import excel
from .paths import resource_dir
from .store import Store

log = logging.getLogger("kaiqiu")
MAX_BODY = 20 * 1024 * 1024  # 图表 PNG / CSV 上限
STATIC = {
    "/": ("index.html", "text/html; charset=utf-8"),
    "/app.js": ("app.js", "text/javascript; charset=utf-8"),
    "/model.js": ("model.js", "text/javascript; charset=utf-8"),
    "/style.css": ("style.css", "text/css; charset=utf-8"),
    "/icon.svg": ("icon.svg", "image/svg+xml"),
    "/vendor/echarts.min.js": ("vendor/echarts.min.js", "text/javascript; charset=utf-8"),
}
CSP = ("default-src 'self'; img-src 'self' data: blob:; style-src 'self' 'unsafe-inline'; "
       "script-src 'self' 'unsafe-eval'; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'")


def reveal_in_folder(path: str) -> None:
    if sys.platform == "darwin":
        subprocess.Popen(["open", "-R", path])
    elif sys.platform == "win32":
        subprocess.Popen(["explorer", "/select,", os.path.normpath(path)])
    else:
        subprocess.Popen(["xdg-open", str(Path(path).parent)])


class App:
    """服务端状态。desktop 是可选的原生窗口桥（保存对话框），浏览器模式下为 None。"""

    def __init__(self, store: Store):
        self.store = store
        self.token = secrets.token_urlsafe(18)
        self.desktop = None
        self.saved_paths: set[str] = set()
        self.last_seen = time.time()
        self.quit_event = threading.Event()
        self._xlsx: tuple[str, bytes] | None = None
        self._xlsx_lock = threading.Lock()
        self._static = resource_dir() / "web"

    def excel_bytes(self) -> tuple[str, bytes]:
        with self.store.lock:
            snap = self.store.snapshot
        if not snap:
            raise LookupError("还没有数据")
        with self._xlsx_lock:
            if not self._xlsx or self._xlsx[0] != snap["revision"]:
                self._xlsx = (snap["revision"], excel.build(snap))
            return excel.filename(snap), self._xlsx[1]

    def save(self, body: dict) -> dict:
        kind = body.get("kind")
        if kind == "xlsx":
            name, payload = self.excel_bytes()
            types = ("Excel 工作簿 (*.xlsx)",)
        elif kind in ("csv", "png"):
            name = Path(str(body.get("name") or f"导出.{kind}")).name
            if not name.lower().endswith("." + kind):
                name += "." + kind
            content = body.get("content") or ""
            if kind == "csv":
                payload = "﻿".encode() + content.encode("utf-8")  # 带 BOM，Excel 直接打开不乱码
                types = ("CSV 表格 (*.csv)",)
            else:
                payload = base64.b64decode(content.split(",", 1)[-1])
                types = ("PNG 图片 (*.png)",)
        else:
            raise ValueError("未知导出类型")
        if not self.desktop:
            return {"mode": "browser"}
        target = self.desktop.save_dialog(name, types)
        if not target:
            return {"cancelled": True}
        Path(target).write_bytes(payload)
        self.saved_paths.add(str(target))
        return {"saved": str(target)}


def make_handler(app: App, port: int):
    hosts = {f"127.0.0.1:{port}", f"localhost:{port}"}
    origins = {f"http://127.0.0.1:{port}", f"http://localhost:{port}"}

    class Handler(BaseHTTPRequestHandler):
        protocol_version = "HTTP/1.1"

        def log_message(self, fmt, *args):
            log.debug(fmt, *args)

        def send(self, code: int, body: bytes, ctype: str, extra: dict | None = None):
            self.send_response(code)
            self.send_header("Content-Type", ctype)
            self.send_header("Content-Length", str(len(body)))
            self.send_header("Cache-Control", "no-store")
            self.send_header("X-Content-Type-Options", "nosniff")
            self.send_header("Referrer-Policy", "no-referrer")
            self.send_header("Content-Security-Policy", CSP)
            for k, v in (extra or {}).items():
                self.send_header(k, v)
            self.end_headers()
            if self.command != "HEAD":
                try:
                    self.wfile.write(body)
                except (BrokenPipeError, ConnectionResetError):
                    pass

        def json(self, value, code=200, extra=None):
            self.send(code, json.dumps(value, ensure_ascii=False, allow_nan=False).encode(),
                      "application/json; charset=utf-8", extra)

        def do_GET(self):
            if self.headers.get("Host") not in hosts:  # 防 DNS 重绑定
                return self.json({"error": "forbidden"}, 403)
            path = urlparse(self.path).path
            app.last_seen = time.time()
            if path in STATIC:
                name, ctype = STATIC[path]
                return self.send(200, (app._static / name).read_bytes(), ctype)
            if path == "/api/status":
                return self.json(app.store.status())
            if path == "/api/data":
                with app.store.lock:
                    snap = app.store.snapshot
                if not snap:
                    return self.json({"error": "还没有数据，请稍候"}, 503)
                etag = f'"{snap["revision"]}"'
                if self.headers.get("If-None-Match") == etag:
                    return self.send(304, b"", "application/json", {"ETag": etag})
                return self.json(snap, extra={"ETag": etag})
            if path == "/api/export.xlsx":
                try:
                    name, payload = app.excel_bytes()
                except LookupError as exc:
                    return self.json({"error": str(exc)}, 503)
                return self.send(200, payload, "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
                                 {"Content-Disposition": f"attachment; filename=\"kaiqiu.xlsx\"; filename*=UTF-8''{quote(name)}"})
            self.json({"error": "not found"}, 404)

        do_HEAD = do_GET

        def do_POST(self):
            if (self.headers.get("Host") not in hosts
                    or self.headers.get("Origin") not in origins | {None}
                    or not secrets.compare_digest(self.headers.get("X-Kaiqiu-Token", ""), app.token)):
                return self.json({"error": "请求来源不允许"}, 403)
            try:
                size = int(self.headers.get("Content-Length", 0))
                if not 0 <= size <= MAX_BODY:
                    raise ValueError
                body = json.loads(self.rfile.read(size) or b"{}")
                if not isinstance(body, dict):
                    raise ValueError
            except ValueError:
                return self.json({"error": "请求内容无效"}, 400)
            path = urlparse(self.path).path
            app.last_seen = time.time()
            try:
                if path == "/api/refresh":
                    started = app.store.start_refresh()
                    return self.json({"started": started, **app.store.status()}, 202)
                if path == "/api/settings":
                    return self.json({"settings": app.store.set_settings(body)})
                if path == "/api/save":
                    return self.json(app.save(body))
                if path == "/api/reveal":
                    target = str(body.get("path", ""))
                    if target not in app.saved_paths:
                        return self.json({"error": "只能打开本次保存过的文件"}, 403)
                    reveal_in_folder(target)
                    return self.json({"ok": True})
                if path == "/api/open-data-dir":
                    reveal_in_folder(str(app.store.dir / "current.json"))
                    return self.json({"ok": True})
                if path == "/api/heartbeat":
                    return self.json({"ok": True})
                if path == "/api/quit":
                    app.quit_event.set()
                    return self.json({"ok": True})
            except Exception as exc:  # noqa: BLE001
                log.exception("请求失败 %s", path)
                return self.json({"error": str(exc)}, 500)
            self.json({"error": "not found"}, 404)

    return Handler


def serve(store: Store, port: int = 0) -> tuple[App, ThreadingHTTPServer]:
    app = App(store)
    httpd = ThreadingHTTPServer(("127.0.0.1", port), make_handler(app, port))
    httpd.RequestHandlerClass = make_handler(app, httpd.server_address[1])
    httpd.daemon_threads = True
    return app, httpd
