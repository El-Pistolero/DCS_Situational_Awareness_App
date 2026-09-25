"""HTTP server: the review UI, the second-screen live view, and a JSON API.

Standard library only (``http.server`` + Server-Sent Events), so running the
app on the DCS machine needs nothing beyond Python itself.
"""

from __future__ import annotations

import json
import logging
import mimetypes
import os
import threading
import time
import webbrowser
from http import HTTPStatus
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from typing import Any, Dict, Optional
from urllib.parse import parse_qs, unquote, urlparse

from .. import __version__
from ..config import Config
from ..dcs_profile import read_profile
from ..telemetry.dcs_bridge import DcsBridgeListener
from ..telemetry.live_world import LiveWorld
from ..telemetry.realtime import RealtimeTelemetryClient
from ..telemetry.replay import ReplaySource
from .store import RecordingStore
from .tiles import TileCache

log = logging.getLogger(__name__)

WEB_ROOT = Path(__file__).resolve().parent.parent / "web"
MAX_UPLOAD = 4 * 1024 * 1024 * 1024


class LiveManager:
    """Owns the live world and whichever source is feeding it."""

    def __init__(self, cfg: Config) -> None:
        self.cfg = cfg
        self.world = LiveWorld(cfg.player_names)
        self.source: Any = None
        self.source_kind: Optional[str] = None
        self.bridge: Optional[DcsBridgeListener] = None
        self._lock = threading.Lock()

    def start_bridge(self) -> Optional[str]:
        if not self.cfg.bridge_enabled:
            return None
        try:
            self.bridge = DcsBridgeListener(self.world.ingest_bridge, self.cfg.bridge_host, self.cfg.bridge_port)
            self.bridge.start()
            return None
        except OSError as exc:
            self.bridge = None
            return f"DCS bridge port {self.cfg.bridge_port} unavailable: {exc}"

    def connect_tacview(self, host: str, port: int, password: str = "") -> None:
        with self._lock:
            self._stop_source()
            client = RealtimeTelemetryClient(
                self.world, host=host, port=port, password=password,
                client_name="DCS-SA " + __version__,
                on_status=lambda s, d: self.world.set_status("tacview", s, d),
                on_reset=self.world.reset,
            )
            self.source, self.source_kind = client, "tacview"
            self.world.set_status("tacview", "connecting", f"{host}:{port}")
            client.start()

    def replay(self, path: str, speed: float, start_at: float = 0.0) -> None:
        with self._lock:
            self._stop_source()
            src = ReplaySource(
                self.world, path, speed=speed, loop=True, start_at=start_at,
                on_status=lambda s, d: self.world.set_status("replay", s, d),
                on_reset=self.world.reset,
            )
            self.source, self.source_kind = src, "replay"
            src.start()

    def disconnect(self) -> None:
        with self._lock:
            self._stop_source()
            self.world.reset()
            self.world.set_status("none", "idle", "")

    def _stop_source(self) -> None:
        if self.source is not None:
            try:
                self.source.stop()
            except Exception:  # pragma: no cover
                log.exception("stopping source")
        self.source, self.source_kind = None, None

    def shutdown(self) -> None:
        self._stop_source()
        if self.bridge:
            self.bridge.stop()


class App:
    def __init__(self, cfg: Config) -> None:
        self.cfg = cfg
        self.store = RecordingStore(cfg.all_recording_dirs(), cfg.upload_dir, cfg.player_names)
        self.live = LiveManager(cfg)
        self.warnings: list[str] = []
        self.desktop = False
        self.open_live_window = None  # set by the desktop shell
        self.profile = read_profile()
        self.tiles = TileCache(str(Path(cfg.upload_dir).parent / "tilecache"))
        # No name configured: use the active DCS logbook pilot.
        if not cfg.player_names and self.profile.get("player"):
            cfg.player_names = [str(self.profile["player"])]
            self.store.player_names = cfg.player_names
            self.live.world.player_names = [n.lower() for n in cfg.player_names]

    def status(self) -> Dict[str, Any]:
        return {
            "version": __version__,
            "recordingDirs": self.store.dirs,
            "live": self.live.world.status,
            "liveSource": self.live.source_kind,
            "bridge": {
                "enabled": self.cfg.bridge_enabled,
                "listening": self.live.bridge is not None,
                "port": self.cfg.bridge_port,
                **self.live.world.bridge_status,
            },
            "tacview": {"host": self.cfg.tacview_host, "port": self.cfg.tacview_port},
            "playerNames": self.cfg.player_names,
            "profile": self.profile,
            "desktop": self.desktop,
            "warnings": self.warnings,
        }


def make_handler(app: App):
    class Handler(BaseHTTPRequestHandler):
        server_version = f"dcs-sa/{__version__}"
        protocol_version = "HTTP/1.1"

        # -- plumbing ------------------------------------------------------------

        def log_message(self, fmt: str, *args: Any) -> None:  # quieter default log
            log.debug("%s - %s", self.address_string(), fmt % args)

        def _send(self, status: int, body: bytes, ctype: str, extra: Optional[Dict[str, str]] = None) -> None:
            self.send_response(status)
            self.send_header("Content-Type", ctype)
            self.send_header("Content-Length", str(len(body)))
            extra = dict(extra or {})
            self.send_header("Cache-Control", extra.pop("Cache-Control", "no-store"))
            for k, v in extra.items():
                self.send_header(k, v)
            self.end_headers()
            if self.command != "HEAD":
                self.wfile.write(body)

        def _json(self, obj: Any, status: int = 200) -> None:
            body = json.dumps(obj, separators=(",", ":"), allow_nan=False).encode("utf-8")
            self._send(status, body, "application/json; charset=utf-8")

        def _error(self, status: int, message: str) -> None:
            self._json({"error": message}, status)

        def _body_json(self) -> Dict[str, Any]:
            length = int(self.headers.get("Content-Length") or 0)
            if length <= 0:
                return {}
            if length > 1 << 20:
                raise ValueError("body too large")
            return json.loads(self.rfile.read(length).decode("utf-8") or "{}")

        # -- routing -------------------------------------------------------------

        def do_HEAD(self) -> None:
            self.do_GET()

        def do_GET(self) -> None:
            url = urlparse(self.path)
            path = url.path
            q = {k: v[-1] for k, v in parse_qs(url.query).items()}
            try:
                if path in ("/", "/index.html"):
                    return self._static("index.html")
                if path in ("/live", "/live.html"):
                    return self._static("live.html")
                if path.startswith("/static/"):
                    return self._static(path[len("/static/"):])
                if path.startswith("/tiles/"):
                    return self._tile(path.split("/")[2:])
                if path == "/api/status":
                    return self._json(app.status())
                if path == "/api/recordings":
                    return self._json({"recordings": app.store.scan(), "dirs": app.store.dirs})
                if path.startswith("/api/recording/"):
                    return self._recording_get(path[len("/api/recording/"):], q)
                if path == "/api/live/snapshot":
                    return self._json(app.live.world.snapshot(int(q.get("since", 0))))
                if path == "/api/live/stream":
                    return self._sse(float(q.get("rate", app.cfg.live_rate_hz)))
                return self._error(404, "not found")
            except KeyError as exc:
                return self._error(404, f"unknown id {exc}")
            except (BrokenPipeError, ConnectionResetError):
                return
            except Exception as exc:  # pragma: no cover - last-resort 500
                log.exception("GET %s failed", self.path)
                try:
                    return self._error(500, f"{exc.__class__.__name__}: {exc}")
                except OSError:
                    return

        def do_POST(self) -> None:
            url = urlparse(self.path)
            path = url.path
            try:
                if path == "/api/upload":
                    return self._upload()
                if path == "/api/live/focus":
                    body = self._body_json()
                    app.live.world.set_focus(body.get("id") or None)
                    return self._json({"ok": True, "focus": app.live.world.focus_id})
                if path == "/api/live/source":
                    return self._set_source(self._body_json())
                if path == "/api/open-live":
                    if app.open_live_window:
                        app.open_live_window()
                        return self._json({"ok": True})
                    return self._json({"ok": False})
                if path == "/api/install-bridge":
                    from ..dcs_profile import install_bridge

                    result = install_bridge()
                    app.profile = read_profile()
                    return self._json(result, 200 if result.get("ok") else 404)
                if path == "/api/player":
                    body = self._body_json()
                    names = [n for n in (body.get("names") or []) if isinstance(n, str) and n.strip()]
                    app.cfg.player_names = names
                    app.store.player_names = names
                    app.live.world.player_names = [n.lower() for n in names]
                    return self._json({"ok": True, "playerNames": names})
                return self._error(404, "not found")
            except (ValueError, json.JSONDecodeError) as exc:
                return self._error(400, str(exc))
            except KeyError as exc:
                return self._error(404, f"unknown id {exc}")
            except (BrokenPipeError, ConnectionResetError):
                return
            except Exception as exc:  # pragma: no cover
                log.exception("POST %s failed", self.path)
                return self._error(500, f"{exc.__class__.__name__}: {exc}")

        # -- static files --------------------------------------------------------

        def _static(self, rel: str) -> None:
            rel = unquote(rel).lstrip("/")
            target = (WEB_ROOT / rel).resolve()
            if WEB_ROOT not in target.parents and target != WEB_ROOT:
                return self._error(403, "forbidden")
            if not target.is_file():
                return self._error(404, "not found")
            ctype = mimetypes.guess_type(str(target))[0] or "application/octet-stream"
            if ctype.startswith("text/") or ctype in ("application/javascript",):
                ctype += "; charset=utf-8"
            if target.suffix == ".js":
                ctype = "text/javascript; charset=utf-8"
            self._send(200, target.read_bytes(), ctype)

        def _tile(self, parts) -> None:
            try:
                src, z, x, y = parts[0], int(parts[1]), int(parts[2]), int(parts[3].split(".")[0])
            except (IndexError, ValueError):
                return self._error(400, "bad tile path")
            got = app.tiles.get(src, z, x, y)
            if got is None:
                return self._error(404, "tile unavailable")
            data, ctype = got
            self._send(200, data, ctype, {"Cache-Control": "max-age=86400"})

        # -- recordings --------------------------------------------------------------

        def _recording_get(self, rest: str, q: Dict[str, str]) -> None:
            parts = [p for p in rest.split("/") if p]
            if not parts:
                return self._error(404, "missing key")
            key, action = parts[0], (parts[1] if len(parts) > 1 else "status")
            if app.store.path_for(key) is None:
                return self._error(404, "unknown recording")

            if action in ("status", "load"):
                job = app.store.ensure(key)
                return self._json(job.to_dict())

            got = app.store.get(key)
            if got is None:
                job = app.store.ensure(key)
                return self._json({"pending": True, **job.to_dict()}, 202)
            rec, report = got

            if action == "analysis":
                return self._json(report)
            if action == "playback":
                return self._json(app.store.playback(rec))
            if action == "series" and len(parts) > 2:
                chans = [c for c in q.get("channels", "").split(",") if c] or None
                return self._json(app.store.series(rec, unquote(parts[2]), chans, int(q.get("max", 4000))))
            if action == "markdown":
                md = app.store.markdown(key, q.get("focus")) or ""
                return self._send(200, md.encode("utf-8"), "text/markdown; charset=utf-8",
                                  {"Content-Disposition": 'inline; filename="debrief.md"'})
            return self._error(404, "unknown action")

        def _upload(self) -> None:
            length = int(self.headers.get("Content-Length") or 0)
            if length <= 0:
                return self._error(400, "empty upload")
            if length > MAX_UPLOAD:
                return self._error(413, "file too large")
            name = unquote(self.headers.get("X-Filename") or "upload.acmi")
            info = app.store.register_upload(name, self.rfile, length)
            return self._json(info, 201)

        # -- live ----------------------------------------------------------------

        def _set_source(self, body: Dict[str, Any]) -> None:
            kind = body.get("type")
            if kind == "tacview":
                host = str(body.get("host") or app.cfg.tacview_host)
                port = int(body.get("port") or app.cfg.tacview_port)
                app.live.connect_tacview(host, port, str(body.get("password") or ""))
            elif kind == "replay":
                key = body.get("key")
                path = app.store.path_for(key) if key else None
                if path is None:
                    return self._error(404, "unknown recording")
                app.live.replay(path, float(body.get("speed") or 1.0), float(body.get("startAt") or 0.0))
            elif kind in ("none", None):
                app.live.disconnect()
            else:
                return self._error(400, f"unknown source type {kind!r}")
            return self._json({"ok": True, "source": app.live.source_kind})

        def _sse(self, rate: float) -> None:
            rate = max(0.5, min(rate, 20.0))
            self.send_response(200)
            self.send_header("Content-Type", "text/event-stream")
            self.send_header("Cache-Control", "no-store")
            self.send_header("Connection", "keep-alive")
            self.send_header("X-Accel-Buffering", "no")
            self.end_headers()
            self.close_connection = True
            since = 0
            n = 0
            period = 1.0 / rate
            try:
                self.wfile.write(b"retry: 2000\n\n")
                while True:
                    t0 = time.monotonic()
                    snap = app.live.world.snapshot(since, include_trails=(n % 10 == 0))
                    since = snap["eventSeq"]
                    data = json.dumps(snap, separators=(",", ":"), allow_nan=False, default=str)
                    self.wfile.write(b"data: " + data.encode("utf-8") + b"\n\n")
                    self.wfile.flush()
                    n += 1
                    time.sleep(max(0.0, period - (time.monotonic() - t0)))
            except (BrokenPipeError, ConnectionResetError, OSError):
                return

    return Handler


class _Server(ThreadingHTTPServer):
    daemon_threads = True
    allow_reuse_address = True


def start(cfg: Config):
    """Start sources and the HTTP server on a background thread.

    Returns (app, httpd, url).  Used by both the console server and the
    desktop shell.
    """
    app = App(cfg)
    err = app.live.start_bridge()
    if err:
        app.warnings.append(err)
        log.warning(err)
    if cfg.replay_file:
        app.live.replay(cfg.replay_file, cfg.replay_speed)
    elif cfg.tacview_autoconnect:
        app.live.connect_tacview(cfg.tacview_host, cfg.tacview_port, cfg.tacview_password)
    httpd = _Server((cfg.host, cfg.port), make_handler(app))
    threading.Thread(target=httpd.serve_forever, kwargs={"poll_interval": 0.5},
                     name="http", daemon=True).start()
    url_host = "localhost" if cfg.host in ("0.0.0.0", "127.0.0.1", "") else cfg.host
    return app, httpd, f"http://{url_host}:{httpd.server_address[1]}/"


def stop(app: App, httpd) -> None:
    app.live.shutdown()
    httpd.shutdown()
    httpd.server_close()


def serve(cfg: Config) -> None:
    """Console mode: run until Ctrl+C, opening the default browser."""
    app, httpd, url = start(cfg)
    print(f"\n  DCS Situational Awareness {__version__}")
    print(f"  Debrief / review  : {url}")
    print(f"  Live second screen: {url}live")
    if app.live.bridge:
        print(f"  DCS bridge        : udp://{cfg.bridge_host}:{cfg.bridge_port}")
    if app.profile.get("player"):
        print(f"  DCS pilot profile : {app.profile['player']}")
    for w in app.warnings:
        print(f"  ! {w}")
    print("  Press Ctrl+C to stop.\n")
    if cfg.open_browser:
        threading.Timer(0.8, lambda: webbrowser.open(url)).start()
    try:
        while True:
            time.sleep(1.0)
    except KeyboardInterrupt:
        print("\nShutting down...")
    finally:
        stop(app, httpd)
