"""Flight recorder: what DCS itself reported during a flight.

While DCS runs, the Export.lua bridge (your aircraft) and the hook (DCS
combat events) stream to the app.  Everything worth keeping is written to a
JSON-lines file per session in ``Documents/DCS-SA/flightlogs``, so a later
debrief of the matching Tacview recording can use the values DCS actually
reported - real hits and kills, control deflections, radar scan zone - rather
than estimating them from the recording's geometry.
"""

from __future__ import annotations

import json
import logging
import threading
import time
from pathlib import Path
from typing import IO, Any, Dict, List, Optional

log = logging.getLogger(__name__)

SELF_RATE_HZ = 4.0
NEW_SESSION_GAP_S = 120.0


def _num(v: Any) -> Optional[float]:
    return float(v) if isinstance(v, (int, float)) and v == v else None


def compact_self(payload: Dict[str, Any]) -> Optional[Dict[str, Any]]:
    """Reduce a bridge packet to what the debrief uses."""
    me = payload.get("self") or {}
    if _num(me.get("lat")) is None:
        return None
    row: Dict[str, Any] = {"t": _num(payload.get("t"))}
    for k in ("lat", "lon", "alt", "hdg", "pitch", "bank", "ias", "tas", "mach", "aoa", "vs", "agl"):
        v = _num(me.get(k))
        if v is not None:
            row[k] = round(v, 6 if k in ("lat", "lon") else 2)
    g = me.get("g")
    if isinstance(g, dict) and _num(g.get("y")) is not None:
        row["g"] = round(g["y"], 2)
    c = payload.get("controls")
    if isinstance(c, dict):
        row["ctl"] = {k: round(c[k], 3) for k in ("pitch", "roll", "yaw", "throttle") if _num(c.get(k)) is not None}
    scan = payload.get("scan")
    if isinstance(scan, dict):
        row["scan"] = {k: v for k, v in scan.items() if _num(v) is not None or isinstance(v, bool)}
    cm = payload.get("cm")
    if isinstance(cm, dict):
        row["cm"] = {k: cm.get(k) for k in ("chaff", "flare")}
    pl = payload.get("payload")
    if isinstance(pl, dict) and _num(pl.get("gun")) is not None:
        row["gun"] = pl["gun"]
    return row


class FlightRecorder:
    def __init__(self, directory: str) -> None:
        self.dir = Path(directory)
        self._lock = threading.Lock()
        self._fh: Optional[IO[str]] = None
        self.path: Optional[Path] = None
        self._last_wall = 0.0
        self._last_t: Optional[float] = None
        self._last_self_wall = 0.0
        self.meta: Dict[str, Any] = {}
        self.enabled = True
        self._last_world_wall = 0.0

    # -- session handling ------------------------------------------------------

    def _open(self, reason: str) -> None:
        self._close()
        self.dir.mkdir(parents=True, exist_ok=True)
        stamp = time.strftime("%Y%m%d-%H%M%S", time.gmtime())
        self.path = self.dir / f"flight-{stamp}.jsonl"
        n = 1
        while self.path.exists():
            self.path = self.dir / f"flight-{stamp}-{n}.jsonl"
            n += 1
        self._fh = open(self.path, "a", encoding="utf-8")
        self._write({"k": "meta", "reason": reason, **self.meta})
        log.info("flight log %s", self.path)

    def _close(self) -> None:
        if self._fh is not None:
            try:
                self._fh.close()
            except OSError:
                pass
        self._fh = None

    def _write(self, row: Dict[str, Any]) -> None:
        if self._fh is None:
            return
        row.setdefault("wall", round(time.time(), 3))
        self._fh.write(json.dumps(row, separators=(",", ":")) + "\n")
        self._fh.flush()

    def _session_for(self, t: Optional[float]) -> None:
        now = time.time()
        restart = (
            self._fh is None
            or now - self._last_wall > NEW_SESSION_GAP_S
            or (t is not None and self._last_t is not None and t < self._last_t - 5.0)
        )
        if restart:
            self._open("mission restart" if self._fh is not None else "start")
        self._last_wall = now
        if t is not None:
            self._last_t = t

    # -- inputs ------------------------------------------------------------------

    def on_hook_hello(self, packet: Dict[str, Any]) -> None:
        if packet.get("theatre"):
            self.meta["theatre"] = packet["theatre"]

    def on_bridge(self, payload: Dict[str, Any]) -> None:
        if not self.enabled:
            return
        row = compact_self(payload)
        if row is None:
            return
        with self._lock:
            now = time.time()
            self._session_for(row.get("t"))
            me = payload.get("self") or {}
            if not self.meta.get("player") and (me.get("pilot") or me.get("name")):
                self.meta.update({"player": me.get("pilot"), "aircraft": me.get("name")})
                self._write({"k": "meta", **self.meta})
            world = payload.get("world")
            if isinstance(world, list) and now - self._last_world_wall >= 2.0:
                # Every unit's radar on/off as DCS reports it (0.5 Hz).
                self._last_world_wall = now
                units = [[o.get("name"), round(o["lat"], 5), round(o["lon"], 5), round(o.get("alt") or 0), bool(o.get("radar"))]
                         for o in world if isinstance(o, dict) and isinstance(o.get("lat"), (int, float))
                         and isinstance(o.get("lon"), (int, float)) and "radar" in o]
                if units:
                    self._write({"k": "world", "t": row.get("t"), "u": units})
            if now - self._last_self_wall < 1.0 / SELF_RATE_HZ:
                return
            self._last_self_wall = now
            self._write({"k": "self", **row})

    def on_events(self, events: List[Dict[str, Any]]) -> None:
        if not self.enabled or not events:
            return
        with self._lock:
            self._session_for(None)
            for ev in events:
                self._write({"k": "ev", **ev})

    def close(self) -> None:
        with self._lock:
            self._close()


# -- reading ----------------------------------------------------------------------


def read_log(path: Path) -> Dict[str, Any]:
    meta: Dict[str, Any] = {}
    selfs: List[Dict[str, Any]] = []
    events: List[Dict[str, Any]] = []
    worlds: List[Dict[str, Any]] = []
    with open(path, encoding="utf-8", errors="replace") as fh:
        for line in fh:
            try:
                row = json.loads(line)
            except ValueError:
                continue
            kind = row.get("k")
            if kind == "meta":
                meta.update({k: v for k, v in row.items() if k not in ("k",)})
            elif kind == "self" and _num(row.get("t")) is not None:
                selfs.append(row)
            elif kind == "ev":
                events.append(row)
            elif kind == "world" and _num(row.get("t")) is not None:
                worlds.append(row)
    walls = [r["wall"] for r in selfs + events if _num(r.get("wall")) is not None]
    return {"path": str(path), "meta": meta, "self": selfs, "events": events, "world": worlds,
            "wallStart": min(walls) if walls else None, "wallEnd": max(walls) if walls else None}


def list_logs(directory: str) -> List[Path]:
    d = Path(directory)
    return sorted(d.glob("flight-*.jsonl")) if d.is_dir() else []
