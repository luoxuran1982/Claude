"""启动入口：本机服务 + 原生窗口（pywebview：Windows 用 WebView2，macOS 用 WKWebView）。

没有 pywebview 或窗口组件不可用时，自动改用默认浏览器打开，功能相同。
"""
from __future__ import annotations

import argparse
import logging
import sys
import threading
import time
import webbrowser
from logging.handlers import RotatingFileHandler

from . import APP_NAME, __version__
from .paths import data_dir
from .server import serve
from .store import Store, now_shanghai

log = logging.getLogger("kaiqiu")
BROWSER_IDLE_EXIT = 180  # 浏览器模式：页面关闭 3 分钟后退出后台


def setup_logging(directory) -> None:
    directory.mkdir(parents=True, exist_ok=True)
    handlers = [RotatingFileHandler(directory / "kaiqiu.log", maxBytes=1_000_000, backupCount=2, encoding="utf-8")]
    if sys.stderr:
        handlers.append(logging.StreamHandler())
    logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s", handlers=handlers)


def scheduler(store: Store, stop: threading.Event) -> None:
    """窗口开着时按设置定时刷新（默认关闭）。"""
    while not stop.wait(60):
        hours = store.settings.get("periodic_hours") or 0
        age = store.snapshot_age_minutes()
        if hours and not store.progress["running"] and (age is None or age >= hours * 60):
            log.info("定时刷新")
            store.start_refresh()


class Desktop:
    """给服务端用的原生能力：保存对话框。"""

    def __init__(self, webview, window):
        self.webview, self.window = webview, window

    def save_dialog(self, filename: str, file_types: tuple[str, ...]):
        kind = getattr(getattr(self.webview, "FileDialog", None), "SAVE", None)
        if kind is None:
            kind = self.webview.SAVE_DIALOG
        result = self.window.create_file_dialog(kind, save_filename=filename, file_types=file_types)
        if isinstance(result, (list, tuple)):
            result = result[0] if result else None
        return result or None


def run_window(app, url: str, storage: str) -> bool:
    try:
        import webview
    except Exception as exc:  # noqa: BLE001
        log.info("没有 pywebview（%s），改用浏览器", exc)
        return False
    try:
        window = webview.create_window(APP_NAME, url, width=1440, height=920, min_size=(900, 620),
                                       background_color="#F5F7FB", text_select=True)
        app.desktop = Desktop(webview, window)
        kwargs = {"private_mode": False, "storage_path": storage}
        if sys.platform == "win32":
            kwargs["gui"] = "edgechromium"
        webview.start(**kwargs)
        return True
    except Exception:  # noqa: BLE001
        log.exception("原生窗口启动失败，改用浏览器")
        app.desktop = None
        return False


def run_browser(app, url: str) -> None:
    threading.Timer(0.5, lambda: webbrowser.open(url)).start()
    print(f"{APP_NAME} 已在浏览器打开：{url}\n关闭页面 3 分钟后自动退出，或按 Ctrl+C。", flush=True)
    app.last_seen = time.time()
    while not app.quit_event.wait(5):
        if time.time() - app.last_seen > BROWSER_IDLE_EXIT:
            log.info("页面已关闭，退出")
            break


def main(argv=None) -> None:
    ap = argparse.ArgumentParser(description=APP_NAME)
    ap.add_argument("--browser", action="store_true", help="用默认浏览器打开，不用独立窗口")
    ap.add_argument("--port", type=int, default=0, help="端口（默认随机）")
    ap.add_argument("--no-refresh", action="store_true", help="启动时不自动更新")
    ap.add_argument("--serve-only", action="store_true", help="只启动服务（开发/测试用）")
    args = ap.parse_args(argv)

    directory = data_dir()
    setup_logging(directory)
    store = Store(directory)
    app, httpd = serve(store, args.port)
    port = httpd.server_address[1]
    url = f"http://127.0.0.1:{port}/?t={app.token}"
    threading.Thread(target=httpd.serve_forever, name="http", daemon=True).start()
    log.info("%s %s 启动于 %s，数据目录 %s", APP_NAME, __version__, now_shanghai().isoformat(timespec="seconds"), directory)

    if not args.no_refresh and store.should_refresh_on_open():
        store.start_refresh()
    stop = threading.Event()
    threading.Thread(target=scheduler, args=(store, stop), name="scheduler", daemon=True).start()

    try:
        if args.serve_only:
            print(url, flush=True)
            app.quit_event.wait()
        elif args.browser or not run_window(app, url, str(directory / "webview")):
            run_browser(app, url)
    except KeyboardInterrupt:
        pass
    finally:
        stop.set()
        httpd.shutdown()
        httpd.server_close()
        log.info("已退出")
