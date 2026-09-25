"""Streaming ACMI 2.x parser.

The parser is a pure line pump: feed it logical lines, it calls a sink.  The
same code therefore drives both offline file analysis and the live Tacview
real-time telemetry stream, so a bug fixed in one is fixed in both.
"""

from __future__ import annotations

import math
from typing import Any, Callable, Dict, List, Optional, Protocol, Tuple

from . import props as P
from . import types as T
from .model import Event, Recording, Track
from .reader import iter_lines, uncompressed_size

NAN = float("nan")

#: How a ``T=`` field's slots map onto channel names, keyed by slot count.
_TRANSFORM_LAYOUTS: Dict[int, Tuple[str, ...]] = {
    3: ("Longitude", "Latitude", "Altitude"),
    5: ("Longitude", "Latitude", "Altitude", "U", "V"),
    6: ("Longitude", "Latitude", "Altitude", "Roll", "Pitch", "Yaw"),
    9: ("Longitude", "Latitude", "Altitude", "Roll", "Pitch", "Yaw", "U", "V", "Heading"),
}

_HEX_DIGITS = set("0123456789abcdefABCDEF")


def norm_id(raw: str) -> str:
    """Canonical object id: upper-case hex with no leading zeros."""
    s = raw.strip().upper()
    if not s:
        return ""
    stripped = s.lstrip("0")
    return stripped or "0"


def looks_like_id(raw: str) -> bool:
    s = raw.strip()
    return bool(s) and len(s) <= 16 and all(c in _HEX_DIGITS for c in s)


def unescape(value: str) -> str:
    r"""Undo ACMI escaping (``\,`` ``\|`` ``\\`` and a trailing newline join)."""
    if "\\" not in value:
        return value
    out: List[str] = []
    i = 0
    n = len(value)
    while i < n:
        ch = value[i]
        if ch == "\\" and i + 1 < n:
            nxt = value[i + 1]
            if nxt in (",", "|", "\\"):
                out.append(nxt)
                i += 2
                continue
            if nxt == "n":
                out.append("\n")
                i += 2
                continue
            if nxt == "\n":
                out.append("\n")
                i += 2
                continue
        out.append(ch)
        i += 1
    return "".join(out)


def split_unescaped(text: str, sep: str) -> List[str]:
    """Split on *sep*, honouring backslash escapes."""
    if "\\" not in text:
        return text.split(sep)
    parts: List[str] = []
    buf: List[str] = []
    i = 0
    n = len(text)
    while i < n:
        ch = text[i]
        if ch == "\\" and i + 1 < n:
            buf.append(ch)
            buf.append(text[i + 1])
            i += 2
            continue
        if ch == sep:
            parts.append("".join(buf))
            buf = []
            i += 1
            continue
        buf.append(ch)
        i += 1
    parts.append("".join(buf))
    return parts


def _to_float(raw: str) -> float:
    try:
        return float(raw)
    except ValueError:
        return NAN


class AcmiSink(Protocol):
    """What the parser reports.  All times are seconds from ReferenceTime."""

    def on_global(self, t: float, values: Dict[str, Any]) -> None: ...
    def on_object(self, t: float, obj_id: str, numeric: Dict[str, float], text: Dict[str, str]) -> None: ...
    def on_remove(self, t: float, obj_id: str) -> None: ...
    def on_event(self, event: Event) -> None: ...
    def on_frame(self, t: float) -> None: ...


class AcmiParser:
    """Feed it logical ACMI lines; it decodes and forwards to a sink."""

    def __init__(self, sink: AcmiSink) -> None:
        self.sink = sink
        self.time: float = 0.0
        self.ref_lon: float = 0.0
        self.ref_lat: float = 0.0
        self.file_type: Optional[str] = None
        self.file_version: Optional[str] = None
        self.warnings: List[str] = []
        self._warned: set[str] = set()
        self.lines_parsed: int = 0

    # -- diagnostics -------------------------------------------------------

    def _warn(self, key: str, message: str) -> None:
        if key in self._warned:
            return
        self._warned.add(key)
        self.warnings.append(message)

    # -- entry point -------------------------------------------------------

    def feed(self, line: str) -> None:
        if not line:
            return
        first = line[0]

        if first == "#":
            try:
                self.time = float(line[1:])
            except ValueError:
                self._warn("badframe", f"Malformed time frame: {line[:40]!r}")
                return
            self.sink.on_frame(self.time)
            return

        if first == "/" and line.startswith("//"):
            return

        if first == "-":
            obj_id = norm_id(line[1:])
            if obj_id:
                self.sink.on_remove(self.time, obj_id)
            return

        if line.startswith("FileType="):
            self.file_type = line.partition("=")[2].strip()
            return
        if line.startswith("FileVersion="):
            self.file_version = line.partition("=")[2].strip()
            return

        self.lines_parsed += 1
        fields = split_unescaped(line, ",")
        obj_id = norm_id(fields[0])
        if not obj_id:
            return
        if obj_id == "0":
            self._feed_global(fields[1:])
        else:
            self._feed_object(obj_id, fields[1:])

    def feed_many(self, lines) -> None:
        for line in lines:
            self.feed(line)

    # -- record handling ---------------------------------------------------

    def _feed_global(self, fields: List[str]) -> None:
        values: Dict[str, Any] = {}
        for field in fields:
            key, sep, raw = field.partition("=")
            if not sep:
                continue
            key = key.strip()
            if key == "Event":
                self.sink.on_event(self._decode_event(raw))
                continue
            value = unescape(raw)
            if key in P.GLOBAL_NUMERIC:
                num = _to_float(value)
                if key == "ReferenceLongitude":
                    self.ref_lon = 0.0 if math.isnan(num) else num
                elif key == "ReferenceLatitude":
                    self.ref_lat = 0.0 if math.isnan(num) else num
                values[key] = num
            else:
                values[key] = value
        if values:
            self.sink.on_global(self.time, values)

    def _decode_event(self, raw: str) -> Event:
        parts = [unescape(p) for p in split_unescaped(raw, "|")]
        kind = parts[0].strip() if parts else "Unknown"
        rest = parts[1:]
        text = rest[-1] if rest else ""
        ids = [norm_id(p) for p in rest[:-1] if looks_like_id(p)]
        return Event(time=self.time, kind=kind, object_ids=ids, text=text.strip())

    def _feed_object(self, obj_id: str, fields: List[str]) -> None:
        numeric: Dict[str, float] = {}
        text: Dict[str, str] = {}

        for field in fields:
            key, sep, raw = field.partition("=")
            if not sep:
                continue
            key = key.strip()

            if key == "T":
                self._decode_transform(raw, numeric)
                continue

            value = unescape(raw)
            if key in P.REFERENCE_PROPS:
                text[key] = norm_id(value) if looks_like_id(value) else value
            elif P.is_numeric(key):
                numeric[key] = _to_float(value)
            elif key in P.OBJECT_TEXT:
                text[key] = value
            else:
                # Unknown property: keep it as text so nothing is silently lost.
                self._warn(f"prop:{key}", f"Unknown property {key!r}; stored as text")
                text[key] = value

        if numeric or text:
            self.sink.on_object(self.time, obj_id, numeric, text)

    def _decode_transform(self, raw: str, numeric: Dict[str, float]) -> None:
        slots = raw.split("|")
        layout = _TRANSFORM_LAYOUTS.get(len(slots))
        if layout is None:
            self._warn(
                f"tf:{len(slots)}",
                f"Unexpected transform with {len(slots)} components; using first 3",
            )
            layout = _TRANSFORM_LAYOUTS[3]
            slots = slots[:3]
            if len(slots) < 3:
                return
        for name, slot in zip(layout, slots):
            if not slot:
                continue  # empty slot means "unchanged"
            value = _to_float(slot)
            if math.isnan(value):
                continue
            if name == "Longitude":
                value += self.ref_lon
            elif name == "Latitude":
                value += self.ref_lat
            numeric[name] = value


class RecordingBuilder:
    """Sink that assembles a full :class:`Recording` in memory."""

    def __init__(self, recording: Optional[Recording] = None) -> None:
        self.recording = recording or Recording()
        self._started = False

    # AcmiSink -------------------------------------------------------------

    def on_frame(self, t: float) -> None:
        rec = self.recording
        if not self._started:
            rec.start_time = t
            self._started = True
        if t > rec.end_time:
            rec.end_time = t

    def on_global(self, t: float, values: Dict[str, Any]) -> None:
        self.recording.globals.update(values)

    def on_object(self, t: float, obj_id: str, numeric: Dict[str, float], text: Dict[str, str]) -> None:
        rec = self.recording
        track = rec.tracks.get(obj_id)
        if track is None:
            track = Track(obj_id, t)
            rec.tracks[obj_id] = track
        track.append(t, numeric, text)
        if t > rec.end_time:
            rec.end_time = t

    def on_remove(self, t: float, obj_id: str) -> None:
        track = self.recording.tracks.get(obj_id)
        if track is not None:
            track.removed_at = t
            track.last_seen = max(track.last_seen, t)

    def on_event(self, event: Event) -> None:
        self.recording.events.append(event)

    # ----------------------------------------------------------------------

    def finish(self) -> Recording:
        rec = self.recording
        for track in rec.tracks.values():
            track.finalize()
        if rec.tracks:
            rec.end_time = max(rec.end_time, max(tr.last_seen for tr in rec.tracks.values()))
        for track in rec.tracks.values():
            track.end_time = track.removed_at if track.removed_at is not None else rec.end_time
        return rec


ProgressFn = Callable[[int, int], None]


def parse_file(path: str, progress: Optional[ProgressFn] = None) -> Recording:
    """Parse an ACMI recording from disk into a :class:`Recording`.

    *progress*, if given, is called periodically with (bytes_done, bytes_total)
    measured against the uncompressed text.
    """
    builder = RecordingBuilder()
    parser = AcmiParser(builder)
    total = uncompressed_size(path)
    done = 0

    for i, line in enumerate(iter_lines(path)):
        parser.feed(line)
        done += len(line) + 1
        if progress is not None and i % 50000 == 0:
            progress(done, total)

    rec = builder.finish()
    if progress is not None:
        progress(total, total)
    rec.source_path = str(path)
    rec.parse_warnings = list(parser.warnings)
    if parser.file_type and "acmi" not in parser.file_type.lower():
        rec.parse_warnings.insert(0, f"Unexpected FileType={parser.file_type!r}")
    return rec
