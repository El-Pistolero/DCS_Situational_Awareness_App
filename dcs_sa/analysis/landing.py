"""Takeoff and landing analysis.

ACMI carries no runway database, so everything here is measured relative to
where the aircraft actually touched down:

* the *final approach course* comes from the rollout ground track (or, for
  a carrier trap with no rollout, from the last seconds of the approach);
* the *glideslope* is the angle from the touchdown point, flown against a
  3.0 deg (airfield) or 3.5 deg (carrier) reference;
* for a carrier the whole approach is re-expressed in a frame moving with
  the ship, so a 25 kt carrier does not show up as a lateral drift.
"""

from __future__ import annotations

import math
from dataclasses import asdict, dataclass, field
from typing import Dict, List, Optional, Tuple

from ..acmi import types as T
from ..acmi.model import Recording, Track
from . import geo
from .kinematics import derive

NAN = float("nan")

AIRFIELD_GLIDESLOPE = 3.0
CARRIER_GLIDESLOPE = 3.5
#: Approach gates, metres from touchdown along the final course.
GATES_NM = (4.0, 3.0, 2.0, 1.0, 0.5, 0.25)
STABLE_HEIGHT_M = 152.4  # 500 ft
AIRBORNE_MIN_S = 3.0
GROUND_MIN_S = 1.0


def _isnan(x: float) -> bool:
    return x != x


@dataclass
class ApproachGate:
    distance_nm: float
    time: float
    height: float
    glidepath: float
    gs_deviation_deg: float
    gs_deviation_m: float
    lateral_m: float
    ias: float
    aoa: float
    vertical_speed: float
    bank: float


@dataclass
class Landing:
    aircraft_id: str
    aircraft_name: str
    pilot: Optional[str]
    time: float
    kind: str  # "airfield" | "carrier"
    location: str
    confirmed_by_event: bool
    touchdown: Dict[str, float] = field(default_factory=dict)
    approach_course: Optional[float] = None
    reference_glideslope: float = AIRFIELD_GLIDESLOPE
    gates: List[ApproachGate] = field(default_factory=list)
    stabilized: Dict[str, object] = field(default_factory=dict)
    rollout: Dict[str, float] = field(default_factory=dict)
    outcome: str = "landed"  # landed | touch-and-go | bolter | trap | bounced
    bounces: int = 0
    score: int = 100
    grade: str = ""
    comments: List[str] = field(default_factory=list)
    profile: Dict[str, List[float]] = field(default_factory=dict)

    def to_dict(self) -> Dict:
        d = asdict(self)
        return _json_safe(d)


@dataclass
class Takeoff:
    aircraft_id: str
    aircraft_name: str
    pilot: Optional[str]
    time: float
    location: str
    confirmed_by_event: bool
    runway_heading: Optional[float] = None
    liftoff_ias: Optional[float] = None
    liftoff_pitch: Optional[float] = None
    liftoff_aoa: Optional[float] = None
    ground_roll_m: Optional[float] = None
    ground_roll_s: Optional[float] = None
    gear_up_after_s: Optional[float] = None
    climb_rate_10s: Optional[float] = None
    afterburner_used: Optional[bool] = None
    kind: str = "runway"  # runway | carrier | vertical

    def to_dict(self) -> Dict:
        return _json_safe(asdict(self))


def _json_safe(obj):
    if isinstance(obj, float):
        return None if math.isnan(obj) or math.isinf(obj) else round(obj, 4)
    if isinstance(obj, dict):
        return {_camel(k): _json_safe(v) for k, v in obj.items()}
    if isinstance(obj, (list, tuple)):
        return [_json_safe(v) for v in obj]
    return obj


def _camel(key: str) -> str:
    parts = key.split("_")
    return parts[0] + "".join(p[:1].upper() + p[1:] for p in parts[1:])


# ---------------------------------------------------------------------------
# Ground contact detection
# ---------------------------------------------------------------------------


def ground_mask(track: Track, derived: Dict[str, List[float]]) -> List[bool]:
    """Per-sample on-ground flag.

    Uses AGL when the recording has it; otherwise infers ground contact from
    being slow, level and at the local altitude floor.
    """
    t = list(track.t)
    n = len(t)
    agl = track.series("AGL")
    alt = track.series("Altitude")
    speed = track.series("IAS") or derived.get("Speed", [NAN] * n)
    vs = derived.get("VerticalSpeed", [NAN] * n)
    gear = track.series("LandingGear")

    has_agl = bool(agl) and any(not _isnan(v) for v in agl)
    mask = [False] * n
    if has_agl:
        # DCS reports AGL of the aircraft's reference point, so a parked jet
        # reads a metre or two, not zero.  Calibrate from slow samples.
        slow_agl = sorted(
            agl[i] for i in range(n)
            if not _isnan(agl[i]) and speed and not _isnan(speed[i]) and speed[i] < 15.0
        )
        # Use the floor rather than the median so a hovering helicopter cannot
        # teach us that "ground" is ten metres up, and ignore implausible
        # references from aircraft that never actually sat on the ground.
        ground_ref = slow_agl[0] if slow_agl else 0.0
        if not -1.0 <= ground_ref <= 5.0:
            ground_ref = 0.0
        limit = ground_ref + 0.6
        for i in range(n):
            a = agl[i]
            s = speed[i] if speed else NAN
            mask[i] = (not _isnan(a)) and a < limit and (_isnan(s) or s < 125.0)
    else:
        # Rolling altitude floor over +/- 30 s approximates terrain height
        # where the aircraft is sitting.
        lo = 0
        from collections import deque

        window: deque = deque()
        floor = [NAN] * n
        hi = 0
        for i in range(n):
            while hi < n and t[hi] <= t[i] + 30.0:
                while window and alt[window[-1]] >= alt[hi]:
                    window.pop()
                window.append(hi)
                hi += 1
            while t[lo] < t[i] - 30.0:
                lo += 1
            while window and window[0] < lo:
                window.popleft()
            if window:
                floor[i] = alt[window[0]]
        for i in range(n):
            a, f, s, v = alt[i], floor[i], speed[i] if speed else NAN, vs[i]
            if _isnan(a) or _isnan(f):
                continue
            near_floor = a - f < 2.5
            slow = _isnan(s) or s < 110.0
            level = _isnan(v) or abs(v) < 1.0
            gear_down = not gear or _isnan(gear[i]) or gear[i] > 0.9
            mask[i] = near_floor and slow and level and gear_down

    return _debounce(t, mask)


def _debounce(t: List[float], mask: List[bool]) -> List[bool]:
    """Drop blips: short airborne gaps are bounces, short ground runs are noise."""
    n = len(mask)
    if n < 3:
        return mask
    out = list(mask)

    def runs(m):
        i = 0
        while i < n:
            j = i
            while j + 1 < n and m[j + 1] == m[i]:
                j += 1
            yield i, j, m[i]
            i = j + 1

    for i, j, val in list(runs(out)):
        if val and 0 < i and j < n - 1 and t[j] - t[i] < GROUND_MIN_S * 0.5:
            for k in range(i, j + 1):
                out[k] = False
    return out


def _transitions(t: List[float], mask: List[bool]) -> Tuple[List[int], List[int]]:
    """(takeoff indices, touchdown indices) from a ground mask."""
    takeoffs: List[int] = []
    touchdowns: List[int] = []
    for i in range(1, len(mask)):
        if mask[i - 1] and not mask[i]:
            takeoffs.append(i)
        elif not mask[i - 1] and mask[i]:
            touchdowns.append(i)
    return takeoffs, touchdowns


# ---------------------------------------------------------------------------
# Landing
# ---------------------------------------------------------------------------


def _find_carrier(rec: Recording, lon: float, lat: float, t: float) -> Optional[Track]:
    for tr in rec.tracks.values():
        if not T.is_carrier(tr.tags) or not tr.alive_at(t, grace=5.0):
            continue
        pos = tr.position_at(t)
        if pos and geo.ground_distance(lon, lat, pos[0], pos[1]) < 450.0:
            return tr
    return None


def _nearest_aerodrome(rec: Recording, lon: float, lat: float) -> Optional[str]:
    best, best_d = None, 8000.0
    for tr in rec.tracks.values():
        if "Aerodrome" not in tr.tags:
            continue
        pos = tr.position_at(tr.first_seen)
        if pos is None:
            continue
        d = geo.ground_distance(lon, lat, pos[0], pos[1])
        if d < best_d:
            best, best_d = tr.name, d
    return best


def _event_near(rec: Recording, kind: str, obj_id: str, t: float, window: float = 15.0):
    best = None
    for e in rec.events:
        if e.kind == kind and obj_id in e.object_ids and abs(e.time - t) <= window:
            if best is None or abs(e.time - t) < abs(best.time - t):
                best = e
    return best


def _grade(landing: Landing) -> None:
    carrier = landing.kind == "carrier"
    score = 100
    notes: List[str] = []
    td = landing.touchdown
    sink = td.get("sinkRate")

    if td.get("gear") is not None and td["gear"] < 0.9:
        landing.score = 0
        landing.grade = "Gear-up landing" if not carrier else "C (cut)"
        landing.comments = ["Landing gear was not down at touchdown."]
        return

    if sink is not None:
        fpm = sink * geo.FPM_PER_MPS
        limits = (4.6, 5.6) if carrier else (2.5, 3.5)
        if sink > limits[1]:
            score -= 30
            notes.append(f"Hard landing: {fpm:.0f} fpm sink at touchdown.")
        elif sink > limits[0]:
            score -= 12
            notes.append(f"Firm touchdown: {fpm:.0f} fpm.")
        elif not carrier and sink < 0.3:
            notes.append("Very smooth touchdown.")

    crab = td.get("crab")
    if crab is not None and abs(crab) > 5.0:
        score -= 10
        notes.append(f"Touched down with {abs(crab):.0f} deg of crab.")
    bank = td.get("bank")
    if bank is not None and abs(bank) > 5.0:
        score -= 8
        notes.append(f"Wing low at touchdown ({abs(bank):.0f} deg bank).")

    for gate in landing.gates:
        # Beyond 2 nm is too early to matter; inside 0.5 nm the angular
        # glidepath is dominated by the flare.
        if gate.distance_nm > 2.0 or gate.distance_nm < 0.5:
            continue
        dev = gate.gs_deviation_deg
        if abs(dev) > (1.0 if gate.distance_nm <= 0.5 else 0.7):
            score -= 5
            notes.append(
                f"{'High' if dev > 0 else 'Low'} at {gate.distance_nm:g} nm "
                f"({abs(dev):.1f} deg {'above' if dev > 0 else 'below'} glidepath)."
            )
        lateral = gate.lateral_m
        if abs(lateral) > (20.0 if carrier else 45.0) and gate.distance_nm <= 1.0:
            score -= 5
            notes.append(
                f"Lined up {'right' if lateral > 0 else 'left'} at {gate.distance_nm:g} nm "
                f"({abs(lateral):.0f} m)."
            )

    stab = landing.stabilized
    if stab and not stab.get("stable", True):
        score -= 10
        notes.append("Not stabilised by 500 ft: " + "; ".join(stab.get("reasons", [])) + ".")

    if landing.bounces:
        score -= 15
        notes.append(f"Bounced {landing.bounces} time(s).")

    if landing.outcome == "bolter":
        notes.append("Bolter - hook did not engage a wire.")
    if landing.outcome == "touch-and-go":
        notes.append("Touch-and-go.")

    score = max(0, min(100, score))
    landing.score = score
    if carrier:
        if landing.outcome == "bolter":
            landing.grade = "B (bolter)"
        elif score >= 92:
            landing.grade = "OK"
        elif score >= 80:
            landing.grade = "(OK) fair"
        elif score >= 60:
            landing.grade = "-- no grade"
        else:
            landing.grade = "C (cut)"
    else:
        landing.grade = "A" if score >= 90 else "B" if score >= 80 else "C" if score >= 70 else "D" if score >= 60 else "F"
    landing.comments = notes or ["Clean approach and touchdown."]


def _refine_touchdown(t: List[float], alt: List[float], idx: int) -> int:
    """Move a coarse touchdown index to where the altitude bottoms out.

    Threshold-based ground detection trips during the flare; the true contact
    is the first sample within a few decimetres of the post-landing floor.
    """
    n = len(t)
    hi = idx
    while hi + 1 < n and t[hi + 1] <= t[idx] + 5.0:
        hi += 1
    window = [alt[i] for i in range(idx, hi + 1) if not _isnan(alt[i])]
    if not window:
        return idx
    floor = min(window)
    lo = idx
    while lo > 0 and t[lo - 1] >= t[idx] - 4.0:
        lo -= 1
    for i in range(lo, hi + 1):
        if not _isnan(alt[i]) and alt[i] <= floor + 0.3:
            return i
    return idx


def _analyze_landing(
    rec: Recording,
    tr: Track,
    derived: Dict[str, List[float]],
    mask: List[bool],
    idx: int,
) -> Landing:
    t = list(tr.t)
    n = len(t)
    idx = _refine_touchdown(t, tr.series("Altitude"), idx)
    td_t = t[idx]
    lon = tr.series("Longitude")
    lat = tr.series("Latitude")
    alt = tr.series("Altitude")
    vs = derived.get("VerticalSpeed", [NAN] * n)
    speed = tr.series("IAS") or derived.get("Speed", [NAN] * n)
    aoa = tr.series("AOA")
    roll = tr.series("Roll")
    yaw = tr.series("Yaw") or tr.series("HDG")
    course = derived.get("Track", [NAN] * n)
    gear = tr.series("LandingGear")
    gload = tr.series("VerticalGForce")

    def at(series, i, default=NAN):
        return series[i] if series and 0 <= i < len(series) else default

    carrier = _find_carrier(rec, lon[idx], lat[idx], td_t)
    ev = _event_near(rec, "Landed", tr.id, td_t)
    if carrier is not None:
        location = carrier.name
    elif ev is not None and ev.text:
        location = ev.text
    else:
        location = _nearest_aerodrome(rec, lon[idx], lat[idx]) or f"{lat[idx]:.3f}, {lon[idx]:.3f}"

    landing = Landing(
        aircraft_id=tr.id,
        aircraft_name=tr.name,
        pilot=tr.pilot,
        time=td_t,
        kind="carrier" if carrier else "airfield",
        location=location,
        confirmed_by_event=ev is not None,
        reference_glideslope=CARRIER_GLIDESLOPE if carrier else AIRFIELD_GLIDESLOPE,
    )

    # Ship-relative frame: remove the carrier's own motion.
    def ship_shift(ti: float) -> Tuple[float, float]:
        if carrier is None:
            return 0.0, 0.0
        p_now = carrier.position_at(ti)
        p_td = carrier.position_at(td_t)
        if p_now is None or p_td is None:
            return 0.0, 0.0
        return geo.to_local(p_now[0], p_now[1], p_td[0], p_td[1])

    origin = (lon[idx], lat[idx])
    td_alt = alt[idx]

    def rel(i: int) -> Tuple[float, float]:
        e, nn = geo.to_local(lon[i], lat[i], origin[0], origin[1])
        se, sn = ship_shift(t[i])
        return e - se, nn - sn

    # Samples between the refined contact and the coarse ground edge are on
    # the runway too.
    mask = list(mask)
    k = idx
    while k < n and not mask[k] and t[k] <= td_t + 2.0:
        mask[k] = True
        k += 1

    # Final approach course: rollout if it rolled, else the last 12 s in.
    j = idx
    while j + 1 < n and t[j + 1] <= td_t + 8.0 and mask[j + 1]:
        j += 1
    re, rn = rel(j)
    if math.hypot(re, rn) > 150.0:
        crs = math.degrees(math.atan2(re, rn)) % 360.0
    else:
        k = idx
        while k > 0 and t[k - 1] >= td_t - 12.0:
            k -= 1
        ke, kn = rel(k)
        crs = math.degrees(math.atan2(-ke, -kn)) % 360.0
    landing.approach_course = crs
    ux, uy = math.sin(math.radians(crs)), math.cos(math.radians(crs))

    # Touchdown state.  Sink rate is averaged over the last second airborne
    # because a single-sample derivative at contact is dominated by the
    # altitude clamp.
    k = idx - 1
    sinks = []
    while k >= 0 and t[k] >= td_t - 1.0:
        if not _isnan(vs[k]):
            sinks.append(-vs[k])
        k -= 1
    raw_sink = max(0.0, sum(sinks) / len(sinks)) if sinks else NAN
    hdg_td = at(yaw, idx)
    crs_td = at(course, max(idx - 1, 0))
    td_info: Dict[str, float] = {
        "longitude": lon[idx],
        "latitude": lat[idx],
        "altitude": td_alt,
        "sinkRate": raw_sink,
        "sinkRateFpm": raw_sink * geo.FPM_PER_MPS if not _isnan(raw_sink) else NAN,
        "ias": at(speed, idx - 1),
        "aoa": at(aoa, idx - 1),
        "pitch": at(tr.series("Pitch"), idx - 1),
        "bank": at(roll, idx - 1),
        "gear": at(gear, idx),
        "flaps": at(tr.series("Flaps"), idx),
        "tailhook": at(tr.series("Tailhook"), idx),
    }
    if not _isnan(hdg_td) and not _isnan(crs_td):
        td_info["crab"] = geo.wrap180(hdg_td - crs_td)
    if gload:
        peak = max((gload[i] for i in range(max(0, idx - 2), min(n, idx + 3)) if not _isnan(gload[i])), default=NAN)
        td_info["gLoad"] = peak
    landing.touchdown = td_info

    # Approach profile & gates (only while airborne, before touchdown).  The
    # refined contact can sit a sample or two after the coarse ground edge,
    # so step back over those flare samples before walking the approach.
    start = idx
    while start > 0 and t[start - 1] >= td_t - 3.0 and mask[start - 1]:
        start -= 1
    while start > 0 and t[start - 1] >= td_t - 240.0 and not mask[start - 1]:
        start -= 1
    prof_d: List[float] = []
    prof_h: List[float] = []
    prof_x: List[float] = []
    prof_t: List[float] = []
    for i in range(start, idx + 1):
        e, nn = rel(i)
        along = -(e * ux + nn * uy)  # positive before touchdown
        cross = e * uy - nn * ux  # positive right of course
        if along < 0 or along > 20000.0:
            continue
        prof_t.append(t[i] - td_t)
        prof_d.append(along)
        prof_h.append(alt[i] - td_alt)
        prof_x.append(cross)
    landing.profile = {"t": prof_t, "distance": prof_d, "height": prof_h, "lateral": prof_x}

    ref = landing.reference_glideslope
    tan_ref = math.tan(math.radians(ref))
    for gate_nm in GATES_NM:
        gd = gate_nm * 1852.0
        for p in range(len(prof_d) - 1):
            if prof_d[p] >= gd >= prof_d[p + 1]:
                span = prof_d[p] - prof_d[p + 1]
                f = (prof_d[p] - gd) / span if span > 1e-6 else 0.0
                h = prof_h[p] + f * (prof_h[p + 1] - prof_h[p])
                x = prof_x[p] + f * (prof_x[p + 1] - prof_x[p])
                tg = td_t + prof_t[p] + f * (prof_t[p + 1] - prof_t[p])
                gi = tr.index_at(tg)
                gp = math.degrees(math.atan2(h, gd))
                landing.gates.append(ApproachGate(
                    distance_nm=gate_nm, time=tg, height=h, glidepath=gp,
                    gs_deviation_deg=gp - ref, gs_deviation_m=h - gd * tan_ref,
                    lateral_m=x, ias=at(speed, gi), aoa=at(aoa, gi),
                    vertical_speed=at(vs, gi), bank=at(roll, gi),
                ))
                break

    # Stabilised-approach check at 500 ft above touchdown.
    stab_i = None
    for i in range(idx, start - 1, -1):
        if alt[i] - td_alt >= STABLE_HEIGHT_M:
            stab_i = i
            break
    if stab_i is not None:
        reasons: List[str] = []
        sink500 = -at(vs, stab_i)
        if not _isnan(sink500) and sink500 * geo.FPM_PER_MPS > 1000.0:
            reasons.append(f"sink {sink500 * geo.FPM_PER_MPS:.0f} fpm")
        b = at(roll, stab_i)
        if not _isnan(b) and abs(b) > 15.0:
            reasons.append(f"{abs(b):.0f} deg bank")
        g = at(gear, stab_i)
        if not _isnan(g) and g < 0.95:
            reasons.append("gear not down")
        spd = [speed[i] for i in range(stab_i, idx) if speed and not _isnan(speed[i])]
        if len(spd) > 3:
            mean = sum(spd) / len(spd)
            sd = math.sqrt(sum((v - mean) ** 2 for v in spd) / len(spd))
            if sd > 4.0:
                reasons.append(f"speed unstable (+/-{sd * geo.KT_PER_MPS:.0f} kt)")
        e, nn = rel(stab_i)
        cross = e * uy - nn * ux
        if abs(cross) > (25.0 if carrier else 60.0):
            reasons.append(f"{abs(cross):.0f} m off centreline")
        landing.stabilized = {"time": t[stab_i], "stable": not reasons, "reasons": reasons}

    # Rollout / outcome.
    j = idx
    bounces = 0
    airborne_again = None
    while j + 1 < n:
        j += 1
        if not mask[j]:
            # Airborne again - bounce or go-around?
            k = j
            while k + 1 < n and not mask[k + 1]:
                k += 1
            if t[k] - t[j] < AIRBORNE_MIN_S and k + 1 < n:
                bounces += 1
                j = k
                continue
            airborne_again = t[j]
            break
        s = at(speed, j)
        if not _isnan(s) and s < 15.0:
            break
    landing.bounces = bounces
    if airborne_again is not None:
        landing.outcome = "bolter" if carrier else "touch-and-go"
    else:
        stop_e, stop_n = rel(j)
        roll_m = math.hypot(stop_e, stop_n)
        landing.rollout = {"distance": roll_m, "time": t[j] - td_t}
        if carrier:
            landing.outcome = "trap" if roll_m < 150.0 else "landed"
        elif bounces:
            landing.outcome = "bounced"

    _grade(landing)
    return landing


def _analyze_takeoff(
    rec: Recording,
    tr: Track,
    derived: Dict[str, List[float]],
    mask: List[bool],
    idx: int,
) -> Takeoff:
    t = list(tr.t)
    n = len(t)
    speed = tr.series("IAS") or derived.get("Speed", [NAN] * n)
    gs = derived.get("GroundSpeed", [NAN] * n)
    lon, lat = tr.series("Longitude"), tr.series("Latitude")
    alt = tr.series("Altitude")
    gear = tr.series("LandingGear")
    ab = tr.series("Afterburner")
    lt = t[idx]

    carrier = _find_carrier(rec, lon[idx], lat[idx], lt)
    ev = _event_near(rec, "TakenOff", tr.id, lt)
    location = (carrier.name if carrier else (ev.text if ev and ev.text else None)) or \
        _nearest_aerodrome(rec, lon[idx], lat[idx]) or f"{lat[idx]:.3f}, {lon[idx]:.3f}"

    to = Takeoff(
        aircraft_id=tr.id, aircraft_name=tr.name, pilot=tr.pilot, time=lt,
        location=location, confirmed_by_event=ev is not None,
        kind="carrier" if carrier else "runway",
    )
    to.liftoff_ias = speed[idx] if speed else None
    to.liftoff_pitch = tr.value_at("Pitch", lt)
    to.liftoff_aoa = tr.value_at("AOA", lt)

    # Start of the roll: walk back while on the ground and moving.
    k = idx - 1
    while k > 0 and mask[k - 1] and not _isnan(gs[k - 1]) and gs[k - 1] > 2.0:
        k -= 1
    if 0 <= k < idx:
        to.ground_roll_m = geo.ground_distance(lon[k], lat[k], lon[idx], lat[idx])
        to.ground_roll_s = lt - t[k]
        crs = geo.bearing(lon[k], lat[k], lon[idx], lat[idx])
        to.runway_heading = crs if to.ground_roll_m and to.ground_roll_m > 100 else None
        if ab:
            to.afterburner_used = any(not _isnan(ab[i]) and ab[i] > 0.05 for i in range(k, idx + 1))
        if to.ground_roll_m is not None and to.ground_roll_m < 30.0:
            to.kind = "vertical"

    if gear:
        for i in range(idx, n):
            if t[i] - lt > 60.0:
                break
            if not _isnan(gear[i]) and gear[i] < 0.05:
                to.gear_up_after_s = t[i] - lt
                break

    i10 = tr.index_at(lt + 10.0)
    if 0 <= i10 < n and not _isnan(alt[i10]) and not _isnan(alt[idx]) and t[i10] > lt:
        to.climb_rate_10s = (alt[i10] - alt[idx]) / (t[i10] - lt)
    return to


def analyze_landings(rec: Recording, aircraft: Optional[List[Track]] = None) -> Dict[str, List]:
    """Find and analyse every takeoff and landing in the recording."""
    aircraft = aircraft if aircraft is not None else rec.aircraft()
    landings: List[Landing] = []
    takeoffs: List[Takeoff] = []
    for tr in aircraft:
        if len(tr) < 5:
            continue
        derived = derive(tr)
        mask = ground_mask(tr, derived)
        t = list(tr.t)
        to_idx, td_idx = _transitions(t, mask)

        # Drop touchdowns that are the far side of a bounce: a touchdown
        # within AIRBORNE_MIN_S of the previous lift-off is the same landing.
        kept_td: List[int] = []
        for i in td_idx:
            prior_to = [j for j in to_idx if j < i]
            if prior_to and kept_td and t[i] - t[prior_to[-1]] < AIRBORNE_MIN_S and prior_to[-1] > kept_td[-1]:
                continue
            kept_td.append(i)
        kept_to: List[int] = []
        for j in to_idx:
            nxt = [i for i in td_idx if i > j]
            if nxt and t[nxt[0]] - t[j] < AIRBORNE_MIN_S:
                continue  # a bounce, not a takeoff
            kept_to.append(j)

        for i in kept_td:
            try:
                landings.append(_analyze_landing(rec, tr, derived, mask, i))
            except (IndexError, ValueError, ZeroDivisionError):  # pragma: no cover - defensive
                continue
        for j in kept_to:
            try:
                takeoffs.append(_analyze_takeoff(rec, tr, derived, mask, j))
            except (IndexError, ValueError, ZeroDivisionError):  # pragma: no cover - defensive
                continue

    _share_location_names(landings, takeoffs)
    landings.sort(key=lambda x: x.time)
    takeoffs.sort(key=lambda x: x.time)
    return {"landings": landings, "takeoffs": takeoffs}


def _share_location_names(landings: List[Landing], takeoffs: List[Takeoff]) -> None:
    """Name unnamed airfields after a nearby named takeoff or landing.

    Usually only the player's own ``TakenOff``/``Landed`` events carry an
    airfield name; a wingman rolling 15 m to the side is at the same field.
    """
    named: List[Tuple[float, float, str]] = []
    for ld in landings:
        if ld.confirmed_by_event and ld.kind == "airfield":
            named.append((ld.touchdown["longitude"], ld.touchdown["latitude"], ld.location))
    pending_to = []
    for to in takeoffs:
        if to.confirmed_by_event:
            pending_to.append(to)
    # Takeoff positions are not stored on the object, so recover them from
    # the landing list only; takeoff-to-takeoff sharing uses time proximity.
    for ld in landings:
        if ld.confirmed_by_event or ld.kind != "airfield":
            continue
        lon, lat = ld.touchdown["longitude"], ld.touchdown["latitude"]
        for nlon, nlat, name in named:
            if geo.ground_distance(lon, lat, nlon, nlat) < 4000.0:
                ld.location = name
                break
    for to in takeoffs:
        if to.confirmed_by_event:
            continue
        for ref in pending_to:
            if abs(ref.time - to.time) < 90.0 and ref.kind == to.kind:
                to.location = ref.location
                break
