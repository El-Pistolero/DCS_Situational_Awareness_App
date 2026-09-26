"""HTTP server: the review UI, the second-screen live view, and a JSON API.

Standard library only (``http.server`` + Server-Sent Events), so running the
app on the DCS machine needs nothing beyond Python itself.
"""

from __future__ import annotations

import ipaddress
import json
import logging
import mimetypes
import os
import re
import socket
import sys
import threading
import time
import webbrowser
from http import HTTPStatus
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from typing import Any, Dict, List, Optional
from urllib.parse import parse_qs, unquote, urlparse

from .. import __version__
from ..config import Config
from .. import usersettings
from ..career import CareerStore, totals as career_totals
from ..diagnostics import console, install as install_console
from ..update import REPO as UPDATE_REPO, RELEASES_PAGE, Downloader, UpdateChecker, launch_installer
from ..dcs_profile import read_profile
from ..telemetry.dcs_bridge import DcsBridgeListener
from ..telemetry.live_world import LiveWorld
from ..telemetry.realtime import RealtimeTelemetryClient
from ..telemetry.replay import ReplaySource
from .store import RecordingStore
from .tiles import TileCache
from ..dcsmap import DcsMapStore
from ..flightlog import FlightRecorder

log = logging.getLogger(__name__)

WEB_ROOT = Path(__file__).resolve().parent.parent / "web"
# The step-by-step guide: the repo's GETTING_STARTED.md (bundled next to dcs_sa in the exe).
GUIDE = WEB_ROOT.parent.parent / "GETTING_STARTED.md"
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
        def on_packet(p):
            kind = p.get("type")
            rec = getattr(self, "recorder", None)
            if kind == "dcs-events":
                events = [e for e in (p.get("events") or []) if isinstance(e, dict)]
                self.world.on_dcs_events(events)
                if rec is not None:
                    rec.on_events(events)
                return
            dcsmap = getattr(self, "dcsmap", None)
            if kind == "dcs-hook" and rec is not None:
                rec.on_hook_hello(p)
            if dcsmap is not None and dcsmap.on_packet(p):
                return
            self.world.ingest_bridge(p)
            if rec is not None:
                rec.on_bridge(p)

        try:
            self.bridge = DcsBridgeListener(on_packet, self.cfg.bridge_host, self.cfg.bridge_port)
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
        rec = getattr(self, "recorder", None)
        if rec is not None:
            rec.close()


class App:
    def __init__(self, cfg: Config) -> None:
        self.cfg = cfg
        self.store = RecordingStore(cfg.all_recording_dirs(), cfg.upload_dir, cfg.player_names)
        self.live = LiveManager(cfg)
        self.warnings: list[str] = []
        self.desktop = False
        self.open_live_window = None  # set by the desktop shell
        self.open_debrief = None      # (key) -> show that recording in the debrief window
        self.profile = read_profile()
        self.updates = UpdateChecker(cfg.update_check)
        self.downloads = Downloader(Path(cfg.upload_dir).parent / "updates")
        self.career = CareerStore(str(Path(cfg.upload_dir).parent / "career.json"))
        self.updates.on_available = self._queue_update
        self.store.career = self.career
        self.quit: Any = None   # set by the desktop shell, to close for an install
        self.tiles = TileCache(str(Path(cfg.upload_dir).parent / "tilecache"))
        self.dcsmap = DcsMapStore(str(Path(cfg.upload_dir).parent / "tilecache" / "dcs"))
        self.store.extras = lambda: {"flightlog_dir": self.flightlog_dir, "airbases": self.dcsmap.airbases}
        self.live.dcsmap = self.dcsmap
        self.flightlog_dir = str(Path(cfg.upload_dir).parent / "flightlogs")
        self.live.recorder = FlightRecorder(self.flightlog_dir)
        # No name configured: names picked with "This is me", then the active DCS logbook pilot.
        if not cfg.player_names:
            names = [n for n in usersettings.load().get("playerNames") or [] if isinstance(n, str) and n.strip()]
            if self.profile.get("player"):
                names.append(str(self.profile["player"]))
            if names:
                self._set_player_names(list(dict.fromkeys(names)))

    def _set_player_names(self, names: List[str]) -> None:
        self.cfg.player_names = names
        self.store.player_names = names
        self.live.world.player_names = [n.lower() for n in names]

    def auto_download(self) -> bool:
        saved = usersettings.load().get("autoDownloadUpdates")
        return bool(self.cfg.update_auto_download if saved is None else saved)

    def _queue_update(self, state: Dict[str, Any]) -> None:
        """An update exists: fetch it now so it is ready when the user looks."""
        if sys.platform != "win32" or not self.auto_download() or not state.get("download"):
            return
        log.info("Update %s found; downloading it in the background", state.get("latest"))
        self.downloads.start(str(state.get("latest")), str(state["download"]),
                             state.get("sha256"), int(state.get("size") or 0))

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
            "dcsMap": self.dcsmap.status(),
            "desktop": self.desktop,
            "platform": sys.platform,
            "autoDownload": self.auto_download(),
            "update": self.updates.status(),
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

        def _read_body(self) -> bytes:
            """Consume the request body exactly once, whatever the route does."""
            if getattr(self, "_body", None) is not None:
                return self._body
            length = int(self.headers.get("Content-Length") or 0)
            self._body = self.rfile.read(length) if 0 < length <= (1 << 20) else b""
            if length > (1 << 20):
                # Too big to hold: drain it so the connection stays usable.
                left = length
                while left > 0:
                    chunk = self.rfile.read(min(left, 65536))
                    if not chunk:
                        break
                    left -= len(chunk)
                raise ValueError("body too large")
            return self._body

        def _body_json(self) -> Dict[str, Any]:
            return json.loads(self._read_body().decode("utf-8") or "{}")

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
                if path in ("/guide", "/guide.html"):
                    return self._static("guide.html")
                if path in ("/career", "/career.html"):
                    return self._static("career.html")
                if path == "/api/career":
                    profile = q.get("profile") or "all"
                    rows = app.career.records(profile)
                    return self._json({
                        "profiles": app.career.profiles(),
                        "profile": profile,
                        "current": (app.cfg.player_names or [None])[0],
                        "totals": career_totals(rows),
                        "missions": rows,
                    })
                if path == "/api/guide":
                    if not GUIDE.is_file():
                        return self._error(404, "guide not found")
                    return self._send(200, GUIDE.read_bytes(), "text/markdown; charset=utf-8")
                if path.startswith("/static/"):
                    return self._static(path[len("/static/"):])
                if path.startswith("/tiles/dcs/"):
                    return self._dcs_tile(path.split("/")[3:])
                if path == "/api/dcsmap":
                    lon, lat = float(q.get("lon", "nan")), float(q.get("lat", "nan"))
                    near = app.dcsmap.airbases_near(lon, lat) if lon == lon and lat == lat else app.dcsmap.airbases
                    return self._json({**app.dcsmap.status(), "airbaseList": near})
                if path.startswith("/tiles/"):
                    return self._tile(path.split("/")[2:])
                if path == "/api/status":
                    return self._json(app.status())
                if path == "/api/update":
                    return self._json({**app.updates.status(force=q.get("force") == "1"),
                                       "install": app.downloads.status()})
                if path == "/api/console":
                    since = int(q.get("since") or 0)
                    return self._json({"entries": console.entries(since), **console.counts(),
                                       "startedAt": console.started})
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

        def _foreign_request(self) -> bool:
            """A POST that didn't come from this app's own pages.

            Any website open in the browser can send POSTs to localhost; the
            browser then names that site in Origin.  A Host that isn't this PC
            (an IP, localhost or its own name) means a DNS-rebinding trick.
            """
            host = (self.headers.get("Host") or "").strip().lower()
            origin = (self.headers.get("Origin") or "").strip().lower()
            if origin and urlparse(origin).netloc != host:
                return True
            if (self.headers.get("Sec-Fetch-Site") or "").lower() == "cross-site":
                return True
            name = urlparse("//" + host).hostname or ""
            if not name or name == "localhost" or name.endswith(".localhost"):
                return False
            try:
                ipaddress.ip_address(name)
                return False
            except ValueError:
                pass
            own = socket.gethostname().lower()
            return name.split(".")[0] != own.split(".")[0]

        def do_POST(self) -> None:
            url = urlparse(self.path)
            path = url.path
            self._body = None
            if self._foreign_request():
                log.warning("Refused POST %s from %s (Host %s)", path, self.headers.get("Origin"), self.headers.get("Host"))
                return self._error(403, "request from another website refused")
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
                if path == "/api/open-debrief":
                    key = str(self._body_json().get("key") or "")
                    if not key:
                        # No recording: just bring the debrief window forward (a second launch).
                        if app.open_debrief:
                            app.open_debrief(None)
                            return self._json({"ok": True})
                        return self._json({"ok": False})
                    if not re.fullmatch(r"[0-9a-f]{16}", key) or app.store.path_for(key) is None:
                        return self._error(404, "unknown recording")
                    if app.open_debrief:
                        app.open_debrief(key)
                        return self._json({"ok": True})
                    return self._json({"ok": False})
                if path == "/api/update/download":
                    up = app.updates.status()
                    if not up.get("available") or not up.get("download"):
                        return self._json({"ok": False, "error": "no update to download"})
                    if os.name != "nt":
                        return self._json({"ok": False, "error": "the installer only runs on Windows"})
                    state = app.downloads.start(str(up.get("latest")), str(up["download"]),
                                                up.get("sha256"), int(up.get("size") or 0))
                    return self._json({"ok": True, "install": state})
                if path == "/api/update/install":
                    installer = app.downloads.ready_file()
                    if installer is None:
                        return self._json({"ok": False, "error": "nothing downloaded yet"})
                    try:
                        launch_installer(installer)
                    except (OSError, RuntimeError) as exc:
                        log.warning("Could not start the installer: %s", exc)
                        return self._json({"ok": False, "error": str(exc)})
                    log.info("Installing the update; DCS SA will close and reopen")
                    # The running exe cannot be replaced, so step out of the way.
                    threading.Timer(1.0, lambda: app.quit and app.quit()).start()
                    return self._json({"ok": True})
                if path == "/api/open-release":
                    # Opens the project's own releases page in the system browser.
                    # No URL comes from the page, so this can't be pointed elsewhere.
                    target = str(app.updates.status().get("page") or RELEASES_PAGE)
                    if not target.startswith(f"https://github.com/{UPDATE_REPO}/"):
                        target = RELEASES_PAGE
                    webbrowser.open(target)
                    return self._json({"ok": True, "url": target})
                if path == "/api/shortcut":
                    from ..shortcut import install_shortcuts

                    try:
                        return self._json({"ok": True, "created": install_shortcuts()})
                    except (OSError, ValueError) as exc:
                        return self._json({"ok": False, "error": str(exc)}, 500)
                if path == "/api/install-bridge":
                    from ..dcs_profile import install_bridge

                    result = install_bridge()
                    app.profile = read_profile()
                    return self._json(result, 200 if result.get("ok") else 404)
                if path == "/api/console":
                    body = self._body_json()
                    if body.get("clear"):
                        console.clear()
                        log.info("Console cleared")
                        return self._json({"ok": True})
                    level = str(body.get("level") or "ERROR").upper()
                    if level not in ("INFO", "WARNING", "ERROR"):
                        return self._error(400, "unknown level")
                    console.add(level, str(body.get("message") or "")[:2000], source="page")
                    return self._json({"ok": True})
                if path == "/api/player":
                    # "Remember this name as me": kept for the next runs too.
                    body = self._body_json()
                    names = list(dict.fromkeys(n.strip() for n in (body.get("names") or [])
                                               if isinstance(n, str) and n.strip()))[:8]
                    app._set_player_names(names)
                    usersettings.update(playerNames=names or None)
                    return self._json({"ok": True, "playerNames": names})
                if path == "/api/career/include":
                    body = self._body_json()
                    key = str(body.get("key") or "")
                    if not app.career.set_included(key, bool(body.get("included", True))):
                        return self._error(404, "unknown mission")
                    return self._json({"ok": True, "key": key, "included": app.career.included(key)})
                if path == "/api/settings":
                    body = self._body_json()
                    if "autoDownloadUpdates" in body:
                        usersettings.update(autoDownloadUpdates=bool(body["autoDownloadUpdates"]))
                    return self._json({"ok": True, "autoDownload": app.auto_download()})
                self._read_body()   # an unknown route must not leave bytes behind
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

        def _dcs_tile(self, parts) -> None:
            try:
                z, x, y = int(parts[0]), int(parts[1]), int(parts[2].split(".")[0])
            except (IndexError, ValueError):
                return self._error(400, "bad tile path")
            tile = app.dcsmap.get_tile(z, x, y)
            if tile is not None:
                return self._send(200, json.dumps(tile, separators=(",", ":")).encode(), "application/json",
                                  {"Cache-Control": "max-age=3600"})
            if app.dcsmap.is_pending(z, x, y):
                return self._json({"pending": True}, 202)
            return self._error(404, "DCS terrain not available (start a mission with the DCS-SA hook installed)")

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
            if action == "summary":
                got = app.store.get(key)
                if got is None:
                    job = app.store.ensure(key)
                    return self._json({"pending": True, **job.to_dict()}, 202)
                r = got[1].get("recording") or {}
                return self._json({"key": key, "title": r.get("title"), "duration": r.get("duration"),
                                   "aircraftCount": r.get("aircraftCount")})

            got = app.store.get(key)
            if got is None:
                job = app.store.ensure(key)
                return self._json({"pending": True, **job.to_dict()}, 202)
            rec, report = got

            if action == "analysis":
                return self._json(report)
            if action == "playback":
                return self._json(app.store.playback(rec, report))
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
                password = str(body.get("password") or "")
                app.cfg.tacview_host, app.cfg.tacview_port = host, port
                app.live.connect_tacview(host, port, password)
                # Connect again by itself next time DCS SA starts.
                usersettings.update(tacview={"host": host, "port": port, "password": password, "autoconnect": True})
            elif kind == "replay":
                key = body.get("key")
                path = app.store.path_for(key) if key else None
                if path is None:
                    return self._error(404, "unknown recording")
                app.live.replay(path, float(body.get("speed") or 1.0), float(body.get("startAt") or 0.0))
            elif kind in ("none", None):
                app.live.disconnect()
                saved = usersettings.load().get("tacview")
                if isinstance(saved, dict) and saved.get("autoconnect"):
                    usersettings.update(tacview={**saved, "autoconnect": False})
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
            session = None
            n = 0
            period = 1.0 / rate
            try:
                self.wfile.write(b"retry: 2000\n\n")
                while True:
                    t0 = time.monotonic()
                    if app.live.world.session != session:
                        # World was reset: replay its events from the start and
                        # resend trails.
                        session, since, n = app.live.world.session, 0, 0
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
    install_console()
    app = App(cfg)
    log.info("DCS SA %s starting", __version__)
    # Look for an update straight away rather than waiting for a page to ask.
    threading.Timer(3.0, app.updates.status).start()
    try:
        from ..dcs_profile import refresh_bridge
        for path in refresh_bridge():
            log.info("Updated DCS bridge script %s", path)
    except Exception as exc:  # noqa: BLE001 - never stop the app over this
        log.warning("Could not update the DCS bridge scripts: %s", exc)
    err = app.live.start_bridge()
    if err:
        app.warnings.append(err)
        log.warning(err)
    if cfg.replay_file:
        app.live.replay(cfg.replay_file, cfg.replay_speed)
    elif cfg.tacview_autoconnect:
        app.live.connect_tacview(cfg.tacview_host, cfg.tacview_port, cfg.tacview_password)
    else:
        saved = usersettings.load().get("tacview")
        if isinstance(saved, dict) and saved.get("autoconnect"):
            try:
                cfg.tacview_host = str(saved.get("host") or cfg.tacview_host)
                cfg.tacview_port = int(saved.get("port") or cfg.tacview_port)
            except (TypeError, ValueError):
                pass
            app.live.connect_tacview(cfg.tacview_host, cfg.tacview_port, str(saved.get("password") or ""))
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
