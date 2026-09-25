"""Desktop shell: runs the app in its own window instead of a browser tab.

This is what the Windows ``DCS-SA.exe`` launches.  The HTTP server still
exists, but only on 127.0.0.1 and only as the window's internal plumbing -
closing the window shuts everything down.

Window backends, in order of preference:

1. ``pywebview`` (bundled in the exe; uses the Edge WebView2 runtime that
   ships with Windows 10/11) - real native windows, live view in a second one.
2. Edge or Chrome in ``--app`` mode - a chromeless window, no install needed.
3. The default browser, as a last resort.
"""

from __future__ import annotations

import logging
import os
import shutil
import socket
import subprocess
import sys
import time
from typing import List, Optional

from .config import Config

log = logging.getLogger(__name__)


def _free_port(preferred: int) -> int:
    for port in (preferred, 0):
        with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as s:
            try:
                s.bind(("127.0.0.1", port))
                return s.getsockname()[1]
            except OSError:
                continue
    return preferred


def _chromium_app_browser() -> Optional[str]:
    candidates: List[str] = []
    for env in ("PROGRAMFILES(X86)", "PROGRAMFILES", "LOCALAPPDATA"):
        base = os.environ.get(env)
        if base:
            candidates += [
                os.path.join(base, "Microsoft", "Edge", "Application", "msedge.exe"),
                os.path.join(base, "Google", "Chrome", "Application", "chrome.exe"),
            ]
    for name in ("msedge", "google-chrome", "chromium", "chromium-browser", "chrome"):
        found = shutil.which(name)
        if found:
            candidates.append(found)
    return next((c for c in candidates if c and os.path.isfile(c)), None)


def run(cfg: Config, live_only: bool = False) -> int:
    from .server.app import start, stop

    cfg.host = "127.0.0.1"
    cfg.port = _free_port(cfg.port)
    cfg.open_browser = False
    app, httpd, url = start(cfg)
    app.desktop = True
    first = url + ("live" if live_only else "")

    try:
        import webview  # type: ignore[import-not-found]
    except ImportError:
        webview = None

    if webview is not None:
        def open_live() -> None:
            webview.create_window("DCS SA - Live", url + "live", width=1100, height=820,
                                  background_color="#0b0f14")

        app.open_live_window = open_live
        webview.create_window("DCS SA" + (" - Live" if live_only else " - Debrief"), first,
                              width=1480, height=920, min_size=(900, 600),
                              background_color="#0b0f14")
        try:
            webview.start()
        finally:
            stop(app, httpd)
        return 0

    browser = _chromium_app_browser()
    procs: List[subprocess.Popen] = []
    if browser:
        profile_dir = os.path.join(os.path.expanduser("~"), ".dcs-sa", "window")
        os.makedirs(profile_dir, exist_ok=True)

        def launch(target: str) -> None:
            procs.append(subprocess.Popen([browser, f"--app={target}", f"--user-data-dir={profile_dir}",
                                           "--window-size=1480,920"]))

        app.open_live_window = lambda: launch(url + "live")
        launch(first)
        print(f"DCS SA running at {url} - close the window to quit.")
        try:
            # A private --user-data-dir makes this its own browser process, so
            # we can quit once every window we opened is closed.
            while any(p.poll() is None for p in procs):
                time.sleep(1.0)
        except KeyboardInterrupt:
            pass
        finally:
            stop(app, httpd)
        return 0

    import webbrowser

    webbrowser.open(first)
    print(f"DCS SA running at {url} - press Ctrl+C to quit.")
    try:
        while True:
            time.sleep(1.0)
    except KeyboardInterrupt:
        pass
    finally:
        stop(app, httpd)
    return 0


def main() -> int:
    """Entry point for the frozen exe."""
    logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(name)s: %(message)s")
    from .shortcut import first_run

    made = first_run()
    if made:
        log.info("created shortcuts: %s", ", ".join(made))
    cfg = Config.load()
    return run(cfg, live_only="--live" in sys.argv)


if __name__ == "__main__":
    raise SystemExit(main())
