"""Caching proxy for map tiles used by the 3D view.

Serving tiles from our own origin sidesteps WebGL's cross-origin texture
rules, and the disk cache means terrain you have flown over once loads
instantly - and works offline - next time.
"""

from __future__ import annotations

import logging
import os
import threading
import time
import urllib.request
from pathlib import Path
from typing import Dict, Optional, Tuple

log = logging.getLogger(__name__)

SOURCES: Dict[str, Tuple[str, str]] = {
    # Terrarium-encoded elevation (AWS open data): height = R*256 + G + B/256 - 32768
    "elev": ("https://s3.amazonaws.com/elevation-tiles-prod/terrarium/{z}/{x}/{y}.png", "image/png"),
    "sat": ("https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}", "image/jpeg"),
    "topo": ("https://server.arcgisonline.com/ArcGIS/rest/services/World_Topo_Map/MapServer/tile/{z}/{y}/{x}", "image/jpeg"),
}
MAX_ZOOM = 17
FAIL_TTL = 60.0


class TileCache:
    def __init__(self, root: str) -> None:
        self.root = Path(root)
        self._failed: Dict[str, float] = {}
        self._lock = threading.Lock()

    def get(self, src: str, z: int, x: int, y: int) -> Optional[Tuple[bytes, str]]:
        if src not in SOURCES or not (0 <= z <= MAX_ZOOM) or not (0 <= x < 2 ** z) or not (0 <= y < 2 ** z):
            return None
        url_tmpl, ctype = SOURCES[src]
        path = self.root / src / str(z) / str(x) / f"{y}.tile"
        if path.is_file():
            try:
                return path.read_bytes(), ctype
            except OSError:
                pass
        key = f"{src}/{z}/{x}/{y}"
        with self._lock:
            failed = self._failed.get(key)
        if failed and time.time() - failed < FAIL_TTL:
            return None
        try:
            req = urllib.request.Request(url_tmpl.format(z=z, x=x, y=y), headers={"User-Agent": "DCS-SA/0.1 (flight debrief tool)"})
            with urllib.request.urlopen(req, timeout=12) as resp:
                data = resp.read()
                ctype = resp.headers.get("Content-Type", ctype)
        except Exception as exc:  # network down, 404 over the sea, etc.
            log.debug("tile %s failed: %s", key, exc)
            with self._lock:
                self._failed[key] = time.time()
            return None
        try:
            path.parent.mkdir(parents=True, exist_ok=True)
            tmp = path.with_suffix(".part")
            tmp.write_bytes(data)
            os.replace(tmp, path)
        except OSError:
            pass
        return data, ctype
