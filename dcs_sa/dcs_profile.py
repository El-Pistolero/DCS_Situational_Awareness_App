"""Read the local DCS World pilot profile.

DCS keeps pilot profiles (the names you pick at the logbook screen) in
``Saved Games/DCS/MissionEditor/logbook.lua``.  We read it - never write it -
to learn the player's name, so the app can pick "your" aircraft out of a
recording automatically.  The parser is deliberately tolerant: the file is a
Lua table whose exact layout has shifted between DCS versions.
"""

from __future__ import annotations

import os
import re
from pathlib import Path
from typing import Dict, List, Optional

SAVED_GAMES_VARIANTS = ("DCS", "DCS.openbeta", "DCS.release_server")


def saved_games_dirs() -> List[Path]:
    homes = []
    if os.environ.get("USERPROFILE"):
        homes.append(Path(os.environ["USERPROFILE"]))
    homes.append(Path.home())
    out: List[Path] = []
    for home in homes:
        for variant in SAVED_GAMES_VARIANTS:
            p = home / "Saved Games" / variant
            if p.is_dir() and p not in out:
                out.append(p)
    return out


_NAME_RE = re.compile(r'\["name"\]\s*=\s*"((?:[^"\\]|\\.)*)"')
_CURRENT_RE = re.compile(r'\["currentPlayer"\]\s*=\s*(\d+|"(?:[^"\\]|\\.)*")')
_PLAYER_BLOCK_RE = re.compile(r'\[(\d+)\]\s*=\s*\{')


def parse_logbook(text: str) -> Dict[str, object]:
    """Extract player names and the current player from logbook.lua text."""
    players_at = text.find('["players"]')
    region = text[players_at:] if players_at >= 0 else text
    names: List[str] = []
    by_index: Dict[int, str] = {}
    # Each player entry is "[n] = { ... ["name"] = "X" ...".  Pair every
    # player index with the first name that follows it.
    for m in _PLAYER_BLOCK_RE.finditer(region):
        nm = _NAME_RE.search(region, m.end())
        if nm is None:
            continue
        name = nm.group(1).replace('\\"', '"')
        idx = int(m.group(1))
        if name and idx not in by_index and name not in by_index.values():
            by_index[idx] = name
    names = list(by_index.values()) or [m.group(1) for m in _NAME_RE.finditer(region)][:1]

    current: Optional[str] = None
    cm = _CURRENT_RE.search(text)
    if cm:
        raw = cm.group(1)
        if raw.startswith('"'):
            current = raw.strip('"')
        else:
            current = by_index.get(int(raw))
    if current is None and names:
        current = names[0]
    return {"players": names, "current": current}


def read_profile() -> Dict[str, object]:
    """Best-effort summary of the local DCS install, for the UI."""
    info: Dict[str, object] = {"found": False, "savedGames": None, "player": None,
                               "players": [], "exportLua": None, "bridgeInstalled": False,
                               "tacviewInstalled": False}
    for sg in saved_games_dirs():
        info["found"] = True
        info["savedGames"] = str(sg)
        logbook = sg / "MissionEditor" / "logbook.lua"
        if logbook.is_file():
            try:
                parsed = parse_logbook(logbook.read_text(encoding="utf-8", errors="replace"))
                info["player"] = parsed["current"]
                info["players"] = parsed["players"]
            except OSError:
                pass
        info["mapHookInstalled"] = (sg / "Scripts" / "Hooks" / HOOK_NAME).is_file()
        export = sg / "Scripts" / "Export.lua"
        if export.is_file():
            info["exportLua"] = str(export)
            try:
                content = export.read_text(encoding="utf-8", errors="replace")
                info["bridgeInstalled"] = "DCS-SA-Export" in content
                info["tacviewInstalled"] = "Tacview" in content
            except OSError:
                pass
        if not info["tacviewInstalled"]:
            info["tacviewInstalled"] = (sg / "Scripts" / "TacviewGameExport.lua").is_file() or \
                (sg / "Mods" / "tech" / "Tacview").is_dir()
        if info["player"]:
            break
    return info


BRIDGE_NAME = "DCS-SA-Export.lua"
HOOK_NAME = "DCS-SA-Hook.lua"
BRIDGE_LINE = "local dcssalfs=require('lfs'); dofile(dcssalfs.writedir()..'Scripts/DCS-SA-Export.lua')"


def bridge_source(name: str = BRIDGE_NAME) -> Path:
    """Location of a bundled Lua script (works from source and from the exe)."""
    import sys

    base = Path(getattr(sys, "_MEIPASS", Path(__file__).resolve().parent.parent))
    for cand in (base / "dcs-scripts" / name, Path(__file__).resolve().parent.parent / "dcs-scripts" / name):
        if cand.is_file():
            return cand
    raise FileNotFoundError(name)


def install_bridge(saved_games: Optional[Path] = None) -> Dict[str, object]:
    """Copy the bridge into Saved Games/DCS*/Scripts and hook it from Export.lua.

    Idempotent, and keeps a one-time backup of an existing Export.lua.  Other
    exporters already in Export.lua are left untouched and keep working.
    """
    targets = [saved_games] if saved_games else saved_games_dirs()
    if not targets:
        return {"ok": False, "error": "No DCS Saved Games folder found."}
    done = []
    src = bridge_source().read_bytes()
    hook_src = bridge_source(HOOK_NAME).read_bytes()
    for sg in targets:
        scripts = Path(sg) / "Scripts"
        (scripts / "Hooks").mkdir(parents=True, exist_ok=True)
        (scripts / BRIDGE_NAME).write_bytes(src)
        # Hooks load automatically; this one lets the app read DCS's own map.
        (scripts / "Hooks" / HOOK_NAME).write_bytes(hook_src)
        export = scripts / "Export.lua"
        text = export.read_text(encoding="utf-8", errors="replace") if export.is_file() else ""
        if BRIDGE_NAME not in text:
            backup = scripts / "Export.lua.before-dcs-sa"
            if export.is_file() and not backup.exists():
                backup.write_text(text, encoding="utf-8")
            sep = "" if not text or text.endswith("\n") else "\n"
            export.write_text(f"{text}{sep}{BRIDGE_LINE}\n", encoding="utf-8")
        done.append(str(scripts))
    return {"ok": True, "installed": done}
