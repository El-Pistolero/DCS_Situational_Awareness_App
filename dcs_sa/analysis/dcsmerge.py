"""Merge what DCS reported during the flight into a recording's analysis.

A flight log (see :mod:`dcs_sa.flightlog`) holds values read from DCS while
flying - your control deflections, radar scan zone and engine, every unit's
radar on/off flag, and DCS's own shot/hit/kill events.  This module finds the log
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
MOVING_SPEED = 20.0      # m/s: only rows where the jet moves can pin the clock
MIN_MOVING_ROWS = 10
NAN = float("nan")


def _median(xs: List[float]) -> float:
    xs = sorted(xs)
    return xs[len(xs) // 2] if xs else math.inf


def _num(v: Any) -> Optional[float]:
    return float(v) if isinstance(v, (int, float)) and v == v else None


def _engine1(rpm: Any) -> Optional[float]:
    """Engine 1 from the log's [left, right] RPM: the left, else the right."""
    if not isinstance(rpm, list):
        return None
    return next((_num(v) for v in rpm[:2] if _num(v) is not None), None)


def _moving_rows(selfs: List[Dict[str, Any]]) -> List[Dict[str, Any]]:
    """Rows where the aircraft is moving.  Parked rows match any parked
    stretch of the recording, so they cannot tell clock offsets apart."""
    pts = [r for r in selfs if isinstance(r.get("lat"), (int, float)) and isinstance(r.get("lon"), (int, float))]
    out = []
    for i, r in enumerate(pts):
        spd = r.get("tas") if isinstance(r.get("tas"), (int, float)) else r.get("ias")
        if not isinstance(spd, (int, float)):
            q = pts[i - 1] if i else (pts[i + 1] if i + 1 < len(pts) else None)
            dt = abs(r["t"] - q["t"]) if q else 0.0
            spd = geo.ground_distance(r["lon"], r["lat"], q["lon"], q["lat"]) / dt if q and dt > 1e-3 else 0.0
        if spd >= MOVING_SPEED:
            out.append(r)
    return out


def align(track: Track, selfs: List[Dict[str, Any]]) -> Tuple[Optional[float], float]:
    """Time offset (recording t = log t + offset) and median position error."""
    pts = _moving_rows(selfs)
    if len(pts) < MIN_MOVING_ROWS or not len(track):
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
    err, offset = min((error(c), c) for c in candidates)
    if err == math.inf:
        return None, err
    # Refine: the coarse candidates come from strided samples.
    for span, step in ((3.0, 0.25), (0.3, 0.02)):
        base = offset
        k = int(span / step)
        for i in range(-k, k + 1):
            c = base + i * step
            e = error(c)
            if e < err:
                err, offset = e, c
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


SKIP = ("round", "clutter", "countermeasure", "weapon", "bullseye", "navaid", "misc")


class _UnitMatcher:
    """DCS unit (name/type/player/position) -> recording object id, indexed."""

    def __init__(self, rec: Recording) -> None:
        self.rec = rec
        self.by_name: Dict[str, List[Track]] = {}
        self.by_pilot: Dict[str, Track] = {}
        self.all: List[Track] = []
        for tr in rec.tracks.values():
            if tr.category in SKIP:
                continue
            self.all.append(tr)
            self.by_name.setdefault(tr.name, []).append(tr)
            if tr.pilot:
                self.by_pilot.setdefault(tr.pilot, tr)
        self.static: Dict[Tuple, Optional[str]] = {}

    def match(self, unit: Dict[str, Any], t: float) -> Optional[str]:
        if not unit:
            return None
        player = (unit.get("player") or "").strip()
        if player and player in self.by_pilot and self.by_pilot[player].alive_at(t, grace=2.0):
            return self.by_pilot[player].id
        typ = unit.get("type") or ""
        lat, lon = unit.get("lat"), unit.get("lon")
        cands = self.by_name.get(typ) if typ else self.all
        if not cands:
            return None
        if not (isinstance(lat, (int, float)) and isinstance(lon, (int, float))):
            return None
        key = (typ, round(lat, 4), round(lon, 4))
        if key in self.static:  # ground units don't move: match once
            tid = self.static[key]
            if tid is None or self.rec.tracks[tid].alive_at(t, grace=2.0):
                return tid
        best, best_d = None, 3000.0
        for tr in cands:
            if not tr.alive_at(t, grace=2.0):
                continue
            p = tr.position_interp(t)
            if p is None:
                continue
            d = geo.ground_distance(lon, lat, p[0], p[1])
            if d < best_d:
                best, best_d = tr, d
        if best is not None and best.category in ("ground", "sea"):
            self.static[key] = best.id
        return best.id if best else None


def _match_unit(rec: Recording, unit: Dict[str, Any], t: float) -> Optional[str]:
    return _UnitMatcher(rec).match(unit, t)


def _log_span(path: Path) -> Tuple[Optional[float], Optional[float]]:
    """Wall-clock start (from the file name, UTC) and end (mtime) without reading it."""
    try:
        stamp = path.stem.split("-", 1)[1][:15]
        start = datetime.strptime(stamp, "%Y%m%d-%H%M%S").replace(tzinfo=timezone.utc).timestamp()
    except (IndexError, ValueError):
        start = None
    try:
        end = path.stat().st_mtime
    except OSError:
        end = None
    return start, end


def find_and_merge(rec: Recording, log_dir: str, player: Optional[Track]) -> Optional[Dict[str, Any]]:
    """Merge every flight log that lines up with this recording."""
    if player is None:
        return None
    rec_wall = _parse_iso8601(str(rec.globals.get("RecordingTime") or ""))
    lo = hi = None
    if rec_wall is not None:
        # RecordingTime is the real time the file was made; allow for it
        # being the start or the end of the recording.
        lo = rec_wall.timestamp() - rec.duration - 3600
        hi = rec_wall.timestamp() + rec.duration + 3600
    aligned: List[Tuple[float, Dict[str, Any], float]] = []
    for path in list_logs(log_dir):
        if lo is not None:
            start, end = _log_span(path)  # cheap filter before parsing
            if (start is not None and start > hi) or (end is not None and end < lo):
                continue
        log = read_log(path)
        if not log["self"]:
            continue
        if lo is not None and log["wallStart"] is not None and (log["wallEnd"] < lo or log["wallStart"] > hi):
            continue
        offset, err = align(player, log["self"])
        if offset is not None:
            aligned.append((err, log, offset))
    if not aligned:
        return None
    # Keep logs that cover different parts of the flight (a pause or an app
    # restart splits one flight into several); for overlaps, the best fit.
    aligned.sort(key=lambda x: x[0])
    chosen: List[Tuple[float, Dict[str, Any], float, Tuple[float, float]]] = []
    for err, log, offset in aligned:
        ts = [r["t"] for r in log["self"]]
        span = (min(ts) + offset, max(ts) + offset)
        overlap = sum(max(0.0, min(span[1], c[3][1]) - max(span[0], c[3][0])) for c in chosen)
        if overlap < 0.5 * (span[1] - span[0]):
            chosen.append((err, log, offset, span))
    chosen.sort(key=lambda c: c[3][0])
    merged: Dict[str, Any] = {"path": chosen[0][1]["path"], "meta": {}, "self": [], "events": [], "world": []}
    for err, log, offset, span in chosen:
        merged["meta"].update(log["meta"])
        for key in ("self", "world", "events"):
            for r in log[key]:
                if isinstance(r.get("t"), (int, float)):
                    merged[key].append({**r, "t": r["t"] + offset})  # now on the recording's clock
    merged["self"].sort(key=lambda r: r["t"])
    merged["world"].sort(key=lambda r: r["t"])
    errs = [c[0] for c in chosen]
    out = apply(rec, merged, 0.0, max(errs), player)
    out.update({
        "log": ", ".join(Path(c[1]["path"]).name for c in chosen),
        "logs": [Path(c[1]["path"]).name for c in chosen],
        "offset": chosen[0][2],
        "coverage": [list(c[3]) for c in chosen],
    })
    return out


def apply(rec: Recording, log: Dict[str, Any], offset: float, err: float, player: Track) -> Dict[str, Any]:
    selfs = log["self"]
    times = [r["t"] for r in selfs]
    added: List[str] = []
    matcher = _UnitMatcher(rec)

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
    # Engine, where the recording has none: DCS's fuel flow (left + right, in
    # DCS's raw units - not kg/h, hence its own channel, not FuelFlowWeight)
    # and engine 1's RPM (the left engine, else the right; DCS gives percent).
    engs = [r.get("eng") if isinstance(r.get("eng"), dict) else {} for r in selfs]
    if "FuelFlowWeight" not in player.channels:
        put(player, "DcsFuelFlow", _channel_from_log(player, times, [_num(e.get("ff")) for e in engs], offset))
    if "EngineRPM" not in player.channels:
        put(player, "EngineRPM", _channel_from_log(player, times, [_engine1(e.get("rpm")) for e in engs], offset))

    # Every other unit's radar on/off flag (0.5 Hz snapshots).
    per_track: Dict[str, Tuple[List[float], List[float]]] = {}
    for row in log.get("world", []):
        t = row["t"] + offset
        for name, lat, lon, _alt, radar in row.get("u", []):
            tid = matcher.match({"type": name, "lat": lat, "lon": lon}, t)
            if tid is None or tid == player.id:
                continue
            ts, vs = per_track.setdefault(tid, ([], []))
            ts.append(row["t"])
            vs.append(1.0 if radar else 0.0)
    radar_series: Dict[str, List[List[float]]] = rec.extras.setdefault("dcsRadar", {})
    for tid, (ts, vs) in per_track.items():
        tr = rec.tracks[tid]
        if tr.category in ("ground", "sea"):
            # Static units have one ACMI sample or so: keep DCS's changes as
            # their own time series (recording clock) instead of resampling.
            ct, cv = [], []
            for t, v in zip(ts, vs):
                if not cv or cv[-1] != v:
                    ct.append(round(t + offset, 2))
                    cv.append(v)
            radar_series[tid] = [ct, cv]
            added.append(f"{tid}:RadarActive")
        else:
            put(tr, "RadarActive", _channel_from_log(tr, ts, vs, offset, hold=True))

    events = []
    for ev in log["events"]:
        t = (ev.get("t") or 0.0) + offset
        events.append({
            "kind": ev.get("kind"), "time": t,
            "initiatorId": matcher.match(ev.get("initiator") or {}, t),
            "targetId": matcher.match(ev.get("target") or {}, t),
            "initiator": ev.get("initiator") or {}, "target": ev.get("target") or {},
            "weapon": ev.get("weapon") or "", "weaponCategory": ev.get("weaponCategory"),
            # Shots (newer hooks): Weapon.GuidanceType and what the weapon
            # itself was guiding on at launch.
            "guidance": ev.get("guidance"),
            "weaponTargetId": matcher.match(ev.get("weaponTarget") or {}, t),
        })
    ts_all = [r["t"] + offset for r in selfs]
    return {"log": Path(log["path"]).name, "offset": offset, "medianError": err, "events": events,
            "channels": added, "theatre": log["meta"].get("theatre"),
            "coverage": [[min(ts_all), max(ts_all)]] if ts_all else []}
