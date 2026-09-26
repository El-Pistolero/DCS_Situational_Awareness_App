"""Synthetic dogfight with heat-seekers: AIM-9Ms, an R-73 and flares.

A demo recording for the IR (heat) side of the app.  An F-16C ("Ethan")
merges with a MiG-29S ("Ivanov") and turns with it:

* Ethan's first AIM-9M goes for one of the MiG's flares and misses;
* the MiG's R-73 is defeated by Ethan's break and a flare burst;
* the MiG extends in afterburner, and Ethan's second AIM-9M kills it.

Written the way DCS's Tacview exporter writes these (checked against real
recordings): flares are separate ``Misc+Decoy+Flare`` objects with no
name, no Parent and Coalition Neutral, living ~9 s at ~2 Hz; missiles have
no Parent and no target; engine data (Throttle, FuelFlowWeight) is written
for the recording player's own jet only; a destroyed aircraft is simply
removed.
"""

from __future__ import annotations

import math
import os
from dataclasses import dataclass
from typing import Dict, List, Optional, Tuple

from .analysis import geo
from .samplegen import FIELD_LAT, FIELD_LON, G, Emitter, Entity

DT = 0.05            # simulation step (missiles need it)
AIR_EVERY = 0.2      # aircraft samples
MSL_EVERY = 0.15     # missile samples (DCS: ~7 Hz)
FLARE_EVERY = 0.5    # flare samples (DCS: ~2 Hz)
FLARE_LIFE = 9.0


def _v3(hdg: float, pitch: float, speed: float) -> Tuple[float, float, float]:
    h, p = math.radians(hdg), math.radians(pitch)
    return (math.sin(h) * math.cos(p) * speed, math.cos(h) * math.cos(p) * speed, math.sin(p) * speed)


@dataclass
class Flare:
    obj_id: str
    e: float
    n: float
    alt: float
    ve: float
    vn: float
    vz: float
    born: float
    last: float = -1e9

    def step(self, dt: float) -> None:
        # A burning pellet: drag bleeds its launch speed in a few seconds.
        k = math.exp(-dt / 1.2)
        self.ve *= k
        self.vn *= k
        self.vz = self.vz * k - G * 0.35 * dt
        self.e += self.ve * dt
        self.n += self.vn * dt
        self.alt += self.vz * dt


@dataclass
class HeatSeeker:
    """Pursuit with lead toward whatever the seeker is looking at."""

    obj_id: str
    name: str
    e: float
    n: float
    alt: float
    vel: Tuple[float, float, float]
    born: float
    target: object                 # Entity or Flare the seeker follows
    max_g: float = 40.0
    life: float = 40.0
    boost: float = 5.2
    alive: bool = True
    last: float = -1e9
    prev_rel: Optional[Tuple[float, float, float]] = None   # to the real target, last step

    def aim_point(self) -> Tuple[float, float, float, Tuple[float, float, float]]:
        t = self.target
        if isinstance(t, Flare):
            return t.e, t.n, t.alt, (t.ve, t.vn, t.vz)
        v = _v3(t.hdg, 0.0, t.tas)
        return t.east, t.north, t.alt, (v[0], v[1], t.vs)

    def step(self, dt: float, t_now: float) -> None:
        age = t_now - self.born
        speed = math.sqrt(sum(c * c for c in self.vel))
        speed = min(900.0, speed + 170.0 * dt) if age < self.boost else max(250.0, speed - 22.0 * dt)
        ae, an, aa, av = self.aim_point()
        rel = (ae - self.e, an - self.n, aa - self.alt)
        dist = math.sqrt(sum(c * c for c in rel)) or 1.0
        tgo = dist / max(speed, 1.0)
        want = (rel[0] + av[0] * tgo, rel[1] + av[1] * tgo, rel[2] + av[2] * tgo)
        wn = math.sqrt(sum(c * c for c in want)) or 1.0
        cur = tuple(c / (speed or 1.0) for c in self.vel)
        tgt = tuple(c / wn for c in want)
        ang = math.acos(max(-1.0, min(1.0, sum(a * b for a, b in zip(cur, tgt)))))
        max_turn = self.max_g * G / max(speed, 1.0) * dt
        f = 1.0 if ang <= max_turn else max_turn / ang
        d = tuple(a + (b - a) * f for a, b in zip(cur, tgt))
        dn = math.sqrt(sum(c * c for c in d)) or 1.0
        self.vel = tuple(c / dn * speed for c in d)
        self.e += self.vel[0] * dt
        self.n += self.vel[1] * dt
        self.alt += self.vel[2] * dt

    def hdg_pitch(self) -> Tuple[float, float]:
        ve, vn, vz = self.vel
        return math.degrees(math.atan2(ve, vn)) % 360.0, math.degrees(math.atan2(vz, math.hypot(ve, vn)))


def _segment_miss(prev: Optional[Tuple[float, float, float]], cur: Tuple[float, float, float]) -> float:
    """Closest distance over one step, target relative to missile (closure outruns a 9 m check)."""
    if prev is None:
        return math.sqrt(sum(c * c for c in cur))
    d = tuple(b - a for a, b in zip(prev, cur))
    dd = sum(c * c for c in d)
    k = 0.0 if dd == 0 else max(0.0, min(1.0, -sum(a * b for a, b in zip(prev, d)) / dd))
    return math.sqrt(sum((a + b * k) ** 2 for a, b in zip(prev, d)))


def _bearing(a: Entity, e: float, n: float) -> float:
    return math.degrees(math.atan2(e - a.east, n - a.north)) % 360.0


def _off_nose(a: Entity, b: Entity) -> float:
    return abs(geo.wrap180(_bearing(a, b.east, b.north) - a.hdg))


def build_dogfight_sample(duration: float = 150.0) -> List[str]:
    em = Emitter(FIELD_LON, FIELD_LAT)
    em.raw("FileType=text/acmi/tacview")
    em.raw("FileVersion=2.2")
    em.raw("0,ReferenceTime=2026-09-26T09:00:00Z")
    em.raw(f"0,ReferenceLongitude={FIELD_LON}")
    em.raw(f"0,ReferenceLatitude={FIELD_LAT}")
    em.raw("0,Title=Heat-seeker dogfight - sample sortie")
    em.raw("0,DataSource=DCS 2.9 (synthetic sample)")
    em.raw("0,DataRecorder=DCS SA sample generator")

    ethan = Entity("101", "F-16C_50", "Air+FixedWing", "Allies", "Blue", east=-12000.0, north=0.0, alt=6000.0,
                   hdg=90.0, tas=250.0, pilot="Ethan", group="Viper 1", on_ground=False, gear=0.0)
    ivan = Entity("201", "MiG-29S", "Air+FixedWing", "Enemies", "Red", east=12000.0, north=900.0, alt=6200.0,
                  hdg=270.0, tas=240.0, pilot="Ivanov", group="Fulcrum 1", country="ru", on_ground=False, gear=0.0)
    for a in (ethan, ivan):
        a.cmd_hdg, a.cmd_tas, a.cmd_alt, a.max_bank, a.max_accel = a.hdg, a.tas, a.alt, 80.0, 9.0

    flares: List[Flare] = []
    missiles: List[HeatSeeker] = []
    next_id = [0x4000]
    ab: Dict[str, bool] = {"101": False, "201": False}
    flare_due: List[Tuple[float, str]] = []
    decoy_at: Dict[str, Tuple[float, str]] = {}   # missile id -> (from time, jet whose next flare it takes)
    kill_pending: List[Tuple[float, str]] = []
    shots: Dict[str, float] = {}

    def new_id() -> str:
        next_id[0] += 1
        return f"{next_id[0]:x}"

    def pos(ent: Entity) -> Tuple[float, float, float]:
        return ent.east, ent.north, ent.alt

    def launch(shooter: Entity, name: str, target: Entity, t: float, max_g: float, life: float) -> HeatSeeker:
        h = math.radians(shooter.hdg)
        m = HeatSeeker(new_id(), name, shooter.east + math.sin(h) * 6.0, shooter.north + math.cos(h) * 6.0,
                       shooter.alt - 2.0, _v3(shooter.hdg, 0.0, shooter.tas + 30.0), t, target, max_g=max_g, life=life)
        missiles.append(m)
        return m

    def emit_flare(fl: Flare, first: bool = False) -> None:
        text = {"Type": "Misc+Decoy+Flare", "Coalition": "Neutral", "Color": "Violet"} if first else {}
        em.update(fl.obj_id, (*geo.to_lonlat(fl.e, fl.n, FIELD_LON, FIELD_LAT), fl.alt, None, None, None), {}, text)

    t = 0.0
    last_air = -1e9
    phase, t_phase, closest = "merge", 0.0, 1e9
    while t <= duration + 1e-9:
        # One frame marker per step; empty ones are merged at the end.
        em.frame(t)

        # --- the fight: merge, Ethan gains the MiG's six, overshoots, the MiG runs ----------
        rng = math.dist(pos(ethan), pos(ivan)) if ivan.alive else 1e9
        if ivan.alive:
            if phase == "merge":
                # Head-on, offset a little, until they have passed each other.
                ivan.cmd_hdg = _bearing(ivan, ethan.east + 0.0, ethan.north + 600.0)
                ethan.cmd_hdg = _bearing(ethan, ivan.east, ivan.north - 600.0) if rng > 3000.0 else ethan.hdg
                if rng < 3000.0:
                    ivan.cmd_hdg = ivan.hdg
                closest = min(closest, rng)
                if closest < 2500.0 and rng > closest + 300.0:
                    phase, t_phase = "turn", t
            elif phase == "turn":  # the MiG holds a hard left turn; Ethan pulls lead onto its six
                ivan.cmd_hdg, ivan.cmd_tas, ivan.max_bank = (ivan.hdg - 30.0) % 360.0, 225.0, 55.0
                le = ivan.east + math.sin(math.radians(ivan.hdg)) * ivan.tas * 1.5
                ln = ivan.north + math.cos(math.radians(ivan.hdg)) * ivan.tas * 1.5
                # Pull harder than the geometry asks (more bank): Ethan out-turns the MiG.
                ethan.max_bank = 85.0
                err = geo.wrap180(_bearing(ethan, le, ln) - ethan.hdg)
                if abs(err) > 150.0:
                    err = 150.0  # the MiG is behind: come round to the right, into its turn
                ethan.cmd_hdg = (ethan.hdg + max(-90.0, min(90.0, 2.5 * err))) % 360.0
                ethan.cmd_tas = 235.0
                if "aim9a" in shots and t > shots["aim9a"] + 6.0:
                    phase, t_phase = "overshoot", t
            elif phase == "overshoot":  # Ethan flies through; the MiG reverses onto his tail
                ethan.cmd_tas = 215.0
                ethan.cmd_hdg = (ethan.hdg + (8.0 if t - t_phase > 6.0 else 0.0)) % 360.0
                le = ethan.east + math.sin(math.radians(ethan.hdg)) * ethan.tas * 1.0
                ln = ethan.north + math.cos(math.radians(ethan.hdg)) * ethan.tas * 1.0
                ivan.cmd_hdg, ivan.cmd_tas, ivan.max_bank = _bearing(ivan, le, ln), 285.0, 80.0
                if "r73" in shots:
                    phase, t_phase = "break", t
            elif phase == "break":  # Ethan breaks hard into the R-73, flares going
                ethan.cmd_hdg, ethan.cmd_tas = (ethan.hdg + 45.0) % 360.0, 240.0
                ab["101"] = True
                ivan.cmd_hdg = _bearing(ivan, ethan.east, ethan.north)
                if t - t_phase > 9.0:
                    phase, t_phase = "extend", t
                    ab["101"] = False
            else:  # the MiG runs in afterburner; Ethan follows it down its tail
                away = (_bearing(ethan, ivan.east, ivan.north)) % 360.0
                ivan.cmd_hdg, ivan.cmd_tas, ivan.max_bank = away, 330.0, 45.0
                ab["201"] = True
                ethan.cmd_hdg, ethan.cmd_tas = _bearing(ethan, ivan.east, ivan.north), 360.0
                ab["101"] = True
        else:
            ethan.cmd_hdg, ethan.cmd_tas = ethan.hdg, 250.0
            ab["101"] = False

        # --- shots: each when the geometry allows it ---------------------------------------
        if "aim9a" not in shots and ivan.alive and phase == "turn" and t > t_phase + 8.0 and rng < 3000.0 and _off_nose(ethan, ivan) < 12.0:
            shots["aim9a"] = t
            m = launch(ethan, "AIM_9", ivan, t, 40.0, 30.0)
            flare_due.extend((t + 1.2 + k * 0.35, "201") for k in range(6))   # AI flare pairs
            decoy_at[m.obj_id] = (t + 2.2, "201")
        if "r73" not in shots and ivan.alive and phase == "overshoot" and rng < 3500.0 and _off_nose(ivan, ethan) < 20.0:
            shots["r73"] = t
            m = launch(ivan, "P_73", ethan, t, 45.0, 22.0)
            flare_due.extend((t + 1.4 + k * 0.25, "101") for k in range(8))   # the player's burst
            decoy_at[m.obj_id] = (t + 2.6, "101")
        if ("aim9b" not in shots and ivan.alive and phase == "extend" and t > t_phase + 5.0 and 1000.0 < rng < 4500.0
                and _off_nose(ethan, ivan) < 15.0 and _off_nose(ivan, ethan) > 130.0):  # Ethan in the MiG's rear quarter
            shots["aim9b"] = t
            launch(ethan, "AIM_9", ivan, t, 40.0, 30.0)   # the MiG in afterburner, no flares left

        # --- flares ----------------------------------------------------------------------------
        for due, owner in sorted(flare_due):
            if due > t:
                continue
            flare_due.remove((due, owner))
            ent = ethan if owner == "101" else ivan
            if not ent.alive:
                continue
            h = math.radians(ent.hdg)
            side = 1.0 if len(flares) % 2 else -1.0
            back = 12.0 + (len(flares) % 3) * 4.0
            fl = Flare(new_id(), ent.east - math.sin(h) * back + math.cos(h) * side * 3.0,
                       ent.north - math.cos(h) * back - math.sin(h) * side * 3.0, ent.alt - 3.0,
                       math.sin(h) * ent.tas * 0.85 + math.cos(h) * side * 20.0,
                       math.cos(h) * ent.tas * 0.85 - math.sin(h) * side * 20.0, -15.0, t)
            fl.last = t
            flares.append(fl)
            emit_flare(fl, first=True)
            # The seeker about to be seduced takes the next flare from that jet.
            for m in missiles:
                d = decoy_at.get(m.obj_id)
                if d and m.alive and d[1] == owner and t >= d[0] and not isinstance(m.target, Flare):
                    m.target = fl

        # --- step ------------------------------------------------------------------------------
        for a in (ethan, ivan):
            if a.alive:
                a.step(DT)
        for fl in list(flares):
            fl.step(DT)
            if t - fl.born >= FLARE_LIFE:
                em.remove(fl.obj_id)
                flares.remove(fl)
            elif t - fl.last >= FLARE_EVERY - 1e-9:
                fl.last = t
                emit_flare(fl)
        for m in list(missiles):
            if not m.alive:
                continue
            m.step(DT, t)
            tgt = m.target
            real = ivan if m.name == "AIM_9" else ethan
            rel = tuple(a - b for a, b in zip(pos(real), (m.e, m.n, m.alt)))
            miss = _segment_miss(m.prev_rel, rel)
            m.prev_rel = rel
            if real.alive and not isinstance(tgt, Flare) and miss < 9.0:
                m.alive = False
                em.update(m.obj_id, (*geo.to_lonlat(m.e, m.n, FIELD_LON, FIELD_LAT), m.alt, None, None, None), {}, {})
                em.remove(m.obj_id)
                kill_pending.append((t + 0.3, real.obj_id))
                continue
            if t - m.born > m.life or m.alt < 50.0:
                m.alive = False
                em.remove(m.obj_id)  # self-destruct: DCS just removes it
                continue
            if t - m.last >= MSL_EVERY - 1e-9:
                m.last = t
                hdg, pitch = m.hdg_pitch()
                blue = m.name == "AIM_9"
                em.update(m.obj_id, (*geo.to_lonlat(m.e, m.n, FIELD_LON, FIELD_LAT), m.alt, 0.0, pitch, hdg), {},
                          {"Type": "Weapon+Missile", "Name": m.name, "Coalition": "Allies" if blue else "Enemies",
                           "Color": "Blue" if blue else "Red"})
        for due, oid in list(kill_pending):
            if due <= t:
                kill_pending.remove((due, oid))
                if oid == "201" and ivan.alive:
                    ivan.alive = False
                    em.remove("201")  # DCS writes no Destroyed event: the unit is just removed

        # --- aircraft samples ------------------------------------------------------------------
        if t - last_air >= AIR_EVERY - 1e-9:
            last_air = t
            for a in (ethan, ivan):
                if not a.alive:
                    continue
                lon, lat = a.lonlat
                num = {"IAS": a.ias, "AOA": a.aoa, "AGL": a.alt - 10.0, "FuelWeight": a.fuel,
                       "VerticalGForce": 1.0 / max(0.15, math.cos(math.radians(a.bank)))}
                if a is ethan:
                    # Engine data for the recording player's jet only, as DCS writes it: the
                    # F-16's throttle reads ~0.9 at military power and ~1.02 in afterburner,
                    # and fuel flow (kg/h) jumps about eightfold.
                    num["Throttle"] = 1.02 if ab["101"] else 0.9
                    num["FuelFlowWeight"] = 24900.0 if ab["101"] else 3100.0
                em.update(a.obj_id, (lon, lat, a.alt, a.bank, a.pitch, a.hdg), num,
                          {"Type": a.type_tags, "Name": a.name, "Pilot": a.pilot or "", "Group": a.group or "",
                           "Coalition": a.coalition, "Color": a.color, "Country": a.country})
        t = round(t + DT, 3)
    return _tidy(em.lines)


def _tidy(lines: List[str]) -> List[str]:
    """Drop frame markers with nothing after them (a marker is written every step)."""
    out: List[str] = []
    for ln in lines:
        if ln.startswith("#") and out and out[-1].startswith("#"):
            out[-1] = ln
        else:
            out.append(ln)
    return out


def write_dogfight_sample(path: str, duration: float = 150.0) -> str:
    lines = build_dogfight_sample(duration)
    os.makedirs(os.path.dirname(os.path.abspath(path)), exist_ok=True)
    with open(path, "w", encoding="utf-8") as f:
        f.write("\n".join(lines) + "\n")
    return path
