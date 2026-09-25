"""Radar and sensor analysis: radar activity, lock episodes, and spikes.

A *lock episode* is a continuous interval where an aircraft reports a primary
locked target.  From the other side of the same data we get *spikes*: who
had whom locked, which is what the victim's RWR would have been screaming
about.
"""

from __future__ import annotations

import math
from dataclasses import asdict, dataclass
from typing import Dict, List, Optional

from ..acmi.model import Recording, Track
from . import geo

NAN = float("nan")


def _isnan(x: float) -> bool:
    return x != x


@dataclass
class LockEpisode:
    owner_id: str
    owner_name: str
    owner_pilot: Optional[str]
    target_id: Optional[str]
    target_name: Optional[str]
    target_pilot: Optional[str]
    start: float
    end: float
    duration: float
    range_start: Optional[float] = None
    range_end: Optional[float] = None
    min_range: Optional[float] = None
    aspect_start: Optional[float] = None
    ended_by: str = "released"  # released | target-destroyed | recording-end | target-changed
    shots_during: int = 0

    def to_dict(self) -> Dict:
        out = {}
        for k, v in asdict(self).items():
            parts = k.split("_")
            key = parts[0] + "".join(p.title() for p in parts[1:])
            out[key] = None if isinstance(v, float) and math.isnan(v) else v
        return out


@dataclass
class RadarInterval:
    owner_id: str
    start: float
    end: float
    mode: float
    max_range: Optional[float] = None

    def to_dict(self) -> Dict:
        return {"ownerId": self.owner_id, "start": self.start, "end": self.end,
                "mode": self.mode, "maxRange": self.max_range}


def _range_between(a: Track, b: Track, t: float) -> Optional[float]:
    pa, pb = a.position_at(t), b.position_at(t)
    if pa is None or pb is None:
        return None
    return geo.slant_range(*pa, *pb)


def radar_intervals(tr: Track) -> List[RadarInterval]:
    mode = tr.channel("RadarMode")
    if mode is None:
        return []
    rng = tr.channel("RadarRange")
    out: List[RadarInterval] = []
    start_i: Optional[int] = None
    for i, m in enumerate(mode):
        on = not _isnan(m) and m > 0
        if on and start_i is None:
            start_i = i
        elif not on and start_i is not None:
            out.append(_interval(tr, start_i, i, rng))
            start_i = None
    if start_i is not None:
        out.append(_interval(tr, start_i, len(mode) - 1, rng))
    return out


def _interval(tr: Track, i0: int, i1: int, rng) -> RadarInterval:
    max_range = None
    if rng is not None:
        vals = [rng[i] for i in range(i0, i1 + 1) if not _isnan(rng[i])]
        max_range = max(vals) if vals else None
    end = tr.ends_at if i1 == len(tr.t) - 1 else tr.t[i1]
    return RadarInterval(tr.id, tr.t[i0], end, tr.channel("RadarMode")[i0], max_range)


def lock_episodes(rec: Recording, tr: Track, destroyed: Dict[str, float]) -> List[LockEpisode]:
    """Continuous primary-lock intervals for one aircraft."""
    mode = tr.channel("LockedTargetMode")
    hist = tr.text_history.get("LockedTarget", [])
    if mode is None and not hist:
        return []

    # Build a merged, time-ordered list of (t, target_id) where target_id is
    # None when there is no lock.
    changes: List[float] = sorted({tr.t[i] for i in range(len(tr.t))
                                   if mode is not None and (i == 0 or mode[i] != mode[i - 1])}
                                  | {t for t, _ in hist})

    def locked_at(t: float) -> Optional[str]:
        tid = tr.text_at("LockedTarget", t)
        if mode is not None:
            m = tr.value_at("LockedTargetMode", t)
            if _isnan(m) or m <= 0:
                return None
            return tid or "?"
        return tid or None

    episodes: List[LockEpisode] = []
    cur_tid: Optional[str] = None
    cur_start = 0.0
    end_of_track = tr.ends_at

    def close(end: float, reason: str) -> None:
        tgt = rec.tracks.get(cur_tid) if cur_tid else None
        ep = LockEpisode(
            owner_id=tr.id, owner_name=tr.name, owner_pilot=tr.pilot,
            target_id=cur_tid if cur_tid != "?" else None,
            target_name=tgt.name if tgt else None,
            target_pilot=tgt.pilot if tgt else None,
            start=cur_start, end=end, duration=end - cur_start, ended_by=reason,
        )
        if tgt is not None:
            ep.range_start = _range_between(tr, tgt, cur_start)
            ep.range_end = _range_between(tr, tgt, min(end, tgt.last_seen))
            samples = [_range_between(tr, tgt, x) for x in _frange(cur_start, min(end, tgt.last_seen), 1.0)]
            samples = [s for s in samples if s is not None]
            ep.min_range = min(samples) if samples else None
            tp = tgt.position_at(cur_start)
            op = tr.position_at(cur_start)
            th = tgt.value_at("Yaw", cur_start)
            if tp and op and not _isnan(th):
                ep.aspect_start = geo.aspect_angle(tp[0], tp[1], th, op[0], op[1])
            died = destroyed.get(tgt.id)
            if died is not None and abs(died - end) < 3.0:
                ep.ended_by = "target-destroyed"
        owner_died = destroyed.get(tr.id)
        if owner_died is not None and abs(owner_died - end) < 3.0:
            ep.ended_by = "owner-destroyed"
        episodes.append(ep)

    for t in changes:
        tid = locked_at(t)
        if tid == cur_tid:
            continue
        if cur_tid is not None:
            close(t, "target-changed" if tid else "released")
        cur_tid, cur_start = tid, t
    if cur_tid is not None:
        close(end_of_track, "recording-end" if end_of_track >= rec.end_time - 0.5 else "released")
    return [e for e in episodes if e.duration > 0.0]


def _frange(a: float, b: float, step: float):
    x = a
    while x <= b:
        yield x
        x += step
    if b > a:
        yield b


def analyze_radar(rec: Recording, destroyed: Dict[str, float], shots: Optional[List] = None) -> Dict:
    locks: List[LockEpisode] = []
    radar: List[RadarInterval] = []
    for tr in rec.tracks.values():
        if tr.category not in ("fixedwing", "rotorcraft", "air", "ground", "sea"):
            continue
        locks.extend(lock_episodes(rec, tr, destroyed))
        radar.extend(radar_intervals(tr))

    for shot in shots or []:
        for ep in locks:
            if ep.owner_id == shot.launcher_id and ep.start <= shot.launch_time <= ep.end:
                ep.shots_during += 1

    spikes: Dict[str, List[Dict]] = {}
    for ep in locks:
        if ep.target_id:
            spikes.setdefault(ep.target_id, []).append({
                "by": ep.owner_id, "byName": ep.owner_name, "byPilot": ep.owner_pilot,
                "start": ep.start, "end": ep.end, "rangeStart": ep.range_start,
                "shots": ep.shots_during,
            })

    locks.sort(key=lambda e: e.start)
    radar.sort(key=lambda r: r.start)
    return {
        "locks": locks,
        "radar": radar,
        "spikes": spikes,
    }
