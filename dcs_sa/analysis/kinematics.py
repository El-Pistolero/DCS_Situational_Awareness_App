"""Derived flight parameters.

ACMI gives us position and attitude; a lot of what a pilot cares about in a
debrief (vertical speed, G, turn rate, specific energy) has to be derived.
When the recording carries a direct measurement - ``VerticalGForce``, ``IAS``
- we prefer it, and fall back to differentiation otherwise.
"""

from __future__ import annotations

import math
from typing import Dict, List, Optional

from ..acmi.model import Track
from . import geo

G0 = 9.80665
NAN = float("nan")


def _isnan(x: float) -> bool:
    return x != x


def _central_diff(t: List[float], y: List[float]) -> List[float]:
    """dy/dt with central differences, robust to repeated timestamps."""
    n = len(t)
    out = [NAN] * n
    if n < 2:
        return out
    for i in range(n):
        lo = max(0, i - 1)
        hi = min(n - 1, i + 1)
        dt = t[hi] - t[lo]
        if dt <= 1e-6 or _isnan(y[hi]) or _isnan(y[lo]):
            continue
        out[i] = (y[hi] - y[lo]) / dt
    return out


def _smooth(values: List[float], window: int) -> List[float]:
    """Centred moving average that skips NaNs."""
    if window <= 1:
        return list(values)
    half = window // 2
    n = len(values)
    out = [NAN] * n
    for i in range(n):
        acc = 0.0
        cnt = 0
        for j in range(max(0, i - half), min(n, i + half + 1)):
            v = values[j]
            if not _isnan(v):
                acc += v
                cnt += 1
        if cnt:
            out[i] = acc / cnt
    return out


def derive(track: Track) -> Dict[str, List[float]]:
    """Compute derived channels for one track.

    Returns a dict of name -> list aligned with ``track.t``:

    ``GroundSpeed`` m/s, ``VerticalSpeed`` m/s, ``Track`` deg (course over
    ground), ``TurnRate`` deg/s, ``GLoad`` g, ``SpecificEnergy`` m (energy
    height), ``Ps`` m/s (specific excess power), ``Speed`` m/s (best available
    airspeed, TAS preferred).
    """
    t = list(track.t)
    n = len(t)
    empty = [NAN] * n
    lon = track.series("Longitude") or empty
    lat = track.series("Latitude") or empty
    alt = track.series("Altitude") or empty
    if n == 0:
        return {}

    # Local metric frame about the first valid fix.
    origin = next(((lo, la) for lo, la in zip(lon, lat) if not _isnan(lo) and not _isnan(la)), None)
    if origin is None:
        return {}
    east: List[float] = []
    north: List[float] = []
    for lo, la in zip(lon, lat):
        if _isnan(lo) or _isnan(la):
            east.append(NAN)
            north.append(NAN)
        else:
            e, nn = geo.to_local(lo, la, origin[0], origin[1])
            east.append(e)
            north.append(nn)

    ve = _central_diff(t, east)
    vn = _central_diff(t, north)
    vu = _central_diff(t, alt)

    ground_speed = [math.hypot(a, b) if not (_isnan(a) or _isnan(b)) else NAN for a, b in zip(ve, vn)]
    course = [
        (math.degrees(math.atan2(a, b)) % 360.0) if gs > 1.0 else NAN
        for a, b, gs in zip(ve, vn, ground_speed)
    ]

    # Prefer recorded true airspeed; fall back to 3-D inertial speed.
    tas = track.series("TAS")
    speed: List[float] = []
    for i in range(n):
        v = tas[i] if tas and not _isnan(tas[i]) else NAN
        if _isnan(v):
            gs = ground_speed[i]
            vz = vu[i]
            v = math.hypot(gs, vz) if not (_isnan(gs) or _isnan(vz)) else NAN
        speed.append(v)

    # Turn rate from heading (attitude) if present, else from course.
    heading = track.series("Yaw") or track.series("HDG") or course
    turn_rate = [NAN] * n
    for i in range(1, n - 1):
        dt = t[i + 1] - t[i - 1]
        h0, h1 = heading[i - 1], heading[i + 1]
        if dt > 1e-6 and not (_isnan(h0) or _isnan(h1)):
            turn_rate[i] = geo.wrap180(h1 - h0) / dt
    turn_rate = _smooth(turn_rate, 3)

    # Load factor: recorded if available, otherwise from turn rate and
    # vertical acceleration (n = sqrt((V*omega)^2 + (g + az)^2) / g).
    g_rec = track.series("VerticalGForce")
    az = _smooth(_central_diff(t, _smooth(vu, 3)), 3)
    gload: List[float] = []
    for i in range(n):
        if g_rec and not _isnan(g_rec[i]):
            gload.append(g_rec[i])
            continue
        v, w, a = speed[i], turn_rate[i], az[i]
        if _isnan(v) or _isnan(w):
            gload.append(NAN)
            continue
        lateral = v * math.radians(w)
        vertical = G0 + (0.0 if _isnan(a) else a)
        gload.append(math.hypot(lateral, vertical) / G0)

    # Energy height Es = h + V^2 / 2g, and Ps = dEs/dt.
    es = [
        (h + v * v / (2 * G0)) if not (_isnan(h) or _isnan(v)) else NAN
        for h, v in zip(alt, speed)
    ]
    ps = _smooth(_central_diff(t, es), 5)

    return {
        "GroundSpeed": ground_speed,
        "VerticalSpeed": vu,
        "Track": course,
        "TurnRate": turn_rate,
        "GLoad": gload,
        "SpecificEnergy": es,
        "Ps": ps,
        "Speed": speed,
    }


def flight_stats(track: Track, derived: Optional[Dict[str, List[float]]] = None) -> Dict[str, float]:
    """Headline numbers for a sortie."""
    derived = derived if derived is not None else derive(track)
    t = list(track.t)

    def _vals(series: List[float]) -> List[float]:
        return [v for v in series if not _isnan(v)]

    stats: Dict[str, float] = {"duration": (t[-1] - t[0]) if t else 0.0}

    alt = _vals(track.series("Altitude"))
    if alt:
        stats["maxAltitude"] = max(alt)
        stats["minAltitude"] = min(alt)

    for key, src in (("maxIAS", "IAS"), ("maxTAS", "TAS"), ("maxMach", "Mach"), ("maxAOA", "AOA")):
        vals = _vals(track.series(src))
        if vals:
            stats[key] = max(vals)

    g = _vals(derived.get("GLoad", []))
    if g:
        stats["maxG"] = max(g)
        stats["minG"] = min(g)

    gs = derived.get("GroundSpeed", [])
    dist = 0.0
    for i in range(1, len(t)):
        v = gs[i]
        if not _isnan(v):
            dist += v * (t[i] - t[i - 1])
    stats["distance"] = dist

    fuel = [v for v in track.series("FuelWeight") if not _isnan(v)]
    if len(fuel) >= 2:
        stats["fuelStart"] = fuel[0]
        stats["fuelEnd"] = fuel[-1]
        stats["fuelUsed"] = max(0.0, fuel[0] - fuel[-1])

    ab = track.series("Afterburner")
    if ab:
        ab_time = 0.0
        for i in range(1, len(t)):
            if not _isnan(ab[i]) and ab[i] > 0.05:
                ab_time += t[i] - t[i - 1]
        stats["afterburnerTime"] = ab_time

    return stats
