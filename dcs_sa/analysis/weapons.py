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
#: Max distance from a weapon's first sample to its launcher.
LAUNCHER_RADIUS = 600.0
#: Gun rounds further apart than this belong to separate bursts.
BURST_GAP = 1.0
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
    rounds_on_target: Optional[int] = None
    fire_rate: Optional[float] = None  # rounds per second, as recorded
    time_of_flight: Optional[float] = None  # mean, seconds
    round_ids: List[str] = field(default_factory=list)

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

    def to_dict(self) -> Dict:
        return _clean(asdict(self))


@dataclass
class WeaponReport:
    shots: List[Shot]
    bursts: List[GunBurst]
    kills: List[Kill]
    destructions: List[Destruction]
    by_shooter: Dict[str, Dict]

    def to_dict(self) -> Dict:
        return {
            "shots": [s.to_dict() for s in self.shots],
            "bursts": [b.to_dict() for b in self.bursts],
            "kills": [k.to_dict() for k in self.kills],
            "byShooter": self.by_shooter,
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


def _find_launcher(rec: Recording, weapon: Track, platforms: List[Track]) -> Tuple[Optional[Track], Optional[str]]:
    parent = weapon.props.get("Parent")
    if parent and parent in rec.tracks:
        return rec.tracks[parent], "parent"
    first = weapon.position_at(weapon.first_seen)
    if first is None:
        return None, None
    best: Optional[Track] = None
    best_d = LAUNCHER_RADIUS
    for tr in platforms:
        if not tr.alive_at(weapon.first_seen, grace=0.5):
            continue
        pos = tr.position_at(weapon.first_seen)
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

    for w in weapons:
        kind = weapon_kind(w.tags)
        launcher, launcher_src = _find_launcher(rec, w, platforms)
        samples = _weapon_samples(w)
        if kind == "gun":
            if launcher is not None:
                gun_rounds.setdefault(launcher.id, []).append((w, samples))
            continue

        end_time = w.removed_at if w.removed_at is not None else w.last_seen
        shot = Shot(
            weapon_id=w.id,
            weapon_name=w.name,
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
        groups: List[List[Tuple[Track, List]]] = []
        for rnd in rounds:
            if groups and rnd[0].first_seen - groups[-1][-1][0].first_seen <= BURST_GAP:
                groups[-1].append(rnd)
            else:
                groups.append([rnd])
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
                weapon_name=grp[0][0].name,
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
