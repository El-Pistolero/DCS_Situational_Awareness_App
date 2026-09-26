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
import sys
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


#: The two things a release offers: the full installer, and the bare exe that
#: an already-installed copy can swap itself for.
SETUP_ASSET = "setup.exe"
APP_ASSET = "dcs-sa.exe"


def _asset(release: Dict[str, Any], suffix: str) -> Dict[str, Any]:
    """One release asset by the end of its name: where it is and its digest."""
    for asset in release.get("assets") or []:
        if str(asset.get("name", "")).lower().endswith(suffix):
            digest = str(asset.get("digest") or "")
            return {
                "download": asset.get("browser_download_url"),
                "size": int(asset.get("size") or 0),
                "sha256": digest.split(":", 1)[1] if digest.startswith("sha256:") else None,
                "name": asset.get("name"),
            }
    return {}


def _installer(release: Dict[str, Any]) -> Dict[str, Any]:
    """Which asset to fetch, and how the update will be applied.

    When we are the installed exe and its folder is ours to write, the update
    is the bare exe and we swap ourselves for it - no installer, no rollback,
    nothing to click.  Otherwise it is the installer, as before.
    """
    if can_swap_in_place():
        found = _asset(release, APP_ASSET)
        if found.get("download"):
            return dict(found, mode="swap")
    found = _asset(release, SETUP_ASSET)
    return dict(found, mode="installer") if found.get("download") else {}


def app_exe() -> Optional["Path"]:
    """The installed DCS-SA.exe, when this is the frozen Windows app."""
    if os.name != "nt" or not getattr(sys, "frozen", False):
        return None
    return Path(sys.executable)


def _writable(folder: "Path") -> bool:
    """Can we actually create a file here?  os.access lies about this on Windows."""
    probe = folder / ".dcs-sa-write-probe"
    try:
        probe.touch()
        probe.unlink()
        return True
    except OSError:
        return False


def can_swap_in_place() -> bool:
    exe = app_exe()
    return bool(exe and exe.is_file() and _writable(exe.parent))


def sweep_old_exe(exe: Optional["Path"] = None) -> int:
    """Delete the previous version left behind by an update.  Returns how many."""
    exe = exe or app_exe()
    if not exe:
        return 0
    gone = 0
    for stale in exe.parent.glob(exe.name + ".old*"):
        try:
            stale.unlink()
            gone += 1
        except OSError:
            pass    # still mapped by the process that just handed over; next start
    if gone:
        log.info("Cleaned up %d file(s) from the previous version", gone)
    return gone


def swap_in_place(new_exe: "Path", exe: Optional["Path"] = None) -> "Path":
    """Put the downloaded exe where the running one lives; return the old file.

    Windows will not let a running executable be overwritten or deleted, which
    is what made the installer roll itself back: a one-file build keeps a
    second process holding the exe open, so it is never free in time.  But
    Windows *does* allow a running exe to be **renamed** - the image stays
    mapped under the new name.  So the running exe is moved aside, the new one
    takes its place, and the old file is deleted once this process has gone.

    If anything fails the old exe is put back, so a failed update leaves a
    working app rather than none at all.
    """
    import shutil

    exe = exe or app_exe()
    if not exe:
        raise RuntimeError("not running as the installed app")
    if not new_exe.is_file():
        raise FileNotFoundError(str(new_exe))
    sweep_old_exe(exe)
    old = exe.with_name(exe.name + ".old")
    if old.exists():        # last update's exe is still mapped: use a fresh name
        old = exe.with_name(f"{exe.name}.old{os.getpid()}")
    exe.rename(old)
    try:
        shutil.move(str(new_exe), str(exe))
    except OSError:
        old.rename(exe)     # nothing changed, and the app still runs
        raise
    log.info("Swapped in the new %s; the old one is %s", exe.name, old.name)
    return old


def record_installed_version(version: str) -> None:
    """Keep Windows' own "Apps & features" entry honest about the version."""
    if os.name != "nt":
        return
    try:
        import winreg

        key = r"Software\Microsoft\Windows\CurrentVersion\Uninstall\{6F2A7C1E-5B7D-4C1A-9E0B-DC5A5A0F16C0}_is1"
        with winreg.OpenKey(winreg.HKEY_CURRENT_USER, key, 0, winreg.KEY_SET_VALUE) as k:
            winreg.SetValueEx(k, "DisplayVersion", 0, winreg.REG_SZ, str(version))
    except OSError as exc:
        log.debug("Could not update the uninstall entry: %s", exc)


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


def _ps_quote(text: str) -> str:
    return "'" + str(text).replace("'", "''") + "'"


def _detached(script: str) -> bool:
    """Run a PowerShell snippet that outlives this process.  True if it started."""
    import subprocess

    flags = getattr(subprocess, "DETACHED_PROCESS", 0) | getattr(subprocess, "CREATE_NEW_PROCESS_GROUP", 0)
    try:
        subprocess.Popen(["powershell", "-NoProfile", "-NonInteractive", "-WindowStyle", "Hidden",
                          "-Command", script], close_fds=True, creationflags=flags)
        return True
    except OSError as exc:
        log.warning("Could not start the update helper: %s", exc)
        return False


def _wait_for_exit() -> str:
    """PowerShell that waits until this app is really gone.

    Waiting on our own process id is not enough: a one-file build runs a second
    process that unpacked us and holds the exe open until we are finished with
    it.  So after the process goes, wait until the exe file itself can be
    opened for writing - that is the moment Windows will let it be replaced.
    """
    exe = app_exe()
    script = f"Wait-Process -Id {os.getpid()} -Timeout 120 -ErrorAction SilentlyContinue"
    if exe:
        script += (
            f"; $f = {_ps_quote(exe)}"
            "; for ($i = 0; $i -lt 150; $i++) {"
            " try { $h = [IO.File]::Open($f, 'Open', 'ReadWrite', 'None'); $h.Close(); break }"
            " catch { Start-Sleep -Milliseconds 400 } }"
        )
    return script


def launch_swapped(exe: "Path", old: "Path") -> None:
    """Start the exe we just swapped in, then delete the version it replaced.

    Nothing here has to wait for a lock: the new exe is a different file at
    the same path, so it can start the moment we are out of the way.  Deleting
    the old one is retried because the process handing over still has it
    mapped, and if it never succeeds the next start sweeps it up.
    """
    if os.name != "nt":
        raise RuntimeError("updates are applied in place only on Windows")
    script = (
        f"Wait-Process -Id {os.getpid()} -Timeout 120 -ErrorAction SilentlyContinue"
        f"; Start-Process -FilePath {_ps_quote(exe)}"
        f"; $old = {_ps_quote(old)}"
        "; for ($i = 0; $i -lt 60; $i++) {"
        " try { Remove-Item -LiteralPath $old -Force -ErrorAction Stop; break }"
        " catch { Start-Sleep -Milliseconds 500 } }"
    )
    if not _detached(script):
        # Without the helper the old app is gone and nothing would bring the
        # new one back, so start it now and leave the old file for the sweep.
        import subprocess

        subprocess.Popen([str(exe)], close_fds=True,
                         creationflags=getattr(subprocess, "DETACHED_PROCESS", 0))


def launch_installer(path: "Path", exe_path: Optional[str] = None) -> None:
    """Run the downloaded installer once this app is out of its way.

    Used when we cannot swap the exe ourselves - a copy installed somewhere we
    may not write, or a first install.  The helper waits for the exe to be
    free rather than just for the process, because an installer that finds it
    still in use rolls the whole install back.
    """
    if os.name != "nt":
        raise RuntimeError("the installer only runs on Windows")
    exe = exe_path or (sys.executable if getattr(sys, "frozen", False) else None)
    script = (
        f"{_wait_for_exit()}; Start-Process -FilePath {_ps_quote(path)} "
        "-ArgumentList '/SILENT','/SUPPRESSMSGBOXES','/NORESTART' -Wait"
    )
    if exe:
        script += f"; Start-Process -FilePath {_ps_quote(exe)}"
    if _detached(script):
        return
    import subprocess

    log.warning("Running the installer directly; the timing may not hold")
    subprocess.Popen([str(path), "/SILENT", "/SUPPRESSMSGBOXES", "/NORESTART"],
                     close_fds=True, creationflags=getattr(subprocess, "DETACHED_PROCESS", 0))


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

    def start(self, version: str, url: str, sha256: Optional[str], size: int = 0,
              mode: str = "installer") -> Dict[str, Any]:
        """Fetch the update.  *mode* is how it will be applied: swap or installer."""
        with self._lock:
            if self._state.get("state") == "downloading":
                return dict(self._state)
            stem = "DCS-SA-App" if mode == "swap" else "DCS-SA-Setup"
            dest = self.folder / f"{stem}-{version}.exe"
            ready = {"state": "ready", "version": version, "file": str(dest), "mode": mode}
            if dest.is_file() and (not size or dest.stat().st_size == size):
                self._state = ready
                return dict(self._state)
            self._state = {"state": "downloading", "version": version, "done": 0,
                           "total": size, "mode": mode}
            self._thread = threading.Thread(target=self._run,
                                            args=(version, url, sha256, size, dest, mode),
                                            name="update-download", daemon=True)
            self._thread.start()
            return dict(self._state)

    def _run(self, version: str, url: str, sha256: Optional[str], size: int,
             dest: "Path", mode: str = "installer") -> None:
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
                self._state = {"state": "failed", "version": version,
                               "error": str(exc), "mode": mode}
            return
        log.info("Update %s downloaded and verified", version)
        with self._lock:
            self._state = {"state": "ready", "version": version,
                           "file": str(dest), "mode": mode}

    def _clean_old(self, keep: "Path") -> None:
        """One download at a time: earlier ones are just clutter."""
        try:
            for pattern in ("DCS-SA-Setup-*.exe*", "DCS-SA-App-*.exe*"):
                for old in self.folder.glob(pattern):
                    if old != keep:
                        old.unlink(missing_ok=True)
        except OSError:
            pass

    def ready_file(self) -> Optional["Path"]:
        with self._lock:
            path = self._state.get("file") if self._state.get("state") == "ready" else None
        p = Path(path) if path else None
        return p if p and p.is_file() else None

    def ready_mode(self) -> str:
        """How the downloaded file should be applied: "swap" or "installer"."""
        with self._lock:
            return str(self._state.get("mode") or "installer")


class UpdateChecker:
    """Caches one answer and refreshes it in the background."""

    def __init__(self, enabled: bool = True, interval: float = INTERVAL) -> None:
        self.enabled = enabled
        self.interval = interval
        #: Called with the state as soon as a newer version is found, so the
        #: download can be queued without waiting for anyone to click.
        self.on_available = None
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
        if state.get("available") and self.on_available:
            try:
                self.on_available(state)
            except Exception as exc:  # noqa: BLE001 - queuing is a convenience
                log.warning("Could not queue the update: %s", exc)
