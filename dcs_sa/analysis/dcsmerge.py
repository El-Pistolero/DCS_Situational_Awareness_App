"""Merge what DCS reported during the flight into a recording's analysis.

A flight log (see :mod:`dcs_sa.flightlog`) holds values read from DCS while
flying - your control deflections and radar scan zone, every unit's radar
on/off flag, and DCS's own shot/hit/kill events.  This module finds the log
that belongs to a Tacview recording, works out the time offset between the
two by matching your aircraft's flight path, and then:

* adds the read values to the recording as channels (so the Flight tab,
  charts and radar cones show read data rather than estimates), and
* returns DCS's events mapped onto recording object ids, which the weapons
  analysis uses to confirm hits and kills.

Nothing is merged unless the flight paths agree (median error < 300 m).
"""

from __future__ import annotations

import bisect
import math
from array import array
from datetime import datetime, timedelta, timezone
from pathlib import Path
from typing import Any, Dict, List, Optional, Tuple

from ..acmi.model import Recording, Track, _parse_iso8601
from ..flightlog import list_logs, read_log
from . import geo

MAX_MEDIAN_ERROR = 300.0
NAN = float("nan")


def _median(xs: List[float]) -> float:
    xs = sorted(xs)
    return xs[len(xs) // 2] if xs else math.inf


def align(track: Track, selfs: List[Dict[str, Any]]) -> Tuple[Optional[float], float]:
    """Time offset (recording t = log t + offset) and median position error."""
    pts = [r for r in selfs if isinstance(r.get("lat"), (int, float)) and isinstance(r.get("lon"), (int, float))]
    if len(pts) < 5 or not len(track):
        return None, math.inf
    probe = pts[:: max(1, len(pts) // 60)]

    def error(offset: float) -> float:
        errs = []
        for r in probe:
            t = r["t"] + offset
            if not track.first_seen - 1 <= t <= track.ends_at + 1:
                continue
            p = track.position_interp(t)
            if p is not None:
                errs.append(geo.ground_distance(r["lon"], r["lat"], p[0], p[1]))
        return _median(errs) if len(errs) >= max(3, len(probe) // 3) else math.inf

    candidates = [0.0]
    lon, lat = track.channel("Longitude"), track.channel("Latitude")
    if lon is not None and lat is not None:
        stride = max(1, len(track) // 4000)
        for anchor in (pts[len(pts) // 5], pts[len(pts) // 2], pts[4 * len(pts) // 5]):
            best_t, best_d = None, math.inf
            for i in range(0, len(track), stride):
                if lon[i] != lon[i]:
                    continue
                d = geo.ground_distance(anchor["lon"], anchor["lat"], lon[i], lat[i])
                if d < best_d:
                    best_t, best_d = track.t[i], d
            if best_t is not None:
                candidates.append(best_t - anchor["t"])
    scored = sorted((error(c), c) for c in candidates)
    err, offset = scored[0]
    return (offset, err) if err < MAX_MEDIAN_ERROR else (None, err)


def _channel_from_log(track: Track, times: List[float], values: List[float], offset: float,
                      max_gap: float = 0.8, hold: bool = False) -> array:
    """Sample a log series at the track's timestamps (nearest, or held)."""
    out = array("d")
    for t in track.t:
        lt = t - offset
        i = bisect.bisect_left(times, lt)
        best = None
        for j in (i - 1, i):
            if 0 <= j < len(times) and (hold and times[j] <= lt or not hold and abs(times[j] - lt) <= max_gap):
                if best is None or abs(times[j] - lt) < abs(times[best] - lt):
                    best = j
        if hold and best is not None and lt - times[best] > 5.0:
            best = None
        out.append(values[best] if best is not None and values[best] is not None else NAN)
    return out


def _match_unit(rec: Recording, unit: Dict[str, Any], t: float) -> Optional[str]:
    """A DCS unit (name/type/player/position) -> recording object id."""
    if not unit:
        return None
    player = (unit.get("player") or "").strip()
    typ = unit.get("type") or ""
    lat, lon = unit.get("lat"), unit.get("lon")
    best, best_d = None, 3000.0
    for tr in rec.tracks.values():
        if tr.category in ("round", "clutter", "countermeasure") or not tr.alive_at(t, grace=2.0):
            continue
        if player and tr.pilot and tr.pilot == player:
            return tr.id
        if typ and tr.name != typ:
            continue
        if isinstance(lat, (int, float)) and isinstance(lon, (int, float)):
            p = tr.position_interp(t)
            if p is None:
                continue
            d = geo.ground_distance(lon, lat, p[0], p[1])
            if d < best_d:
                best, best_d = tr.id, d
    return best


def find_and_merge(rec: Recording, log_dir: str, player: Optional[Track]) -> Optional[Dict[str, Any]]:
    if player is None:
        return None
    rec_wall = _parse_iso8601(str(rec.globals.get("RecordingTime") or ""))
    best: Optional[Tuple[float, Dict[str, Any], float]] = None
    for path in list_logs(log_dir):
        log = read_log(path)
        if not log["self"]:
            continue
        if rec_wall is not None and log["wallStart"] is not None:
            # RecordingTime is the real time the file was made; allow for it
            # being the start or the end of the recording.
            lo = rec_wall.timestamp() - rec.duration - 3600
            hi = rec_wall.timestamp() + rec.duration + 3600
            if log["wallEnd"] < lo or log["wallStart"] > hi:
                continue
        offset, err = align(player, log["self"])
        if offset is not None and (best is None or err < best[0]):
            best = (err, log, offset)
    if best is None:
        return None
    err, log, offset = best
    return apply(rec, log, offset, err, player)


def apply(rec: Recording, log: Dict[str, Any], offset: float, err: float, player: Track) -> Dict[str, Any]:
    selfs = log["self"]
    times = [r["t"] for r in selfs]
    added: List[str] = []

    def put(tr: Track, name: str, series: array) -> None:
        if any(v == v for v in series):
            tr.channels[name] = series
            added.append(f"{tr.id}:{name}")

    # Your aircraft: control deflection, radar scan zone, countermeasures.
    for ch, key in (("Elevator", "pitch"), ("AileronLeft", "roll"), ("Rudder", "yaw")):
        if ch not in player.channels:
            put(player, ch, _channel_from_log(player, times, [(r.get("ctl") or {}).get(key) for r in selfs], offset))
    scan_rows = [r.get("scan") or {} for r in selfs]
    for ch, key in (("ScanAz", "azHalf"), ("ScanEl", "elHalf"), ("ScanCenterAz", "centerAz"), ("ScanCenterEl", "centerEl")):
        put(player, ch, _channel_from_log(player, times, [s.get(key) if s.get("on", True) else None for s in scan_rows], offset))
    on = [(1.0 if s.get("on") else 0.0) if isinstance(s.get("on"), bool) else None for s in scan_rows]
    put(player, "RadarActive", _channel_from_log(player, times, on, offset))
    for ch, key in (("ChaffCount", "chaff"), ("FlareCount", "flare")):
        put(player, ch, _channel_from_log(player, times, [(r.get("cm") or {}).get(key) for r in selfs], offset))
    put(player, "GunAmmo", _channel_from_log(player, times, [r.get("gun") for r in selfs], offset))

    # Every other unit's radar on/off flag (0.5 Hz snapshots).
    per_track: Dict[str, Tuple[List[float], List[float]]] = {}
    for row in log.get("world", []):
        t = row["t"] + offset
        for name, lat, lon, _alt, radar in row.get("u", []):
            tid = _match_unit(rec, {"type": name, "lat": lat, "lon": lon}, t)
            if tid is None or tid == player.id:
                continue
            ts, vs = per_track.setdefault(tid, ([], []))
            ts.append(row["t"])
            vs.append(1.0 if radar else 0.0)
    for tid, (ts, vs) in per_track.items():
        put(rec.tracks[tid], "RadarActive", _channel_from_log(rec.tracks[tid], ts, vs, offset, hold=True))

    events = []
    for ev in log["events"]:
        t = (ev.get("t") or 0.0) + offset
        events.append({
            "kind": ev.get("kind"), "time": t,
            "initiatorId": _match_unit(rec, ev.get("initiator") or {}, t),
            "targetId": _match_unit(rec, ev.get("target") or {}, t),
            "initiator": ev.get("initiator") or {}, "target": ev.get("target") or {},
            "weapon": ev.get("weapon") or "", "weaponCategory": ev.get("weaponCategory"),
        })
    return {"log": Path(log["path"]).name, "offset": offset, "medianError": err, "events": events,
            "channels": added, "theatre": log["meta"].get("theatre")}
