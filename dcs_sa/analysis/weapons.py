"""Weapon employment analysis: shots, launch geometry, outcomes and kills.

Real DCS recordings are messier than the ACMI spec suggests:

* The DCS exporter frequently omits ``Parent`` on weapons, so the launcher
  is inferred as the nearest platform at the moment the weapon appears.
* Destruction is not always announced with ``Event=Destroyed``; an aircraft
  can simply vanish mid-air.  :func:`find_destructions` combines every
  signal available and records which one it relied on.
* ``LockedTarget`` is only present when the recording includes sensor data,
  so target inference falls back to closest approach.
"""

from __future__ import annotations

import math
from dataclasses import asdict, dataclass, field
from typing import Dict, List, Optional, Tuple

from ..acmi import types as T
from ..acmi.model import Recording, Track
from . import geo

NAN = float("nan")

#: Distance from the weapon's last known position to a victim for the weapon
#: to be credited with the kill.  Generous, because a missile's final ACMI
#: sample can be a fraction of a second before detonation at Mach 3.
KILL_RADIUS = {"missile": 350.0, "rocket": 150.0, "bomb": 250.0, "torpedo": 150.0, "gun": 120.0}
#: Max closest-approach distance for inferring what a weapon was aimed at.
TARGET_RADIUS = {"missile": 6000.0, "rocket": 1500.0, "bomb": 1500.0, "torpedo": 1500.0, "gun": 400.0}
#: Max distance from a weapon's first sample to its launcher.  DCS writes
#: no Parent at all (not even on missiles), so this is how every shot is
#: attributed.  Gun rounds first appear ~20-60 m from the muzzle.
LAUNCHER_RADIUS = 600.0
ROUND_LAUNCHER_RADIUS = 300.0
#: Rounds in one trigger pull spawn ~0.05 s apart at 100 rds/s; separate
#: pulls are usually well over half a second apart.
BURST_GAP = 0.4
#: A recorded round "moving" faster than this is corrupt/obfuscated
#: position data (seen in delayed multiplayer recordings) - never attribute it.
MAX_ROUND_SPEED = 2000.0

#: DCS ammunition name (after "weapons.shells.") -> gun, by prefix.
GUN_BY_AMMO = (
    ("M61_", "M61A1 Vulcan"), ("GAU8_", "GAU-8 Avenger"), ("GAU_12", "GAU-12 Equalizer"),
    ("GSH301_", "GSh-30-1"), ("GSH23_", "GSh-23"), ("GSh_23", "GSh-23"), ("GSH_23", "GSh-23"),
    ("GSH_30_2", "GSh-30-2"), ("GSh_30_2", "GSh-30-2"), ("DEFA55", "DEFA 554"), ("DEFA_", "DEFA"),
    ("M39_", "M39"), ("ADEN_", "ADEN"), ("MAUSER27", "Mauser BK-27"), ("BK_27", "Mauser BK-27"),
    ("M20_50", "M3 .50 cal"), ("M2_12_7", "M2 .50 cal"), ("2A42_", "2A42 30 mm"), ("2A38_", "2A38 30 mm"),
    ("2A7_", "2A7 23 mm (ZSU-23)"), ("KDA_35", "Oerlikon KDA 35 mm"), ("KPVT_", "KPVT 14.5 mm"),
    ("Utes_12_7", "NSV Utes 12.7 mm"), ("7_62", "7.62 mm MG"), ("M230_", "M230 30 mm"),
    ("GSH_2_30", "GSh-2-30"), ("HISPANO", "Hispano 20 mm"),
)


def ammo_name(name: Optional[str]) -> str:
    """Strip DCS's ``weapons.shells.`` / ``weapons.`` prefixes."""
    n = (name or "").strip()
    for prefix in ("weapons.shells.", "weapons.missiles.", "weapons.nurs.", "weapons.bombs.", "weapons."):
        if n.startswith(prefix):
            return n[len(prefix):]
    return n


def gun_name(ammo: str) -> Optional[str]:
    for prefix, gun in GUN_BY_AMMO:
        if ammo.startswith(prefix):
            return gun
    return None
#: A round whose path passes this close to the target counts as on target
#: (roughly a fighter's half-span; DCS resolves real hits on the airframe).
ROUND_HIT_RADIUS = 12.0


def weapon_kind(tags) -> str:
    if T.is_gun_round(tags):
        return "gun"
    if "Missile" in tags:
        return "missile"
    if "Rocket" in tags:
        return "rocket"
    if "Bomb" in tags:
        return "bomb"
    if "Torpedo" in tags:
        return "torpedo"
    if tags & {"Shell", "Bullet", "Projectile"}:
        return "gun"
    return "missile" if "Weapon" in tags else "other"


def _is_platform(tr: Track) -> bool:
    """Something that can launch a weapon or be a target."""
    return tr.category in ("fixedwing", "rotorcraft", "air", "ground", "sea")


def _hostile(a: Track, b: Track) -> bool:
    ca, cb = a.coalition, b.coalition
    if ca in ("", "Unknown") or cb in ("", "Unknown"):
        return True
    return ca != cb


@dataclass
class Destruction:
    object_id: str
    time: float
    cause: str  # "event" | "health" | "removed-in-flight" | "removed"
    confidence: str  # "confirmed" | "probable"


@dataclass
class Shot:
    weapon_id: str
    weapon_name: str
    kind: str
    guided: bool
    launcher_id: Optional[str]
    launcher_name: Optional[str]
    launcher_pilot: Optional[str]
    launcher_coalition: Optional[str]
    launcher_source: Optional[str]
    target_id: Optional[str] = None
    target_name: Optional[str] = None
    target_pilot: Optional[str] = None
    target_source: Optional[str] = None
    launch_time: float = 0.0
    end_time: float = 0.0
    time_of_flight: float = 0.0
    launch: Dict[str, float] = field(default_factory=dict)
    geometry: Dict[str, float] = field(default_factory=dict)
    closest_approach: Optional[float] = None
    closest_time: Optional[float] = None
    max_speed: Optional[float] = None
    outcome: str = "unknown"
    outcome_detail: str = ""
    killed_id: Optional[str] = None
    killed_name: Optional[str] = None
    dcs_confirmed: Optional[bool] = None   # DCS reported the launch
    dcs_hit: Optional[str] = None          # what DCS says this weapon hit

    def to_dict(self) -> Dict:
        return _clean(asdict(self))


@dataclass
class GunBurst:
    launcher_id: str
    launcher_name: str
    launcher_pilot: Optional[str]
    start: float
    end: float
    rounds: int
    target_id: Optional[str] = None
    target_name: Optional[str] = None
    closest_approach: Optional[float] = None
    range_at_open: Optional[float] = None
    kill: bool = False
    killed_id: Optional[str] = None
    source: str = "rounds"  # "rounds" (projectiles exported) or "trigger"
    weapon_name: Optional[str] = None
    ammo: Optional[str] = None
    rounds_on_target: Optional[int] = None
    fire_rate: Optional[float] = None  # rounds per second, as recorded
    time_of_flight: Optional[float] = None  # mean, seconds
    round_ids: List[str] = field(default_factory=list)
    dcs_hits: Optional[int] = None          # hits DCS itself reported for this burst
    dcs_hit_targets: Dict[str, int] = field(default_factory=dict)

    def to_dict(self) -> Dict:
        return _clean(asdict(self))


@dataclass
class Kill:
    victim_id: str
    victim_name: str
    victim_pilot: Optional[str]
    victim_coalition: str
    victim_category: str
    time: float
    cause: str
    confidence: str
    killer_id: Optional[str] = None
    killer_name: Optional[str] = None
    killer_pilot: Optional[str] = None
    weapon_id: Optional[str] = None
    weapon_name: Optional[str] = None
    weapon_kind: Optional[str] = None
    miss_distance: Optional[float] = None
    confirmed_by: Optional[str] = None     # "DCS" when DCS reported the kill
    note: Optional[str] = None

    def to_dict(self) -> Dict:
        return _clean(asdict(self))


@dataclass
class WeaponReport:
    shots: List[Shot]
    bursts: List[GunBurst]
    kills: List[Kill]
    destructions: List[Destruction]
    by_shooter: Dict[str, Dict]
    rounds: Dict[str, int] = field(default_factory=dict)

    def to_dict(self) -> Dict:
        return {
            "shots": [s.to_dict() for s in self.shots],
            "bursts": [b.to_dict() for b in self.bursts],
            "kills": [k.to_dict() for k in self.kills],
            "byShooter": self.by_shooter,
            "rounds": self.rounds,
        }


def _clean(d: Dict) -> Dict:
    """camelCase keys, NaN -> None, so the dict is valid JSON."""
    out = {}
    for key, value in d.items():
        parts = key.split("_")
        camel = parts[0] + "".join(p.title() for p in parts[1:])
        if isinstance(value, float) and math.isnan(value):
            value = None
        elif isinstance(value, dict):
            value = {k: (None if isinstance(v, float) and math.isnan(v) else v) for k, v in value.items()}
        out[camel] = value
    return out


# ---------------------------------------------------------------------------
# Destruction detection
# ---------------------------------------------------------------------------


def find_destructions(rec: Recording) -> Dict[str, Destruction]:
    """Work out which platforms died, when, and how sure we are."""
    out: Dict[str, Destruction] = {}
    left_area = {oid for e in rec.events if e.kind == "LeftArea" for oid in e.object_ids}

    for e in rec.events:
        if e.kind != "Destroyed":
            continue
        for oid in e.object_ids:
            tr = rec.tracks.get(oid)
            if tr is None or not _is_platform(tr):
                continue
            prev = out.get(oid)
            if prev is None or e.time < prev.time:
                out[oid] = Destruction(oid, e.time, "event", "confirmed")

    for tr in rec.tracks.values():
        if not _is_platform(tr) or tr.id in out:
            continue
        health = tr.channel("Health")
        if health is not None:
            for i, h in enumerate(health):
                if h == h and h <= 0.0:
                    out[tr.id] = Destruction(tr.id, tr.t[i], "health", "confirmed")
                    break
            if tr.id in out:
                continue

        if tr.removed_at is None or tr.id in left_area:
            continue
        if tr.removed_at >= rec.end_time - 1.0:
            continue  # recording ended, not a death
        if T.is_aircraft(tr.tags) or tr.category == "air":
            agl = tr.value_at("AGL", tr.removed_at)
            alt = tr.value_at("Altitude", tr.removed_at)
            spd = tr.value_at("IAS", tr.removed_at)
            if agl != agl:
                min_alt = min((a for a in tr.series("Altitude") if a == a), default=alt)
                agl = alt - min_alt if alt == alt else NAN
            airborne = (agl == agl and agl > 30.0) or (spd == spd and spd > 40.0)
            if airborne:
                out[tr.id] = Destruction(tr.id, tr.removed_at, "removed-in-flight", "probable")
        elif tr.category in ("ground", "sea") and not T.is_static(tr.tags):
            out[tr.id] = Destruction(tr.id, tr.removed_at, "removed", "probable")

    return out


# ---------------------------------------------------------------------------
# Shot analysis
# ---------------------------------------------------------------------------


def _weapon_samples(tr: Track) -> List[Tuple[float, float, float, float]]:
    lon = tr.channel("Longitude")
    lat = tr.channel("Latitude")
    alt = tr.channel("Altitude")
    if lon is None or lat is None:
        return []
    out = []
    for i, t in enumerate(tr.t):
        lo, la = lon[i], lat[i]
        if lo != lo or la != la:
            continue
        a = alt[i] if alt is not None else 0.0
        out.append((t, lo, la, 0.0 if a != a else a))
    return out


def _same_side(weapon: Track, platform: Track) -> bool:
    """Weapons carry their shooter's Country/Coalition; use it as a hard filter."""
    wc, pc = weapon.props.get("Country"), platform.props.get("Country")
    if wc and pc:
        return wc == pc
    wco, pco = weapon.props.get("Coalition"), platform.props.get("Coalition")
    if wco and pco and wco not in ("Neutral", "Unknown"):
        return wco == pco
    return True


def _implausible_round(samples: List[Tuple[float, float, float, float]]) -> bool:
    for (t0, lo0, la0, a0), (t1, lo1, la1, a1) in zip(samples, samples[1:]):
        dt = t1 - t0
        if dt > 1e-3 and geo.slant_range(lo0, la0, a0, lo1, la1, a1) / dt > MAX_ROUND_SPEED:
            return True
    return False


def _find_launcher(rec: Recording, weapon: Track, platforms: List[Track]) -> Tuple[Optional[Track], Optional[str]]:
    parent = weapon.props.get("Parent")
    if parent and parent in rec.tracks:
        return rec.tracks[parent], "parent"
    first = weapon.position_at(weapon.first_seen)
    if first is None:
        return None, None
    best: Optional[Track] = None
    best_d = ROUND_LAUNCHER_RADIUS if weapon.category == "round" else LAUNCHER_RADIUS
    for tr in platforms:
        if not tr.alive_at(weapon.first_seen, grace=0.5) or not _same_side(weapon, tr):
            continue
        # Interpolate: aircraft are sampled every ~0.2 s and move 50 m in that.
        pos = tr.position_interp(weapon.first_seen)
        if pos is None:
            continue
        d = geo.slant_range(first[0], first[1], first[2], pos[0], pos[1], pos[2])
        if d < best_d:
            best, best_d = tr, d
    return (best, "proximity") if best else (None, None)


def _locked_target(rec: Recording, launcher: Track, t: float) -> Optional[Track]:
    tid = launcher.text_at("LockedTarget", t)
    if not tid:
        return None
    mode = launcher.value_at("LockedTargetMode", t)
    if mode == mode and mode <= 0:
        return None
    tgt = rec.tracks.get(tid)
    if tgt is None or not tgt.alive_at(t, grace=1.0):
        return None
    return tgt


def _closest_approach(
    samples: List[Tuple[float, float, float, float]],
    candidates: List[Track],
    limit: float,
) -> Tuple[Optional[Track], float, float]:
    """Closest distance between a weapon's path and any candidate.

    Between consecutive weapon samples both the weapon and the candidate are
    treated as moving in straight lines, and the minimum of that relative
    motion is solved exactly.  A round at ~1000 m/s covers hundreds of metres
    per recorded sample, so checking only at the samples - or even on a fine
    grid - misses near passes by tens of metres.
    """
    best: Optional[Track] = None
    best_d = limit
    best_t = NAN
    if not samples:
        return best, best_d, best_t
    for cand in candidates:
        prev = None  # (t, rel_east, rel_north, rel_up) of the previous sample
        for t, lo, la, al in samples:
            if not cand.alive_at(t, grace=0.5):
                prev = None
                continue
            pos = cand.position_interp(t)
            if pos is None:
                prev = None
                continue
            kx = geo.m_per_deg_lon(la)
            rel = (t, (lo - pos[0]) * kx, (la - pos[1]) * geo.M_PER_DEG_LAT, al - pos[2])
            d = math.sqrt(rel[1] ** 2 + rel[2] ** 2 + rel[3] ** 2)
            if d < best_d:
                best, best_d, best_t = cand, d, t
            if prev is not None:
                dx, dy, dz = rel[1] - prev[1], rel[2] - prev[2], rel[3] - prev[3]
                seg2 = dx * dx + dy * dy + dz * dz
                if seg2 > 1e-9:
                    f = -(prev[1] * dx + prev[2] * dy + prev[3] * dz) / seg2
                    if 0.0 < f < 1.0:
                        cx, cy, cz = prev[1] + dx * f, prev[2] + dy * f, prev[3] + dz * f
                        dm = math.sqrt(cx * cx + cy * cy + cz * cz)
                        if dm < best_d:
                            best, best_d, best_t = cand, dm, prev[0] + (t - prev[0]) * f
            prev = rel
    return best, best_d, best_t


def _launch_geometry(launcher: Track, target: Track, t: float) -> Dict[str, float]:
    lp = launcher.position_at(t)
    tp = target.position_at(t)
    if lp is None or tp is None:
        return {}
    rng = geo.slant_range(lp[0], lp[1], lp[2], tp[0], tp[1], tp[2])
    brg = geo.bearing(lp[0], lp[1], tp[0], tp[1])
    l_hdg = launcher.value_at("Yaw", t)
    if l_hdg != l_hdg:
        l_hdg = launcher.value_at("HDG", t)
    t_hdg = target.value_at("Yaw", t)
    if t_hdg != t_hdg:
        t_hdg = target.value_at("HDG", t)

    geo_out: Dict[str, float] = {
        "range": rng,
        "bearing": brg,
        "altitudeDelta": tp[2] - lp[2],
        "targetAltitude": tp[2],
    }
    ground = geo.ground_distance(lp[0], lp[1], tp[0], tp[1])
    geo_out["elevation"] = math.degrees(math.atan2(tp[2] - lp[2], max(ground, 1.0)))
    if l_hdg == l_hdg:
        geo_out["offBoresight"] = abs(geo.wrap180(brg - l_hdg))
    if t_hdg == t_hdg:
        geo_out["aspect"] = geo.aspect_angle(tp[0], tp[1], t_hdg, lp[0], lp[1])
        geo_out["targetHeading"] = t_hdg
    tspd = target.value_at("TAS", t)
    if tspd == tspd:
        geo_out["targetSpeed"] = tspd

    # Closure over +/- 1 s.
    lp0, tp0 = launcher.position_at(t - 1.0), target.position_at(t - 1.0)
    if lp0 is not None and tp0 is not None:
        r0 = geo.slant_range(lp0[0], lp0[1], lp0[2], tp0[0], tp0[1], tp0[2])
        geo_out["closure"] = r0 - rng
    return geo_out


def _launch_state(launcher: Track, t: float) -> Dict[str, float]:
    out: Dict[str, float] = {}
    for key, ch in (("altitude", "Altitude"), ("ias", "IAS"), ("tas", "TAS"), ("mach", "Mach"),
                    ("heading", "Yaw"), ("pitch", "Pitch"), ("roll", "Roll"), ("aoa", "AOA"),
                    ("longitude", "Longitude"), ("latitude", "Latitude")):
        v = launcher.value_at(ch, t)
        if v == v:
            out[key] = v
    return out


def _speed_profile(samples: List[Tuple[float, float, float, float]]) -> Optional[float]:
    best = None
    for (t0, lo0, la0, a0), (t1, lo1, la1, a1) in zip(samples, samples[1:]):
        dt = t1 - t0
        if dt <= 1e-3:
            continue
        v = geo.slant_range(lo0, la0, a0, lo1, la1, a1) / dt
        if best is None or v > best:
            best = v
    return best


def analyze_weapons(rec: Recording, destructions: Optional[Dict[str, Destruction]] = None) -> WeaponReport:
    destructions = destructions if destructions is not None else find_destructions(rec)
    platforms = [tr for tr in rec.tracks.values() if _is_platform(tr)]
    weapons = sorted(
        (tr for tr in rec.tracks.values() if tr.category in ("weapon", "round")),
        key=lambda tr: tr.first_seen,
    )

    shots: List[Shot] = []
    gun_rounds: Dict[str, List[Tuple[Track, List]]] = {}
    round_stats = {"total": 0, "attributed": 0, "implausible": 0}

    for w in weapons:
        kind = weapon_kind(w.tags)
        samples = _weapon_samples(w)
        if kind == "gun":
            round_stats["total"] += 1
            if _implausible_round(samples):
                round_stats["implausible"] += 1
                continue
            launcher, _src = _find_launcher(rec, w, platforms)
            if launcher is not None:
                round_stats["attributed"] += 1
                gun_rounds.setdefault(launcher.id, []).append((w, samples))
            continue
        launcher, launcher_src = _find_launcher(rec, w, platforms)

        end_time = w.removed_at if w.removed_at is not None else w.last_seen
        shot = Shot(
            weapon_id=w.id,
            weapon_name=ammo_name(w.name),
            kind=kind,
            guided=T.is_guided(w.tags),
            launcher_id=launcher.id if launcher else None,
            launcher_name=launcher.name if launcher else None,
            launcher_pilot=launcher.pilot if launcher else None,
            launcher_coalition=launcher.coalition if launcher else w.coalition,
            launcher_source=launcher_src,
            launch_time=w.first_seen,
            end_time=end_time,
            time_of_flight=end_time - w.first_seen,
            max_speed=_speed_profile(samples),
        )

        target: Optional[Track] = None
        if launcher is not None:
            target = _locked_target(rec, launcher, w.first_seen)
            if target is not None:
                shot.target_source = "lock"
            shot.launch = _launch_state(launcher, w.first_seen)

        # Candidates for closest approach: hostile platforms near the end point.
        end_pos = samples[-1] if samples else None
        cands: List[Track] = []
        if end_pos is not None:
            for tr in platforms:
                if launcher is not None and (tr.id == launcher.id or not _hostile(launcher, tr)):
                    continue
                if not (tr.first_seen <= end_time + 1.0 and (tr.removed_at or tr.last_seen) >= w.first_seen - 1.0):
                    continue
                pos = tr.position_at(min(end_time, tr.last_seen))
                if pos is None:
                    continue
                if geo.ground_distance(end_pos[1], end_pos[2], pos[0], pos[1]) < 40000.0:
                    cands.append(tr)

        if target is not None:
            _, ca, ct = _closest_approach(samples, [target], float("inf"))
            shot.closest_approach, shot.closest_time = ca, ct
        else:
            tgt, ca, ct = _closest_approach(samples, cands, TARGET_RADIUS.get(kind, 3000.0))
            if tgt is not None:
                target = tgt
                shot.target_source = "closest-approach"
                shot.closest_approach, shot.closest_time = ca, ct

        if target is not None:
            shot.target_id = target.id
            shot.target_name = target.name
            shot.target_pilot = target.pilot
            if launcher is not None:
                shot.geometry = _launch_geometry(launcher, target, w.first_seen)

        still_flying = w.removed_at is None and w.last_seen >= rec.end_time - 0.5
        shot.outcome = "active" if still_flying else "miss"
        if any(e.kind == "Timeout" and w.id in e.object_ids for e in rec.events):
            shot.outcome_detail = "timed out"
        shots.append(shot)

    bursts = _gun_bursts(rec, gun_rounds, platforms)
    bursts.extend(_trigger_bursts(rec, {b.launcher_id for b in bursts}))
    kills = _attribute_kills(rec, destructions, shots, bursts, gun_rounds)

    # Anything whose shot/target was hit but not destroyed counts as damage.
    for shot in shots:
        if shot.outcome != "miss" or not shot.target_id:
            continue
        tgt = rec.tracks.get(shot.target_id)
        if tgt is None or tgt.channel("Health") is None:
            continue
        before = tgt.value_at("Health", shot.launch_time)
        after = tgt.value_at("Health", shot.end_time + 2.0)
        if before == before and after == after and after < before - 0.01:
            shot.outcome = "damage"
            shot.outcome_detail = f"health {before:.2f} -> {after:.2f}"

    return WeaponReport(
        shots=shots,
        bursts=sorted(bursts, key=lambda b: b.start),
        kills=sorted(kills, key=lambda k: k.time),
        destructions=sorted(destructions.values(), key=lambda d: d.time),
        by_shooter=_tally(shots, bursts, kills, rec),
        rounds=round_stats,
    )


# ---------------------------------------------------------------------------
# Guns
# ---------------------------------------------------------------------------


def _gun_bursts(
    rec: Recording,
    gun_rounds: Dict[str, List[Tuple[Track, List]]],
    platforms: List[Track],
) -> List[GunBurst]:
    bursts: List[GunBurst] = []
    for launcher_id, rounds in gun_rounds.items():
        launcher = rec.tracks[launcher_id]
        rounds.sort(key=lambda r: r[0].first_seen)
        # A burst is one trigger pull of one gun: split on a gap between
        # consecutive rounds, and never mix ammunition types.
        groups: List[List[Tuple[Track, List]]] = []
        last_by_ammo: Dict[str, List[Tuple[Track, List]]] = {}
        for rnd in rounds:
            ammo = ammo_name(rnd[0].name)
            grp = last_by_ammo.get(ammo)
            if grp is not None and rnd[0].first_seen - grp[-1][0].first_seen <= BURST_GAP:
                grp.append(rnd)
            else:
                grp = [rnd]
                groups.append(grp)
                last_by_ammo[ammo] = grp
        groups.sort(key=lambda g: g[0][0].first_seen)
        hostile = [p for p in platforms if p.id != launcher_id and _hostile(launcher, p)]
        for grp in groups:
            start = grp[0][0].first_seen
            end = max((r[0].removed_at or r[0].last_seen) for r in grp)
            last_fired = grp[-1][0].first_seen
            burst = GunBurst(
                launcher_id=launcher_id,
                launcher_name=launcher.name,
                launcher_pilot=launcher.pilot,
                start=start,
                end=end,
                rounds=len(grp),
                weapon_name=gun_name(ammo_name(grp[0][0].name)) or ammo_name(grp[0][0].name),
                ammo=ammo_name(grp[0][0].name),
                round_ids=[r[0].id for r in grp],
            )
            # Rounds are first seen on recorder frames, so several share a
            # timestamp; count the last frame as a full frame interval.
            seen = sorted({r[0].first_seen for r in grp})
            if len(seen) > 1:
                frame = min(b - a for a, b in zip(seen, seen[1:]))
                burst.fire_rate = len(grp) / (seen[-1] - seen[0] + frame)
            tofs = [((r[0].removed_at or r[0].last_seen) - r[0].first_seen) for r in grp]
            burst.time_of_flight = sum(tofs) / len(tofs) if tofs else None
            # Target: whatever the burst's rounds passed closest to.  Probe a
            # spread of rounds so a long burst walked across a target counts.
            step = max(1, len(grp) // 8)
            probe = []
            for r in grp[::step] + [grp[-1]]:
                probe.extend(r[1])
            tgt, ca, _ = _closest_approach(probe, hostile, TARGET_RADIUS["gun"])
            if tgt is not None:
                burst.target_id, burst.target_name, burst.closest_approach = tgt.id, tgt.name, ca
                lp, tp = launcher.position_at(start), tgt.position_at(start)
                if lp and tp:
                    burst.range_at_open = geo.slant_range(*lp, *tp)
                # Per-round miss distance along its whole recorded path.
                on_target = 0
                for rnd, samples in grp:
                    _, miss, _ = _closest_approach(samples, [tgt], float("inf"))
                    if miss <= ROUND_HIT_RADIUS:
                        on_target += 1
                burst.rounds_on_target = on_target
            bursts.append(burst)
    return bursts


def _trigger_bursts(rec: Recording, already: set) -> List[GunBurst]:
    """Bursts from ``TriggerPressed`` when rounds were not exported."""
    out: List[GunBurst] = []
    for tr in rec.aircraft():
        if tr.id in already:
            continue
        trig = tr.channel("TriggerPressed")
        if trig is None:
            continue
        start = None
        for i, v in enumerate(trig):
            pressed = v == v and v > 0.5
            if pressed and start is None:
                start = tr.t[i]
            elif not pressed and start is not None:
                out.append(GunBurst(tr.id, tr.name, tr.pilot, start, tr.t[i], 0, source="trigger"))
                start = None
        if start is not None:
            out.append(GunBurst(tr.id, tr.name, tr.pilot, start, tr.t[-1], 0, source="trigger"))
    return out


# ---------------------------------------------------------------------------
# Kill attribution
# ---------------------------------------------------------------------------


def _attribute_kills(
    rec: Recording,
    destructions: Dict[str, Destruction],
    shots: List[Shot],
    bursts: List[GunBurst],
    gun_rounds: Dict[str, List[Tuple[Track, List]]],
) -> List[Kill]:
    kills: List[Kill] = []
    for d in destructions.values():
        victim = rec.tracks[d.object_id]
        vpos = victim.position_at(min(d.time, victim.last_seen))
        kill = Kill(
            victim_id=victim.id,
            victim_name=victim.name,
            victim_pilot=victim.pilot,
            victim_coalition=victim.coalition,
            victim_category=victim.category,
            time=d.time,
            cause=d.cause,
            confidence=d.confidence,
        )
        if vpos is None:
            kills.append(kill)
            continue

        best: Optional[Tuple[float, Shot]] = None
        for shot in shots:
            if not (d.time - 5.0 <= shot.end_time <= d.time + 2.0):
                continue
            w = rec.tracks[shot.weapon_id]
            wpos = w.position_at(w.last_seen)
            if wpos is None:
                continue
            dist = geo.slant_range(*wpos, *vpos)
            if dist <= KILL_RADIUS.get(shot.kind, 300.0) and (best is None or dist < best[0]):
                best = (dist, shot)

        if best is not None:
            dist, shot = best
            shot.outcome = "kill"
            shot.killed_id, shot.killed_name = victim.id, victim.name
            if not shot.target_id:
                shot.target_id, shot.target_name, shot.target_source = victim.id, victim.name, "kill"
            kill.killer_id = shot.launcher_id
            kill.killer_name = shot.launcher_name
            kill.killer_pilot = shot.launcher_pilot
            kill.weapon_id = shot.weapon_id
            kill.weapon_name = shot.weapon_name
            kill.weapon_kind = shot.kind
            kill.miss_distance = dist
            kills.append(kill)
            continue

        # Guns: any burst that put rounds near the victim just before it died.
        gun_best: Optional[Tuple[float, GunBurst]] = None
        for burst in bursts:
            if not (burst.start - 1.0 <= d.time <= burst.end + 4.0):
                continue
            if burst.target_id == victim.id:
                dist = burst.closest_approach if burst.closest_approach is not None else 0.0
            else:
                dist = math.inf
                for rnd, samples in gun_rounds.get(burst.launcher_id, []):
                    if not (burst.start <= rnd.first_seen <= burst.end):
                        continue
                    for _, lo, la, al in samples[-2:]:
                        dist = min(dist, geo.slant_range(lo, la, al, *vpos))
            if dist <= KILL_RADIUS["gun"] and (gun_best is None or dist < gun_best[0]):
                gun_best = (dist, burst)
        if gun_best is not None:
            dist, burst = gun_best
            burst.kill, burst.killed_id = True, victim.id
            kill.killer_id = burst.launcher_id
            kill.killer_name = burst.launcher_name
            kill.killer_pilot = burst.launcher_pilot
            kill.weapon_name = "Gun"
            kill.weapon_kind = "gun"
            kill.miss_distance = dist
        kills.append(kill)
    return kills


def _tally(shots: List[Shot], bursts: List[GunBurst], kills: List[Kill], rec: Recording) -> Dict[str, Dict]:
    out: Dict[str, Dict] = {}

    def entry(obj_id: Optional[str]) -> Optional[Dict]:
        if not obj_id:
            return None
        if obj_id not in out:
            tr = rec.tracks.get(obj_id)
            out[obj_id] = {
                "id": obj_id,
                "name": tr.name if tr else obj_id,
                "pilot": tr.pilot if tr else None,
                "coalition": tr.coalition if tr else None,
                "shots": 0, "kills": 0, "misses": 0, "active": 0,
                "gunBursts": 0, "gunRounds": 0, "byWeapon": {},
            }
        return out[obj_id]

    for s in shots:
        e = entry(s.launcher_id)
        if e is None:
            continue
        e["shots"] += 1
        w = e["byWeapon"].setdefault(s.weapon_name, {"shots": 0, "kills": 0})
        w["shots"] += 1
        if s.outcome == "kill":
            w["kills"] += 1
        elif s.outcome == "active":
            e["active"] += 1
        else:
            e["misses"] += 1
    for b in bursts:
        e = entry(b.launcher_id)
        if e is not None:
            e["gunBursts"] += 1
            e["gunRounds"] += b.rounds
    for k in kills:
        e = entry(k.killer_id)
        if e is not None:
            e["kills"] += 1
    for e in out.values():
        decided = e["shots"] - e["active"]
        e["pk"] = (sum(w["kills"] for w in e["byWeapon"].values()) / decided) if decided else None
    return out


# ---------------------------------------------------------------------------
# Events DCS itself reported (from a merged flight log)
# ---------------------------------------------------------------------------


def _norm(name: Optional[str]) -> str:
    return "".join(ch for ch in ammo_name(name).lower() if ch.isalnum())


def apply_dcs_events(rep: WeaponReport, rec: Recording, events: List[Dict]) -> Dict[str, int]:
    """Replace inferred hits/kills with what DCS reported, where it reported them."""
    hits = [e for e in events if e.get("kind") == "hit"]
    kills = [e for e in events if e.get("kind") == "kill"]
    shots = [e for e in events if e.get("kind") == "shot"]
    stats = {"hits": len(hits), "kills": len(kills), "shots": len(shots), "killsCorrected": 0, "killsAdded": 0}

    # Each DCS gun hit belongs to exactly one burst: the one whose rounds were
    # in flight then (firing window shifted by the burst's time of flight).
    def window(b: GunBurst) -> Tuple[float, float]:
        ends = [(rec.tracks[r].removed_at or rec.tracks[r].last_seen) for r in b.round_ids if r in rec.tracks]
        if ends:  # when the recorded rounds actually ended (impact or timeout)
            return min(ends) - 0.3, max(ends) + 0.5
        tof = b.time_of_flight or 0.0
        fire_end = b.start + (b.rounds / b.fire_rate if b.fire_rate else 0.0)
        return b.start + 0.5 * tof, fire_end + 1.5 * tof + 0.3

    per_burst: Dict[int, List[Dict]] = {id(b): [] for b in rep.bursts}
    for e in hits:
        t = e["time"]
        scored = []
        for b in rep.bursts:
            if e.get("initiatorId") != b.launcher_id:
                continue
            if not (e.get("weaponCategory") == 0 or (b.ammo and _norm(e.get("weapon")) == _norm(b.ammo))):
                continue
            lo, hi = window(b)
            d = max(0.0, lo - t, t - hi)
            # Overlapping windows: the latest burst whose rounds had arrived.
            arrived = lo <= t
            scored.append((d, 0 if arrived else 1, -b.start, id(b)))
        if scored:
            d, _, _, bid = min(scored)
            if d < 1.0:
                per_burst[bid].append(e)
    for b in rep.bursts:
        mine = per_burst[id(b)]
        b.dcs_hits = len(mine)
        counts: Dict[str, int] = {}
        for e in mine:
            tgt = rec.tracks.get(e.get("targetId") or "")
            name = tgt.display_name if tgt else ((e.get("target") or {}).get("type") or "?")
            counts[name] = counts.get(name, 0) + 1
        b.dcs_hit_targets = counts

    for s in rep.shots:
        s.dcs_confirmed = any(e.get("initiatorId") == s.launcher_id and abs(e["time"] - s.launch_time) <= 1.5
                              and _norm(e.get("weapon")) == _norm(s.weapon_name) for e in shots) if shots else None
        for e in hits:
            if (e.get("initiatorId") == s.launcher_id and s.launch_time <= e["time"] <= s.end_time + 2.0
                    and _norm(e.get("weapon")) == _norm(s.weapon_name)):
                tgt = rec.tracks.get(e.get("targetId") or "")
                s.dcs_hit = tgt.display_name if tgt else ((e.get("target") or {}).get("type") or "?")
                if s.outcome == "miss":
                    s.outcome, s.outcome_detail = "damage", "DCS reported a hit"
                break

    for e in kills:
        vid = e.get("targetId")
        if not vid or vid not in rec.tracks:
            continue
        killer = rec.tracks.get(e.get("initiatorId") or "")
        weapon = ammo_name(e.get("weapon")) or None
        existing = next((k for k in rep.kills if k.victim_id == vid), None)
        if existing is None:
            victim = rec.tracks[vid]
            existing = Kill(victim_id=vid, victim_name=victim.name, victim_pilot=victim.pilot,
                            victim_coalition=victim.coalition, victim_category=victim.category,
                            time=e["time"], cause="dcs", confidence="confirmed")
            rep.kills.append(existing)
            stats["killsAdded"] += 1
        existing.confirmed_by = "DCS"
        existing.confidence = "confirmed"
        if killer is not None and existing.killer_id != killer.id:
            if existing.killer_id:
                existing.note = f"inferred {existing.killer_pilot or existing.killer_name}; DCS credits {killer.display_name}"
                stats["killsCorrected"] += 1
            existing.killer_id, existing.killer_name, existing.killer_pilot = killer.id, killer.name, killer.pilot
            existing.weapon_name = gun_name(weapon or "") or weapon
            existing.weapon_kind = "gun" if e.get("weaponCategory") == 0 else existing.weapon_kind
    rep.kills.sort(key=lambda k: k.time)
    return stats
