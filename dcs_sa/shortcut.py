"""Desktop and Start-menu shortcuts, so DCS SA opens like any other app.

Windows shortcuts (.lnk) are written through the WScript.Shell COM object via
PowerShell, so no extra Python packages are needed.  On Linux a freedesktop
``.desktop`` launcher is written instead (handy for testing, and for anyone
running DCS under Proton).
"""

from __future__ import annotations

import json
import os
import subprocess
import sys
from pathlib import Path
from typing import Dict, List, Optional, Tuple

APP_NAME = "DCS SA"
LIVE_NAME = "DCS SA Live"
from .usersettings import PATH as SETTINGS


def _repo_root() -> Path:
    return Path(__file__).resolve().parent.parent


def icon_path() -> Path:
    base = Path(getattr(sys, "_MEIPASS", _repo_root()))
    for cand in (base / "packaging" / "dcs-sa.ico", _repo_root() / "packaging" / "dcs-sa.ico"):
        if cand.is_file():
            return cand
    return Path(sys.executable)


def launch_command() -> Tuple[str, str, str, str]:
    """(target, base arguments, working directory, icon) for a shortcut."""
    if getattr(sys, "frozen", False):
        exe = sys.executable
        return exe, "", str(Path(exe).parent), exe
    # From source: pythonw avoids a console window behind the app.
    py = Path(sys.executable)
    pyw = py.with_name("pythonw.exe") if os.name == "nt" else py
    target = str(pyw if pyw.exists() else py)
    return target, "-m dcs_sa", str(_repo_root()), str(icon_path())


def installed_by_setup() -> bool:
    """True when running from an installer-managed folder (it made shortcuts)."""
    return getattr(sys, "frozen", False) and any(Path(sys.executable).parent.glob("unins*.exe"))


# -- Windows -----------------------------------------------------------------


def _ps(script: str) -> str:
    out = subprocess.run(
        ["powershell", "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-Command", script],
        capture_output=True, text=True, timeout=30,
        creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0),
    )
    if out.returncode != 0:
        raise OSError(out.stderr.strip() or f"powershell exited {out.returncode}")
    return out.stdout.strip()


def _q(s: str) -> str:
    """Single-quoted PowerShell string literal."""
    return "'" + str(s).replace("'", "''") + "'"


def windows_shortcut_script(lnk: str, target: str, args: str, workdir: str, icon: str, description: str) -> str:
    return (
        "$s=(New-Object -ComObject WScript.Shell).CreateShortcut(" + _q(lnk) + ");"
        f"$s.TargetPath={_q(target)};$s.Arguments={_q(args)};$s.WorkingDirectory={_q(workdir)};"
        f"$s.IconLocation={_q(icon + ',0')};$s.Description={_q(description)};$s.Save()"
    )


def _windows_dirs() -> Dict[str, Path]:
    try:
        desktop = Path(_ps("[Environment]::GetFolderPath('Desktop')"))  # follows OneDrive redirection
    except (OSError, subprocess.SubprocessError):
        desktop = Path.home() / "Desktop"
    programs = Path(os.environ.get("APPDATA", Path.home() / "AppData" / "Roaming")) / "Microsoft" / "Windows" / "Start Menu" / "Programs"
    return {"desktop": desktop, "startMenu": programs}


# -- Linux ---------------------------------------------------------------------


def linux_desktop_entry(name: str, target: str, args: str, workdir: str, icon: str) -> str:
    png = _repo_root() / "packaging" / "icon" / "icon-256.png"
    return "\n".join([
        "[Desktop Entry]", "Type=Application", f"Name={name}",
        "Comment=DCS World situational awareness and debrief",
        f"Exec=\"{target}\" {args}".rstrip(), f"Path={workdir}",
        f"Icon={png if png.is_file() else icon}", "Terminal=false", "Categories=Game;Utility;", "",
    ])


# -- public API ------------------------------------------------------------------


def shortcut_paths() -> Dict[str, Path]:
    if os.name == "nt":
        d = _windows_dirs()
        return {"desktop": d["desktop"] / f"{APP_NAME}.lnk", "startMenu": d["startMenu"] / f"{APP_NAME}.lnk",
                "startMenuLive": d["startMenu"] / f"{LIVE_NAME}.lnk"}
    home = Path.home()
    return {"desktop": home / "Desktop" / "dcs-sa.desktop",
            "startMenu": home / ".local" / "share" / "applications" / "dcs-sa.desktop",
            "startMenuLive": home / ".local" / "share" / "applications" / "dcs-sa-live.desktop"}


def status() -> Dict[str, object]:
    paths = shortcut_paths() if os.name != "nt" or _can_powershell() else {}
    return {"desktop": bool(paths) and paths["desktop"].exists(),
            "startMenu": bool(paths) and paths["startMenu"].exists(),
            "installedBySetup": installed_by_setup()}


def _can_powershell() -> bool:
    try:
        _ps("1")
        return True
    except (OSError, subprocess.SubprocessError, FileNotFoundError):
        return False


def install_shortcuts(desktop: bool = True, start_menu: bool = True) -> List[str]:
    """Create (or refresh) the shortcuts.  Returns the paths written."""
    target, args, workdir, icon = launch_command()
    paths = shortcut_paths()
    wanted = []
    if desktop:
        wanted.append((paths["desktop"], APP_NAME, args))
    if start_menu:
        wanted.append((paths["startMenu"], APP_NAME, args))
        wanted.append((paths["startMenuLive"], LIVE_NAME, (args + " app --live").strip() if args else "--live"))
    made = []
    for path, name, a in wanted:
        path.parent.mkdir(parents=True, exist_ok=True)
        if os.name == "nt":
            _ps(windows_shortcut_script(str(path), target, a, workdir, icon,
                                        "DCS World situational awareness and debrief"))
        else:
            path.write_text(linux_desktop_entry(name, target, a, workdir, icon))
            path.chmod(0o755)
        made.append(str(path))
    return made


def first_run() -> Optional[List[str]]:
    """On the exe's first launch, put the icon on the desktop (once)."""
    settings: Dict[str, object] = {}
    try:
        settings = json.loads(SETTINGS.read_text())
    except (OSError, ValueError):
        pass
    if settings.get("shortcutsCreated") or not getattr(sys, "frozen", False) or installed_by_setup():
        return None
    try:
        made = install_shortcuts()
    except (OSError, subprocess.SubprocessError) as exc:
        made = []
        settings["shortcutError"] = str(exc)
    settings["shortcutsCreated"] = True
    SETTINGS.parent.mkdir(parents=True, exist_ok=True)
    SETTINGS.write_text(json.dumps(settings, indent=1))
    return made
