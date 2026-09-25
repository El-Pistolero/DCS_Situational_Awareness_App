"""Generate a synthetic but realistic DCS-style ACMI recording.

Used as a test fixture and as a demo file so the app has something to show
before you have flown a sortie.  The flight model is a rate-limited
autopilot rather than real aerodynamics, but every value that the analysis
layer reads - sink rate, AOA, glideslope, lock ranges, launch geometry - is
produced by integrating a trajectory, not hand-written, so the reports are
computed from the same kind of data a real recording contains.
"""

from __future__ import annotations

import math
import os
from dataclasses import dataclass, field
from typing import Dict, List, Optional, Tuple

from .analysis import geo

# Batumi, Caucasus.  Runway 13 threshold and true heading.
FIELD_LON = 41.5997
FIELD_LAT = 41.6103
FIELD_ELEV = 10.0
RWY_HDG = 126.0
RWY_LEN = 2400.0

G = 9.80665
DT = 0.25


def _rate_limit(current: float, target: float, max_delta: float) -> float:
    if target > current:
        return min(target, current + max_delta)
    return max(target, current - max_delta)


@dataclass
class Entity:
    """A simple airframe driven by commanded heading / speed / altitude."""

    obj_id: str
    name: str
    type_tags: str
    coalition: str
    color: str
    east: float = 0.0
    north: float = 0.0
    alt: float = FIELD_ELEV
    hdg: float = RWY_HDG
    tas: float = 0.0
    pilot: Optional[str] = None
    group: Optional[str] = None
    country: str = "us"
    on_ground: bool = True
    bank: float = 0.0
    pitch: float = 0.0
    aoa: float = 0.0
    vs: float = 0.0
    gear: float = 1.0
    flaps: float = 0.0
    airbrakes: float = 0.0
    throttle: float = 0.5
    afterburner: float = 0.0
    fuel: float = 3200.0
    health: float = 1.0
    alive: bool = True
    extra: Dict[str, float] = field(default_factory=dict)
    text_extra: Dict[str, str] = field(default_factory=dict)

    # commanded
    cmd_hdg: float = RWY_HDG
    cmd_tas: float = 0.0
    cmd_alt: float = FIELD_ELEV
    max_bank: float = 60.0
    max_accel: float = 4.0
    max_vs: float = 120.0

    def step(self, dt: float) -> None:
        if not self.alive:
            return

        # Speed
        prev_tas = self.tas
        self.tas = _rate_limit(self.tas, self.cmd_tas, self.max_accel * dt)
        accel = (self.tas - prev_tas) / dt if dt else 0.0
        self.throttle = max(0.0, min(1.5, 0.45 + accel / 6.0))
        self.afterburner = max(0.0, min(1.0, (self.throttle - 1.0) * 2.0))

        # Heading, banking into the turn
        err = geo.wrap180(self.cmd_hdg - self.hdg)
        if self.on_ground or self.tas < 5.0:
            self.bank = 0.0
            turn_rate = max(-6.0, min(6.0, err / max(dt, 0.1)))
        else:
            bank_cmd = max(-self.max_bank, min(self.max_bank, err * 2.0))
            self.bank = _rate_limit(self.bank, bank_cmd, 60.0 * dt)
            turn_rate = math.degrees(G * math.tan(math.radians(self.bank)) / max(self.tas, 30.0))
            if abs(turn_rate * dt) > abs(err):
                turn_rate = err / dt
        self.hdg = geo.wrap360(self.hdg + turn_rate * dt)

        # Vertical
        alt_err = self.cmd_alt - self.alt
        vs_cmd = max(-self.max_vs, min(self.max_vs, alt_err * 0.25))
        self.vs = _rate_limit(self.vs, vs_cmd, 25.0 * dt)
        self.alt += self.vs * dt
        if self.alt <= FIELD_ELEV:
            self.alt = FIELD_ELEV
            if self.vs < 0:
                self.vs = 0.0

        # Attitude: flight path angle plus angle of attack
        gs = max(self.tas, 1.0)
        fpa = math.degrees(math.asin(max(-1.0, min(1.0, self.vs / gs))))
        if self.on_ground:
            self.aoa = 0.5
        else:
            # Lift ~ q * alpha, so alpha scales as n / IAS^2.  Tuned so an
            # F-16 on approach (~145 kt) sits near 12-13 deg.
            ias = max(self.ias, 40.0)
            load = 1.0 / max(0.2, math.cos(math.radians(self.bank)))
            self.aoa = max(0.5, min(25.0, 1.5 + 55000.0 * load / (ias * ias)))
        self.pitch = fpa + self.aoa * (0.0 if self.on_ground else 1.0)

        # Position
        rad = math.radians(self.hdg)
        self.east += math.sin(rad) * self.tas * dt
        self.north += math.cos(rad) * self.tas * dt

        self.fuel = max(0.0, self.fuel - (0.35 + self.afterburner * 2.2) * dt)

    @property
    def lonlat(self) -> Tuple[float, float]:
        return geo.to_lonlat(self.east, self.north, FIELD_LON, FIELD_LAT)

    @property
    def ias(self) -> float:
        """Crude IAS from TAS using a standard-ish density ratio."""
        sigma = max(0.25, 1.0 - self.alt / 44330.0) ** 4.256
        return self.tas * math.sqrt(sigma)

    @property
    def mach(self) -> float:
        temp = max(216.65, 288.15 - 0.0065 * self.alt)
        return self.tas / (20.05 * math.sqrt(temp))

    @property
    def agl(self) -> float:
        return max(0.0, self.alt - FIELD_ELEV)


class Emitter:
    """Writes ACMI lines, emitting only values that changed."""

    def __init__(self, ref_lon: float = 0.0, ref_lat: float = 0.0) -> None:
        # ACMI transforms are offsets from ReferenceLongitude/Latitude.
        self.ref_lon = ref_lon
        self.ref_lat = ref_lat
        self.lines: List[str] = []
        self._last_num: Dict[str, Dict[str, float]] = {}
        self._last_txt: Dict[str, Dict[str, str]] = {}

    def raw(self, line: str) -> None:
        self.lines.append(line)

    def frame(self, t: float) -> None:
        self.lines.append(f"#{t:.2f}")

    def remove(self, obj_id: str) -> None:
        self.lines.append(f"-{obj_id}")
        self._last_num.pop(obj_id, None)
        self._last_txt.pop(obj_id, None)

    def event(self, kind: str, ids: List[str] | None = None, text: str = "") -> None:
        parts = [kind]
        parts.extend(ids or [])
        parts.append(text.replace("\\", "\\\\").replace(",", "\\,").replace("|", "\\|"))
        self.lines.append("0,Event=" + "|".join(parts))

    def update(
        self,
        obj_id: str,
        transform: Tuple[Optional[float], ...],
        numeric: Dict[str, float],
        text: Optional[Dict[str, str]] = None,
    ) -> None:
        prev_num = self._last_num.setdefault(obj_id, {})
        prev_txt = self._last_txt.setdefault(obj_id, {})
        fields: List[str] = []

        slots: List[str] = []
        for i, value in enumerate(transform):
            if value is None:
                slots.append("")
                continue
            key = f"__t{i}"
            if i == 0:
                value -= self.ref_lon
            elif i == 1:
                value -= self.ref_lat
            rounded = round(value, 7 if i < 2 else 2)
            if prev_num.get(key) == rounded:
                slots.append("")
            else:
                prev_num[key] = rounded
                slots.append(f"{rounded:g}")
        if any(slots):
            fields.append("T=" + "|".join(slots))

        for key, value in numeric.items():
            rounded = round(value, 3)
            if prev_num.get(key) == rounded:
                continue
            prev_num[key] = rounded
            fields.append(f"{key}={rounded:g}")

        for key, value in (text or {}).items():
            if prev_txt.get(key) == value:
                continue
            prev_txt[key] = value
            escaped = value.replace("\\", "\\\\").replace(",", "\\,")
            fields.append(f"{key}={escaped}")

        if fields:
            self.lines.append(f"{obj_id}," + ",".join(fields))


def _aircraft_transform(ent: Entity) -> Tuple[Optional[float], ...]:
    lon, lat = ent.lonlat
    return (lon, lat, ent.alt, ent.bank, ent.pitch, ent.hdg)


def _aircraft_numeric(ent: Entity) -> Dict[str, float]:
    n: Dict[str, float] = {
        "IAS": ent.ias,
        "TAS": ent.tas,
        "Mach": ent.mach,
        "AOA": ent.aoa,
        "AGL": ent.agl,
        "HDG": ent.hdg,
        "Throttle": ent.throttle,
        "Afterburner": ent.afterburner,
        "LandingGear": ent.gear,
        "Flaps": ent.flaps,
        "AirBrakes": ent.airbrakes,
        "FuelWeight": ent.fuel,
        "VerticalGForce": 1.0 / max(0.15, math.cos(math.radians(ent.bank))),
        "Health": ent.health,
    }
    n.update(ent.extra)
    return n


@dataclass
class Missile:
    obj_id: str
    name: str
    type_tags: str
    parent: str
    target: Entity
    coalition: str
    color: str
    east: float
    north: float
    alt: float
    hdg: float
    tas: float
    launched_at: float
    lifetime: float
    hits: bool
    alive: bool = True
    ended: bool = False
    guided: bool = True
    closest: float = float("inf")

    def step(self, dt: float) -> None:
        if not self.alive:
            return
        if not self.guided:
            rad = math.radians(self.hdg)
            self.tas = max(250.0, self.tas - 25.0 * dt)
            self.east += math.sin(rad) * self.tas * dt
            self.north += math.cos(rad) * self.tas * dt
            self.alt = max(0.0, self.alt - 40.0 * dt)
            self.closest = min(self.closest, self.range_to_target())
            return
        tgt_brg = math.degrees(math.atan2(self.target.east - self.east, self.target.north - self.north)) % 360.0
        err = geo.wrap180(tgt_brg - self.hdg)
        # Proportional navigation, loosely.
        self.hdg = geo.wrap360(self.hdg + max(-18.0, min(18.0, err * 3.0)) * dt)
        self.tas = min(1100.0, self.tas + 260.0 * dt) if self.tas < 900 else max(320.0, self.tas - 18.0 * dt)
        rad = math.radians(self.hdg)
        self.east += math.sin(rad) * self.tas * dt
        self.north += math.cos(rad) * self.tas * dt
        d_alt = self.target.alt - self.alt
        self.alt += max(-260.0 * dt, min(260.0 * dt, d_alt * 0.6 * dt * 4))
        self.closest = min(self.closest, self.range_to_target())

    def fuze_radius(self, dt: float) -> float:
        """Proximity fuze radius, widened by the distance flown in one step."""
        return 30.0 + self.tas * dt
    @property
    def lonlat(self) -> Tuple[float, float]:
        return geo.to_lonlat(self.east, self.north, FIELD_LON, FIELD_LAT)

    def range_to_target(self) -> float:
        return math.dist(
            (self.east, self.north, self.alt),
            (self.target.east, self.target.north, self.target.alt),
        )


def _steer_to(ent: Entity, east: float, north: float) -> float:
    """Point *ent* at a local-frame point; returns the range to it."""
    de = east - ent.east
    dn = north - ent.north
    ent.cmd_hdg = math.degrees(math.atan2(de, dn)) % 360.0
    return math.hypot(de, dn)


def _runway_frame(ent: Entity) -> Tuple[float, float]:
    """(along, cross) metres relative to the RWY 13 threshold.

    *along* is negative before the threshold; *cross* is positive right of
    the approach course.
    """
    h = math.radians(RWY_HDG)
    along = ent.east * math.sin(h) + ent.north * math.cos(h)
    cross = ent.east * math.cos(h) - ent.north * math.sin(h)
    return along, cross


def _round_pos(rnd: Dict, t: float) -> Tuple[float, float, float]:
    """Ballistic position of a gun round at time *t* (no drag, gravity only)."""
    tau = max(0.0, min(t - rnd["fired"], rnd["flight"]))
    (e0, n0, a0), (ve, vn, va) = rnd["p0"], rnd["v"]
    return e0 + ve * tau, n0 + vn * tau, a0 + va * tau - 0.5 * G * tau * tau


def _scan(t: float, half_width: float = 60.0, rate: float = 60.0) -> float:
    """Triangle-wave antenna sweep, degrees relative to the nose."""
    period = 4.0 * half_width / rate
    frac = (t / period) % 1.0
    return half_width * (1.0 - 4.0 * abs(frac - 0.5))


def _point_radar(ent: "Entity", target: "Entity", extra: Dict[str, float]) -> None:
    """Antenna on a locked target: azimuth/elevation relative to the airframe."""
    brg = math.degrees(math.atan2(target.east - ent.east, target.north - ent.north))
    ground = math.hypot(target.east - ent.east, target.north - ent.north)
    el = math.degrees(math.atan2(target.alt - ent.alt, max(ground, 1.0)))
    extra["RadarAzimuth"] = geo.wrap180(brg - ent.hdg)
    extra["RadarElevation"] = el - ent.pitch
    extra["LockedTargetAzimuth"] = extra["RadarAzimuth"]
    extra["LockedTargetElevation"] = extra["RadarElevation"]
    extra["LockedTargetRange"] = math.dist((ent.east, ent.north, ent.alt), (target.east, target.north, target.alt))


def _range3d(a: Entity, b: Entity) -> float:
    return math.dist((a.east, a.north, a.alt), (b.east, b.north, b.alt))


def build_sample(duration: float = 1200.0, log: Optional[List[str]] = None) -> List[str]:
    """Simulate one sortie and return the ACMI lines."""
    em = Emitter(FIELD_LON, FIELD_LAT)
    em.raw("FileType=text/acmi/tacview")
    em.raw("FileVersion=2.2")
    em.raw("0,DataSource=DCS World 2.9 (synthetic)")
    em.raw("0,DataRecorder=dcs-sa samplegen")
    em.raw("0,ReferenceTime=2026-09-25T09:00:00Z")
    em.raw("0,RecordingTime=2026-09-25T09:00:00Z")
    em.raw("0,Author=dcs-sa")
    em.raw("0,Title=Batumi CAP and strike - sample sortie")
    em.raw("0,Category=Offensive counter air")
    em.raw("0,Briefing=Launch from Batumi\\, sweep north-east\\, then recover on RWY 13.")
    em.raw(f"0,ReferenceLongitude={FIELD_LON}")
    em.raw(f"0,ReferenceLatitude={FIELD_LAT}")
    em.raw("0,MapId=Caucasus")

    # --- cast -------------------------------------------------------------
    player = Entity(
        obj_id="101", name="F-16C_50", type_tags="Air+FixedWing",
        coalition="Allies", color="Blue", pilot="Ethan", group="Viper",
        country="us", cmd_tas=0.0,
    )
    wing = Entity(
        obj_id="102", name="F-16C_50", type_tags="Air+FixedWing",
        coalition="Allies", color="Blue", pilot="Viper 1-2", group="Viper",
        country="us",
    )
    bandit = Entity(
        obj_id="201", name="MiG-29S", type_tags="Air+FixedWing",
        coalition="Enemies", color="Red", pilot="Ivanov", group="Fulcrum",
        country="ru", east=58000.0, north=66000.0, alt=7200.0,
        hdg=222.0, tas=290.0, cmd_hdg=222.0, cmd_tas=290.0, cmd_alt=7200.0,
        on_ground=False, fuel=3000.0,
    )

    statics: List[Tuple[str, str, str, str, str, float, float, float, Dict[str, float]]] = [
        ("301", "BTR-80", "Ground+Armor+Vehicle", "Enemies", "Red", 15000.0, 20000.0, 240.0, {}),
        ("302", "BTR-80", "Ground+Armor+Vehicle", "Enemies", "Red", 15180.0, 20110.0, 240.0, {}),
        ("303", "Ural-375", "Ground+Vehicle", "Enemies", "Red", 15360.0, 20220.0, 240.0, {}),
        ("304", "SA-11 Buk SR 9S18M1", "Ground+AntiAircraft", "Enemies", "Red", 9000.0, 14000.0, 320.0,
         {"RadarMode": 1.0, "RadarRange": 90000.0,
          "RadarHorizontalBeamwidth": 360.0, "RadarVerticalBeamwidth": 30.0, "RadarElevation": 15.0}),
        ("401", "CVN-75", "Sea+Watercraft+AircraftCarrier", "Allies", "Blue", -30000.0, 9000.0, 0.0, {}),
        ("501", "Bullseye", "Navaid+Static+Bullseye", "Allies", "Blue", 20000.0, 30000.0, 0.0, {}),
    ]
    for oid, name, tags, coalition, color, e, n, a, extra in statics:
        lon, lat = geo.to_lonlat(e, n, FIELD_LON, FIELD_LAT)
        em.update(
            oid, (lon, lat, a, 0.0, 0.0, 0.0), dict(extra),
            {"Name": name, "Type": tags, "Coalition": coalition, "Color": color,
             "Country": "ru" if coalition == "Enemies" else "us"},
        )
    carrier_e, carrier_n = -30000.0, 9000.0

    missiles: List[Missile] = []
    shells: List[Dict] = []
    # Dynamic objects (weapons, rounds) get ids well clear of the fixed cast.
    next_obj = [0x2000]

    def new_id() -> str:
        next_obj[0] += 1
        return f"{next_obj[0]:X}"

    state = "PARKED"
    state_t = 0.0
    fired_amraam = False
    bandit_fired = False
    gun_bursts = 0          # bursts completed
    burst_start = None      # time the current burst began
    last_burst_end = -99.0
    rounds_fired = 0
    round_accum = 0.0
    landed = False
    if log is None:
        log = []

    faf_lon, faf_lat = geo.destination(FIELD_LON, FIELD_LAT, (RWY_HDG + 180.0) % 360.0, 14000.0)
    faf_e, faf_n = geo.to_local(faf_lon, faf_lat, FIELD_LON, FIELD_LAT)

    t = 0.0
    while t <= duration:
        em.frame(t)

        # ---- player state machine ---------------------------------------
        rng_bandit = _range3d(player, bandit) if bandit.alive else float("inf")

        if state == "PARKED":
            player.cmd_tas = 0.0
            player.flaps = 0.3
            player.gear = 1.0
            if t >= 8.0:
                state, state_t = "TAKEOFF_ROLL", t
                em.event("Message", [player.obj_id], "Viper 1-1 rolling RWY 13")

        elif state == "TAKEOFF_ROLL":
            player.cmd_tas = 110.0
            player.cmd_alt = FIELD_ELEV
            player.cmd_hdg = RWY_HDG
            if player.tas > 82.0:
                player.on_ground = False
                player.cmd_alt = 3000.0
                state, state_t = "CLIMBOUT", t
                em.event("TakenOff", [player.obj_id], "Batumi")
                log.append(f"t={t:.1f} takeoff")

        elif state == "CLIMBOUT":
            player.cmd_alt = 7600.0
            player.cmd_tas = 300.0
            player.gear = max(0.0, 1.0 - (t - state_t) / 6.0)
            player.flaps = max(0.0, 0.3 - (t - state_t) / 20.0)
            if t - state_t > 12.0:
                player.cmd_hdg = 45.0
            if player.alt > 3000.0:
                state, state_t = "TRANSIT", t

        elif state == "TRANSIT":
            player.cmd_alt = 7600.0
            player.cmd_tas = 330.0
            player.extra["RadarMode"] = 1.0
            player.extra["RadarRange"] = 74000.0
            if bandit.alive:
                _steer_to(player, bandit.east, bandit.north)
            if rng_bandit < 55000.0:
                player.extra["RadarMode"] = 1.0
                player.extra["RadarRange"] = 74000.0
                player.extra["LockedTargetMode"] = 1.0
                player.text_extra["LockedTarget"] = bandit.obj_id
            if rng_bandit < 40000.0 and not fired_amraam:
                fired_amraam = True
                mid = new_id()
                missiles.append(Missile(
                    obj_id=mid, name="AIM_120C", type_tags="Weapon+Missile",
                    parent=player.obj_id, target=bandit, coalition="Allies", color="Blue",
                    east=player.east, north=player.north, alt=player.alt,
                    hdg=player.hdg, tas=player.tas + 60.0, launched_at=t,
                    lifetime=95.0, hits=True,
                ))
                em.event("Message", [player.obj_id], "Fox 3, MiG-29, 21 miles")
                em.event("Bookmark", [], "AIM-120C launch")
                log.append(f"t={t:.1f} AMRAAM launch at {rng_bandit/1852:.1f} nm")
                state, state_t = "SUPPORT", t

        elif state == "SUPPORT":
            player.cmd_alt = 7600.0
            player.cmd_tas = 340.0
            if bandit.alive:
                _steer_to(player, bandit.east, bandit.north)
            if bandit_fired:
                state, state_t = "DEFEND", t
                em.event("Message", [player.obj_id], "Viper 1-1 defending")
            elif not bandit.alive:
                state, state_t = "EGRESS", t

        elif state == "DEFEND":
            # Notch: put the threat on the beam and descend.
            brg = math.degrees(math.atan2(bandit.east - player.east, bandit.north - player.north)) % 360.0
            player.cmd_hdg = geo.wrap360(brg + 95.0)
            player.cmd_alt = 4200.0
            player.cmd_tas = 360.0
            # Lock broken while defending.  ACMI clears a lock by zeroing the
            # mode; the LockedTarget id itself is left stale.
            player.extra["LockedTargetMode"] = 0.0
            if t - state_t > 7.0:
                for m in missiles:
                    if m.parent == bandit.obj_id and m.guided:
                        m.guided = False
                        log.append(f"t={t:.1f} {m.name} guidance lost (notch)")
            if t - state_t > 45.0:
                state, state_t = "EGRESS", t

        elif state == "EGRESS":
            player.extra["RadarMode"] = 1.0
            rng = _steer_to(player, 15000.0, 20000.0)
            player.cmd_alt = 1200.0
            player.cmd_tas = 250.0
            if rng < 9000.0:
                state, state_t = "STRAFE", t

        elif state == "STRAFE":
            rng = _steer_to(player, 15000.0, 20000.0)
            player.cmd_alt = 700.0
            player.cmd_tas = 200.0
            # Two ~1 s bursts from the M61 at its real 100 rds/s.  Written the way
            # DCS's Tacview exporter writes rounds: one object per round,
            # Type=Projectile+Shell, Name=weapons.shells.<ammo>, no Parent,
            # sampled at ~2 Hz after the spawn frame, no TriggerPressed.
            firing = False
            if burst_start is not None:
                if t - burst_start < 1.0:
                    firing = True
                else:
                    burst_start, last_burst_end = None, t
                    gun_bursts += 1
            elif 1200.0 < rng < 3400.0 and gun_bursts < 2 and t - last_burst_end > 1.25:
                burst_start, firing = t, True
            if firing:
                round_accum += 100.0 * DT
                n_rounds = int(round_accum)
                round_accum -= n_rounds
                tgt_e, tgt_n, tgt_a = 15000.0, 20000.0, 240.0
                walk = min(1.0, (t - burst_start) / 0.75)
                vel_e = math.sin(math.radians(player.hdg)) * player.tas
                vel_n = math.cos(math.radians(player.hdg)) * player.tas
                for k in range(n_rounds):
                    rounds_fired += 1
                    sid = new_id()
                    # Fired k*10 ms ago, so already k*10 ms down range when the
                    # recorder first sees it - how a 4 Hz sampler observes a
                    # 100 rds/s stream.
                    age = k * 0.01
                    fire_e, fire_n = player.east - vel_e * age, player.north - vel_n * age
                    fire_a = player.alt - player.vs * age
                    # Dispersion ~5 mil, deterministic; burst 1 walks onto the
                    # target from short, burst 2 is centred.
                    rng_now = math.dist((fire_e, fire_n, fire_a), (tgt_e, tgt_n, tgt_a))
                    spread = 0.005 * rng_now
                    de = math.sin(rounds_fired * 12.9898) * spread
                    dn = math.sin(rounds_fired * 78.233) * spread
                    short = (1.0 - walk) * 60.0 if gun_bursts == 0 else 0.0
                    ux, uy = (tgt_e - fire_e) / rng_now, (tgt_n - fire_n) / rng_now
                    aim = (tgt_e + de - ux * short, tgt_n + dn - uy * short, tgt_a)
                    flight = rng_now / 1000.0
                    # Ballistic: p(tau) = p0 + v*tau + 0.5*g*tau^2, v chosen to hit the aim point.
                    rnd = {
                        "id": sid, "fired": t - age, "flight": flight,
                        "p0": (fire_e, fire_n, fire_a),
                        "v": ((aim[0] - fire_e) / flight, (aim[1] - fire_n) / flight,
                              (aim[2] - fire_a) / flight + 0.5 * G * flight),
                        "kills": gun_bursts == 1 and k == 0 and not any(r.get("kills") for r in shells),
                    }
                    rnd["born"] = t
                    shells.append(rnd)
                    text = {"Name": "weapons.shells.M61_20_HE", "Type": "Projectile+Shell",
                            "Coalition": "Allies", "Color": "Blue", "Country": "us"}
                    pe, pn, pa = _round_pos(rnd, t)
                    lon, lat = geo.to_lonlat(pe, pn, FIELD_LON, FIELD_LAT)
                    em.update(sid, (lon, lat, pa, None, None, None), {}, text)
            if rng < 1100.0 or t - state_t > 70.0:
                state, state_t = "RTB", t

        elif state == "RTB":
            rng = _steer_to(player, faf_e, faf_n)
            player.cmd_alt = 1500.0
            player.cmd_tas = 220.0
            if rng < 3000.0:
                state, state_t = "APPROACH", t
                em.event("Message", [player.obj_id], "Viper 1-1 on the approach RWY 13")

        elif state == "APPROACH":
            along, cross = _runway_frame(player)
            # Intercept and track the extended centreline.
            player.cmd_hdg = geo.wrap360(RWY_HDG - max(-35.0, min(35.0, cross * 0.03)))
            player.gear = min(1.0, (t - state_t) / 6.0)
            player.flaps = min(1.0, (t - state_t) / 8.0)
            player.cmd_tas = 80.0
            # Aim point ~300 m past the threshold, like a real approach.
            dist_aim = max(0.0, 300.0 - along)
            gs_alt = FIELD_ELEV + math.tan(math.radians(3.0)) * dist_aim
            # The autopilot tracks altitude with vs = 0.25 * error, so lead the
            # command by the steady-state descent rate to sit on the slope.
            player.cmd_alt = gs_alt - 4.0 * player.tas * math.sin(math.radians(3.0))
            player.extra["GlideslopeVerticalDeviation"] = player.alt - gs_alt
            player.extra["LocalizerLateralDeviation"] = cross
            if player.agl < 18.0:
                player.max_vs = 2.2
                state, state_t = "FLARE", t

        elif state == "FLARE":
            _, cross = _runway_frame(player)
            player.cmd_hdg = geo.wrap360(RWY_HDG - max(-10.0, min(10.0, cross * 0.03)))
            # Aim a few metres below the runway so the jet arrives with a
            # realistic ~1.5 m/s sink rather than floating onto it.
            player.cmd_alt = FIELD_ELEV - 6.0
            player.cmd_tas = 72.0
            player.max_vs = 2.2
            if player.alt <= FIELD_ELEV + 0.3:
                player.on_ground = True
                landed = True
                em.event("Landed", [player.obj_id], "Batumi")
                log.append(f"t={t:.1f} touchdown ias={player.ias:.0f} vs={player.vs:.2f}")
                state, state_t = "ROLLOUT", t

        elif state == "ROLLOUT":
            player.cmd_hdg = RWY_HDG
            player.cmd_alt = FIELD_ELEV
            player.cmd_tas = 0.0
            player.max_accel = 5.0
            player.airbrakes = 1.0
            player.extra.pop("GlideslopeVerticalDeviation", None)
            player.extra.pop("LocalizerLateralDeviation", None)
            if player.tas < 1.0:
                state, state_t = "SHUTDOWN", t

        # ---- bandit ------------------------------------------------------
        if bandit.alive:
            if rng_bandit < 70000.0:
                bandit.extra["RadarMode"] = 1.0
                bandit.extra["RadarRange"] = 80000.0
            if rng_bandit < 33000.0 and not bandit_fired:
                bandit_fired = True
                mid = new_id()
                missiles.append(Missile(
                    obj_id=mid, name="R-27ER", type_tags="Weapon+Missile",
                    parent=bandit.obj_id, target=player, coalition="Enemies", color="Red",
                    east=bandit.east, north=bandit.north, alt=bandit.alt,
                    hdg=bandit.hdg, tas=bandit.tas + 60.0, launched_at=t,
                    lifetime=48.0, hits=False,
                ))
                bandit.extra["LockedTargetMode"] = 1.0
                bandit.text_extra["LockedTarget"] = player.obj_id
                log.append(f"t={t:.1f} R-27 launch at {rng_bandit/1852:.1f} nm")
            _steer_to(bandit, player.east, player.north)
            bandit.cmd_tas = 330.0
            bandit.cmd_alt = 7000.0

        # ---- radar: ACMI semantics - the "beamwidths" are the size of the
        # volume Tacview draws, centred on RadarAzimuth/RadarElevation (both
        # relative to the airframe).  Search = the scan volume; single-target
        # track = a narrow cone on the target.
        for ent, tgt, half_az in ((player, bandit, 60.0), (bandit, player, 30.0)):
            if ent.extra.get("RadarMode", 0.0) <= 0 or not ent.alive:
                continue
            if ent.extra.get("LockedTargetMode", 0.0) > 0 and tgt.alive:
                _point_radar(ent, tgt, ent.extra)
                ent.extra["RadarHorizontalBeamwidth"] = 3.3
                ent.extra["RadarVerticalBeamwidth"] = 3.3
            else:
                ent.extra["RadarAzimuth"] = 0.0
                ent.extra["RadarElevation"] = -ent.pitch  # level scan centre
                ent.extra["RadarHorizontalBeamwidth"] = 2 * half_az
                ent.extra["RadarVerticalBeamwidth"] = 10.0
                for k in ("LockedTargetAzimuth", "LockedTargetElevation", "LockedTargetRange"):
                    ent.extra.pop(k, None)

        # ---- wingman: formation takeoff/landing, 250 m line abreast up high --
        blend = min(1.0, player.agl / 300.0)
        off = math.radians(player.hdg + 90.0)
        spacing = 15.0 + 235.0 * blend
        wing.east = player.east + math.sin(off) * spacing
        wing.north = player.north + math.cos(off) * spacing
        wing.alt = player.alt + 60.0 * blend
        wing.hdg, wing.bank, wing.pitch = player.hdg, player.bank * 0.9, player.pitch
        wing.tas, wing.aoa = player.tas, player.aoa
        wing.gear, wing.flaps = player.gear, player.flaps
        wing.on_ground = player.on_ground
        wing.fuel = max(0.0, wing.fuel - 0.4 * DT)
        wing.vs = player.vs

        # ---- integrate ---------------------------------------------------
        player.step(DT)
        if bandit.alive:
            bandit.step(DT)

        for m in missiles:
            if not m.alive:
                continue
            m.step(DT)
            if m.hits and m.range_to_target() < m.fuze_radius(DT):
                m.alive = False
                bandit.alive = False
                bandit.health = 0.0
                lon, lat = bandit.lonlat
                em.update(bandit.obj_id, (lon, lat, bandit.alt, None, None, None), {"Health": 0.0}, {})
                em.event("Destroyed", [bandit.obj_id], "")
                em.event("Message", [player.obj_id], "Splash one MiG-29")
                em.remove(m.obj_id)
                em.remove(bandit.obj_id)
                log.append(f"t={t:.1f} AMRAAM hit, TOF {t - m.launched_at:.1f}s")
            elif t - m.launched_at > m.lifetime:
                m.alive = False
                em.event("Timeout", [m.obj_id], "")
                em.remove(m.obj_id)
                log.append(f"t={t:.1f} {m.name} timeout, closest approach "
                           f"{m.closest:.0f} m")

        # ---- emit ---------------------------------------------------------
        for ent in (player, wing):
            text = {"Name": ent.name, "Type": ent.type_tags, "Pilot": ent.pilot or "",
                    "Group": ent.group or "", "Coalition": ent.coalition,
                    "Color": ent.color, "Country": ent.country}
            text.update(ent.text_extra)
            em.update(ent.obj_id, _aircraft_transform(ent), _aircraft_numeric(ent), text)
        if bandit.alive:
            text = {"Name": bandit.name, "Type": bandit.type_tags, "Pilot": bandit.pilot or "",
                    "Group": bandit.group or "", "Coalition": bandit.coalition,
                    "Color": bandit.color, "Country": bandit.country}
            text.update(bandit.text_extra)
            em.update(bandit.obj_id, _aircraft_transform(bandit), _aircraft_numeric(bandit), text)

        for m in missiles:
            if not m.alive:
                continue
            lon, lat = m.lonlat
            em.update(m.obj_id, (lon, lat, m.alt, 0.0, 0.0, m.hdg), {},
                      {"Name": m.name, "Type": m.type_tags, "Parent": m.parent,
                       "Coalition": m.coalition, "Color": m.color})

        for sh in list(shells):
            if sh.get("seen") != t and t - sh["fired"] >= sh["flight"]:
                # Impact: one last sample on the ground, then the round is gone.
                pe, pn, pa = _round_pos(sh, sh["fired"] + sh["flight"])
                lon, lat = geo.to_lonlat(pe, pn, FIELD_LON, FIELD_LAT)
                em.update(sh["id"], (lon, lat, pa, None, None, None), {}, {})
                em.remove(sh["id"])
                shells.remove(sh)
                if sh["kills"]:
                    em.event("Destroyed", ["301"], "")
                    em.event("Message", [player.obj_id], "Splash one BTR")
                    em.update("301", (None, None, None, None, None, None), {"Health": 0.0}, {})
                    log.append(f"t={t:.1f} strafe kill 301")
                continue
            if sh.get("seen") is None:
                sh["seen"] = t  # emitted at spawn this frame
                continue
            if round((t - sh["born"]) / DT) % 2:
                continue  # rounds are sampled at ~2 Hz after spawning
            pe, pn, pa = _round_pos(sh, t)
            lon, lat = geo.to_lonlat(pe, pn, FIELD_LON, FIELD_LAT)
            em.update(sh["id"], (lon, lat, pa, None, None, None), {}, {})

        # Carrier steams west at 12 m/s.
        carrier_e -= 12.0 * DT
        if int(t * 4) % 8 == 0:
            lon, lat = geo.to_lonlat(carrier_e, carrier_n, FIELD_LON, FIELD_LAT)
            em.update("401", (lon, lat, 0.0, 0.0, 0.0, 270.0), {}, {})

        t = round(t + DT, 3)
        if state == "SHUTDOWN" and landed and t > 30.0:
            em.frame(t)
            em.event("Message", [player.obj_id], "Viper 1-1 clear of the active")
            break

    return em.lines


def write_sample(path: str, duration: float = 1200.0) -> str:
    lines = build_sample(duration)
    os.makedirs(os.path.dirname(os.path.abspath(path)) or ".", exist_ok=True)
    with open(path, "w", encoding="utf-8", newline="\n") as fh:
        fh.write("\n".join(lines))
        fh.write("\n")
    return path
