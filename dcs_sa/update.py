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
import threading
import time
import urllib.error
import urllib.request
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


def _asset_url(release: Dict[str, Any]) -> Optional[str]:
    for asset in release.get("assets") or []:
        if str(asset.get("name", "")).lower().endswith("setup.exe"):
            return asset.get("browser_download_url")
    return None


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

    def status(self) -> Dict[str, Any]:
        """What the UI shows.  Kicks off a refresh when the answer is stale."""
        if self.enabled:
            self._maybe_refresh()
        with self._lock:
            return dict(self._state, enabled=self.enabled)

    def _maybe_refresh(self) -> None:
        with self._lock:
            if self._busy or (self._checked_at and time.monotonic() - self._checked_at < self.interval):
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
            state["download"] = _asset_url(release)
            state["available"] = is_newer(tag)
        with self._lock:
            self._state = state
            self._checked_at = time.monotonic()
            self._busy = False
