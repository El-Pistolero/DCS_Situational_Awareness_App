"""Recording library: discovery, parsing jobs and an analysis cache.

Files are addressed by an opaque key derived from their path.  Only files
found by scanning the configured folders (or uploaded) get a key, so the
HTTP API cannot be used to read arbitrary files off the disk.
"""

from __future__ import annotations

import hashlib
import logging
import os
import re
import threading
import time
from collections import OrderedDict
from pathlib import Path
from typing import Any, Callable, Dict, List, Optional, Tuple

from ..acmi.model import Recording
from ..acmi.parser import parse_file
from ..analysis.kinematics import derive
from .. import threatdb
from ..analysis.dcsmerge import find_and_merge
from ..analysis.report import analyze, guess_player, to_markdown
from ..analysis.weapons import _weapon_samples as weapon_samples

log = logging.getLogger(__name__)

EXTENSIONS = (".acmi", ".txt.acmi", ".zip.acmi")
#: Gun rounds sent to the browser for tracer drawing.  A long furball can
#: record tens of thousands; beyond this the list is truncated (and flagged).
MAX_ROUNDS = 30000
RADAR_STEP = 0.5  # s; radar state sampling for emitters whose positions are sampled coarsely
MAX_PARSED = 3


def _key(path: str) -> str:
    return hashlib.sha1(os.path.abspath(path).encode("utf-8")).hexdigest()[:16]


def safe_filename(name: str) -> str:
    base = os.path.basename(name.replace("\\", "/"))
    base = re.sub(r"[^A-Za-z0-9._ -]+", "_", base).strip(" .") or "recording"
    if not base.lower().endswith(".acmi"):
        base += ".acmi"
    return base[:180]


class Job:
    def __init__(self, key: str) -> None:
        self.key = key
        self.state = "queued"  # queued | parsing | analyzing | ready | error
        self.progress = 0.0
        self.error: Optional[str] = None
        self.started = time.time()
        self.finished: Optional[float] = None

    def to_dict(self) -> Dict[str, Any]:
        return {"key": self.key, "state": self.state, "progress": self.progress,
                "error": self.error, "elapsed": (self.finished or time.time()) - self.started}


class RecordingStore:
    def __init__(self, dirs: List[str], upload_dir: str, player_names: List[str],
                 extras: Optional[Callable[[], Dict[str, Any]]] = None) -> None:
        # extras() -> {"flightlog_dir": str, "airbases": [...]}: what DCS itself
        # reported, merged into each analysis.
        self.extras = extras or (lambda: {})
        self.dirs = dirs
        self.upload_dir = upload_dir
        self.player_names = player_names
        self._lock = threading.RLock()
        self._index: Dict[str, str] = {}
        self._parsed: "OrderedDict[str, Tuple[Tuple[float, int], Recording, Dict]]" = OrderedDict()
        self._jobs: Dict[str, Job] = {}

    # -- discovery ------------------------------------------------------------

    def scan(self) -> List[Dict[str, Any]]:
        found: List[Dict[str, Any]] = []
        seen = set()
        for d in self.dirs:
            root = Path(d)
            if not root.is_dir():
                continue
            try:
                entries = list(root.rglob("*.acmi"))
            except OSError:
                continue
            for p in entries:
                try:
                    st = p.stat()
                except OSError:
                    continue
                ap = str(p.resolve())
                if ap in seen:
                    continue
                seen.add(ap)
                key = _key(ap)
                with self._lock:
                    self._index[key] = ap
                    job = self._jobs.get(key)
                found.append({
                    "key": key,
                    "name": p.name,
                    "folder": str(p.parent),
                    "size": st.st_size,
                    "modified": st.st_mtime,
                    "sample": "samples" in p.parts,
                    "state": job.state if job else None,
                })
        found.sort(key=lambda r: r["modified"], reverse=True)
        return found

    def path_for(self, key: str) -> Optional[str]:
        with self._lock:
            path = self._index.get(key)
        if path is None:
            self.scan()
            with self._lock:
                path = self._index.get(key)
        return path

    def register_upload(self, filename: str, stream, length: int) -> Dict[str, Any]:
        os.makedirs(self.upload_dir, exist_ok=True)
        name = safe_filename(filename)
        dest = Path(self.upload_dir) / name
        stem, n = dest.stem, 1
        while dest.exists():
            dest = dest.with_name(f"{stem}-{n}.acmi")
            n += 1
        remaining = length
        with open(dest, "wb") as fh:
            while remaining > 0:
                chunk = stream.read(min(1 << 20, remaining))
                if not chunk:
                    break
                fh.write(chunk)
                remaining -= len(chunk)
        if remaining > 0:
            dest.unlink(missing_ok=True)
            raise ValueError("upload truncated")
        ap = str(dest.resolve())
        key = _key(ap)
        with self._lock:
            self._index[key] = ap
        return {"key": key, "name": dest.name}

    # -- parse / analyse ----------------------------------------------------------

    def _stamp(self, path: str) -> Tuple[float, int]:
        st = os.stat(path)
        return (st.st_mtime, st.st_size)

    def get(self, key: str) -> Optional[Tuple[Recording, Dict]]:
        """Parsed recording and analysis if ready, else None."""
        path = self.path_for(key)
        if path is None:
            raise KeyError(key)
        with self._lock:
            entry = self._parsed.get(key)
            if entry is not None and entry[0] == self._stamp(path):
                self._parsed.move_to_end(key)
                return entry[1], entry[2]
        return None

    def ensure(self, key: str) -> Job:
        """Start parsing in the background if needed; return the job."""
        path = self.path_for(key)
        if path is None:
            raise KeyError(key)
        with self._lock:
            if self.get(key) is not None:
                job = self._jobs.get(key) or Job(key)
                job.state, job.progress = "ready", 1.0
                self._jobs[key] = job
                return job
            job = self._jobs.get(key)
            if job is not None and job.state in ("queued", "parsing", "analyzing"):
                return job
            job = Job(key)
            self._jobs[key] = job
        threading.Thread(target=self._work, args=(key, path, job), daemon=True, name=f"parse-{key}").start()
        return job

    def job(self, key: str) -> Optional[Job]:
        with self._lock:
            return self._jobs.get(key)

    def _work(self, key: str, path: str, job: Job) -> None:
        try:
            job.state = "parsing"
            t0 = time.time()

            def progress(done: int, total: int) -> None:
                job.progress = min(0.95, 0.9 * done / total) if total else 0.5

            rec = parse_file(path, progress)
            log.info("parsed %s in %.1fs (%d objects)", path, time.time() - t0, len(rec.tracks))
            job.state, job.progress = "analyzing", 0.95
            extras = self.extras() or {}
            dcs = None
            if extras.get("flightlog_dir"):
                try:
                    dcs = find_and_merge(rec, extras["flightlog_dir"], guess_player(rec, self.player_names))
                except (OSError, ValueError, KeyError) as exc:  # never fail a debrief over a bad log
                    log.warning("flight log merge failed: %s", exc)
            report = analyze(rec, self.player_names, dcs=dcs, airbases=extras.get("airbases"))
            with self._lock:
                self._parsed[key] = (self._stamp(path), rec, report)
                self._parsed.move_to_end(key)
                while len(self._parsed) > MAX_PARSED:
                    self._parsed.popitem(last=False)
            job.state, job.progress = "ready", 1.0
        except Exception as exc:  # surface any parse failure to the UI
            log.exception("failed to load %s", path)
            job.state, job.error = "error", f"{exc.__class__.__name__}: {exc}"
        finally:
            job.finished = time.time()

    # -- data shaping for the UI ------------------------------------------------

    @staticmethod
    def playback(rec: Recording, report: Optional[Dict] = None, air_step: float = 0.5,
                 weapon_step: float = 0.2, other_step: float = 5.0) -> Dict:
        """Downsampled positions of every object for map playback.

        Gun rounds go in a separate compact ``rounds`` list at full recorded
        resolution (they live for a second or two), tagged with the shooter
        worked out by the weapons analysis.  Every emitter that recorded radar
        data gets a ``radar`` block so cones can be drawn for all of them.
        """
        out: Dict[str, Dict[str, List]] = {}
        r = lambda v, nd: None if v != v else round(v, nd)  # noqa: E731
        shooter: Dict[str, str] = {}
        for b in ((report or {}).get("weapons") or {}).get("bursts", []):
            for rid in b.get("roundIds") or []:
                shooter[rid] = b.get("launcherId")
        rounds: List[Dict] = []
        total = 0
        for tr in rec.tracks.values():
            if tr.category == "round":
                # Recorded path, carried on to the removal time (DCS deletes a
                # round when it hits, a frame after its last sample).
                pts = weapon_samples(tr)
                if not pts:
                    continue
                total += 1
                if len(rounds) >= MAX_ROUNDS:
                    continue
                rounds.append({
                    "id": tr.id,
                    "shooter": tr.props.get("Parent") or shooter.get(tr.id),
                    "color": tr.props.get("Color"),
                    "coalition": tr.coalition,
                    "t": [round(p[0], 3) for p in pts],
                    "lon": [round(p[1], 7) for p in pts],
                    "lat": [round(p[2], 7) for p in pts],
                    "alt": [round(p[3], 1) for p in pts],
                    # A round with no removal line would otherwise "fly" until
                    # the recording ends: it ended at its last sample.
                    "end": pts[-1][0],
                })
                continue
            if tr.category in ("clutter",):
                continue
            lon, lat = tr.channel("Longitude"), tr.channel("Latitude")
            if lon is None or lat is None or not len(tr):
                continue
            alt, yaw = tr.channel("Altitude"), tr.channel("Yaw")
            pitch, roll = tr.channel("Pitch"), tr.channel("Roll")
            if tr.category in ("fixedwing", "rotorcraft", "air"):
                step = air_step
            elif tr.category in ("weapon", "countermeasure"):
                step = weapon_step
            else:
                step = other_step
            idx: List[int] = []
            last = -1e18
            for i, t in enumerate(tr.t):
                if t - last >= step - 1e-9:
                    idx.append(i)
                    last = t
            if idx[-1] != len(tr) - 1:
                idx.append(len(tr) - 1)
            r = lambda v, nd: None if v != v else round(v, nd)  # noqa: E731
            out[tr.id] = {
                "t": [round(tr.t[i], 2) for i in idx],
                "lon": [r(lon[i], 6) for i in idx],
                "lat": [r(lat[i], 6) for i in idx],
                "alt": [r(alt[i], 1) for i in idx] if alt is not None else None,
                "yaw": [r(yaw[i], 1) for i in idx] if yaw is not None else None,
                "end": tr.ends_at,
            }
            if tr.category in ("fixedwing", "rotorcraft", "air", "weapon"):
                if pitch is not None:
                    out[tr.id]["pitch"] = [r(pitch[i], 1) for i in idx]
                if roll is not None:
                    out[tr.id]["roll"] = [r(roll[i], 1) for i in idx]
            radar = tr.channel("RadarMode")
            scan = tr.channel("ScanAz")
            active = tr.channel("RadarActive")
            if (radar is not None and any(v == v and v > 0 for v in radar)) or scan is not None or active is not None:
                block: Dict[str, List] = {}
                ridx = idx
                if step > RADAR_STEP:
                    # Ground/sea positions are sampled every few seconds, far
                    # too coarse for a sweeping antenna: radar gets its own times.
                    ridx, last = [], -1e18
                    for i, t in enumerate(tr.t):
                        if t - last >= RADAR_STEP - 1e-9:
                            ridx.append(i)
                            last = t
                    if ridx[-1] != len(tr) - 1:
                        ridx.append(len(tr) - 1)
                    block["t"] = [round(tr.t[i], 2) for i in ridx]
                for key, ch, nd in (("mode", "RadarMode", 0), ("az", "RadarAzimuth", 1), ("el", "RadarElevation", 1),
                                    ("roll", "RadarRoll", 1), ("range", "RadarRange", 0),
                                    ("hbw", "RadarHorizontalBeamwidth", 1), ("vbw", "RadarVerticalBeamwidth", 1),
                                    ("scanAz", "ScanAz", 1), ("scanEl", "ScanEl", 1), ("scanCAz", "ScanCenterAz", 1),
                                    ("scanCEl", "ScanCenterEl", 1), ("active", "RadarActive", 0)):
                    col = tr.channel(ch)
                    if col is not None:
                        block[key] = [r(col[i], nd) for i in ridx]
                out[tr.id]["radar"] = block
            eng = tr.channel("EngagementRange")
            vals = [v for v in eng if v == v and v > 0] if eng is not None else []
            if vals:
                out[tr.id]["eng"] = round(max(vals), 0)
                out[tr.id]["engSrc"] = "recorded"
            elif tr.category in ("ground", "sea"):
                db = threatdb.lookup(tr.name)
                if db:
                    out[tr.id]["eng"] = db["range"]
                    out[tr.id]["engSrc"] = db["source"]
                    if db.get("vrange"):
                        out[tr.id]["engV"] = db["vrange"]
        rounds.sort(key=lambda x: x["t"][0])
        return {"start": rec.start_time, "end": rec.end_time, "objects": out, "rounds": rounds,
                "roundsTotal": total, "roundsTruncated": total > len(rounds)}

    @staticmethod
    def series(rec: Recording, obj_id: str, channels: Optional[List[str]] = None, max_points: int = 4000) -> Dict:
        tr = rec.tracks.get(obj_id)
        if tr is None:
            raise KeyError(obj_id)
        n = len(tr)
        stride = max(1, n // max_points)
        idx = list(range(0, n, stride))
        if idx and idx[-1] != n - 1:
            idx.append(n - 1)
        derived = derive(tr)
        names = channels or sorted(tr.channels.keys())
        data: Dict[str, List] = {}
        for name in names:
            col = tr.channel(name)
            src = col if col is not None else derived.get(name)
            if src is None:
                continue
            data[name] = [None if src[i] != src[i] else round(src[i], 4) for i in idx]
        if channels is None:
            for name, src in derived.items():
                data[name] = [None if src[i] != src[i] else round(src[i], 4) for i in idx]
        text = {k: v for k, v in tr.text_history.items() if k in ("LockedTarget", "FocusedTarget")}
        return {"id": obj_id, "t": [round(tr.t[i], 3) for i in idx], "channels": data,
                "text": text, "summary": tr.summary()}

    def markdown(self, key: str, focus: Optional[str] = None) -> Optional[str]:
        got = self.get(key)
        if got is None:
            return None
        return to_markdown(got[1], focus)
