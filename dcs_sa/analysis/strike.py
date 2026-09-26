"""Air-to-ground attacks: release, fall, impact, submunitions and damage.

For every bomb, glide weapon (JSOW), air-to-ground missile or rocket this
works out

* the **release**: where, how high, how fast, dive angle, G and bank;
* the **fall**: time of fall, ground range, highest point, glide ratio;
* the **impact**: where it landed (carried on to its removal time, because
  DCS deletes a weapon a frame after its last sample), the nearest target
  and the miss distance;
* for cluster weapons (AGM-154A with BLU-97s, CBUs) where it **opened** and
  the **footprint** its submunitions covered.  DCS's Tacview exporter writes
  ONE object for a dispenser's whole load (e.g. a single "BLU-97/B" that
  falls as the centre of the 145-bomblet cloud), so the pattern's size then
  comes from :data:`DISPENSERS` and is marked as an estimate; when every
  bomblet is recorded, the pattern is measured from them;
* the **damage**: which ground units died near the impact shortly after.

Everything is measured from the recording; when a DCS flight log is merged,
DCS's own hit/kill events confirm the damage.
"""

from __future__ import annotations

import math
import re
from dataclasses import asdict, dataclass, field
from typing import Dict, List, Optional, Tuple

from ..acmi.model import Recording, Track
from . import geo
from .lar import jsow_envelope
from .weapons import Destruction, Shot, WeaponReport, _clean, _hostile, _weapon_samples, ammo_name

#: Weapon families, by DCS type name.  Order matters (first match wins).
FAMILIES: List[Tuple[str, "re.Pattern[str]"]] = [
    ("jsow", re.compile(r"AGM[-_ ]?154", re.I)),
    ("jdam", re.compile(r"GBU[-_ ]?(31|32|38|54)|JDAM|LJDAM", re.I)),
    ("lgb", re.compile(r"GBU[-_ ]?(10|12|16|24|27|28|49)|KAB[-_ ]?\d+L|LGB", re.I)),
    ("cluster", re.compile(r"CBU|RBK|BL[-_ ]?755|ROCKEYE|MK[-_ ]?20|BLG[-_ ]?66|KMGU", re.I)),
    ("maverick", re.compile(r"AGM[-_ ]?65", re.I)),
    ("harm", re.compile(r"AGM[-_ ]?88|Kh[-_ ]?58|Kh[-_ ]?31P|ALARM", re.I)),
    ("rocket", re.compile(r"HYDRA|FFAR|M151|Mk[-_ ]?151|S[-_ ]?[58]|S[-_ ]?13|S[-_ ]?24|S[-_ ]?25|APKWS|ZUNI|SNEB|B[-_]?8", re.I)),
    ("agm", re.compile(r"AGM|Kh[-_ ]?\d+|HELLFIRE|VIKHR|KATM|SPIKE|BRIMSTONE|SLAM|STORM|SCALP|TAURUS|ALARM", re.I)),
    ("gp-bomb", re.compile(r"MK[-_ ]?8[1234]|FAB[-_ ]?\d+|OFAB|BETAB|SAB|M117|GBU|KAB|BDU|BOMB", re.I)),
]

#: Cluster dispensers: (submunition name, count, typical pattern semi-axes
#: along / across the attack heading in m).  Counts are from DCS's weapon
#: definitions (e.g. AGM_154A: cluster "BLU-97/B", count 145); the pattern
#: size is a typical value, only used when the bomblets are not recorded.
DISPENSERS: List[Tuple["re.Pattern[str]", str, int, float, float]] = [
    (re.compile(r"^AGM[-_ ]?154A$", re.I), "BLU-97/B", 145, 100.0, 60.0),
    (re.compile(r"^AGM[-_ ]?154B$", re.I), "BLU-108", 6, 80.0, 50.0),
    (re.compile(r"^CBU[-_ ]?(87|103)", re.I), "BLU-97B", 202, 110.0, 60.0),
    (re.compile(r"^CBU[-_ ]?(97|105)", re.I), "BLU-108", 10, 80.0, 50.0),
    (re.compile(r"^(ROCKEYE|MK[-_ ]?20|CBU[-_ ]?(99|100))", re.I), "Mk 118", 247, 90.0, 55.0),
    (re.compile(r"^BL[-_ ]?755", re.I), "BL755 bomblets", 147, 90.0, 55.0),
]
#: A load recorded as at most this many objects is DCS's single aggregate child.
AGGREGATE_MAX = 3
#: m around the falling cloud's centre at the moment a unit died (the
#: centre is a representative point: kills at 70-95 m from it were observed).
CLOUD_KILL_RADIUS = 150.0

#: How close to an impact a ground unit must be to count as damaged by it.
DAMAGE_RADIUS = {"unitary": 120.0, "cluster": 80.0, "rocket": 60.0}
DAMAGE_WINDOW = (-1.0, 15.0)   # s around the impact
TARGET_SEARCH = 2500.0         # m: nearest target to an impact within this
MAX_FOOTPRINT_POINTS = 300


def clean_name(name: Optional[str]) -> str:
    """DCS type name without the resource path: "weapons.missiles.AGM_154A" -> "AGM_154A",
    "weapons.bombs.CBU_97.client.launcher.cluster" -> "CBU_97" (older DCS versions)."""
    n = ammo_name(name)
    return re.sub(r"\.(client|server)\.launcher\.cluster$", "", n)


def family(name: str, kind: str) -> str:
    n = clean_name(name)
    for fam, rx in FAMILIES:
        if rx.search(n):
            return fam
    return {"bomb": "gp-bomb", "rocket": "rocket"}.get(kind, "agm")


def dispenser(name: str) -> Optional[Tuple[str, int, float, float]]:
    """(submunition, count, semi-major, semi-minor) for a cluster weapon, or None."""
    n = clean_name(name)
    for rx, sub, count, major, minor in DISPENSERS:
        if rx.search(n):
            return sub, count, major, minor
    return None


@dataclass
class Strike:
    weapon_id: str
    weapon_name: str
    family: str
    launcher_id: Optional[str]
    launcher_name: Optional[str]
    launcher_pilot: Optional[str]
    release_time: float
    impact_time: float
    time_of_fall: float
    release: Dict[str, float] = field(default_factory=dict)
    impact: Dict[str, float] = field(default_factory=dict)
    ground_range: Optional[float] = None
    apex_altitude: Optional[float] = None
    glide_ratio: Optional[float] = None
    target_id: Optional[str] = None
    target_name: Optional[str] = None
    target_source: Optional[str] = None        # "lock" | "closest-approach" | "nearest"
    miss_distance: Optional[float] = None      # ground distance impact (or footprint centre) -> target
    dispense: Dict[str, float] = field(default_factory=dict)   # where a cluster weapon opened
    submunitions: int = 0                      # bomblets in the load (DCS's count when not all recorded)
    submunitions_recorded: int = 0             # objects the recording holds for them
    submunition_name: Optional[str] = None     # e.g. "BLU-97/B"
    footprint: Dict[str, object] = field(default_factory=dict)  # centre, axes, angle, points; "estimated" when typical
    damage: List[Dict[str, object]] = field(default_factory=list)
    dcs_hits: Optional[int] = None
    result: str = "unknown"                    # "destroyed" | "damaged" | "miss" | "intercepted" | "in flight"
    envelope: Dict[str, object] = field(default_factory=dict)  # JSOW: Rmax/Rmin/TOF at release (DCS table)

    def to_dict(self) -> Dict:
        return _clean(asdict(self))


def is_air_to_ground(shot: Shot, rec: Recording) -> bool:
    if shot.kind in ("bomb", "rocket"):
        return True
    launcher = rec.tracks.get(shot.launcher_id or "")
    if launcher is not None and launcher.category not in ("fixedwing", "rotorcraft", "air"):
        return False  # SAMs and ships shoot missiles at aircraft
    target = rec.tracks.get(shot.target_id or "")
    if target is not None:
        return target.category in ("ground", "sea")
    return family(shot.weapon_name, shot.kind) in ("jsow", "jdam", "lgb", "cluster", "maverick", "harm", "agm")


def _flight_path_angle(tr: Track, t: float) -> Optional[float]:
    """Climb (+) / dive (-) angle of the aircraft's flight path, degrees."""
    a, b = tr.position_interp(t - 0.5), tr.position_interp(t + 0.5)
    if a is None or b is None:
        return None
    d = geo.ground_distance(a[0], a[1], b[0], b[1])
    if d < 1.0:
        return None
    return math.degrees(math.atan2(b[2] - a[2], d))


def _release_state(launcher: Track, t: float) -> Dict[str, float]:
    out: Dict[str, float] = {}
    for key, ch in (("altitude", "Altitude"), ("agl", "AGL"), ("ias", "IAS"), ("tas", "TAS"), ("mach", "Mach"),
                    ("heading", "Yaw"), ("pitch", "Pitch"), ("bank", "Roll"), ("aoa", "AOA"),
                    ("g", "VerticalGForce"), ("longitude", "Longitude"), ("latitude", "Latitude")):
        v = launcher.value_at(ch, t)
        if v == v:
            out[key] = v
    fpa = _flight_path_angle(launcher, t)
    if fpa is not None:
        out["dive"] = fpa
    if "tas" not in out:
        a, b = launcher.position_interp(t - 0.5), launcher.position_interp(t + 0.5)
        if a is not None and b is not None:
            out["tas"] = geo.slant_range(*a, *b)
    return out


def _footprint(points: List[Tuple[float, float]]) -> Dict[str, object]:
    """Centre and 2-sigma ellipse of submunition impacts (principal axes)."""
    if not points:
        return {}
    clon = sum(p[0] for p in points) / len(points)
    clat = sum(p[1] for p in points) / len(points)
    xs = [geo.to_local(lon, lat, clon, clat) for lon, lat in points]
    sxx = sum(x * x for x, _ in xs) / len(xs)
    syy = sum(y * y for _, y in xs) / len(xs)
    sxy = sum(x * y for x, y in xs) / len(xs)
    tr, det = sxx + syy, sxx * syy - sxy * sxy
    disc = math.sqrt(max(0.0, tr * tr / 4 - det))
    l1, l2 = tr / 2 + disc, tr / 2 - disc
    angle = 0.5 * math.degrees(math.atan2(2 * sxy, sxx - syy))  # of the major axis, from east, CCW
    step = max(1, len(points) // MAX_FOOTPRINT_POINTS)
    return {
        "lon": clon, "lat": clat,
        "major": 2 * math.sqrt(max(l1, 0.0)), "minor": 2 * math.sqrt(max(l2, 0.0)),
        # Bearing of the major axis (true, 0-180).
        "bearing": (90.0 - angle) % 180.0,
        "extent": max((math.hypot(x, y) for x, y in xs), default=0.0),
        "points": [[round(lon, 6), round(lat, 6)] for lon, lat in points[::step]],
    }


def _ground_alt_near(rec: Recording, lon: float, lat: float, radius: float = 4000.0) -> Optional[float]:
    """Ground elevation near a point, from the ground units standing there."""
    alts = []
    for tr in rec.tracks.values():
        if tr.category != "ground":
            continue
        p = tr.position_at(tr.first_seen)
        if p is not None and p[2] == p[2] and geo.ground_distance(lon, lat, p[0], p[1]) <= radius:
            alts.append(p[2])
    if not alts:
        return None
    alts.sort()
    return alts[len(alts) // 2]


def _to_ground(samples: List[Tuple[float, float, float, float]], ground: Optional[float]) -> Tuple[float, float, float, float]:
    """Where the (extended) path reaches the ground.

    The extension to the removal time can carry the path up to a frame past
    the impact; with the local ground elevation known, the impact is where
    the last segments cross it.
    """
    end = samples[-1]
    if ground is None or len(samples) < 2 or end[3] > ground + 30.0:
        return end
    for (t0, lo0, la0, a0), (t1, lo1, la1, a1) in zip(reversed(samples[:-1]), reversed(samples[1:])):
        if a0 >= ground >= a1 and a0 > a1:
            f = (a0 - ground) / (a0 - a1)
            return (t0 + (t1 - t0) * f, lo0 + (lo1 - lo0) * f, la0 + (la1 - la0) * f, ground)
    return end


def _nearest_target(rec: Recording, launcher: Optional[Track], lon: float, lat: float, t: float,
                    radius: float = TARGET_SEARCH) -> Tuple[Optional[Track], float]:
    best, best_d = None, radius
    for tr in rec.tracks.values():
        if tr.category not in ("ground", "sea") or not tr.alive_at(t, grace=15.0):
            continue
        if launcher is not None and not _hostile(launcher, tr):
            continue
        p = tr.position_interp(min(t, tr.ends_at))
        if p is None:
            continue
        d = geo.ground_distance(lon, lat, p[0], p[1])
        if d < best_d:
            best, best_d = tr, d
    return best, best_d


def analyze_strikes(rec: Recording, weapons: WeaponReport,
                    destructions: Optional[List[Destruction]] = None) -> List[Strike]:
    destructions = destructions if destructions is not None else weapons.destructions
    deaths = [(d, rec.tracks[d.object_id]) for d in destructions
              if d.object_id in rec.tracks and rec.tracks[d.object_id].category in ("ground", "sea")]
    out: List[Strike] = []
    for shot in weapons.shots:
        if not is_air_to_ground(shot, rec):
            continue
        w = rec.tracks.get(shot.weapon_id)
        if w is None:
            continue
        samples = _weapon_samples(w)
        if not samples:
            continue
        launcher = rec.tracks.get(shot.launcher_id or "")
        fam = family(shot.weapon_name, shot.kind)
        gnd = _ground_alt_near(rec, samples[-1][1], samples[-1][2])
        end_t, elon, elat, ealt = _to_ground(samples, gnd)
        flying = w.removed_at is None and w.last_seen >= rec.end_time - 0.5
        st = Strike(
            weapon_id=w.id, weapon_name=shot.weapon_name, family=fam,
            launcher_id=shot.launcher_id, launcher_name=shot.launcher_name, launcher_pilot=shot.launcher_pilot,
            release_time=shot.launch_time, impact_time=end_t, time_of_fall=end_t - shot.launch_time,
        )
        if launcher is not None:
            st.release = _release_state(launcher, shot.launch_time)
        first = samples[0]
        st.release.setdefault("longitude", first[1])
        st.release.setdefault("latitude", first[2])
        st.release.setdefault("altitude", first[3])
        st.apex_altitude = max(s[3] for s in samples)
        # Submunitions: the dispenser opened where it ended; each bomblet's
        # own end is where it landed.
        subs = [rec.tracks[i] for i in weapons.submunitions.get(w.id, []) if i in rec.tracks]
        cluster = bool(subs) or fam == "cluster"
        spec = dispenser(shot.weapon_name)
        cloud: List[Tuple[float, float, float, float]] = []  # the aggregate child's path, for damage
        if subs:
            st.dispense = {"time": end_t, "longitude": elon, "latitude": elat, "altitude": ealt}
            pts, sub_alts = [], []
            last_t = end_t
            for sub in subs:
                ss = _weapon_samples(sub)
                if ss:
                    hit = _to_ground(ss, gnd)
                    pts.append((hit[1], hit[2]))
                    sub_alts.append(hit[3])
                    last_t = max(last_t, hit[0])
                    if len(subs) <= AGGREGATE_MAX:
                        cloud.extend(ss)
            st.submunitions_recorded = len(subs)
            st.submunition_name = spec[0] if spec is not None else clean_name(subs[0].name)
            if len(subs) <= AGGREGATE_MAX and spec is not None:
                # DCS's single child: the centre of the falling cloud.  The
                # pattern's size is typical for the weapon, laid along the
                # dispenser's final heading.
                st.submunitions = spec[1]
                clon = sum(p[0] for p in pts) / len(pts) if pts else elon
                clat = sum(p[1] for p in pts) / len(pts) if pts else elat
                heading = _final_heading(samples)
                st.footprint = {"lon": clon, "lat": clat, "major": spec[2], "minor": spec[3],
                                "bearing": heading % 180.0 if heading is not None else 0.0,
                                "extent": spec[2], "estimated": True,
                                "points": [[round(p[0], 6), round(p[1], 6)] for p in pts]}
            else:
                st.submunitions = len(subs)
                st.footprint = _footprint(pts)
            st.impact_time = last_t
            st.time_of_fall = last_t - shot.launch_time
            ilon, ilat = st.footprint.get("lon", elon), st.footprint.get("lat", elat)
            alts = [a for a in sub_alts if a == a]
            st.impact = {"longitude": ilon, "latitude": ilat, "altitude": sum(alts) / len(alts) if alts else ealt}
        else:
            st.impact = {"longitude": elon, "latitude": elat, "altitude": ealt}
        ilon, ilat = st.impact["longitude"], st.impact["latitude"]
        st.ground_range = geo.ground_distance(first[1], first[2], ilon, ilat)
        drop = first[3] - st.impact["altitude"]
        if drop > 50.0:
            st.glide_ratio = st.ground_range / drop
        if fam == "jsow":
            env = jsow_envelope(drop, st.release.get("tas", float("nan")))
            if env:
                env["rangeFraction"] = st.ground_range / env["rmax"] if env.get("rmax") else None
                env["inRange"] = bool(env.get("rmin", 0.0) <= st.ground_range <= env["rmax"])
                st.envelope = env

        # Target: what the launcher had locked / what the weapon flew at,
        # else the nearest hostile ground unit to the impact.
        tgt = rec.tracks.get(shot.target_id or "")
        if cluster and shot.target_source != "lock":
            tgt = None  # an area weapon: the unit nearest the pattern's centre
        if tgt is not None and tgt.category in ("ground", "sea"):
            st.target_source = shot.target_source
        else:
            tgt, _ = _nearest_target(rec, launcher, ilon, ilat, st.impact_time)
            st.target_source = "nearest" if tgt is not None else None
        if tgt is not None:
            st.target_id, st.target_name = tgt.id, tgt.name
            tp = tgt.position_interp(min(st.impact_time, tgt.ends_at))
            if tp is not None:
                st.miss_distance = geo.ground_distance(ilon, ilat, tp[0], tp[1])

        # Damage: ground units that died near the impact soon after it.
        radius = DAMAGE_RADIUS["rocket" if fam == "rocket" else "cluster" if cluster else "unitary"]
        if cluster and st.footprint:
            radius += float(st.footprint.get("extent") or 0.0)
        # From the moment it could first hurt anything: the dispense for a
        # cluster weapon (bomblets land over a few seconds), else the impact.
        t_from = (st.dispense["time"] if st.dispense else st.impact_time) + DAMAGE_WINDOW[0]
        for d, vt in deaths:
            if not (t_from <= d.time <= st.impact_time + DAMAGE_WINDOW[1]):
                continue
            if launcher is not None and not _hostile(launcher, vt):
                continue
            vp = vt.position_interp(min(d.time, vt.ends_at))
            if vp is None:
                continue
            dist = geo.ground_distance(ilon, ilat, vp[0], vp[1])
            # A unit can die before the cloud's centre lands: measure from
            # where the centre was at that moment too.
            near_cloud = cloud and _cloud_distance(cloud, d.time, vp) <= CLOUD_KILL_RADIUS
            if dist <= radius or near_cloud:
                st.damage.append({"id": vt.id, "name": vt.name, "time": d.time, "distance": dist, "cause": d.cause})
        st.damage.sort(key=lambda x: x["time"])
        if flying:
            st.result = "in flight"
        elif not subs and _intercepted(rec, w, end_t, elon, elat, ealt, gnd):
            st.result = "intercepted"
        elif st.damage:
            st.result = "destroyed"
        elif shot.outcome == "damage" or shot.dcs_hit:
            st.result = "damaged"
        else:
            st.result = "miss"
        out.append(st)
    _share_damage(out)
    return out


def _intercepted(rec: Recording, w: Track, t: float, lon: float, lat: float, alt: float, ground: Optional[float]) -> bool:
    """Shot down: the weapon ended well above the ground, in the same moment
    and place as another missile (a SAM that hit it)."""
    # With no ground units nearby to tell the elevation, sea level; the
    # coincidence with another missile is the real test.
    if alt < (ground if ground is not None else 0.0) + 150.0:
        return False
    for tr in rec.tracks.values():
        if tr is w or tr.category != "weapon" or tr.removed_at is None or abs(tr.removed_at - t) > 1.0:
            continue
        p = tr.position_interp(min(t, tr.ends_at))
        if p is not None and geo.slant_range(lon, lat, alt, p[0], p[1], p[2]) < 500.0:
            return True
    return False


def _final_heading(samples: List[Tuple[float, float, float, float]]) -> Optional[float]:
    """Ground track over the weapon's last few seconds, degrees true."""
    end = samples[-1]
    for s in reversed(samples[:-1]):
        if end[0] - s[0] >= 2.0 and geo.ground_distance(s[1], s[2], end[1], end[2]) > 20.0:
            return geo.bearing(s[1], s[2], end[1], end[2])
    return None


def _cloud_distance(cloud: List[Tuple[float, float, float, float]], t: float, p: Tuple[float, ...]) -> float:
    """Ground distance from p to the cloud centre at time t (held at its ends)."""
    pts = sorted(cloud)
    if t <= pts[0][0]:
        q = pts[0]
    elif t >= pts[-1][0]:
        q = pts[-1]
    else:
        q = next(b for a, b in zip(pts, pts[1:]) if a[0] <= t <= b[0])
    return geo.ground_distance(q[1], q[2], p[0], p[1])


def _share_damage(strikes: List[Strike]) -> None:
    """A unit that died once is credited to the one impact that best explains it."""
    owner: Dict[str, Tuple[float, Strike]] = {}
    for st in strikes:
        for d in st.damage:
            score = abs(float(d["time"]) - st.impact_time) + float(d["distance"]) / 100.0
            if d["id"] not in owner or score < owner[d["id"]][0]:
                owner[d["id"]] = (score, st)
    for st in strikes:
        st.damage = [d for d in st.damage if owner[d["id"]][1] is st]
        if st.result == "destroyed" and not st.damage:
            st.result = "miss"


def credit_kills(rec: Recording, weapons: WeaponReport, strikes: List[Strike]) -> int:
    """Give unattributed ground kills to the strike that caused them."""
    by_victim = {k.victim_id: k for k in weapons.kills}
    n = 0
    for st in strikes:
        for d in st.damage:
            k = by_victim.get(str(d["id"]))
            if k is not None and k.weapon_id == st.weapon_id:
                k.miss_distance = float(d["distance"])  # measured at the ground, not the last sample
            if k is None or k.killer_id:
                continue
            k.killer_id, k.killer_name, k.killer_pilot = st.launcher_id, st.launcher_name, st.launcher_pilot
            k.weapon_id, k.weapon_name = st.weapon_id, st.weapon_name + (" (submunitions)" if st.submunitions else "")
            k.weapon_kind = "bomb" if st.family != "rocket" else "rocket"
            k.miss_distance = float(d["distance"])
            n += 1
            for s in weapons.shots:
                if s.weapon_id == st.weapon_id and s.outcome in ("miss", "unknown", "damage"):
                    s.outcome, s.killed_id, s.killed_name = "kill", k.victim_id, k.victim_name
    return n


def sync_targets(rec: Recording, weapons: WeaponReport, strikes: List[Strike]) -> int:
    """One target per weapon: make the shot list and the strike agree.

    A known target (the launcher's lock, or DCS's own) wins on both sides;
    otherwise the strike's choice (the unit nearest where a cluster weapon's
    pattern landed) replaces the shot's closest-approach guess, which for a
    dispenser is just whatever it passed over when it opened.
    """
    from .weapons import _launch_geometry

    known = ("lock", "dcs")
    shots = {s.weapon_id: s for s in weapons.shots}
    n = 0
    for st in strikes:
        s = shots.get(st.weapon_id)
        if s is None or not st.impact or s.target_id == st.target_id:
            continue
        tgt = rec.tracks.get(s.target_id or "")
        if s.target_source in known and tgt is not None and tgt.category in ("ground", "sea"):
            st.target_id, st.target_name, st.target_source = tgt.id, tgt.name, s.target_source
            tp = tgt.position_interp(min(st.impact_time, tgt.ends_at))
            st.miss_distance = (geo.ground_distance(st.impact["longitude"], st.impact["latitude"], tp[0], tp[1])
                                if tp is not None else None)
        elif st.target_id and s.target_source not in known:
            new = rec.tracks.get(st.target_id)
            if new is None:
                continue
            s.target_id, s.target_name, s.target_pilot, s.target_source = new.id, new.name, new.pilot, st.target_source
            launcher = rec.tracks.get(s.launcher_id or "")
            s.geometry = _launch_geometry(launcher, new, s.launch_time) if launcher is not None else {}
            s.closest_approach, s.closest_time = st.miss_distance, st.impact_time
        else:
            continue
        n += 1
    return n


def target_summary(rec: Recording, strikes: List[Strike]) -> List[Dict[str, object]]:
    """Per ground target: every weapon aimed at or landing on it, and its fate."""
    by: Dict[str, Dict[str, object]] = {}
    for st in strikes:
        ids = {st.target_id} | {str(d["id"]) for d in st.damage}
        for tid in filter(None, ids):
            tr = rec.tracks.get(tid)
            if tr is None:
                continue
            e = by.setdefault(tid, {"id": tid, "name": tr.name, "coalition": tr.coalition, "weapons": [],
                                    "destroyed": None, "destroyedBy": None})
            e["weapons"].append({"weaponId": st.weapon_id, "weapon": st.weapon_name, "time": st.impact_time,
                                 "miss": st.miss_distance if st.target_id == tid else None})
            for d in st.damage:
                if d["id"] == tid:
                    e["destroyed"], e["destroyedBy"] = d["time"], st.weapon_name
    return sorted(by.values(), key=lambda e: (e["destroyed"] is None, e["destroyed"] or 0.0))
