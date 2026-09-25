"""Terrain and airbases from DCS World itself, via DCS-SA-Hook.lua.

The hook samples DCS's own terrain (height and surface type) through the
official scripting API while the game runs.  Every tile it returns is kept on
disk, so the 3D view can use the game's terrain in later debriefs even with
DCS closed.  Tiles are keyed by Web Mercator z/x/y: DCS theatres are real
places, so one geographic cache serves all of them.
"""

from __future__ import annotations

import json
import logging
import math
import os
import socket
import threading
import time
from pathlib import Path
from typing import Any, Dict, List, Optional

log = logging.getLogger(__name__)

HOOK_PORT = 42682
SAMPLES = 41            # per side; matches the 3D mesh (40 segments)
PENDING_TIMEOUT = 20.0
SURFACE = {1: "land", 2: "shallow", 3: "water", 4: "road", 5: "runway"}


class DcsMapStore:
    def __init__(self, cache_dir: str, hook_port: int = HOOK_PORT) -> None:
        self.dir = Path(cache_dir)
        self.hook_port = hook_port
        self._lock = threading.Lock()
        self._pending: Dict[str, float] = {}
        self._sock = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
        self.hook_seen = 0.0
        self.mission = False
        self.theatre: Optional[str] = None
        self.tiles_received = 0
        self.airbases: List[Dict[str, Any]] = self._load_airbases()
        self._airbases_requested = 0.0

    # -- status ---------------------------------------------------------------

    @property
    def connected(self) -> bool:
        return self.mission and time.time() - self.hook_seen < 12.0

    def status(self) -> Dict[str, Any]:
        cached = 0
        if self.dir.is_dir():
            cached = sum(1 for _ in self.dir.rglob("*.json")) - (1 if (self.dir / "airbases.json").exists() else 0)
        return {"connected": self.connected, "theatre": self.theatre, "cachedTiles": max(0, cached),
                "tilesReceived": self.tiles_received, "airbases": len(self.airbases),
                "pending": len(self._pending)}

    # -- requests to the hook -------------------------------------------------------

    def _send(self, payload: Dict[str, Any]) -> None:
        try:
            self._sock.sendto(json.dumps(payload).encode(), ("127.0.0.1", self.hook_port))
        except OSError:
            pass

    def _path(self, z: int, x: int, y: int) -> Path:
        return self.dir / str(z) / str(x) / f"{y}.json"

    def get_tile(self, z: int, x: int, y: int) -> Optional[Dict[str, Any]]:
        """Cached tile, or None - in which case a request is sent if DCS is up."""
        if not (0 <= z <= 16 and 0 <= x < 2 ** z and 0 <= y < 2 ** z):
            return None
        path = self._path(z, x, y)
        if path.is_file():
            try:
                return json.loads(path.read_text())
            except (OSError, ValueError):
                pass
        if self.connected:
            key = f"{z}/{x}/{y}"
            with self._lock:
                sent = self._pending.get(key)
                if sent is None or time.time() - sent > PENDING_TIMEOUT:
                    self._pending[key] = time.time()
                    self._send({"op": "tile", "z": z, "x": x, "y": y, "n": SAMPLES})
        return None

    def is_pending(self, z: int, x: int, y: int) -> bool:
        with self._lock:
            sent = self._pending.get(f"{z}/{x}/{y}")
        return sent is not None and time.time() - sent < PENDING_TIMEOUT and self.connected

    # -- packets from the hook ----------------------------------------------------------

    def on_packet(self, p: Dict[str, Any]) -> bool:
        """Handle a hook packet.  Returns False if it was not one of ours."""
        kind = p.get("type")
        if kind == "dcs-hook":
            self.hook_seen = time.time()
            self.mission = bool(p.get("mission"))
            if p.get("theatre"):
                self.theatre = p["theatre"]
            if self.mission and time.time() - self._airbases_requested > 120:
                self._airbases_requested = time.time()
                self._send({"op": "airbases"})
            return True
        if kind == "terrain":
            self.hook_seen = time.time()
            try:
                z, x, y = int(p["z"]), int(p["x"]), int(p["y"])
            except (KeyError, TypeError, ValueError):
                return True
            with self._lock:
                self._pending.pop(f"{z}/{x}/{y}", None)
            if not p.get("ok"):
                return True
            n = int(p.get("n") or 0)
            h, s = p.get("h") or [], p.get("s") or ""
            if n < 2 or len(h) != n * n or len(s) != n * n:
                log.warning("dropping malformed DCS terrain tile %s/%s/%s", z, x, y)
                return True
            path = self._path(z, x, y)
            path.parent.mkdir(parents=True, exist_ok=True)
            tmp = path.with_suffix(".part")
            tmp.write_text(json.dumps({"z": z, "x": x, "y": y, "n": n, "h": h, "s": s,
                                       "theatre": p.get("theatre") or self.theatre}))
            os.replace(tmp, path)
            self.tiles_received += 1
            return True
        if kind == "airbases":
            self.hook_seen = time.time()
            if p.get("ok"):
                self._merge_airbases(p.get("airbases") or [], p.get("theatre") or self.theatre)
            return True
        return False

    # -- airbases -------------------------------------------------------------------

    def _load_airbases(self) -> List[Dict[str, Any]]:
        try:
            return json.loads((self.dir / "airbases.json").read_text())
        except (OSError, ValueError):
            return []

    def _merge_airbases(self, items: List[Dict[str, Any]], theatre: Optional[str]) -> None:
        merged = {(a.get("theatre"), a.get("name")): a for a in self.airbases}
        for a in items:
            rws = []
            for rw in a.get("runways") or []:
                course = rw.get("course")
                # DCS reports runway course in radians, negated relative to heading.
                hdg = (-math.degrees(course)) % 360.0 if isinstance(course, (int, float)) else None
                rws.append({**rw, "heading": hdg})
            merged[(theatre, a.get("name"))] = {**a, "runways": rws, "theatre": theatre}
        self.airbases = list(merged.values())
        self.dir.mkdir(parents=True, exist_ok=True)
        (self.dir / "airbases.json").write_text(json.dumps(self.airbases))

    def airbases_near(self, lon: float, lat: float, radius_m: float = 400000.0) -> List[Dict[str, Any]]:
        out = []
        for a in self.airbases:
            try:
                d = math.hypot((a["lon"] - lon) * 111320 * math.cos(math.radians(lat)), (a["lat"] - lat) * 111320)
            except (KeyError, TypeError):
                continue
            if d <= radius_m:
                out.append(a)
        return out
