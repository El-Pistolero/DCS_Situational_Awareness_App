"""Live world state for the second-screen view.

:class:`LiveWorld` is an ACMI sink (fed by the Tacview real-time client or a
file replay) *and* the landing zone for the DCS ``Export.lua`` bridge.  It
keeps only what a live display needs - current state, a short trail and
recent events - and computes a threat picture for the focus aircraft.
"""

from __future__ import annotations

import logging
import math
import re
import threading
import time
from collections import deque
from typing import Any, Deque, Dict, List, Optional, Tuple

from .. import threatdb
from ..acmi import types as T
from ..acmi.model import Event
from ..analysis import geo
from ..analysis import ir as IR

log = logging.getLogger(__name__)
from ..analysis.strike import family
from ..analysis.weapons import LAUNCHER_RADIUS, SUBMUNITION_RE, weapon_kind

TRAIL_SECONDS = 90.0
TRAIL_POINTS = 240
MAX_EVENTS = 300
#: Beyond this range a contact is not worth a threat-list row.
THREAT_RANGE_AIR = 150_000.0
THREAT_RANGE_MISSILE = 80_000.0
MAX_LIVE_ROUNDS = 400
#: Bomblet rows per snapshot: one JSOW-A alone releases 145.
MAX_LIVE_BOMBLETS = 150
#: Aircraft position history, to tell which jet a new weapon came off.
HIST_SECONDS = 20.0
HIST_STEP = 0.2
#: A released weapon stays in myWeapons this long after it disappears.
IMPACT_KEEP = 5.0
#: A JSOW-A / CBU that opened in the air: its bomblets land ~10-15 s later,
#: so keep the row long enough for DCS's hit/kill reports to arrive.
IMPACT_KEEP_DISPENSED = 20.0
#: Aim altitude: the nearest ground unit to the first-guess impact, within this.
AIM_SEARCH = 5000.0
#: Target: the nearest hostile ground unit to the predicted impact, within this.
AIM_TARGET_RADIUS = 1500.0
#: s: a unit killed this long before a weapon's removal can still be its target.
KILL_GRACE = 1.0
#: Glide weapons never come down shallower than this.
MIN_GLIDE_DEG = 3.0
#: A dispenser that vanishes this far above the ground opened in the air.
DISPENSE_HEIGHT = 100.0
G = 9.80665
_AIR = ("fixedwing", "rotorcraft", "air")
_SURFACE = ("ground", "sea")
_GLIDE_FAMILIES = ("jsow", "jdam")
_POWERED_FAMILIES = ("agm", "maverick", "harm")
#: Air-to-air missiles have no ground impact to predict; family() calls them "agm".
#: (No \b before R/P/PL/SD: "_" counts as a word character, as in "Matra_R550".)
_AIR_TO_AIR_RE = re.compile(
    r"\bAIM[-_ ]?\d|(?<![A-Z0-9])([RP][-_ ]?(3|13|23|24|27|33|37|40|60|73|77|530|550)(?!\d)|PL[-_ ]?\d|SD[-_ ]?10)|"
    r"MICA|MAGIC|METEOR|PYTHON|DERBY|IRIS[-_ ]?T|SUPER[-_ ]?530|ASRAAM|SKYFLASH|"
    r"MISTRAL|STINGER|FIM[-_ ]?92|IGLA|9M39", re.I)
#: JSOWs that open in the air (A: BLU-97, B: BLU-108); plain AGM_154 is the unitary C.
_JSOW_DISPENSER_RE = re.compile(r"AGM[-_ ]?154[AB](?![A-Z0-9])", re.I)


class LiveObject:
    __slots__ = ("id", "props", "values", "tags", "category", "first_seen", "last_update",
                 "trail", "prev", "derived", "source", "hist", "sub", "dead", "died")

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
        # Aircraft only: positions over the last HIST_SECONDS, every HIST_STEP.
        self.hist: Deque[Tuple[float, float, float, float]] = deque()
        self.sub = False  # a bomblet / submunition (by name)
        self.dead = False  # destroyed (Tacview Destroyed event or Health 0) but still in the stream
        self.died = 0.0  # when, if dead

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


def _is_submunition(obj: LiveObject) -> bool:
    """A bomblet, by name.  Weapons only, and not the SD-10 air-to-air missile
    (which shares a name with a bomblet): it must stay a threat."""
    name = obj.props.get("Name") or ""
    if obj.category != "weapon" or not SUBMUNITION_RE.search(name):
        return False
    return not ("Missile" in obj.tags and _AIR_TO_AIR_RE.search(name))


def _same_side(weapon: LiveObject, ac: LiveObject) -> bool:
    """Weapons carry their shooter's Country/Coalition (as in the offline analysis)."""
    wc, ac_c = weapon.props.get("Country"), ac.props.get("Country")
    if wc and ac_c:
        return wc == ac_c
    wco, aco = weapon.props.get("Coalition"), ac.props.get("Coalition")
    if wco and aco and wco not in ("Neutral", "Unknown"):
        return wco == aco
    return True


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
            # A new session (reconnect, mission restart, replay loop) tells
            # clients to drop their event list and trails.
            self.session = getattr(self, "session", 0) + 1
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
            self.scan_values: Dict[str, float] = {}
            self.world_radar: List[Tuple[str, float, float, bool]] = []
            self.bridge_world: Optional[List[Dict[str, Any]]] = None  # last world sweep applied
            self.recently_destroyed: Deque[Dict[str, Any]] = deque(maxlen=50)
            # Afterburner from fuel flow, per aircraft (live: the dry plateau so far).
            self.ff_ab: Dict[str, IR.FuelFlowAB] = {}
            # Flare / chaff id -> (the jet it appeared next to, that jet's Color, Coalition)
            # (DCS writes no Parent on them; the side is kept for after the jet is gone).
            self.cm_owner: Dict[str, Optional[Tuple[str, str, str]]] = {}
            # Weapon id -> the aircraft that released it, decided when first seen.
            self.launchers: Dict[str, Optional[str]] = {}
            # Weapon id -> (removal time, launcher id, final myWeapons entry).
            self.impacted: Dict[str, Tuple[float, str, Dict[str, Any]]] = {}
            # Ground/sea units by position, rebuilt only after one of them changes.
            self.unit_index: Optional[_UnitIndex] = None

    def set_status(self, source: str, state: str, detail: str = "") -> None:
        with self._lock:
            before = self.status.get("state") if isinstance(self.status, dict) else None
            self.status = {"source": source, "state": state, "detail": detail, "since": time.time()}
        if before != state:
            log.info("%s: %s%s", source, state, f" ({detail})" if detail else "")

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
                if "Name" in text or "Type" in text:
                    obj.sub = _is_submunition(obj)
            obj.values.update(numeric)
            obj.last_update = t
            if obj.category in _AIR and _num(obj.values.get("FuelFlowWeight")):
                self._feed_ab(obj, t, obj.values["FuelFlowWeight"])
            if obj.category in _SURFACE:
                self.unit_index = None
            if numeric.get("Health") == 0.0:
                self._mark_dead(obj, t)
            if "Longitude" in numeric or "Latitude" in numeric or "Altitude" in numeric:
                self._track_motion(obj, t)
            self._note_weapon(obj, t)
            if obj.category == "countermeasure" and obj.id not in self.cm_owner:
                self._note_countermeasure(obj, t)
            if self.focus_id is None or (not self.focus_locked and self._better_focus(obj)):
                if T.is_aircraft(obj.tags):
                    self.focus_id = obj.id

    def _note_countermeasure(self, obj: LiveObject, t: float) -> None:
        """Who dropped it: the nearest aircraft within 60 m when it appears, unless two are that close."""
        pos = obj.position()
        if pos is None:
            return
        near = []
        for ac in self.objects.values():
            if ac.category not in _AIR or ac.dead:
                continue
            p = _position_at(ac, t)
            if p is None:
                continue
            d = geo.slant_range(pos[0], pos[1], pos[2], p[0], p[1], p[2])
            if d < IR.FLARE_OWNER_RADIUS:
                near.append((d, ac.id))
        near.sort()
        ambiguous = len(near) > 1 and near[1][0] < max(near[0][0], 5.0) * IR.FLARE_OWNER_AMBIGUOUS
        owner = self.objects.get(near[0][1]) if near and not ambiguous else None
        self.cm_owner[obj.id] = (owner.id, owner.props.get("Color") or "", owner.coalition) if owner else None

    def _mark_dead(self, obj: LiveObject, t: float) -> None:
        """A unit destroyed while its object stays in the stream (Tacview keeps wrecks)."""
        if obj.dead:
            return
        obj.dead, obj.died = True, t
        self._wreck(obj, t)

    def _wreck(self, obj: LiveObject, t: float) -> None:
        if obj.category not in ("fixedwing", "rotorcraft", "ground", "sea", "air"):
            return
        if any(r["id"] == obj.id for r in self.recently_destroyed):
            return
        pos = obj.position()
        self.recently_destroyed.append({
            "id": obj.id, "name": obj.name, "pilot": obj.props.get("Pilot"),
            "time": t, "lon": pos[0] if pos else None, "lat": pos[1] if pos else None,
            "coalition": obj.coalition, "category": obj.category,
        })

    def on_remove(self, t: float, obj_id: str) -> None:
        with self._lock:
            obj = self.objects.pop(obj_id, None)
            self.cm_owner.pop(obj_id, None)
            if obj is not None and obj.category in _SURFACE:
                self.unit_index = None
            if obj is not None and obj.category in ("fixedwing", "rotorcraft", "ground", "sea", "air"):
                self._wreck(obj, t)
            elif obj is not None and obj.category == "weapon":
                self._retire_weapon(obj, t)
            if obj_id == self.focus_id and not self.focus_locked:
                self.focus_id = None

    def on_event(self, event: Event) -> None:
        with self._lock:
            if event.kind == "Destroyed":
                for oid in event.object_ids:
                    obj = self.objects.get(oid)
                    if obj is not None:
                        self._mark_dead(obj, event.time)
            self.event_seq += 1
            names = [self._label(i) for i in event.object_ids]
            self.events.append({
                "seq": self.event_seq, "time": event.time, "kind": event.kind,
                "objectIds": event.object_ids, "names": names, "text": event.text,
            })

    # -- DCS events (hook) ---------------------------------------------------------

    def on_dcs_events(self, events: List[Dict[str, Any]]) -> None:
        """Combat events as DCS reported them.  Runs of hits are collapsed."""
        with self._lock:
            for ev in events:
                kind = str(ev.get("kind") or "")
                ini, tgt = ev.get("initiator") or {}, ev.get("target") or {}
                who = ini.get("player") or ini.get("name") or ini.get("type") or "?"
                whom = tgt.get("player") or tgt.get("name") or tgt.get("type") or ""
                weapon = ev.get("weapon") or ""
                last = self.events[-1] if self.events else None
                key = (kind, who, whom, weapon)
                # Where the target was (the hook sends lat/lon when DCS knows it).
                tpos = _event_lonlat(tgt) if kind in ("hit", "kill") else None
                if (kind == "hit" and last is not None and last.get("_key") == key
                        and abs((ev.get("t") or 0) - last["time"]) < 3.0):
                    # Same shooter/target/weapon: count it instead of a new row
                    # (a gun burst can land dozens of hits a second).
                    last["count"] += 1
                    last["text"] = f"{who} hit {whom} x{last['count']}" + (f" ({weapon})" if weapon else "")
                    self.event_seq += 1
                    last["seq"] = self.event_seq
                    if tpos and "targetLon" not in last:
                        last["targetLon"], last["targetLat"] = tpos
                    continue
                self.event_seq += 1
                text = {
                    "hit": f"{who} hit {whom}" + (f" ({weapon})" if weapon else ""),
                    "kill": f"{who} killed {whom}" + (f" with {weapon}" if weapon else ""),
                    "shot": f"{who} fired {weapon}" + (f" at {whom}" if whom else ""),
                    "shooting_start": f"{who} guns ({weapon})",
                    "shooting_end": f"{who} guns stop",
                    "takeoff": f"{who} took off", "land": f"{who} landed", "crash": f"{who} crashed",
                    "ejection": f"{who} ejected", "dead": f"{who} destroyed", "pilot_dead": f"{who} pilot killed",
                }.get(kind, f"{kind} {who} {whom}".strip())
                row = {
                    "seq": self.event_seq, "id": self.event_seq, "time": ev.get("t") or self.time, "kind": f"DCS {kind}",
                    "objectIds": [], "names": [], "text": text, "source": "dcs", "count": 1, "_key": key,
                    "againstMe": self._is_me(tgt),
                }
                if tpos:
                    row["targetLon"], row["targetLat"] = tpos
                self.events.append(row)

    def _is_me(self, unit: Dict[str, Any]) -> bool:
        focus = self.objects.get(self.focus_id) if self.focus_id else None
        if not unit:
            return False
        names = {n for n in (unit.get("player"), unit.get("name")) if n}
        if focus is not None and names & {focus.props.get("Pilot"), focus.name}:
            return True
        return bool(self.player_names) and (unit.get("player") or "").lower() in self.player_names

    # -- DCS Export.lua bridge ------------------------------------------------

    def ingest_bridge(self, payload: Dict[str, Any]) -> None:
        """Merge one datagram from the DCS Export.lua bridge."""
        with self._lock:
            self.ownship = payload
            self.ownship_time = time.time()
            self.scan_values = scan_to_values(payload.get("scan"))
            if payload.get("world") is not None:
                self.world_radar = [
                    (str(o.get("name") or ""), float(o["lat"]), float(o["lon"]), bool(o.get("radar")))
                    for o in payload.get("world") or []
                    if isinstance(o.get("lat"), (int, float)) and isinstance(o.get("lon"), (int, float)) and "radar" in o
                ]
            if self.bridge_status.get("state") != "receiving":
                log.info("DCS bridge: receiving (%s)", (payload.get("self") or {}).get("name") or "own aircraft")
            self.bridge_status = {
                "state": "receiving",
                "packets": self.bridge_status.get("packets", 0) + 1,
                "last": self.ownship_time,
            }
            me = payload.get("self") or {}
            # My engines' fuel flow, for afterburner when the Tacview stream has none.
            flow = (payload.get("engine") or {}).get("flow") or {}
            parts = [x for x in (flow.get("left"), flow.get("right")) if _num(x)]
            own = self.objects.get(self._ownship_id() or "")
            if parts and own is not None and not _num(own.values.get("FuelFlowWeight")):
                self._feed_ab(own, self.time, sum(parts))
            # With no Tacview stream, synthesise objects so the map still works.
            acmi_live = self.status.get("state") == "connected" or self.status.get("source") == "replay"
            if acmi_live or "lat" not in me:
                return
            t = float(payload.get("t") or 0.0)
            self.time = t
            self._bridge_object("self", t, me, is_self=True)
            # The Export script sweeps the world once a second and re-sends that
            # sweep in every packet: applying a repeat at a later time would make
            # everything in it look stopped, then jump (speeds, weapon TTIs).
            world = payload.get("world")
            if world is None or world == self.bridge_world:
                return
            self.bridge_world = world
            for obj in world:
                oid = obj.get("id")
                if oid is None:
                    continue
                self._bridge_object(f"w{oid}", t, obj)
            seen = {f"w{o.get('id')}" for o in world}
            for oid in [k for k, o in self.objects.items() if o.source == "bridge" and oid_is_world(k) and k not in seen]:
                gone = self.objects.pop(oid)
                if gone.category in _SURFACE:
                    self.unit_index = None
                if gone.category == "weapon":
                    self._retire_weapon(gone, t)  # keeps its myWeapons row for IMPACT_KEEP

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
        obj.sub = _is_submunition(obj)
        vals = {
            "Longitude": d.get("lon"), "Latitude": d.get("lat"), "Altitude": d.get("alt"),
            "Yaw": d.get("hdg"), "Pitch": d.get("pitch"), "Roll": d.get("bank"),
            "IAS": d.get("ias"), "TAS": d.get("tas"), "Mach": d.get("mach"),
            "AOA": d.get("aoa"), "AOS": d.get("aos"), "AGL": d.get("agl"),
        }
        obj.values.update({k: float(v) for k, v in vals.items() if isinstance(v, (int, float))})
        if "radar" in d:
            obj.values["RadarActive"] = 1.0 if d.get("radar") else 0.0
        obj.last_update = t
        if obj.category in _SURFACE:
            self.unit_index = None
        self._track_motion(obj, t)
        self._note_weapon(obj, t)
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
        if not obj.trail or t - obj.trail[-1][0] >= (0.0 if obj.category == "round" else 0.5):
            obj.trail.append(cur)
        while obj.trail and t - obj.trail[0][0] > TRAIL_SECONDS:
            obj.trail.popleft()
        if obj.category in _AIR:
            # One point per HIST_STEP, but the newest fix is always the last one.
            h = obj.hist
            if len(h) >= 2 and t - h[-2][0] < HIST_STEP:
                h[-1] = cur
            else:
                h.append(cur)
            while h and t - h[0][0] > HIST_SECONDS:
                h.popleft()

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
            rounds = []
            bridge_fresh = (time.time() - self.ownship_time) < 3.0
            own_id = self._ownship_id() if bridge_fresh else None
            focus_obj = self.objects.get(self.focus_id) if self.focus_id else None
            fpos = focus_obj.position() if focus_obj else None
            # Bomblets: a dispenser can put hundreds in the air at once, so
            # only the newest MAX_LIVE_BOMBLETS are sent (enough to draw the
            # pattern forming).
            subs = [o for o in self.objects.values() if o.sub]
            skip_subs = set()
            if len(subs) > MAX_LIVE_BOMBLETS:
                subs.sort(key=lambda o: o.first_seen, reverse=True)
                skip_subs = {o.id for o in subs[MAX_LIVE_BOMBLETS:]}
            for obj in self.objects.values():
                if obj.category == "clutter" or obj.id in skip_subs:
                    continue
                if obj.category == "round":
                    pos = obj.position()
                    if pos is None:
                        continue
                    rounds.append({
                        "id": obj.id, "parent": obj.props.get("Parent"), "color": obj.props.get("Color"),
                        "coalition": obj.coalition, "lon": pos[0], "lat": pos[1], "alt": pos[2],
                        "trail": [[p[1], p[2], p[3]] for p in list(obj.trail)[-12:]],
                        # Nearest to me first; with no focus, the newest first.
                        "_d": geo.ground_distance(fpos[0], fpos[1], pos[0], pos[1]) if fpos else -obj.first_seen,
                    })
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
                if "EngagementRange" not in row["v"]:
                    db = _engagement_db(obj)
                    if db:
                        row["v"]["EngagementRange"] = db["range"]
                        if db.get("vrange"):
                            row["v"]["VerticalEngagementRange"] = db["vrange"]
                        row["engSrc"] = db["source"]
                if obj.sub:
                    row["sub"] = True
                if obj.dead:
                    row["dead"] = True
                if obj.category == "countermeasure":
                    row["cmKind"] = "chaff" if "Chaff" in obj.tags else "flare"
                    own = self.cm_owner.get(obj.id)
                    if own:
                        row["cmOwner"] = own[0]
                        row["cmOwnerSide"] = {"color": own[1], "coalition": own[2]}
                lock = obj.props.get("LockedTarget")
                if lock and v.get("LockedTargetMode", 1.0) > 0:
                    row["lock"] = lock
                if bridge_fresh:
                    if obj.id == own_id and self.scan_values:
                        # The bridge's scan zone is the player's own radar,
                        # whichever aircraft the view is focused on.
                        row["v"].update(self.scan_values)
                    elif obj.category in ("fixedwing", "rotorcraft", "air") and self.world_radar:
                        flag = _radar_flag_for(obj, pos, self.world_radar)
                        if flag is not None:
                            row["v"]["RadarActive"] = 1.0 if flag else 0.0
                # Bomblets are drawn as dots: 145 trails would be ~300 kB.
                if include_trails and obj.category in ("fixedwing", "rotorcraft", "air", "weapon") and not obj.sub:
                    step = 1 if obj.category == "weapon" else 2
                    row["trail"] = [[p[1], p[2], p[3]] for p in list(obj.trail)[::step]]
                objs.append(row)

            focus = self.objects.get(self.focus_id) if self.focus_id else None
            return {
                "time": self.time,
                "session": self.session,
                "wallclock": time.time(),
                "stale": (time.time() - self.wall_updated) > 5.0 if self.wall_updated else True,
                "status": dict(self.status),
                "bridge": dict(self.bridge_status),
                "globals": {k: v for k, v in self.globals.items() if k in ("Title", "ReferenceTime", "MapId", "DataSource")},
                "focus": self.focus_id,
                "focusLocked": self.focus_locked,
                "objects": objs,
                # Nearest rounds only: a gun fight can have hundreds in the air.
                "rounds": [{k: v for k, v in rd.items() if k != "_d"}
                           for rd in sorted(rounds, key=lambda x: x["_d"])[:MAX_LIVE_ROUNDS]],
                "events": [{k: v for k, v in e.items() if k != "_key"} for e in self.events if e["seq"] > since_event],
                "eventSeq": self.event_seq,
                "threats": self._threats(focus) if focus else [],
                "heat": self._heat(focus, own_id) if focus and focus.category in _AIR else None,
                "ownId": own_id,
                "ownship": self.ownship if (time.time() - self.ownship_time) < 3.0 else None,
                "destroyed": list(self.recently_destroyed)[-10:],
                # A focused SAM site's missiles are not air-to-ground releases.
                "myWeapons": self._my_weapons(focus) if focus and focus.category in _AIR else [],
            }

    def _heat(self, obj: LiveObject, own_id: Optional[str]) -> Optional[Dict[str, Any]]:
        """The focused jet's heat (DCS coefficients) and afterburner, from recorded data only."""
        af = IR.airframe(obj.name)
        if af is None:
            return None
        out: Dict[str, Any] = {"type": af["type"], "ir": af["ir"], "irAB": af["irAB"], "ab": None, "src": None}
        if af["irAB"] is None:
            out.update(ab=False, src="noAB")
            return out
        v = obj.values
        if _num(v.get("Afterburner")):
            out.update(ab=v["Afterburner"] > 0.05, src="Afterburner")
            return out
        ff, src = v.get("FuelFlowWeight"), "fuel flow"
        if not _num(ff) and own_id == obj.id:
            flow = ((self.ownship or {}).get("engine") or {}).get("flow") or {}
            parts = [x for x in (flow.get("left"), flow.get("right")) if _num(x)]
            ff = sum(parts) if parts else None
        tracker = self.ff_ab.get(obj.id)  # fed as the data arrives (_feed_ab)
        # Never the throttle: the F/A-18C records 1.00 all flight, the F-16C is in afterburner at 1.0.
        lit = tracker.lit(ff if _num(ff) else None) if tracker is not None else None
        if lit is not None:
            out.update(ab=lit, src=src)
        return out

    def _feed_ab(self, obj: LiveObject, t: float, ff: float) -> None:
        """One fuel-flow sample for an aircraft's afterburner tracker (once a second at most)."""
        v = obj.values
        airborne = (_num(v.get("AGL")) and v["AGL"] > 30) or (_num(v.get("IAS")) and v["IAS"] > 40)
        self.ff_ab.setdefault(obj.id, IR.FuelFlowAB()).add(t, ff, bool(airborne))

    def _ownship_id(self) -> Optional[str]:
        """The object that is the DCS player's own aircraft (bridge data)."""
        if "self" in self.objects:
            return "self"
        me = (self.ownship or {}).get("self") or {}
        pilot, lat, lon = me.get("pilot"), me.get("lat"), me.get("lon")
        best, best_d = None, 1500.0
        for obj in self.objects.values():
            if obj.category not in ("fixedwing", "rotorcraft", "air"):
                continue
            if pilot and obj.props.get("Pilot") == pilot:
                return obj.id
            pos = obj.position()
            if pos is not None and isinstance(lat, (int, float)) and isinstance(lon, (int, float)):
                d = geo.ground_distance(lon, lat, pos[0], pos[1])
                if d < best_d:
                    best, best_d = obj.id, d
        return best

    def _threats(self, me: LiveObject) -> List[Dict[str, Any]]:
        mp = me.position()
        if mp is None:
            return []
        my_hdg = me.heading() or 0.0
        out: List[Dict[str, Any]] = []
        for obj in self.objects.values():
            if obj.id == me.id or obj.sub or obj.category in ("clutter", "round", "countermeasure", "bullseye", "navaid", "misc"):
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
                row = {**base, "kind": "missile", "level": 3 if pointing else 2,
                       "tti": tti, "shooter": parent.name if parent else None,
                       "shooterPilot": parent.props.get("Pilot") if parent else None,
                       "text": "MISSILE"}
                sk = IR.seeker(obj.name)
                if sk is not None:
                    # A heat-seeker: no RWR warning, flares work; which part of me it sees.
                    row.update(ir=True, seeker=sk["short"], allAspect=sk["allAspect"], text="IR MISSILE")
                    tail = IR.tail_angle_from(mp, my_hdg if me.heading() is not None else None, me.values.get("Pitch"), op)
                    if tail is not None:
                        row["sees"], row["heatFactor"] = IR.seen_from(tail), round(IR.aspect_factor(tail), 2)
                out.append(row)
                continue

            if not _hostile(me, obj) or obj.dead:
                continue  # a destroyed SAM no longer threatens anyone
            locked_me = obj.props.get("LockedTarget") == me.id and obj.values.get("LockedTargetMode", 1.0) > 0
            db = _engagement_db(obj) or {}
            eng = obj.values.get("EngagementRange") or db.get("range")
            veng = obj.values.get("VerticalEngagementRange") or db.get("vrange") or eng
            # Inside the envelope both horizontally and vertically (a Shilka
            # cannot reach a jet 9 km above it).
            in_wez = bool(eng) and geo.ground_distance(mp[0], mp[1], op[0], op[1]) <= eng and (mp[2] - op[2]) <= veng
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
                row = {**base, "kind": "sam" if "AntiAircraft" in obj.tags else "surface",
                       "level": 2 if locked_me else 1, "spike": locked_me,
                       "engagementRange": eng, "inWez": in_wez,
                       "text": "SPIKE" if locked_me else "IN WEZ"}
                if IR.is_ir_sam(obj.name):
                    row["ir"] = True  # an IR SAM gives no RWR warning
                out.append(row)

        # Anything tracking me by lock, straight from the RWR, if the bridge sent it.
        out.sort(key=lambda d: (-d["level"], d.get("tti") or 1e9, d["range"]))
        return out[:30]

    # -- own weapons in flight ------------------------------------------------------

    def _note_weapon(self, obj: LiveObject, t: float) -> None:
        """Decide, once, which aircraft a newly seen weapon came off."""
        if obj.category != "weapon" or obj.sub or obj.id in self.launchers:
            return
        pos = obj.position()
        if pos is None:
            return
        parent = obj.props.get("Parent")
        if parent:
            self.launchers[obj.id] = parent
            return
        # No Parent (the DCS exporter often omits it): the nearest aircraft
        # where it was at that moment, as the offline analysis does.
        best, best_d = None, LAUNCHER_RADIUS
        for ac in self.objects.values():
            if ac.category not in _AIR or not _same_side(obj, ac):
                continue
            p = _position_at(ac, t)
            if p is None:
                continue
            d = geo.slant_range(pos[0], pos[1], pos[2], p[0], p[1], p[2])
            if d < best_d:
                best, best_d = ac.id, d
        self.launchers[obj.id] = best

    def _launcher_of(self, w: LiveObject) -> Optional[str]:
        return w.props.get("Parent") or self.launchers.get(w.id)

    def _surface_units(self) -> "_UnitIndex":
        # Cached: a rocket salvo retires dozens of weapons in one frame.
        if self.unit_index is None:
            self.unit_index = _UnitIndex(o for o in self.objects.values() if o.category in _SURFACE)
        return self.unit_index

    def _ground_under(self, jet: Optional[LiveObject]) -> float:
        """Ground elevation under a jet from its AGL (Tacview or the bridge), else 0."""
        if jet is None:
            return 0.0
        v = jet.values
        if _num(v.get("AGL")) and _num(v.get("Altitude")):
            return v["Altitude"] - v["AGL"]
        if (time.time() - self.ownship_time) < 3.0 and jet.id == self._ownship_id():
            me = (self.ownship or {}).get("self") or {}
            if _num(me.get("alt")) and _num(me.get("agl")):
                return float(me["alt"]) - float(me["agl"])
        return 0.0

    def _weapon_entry(self, w: LiveObject, owner: Optional[LiveObject], units, ground: float,
                      wrecks_since: Optional[float] = None) -> Optional[Dict[str, Any]]:
        """A myWeapons row: time to impact and impact point, extrapolated."""
        kind = weapon_kind(w.tags)
        if kind == "gun" or (kind == "missile" and _AIR_TO_AIR_RE.search(w.name)):
            return None
        fam = family(w.name, kind)
        d = w.derived
        entry: Dict[str, Any] = {
            "id": w.id, "name": w.name, "family": fam, "releasedAt": w.first_seen,
            "tti": None, "impactLon": None, "impactLat": None, "impactAlt": None,
            "targetId": None, "targetName": None, "gs": d.get("gs"), "vs": d.get("vs"),
            "estimated": True, "impacted": False,
        }
        pos = w.position()
        if pos is None or "gs" not in d or "vs" not in d:
            return entry  # first frame: no motion to extrapolate yet
        gs, vs = d["gs"], d["vs"]
        track = d.get("track") if gs > 1.0 else None
        if track is None:
            track = w.heading()
        tti, lon, lat = _predict_impact(fam, pos, gs, vs, track, ground)
        # The ground there, from the unit standing nearest the first guess.
        near = units.nearest(lon, lat, AIM_SEARCH)
        if near is not None:
            ground = near[1][2]
            tti, lon, lat = _predict_impact(fam, pos, gs, vs, track, ground)
        entry.update(tti=tti, impactLon=lon, impactLat=lat, impactAlt=ground)
        self._set_target(entry, owner or w, units, wrecks_since)
        return entry

    @staticmethod
    def _set_target(entry: Dict[str, Any], ref: LiveObject, units, wrecks_since: Optional[float] = None) -> None:
        """Nearest hostile unit to the impact.  Wrecks do not count (Tacview keeps
        them), except ones killed since *wrecks_since*: at impact, its own kill."""
        def keep(o: LiveObject) -> bool:
            if o.dead and (wrecks_since is None or o.died < wrecks_since):
                return False
            return _hostile(ref, o)
        tgt = units.nearest(entry["impactLon"], entry["impactLat"], AIM_TARGET_RADIUS, keep)
        entry["targetId"], entry["targetName"] = (tgt[0].id, tgt[0].name) if tgt else (None, None)

    def _retire_weapon(self, w: LiveObject, t: float) -> None:
        """A weapon disappeared: keep its final row for IMPACT_KEEP seconds."""
        launcher = self._launcher_of(w)
        self.launchers.pop(w.id, None)
        if w.sub:
            return
        self._prune_impacted(t)
        owner = self.objects.get(launcher) if launcher else None
        if owner is None or owner.category not in _AIR:
            return
        ground = self._ground_under(owner)
        units = self._surface_units()
        # DCS/Tacview may report the kill a moment before the weapon's removal.
        since = t - KILL_GRACE
        entry = self._weapon_entry(w, owner, units, ground, since)
        if entry is None:
            return
        pos = w.position()
        if pos is not None:
            aim = entry["impactAlt"] if entry["impactAlt"] is not None else ground
            dispenser = entry["family"] == "cluster" or bool(_JSOW_DISPENSER_RE.search(w.name))
            opened = dispenser and pos[2] - aim > DISPENSE_HEIGHT
            if opened or entry["tti"] is None:
                # A dispenser opening in the air (its bomblets show the
                # pattern), or never seen moving: where it vanished.
                entry.update(impactLon=pos[0], impactLat=pos[1], impactAlt=aim)
                self._set_target(entry, owner, units, since)
            if opened:
                entry["dispensed"] = True
        entry.update(tti=0.0, impacted=True)
        self.impacted[w.id] = (t, launcher, entry)

    def _prune_impacted(self, now: float) -> None:
        for wid, (t_gone, _, entry) in list(self.impacted.items()):
            keep = IMPACT_KEEP_DISPENSED if entry.get("dispensed") else IMPACT_KEEP
            if not (-1.0 <= now - t_gone <= keep):  # also a replay jumping back
                del self.impacted[wid]

    def _my_weapons(self, me: LiveObject) -> List[Dict[str, Any]]:
        """The focus jet's weapons in flight, plus the ones that just landed."""
        self._prune_impacted(self.time)
        mine = [w for w in self.objects.values()
                if w.category == "weapon" and not w.sub and self._launcher_of(w) == me.id]
        out: List[Dict[str, Any]] = []
        if mine:
            units = self._surface_units()
            ground = self._ground_under(me)
            for w in mine:
                entry = self._weapon_entry(w, me, units, ground)
                if entry is not None:
                    out.append(entry)
        out.extend(dict(e) for wid, (_, launcher, e) in self.impacted.items()
                   if launcher == me.id and wid not in self.objects)
        out.sort(key=lambda e: e["releasedAt"])
        return out


def _position_at(obj: LiveObject, t: float) -> Optional[Tuple[float, float, float]]:
    """Where an aircraft was at time t, from its short position history."""
    h = obj.hist
    if not h:
        return obj.position()
    last = h[-1]
    if t >= last[0]:
        # A weapon's first frame can arrive before its launcher's: dead-reckon.
        lon, lat, alt = last[1], last[2], last[3]
        dt, d = min(t - last[0], 2.0), obj.derived
        if dt > 0 and d.get("gs") and d.get("track") is not None:
            lon, lat = geo.destination(lon, lat, d["track"], d["gs"] * dt)
            alt += d.get("vs", 0.0) * dt
        return lon, lat, alt
    nxt = last
    for p in reversed(h):
        if p[0] <= t:
            f = (t - p[0]) / (nxt[0] - p[0]) if nxt[0] > p[0] else 0.0
            return tuple(p[i] + (nxt[i] - p[i]) * f for i in (1, 2, 3))
        nxt = p
    return h[0][1], h[0][2], h[0][3]


def _predict_impact(fam: str, pos: Tuple[float, float, float], gs: float, vs: float,
                    track: Optional[float], ground: float) -> Tuple[float, float, float]:
    """(time to impact, lon, lat) of a weapon reaching altitude *ground*.

    Glide weapons keep their glide slope and powered missiles fly a straight
    line, both at least MIN_GLIDE_DEG down; everything else falls in a vacuum.
    """
    h = pos[2] - ground
    if h <= 0.0:
        return 0.0, pos[0], pos[1]
    slope = -vs / gs if gs > 1.0 else None  # descent per metre travelled
    guided = fam in _GLIDE_FAMILIES or fam in _POWERED_FAMILIES
    if guided and slope is not None:
        # A missile level or lofting (or nearly so: 1 m/s down would put the
        # impact hours away) is assumed to come down like a glider.
        t = h / max(slope, math.tan(math.radians(MIN_GLIDE_DEG))) / gs
    elif fam in _POWERED_FAMILIES and vs < 0.0:
        t = h / -vs
    else:
        t = (vs + math.sqrt(vs * vs + 2.0 * G * h)) / G  # vs positive up
    dist = gs * t
    if track is None or dist <= 0.0:
        return t, pos[0], pos[1]
    lon, lat = geo.destination(pos[0], pos[1], track, dist)
    return t, lon, lat


class _UnitIndex:
    """Surface units bucketed on a lat/lon grid: a rocket salvo in a mission
    with thousands of units would otherwise cost ~100 ms per snapshot."""

    CELL = 0.05  # degrees (~5.5 km north-south)

    def __init__(self, objs) -> None:
        self.cells: Dict[Tuple[int, int], List[Tuple[LiveObject, Tuple[float, float, float]]]] = {}
        for obj in objs:
            pos = obj.position()
            if pos is not None:
                key = (math.floor(pos[1] / self.CELL), math.floor(pos[0] / self.CELL))
                self.cells.setdefault(key, []).append((obj, pos))

    def nearest(self, lon: float, lat: float, radius: float, keep=None):
        """The nearest (unit, position) within *radius* m that passes *keep*, else None."""
        c = self.CELL
        dlat = radius * 1.02 / geo.M_PER_DEG_LAT  # small margin: the box is flat, distances are not
        dlon = radius * 1.02 / max(geo.m_per_deg_lon(lat), 1000.0)
        best, best_d = None, radius
        for i in range(math.floor((lat - dlat) / c), math.floor((lat + dlat) / c) + 1):
            for j in range(math.floor((lon - dlon) / c), math.floor((lon + dlon) / c) + 1):
                for obj, pos in self.cells.get((i, j), ()):
                    if keep is not None and not keep(obj):
                        continue
                    d = geo.ground_distance(lon, lat, pos[0], pos[1])
                    if d < best_d:
                        best, best_d = (obj, pos), d
        return best


def _num(v: Any) -> bool:
    return isinstance(v, (int, float)) and not isinstance(v, bool) and math.isfinite(v)


def _event_lonlat(unit: Dict[str, Any]) -> Optional[Tuple[float, float]]:
    lon, lat = unit.get("lon"), unit.get("lat")
    if _num(lon) and _num(lat) and -180.0 <= lon <= 180.0 and -90.0 <= lat <= 90.0:
        return float(lon), float(lat)
    return None


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


def scan_to_values(scan: Any) -> Dict[str, float]:
    """Bridge scan zone -> the channel names radarVolume() understands."""
    if not isinstance(scan, dict):
        return {}
    out: Dict[str, float] = {}
    for src, dst in (("azHalf", "ScanAz"), ("elHalf", "ScanEl"), ("centerAz", "ScanCenterAz"),
                     ("centerEl", "ScanCenterEl"), ("range", "RadarRange")):
        v = scan.get(src)
        if isinstance(v, (int, float)) and v == v:
            out[dst] = float(v)
    if isinstance(scan.get("on"), bool):
        out["RadarActive"] = 1.0 if scan["on"] else 0.0
        if not scan["on"]:
            out.pop("ScanAz", None)  # radar off: no volume
    return out


def _radar_flag_for(obj: "LiveObject", pos, world: List[Tuple[str, float, float, bool]]) -> Optional[bool]:
    """Match a Tacview object to DCS's per-unit radar flag by type and position."""
    best, best_d = None, 2000.0
    for name, lat, lon, radar in world:
        if name and name != obj.name:
            continue
        d = geo.ground_distance(pos[0], pos[1], lon, lat)
        if d < best_d:
            best, best_d = radar, d
    return best


def _engagement_db(obj: "LiveObject") -> Optional[Dict[str, Any]]:
    """Engagement range from Tacview's database, for SAM/AAA/ship types."""
    if obj.category not in ("ground", "sea"):
        return None
    return threatdb.lookup(obj.name)


def oid_is_world(oid: str) -> bool:
    return oid.startswith("w")


_LIVE_CHANNELS = (
    "Roll", "Pitch", "Yaw", "IAS", "TAS", "Mach", "AOA", "AOS", "AGL", "HDG", "HDM",
    "Throttle", "Throttle2", "Afterburner", "AirBrakes", "Flaps", "LandingGear", "Tailhook",
    "FuelWeight", "FuelWeight2", "RadarMode", "RadarAzimuth", "RadarElevation", "RadarRange",
    "RadarHorizontalBeamwidth", "RadarVerticalBeamwidth", "LockedTargetMode",
    "LockedTargetAzimuth", "LockedTargetElevation", "LockedTargetRange", "EngagementRange",
    "VerticalEngagementRange", "EngagementMode", "Health", "VerticalGForce", "PitchControlInput", "RollControlInput",
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
        if l1 == 4:  # wsType_Weapon: level2 4 missile, 5 bomb, 6 shell, 7 rocket (NURS)
            return {5: "Weapon+Bomb", 6: "Projectile+Shell", 7: "Weapon+Rocket"}.get(l2, "Weapon+Missile")
    return "Misc"
