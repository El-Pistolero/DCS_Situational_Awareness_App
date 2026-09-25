"""Live world state for the second-screen view.

:class:`LiveWorld` is an ACMI sink (fed by the Tacview real-time client or a
file replay) *and* the landing zone for the DCS ``Export.lua`` bridge.  It
keeps only what a live display needs - current state, a short trail and
recent events - and computes a threat picture for the focus aircraft.
"""

from __future__ import annotations

import math
import threading
import time
from collections import deque
from typing import Any, Deque, Dict, List, Optional, Tuple

from ..acmi import types as T
from ..acmi.model import Event
from ..analysis import geo

TRAIL_SECONDS = 90.0
TRAIL_POINTS = 240
MAX_EVENTS = 300
#: Beyond this range a contact is not worth a threat-list row.
THREAT_RANGE_AIR = 150_000.0
THREAT_RANGE_MISSILE = 80_000.0


class LiveObject:
    __slots__ = ("id", "props", "values", "tags", "category", "first_seen", "last_update",
                 "trail", "prev", "derived", "source")

    def __init__(self, obj_id: str, t: float, source: str = "acmi") -> None:
        self.id = obj_id
        self.props: Dict[str, str] = {}
        self.values: Dict[str, float] = {}
        self.tags = frozenset()
        self.category = "misc"
        self.first_seen = t
        self.last_update = t
        self.trail: Deque[Tuple[float, float, float, float]] = deque(maxlen=TRAIL_POINTS)
        self.prev: Optional[Tuple[float, float, float, float]] = None
        self.derived: Dict[str, float] = {}
        self.source = source

    def position(self) -> Optional[Tuple[float, float, float]]:
        v = self.values
        if "Longitude" not in v or "Latitude" not in v:
            return None
        return v["Longitude"], v["Latitude"], v.get("Altitude", 0.0)

    def heading(self) -> Optional[float]:
        for key in ("Yaw", "HDG", "Heading"):
            if key in self.values:
                return self.values[key]
        return self.derived.get("track")

    @property
    def coalition(self) -> str:
        return self.props.get("Coalition", "Unknown")

    @property
    def name(self) -> str:
        return self.props.get("Name") or self.id


def _hostile(a: LiveObject, b: LiveObject) -> bool:
    ca, cb = a.coalition, b.coalition
    if ca in ("", "Unknown", "Neutral") or cb in ("", "Unknown", "Neutral"):
        return ca != cb or ca in ("", "Unknown")
    return ca != cb


def _clock(rel_bearing: float) -> int:
    """Relative bearing to a clock position (12 = nose)."""
    c = int(round((rel_bearing % 360.0) / 30.0)) % 12
    return 12 if c == 0 else c


class LiveWorld:
    def __init__(self, player_names: Optional[List[str]] = None) -> None:
        self._lock = threading.RLock()
        self.player_names = [n.lower() for n in (player_names or []) if n]
        self.reset()
        self.status: Dict[str, Any] = {"source": None, "state": "idle", "detail": ""}
        self.bridge_status: Dict[str, Any] = {"state": "idle", "packets": 0, "last": None}

    # -- housekeeping -------------------------------------------------------

    def reset(self) -> None:
        with getattr(self, "_lock", threading.RLock()):
            self.objects: Dict[str, LiveObject] = {}
            self.globals: Dict[str, Any] = {}
            self.events: Deque[Dict[str, Any]] = deque(maxlen=MAX_EVENTS)
            self.event_seq = 0
            self.time = 0.0
            self.wall_updated = 0.0
            self.focus_id: Optional[str] = getattr(self, "focus_id", None)
            self.focus_locked = getattr(self, "focus_locked", False)
            self.ownship: Dict[str, Any] = {}
            self.ownship_time = 0.0
            self.recently_destroyed: Deque[Dict[str, Any]] = deque(maxlen=50)

    def set_status(self, source: str, state: str, detail: str = "") -> None:
        with self._lock:
            self.status = {"source": source, "state": state, "detail": detail, "since": time.time()}

    def set_focus(self, obj_id: Optional[str]) -> None:
        with self._lock:
            self.focus_id = obj_id
            self.focus_locked = obj_id is not None

    # -- AcmiSink -----------------------------------------------------------

    def on_frame(self, t: float) -> None:
        self.time = t
        self.wall_updated = time.time()

    def on_global(self, t: float, values: Dict[str, Any]) -> None:
        with self._lock:
            self.globals.update(values)

    def on_object(self, t: float, obj_id: str, numeric: Dict[str, float], text: Dict[str, str]) -> None:
        with self._lock:
            obj = self.objects.get(obj_id)
            if obj is None:
                obj = LiveObject(obj_id, t)
                self.objects[obj_id] = obj
            if text:
                obj.props.update(text)
                if "Type" in text:
                    obj.tags = T.parse_tags(text["Type"])
                    obj.category = T.category(obj.tags)
            obj.values.update(numeric)
            obj.last_update = t
            if "Longitude" in numeric or "Latitude" in numeric or "Altitude" in numeric:
                self._track_motion(obj, t)
            if self.focus_id is None or (not self.focus_locked and self._better_focus(obj)):
                if T.is_aircraft(obj.tags):
                    self.focus_id = obj.id

    def on_remove(self, t: float, obj_id: str) -> None:
        with self._lock:
            obj = self.objects.pop(obj_id, None)
            if obj is not None and obj.category in ("fixedwing", "rotorcraft", "ground", "sea", "air"):
                pos = obj.position()
                self.recently_destroyed.append({
                    "id": obj_id, "name": obj.name, "pilot": obj.props.get("Pilot"),
                    "time": t, "lon": pos[0] if pos else None, "lat": pos[1] if pos else None,
                })
            if obj_id == self.focus_id and not self.focus_locked:
                self.focus_id = None

    def on_event(self, event: Event) -> None:
        with self._lock:
            self.event_seq += 1
            names = [self._label(i) for i in event.object_ids]
            self.events.append({
                "seq": self.event_seq, "time": event.time, "kind": event.kind,
                "objectIds": event.object_ids, "names": names, "text": event.text,
            })

    # -- DCS Export.lua bridge ------------------------------------------------

    def ingest_bridge(self, payload: Dict[str, Any]) -> None:
        """Merge one datagram from the DCS Export.lua bridge."""
        with self._lock:
            self.ownship = payload
            self.ownship_time = time.time()
            self.bridge_status = {
                "state": "receiving",
                "packets": self.bridge_status.get("packets", 0) + 1,
                "last": self.ownship_time,
            }
            me = payload.get("self") or {}
            # With no Tacview stream, synthesise objects so the map still works.
            acmi_live = self.status.get("state") == "connected" or self.status.get("source") == "replay"
            if acmi_live or "lat" not in me:
                return
            t = float(payload.get("t") or 0.0)
            self.time = t
            self._bridge_object("self", t, me, is_self=True)
            for obj in payload.get("world") or []:
                oid = obj.get("id")
                if oid is None:
                    continue
                self._bridge_object(f"w{oid}", t, obj)
            seen = {f"w{o.get('id')}" for o in payload.get("world") or []}
            if payload.get("world") is not None:
                for oid in [k for k, o in self.objects.items() if o.source == "bridge" and oid_is_world(k) and k not in seen]:
                    self.objects.pop(oid, None)

    def _bridge_object(self, oid: str, t: float, d: Dict[str, Any], is_self: bool = False) -> None:
        obj = self.objects.get(oid)
        if obj is None:
            obj = LiveObject(oid, t, source="bridge")
            self.objects[oid] = obj
        type_str = d.get("tacviewType") or _dcs_type_to_tags(d.get("type"), is_self)
        props = {
            "Name": d.get("name") or "",
            "Pilot": d.get("pilot") or "",
            "Coalition": d.get("coalition") or "",
            "Group": d.get("group") or "",
            "Type": type_str,
        }
        obj.props.update({k: v for k, v in props.items() if v})
        obj.tags = T.parse_tags(type_str)
        obj.category = T.category(obj.tags)
        vals = {
            "Longitude": d.get("lon"), "Latitude": d.get("lat"), "Altitude": d.get("alt"),
            "Yaw": d.get("hdg"), "Pitch": d.get("pitch"), "Roll": d.get("bank"),
            "IAS": d.get("ias"), "TAS": d.get("tas"), "Mach": d.get("mach"),
            "AOA": d.get("aoa"), "AOS": d.get("aos"), "AGL": d.get("agl"),
        }
        obj.values.update({k: float(v) for k, v in vals.items() if isinstance(v, (int, float))})
        obj.last_update = t
        self._track_motion(obj, t)
        if is_self and not self.focus_locked:
            self.focus_id = oid

    # -- derived motion ---------------------------------------------------------

    def _track_motion(self, obj: LiveObject, t: float) -> None:
        pos = obj.position()
        if pos is None:
            return
        cur = (t, pos[0], pos[1], pos[2])
        prev = obj.prev
        if prev is not None and t - prev[0] >= 0.2:
            dt = t - prev[0]
            gd = geo.ground_distance(prev[1], prev[2], cur[1], cur[2])
            vs = (cur[3] - prev[3]) / dt
            gs = gd / dt
            d = obj.derived
            old_vs = d.get("vs")
            d["gs"] = gs
            d["vs"] = vs
            if gs > 1.0:
                new_track = geo.bearing(prev[1], prev[2], cur[1], cur[2])
                old_track = d.get("track")
                d["track"] = new_track
                if old_track is not None:
                    turn = geo.wrap180(new_track - old_track) / dt
                    d["turnRate"] = turn
                    v = math.hypot(gs, vs)
                    az = 0.0 if old_vs is None else (vs - old_vs) / dt
                    d["g"] = math.hypot(v * math.radians(turn), 9.80665 + az) / 9.80665
            obj.prev = cur
        elif prev is None:
            obj.prev = cur
        if not obj.trail or t - obj.trail[-1][0] >= 0.5:
            obj.trail.append(cur)
        while obj.trail and t - obj.trail[0][0] > TRAIL_SECONDS:
            obj.trail.popleft()

    # -- focus / labels -----------------------------------------------------------

    def _better_focus(self, obj: LiveObject) -> bool:
        if not T.is_aircraft(obj.tags):
            return False
        pilot = (obj.props.get("Pilot") or "").lower()
        if self.player_names and pilot in self.player_names:
            return obj.id != self.focus_id
        current = self.objects.get(self.focus_id) if self.focus_id else None
        if current is None:
            return True
        if self.player_names and (current.props.get("Pilot") or "").lower() in self.player_names:
            return False
        # Richest telemetry wins, as in the offline analysis.
        return len(obj.values) > len(current.values) + 3

    def _label(self, obj_id: str) -> str:
        obj = self.objects.get(obj_id)
        if obj is None:
            return obj_id
        pilot = obj.props.get("Pilot")
        return f"{pilot} ({obj.name})" if pilot else obj.name

    # -- snapshot -----------------------------------------------------------------

    def snapshot(self, since_event: int = 0, include_trails: bool = True) -> Dict[str, Any]:
        with self._lock:
            objs = []
            for obj in self.objects.values():
                if obj.category == "clutter":
                    continue
                pos = obj.position()
                if pos is None:
                    continue
                v = obj.values
                row: Dict[str, Any] = {
                    "id": obj.id,
                    "name": obj.name,
                    "pilot": obj.props.get("Pilot"),
                    "group": obj.props.get("Group"),
                    "coalition": obj.coalition,
                    "color": obj.props.get("Color"),
                    "category": obj.category,
                    "type": obj.props.get("Type"),
                    "parent": obj.props.get("Parent"),
                    "lon": pos[0], "lat": pos[1], "alt": pos[2],
                    "hdg": obj.heading(),
                    "v": {k: v[k] for k in _LIVE_CHANNELS if k in v},
                    "d": dict(obj.derived),
                }
                lock = obj.props.get("LockedTarget")
                if lock and v.get("LockedTargetMode", 1.0) > 0:
                    row["lock"] = lock
                if include_trails and obj.category in ("fixedwing", "rotorcraft", "air", "weapon"):
                    step = 1 if obj.category == "weapon" else 2
                    row["trail"] = [[p[1], p[2], p[3]] for p in list(obj.trail)[::step]]
                objs.append(row)

            focus = self.objects.get(self.focus_id) if self.focus_id else None
            return {
                "time": self.time,
                "wallclock": time.time(),
                "stale": (time.time() - self.wall_updated) > 5.0 if self.wall_updated else True,
                "status": dict(self.status),
                "bridge": dict(self.bridge_status),
                "globals": {k: v for k, v in self.globals.items() if k in ("Title", "ReferenceTime", "MapId", "DataSource")},
                "focus": self.focus_id,
                "focusLocked": self.focus_locked,
                "objects": objs,
                "events": [e for e in self.events if e["seq"] > since_event],
                "eventSeq": self.event_seq,
                "threats": self._threats(focus) if focus else [],
                "ownship": self.ownship if (time.time() - self.ownship_time) < 3.0 else None,
                "destroyed": list(self.recently_destroyed)[-10:],
            }

    def _threats(self, me: LiveObject) -> List[Dict[str, Any]]:
        mp = me.position()
        if mp is None:
            return []
        my_hdg = me.heading() or 0.0
        out: List[Dict[str, Any]] = []
        for obj in self.objects.values():
            if obj.id == me.id or obj.category in ("clutter", "countermeasure", "bullseye", "navaid", "misc"):
                continue
            op = obj.position()
            if op is None:
                continue
            rng = geo.slant_range(*mp, *op)
            brg = geo.bearing(mp[0], mp[1], op[0], op[1])
            rel = geo.wrap180(brg - my_hdg)
            closure = _closure(me, obj)
            base = {
                "id": obj.id, "name": obj.name, "pilot": obj.props.get("Pilot"),
                "category": obj.category, "range": rng, "bearing": brg,
                "relBearing": rel, "clock": _clock(rel), "altDelta": op[2] - mp[2],
                "closure": closure,
            }

            if obj.category == "weapon":
                parent = self.objects.get(obj.props.get("Parent", ""))
                if parent is not None and not _hostile(me, parent):
                    continue
                if parent is None and not _hostile(me, obj) and obj.coalition not in ("", "Unknown"):
                    continue
                if rng > THREAT_RANGE_MISSILE:
                    continue
                w_hdg = obj.heading()
                brg_to_me = geo.bearing(op[0], op[1], mp[0], mp[1])
                pointing = w_hdg is not None and abs(geo.wrap180(brg_to_me - w_hdg)) < 35.0
                if not pointing and (closure is None or closure <= 0):
                    continue
                tti = rng / closure if closure and closure > 1.0 else None
                out.append({**base, "kind": "missile", "level": 3 if pointing else 2,
                            "tti": tti, "shooter": parent.name if parent else None,
                            "shooterPilot": parent.props.get("Pilot") if parent else None,
                            "text": "MISSILE"})
                continue

            if not _hostile(me, obj):
                continue
            locked_me = obj.props.get("LockedTarget") == me.id and obj.values.get("LockedTargetMode", 1.0) > 0
            eng = obj.values.get("EngagementRange")
            in_wez = bool(eng) and geo.ground_distance(mp[0], mp[1], op[0], op[1]) <= eng
            if obj.category in ("fixedwing", "rotorcraft", "air"):
                if rng > THREAT_RANGE_AIR and not locked_me:
                    continue
                oh = obj.heading()
                aspect = geo.aspect_angle(op[0], op[1], oh, mp[0], mp[1]) if oh is not None else None
                hot = aspect is not None and aspect > 135.0
                level = 2 if locked_me else (1 if hot and rng < 60_000 else 0)
                out.append({**base, "kind": "aircraft", "level": level, "aspect": aspect,
                            "spike": locked_me, "text": "SPIKE" if locked_me else ("HOT" if hot else "")})
            elif locked_me or in_wez:
                out.append({**base, "kind": "sam" if "AntiAircraft" in obj.tags else "surface",
                            "level": 2 if locked_me else 1, "spike": locked_me,
                            "engagementRange": eng, "inWez": in_wez,
                            "text": "SPIKE" if locked_me else "IN WEZ"})

        # Anything tracking me by lock, straight from the RWR, if the bridge sent it.
        out.sort(key=lambda d: (-d["level"], d.get("tti") or 1e9, d["range"]))
        return out[:30]


def _closure(a: LiveObject, b: LiveObject) -> Optional[float]:
    """Closure rate from the last two trail points of each object."""
    if len(a.trail) < 2 or len(b.trail) < 2:
        return None
    a0, a1 = a.trail[-2], a.trail[-1]
    b0, b1 = b.trail[-2], b.trail[-1]
    t_now = min(a1[0], b1[0])
    t_prev = max(a0[0], b0[0])
    dt = t_now - t_prev
    if dt <= 0.05:
        return None
    r_now = geo.slant_range(a1[1], a1[2], a1[3], b1[1], b1[2], b1[3])
    r_prev = geo.slant_range(a0[1], a0[2], a0[3], b0[1], b0[2], b0[3])
    return (r_prev - r_now) / max(a1[0] - a0[0], b1[0] - b0[0], 1e-3)


def oid_is_world(oid: str) -> bool:
    return oid.startswith("w")


_LIVE_CHANNELS = (
    "Roll", "Pitch", "Yaw", "IAS", "TAS", "Mach", "AOA", "AOS", "AGL", "HDG", "HDM",
    "Throttle", "Throttle2", "Afterburner", "AirBrakes", "Flaps", "LandingGear", "Tailhook",
    "FuelWeight", "FuelWeight2", "RadarMode", "RadarAzimuth", "RadarElevation", "RadarRange",
    "RadarHorizontalBeamwidth", "RadarVerticalBeamwidth", "LockedTargetMode",
    "LockedTargetAzimuth", "LockedTargetElevation", "LockedTargetRange", "EngagementRange",
    "EngagementMode", "Health", "VerticalGForce", "PitchControlInput", "RollControlInput",
    "YawControlInput", "PitchTrimTab", "TriggerPressed", "GlideslopeVerticalDeviation",
    "LocalizerLateralDeviation",
)


def _dcs_type_to_tags(t: Any, is_self: bool) -> str:
    """Map DCS's wsType level1/level2 onto Tacview type tags."""
    if is_self:
        return "Air+FixedWing"
    if isinstance(t, dict):
        l1, l2 = t.get("level1"), t.get("level2")
        if l1 == 1:  # wsType_Air
            return "Air+Rotorcraft" if l2 == 2 else "Air+FixedWing"
        if l1 == 2:  # wsType_Ground
            return "Ground+Vehicle"
        if l1 == 3:  # wsType_Navy
            return "Sea+Watercraft"
        if l1 == 4:  # wsType_Weapon
            return "Weapon+Missile"
    return "Misc"
