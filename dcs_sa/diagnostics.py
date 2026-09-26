"""The console's backing store: what DCS SA has been doing, most recent last.

A logging handler keeps the last few hundred records in memory so the UI can
show them without reading a file, plus a few counters worth seeing at a glance
(telemetry packets in, recordings analysed).  Nothing here touches disk: the
console is for "why isn't this working right now", and a log file that grows
forever on a gaming PC is a liability.

The buffer is shared, so every read hands back a copy under the lock.
"""

from __future__ import annotations

import logging
import threading
import time
from collections import deque
from typing import Any, Deque, Dict, List, Optional

MAX_RECORDS = 500
#: Log records below this level never reach the console.
LEVEL = logging.INFO


class ConsoleBuffer(logging.Handler):
    """Keeps the newest records, each with a sequence number the UI polls on."""

    def __init__(self, capacity: int = MAX_RECORDS) -> None:
        super().__init__(level=LEVEL)
        self._lock = threading.Lock()
        self._records: Deque[Dict[str, Any]] = deque(maxlen=capacity)
        self._seq = 0
        self.started = time.time()

    # -- writing ---------------------------------------------------------------

    def emit(self, record: logging.LogRecord) -> None:
        try:
            message = record.getMessage()
            if record.exc_info:
                message = f"{message}\n{self.format(record)}" if self.formatter else message
        except Exception:  # noqa: BLE001 - logging must never raise into the app
            message = "<unprintable log record>"
        self.add(record.levelname, message, source=record.name, when=record.created)

    def add(self, level: str, message: str, source: str = "dcs_sa", when: Optional[float] = None) -> None:
        with self._lock:
            self._seq += 1
            self._records.append({
                "seq": self._seq,
                "t": when if when is not None else time.time(),
                "level": level.upper(),
                "source": source.replace("dcs_sa.", "") or "dcs_sa",
                "message": str(message)[:2000],
            })

    # -- reading ---------------------------------------------------------------

    def entries(self, since: int = 0, limit: int = MAX_RECORDS) -> List[Dict[str, Any]]:
        with self._lock:
            rows = [r for r in self._records if r["seq"] > since]
        return rows[-limit:]

    def counts(self) -> Dict[str, int]:
        """How many warnings and errors, so the UI can badge the console."""
        with self._lock:
            rows = list(self._records)
        return {
            "warnings": sum(1 for r in rows if r["level"] == "WARNING"),
            "errors": sum(1 for r in rows if r["level"] in ("ERROR", "CRITICAL")),
            "total": len(rows),
            "seq": self._seq,
        }

    def clear(self) -> None:
        with self._lock:
            self._records.clear()


#: The one buffer the app logs into.
console = ConsoleBuffer()


def install(level: int = LEVEL) -> ConsoleBuffer:
    """Attach the console to the root logger.  Safe to call more than once."""
    root = logging.getLogger()
    if console not in root.handlers:
        console.setLevel(level)
        console.setFormatter(logging.Formatter("%(message)s"))
        root.addHandler(console)
        if root.level > level:
            root.setLevel(level)
    return console
