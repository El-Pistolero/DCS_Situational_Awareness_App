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


def _running_instance(port: int) -> Optional[str]:
    """URL of a DCS SA desktop app already running on this PC, or None."""
    import json
    import urllib.request

    url = f"http://127.0.0.1:{port}/"
    try:
        with urllib.request.urlopen(url + "api/status", timeout=1.5) as r:
            body = json.loads(r.read().decode("utf-8"))
    except (OSError, ValueError):
        return None
    return url if isinstance(body, dict) and body.get("desktop") else None


def _ask_instance(url: str, live_only: bool) -> bool:
    """Ask a running DCS SA to open the window this launch was for."""
    import json
    import urllib.request

    req = urllib.request.Request(url + ("api/open-live" if live_only else "api/open-debrief"), data=b"{}",
                                 headers={"Content-Type": "application/json"}, method="POST")
    try:
        with urllib.request.urlopen(req, timeout=3.0) as r:
            return bool(json.loads(r.read().decode("utf-8")).get("ok"))
    except (OSError, ValueError):
        return False


def run(cfg: Config, live_only: bool = False) -> int:
    from .server.app import start, stop

    # One copy at a time: a second one (the Live icon while the debrief is open,
    # or an impatient double-click) would compete with the first for DCS's data.
    existing = _running_instance(cfg.port)
    if existing and _ask_instance(existing, live_only):
        log.info("DCS SA is already running at %s: opened its window instead", existing)
        return 0

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
        main = webview.create_window("DCS SA" + (" - Live" if live_only else " - Debrief"), first,
                                     width=1480, height=920, min_size=(900, 600),
                                     background_color="#0b0f14")

        def open_debrief(key: Optional[str]) -> None:
            if live_only:
                # Started from the Live icon: the debrief gets a window of its own.
                webview.create_window("DCS SA - Debrief", url + (f"#rec={key}" if key else ""), width=1480, height=920,
                                      min_size=(900, 600), background_color="#0b0f14")
                return
            # Switch the main window to that recording (if any) and bring it forward.
            steps = [main.restore, main.show]
            if key:
                steps.insert(0, lambda: main.evaluate_js(f"location.hash='rec={key}'"))
            for step in steps:
                try:
                    step()
                except Exception:  # noqa: BLE001 - window may be closed or the backend lacks the call
                    pass

        app.open_debrief = open_debrief
        # Installing an update replaces this exe, so the app has to let go first.
        def quit_for_update() -> None:
            for win in list(getattr(webview, "windows", []) or []):
                try:
                    win.destroy()
                except Exception:  # noqa: BLE001 - already closing
                    pass

        app.quit = quit_for_update
        # Keep settings (modes, Display choices) between runs: pywebview 5 is private by default.
        storage = os.path.join(os.path.expanduser("~"), ".dcs-sa", "webview")
        os.makedirs(storage, exist_ok=True)
        try:
            webview.start(private_mode=False, storage_path=storage)
        except TypeError:  # an older pywebview without these options
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
        app.open_debrief = lambda key: launch(f"{url}#rec={key}" if key else url)
        app.quit = lambda: os._exit(0)   # no window to close in the browser fallback
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
