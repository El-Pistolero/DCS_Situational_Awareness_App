"""Is there a newer DCS SA to download?

Asks GitHub for the project's latest *release* (not a build artifact: those
need a GitHub login, releases don't).  The check runs on a background thread,
at most once an hour, and stays quiet when it fails: no network, GitHub down
or rate-limiting must never hold up or break the app.

Nothing is downloaded or installed automatically.  The app only says a newer
version exists and offers the link; the user stays in charge of installing it.
"""

from __future__ import annotations

import json
import logging
import os
import threading
import time
import urllib.error
import urllib.request
from pathlib import Path
from typing import Any, Dict, Optional, Tuple

from . import __version__

log = logging.getLogger(__name__)

REPO = "El-Pistolero/DCS_Situational_Awareness_App"
API = f"https://api.github.com/repos/{REPO}/releases/latest"
RELEASES_PAGE = f"https://github.com/{REPO}/releases/latest"
INTERVAL = 3600.0   # at most one ask an hour
TIMEOUT = 6.0


def version_tuple(text: str) -> Tuple[int, ...]:
    """"v1.2.3" -> (1, 2, 3).  Anything unparsable counts as (0,)."""
    parts = []
    for chunk in str(text).strip().lstrip("vV").split("."):
        digits = ""
        for ch in chunk:
            if not ch.isdigit():
                break
            digits += ch
        if not digits:
            break
        parts.append(int(digits))
    return tuple(parts) or (0,)


def is_newer(latest: str, current: str = __version__) -> bool:
    return version_tuple(latest) > version_tuple(current)


def _installer(release: Dict[str, Any]) -> Dict[str, Any]:
    """The installer asset: where it is, how big, and its published digest."""
    for asset in release.get("assets") or []:
        if str(asset.get("name", "")).lower().endswith("setup.exe"):
            digest = str(asset.get("digest") or "")
            return {
                "download": asset.get("browser_download_url"),
                "size": int(asset.get("size") or 0),
                "sha256": digest.split(":", 1)[1] if digest.startswith("sha256:") else None,
                "name": asset.get("name"),
            }
    return {}


def safe_asset_url(url: str) -> bool:
    """Only this project's own release downloads, over https.

    The URL comes from GitHub's API rather than the page, but it ends up
    being fetched and then run, so it is checked against the one place a
    DCS SA installer can legitimately come from.
    """
    from urllib.parse import urlparse

    u = urlparse(url or "")
    return (u.scheme == "https" and u.netloc == "github.com"
            and u.path.startswith(f"/{REPO}/releases/download/"))


def download(url: str, dest: "Path", sha256: Optional[str] = None,
             on_progress=None, expected_size: int = 0) -> "Path":
    """Fetch a release asset, checking its digest before it is usable.

    Downloads beside the target and renames on success, so a half-finished
    file is never mistaken for an installer.
    """
    import hashlib
    import shutil

    if not safe_asset_url(url):
        raise ValueError("refusing to download from an unexpected address")
    dest.parent.mkdir(parents=True, exist_ok=True)
    part = dest.with_suffix(dest.suffix + ".part")
    digest = hashlib.sha256()
    done = 0
    req = urllib.request.Request(url, headers={"User-Agent": f"dcs-sa/{__version__}"})
    with urllib.request.urlopen(req, timeout=30) as resp, open(part, "wb") as fh:
        total = int(resp.headers.get("Content-Length") or expected_size or 0)
        while True:
            chunk = resp.read(262144)
            if not chunk:
                break
            fh.write(chunk)
            digest.update(chunk)
            done += len(chunk)
            if on_progress:
                on_progress(done, total)
    got = digest.hexdigest()
    if sha256 and got.lower() != sha256.lower():
        part.unlink(missing_ok=True)
        raise ValueError("the download did not match its published checksum")
    if expected_size and done != expected_size and not sha256:
        part.unlink(missing_ok=True)
        raise ValueError(f"expected {expected_size} bytes, got {done}")
    shutil.move(str(part), str(dest))
    return dest


def launch_installer(path: "Path", silent: bool = True) -> None:
    """Start the downloaded installer and let it replace this app.

    The running exe cannot be overwritten while it is running, so the caller
    shuts the app down immediately afterwards; Inno Setup waits and then
    starts the new version.
    """
    import subprocess

    if os.name != "nt":
        raise RuntimeError("the installer only runs on Windows")
    args = [str(path)]
    if silent:
        args += ["/SILENT", "/SUPPRESSMSGBOXES", "/CLOSEAPPLICATIONS", "/RESTARTAPPLICATIONS", "/NORESTART"]
    flags = getattr(subprocess, "DETACHED_PROCESS", 0) | getattr(subprocess, "CREATE_NEW_PROCESS_GROUP", 0)
    subprocess.Popen(args, close_fds=True, creationflags=flags)


def fetch_latest(url: str = API) -> Dict[str, Any]:
    """The newest release, or {} when there is none / it can't be reached."""
    req = urllib.request.Request(url, headers={
        "Accept": "application/vnd.github+json",
        "User-Agent": f"dcs-sa/{__version__}",
    })
    try:
        with urllib.request.urlopen(req, timeout=TIMEOUT) as resp:
            body = json.loads(resp.read().decode("utf-8"))
    except (urllib.error.URLError, OSError, ValueError, TimeoutError) as exc:
        log.debug("update check failed: %s", exc)
        return {}
    if not isinstance(body, dict) or not body.get("tag_name"):
        return {}   # 404 when the project has no releases yet
    return body


class Downloader:
    """Fetches the installer in the background and reports how it is going.

    State is one of: idle, downloading, ready, failed.  The file is kept in
    the user's own DCS-SA folder so a half-finished download is easy to find
    and delete, and so it survives the app restarting.
    """

    def __init__(self, folder: "Path") -> None:
        self.folder = Path(folder)
        self._lock = threading.Lock()
        self._state: Dict[str, Any] = {"state": "idle"}
        self._thread: Optional[threading.Thread] = None

    def status(self) -> Dict[str, Any]:
        with self._lock:
            return dict(self._state)

    def start(self, version: str, url: str, sha256: Optional[str], size: int = 0) -> Dict[str, Any]:
        with self._lock:
            if self._state.get("state") == "downloading":
                return dict(self._state)
            dest = self.folder / f"DCS-SA-Setup-{version}.exe"
            if dest.is_file() and (not size or dest.stat().st_size == size):
                self._state = {"state": "ready", "version": version, "file": str(dest)}
                return dict(self._state)
            self._state = {"state": "downloading", "version": version, "done": 0, "total": size}
            self._thread = threading.Thread(target=self._run, args=(version, url, sha256, size, dest),
                                            name="update-download", daemon=True)
            self._thread.start()
            return dict(self._state)

    def _run(self, version: str, url: str, sha256: Optional[str], size: int, dest: "Path") -> None:
        def progress(done: int, total: int) -> None:
            with self._lock:
                if self._state.get("state") == "downloading":
                    self._state.update({"done": done, "total": total or size})

        try:
            self._clean_old(dest)
            download(url, dest, sha256, progress, size)
        except Exception as exc:  # noqa: BLE001 - a failed update must not take the app with it
            log.warning("Update download failed: %s", exc)
            with self._lock:
                self._state = {"state": "failed", "version": version, "error": str(exc)}
            return
        log.info("Update %s downloaded and verified", version)
        with self._lock:
            self._state = {"state": "ready", "version": version, "file": str(dest)}

    def _clean_old(self, keep: "Path") -> None:
        """One installer at a time: old ones are just clutter."""
        try:
            for old in self.folder.glob("DCS-SA-Setup-*.exe*"):
                if old != keep:
                    old.unlink(missing_ok=True)
        except OSError:
            pass

    def ready_file(self) -> Optional["Path"]:
        with self._lock:
            path = self._state.get("file") if self._state.get("state") == "ready" else None
        p = Path(path) if path else None
        return p if p and p.is_file() else None


class UpdateChecker:
    """Caches one answer and refreshes it in the background."""

    def __init__(self, enabled: bool = True, interval: float = INTERVAL) -> None:
        self.enabled = enabled
        self.interval = interval
        self._lock = threading.Lock()
        self._state: Dict[str, Any] = {"checked": False, "available": False,
                                       "current": __version__, "page": RELEASES_PAGE}
        self._checked_at = 0.0
        self._busy = False

    def status(self, force: bool = False) -> Dict[str, Any]:
        """What the UI shows.  Kicks off a refresh when the answer is stale.

        *force* is the user pressing "Check again": it ignores the interval,
        so a failed check can be retried at once.
        """
        if self.enabled:
            self._maybe_refresh(force)
        with self._lock:
            return dict(self._state, enabled=self.enabled, checking=self._busy)

    def _maybe_refresh(self, force: bool = False) -> None:
        with self._lock:
            if self._busy or (not force and self._checked_at
                              and time.monotonic() - self._checked_at < self.interval):
                return
            self._busy = True
        threading.Thread(target=self._refresh, name="update-check", daemon=True).start()

    def _refresh(self) -> None:
        release = fetch_latest()
        state: Dict[str, Any] = {"checked": True, "available": False,
                                 "current": __version__, "page": RELEASES_PAGE}
        if release:
            tag = str(release.get("tag_name"))
            state["latest"] = tag.lstrip("vV")
            state["page"] = release.get("html_url") or RELEASES_PAGE
            state.update(_installer(release))
            state["available"] = is_newer(tag)
        with self._lock:
            self._state = state
            self._checked_at = time.monotonic()
            self._busy = False
