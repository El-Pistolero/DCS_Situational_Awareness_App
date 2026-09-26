"""Every mission you have opened, remembered: the basis of the stats page.

One compact record per recording, keyed by the library's key, written the
first time a recording is analysed.  Records are small (a few hundred bytes)
and hold only what the stats page needs, so the whole career can be loaded
and added up in memory without touching the original .acmi files again.

Grouped by DCS pilot profile, because two people sharing a PC should not
share a kill tally.

The file is a single JSON object written atomically.  Anything unreadable is
treated as "no career yet" rather than an error: this is a record of play,
not something worth stopping the app over.
"""

from __future__ import annotations

import json
import logging
import math
import os
import threading
import time
from pathlib import Path
from typing import Any, Dict, Iterable, List, Optional

log = logging.getLogger(__name__)

VERSION = 1
#: Categories where "damage" is a real result: a truck that survives a near
#: miss was still hit.  Against an aircraft the bar is a kill (see `_scored`).
SURFACE = ("ground", "sea", "building", "structure")
MISS_OUTCOMES = ("miss", "intercepted", "damage")


def _scored(outcome: str, category: str) -> Optional[str]:
    """"hit", "miss", or None for a shot that was never decided.

    Against an aircraft only a kill counts.  A jet that flies home is not a
    jet you shot down, and "damage" there is inferred from its health rather
    than reported, so it is the least trustworthy number we have.
    """
    if outcome == "kill":
        return "hit"
    if category in SURFACE and outcome == "damage":
        return "hit"
    if outcome in MISS_OUTCOMES:
        return "miss"
    return None     # still in flight when the recording ended, or unknown


def _num(x: Any) -> Optional[float]:
    return float(x) if isinstance(x, (int, float)) and math.isfinite(x) else None


def summarise(key: str, report: Dict[str, Any], *, path: str = "", modified: Optional[float] = None) -> Dict[str, Any]:
    """Boil one debrief down to the record the stats page adds up.

    Only the player's own shots count: this is *your* career, not the
    mission's.  Where DCS confirmed a hit we say so, so the stats page can
    separate what DCS reported from what we worked out ourselves.
    """
    rec = report.get("recording") or {}
    me = report.get("player")
    weapons = report.get("weapons") or {}
    shots = [s for s in weapons.get("shots") or [] if s.get("launcherId") == me]
    bursts = [b for b in weapons.get("bursts") or [] if b.get("launcherId") == me]
    kills = [k for k in weapons.get("kills") or [] if k.get("killerId") == me]

    my_jet = next((a for a in report.get("aircraft") or [] if a.get("id") == me), {})
    pilot = my_jet.get("pilot") or None

    category = {str(o.get("id")): str(o.get("category") or "") for o in report.get("objects") or []}
    by_weapon: Dict[str, Dict[str, int]] = {}
    for s in shots:
        name = str(s.get("weaponName") or "?")
        row = by_weapon.setdefault(name, {"fired": 0, "hits": 0, "misses": 0, "kills": 0, "dcsHits": 0})
        row["fired"] += 1
        outcome = str(s.get("outcome") or "")
        if outcome == "kill":
            row["kills"] += 1
        scored = _scored(outcome, category.get(str(s.get("targetId")), ""))
        if scored == "hit":
            row["hits"] += 1
        elif scored == "miss":
            row["misses"] += 1
        if s.get("dcsHit"):
            row["dcsHits"] += 1

    guns = {"bursts": len(bursts), "rounds": sum(int(b.get("rounds") or 0) for b in bursts),
            "kills": sum(1 for b in bursts if b.get("kill"))}

    # "Against what jet": what was killed, and what was shot at.
    against: Dict[str, Dict[str, int]] = {}
    for k in kills:
        name = str(k.get("victimName") or "?")
        against.setdefault(name, {"kills": 0, "shotAt": 0, "category": k.get("victimCategory") or ""})["kills"] += 1
    for s in shots:
        name = s.get("targetName")
        if not name:
            continue
        against.setdefault(str(name), {"kills": 0, "shotAt": 0, "category": ""})["shotAt"] += 1

    landings = [l for l in report.get("landings") or [] if l.get("aircraftId") == me]
    losses = [k for k in weapons.get("kills") or [] if k.get("victimId") == me]

    return {
        "v": VERSION,
        "key": key,
        "path": path,
        "title": rec.get("title") or "",
        "startedAt": rec.get("startTime") or rec.get("reference") or None,
        "duration": _num(rec.get("duration")),
        "modified": modified,
        "recordedAt": time.time(),
        "profile": pilot or "(unknown)",
        "aircraft": my_jet.get("name") or "",
        "coalition": my_jet.get("coalition") or "",
        "shots": len(shots),
        "hits": sum(r["hits"] for r in by_weapon.values()),
        "misses": sum(r["misses"] for r in by_weapon.values()),
        "kills": len(kills),
        "airKills": sum(1 for k in kills if (k.get("victimCategory") or "") in ("fixedwing", "rotorcraft", "air")),
        "groundKills": sum(1 for k in kills if (k.get("victimCategory") or "") in ("ground", "sea")),
        "byWeapon": by_weapon,
        "against": against,
        "guns": guns,
        "landings": len(landings),
        "grades": [l.get("grade") for l in landings if l.get("grade")],
        "lost": bool(losses),
        "dcsConfirmed": bool(report.get("dcs")),
    }


class CareerStore:
    """The saved records, keyed by recording key."""

    def __init__(self, path: str) -> None:
        self.path = Path(path)
        self._lock = threading.Lock()
        self._records: Dict[str, Dict[str, Any]] = {}
        self._loaded = False

    # -- persistence -----------------------------------------------------------

    def _load(self) -> None:
        if self._loaded:
            return
        self._loaded = True
        try:
            data = json.loads(self.path.read_text(encoding="utf-8"))
        except FileNotFoundError:
            return
        except (OSError, ValueError) as exc:
            log.warning("Career file unreadable, starting a new one: %s", exc)
            return
        records = data.get("records") if isinstance(data, dict) else None
        if isinstance(records, dict):
            self._records = {k: v for k, v in records.items() if isinstance(v, dict)}

    def _save(self) -> None:
        try:
            self.path.parent.mkdir(parents=True, exist_ok=True)
            tmp = self.path.with_suffix(".tmp")
            tmp.write_text(json.dumps({"v": VERSION, "records": self._records}, separators=(",", ":")),
                           encoding="utf-8")
            os.replace(tmp, self.path)
        except OSError as exc:
            log.warning("Could not save the career file: %s", exc)

    # -- use -------------------------------------------------------------------

    def remember(self, record: Dict[str, Any]) -> None:
        key = record.get("key")
        if not key:
            return
        with self._lock:
            self._load()
            before = self._records.get(key)
            self._records[key] = record
            if before != record:
                self._save()
                log.info("Career: recorded %s (%d kills, %d shots)", record.get("title") or key,
                         record.get("kills") or 0, record.get("shots") or 0)

    def records(self, profile: Optional[str] = None) -> List[Dict[str, Any]]:
        with self._lock:
            self._load()
            rows = list(self._records.values())
        if profile and profile != "all":
            rows = [r for r in rows if r.get("profile") == profile]
        return sorted(rows, key=lambda r: r.get("startedAt") or r.get("recordedAt") or 0)

    def profiles(self) -> List[str]:
        with self._lock:
            self._load()
            return sorted({str(r.get("profile") or "(unknown)") for r in self._records.values()})

    def forget(self, key: str) -> bool:
        with self._lock:
            self._load()
            if key not in self._records:
                return False
            del self._records[key]
            self._save()
            return True

    def clear(self) -> None:
        with self._lock:
            self._load()
            self._records = {}
            self._save()


def totals(rows: Iterable[Dict[str, Any]]) -> Dict[str, Any]:
    """Add records up into the numbers the stats page shows."""
    rows = list(rows)
    by_weapon: Dict[str, Dict[str, int]] = {}
    against: Dict[str, Dict[str, int]] = {}
    by_aircraft: Dict[str, Dict[str, int]] = {}
    for r in rows:
        for name, w in (r.get("byWeapon") or {}).items():
            row = by_weapon.setdefault(name, {"fired": 0, "hits": 0, "misses": 0, "kills": 0, "dcsHits": 0})
            for k in row:
                row[k] += int(w.get(k) or 0)
        for name, a in (r.get("against") or {}).items():
            row = against.setdefault(name, {"kills": 0, "shotAt": 0, "category": a.get("category") or ""})
            row["kills"] += int(a.get("kills") or 0)
            row["shotAt"] += int(a.get("shotAt") or 0)
            if not row["category"] and a.get("category"):
                row["category"] = a["category"]
        jet = r.get("aircraft") or "?"
        row = by_aircraft.setdefault(jet, {"missions": 0, "kills": 0, "shots": 0, "hits": 0, "hours": 0.0})
        row["missions"] += 1
        row["kills"] += int(r.get("kills") or 0)
        row["shots"] += int(r.get("shots") or 0)
        row["hits"] += int(r.get("hits") or 0)
        row["hours"] += (_num(r.get("duration")) or 0.0) / 3600.0

    shots = sum(int(r.get("shots") or 0) for r in rows)
    hits = sum(int(r.get("hits") or 0) for r in rows)
    misses = sum(int(r.get("misses") or 0) for r in rows)
    kills = sum(int(r.get("kills") or 0) for r in rows)
    decided = hits + misses
    grades = [g for r in rows for g in (r.get("grades") or [])]
    return {
        "missions": len(rows),
        "hours": sum((_num(r.get("duration")) or 0.0) for r in rows) / 3600.0,
        "shots": shots,
        "hits": hits,
        "misses": misses,
        "kills": kills,
        "airKills": sum(int(r.get("airKills") or 0) for r in rows),
        "groundKills": sum(int(r.get("groundKills") or 0) for r in rows),
        # Undecided shots (still in flight at the end, unknown) are left out of
        # the denominator rather than counted as misses.
        "accuracy": (hits / decided) if decided else None,
        "decided": decided,
        "losses": sum(1 for r in rows if r.get("lost")),
        "landings": sum(int(r.get("landings") or 0) for r in rows),
        "grades": {g: grades.count(g) for g in sorted(set(grades))},
        "guns": {
            "bursts": sum(int((r.get("guns") or {}).get("bursts") or 0) for r in rows),
            "rounds": sum(int((r.get("guns") or {}).get("rounds") or 0) for r in rows),
            "kills": sum(int((r.get("guns") or {}).get("kills") or 0) for r in rows),
        },
        "byWeapon": by_weapon,
        "against": against,
        "byAircraft": by_aircraft,
    }
