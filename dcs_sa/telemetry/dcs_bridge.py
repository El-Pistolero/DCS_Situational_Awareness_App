"""UDP receiver for the DCS ``Export.lua`` bridge (``dcs-scripts/DCS-SA-Export.lua``).

The Lua side sends one JSON object per datagram to ``127.0.0.1:42680`` (by
default) several times a second.  Datagrams are independent snapshots, so a
dropped packet costs nothing and there is no connection state to manage.
"""

from __future__ import annotations

import json
import logging
import socket
import threading
from typing import Callable, Dict, Optional

log = logging.getLogger(__name__)

DEFAULT_PORT = 42680


class DcsBridgeListener:
    def __init__(
        self,
        on_packet: Callable[[Dict], None],
        host: str = "127.0.0.1",
        port: int = DEFAULT_PORT,
    ) -> None:
        self.on_packet = on_packet
        self.host = host
        self.port = port
        self._stop = threading.Event()
        self._thread: Optional[threading.Thread] = None
        self._sock: Optional[socket.socket] = None
        self.packets = 0
        self.errors = 0
        self.last_error: Optional[str] = None

    def start(self) -> None:
        sock = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
        sock.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
        sock.bind((self.host, self.port))
        sock.settimeout(1.0)
        self._sock = sock
        self._stop.clear()
        self._thread = threading.Thread(target=self._run, name="dcs-bridge", daemon=True)
        self._thread.start()
        log.info("DCS bridge listening on udp://%s:%d", self.host, self.port)

    def stop(self) -> None:
        self._stop.set()
        if self._thread:
            self._thread.join(timeout=3.0)
        if self._sock:
            self._sock.close()

    def _run(self) -> None:
        assert self._sock is not None
        while not self._stop.is_set():
            try:
                data, _ = self._sock.recvfrom(65535)
            except socket.timeout:
                continue
            except OSError:
                break
            try:
                payload = json.loads(data.decode("utf-8", errors="replace"))
            except ValueError as exc:
                self.errors += 1
                self.last_error = f"bad JSON: {exc}"
                continue
            if not isinstance(payload, dict):
                continue
            self.packets += 1
            try:
                self.on_packet(payload)
            except Exception:  # pragma: no cover - keep listening whatever happens
                self.errors += 1
                log.exception("bridge packet handler failed")
