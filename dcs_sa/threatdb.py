"""Weapon engagement ranges for SAM, AAA and warship types.

DCS recordings do not carry ``EngagementRange``; Tacview adds it when it
displays a file, from its own object database.  This module reads the same
numbers (``data/tacview_threats.json``, copied from Tacview's public database)
so threat rings show for DCS recordings and live telemetry too.  Anything the
recording itself provides always wins, and results are labelled with their
source so the UI can say where a ring came from.
"""

from __future__ import annotations

import json
from functools import lru_cache
from pathlib import Path
from typing import Dict, Optional

SOURCE = "Tacview database"

# DCS type names that differ from the database's names.
ALIASES = {
    "SNR_75V": "SNR-75",
    "Osa 9A33 ln": "Osa 9A33",
    "SA-18 Igla manpad": "SA-18",
    "SA-18 Igla-S manpad": "SA-18",
    "HQ-7_STR_SP": "HQ-7 STR",
    "USS_Arleigh_Burke_IIa": "Burke",
}


def _norm(name: str) -> str:
    return "".join(ch for ch in str(name).casefold() if ch.isalnum())


@lru_cache(maxsize=1)
def _table() -> Dict[str, Dict]:
    path = Path(__file__).with_name("data") / "tacview_threats.json"
    try:
        data = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return {}
    return {_norm(e["name"]): e for e in data.get("entries", []) if isinstance(e.get("range"), (int, float))}


def lookup(name: Optional[str]) -> Optional[Dict]:
    """``{"range": m, "vrange": m|None, "role": str, "source": ...}`` or None."""
    if not name:
        return None
    table = _table()
    e = table.get(_norm(ALIASES.get(name, name)))
    if e is None:
        return None
    return {"range": float(e["range"]), "vrange": e.get("vrange"), "role": e.get("role"), "source": SOURCE}
