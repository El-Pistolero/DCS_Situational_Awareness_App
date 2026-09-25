"""Launch envelope (LAR) for the AGM-154 JSOW, from DCS's own tables.

DCS ships AI launch tables for the JSOW: maximum and minimum launch range
and time of flight, by release altitude and true airspeed.  They are what DCS
itself plans with, so they are the best available stand-in for the cockpit
LAR (they run about 10 % longer than the Hornet's DLZ at high altitude).
The same file is served to the web UI for live range rings.
"""

from __future__ import annotations

import json
from functools import lru_cache
from pathlib import Path
from typing import Dict, List, Optional

DATA = Path(__file__).resolve().parent.parent / "web" / "data" / "jsow_lar.json"


@lru_cache(maxsize=1)
def _tables() -> Optional[Dict]:
    try:
        t = json.loads(DATA.read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return None
    # The raw rows are noisy (the 10 km row dips below 9 km); range cannot
    # fall with height, so keep a running maximum up the altitude axis.
    for key in ("rmax",):
        grid = t[key]
        for c in range(len(t["speeds"])):
            best = 0.0
            for r in range(len(t["altitudes"])):
                best = max(best, grid[r][c])
                grid[r][c] = best if grid[r][c] > 0 else 0.0
    return t


def _interp(t: Dict, key: str, alt: float, tas: float) -> Optional[float]:
    alts: List[float] = t["altitudes"]
    spds: List[float] = t["speeds"]
    alt = max(alts[0], min(alts[-1], alt))
    tas = max(spds[0], min(spds[-1], tas))
    r = max(0, min(len(alts) - 2, next((i for i in range(len(alts) - 1) if alts[i + 1] >= alt), len(alts) - 2)))
    c = max(0, min(len(spds) - 2, next((i for i in range(len(spds) - 1) if spds[i + 1] >= tas), len(spds) - 2)))
    fr = (alt - alts[r]) / (alts[r + 1] - alts[r])
    fc = (tas - spds[c]) / (spds[c + 1] - spds[c])
    g = t[key]
    cells = [(g[r][c], (1 - fr) * (1 - fc)), (g[r][c + 1], (1 - fr) * fc),
             (g[r + 1][c], fr * (1 - fc)), (g[r + 1][c + 1], fr * fc)]
    good = [(v, w) for v, w in cells if v > 0]
    wsum = sum(w for _, w in good)
    if not good or wsum <= 1e-9:
        return None
    return sum(v * w for v, w in good) / wsum


def jsow_envelope(alt_above_target: float, tas: float) -> Optional[Dict[str, float]]:
    """Rmax/Rmin (m) and times of flight (s) for a release at this height and speed."""
    t = _tables()
    if t is None or alt_above_target != alt_above_target or tas != tas:
        return None
    out = {}
    for key in ("rmax", "rmin", "tofMax", "tofMid", "tofMin"):
        v = _interp(t, key, alt_above_target, tas)
        if v is not None:
            out[key] = v
    if "rmax" not in out:
        return None
    out["source"] = "DCS AI launch table"
    return out
