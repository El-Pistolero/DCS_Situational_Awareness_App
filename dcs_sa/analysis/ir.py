"""Heat (IR): DCS's heat signatures, IR seekers, flares and decoys.

What DCS itself defines (``web/data/ir.json``, read from DCS 2.9.29's Lua):

* every aircraft type has an IR emission coefficient, dry and in afterburner,
  on one scale where 1.0 is a Su-27 at military power;
* the heat a seeker sees depends on aspect: x1.5 from the tail, x1 from the
  beam, x0.5 nose-on (``prbCoeff.lua`` k7 = 0.5);
* every IR missile has a seeker sensitivity distance, a flare-resistance
  factor, launch look angle, gimbal limit and an aspect limit (all-aspect or
  rear-aspect only).

What a recording holds: positions, the recording player's throttle and
fuel flow, and flares as anonymous ``Misc+Decoy+Flare`` objects (no Parent).
Everything else here is inferred from geometry and says so:

* who dropped each flare (the nearest aircraft when it appeared);
* whether a missile went for a flare (its predicted miss, "zero-effort
  miss", became far smaller against a flare than against its target);
* whether an aircraft was in afterburner - only from recorded engine data,
  never guessed for AI aircraft.

Nothing here claims a lock, a tone or a detection range as fact.
"""

from __future__ import annotations

import bisect
import json
import math
import re
from functools import lru_cache
from pathlib import Path
from typing import Dict, List, Optional, Sequence, Tuple

from ..acmi.model import Recording, Track
from . import geo

IR_JSON = Path(__file__).resolve().parent.parent / "web" / "data" / "ir.json"

#: DCS prbCoeff k7: heat seen nose-on is k7, beam 1, tail 2 - k7.
K7 = 0.5
#: m: a flare belongs to the nearest aircraft this close when it appears.
FLARE_OWNER_RADIUS = 60.0
#: Another aircraft this much farther than the nearest still makes it a toss-up.
FLARE_OWNER_AMBIGUOUS = 1.5
#: s: flares from one aircraft less than this apart form one salvo.
SALVO_GAP = 1.5
#: Decoy rule: the predicted miss against a flare under this (m) ...
DECOY_ZEM = 60.0
#: ... and under this fraction of the predicted miss against the target ...
DECOY_RATIO = 0.3
#: ... on this many consecutive missile samples.
DECOY_SAMPLES = 2
#: s: the seeker settles after launch; flares count from then.
DECOY_SETTLE = 0.5
#: s: a flare about to be passed no longer steers the missile.
DECOY_MIN_TGO = 0.3
#: deg: velocity is not the missile's body axis (AoA): margin on the gimbal limit.
GIMBAL_MARGIN = 8.0
#: s: engine-data afterburner windows shorter than this are spool noise.
AB_MIN_SPAN = 1.0
#: s: the fly-out series step for the shot card.
SERIES_STEP = 0.25


def _norm(s: str) -> str:
    s = (s or "").strip()
    for prefix in ("weapons.missiles.", "weapons.nurs."):
        if s.lower().startswith(prefix):
            s = s[len(prefix):]
    return re.sub(r"[^a-z0-9]", "", s.lower())


@lru_cache(maxsize=1)
def table() -> Dict:
    with open(IR_JSON, encoding="utf-8") as f:
        data = json.load(f)
    data["_missiles"] = {_norm(k): k for k in data["missiles"]}
    for alias, key in data.get("missileAliases", {}).items():
        data["_missiles"].setdefault(_norm(alias), key)
    data["_planes"] = {_norm(k): k for k in data["planes"]}
    for alias, key in {**data.get("planeAliases", {}), "F/A-18C": "FA-18C_hornet", "FA-18C": "FA-18C_hornet"}.items():
        data["_planes"].setdefault(_norm(alias), key)
    return data


def seeker(name: Optional[str]) -> Optional[Dict]:
    """DCS seeker data for an IR missile, or None (not IR, or not in the table).

    Only missiles DCS gives an IR seeker are in the table: a missile is never
    called IR from its name alone.
    """
    if not name:
        return None
    t = table()
    key = t["_missiles"].get(_norm(name))
    if key is None:
        return None
    s = dict(t["missiles"][key])
    s["key"] = key
    s["allAspect"] = s.get("aspectLimit", 0) >= 179.0
    return s


def airframe(type_name: Optional[str]) -> Optional[Dict]:
    """DCS IR emission coefficients: {type, ir, irAB (None: no afterburner)}."""
    if not type_name:
        return None
    t = table()
    key = t["_planes"].get(_norm(type_name))
    if key is None:
        return None
    ir, ir_ab = t["planes"][key]
    return {"type": key, "ir": ir, "irAB": ir_ab or None}


def aspect_factor(tail_deg: float) -> float:
    """Heat seen from *tail_deg* off the target's tail (0 = up the tailpipe)."""
    return 1.0 + (1.0 - K7) * math.cos(math.radians(tail_deg))


# --------------------------------------------------------------------------
# geometry helpers (local east/north/up metres)

Vec = Tuple[float, float, float]


def _enu(p: Sequence[float], ref: Sequence[float]) -> Vec:
    kx = geo.m_per_deg_lon(ref[1])
    return ((p[0] - ref[0]) * kx, (p[1] - ref[1]) * geo.M_PER_DEG_LAT, p[2] - ref[2])


def _dot(a: Vec, b: Vec) -> float:
    return a[0] * b[0] + a[1] * b[1] + a[2] * b[2]


def _len(a: Vec) -> float:
    return math.sqrt(_dot(a, a))


def _angle(a: Vec, b: Vec) -> Optional[float]:
    la, lb = _len(a), _len(b)
    if la < 1e-6 or lb < 1e-6:
        return None
    return math.degrees(math.acos(max(-1.0, min(1.0, _dot(a, b) / (la * lb)))))


def _velocity(tr: Track, t: float, dt: float = 0.25) -> Optional[Vec]:
    t0 = max(tr.first_seen, t - dt)
    t1 = t0 + dt if t0 + dt <= tr.ends_at else t
    if t1 - t0 < 1e-3:
        return None
    a, b = tr.position_interp(t0), tr.position_interp(t1)
    if a is None or b is None:
        return None
    d = _enu(b, a)
    return (d[0] / (t1 - t0), d[1] / (t1 - t0), d[2] / (t1 - t0))


def _zem(rel: Vec, vrel: Vec) -> Tuple[float, float]:
    """Zero-effort miss and time to go: *rel* object minus missile, *vrel* likewise."""
    vv = _dot(vrel, vrel)
    tgo = -_dot(rel, vrel) / vv if vv > 1e-6 else 0.0
    if tgo <= 0.0:
        return _len(rel), tgo
    return _len((rel[0] + vrel[0] * tgo, rel[1] + vrel[1] * tgo, rel[2] + vrel[2] * tgo)), tgo


def _tail_vector(tr: Track, t: float) -> Optional[Vec]:
    """Straight out of the tailpipe: minus the body axis (yaw/pitch), else minus velocity."""
    yaw = tr.value_at("Yaw", t)
    if yaw == yaw:
        pitch = tr.value_at("Pitch", t)
        pitch = 0.0 if pitch != pitch else pitch
        y, p = math.radians(yaw), math.radians(pitch)
        return (-math.sin(y) * math.cos(p), -math.cos(y) * math.cos(p), -math.sin(p))
    v = _velocity(tr, t)
    return (-v[0], -v[1], -v[2]) if v is not None else None


def tail_angle(target: Track, t: float, viewer: Sequence[float]) -> Optional[float]:
    """Degrees between the target's tail and the line from it to *viewer* (lon, lat, alt)."""
    tp = target.position_interp(t)
    tail = _tail_vector(target, t)
    if tp is None or tail is None:
        return None
    return _angle(tail, _enu(viewer, tp))


# --------------------------------------------------------------------------
# afterburner

def _type_key(tr: Track) -> str:
    return tr.name or ""


def ab_state(tr: Track) -> Dict:
    """Afterburner over time, from recorded data only.

    ``{"state": "noAB" | "recorded" | "unknown", "src": ..., "spans": [[t0, t1], ...]}``.
    *spans* are the windows the afterburner was lit (``recorded`` only).
    A type DCS gives no afterburner coefficient is ``noAB``: exact.  An AI
    aircraft in a Tacview file has no engine data: ``unknown``, never guessed.
    """
    af = airframe(_type_key(tr))
    if af is not None and af["irAB"] is None:
        return {"state": "noAB", "src": "DCS", "spans": []}
    ab = tr.channel("Afterburner")
    if ab is not None and any(v == v for v in ab):
        return {"state": "recorded", "src": "Afterburner", "spans": _spans(tr.t, [v == v and v > 0.05 for v in ab], 0.0)}
    ff = tr.channel("FuelFlowWeight")
    if ff is not None:
        lit = _ab_from_fuel_flow(tr, ff)
        if lit is not None:
            return {"state": "recorded", "src": "FuelFlowWeight", "spans": _spans(tr.t, lit, AB_MIN_SPAN)}
    return {"state": "unknown", "src": None, "spans": []}


def _ab_from_fuel_flow(tr: Track, ff) -> Optional[List[bool]]:
    """Lit where fuel flow is far above the dry plateau (DCS: x5-8 in AB).

    The dry reference is the 10th percentile of airborne fuel flow, and the
    split must be clean: few samples in the gap between dry and lit.
    """
    agl, ias = tr.channel("AGL"), tr.channel("IAS")
    air = []
    for i, v in enumerate(ff):
        if v != v or v <= 0:
            continue
        up = (agl is not None and agl[i] == agl[i] and agl[i] > 30) or (ias is not None and ias[i] == ias[i] and ias[i] > 40)
        if up or (agl is None and ias is None):
            air.append(v)
    if len(air) < 20:
        return None
    air.sort()
    ref = air[len(air) // 10]
    thr = max(ref * 4.0, 1.0)
    # A bimodal split: the lit mode must sit well above the threshold.
    lit = [v for v in air if v > thr]
    if not lit or lit[len(lit) // 2] < thr * 1.8:
        return None
    return [v == v and v > thr for v in ff]


def _spans(ts, flags: List[bool], min_len: float) -> List[List[float]]:
    out: List[List[float]] = []
    start = None
    for i, on in enumerate(flags):
        if on and start is None:
            start = ts[i]
        elif not on and start is not None:
            out.append([start, ts[i]])
            start = None
    if start is not None:
        out.append([start, ts[len(flags) - 1]])
    return [[round(a, 2), round(b, 2)] for a, b in out if b - a >= min_len]


def ab_at(state: Dict, t: float) -> Optional[bool]:
    """Lit at *t*: True/False, or None when not recorded."""
    if state["state"] == "noAB":
        return False
    if state["state"] != "recorded":
        return None
    return any(a <= t <= b for a, b in state["spans"])


# --------------------------------------------------------------------------
# flares

def flare_owners(rec: Recording) -> Dict[str, Dict]:
    """Flare / chaff id -> {owner, distance, ambiguous, kind, t}.

    DCS writes no Parent on countermeasures: the owner is the nearest aircraft
    within 60 m when the flare first appears.  If a second aircraft is nearly
    as close the owner is left undecided.
    """
    air = [a for a in rec.aircraft()]
    out: Dict[str, Dict] = {}
    for tr in rec.tracks.values():
        if tr.category != "countermeasure":
            continue
        kind = "flare" if "Flare" in tr.tags else "chaff" if "Chaff" in tr.tags else None
        if kind is None:
            continue
        t = tr.first_seen
        p = tr.position_at(t)
        row = {"kind": kind, "t": round(t, 2), "owner": None, "distance": None, "ambiguous": False}
        if p is not None:
            near = []
            for a in air:
                if not a.alive_at(t, grace=0.5):
                    continue
                q = a.position_interp(t)
                if q is None:
                    continue
                d = _len(_enu(p, q))
                if d < FLARE_OWNER_RADIUS:
                    near.append((d, a.id))
            near.sort()
            if near:
                row["owner"], row["distance"] = near[0][1], round(near[0][0], 1)
                if len(near) > 1 and near[1][0] < max(near[0][0], 5.0) * FLARE_OWNER_AMBIGUOUS:
                    row["ambiguous"] = True
                    row["owner"] = None
        out[tr.id] = row
    return out


def salvos(owners: Dict[str, Dict]) -> Dict[str, List[Dict]]:
    """Owner id -> salvos [{t0, t1, n, kind, ids}] (releases less than 1.5 s apart)."""
    by: Dict[Tuple[str, str], List[Tuple[float, str]]] = {}
    for fid, row in owners.items():
        if row["owner"]:
            by.setdefault((row["owner"], row["kind"]), []).append((row["t"], fid))
    out: Dict[str, List[Dict]] = {}
    for (owner, kind), items in by.items():
        items.sort()
        cur: Optional[Dict] = None
        for t, fid in items:
            if cur is None or t - cur["t1"] >= SALVO_GAP:
                cur = {"t0": t, "t1": t, "n": 0, "kind": kind, "ids": []}
                out.setdefault(owner, []).append(cur)
            cur["t1"], cur["n"] = t, cur["n"] + 1
            cur["ids"].append(fid)
    for rows in out.values():
        rows.sort(key=lambda s: s["t0"])
    return out


# --------------------------------------------------------------------------
# IR shots

def analyze_ir_shot(rec: Recording, shot, owners: Dict[str, Dict], heat: Dict[str, Dict],
                    samples: List[Tuple[float, float, float, float]]) -> Optional[Dict]:
    """Seeker facts, target heat and the flare fight for one IR missile shot."""
    sk = seeker(shot.weapon_name)
    if sk is None:
        return None
    out: Dict = {"seeker": _seeker_row(sk)}
    target = rec.tracks.get(shot.target_id) if shot.target_id else None
    launcher = rec.tracks.get(shot.launcher_id) if shot.launcher_id else None
    t0 = shot.launch_time
    if target is None:
        return out

    # Heat of the target at launch, as the missile saw it.
    af = airframe(target.name)
    tstate = heat.get(target.id) or ab_state(target)
    lp = launcher.position_interp(t0) if launcher is not None else (samples[0][1:] if samples else None)
    if af is not None:
        h: Dict = {"type": af["type"], "ir": af["ir"], "irAB": af["irAB"], "abState": tstate["state"],
                   "abSrc": tstate.get("src")}
        lit = ab_at(tstate, t0)
        h["ab"] = lit
        if lp is not None:
            th = tail_angle(target, t0, lp)
            if th is not None:
                h["tailAngle"] = round(th, 1)
                h["aspectFactor"] = round(aspect_factor(th), 3)
                c = af["irAB"] if lit and af["irAB"] else af["ir"]
                h["seen"] = round(c * aspect_factor(th), 3)
                if lit is None and af["irAB"]:
                    h["seenAB"] = round(af["irAB"] * aspect_factor(th), 3)
                if not sk["allAspect"]:
                    h["outsideAspect"] = th > sk["aspectLimit"]
        out["heat"] = h

    # Flares by the target (and its side) around the flight.
    t_end = shot.end_time or (samples[-1][0] if samples else t0)
    mine = [(row["t"], fid) for fid, row in owners.items()
            if row["owner"] == target.id and row["kind"] == "flare"]
    out["flares"] = {
        "beforeLaunch": sum(1 for t, _ in mine if t0 - 5.0 <= t < t0),
        "inFlight": sum(1 for t, _ in mine if t0 <= t <= t_end),
        "first": min((round(t - t0, 2) for t, _ in mine if t0 <= t <= t_end), default=None),
        "chaff": sum(1 for row in owners.values()
                     if row["owner"] == target.id and row["kind"] == "chaff" and t0 <= row["t"] <= t_end),
    }
    weapon = rec.tracks.get(shot.weapon_id)
    if weapon is None or len(samples) < 3:
        return out
    fly = _fly_out(rec, weapon, target, samples, owners, t0, sk, af, tstate)
    out.update(fly)
    return out


def _seeker_row(sk: Dict) -> Dict:
    keep = ("key", "display", "ssd", "ccm", "gen", "cooled", "offBoresight", "gimbal", "aspectLimit",
            "trackRate", "dMax", "dMin", "rangeMax", "fuze", "life", "allAspect")
    return {k: sk[k] for k in keep if k in sk}


def _fly_out(rec: Recording, weapon: Track, target: Track, samples, owners, t0: float, sk: Dict,
             af: Optional[Dict], tstate: Dict) -> Dict:
    """Per missile sample: predicted miss against the target and the best flare."""
    side = _side(target)
    flares = [rec.tracks[fid] for fid, row in owners.items()
              if row["kind"] == "flare" and fid in rec.tracks and _flare_counts(row, target, side, rec)]
    flares.sort(key=lambda f: f.first_seen)
    starts = [f.first_seen for f in flares]
    streak, decoy = 0, None
    prev_t, prev_best, prev_zf, prev_zt = 0.0, None, 0.0, 0.0
    series: List[Dict] = []
    beyond = 0
    gimbal_exceeded: Optional[float] = None
    last_series = -1e9
    passed = False
    for i in range(1, len(samples)):
        t, lo, la, al = samples[i]
        if t - t0 < DECOY_SETTLE:
            continue
        mp = (lo, la, al)
        prev = samples[i - 1]
        dt = t - prev[0]
        if dt < 1e-3:
            continue
        mv = _enu(mp, prev[1:])
        mv = (mv[0] / dt, mv[1] / dt, mv[2] / dt)
        if not target.alive_at(t, grace=0.5):
            break
        tp, tv = target.position_interp(t), _velocity(target, t)
        if tp is None or tv is None:
            continue
        rel = _enu(tp, mp)
        zt, tgo = _zem(rel, (tv[0] - mv[0], tv[1] - mv[1], tv[2] - mv[2]))
        if tgo <= 0.0:
            passed = True
            break
        look = _angle(mv, rel)
        if look is not None and look > sk.get("gimbal", 90.0) + GIMBAL_MARGIN:
            beyond += 1
            if beyond >= 2 and gimbal_exceeded is None:
                gimbal_exceeded = round(t - t0, 2)
        else:
            beyond = 0
        best = None
        hi = bisect.bisect_right(starts, t)
        for f in flares[:hi]:
            if f.ends_at < t:
                continue
            fp, fv = f.position_interp(t), _velocity(f, t, min(0.5, max(0.1, t - f.first_seen)))
            if fp is None or fv is None:
                continue
            zf, tf = _zem(_enu(fp, mp), (fv[0] - mv[0], fv[1] - mv[1], fv[2] - mv[2]))
            if tf > DECOY_MIN_TGO and (best is None or zf < best[0]):
                best = (zf, f, _angle(mv, _enu(fp, mp)))
        on_flare = best is not None and best[0] < DECOY_ZEM and best[0] < DECOY_RATIO * zt
        streak = streak + 1 if on_flare else 0
        if streak == DECOY_SAMPLES and decoy is None:
            # Decoyed from the first sample of the streak.
            decoy = {"t": round(prev_t - t0, 2), "flareId": prev_best.id, "owner": owners[prev_best.id]["owner"],
                     "zemFlare": round(prev_zf, 1), "zemTarget": round(prev_zt, 1)}
        if on_flare:
            prev_t, prev_best, prev_zf, prev_zt = (t, best[1], best[0], zt) if streak == 1 else (prev_t, prev_best, prev_zf, prev_zt)
        if t - last_series >= SERIES_STEP - 1e-6:
            last_series = t
            row = {"t": round(t - t0, 2), "zem": round(zt, 1), "range": round(_len(rel), 1)}
            if look is not None:
                row["look"] = round(look, 1)
            if best is not None:
                row["zemFlare"] = round(best[0], 1)
                row["flareId"] = best[1].id
                if best[2] is not None:
                    row["lookFlare"] = round(best[2], 1)
            th = _angle(_tail_vector(target, t) or (0.0, 0.0, 0.0), _enu(mp, tp))
            if th is not None and af is not None:
                lit = ab_at(tstate, t)
                row["heat"] = round((af["irAB"] if lit and af["irAB"] else af["ir"]) * aspect_factor(th), 3)
                if lit is None and af["irAB"]:
                    row["heatAB"] = round(af["irAB"] * aspect_factor(th), 3)
            series.append(row)
    out: Dict = {"series": series}
    if decoy is not None:
        decoy["method"] = "zem"
        out["decoy"] = decoy
    if gimbal_exceeded is not None:
        out["gimbalExceeded"] = gimbal_exceeded
    out["passedTarget"] = passed
    return out


def _side(tr: Track) -> str:
    return (tr.coalition or "").lower()


def _flare_counts(row: Dict, target: Track, side: str, rec: Recording) -> bool:
    """Flares from the target, or from an aircraft on its side (never the shooter's)."""
    owner = row.get("owner")
    if owner is None:
        return False
    if owner == target.id:
        return True
    o = rec.tracks.get(owner)
    return o is not None and side != "" and _side(o) == side


# --------------------------------------------------------------------------

def analyze_ir(rec: Recording, weapons) -> Dict:
    """The recording's IR picture: heat per aircraft, flares, and every IR shot.

    Also sets ``shot.ir`` on each IR shot of *weapons* (a WeaponReport).
    """
    owners = flare_owners(rec)
    heat: Dict[str, Dict] = {}
    for tr in rec.aircraft():
        af = airframe(tr.name)
        st = ab_state(tr)
        heat[tr.id] = {**st, **({"ir": af["ir"], "irAB": af["irAB"], "type": af["type"]} if af else {})}
    from .weapons import _weapon_samples
    decoys = 0
    for shot in weapons.shots:
        if seeker(shot.weapon_name) is None:
            continue
        w = rec.tracks.get(shot.weapon_id)
        samples = _weapon_samples(w) if w is not None else []
        info = analyze_ir_shot(rec, shot, owners, heat, samples)
        if info is not None:
            shot.ir = info
            decoys += bool(info.get("decoy"))
    return {
        "source": table()["source"],
        "aspect": table()["aspect"],
        "heat": heat,
        "flares": {fid: {k: v for k, v in row.items() if v is not None and v is not False}
                   for fid, row in owners.items()},
        "salvos": salvos(owners),
        "decoys": decoys,
    }
