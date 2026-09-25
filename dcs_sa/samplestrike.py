"""Synthetic strike sortie: JSOWs, a GBU-12 and a Mk-82 dive attack.

A second demo recording, for the ground-attack side of the app: an F-16C
releases an AGM-154C at an SA-11 search radar and two AGM-154As at a
vehicle column from high altitude, cranks away while the JSOWs glide in, then
comes back for a GBU-12 on an armoured vehicle and a Mk-82 dive pass on a
truck.  An SA-11 launcher takes a shot at it on the way in.

Written the way DCS's Tacview exporter writes weapons: one object per weapon
and per bomblet, no Parent, weapons deleted on impact without an impact
sample, Event=Destroyed for the units that die.
"""

from __future__ import annotations

import math
import os
from dataclasses import dataclass
from typing import Dict, List, Optional, Tuple

from .analysis import geo
from .samplegen import (FIELD_LAT, FIELD_LON, G, Emitter, Entity, _aircraft_numeric, _aircraft_transform,
                        _steer_to)

DT = 0.25
GROUND = 150.0  # m MSL, target area
DIVE_START = 5800.0  # m from the truck: roll in for the Mk-82 dive

#: DCS type names and Tacview type tags for the weapons in this sortie.
WEAPONS = {
    "jsow_a": ("AGM_154A", "Weapon+Bomb"),
    "jsow_c": ("AGM_154", "Weapon+Bomb"),
    "blu97": ("BLU-97/B", "Weapon+Bomb"),
    "gbu12": ("GBU_12", "Weapon+Bomb"),
    "mk82": ("Mk_82", "Weapon+Bomb"),
    "sa11": ("SA9M38M1", "Weapon+Missile"),
}

# Targets (east, north metres from Batumi's runway threshold).
COLUMN = [("601", "BTR-80", "Ground+Armor+Vehicle"), ("602", "BTR-80", "Ground+Armor+Vehicle"),
          ("603", "Ural-375", "Ground+Vehicle"), ("604", "ZSU-23-4 Shilka", "Ground+AntiAircraft")]
COLUMN_HEAD = (38000.0, 26000.0)
COLUMN_HDG = 250.0          # moving west-south-west along a road
COLUMN_SPEED = 4.0          # m/s
SA11_SR = ("611", "SA-11 Buk SR 9S18M1", "Ground+AntiAircraft", (44000.0, 31000.0))
SA11_LN = [("612", "SA-11 Buk LN 9A310M1", "Ground+AntiAircraft", (44520.0, 30320.0)),
           ("613", "SA-11 Buk LN 9A310M1", "Ground+AntiAircraft", (44630.0, 30370.0))]
GBU_TGT = ("621", "BMP-2", "Ground+Armor+Vehicle", (33000.0, 21500.0))
MK82_TGT = ("622", "Ural-375", "Ground+Vehicle", (33400.0, 21200.0))


@dataclass
class Glider:
    """A JSOW: glides to its aim point, then dispenses (A) or dives in (C)."""
    obj_id: str
    kind: str                      # "jsow_a" | "jsow_c"
    e: float
    n: float
    alt: float
    v: float
    hdg: float
    aim: Tuple[float, float]
    target: Optional[str]
    alive: bool = True
    pitch: float = 0.0
    born: float = 0.0

    def step(self, dt: float) -> None:
        de, dn = self.aim[0] - self.e, self.aim[1] - self.n
        dist = math.hypot(de, dn)
        want = math.degrees(math.atan2(de, dn)) % 360.0
        err = geo.wrap180(want - self.hdg)
        self.hdg = (self.hdg + max(-4.0 * dt, min(4.0 * dt, err))) % 360.0
        # Glide: a shallow descent, steepening near the target.  The A model
        # heads for a point 500 m above the target (DCS's default burst
        # height) and opens short of it; the C model dives onto the target.
        floor = GROUND + (500.0 if self.kind == "jsow_a" else 0.0)
        if self.kind == "jsow_c" and dist < 2500.0:
            gamma = math.atan2(self.alt - GROUND, max(dist, 1.0))
        else:
            gamma = max(math.radians(3.0), math.atan2(max(self.alt - floor, 0.0), max(dist, 1.0)) * 0.9)
            if self.alt <= floor + 5.0:
                gamma = 0.0
        # Speed: settles near 210 m/s in the glide, gains in the terminal dive.
        self.v += (G * math.sin(gamma) - 0.012 * (self.v - 150.0) * (self.v / 200.0)) * dt
        step = self.v * dt
        self.e += math.sin(math.radians(self.hdg)) * step * math.cos(gamma)
        self.n += math.cos(math.radians(self.hdg)) * step * math.cos(gamma)
        self.alt -= step * math.sin(gamma)
        self.pitch = -math.degrees(gamma)


@dataclass
class Ballistic:
    """A bomb or bomblet: drag + gravity, optionally steered (GBU-12)."""
    obj_id: str
    kind: str
    e: float
    n: float
    alt: float
    ve: float
    vn: float
    vz: float
    drag: float                    # 1/s, velocity decay towards terminal
    target: Optional[Tuple[float, float]] = None   # laser spot for a GBU-12
    alive: bool = True
    born: float = 0.0
    sample_every: float = DT
    prev: Tuple[float, float, float] = (0.0, 0.0, 0.0)

    def ground_hit(self) -> Tuple[float, float]:
        """Where the last step crossed the ground."""
        pe, pn, pa = self.prev
        f = (pa - GROUND) / max(pa - self.alt, 1e-6)
        return pe + (self.e - pe) * f, pn + (self.n - pn) * f

    def step(self, dt: float) -> None:
        self.prev = (self.e, self.n, self.alt)
        if self.target is not None:
            # Laser guidance: turn the velocity vector toward the spot,
            # gently at first, firmly in the last seconds.
            de, dn, dz = self.target[0] - self.e, self.target[1] - self.n, GROUND - self.alt
            d = math.sqrt(de * de + dn * dn + dz * dz)
            v = math.sqrt(self.ve ** 2 + self.vn ** 2 + self.vz ** 2)
            tgo = d / max(v, 1.0)
            k = min(1.0, (0.4 if tgo > 8 else 4.0) * dt)
            if d > 1.0:
                self.ve += (v * de / d - self.ve) * k
                self.vn += (v * dn / d - self.vn) * k
                self.vz += (v * dz / d - self.vz) * k
        self.ve -= self.ve * self.drag * dt
        self.vn -= self.vn * self.drag * dt
        self.vz += (-G - self.vz * self.drag) * dt
        self.e += self.ve * dt
        self.n += self.vn * dt
        self.alt += self.vz * dt


def build_strike_sample(duration: float = 540.0) -> List[str]:
    em = Emitter(FIELD_LON, FIELD_LAT)
    for line in ("FileType=text/acmi/tacview", "FileVersion=2.2", "0,DataSource=DCS World 2.9 (synthetic)",
                 "0,DataRecorder=dcs-sa samplestrike", "0,ReferenceTime=2026-09-25T10:00:00Z",
                 "0,RecordingTime=2026-09-25T10:00:00Z", "0,Author=dcs-sa",
                 "0,Title=JSOW strike - sample sortie", "0,Category=Strike",
                 "0,Briefing=AGM-154C on the SA-11 search radar\\, AGM-154As on the column\\, then GBU-12 and Mk-82 on the stragglers.",
                 f"0,ReferenceLongitude={FIELD_LON}", f"0,ReferenceLatitude={FIELD_LAT}", "0,MapId=Caucasus"):
        em.raw(line)

    player = Entity(obj_id="101", name="F-16C_50", type_tags="Air+FixedWing", coalition="Allies", color="Blue",
                    pilot="Ethan", group="Viper", country="us", east=-6000.0, north=-9000.0, alt=7620.0,
                    hdg=52.0, tas=245.0, cmd_hdg=52.0, cmd_tas=245.0, cmd_alt=7620.0, on_ground=False,
                    fuel=3000.0, gear=0.0)
    player.max_vs = 60.0

    ground: Dict[str, Dict] = {}

    def place(oid: str, name: str, tags: str, e: float, n: float, extra: Optional[Dict] = None, hdg: float = 0.0):
        ground[oid] = {"name": name, "tags": tags, "e": e, "n": n, "hdg": hdg, "alive": True, "extra": extra or {}}
        lon, lat = geo.to_lonlat(e, n, FIELD_LON, FIELD_LAT)
        em.update(oid, (lon, lat, GROUND, 0.0, 0.0, hdg), dict(extra or {}),
                  {"Name": name, "Type": tags, "Coalition": "Enemies", "Color": "Red", "Country": "ru"})

    for i, (oid, name, tags) in enumerate(COLUMN):
        back = 60.0 * i
        e = COLUMN_HEAD[0] - math.sin(math.radians(COLUMN_HDG)) * back
        n = COLUMN_HEAD[1] - math.cos(math.radians(COLUMN_HDG)) * back
        place(oid, name, tags, e, n, hdg=COLUMN_HDG)
    place(SA11_SR[0], SA11_SR[1], SA11_SR[2], *SA11_SR[3],
          extra={"RadarMode": 1.0, "RadarRange": 90000.0, "RadarHorizontalBeamwidth": 360.0,
                 "RadarVerticalBeamwidth": 30.0, "RadarElevation": 15.0})
    for oid, name, tags, (e, n) in SA11_LN:
        place(oid, name, tags, e, n)
    place(GBU_TGT[0], GBU_TGT[1], GBU_TGT[2], *GBU_TGT[3])
    place(MK82_TGT[0], MK82_TGT[1], MK82_TGT[2], *MK82_TGT[3])
    bull_lon, bull_lat = geo.to_lonlat(20000.0, 30000.0, FIELD_LON, FIELD_LAT)
    em.update("501", (bull_lon, bull_lat, 0.0, 0.0, 0.0, 0.0), {},
              {"Name": "Bullseye", "Type": "Navaid+Static+Bullseye", "Coalition": "Allies", "Color": "Blue"})

    next_obj = [0x3000]

    def new_id() -> str:
        next_obj[0] += 1
        return f"{next_obj[0]:X}"

    gliders: List[Glider] = []
    bombs: List[Ballistic] = []
    sam: Optional[Dict] = None
    kills_pending: List[Tuple[float, str]] = []   # (time, unit id)
    state, state_t = "INBOUND", 0.0
    released = set()
    a1_t = 0.0
    t = 0.0

    def unit_pos(oid: str) -> Tuple[float, float]:
        u = ground[oid]
        return u["e"], u["n"]

    def emit_weapon(oid: str, kind: str, e: float, n: float, alt: float, hdg: float, pitch: float = 0.0,
                    first: bool = False) -> None:
        lon, lat = geo.to_lonlat(e, n, FIELD_LON, FIELD_LAT)
        name, tags = WEAPONS[kind]
        em.update(oid, (lon, lat, alt, 0.0, pitch, hdg), {},
                  {"Name": name, "Type": tags, "Coalition": "Allies", "Color": "Blue", "Country": "us"} if first else {})

    def release_jsow(kind: str, target_oid: str, aim_offset: Tuple[float, float] = (0.0, 0.0)) -> None:
        oid = new_id()
        te, tn = unit_pos(target_oid)
        g = Glider(oid, kind, player.east, player.north, player.alt - 3.0, player.tas, player.hdg,
                   (te + aim_offset[0], tn + aim_offset[1]), target_oid, born=t)
        gliders.append(g)
        emit_weapon(oid, kind, g.e, g.n, g.alt, g.hdg, first=True)
        em.event("Message", [player.obj_id], f"Viper 1-1 {'JSOW-C' if kind == 'jsow_c' else 'JSOW-A'} away")

    while t <= duration:
        em.frame(t)

        # --- the column drives on until it is hit ------------------------------
        for oid, _n, _t in COLUMN:
            u = ground[oid]
            if u["alive"]:
                u["e"] += math.sin(math.radians(COLUMN_HDG)) * COLUMN_SPEED * DT
                u["n"] += math.cos(math.radians(COLUMN_HDG)) * COLUMN_SPEED * DT
                if int(round(t / DT)) % 8 == 0:
                    lon, lat = geo.to_lonlat(u["e"], u["n"], FIELD_LON, FIELD_LAT)
                    em.update(oid, (lon, lat, GROUND, 0.0, 0.0, COLUMN_HDG), {}, {})

        # --- the F-16 ------------------------------------------------------------------
        col_e, col_n = unit_pos("601")
        if state == "INBOUND":
            _steer_to(player, (col_e + ground["611"]["e"]) / 2, (col_n + ground["611"]["n"]) / 2)
            sr_rng = math.hypot(ground["611"]["e"] - player.east, ground["611"]["n"] - player.north)
            col_rng = math.hypot(col_e - player.east, col_n - player.north)
            if "c" not in released and sr_rng < 44000.0:
                released.add("c")
                release_jsow("jsow_c", "611")
            if "a1" not in released and col_rng < 36000.0:
                released.add("a1")
                a1_t = t
                # Lead the moving column: aim at the middle of it, where it
                # will be when the JSOW arrives (~250 m/s average).
                lead = COLUMN_SPEED * col_rng / 250.0 - 90.0
                release_jsow("jsow_a", "602", (math.sin(math.radians(COLUMN_HDG)) * lead,
                                               math.cos(math.radians(COLUMN_HDG)) * lead))
            ln_e = (ground["612"]["e"] + ground["613"]["e"]) / 2
            ln_n = (ground["612"]["n"] + ground["613"]["n"]) / 2
            ln_rng = math.hypot(ln_e - player.east, ln_n - player.north)
            if "a2" not in released and "a1" in released and t - a1_t > 4.0 and ln_rng < 40000.0:
                released.add("a2")
                release_jsow("jsow_a", "612", (ln_e - ground["612"]["e"], ln_n - ground["612"]["n"]))
                state, state_t = "CRANK", t
                em.event("Message", [player.obj_id], "Viper 1-1 cranking")
        elif state == "CRANK":
            player.cmd_hdg = 140.0
            player.cmd_alt = 4600.0
            player.cmd_tas = 235.0
            if t - state_t > 70.0:
                state, state_t = "GBU", t
                em.event("Message", [player.obj_id], "Viper 1-1 in for the GBU-12")
        elif state == "GBU":
            te, tn = unit_pos("621")
            rng = _steer_to(player, te, tn)
            player.cmd_alt, player.cmd_tas = 4600.0, 235.0
            if "gbu" not in released and rng < 5600.0:
                released.add("gbu")
                oid = new_id()
                vh = player.tas
                b = Ballistic(oid, "gbu12", player.east, player.north, player.alt - 2.0,
                              math.sin(math.radians(player.hdg)) * vh, math.cos(math.radians(player.hdg)) * vh,
                              player.vs, drag=0.02, target=(te, tn), born=t)
                bombs.append(b)
                emit_weapon(oid, "gbu12", b.e, b.n, b.alt, player.hdg, first=True)
                em.event("Message", [player.obj_id], "Viper 1-1 GBU-12 away, lasing")
                state, state_t = "OFFSET", t
        elif state == "OFFSET":
            # Keep the laser on while offsetting, then set up for the dive.
            player.cmd_hdg = 20.0
            player.cmd_alt, player.cmd_tas = 3700.0, 230.0
            if t - state_t > 40.0:
                state, state_t = "DIVE_SETUP", t
        elif state == "DIVE_SETUP":
            # Extend north-east to about 7 km from the truck, then turn in.
            te, tn = unit_pos("622")
            player.cmd_hdg = 45.0
            if math.hypot(te - player.east, tn - player.north) > 10500.0:
                state, state_t = "IN", t
        elif state == "IN":
            te, tn = unit_pos("622")
            rng = _steer_to(player, te, tn)
            brg = math.degrees(math.atan2(te - player.east, tn - player.north)) % 360.0
            if abs(geo.wrap180(brg - player.hdg)) < 8.0 and rng < DIVE_START:
                state, state_t = "DIVE", t
                player.max_vs = 140.0
                em.event("Message", [player.obj_id], "Viper 1-1 in hot, Mk-82")
            elif rng < 3500.0:
                state, state_t = "DIVE_SETUP", t  # not lined up: go round
        elif state == "DIVE":
            te, tn = unit_pos("622")
            rng = _steer_to(player, te, tn)
            player.cmd_tas = 240.0
            player.cmd_alt = GROUND + 300.0  # pushes into a ~30 deg dive
            diving = player.vs < -0.34 * player.tas  # established in a 20+ degree dive
            if "mk82" not in released and diving and player.alt < GROUND + 1600.0:
                released.add("mk82")
                oid = new_id()
                # Scripted ballistics: the bomb leaves with the jet's sink rate
                # and a horizontal velocity that carries it to a point 35 m
                # short of the truck (a slightly early pickle).
                ux, uy = (te - player.east) / max(rng, 1.0), (tn - player.north) / max(rng, 1.0)
                aim_e, aim_n = te - ux * 35.0, tn - uy * 35.0
                h, vz = player.alt - 2.0 - GROUND, player.vs
                tf = (vz + math.sqrt(vz * vz + 2.0 * G * h)) / G
                b = Ballistic(oid, "mk82", player.east, player.north, player.alt - 2.0,
                              (aim_e - player.east) / tf, (aim_n - player.north) / tf, vz, drag=0.0, born=t)
                bombs.append(b)
                emit_weapon(oid, "mk82", b.e, b.n, b.alt, player.hdg, first=True)
                state, state_t = "RECOVER", t
        elif state == "RECOVER":
            player.cmd_alt, player.cmd_tas, player.cmd_hdg = 4000.0, 250.0, 230.0
            player.max_vs = 60.0

        # SA-11 launcher takes a shot on the way in.
        if sam is None and t >= 62.0:
            sid = new_id()
            le, ln = ground["612"]["e"], ground["612"]["n"]
            sam = {"id": sid, "e": le, "n": ln, "alt": GROUND + 5.0, "v": 50.0, "born": t, "alive": True}
            name, tags = WEAPONS["sa11"]
            lon, lat = geo.to_lonlat(le, ln, FIELD_LON, FIELD_LAT)
            em.update(sid, (lon, lat, sam["alt"], 0.0, 60.0, 0.0), {},
                      {"Name": name, "Type": tags, "Coalition": "Enemies", "Color": "Red", "Country": "ru"})
        if sam is not None and sam["alive"]:
            # Lead pursuit at up to ~900 m/s, motor out after 15 s; the F-16's
            # crank drags it out of energy and it self-destructs at 45 s.
            age = t - sam["born"]
            sam["v"] = min(900.0, sam["v"] + 90.0 * DT) if age < 15 else max(250.0, sam["v"] - 12.0 * DT)
            de, dn, dz = player.east - sam["e"], player.north - sam["n"], player.alt - sam["alt"]
            d = math.sqrt(de * de + dn * dn + dz * dz)
            step = sam["v"] * DT
            miss_bias = 1.0 if age > 20 else 0.0  # the crank: the missile falls behind
            sam["e"] += de / d * step * (1.0 - 0.15 * miss_bias)
            sam["n"] += dn / d * step * (1.0 - 0.15 * miss_bias)
            sam["alt"] += dz / d * step
            if age > 45.0 or d < 250.0 and False:
                sam["alive"] = False
                em.remove(sam["id"])
            else:
                lon, lat = geo.to_lonlat(sam["e"], sam["n"], FIELD_LON, FIELD_LAT)
                hdg = math.degrees(math.atan2(de, dn)) % 360.0
                em.update(sam["id"], (lon, lat, sam["alt"], 0.0, 0.0, hdg), {}, {})

        player.step(DT)
        em.update(player.obj_id, _aircraft_transform(player), _aircraft_numeric(player),
                  {"Name": player.name, "Type": player.type_tags, "Coalition": player.coalition, "Color": player.color,
                   "Pilot": player.pilot or "", "Group": player.group or "", "Country": player.country})

        # --- JSOWs ------------------------------------------------------------------------
        for g in list(gliders):
            g.step(DT)
            dist = math.hypot(g.aim[0] - g.e, g.aim[1] - g.n)
            if g.kind == "jsow_a" and dist < g.v / 0.29:  # the bomblets' forward throw
                # Dispense ~700 m short and ~500 m above the aim point: the
                # 145 BLU-97/Bs, slowed by their drogues (terminal ~34 m/s),
                # carry forward onto it over ~15 s in a ~150 x 80 m pattern.
                em.remove(g.obj_id)
                gliders.remove(g)
                h = math.radians(g.hdg)
                for k in range(145):
                    ang = (k * 137.508) % 360.0
                    rad = 4.0 + 18.0 * math.sqrt((k + 0.5) / 145.0)
                    along = math.cos(math.radians(ang)) * rad * 1.3
                    across = math.sin(math.radians(ang)) * rad * 0.8
                    ve = math.sin(h) * (g.v + along) + math.cos(h) * across
                    vn = math.cos(h) * (g.v + along) - math.sin(h) * across
                    b = Ballistic(new_id(), "blu97", g.e, g.n, g.alt, ve, vn, -10.0, drag=0.29, born=t, sample_every=0.5)
                    bombs.append(b)
                    emit_weapon(b.obj_id, "blu97", b.e, b.n, b.alt, g.hdg, -60.0, first=True)
                # Everything under the pattern dies as the bomblets land.
                for oid in list(ground):
                    ue, un = unit_pos(oid)
                    if ground[oid]["alive"] and math.hypot(ue - g.aim[0], un - g.aim[1]) < 85.0:
                        kills_pending.append((t + 15.0 + 0.4 * len(kills_pending), oid))
                continue
            if g.alt <= GROUND + 0.5:
                em.remove(g.obj_id)  # deleted on impact, no impact sample
                gliders.remove(g)
                if g.target and math.hypot(g.aim[0] - g.e, g.aim[1] - g.n) < 40.0:
                    kills_pending.append((t + 0.5, g.target))
                continue
            if int(round((t - g.born) / DT)) % 2 == 0:  # recorded at ~2 Hz
                emit_weapon(g.obj_id, g.kind, g.e, g.n, g.alt, g.hdg, g.pitch)

        # --- bombs and bomblets ------------------------------------------------------------
        for b in list(bombs):
            b.step(DT)
            if b.alt <= GROUND:
                em.remove(b.obj_id)
                bombs.remove(b)
                if b.kind in ("gbu12", "mk82"):
                    he, hn = b.ground_hit()
                    for oid in list(ground):
                        ue, un = unit_pos(oid)
                        if ground[oid]["alive"] and math.hypot(ue - he, un - hn) < 25.0:
                            kills_pending.append((t + 0.3, oid))
                continue
            if int(round((t - b.born) / DT)) % max(1, int(round(b.sample_every / DT))) == 0:
                emit_weapon(b.obj_id, b.kind, b.e, b.n, b.alt, math.degrees(math.atan2(b.ve, b.vn)) % 360.0)

        # --- deaths ---------------------------------------------------------------------------
        for due, oid in list(kills_pending):
            if due <= t:
                kills_pending.remove((due, oid))
                if ground[oid]["alive"]:
                    ground[oid]["alive"] = False
                    em.event("Destroyed", [oid], "")
                    em.update(oid, (None, None, None, None, None, None), {"Health": 0.0}, {})
                    if oid == "611":
                        em.update(oid, (None, None, None, None, None, None), {"RadarMode": 0.0}, {})

        t = round(t + DT, 3)
    return em.lines


def write_strike_sample(path: str, duration: float = 540.0) -> str:
    lines = build_strike_sample(duration)
    os.makedirs(os.path.dirname(os.path.abspath(path)) or ".", exist_ok=True)
    with open(path, "w", encoding="utf-8", newline="\n") as fh:
        fh.write("\n".join(lines))
        fh.write("\n")
    return path
