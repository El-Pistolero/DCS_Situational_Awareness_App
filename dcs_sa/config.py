"""Configuration: defaults, an optional ``dcs-sa.toml``, then CLI overrides."""

from __future__ import annotations

import os
import sys
from dataclasses import dataclass, field, fields
from pathlib import Path
from typing import Any, Dict, List, Optional

try:  # Python 3.11+
    import tomllib
except ModuleNotFoundError:  # pragma: no cover - 3.9/3.10 fallback
    tomllib = None  # type: ignore[assignment]

CONFIG_NAMES = ("dcs-sa.toml", "config.toml")


def default_recording_dirs() -> List[str]:
    """Where Tacview and DCS usually put recordings on this machine."""
    home = Path.home()
    candidates = [
        home / "Documents" / "Tacview",
        home / "OneDrive" / "Documents" / "Tacview",
        home / "Saved Games" / "DCS" / "Tacview",
        home / "Saved Games" / "DCS.openbeta" / "Tacview",
        Path.cwd() / "recordings",
        home / "Documents" / "DCS-SA" / "recordings",
    ]
    user_profile = os.environ.get("USERPROFILE")
    if user_profile:
        candidates.insert(0, Path(user_profile) / "Documents" / "Tacview")
    # Documents / Saved Games moved to another drive: Windows knows where.
    from .winpaths import DOCUMENTS, SAVED_GAMES, known_folder
    docs, saved = known_folder(DOCUMENTS), known_folder(SAVED_GAMES)
    if saved:
        candidates[2:2] = [saved / "DCS" / "Tacview", saved / "DCS.openbeta" / "Tacview"]
    if docs:
        candidates.insert(0, docs / "Tacview")
    out: List[str] = []
    for c in candidates:
        s = str(c)
        if s not in out:
            out.append(s)
    return out


@dataclass
class Config:
    host: str = "127.0.0.1"
    port: int = 8765
    recording_dirs: List[str] = field(default_factory=default_recording_dirs)
    upload_dir: str = str(Path.home() / "Documents" / "DCS-SA" / "recordings")
    player_names: List[str] = field(default_factory=list)

    # Live sources
    tacview_host: str = "127.0.0.1"
    tacview_port: int = 42674
    tacview_password: str = ""
    tacview_autoconnect: bool = False
    update_check: bool = True      # ask GitHub whether a newer release exists
    bridge_enabled: bool = True
    bridge_host: str = "127.0.0.1"
    bridge_port: int = 42680
    replay_file: Optional[str] = None
    replay_speed: float = 1.0

    live_rate_hz: float = 5.0
    open_browser: bool = True

    @classmethod
    def load(cls, path: Optional[str] = None) -> "Config":
        cfg = cls()
        if path:
            candidates = [Path(path)]
        else:
            dirs = [Path.cwd(), Path(sys.executable).parent, Path.home() / "Documents" / "DCS-SA"]
            candidates = [d / n for d in dirs for n in CONFIG_NAMES]
        for cand in candidates:
            if cand.is_file():
                cfg.apply(_read_toml(cand))
                break
        return cfg

    def apply(self, values: Dict[str, Any]) -> None:
        known = {f.name for f in fields(self)}
        flat: Dict[str, Any] = {}
        for key, value in values.items():
            if isinstance(value, dict):
                for sub, v in value.items():
                    flat[f"{key}_{sub}"] = v
            else:
                flat[key] = value
        for key, value in flat.items():
            key = key.replace("-", "_")
            if key in known and value is not None:
                setattr(self, key, value)

    def all_recording_dirs(self) -> List[str]:
        dirs = list(self.recording_dirs)
        if self.upload_dir not in dirs:
            dirs.append(self.upload_dir)
        samples = str(Path(__file__).resolve().parent.parent / "samples")
        if samples not in dirs:
            dirs.append(samples)
        return dirs


def _read_toml(path: Path) -> Dict[str, Any]:
    if tomllib is None:
        print(f"warning: cannot read {path} (needs Python 3.11+)", file=sys.stderr)
        return {}
    with open(path, "rb") as fh:
        return tomllib.load(fh)
