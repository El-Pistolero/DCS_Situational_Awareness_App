"""Play an ACMI file into a sink at (scaled) real time.

Lets you exercise the live second-screen view without DCS running, and is
how the live pipeline is tested.
"""

from __future__ import annotations

import logging
import threading
import time
from typing import Callable, List, Optional

from ..acmi.parser import AcmiParser, AcmiSink
from ..acmi.reader import iter_lines

log = logging.getLogger(__name__)


class ReplaySource:
    def __init__(
        self,
        sink: AcmiSink,
        path: str,
        speed: float = 1.0,
        loop: bool = True,
        start_at: float = 0.0,
        on_status: Optional[Callable[[str, str], None]] = None,
        on_reset: Optional[Callable[[], None]] = None,
    ) -> None:
        self.sink = sink
        self.path = path
        self.speed = max(0.05, float(speed))
        self.loop = loop
        self.start_at = start_at
        self.on_status = on_status or (lambda s, d: None)
        self.on_reset = on_reset
        self._stop = threading.Event()
        self._thread: Optional[threading.Thread] = None
        self.state = "idle"

    def start(self) -> None:
        self._stop.clear()
        self._thread = threading.Thread(target=self._run, name="acmi-replay", daemon=True)
        self._thread.start()

    def stop(self) -> None:
        self._stop.set()
        if self._thread:
            self._thread.join(timeout=3.0)

    def _run(self) -> None:
        try:
            lines: List[str] = list(iter_lines(self.path))
        except (OSError, ValueError) as exc:
            self.state = "error"
            self.on_status("error", str(exc))
            return
        while not self._stop.is_set():
            if self.on_reset:
                self.on_reset()
            self.state = "connected"
            self.on_status("connected", f"replaying {self.path} at {self.speed:g}x")
            self._play(lines)
            if not self.loop or self._stop.is_set():
                break
            self._stop.wait(2.0)
        self.state = "stopped"
        self.on_status("stopped", "replay finished")

    def _play(self, lines: List[str]) -> None:
        parser = AcmiParser(self.sink)
        wall0: Optional[float] = None
        sim0: Optional[float] = None
        for line in lines:
            if self._stop.is_set():
                return
            if line.startswith("#"):
                try:
                    t = float(line[1:])
                except ValueError:
                    continue
                if t < self.start_at:
                    parser.feed(line)
                    continue
                if wall0 is None:
                    wall0, sim0 = time.monotonic(), t
                due = wall0 + (t - sim0) / self.speed
                delay = due - time.monotonic()
                if delay > 0:
                    if self._stop.wait(delay):
                        return
            parser.feed(line)
