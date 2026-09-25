"""In-memory representation of a parsed ACMI recording.

Telemetry is stored column-wise: each object owns one time vector plus a
dense ``array('d')`` per channel.  ACMI is a delta format - a property keeps
its value until it changes - so columns are forward-filled, which makes
"what was the state at time t" a bisect instead of a scan.
"""

from __future__ import annotations

import bisect
import math
from array import array
from dataclasses import dataclass, field
from datetime import datetime, timedelta, timezone
from typing import Any, Dict, FrozenSet, Iterable, List, Optional

from . import props as P
from . import types as T

NAN = float("nan")

#: Channels retained for objects that are not crewed aircraft.  Ground units
#: and ordnance vastly outnumber aircraft in a busy recording and we only
#: ever plot their position and health.
BASIC_CHANNELS = frozenset(P.TRANSFORM_CHANNELS) | {
    "Health", "Disabled", "Visible", "AGL", "IAS", "TAS", "Mach",
    "EngagementRange", "EngagementMode", "VerticalEngagementRange",
    "RadarMode", "RadarRange", "RadarAzimuth", "RadarElevation",
    "RadarHorizontalBeamwidth", "RadarVerticalBeamwidth", "LockedTargetMode",
}


@dataclass(slots=True)
class Event:
    """One ``0,Event=...`` record."""

    time: float
    kind: str
    object_ids: List[str] = field(default_factory=list)
    text: str = ""

    def to_dict(self) -> Dict[str, Any]:
        return {
            "time": self.time,
            "kind": self.kind,
            "objectIds": list(self.object_ids),
            "text": self.text,
        }


class Track:
    """Everything recorded about a single ACMI object."""

    __slots__ = (
        "id", "props", "tags", "category", "first_seen", "last_seen",
        "removed_at", "end_time", "t", "channels", "text_history", "_detailed", "_sample_count",
    )

    def __init__(self, obj_id: str, t0: float) -> None:
        self.id = obj_id
        self.props: Dict[str, str] = {}
        self.tags: FrozenSet[str] = frozenset()
        self.category: str = "misc"
        self.first_seen: float = t0
        self.last_seen: float = t0
        self.removed_at: Optional[float] = None
        #: When the object stops existing: its removal, or the end of the
        #: recording.  An object that never updates after spawning (a SAM
        #: site, a parked jet) is alive the whole time.
        self.end_time: Optional[float] = None
        self.t: array = array("d")
        self.channels: Dict[str, array] = {}
        #: Every change to a text property as (time, value), oldest first.
        #: Text properties are sparse (Name is set once, LockedTarget changes
        #: a handful of times) so a change log is far cheaper than a column.
        self.text_history: Dict[str, List[tuple[float, str]]] = {}
        self._detailed: bool = True
        self._sample_count: int = 0

    # -- construction ------------------------------------------------------

    def _set_type(self, type_str: str) -> None:
        self.tags = T.parse_tags(type_str)
        self.category = T.category(self.tags)
        self._detailed = self.category in T.DETAILED_CATEGORIES
        if not self._detailed:
            for name in [c for c in self.channels if c not in BASIC_CHANNELS]:
                del self.channels[name]

    def _wants(self, channel: str) -> bool:
        return self._detailed or channel in BASIC_CHANNELS

    def append(self, t: float, numeric: Dict[str, float], text: Dict[str, str]) -> None:
        """Record one sample.  *numeric* holds only the values that changed."""
        if text:
            for key, value in text.items():
                hist = self.text_history.get(key)
                if hist is None:
                    self.text_history[key] = [(t, value)]
                elif hist[-1][1] != value:
                    hist.append((t, value))
            self.props.update(text)
            if "Type" in text:
                self._set_type(text["Type"])

        idx = self._sample_count
        self.t.append(t)
        self._sample_count = idx + 1
        self.last_seen = t

        for name, value in numeric.items():
            if not self._wants(name):
                continue
            col = self.channels.get(name)
            if col is None:
                col = array("d", [NAN]) * idx if idx else array("d")
                if idx and len(col) != idx:  # pragma: no cover - defensive
                    col = array("d", [NAN] * idx)
                self.channels[name] = col
            # Forward-fill any frames this channel sat out.
            missing = idx - len(col)
            if missing > 0:
                last = col[-1] if col else NAN
                col.extend([last] * missing)
            col.append(value)

    def finalize(self) -> None:
        """Pad every column out to the full sample count."""
        n = self._sample_count
        for col in self.channels.values():
            missing = n - len(col)
            if missing > 0:
                last = col[-1] if col else NAN
                col.extend([last] * missing)

    # -- queries -----------------------------------------------------------

    def __len__(self) -> int:
        return self._sample_count

    @property
    def name(self) -> str:
        return self.props.get("Name") or self.props.get("ShortName") or self.id

    @property
    def pilot(self) -> Optional[str]:
        return self.props.get("Pilot")

    @property
    def coalition(self) -> str:
        return self.props.get("Coalition", "Unknown")

    @property
    def display_name(self) -> str:
        pilot = self.pilot
        return f"{pilot} ({self.name})" if pilot else self.name

    def index_at(self, t: float) -> int:
        """Index of the most recent sample at or before *t* (0 if before start)."""
        if not self._sample_count:
            return -1
        i = bisect.bisect_right(self.t, t) - 1
        return max(i, 0)

    @property
    def ends_at(self) -> float:
        if self.removed_at is not None:
            return self.removed_at
        if self.end_time is not None:
            return self.end_time
        return self.last_seen

    def alive_at(self, t: float, grace: float = 0.0) -> bool:
        if not self._sample_count:
            return False
        return self.first_seen - 1e-9 <= t <= self.ends_at + grace

    def text_at(self, name: str, t: float) -> Optional[str]:
        """Value of a text property as it stood at time *t*."""
        hist = self.text_history.get(name)
        if not hist:
            return None
        lo, hi = 0, len(hist)
        while lo < hi:
            mid = (lo + hi) // 2
            if hist[mid][0] <= t:
                lo = mid + 1
            else:
                hi = mid
        return hist[lo - 1][1] if lo else None

    def channel(self, name: str) -> Optional[array]:
        return self.channels.get(name)

    def value_at(self, name: str, t: float) -> float:
        col = self.channels.get(name)
        if col is None:
            return NAN
        i = self.index_at(t)
        if i < 0 or i >= len(col):
            return NAN
        return col[i]

    def series(self, name: str) -> List[float]:
        col = self.channels.get(name)
        return list(col) if col is not None else []

    def state_at(self, t: float) -> Dict[str, float]:
        i = self.index_at(t)
        if i < 0:
            return {}
        out: Dict[str, float] = {}
        for name, col in self.channels.items():
            if i < len(col):
                v = col[i]
                if not math.isnan(v):
                    out[name] = v
        return out

    def position_at(self, t: float) -> Optional[tuple[float, float, float]]:
        lon = self.value_at("Longitude", t)
        lat = self.value_at("Latitude", t)
        alt = self.value_at("Altitude", t)
        if math.isnan(lon) or math.isnan(lat):
            return None
        return (lon, lat, 0.0 if math.isnan(alt) else alt)

    def position_interp(self, t: float) -> Optional[tuple[float, float, float]]:
        """Position at *t*, linearly interpolated between recorded samples.

        :meth:`position_at` holds the last sample, which is right for "what
        did the recording say" but wrong for geometry against fast objects: a
        200 m/s jet sampled at 2 Hz is up to 100 m from its last sample.
        """
        n = self._sample_count
        if not n:
            return None
        i = bisect.bisect_right(self.t, t) - 1
        if i < 0 or i >= n - 1:
            return self.position_at(t)
        t0, t1 = self.t[i], self.t[i + 1]
        lon, lat, alt = self.channels.get("Longitude"), self.channels.get("Latitude"), self.channels.get("Altitude")
        if lon is None or lat is None:
            return None
        f = (t - t0) / (t1 - t0) if t1 > t0 else 0.0
        vals = []
        for col in (lon, lat, alt):
            if col is None:
                vals.append(0.0)
                continue
            a, b = col[i], col[i + 1]
            if math.isnan(a):
                return self.position_at(t)
            vals.append(a if math.isnan(b) else a + (b - a) * f)
        return vals[0], vals[1], vals[2]

    def summary(self) -> Dict[str, Any]:
        return {
            "id": self.id,
            "name": self.name,
            "pilot": self.pilot,
            "group": self.props.get("Group"),
            "callsign": self.props.get("CallSign"),
            "coalition": self.coalition,
            "country": self.props.get("Country"),
            "color": self.props.get("Color"),
            "type": self.props.get("Type"),
            "category": self.category,
            "parent": self.props.get("Parent"),
            "firstSeen": self.first_seen,
            "lastSeen": self.last_seen,
            "removedAt": self.removed_at,
            "endsAt": self.ends_at,
            "samples": self._sample_count,
            "channels": sorted(self.channels.keys()),
        }


class Recording:
    """A parsed ACMI file: global metadata, object tracks and events."""

    def __init__(self) -> None:
        self.globals: Dict[str, Any] = {}
        self.tracks: Dict[str, Track] = {}
        self.events: List[Event] = []
        self.start_time: float = 0.0
        self.end_time: float = 0.0
        self.source_path: Optional[str] = None
        self.parse_warnings: List[str] = []
        # Data merged in from outside the ACMI (e.g. DCS flight logs).
        self.extras: Dict[str, Any] = {}

    # -- metadata ----------------------------------------------------------

    @property
    def reference_time(self) -> Optional[datetime]:
        raw = self.globals.get("ReferenceTime")
        if not raw:
            return None
        return _parse_iso8601(str(raw))

    @property
    def duration(self) -> float:
        return max(0.0, self.end_time - self.start_time)

    @property
    def title(self) -> str:
        return str(self.globals.get("Title") or "Untitled mission")

    def wall_clock(self, t: float) -> Optional[datetime]:
        ref = self.reference_time
        if ref is None:
            return None
        return ref + timedelta(seconds=t)

    # -- lookups -----------------------------------------------------------

    def track(self, obj_id: str) -> Optional[Track]:
        return self.tracks.get(obj_id)

    def iter_category(self, *categories: str) -> Iterable[Track]:
        wanted = set(categories)
        return (tr for tr in self.tracks.values() if tr.category in wanted)

    def aircraft(self) -> List[Track]:
        return [tr for tr in self.tracks.values() if T.is_aircraft(tr.tags)]

    def players(self) -> List[Track]:
        """Aircraft flown by a human - DCS puts the player name in ``Pilot``."""
        return [tr for tr in self.aircraft() if tr.pilot]

    def weapons(self) -> List[Track]:
        return [tr for tr in self.tracks.values() if tr.category == "weapon"]

    def bullseye(self) -> Optional[Track]:
        for tr in self.tracks.values():
            if T.is_bullseye(tr.tags):
                return tr
        return None

    def alive_at(self, t: float, grace: float = 0.0) -> List[Track]:
        return [tr for tr in self.tracks.values() if tr.alive_at(t, grace)]

    def events_between(self, t0: float, t1: float) -> List[Event]:
        return [e for e in self.events if t0 <= e.time <= t1]

    def summary(self) -> Dict[str, Any]:
        ref = self.reference_time
        return {
            "title": self.title,
            "source": self.source_path,
            "globals": {k: v for k, v in self.globals.items()},
            "referenceTime": ref.isoformat() if ref else None,
            "startTime": self.start_time,
            "endTime": self.end_time,
            "duration": self.duration,
            "objectCount": len(self.tracks),
            "aircraftCount": len(self.aircraft()),
            "eventCount": len(self.events),
            "warnings": self.parse_warnings[:50],
        }


def _parse_iso8601(raw: str) -> Optional[datetime]:
    text = raw.strip()
    if not text:
        return None
    if text.endswith("Z"):
        text = text[:-1] + "+00:00"
    # Tacview writes fractional seconds with variable precision.
    try:
        dt = datetime.fromisoformat(text)
    except ValueError:
        for fmt in ("%Y-%m-%dT%H:%M:%S", "%Y-%m-%d %H:%M:%S", "%Y-%m-%dT%H:%M:%S.%f"):
            try:
                dt = datetime.strptime(raw.strip().rstrip("Z"), fmt)
                break
            except ValueError:
                continue
        else:
            return None
    if dt.tzinfo is None:
        dt = dt.replace(tzinfo=timezone.utc)
    return dt
