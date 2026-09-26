"""Tacview real-time telemetry client.

Tacview's live protocol is the ACMI text format over TCP (default port
42674), preceded by a short handshake in each direction::

    XtraLib.Stream.0\\n
    Tacview.RealTimeTelemetry.0\\n
    <name>\\n
    <password hash>\\0

The host sends its handshake first (password field ``0``).  The client
answers with its own name and a hash of the password: CRC-64/WE over the
UTF-16LE bytes, as unpadded lowercase hex.  An empty password therefore
hashes to ``0``.  Tacview itself retries with CRC-32 if CRC-64 is refused,
and so do we.

Note: the stream comes from the Tacview exporter built into DCS, with
real-time telemetry switched on in DCS's Tacview options.  Tacview's own
viewer needs its Advanced edition to show that stream; this client does
not use the viewer.  (Not yet tried against a real DCS.)
"""

from __future__ import annotations

import logging
import socket
import threading
import time
import zlib
from typing import Callable, Optional

from ..acmi.parser import AcmiParser, AcmiSink

log = logging.getLogger(__name__)

DEFAULT_PORT = 42674
LOW_LEVEL = "XtraLib.Stream.0"
HIGH_LEVEL = "Tacview.RealTimeTelemetry.0"

# --- CRC-64/WE --------------------------------------------------------------
# width=64 poly=0x42f0e1eba9ea3693 init=0xffffffffffffffff refin=false
# refout=false xorout=0xffffffffffffffff check("123456789")=0x62ec59e3f1a4f00a
_CRC64_POLY = 0x42F0E1EBA9EA3693
_MASK64 = 0xFFFFFFFFFFFFFFFF


def _build_crc64_table():
    table = []
    for byte in range(256):
        crc = byte << 56
        for _ in range(8):
            if crc & (1 << 63):
                crc = ((crc << 1) ^ _CRC64_POLY) & _MASK64
            else:
                crc = (crc << 1) & _MASK64
        table.append(crc)
    return table


_CRC64_TABLE = _build_crc64_table()


def crc64_we(data: bytes) -> int:
    crc = _MASK64
    for b in data:
        crc = (_CRC64_TABLE[((crc >> 56) ^ b) & 0xFF] ^ (crc << 8)) & _MASK64
    return crc ^ _MASK64


def hash_password(password: str, algorithm: str = "crc64") -> str:
    """Tacview password hash: CRC of UTF-16LE bytes, unpadded lowercase hex."""
    data = password.encode("utf-16-le")
    if algorithm == "crc32":
        value = zlib.crc32(data) & 0xFFFFFFFF
    else:
        value = crc64_we(data)
    return format(value, "x")


def client_handshake(client_name: str, password: str = "", algorithm: str = "crc64") -> bytes:
    return (
        f"{LOW_LEVEL}\n{HIGH_LEVEL}\n{client_name}\n{hash_password(password, algorithm)}\0"
    ).encode("utf-8")


# --- client -----------------------------------------------------------------

StatusFn = Callable[[str, str], None]


class RealtimeTelemetryClient:
    """Connects to a Tacview real-time telemetry host and feeds a sink.

    Runs on its own thread, reconnecting with backoff until stopped, so the
    second-screen view survives DCS mission restarts without babysitting.
    """

    def __init__(
        self,
        sink: AcmiSink,
        host: str = "127.0.0.1",
        port: int = DEFAULT_PORT,
        password: str = "",
        client_name: str = "DCS-SA",
        on_status: Optional[StatusFn] = None,
        on_reset: Optional[Callable[[], None]] = None,
    ) -> None:
        self.sink = sink
        self.host = host
        self.port = port
        self.password = password
        self.client_name = client_name
        self.on_status = on_status or (lambda state, detail: None)
        self.on_reset = on_reset
        self._stop = threading.Event()
        self._thread: Optional[threading.Thread] = None
        self._sock: Optional[socket.socket] = None
        self.state = "idle"
        self.host_name: Optional[str] = None
        self.bytes_received = 0
        self.lines_received = 0

    # -- lifecycle -----------------------------------------------------------

    def start(self) -> None:
        if self._thread and self._thread.is_alive():
            return
        self._stop.clear()
        self._thread = threading.Thread(target=self._run, name="tacview-rt", daemon=True)
        self._thread.start()

    def stop(self) -> None:
        self._stop.set()
        sock = self._sock
        if sock is not None:
            try:
                sock.shutdown(socket.SHUT_RDWR)
            except OSError:
                pass
            try:
                sock.close()
            except OSError:
                pass
        if self._thread:
            self._thread.join(timeout=3.0)

    def _set_state(self, state: str, detail: str = "") -> None:
        self.state = state
        log.info("tacview-rt %s %s", state, detail)
        try:
            self.on_status(state, detail)
        except Exception:  # pragma: no cover - never let a UI hook kill the reader
            log.exception("status callback failed")

    # -- main loop -----------------------------------------------------------

    def _run(self) -> None:
        backoff = 1.0
        algorithms = ["crc64", "crc32"] if self.password else ["crc64"]
        algo_i = 0
        while not self._stop.is_set():
            algorithm = algorithms[algo_i % len(algorithms)]
            try:
                self._set_state("connecting", f"{self.host}:{self.port}")
                self._session(algorithm)
                backoff = 1.0
            except _AuthRejected:
                algo_i += 1
                self._set_state("error", "handshake rejected - check the password")
            except (OSError, ConnectionError) as exc:
                if self._stop.is_set():
                    break
                self._set_state("disconnected", str(exc) or exc.__class__.__name__)
            if self._stop.is_set():
                break
            self._stop.wait(backoff)
            backoff = min(backoff * 2.0, 10.0)
        self._set_state("stopped")

    def _session(self, algorithm: str) -> None:
        sock = socket.create_connection((self.host, self.port), timeout=5.0)
        self._sock = sock
        try:
            sock.settimeout(15.0)
            host_hs = self._read_until_nul(sock)
            lines = host_hs.decode("utf-8", errors="replace").split("\n")
            if len(lines) < 2 or lines[0] != LOW_LEVEL or lines[1] != HIGH_LEVEL:
                raise ConnectionError(f"unexpected handshake from host: {lines[:2]!r}")
            self.host_name = lines[2] if len(lines) > 2 else None
            sock.sendall(client_handshake(self.client_name, self.password, algorithm))
            self._set_state("connected", self.host_name or "")
            if self.on_reset:
                self.on_reset()

            parser = AcmiParser(self.sink)
            sock.settimeout(30.0)
            buf = b""
            pending: Optional[str] = None
            got_data = False
            while not self._stop.is_set():
                try:
                    chunk = sock.recv(65536)
                except socket.timeout:
                    raise ConnectionError("no data for 30 s")
                if not chunk:
                    if not got_data and self.password:
                        raise _AuthRejected()
                    raise ConnectionError("host closed the connection")
                got_data = True
                self.bytes_received += len(chunk)
                buf += chunk
                *complete, buf = buf.split(b"\n")
                for raw in complete:
                    line = raw.decode("utf-8", errors="replace").rstrip("\r")
                    if line.startswith("﻿"):
                        line = line[1:]
                    # Multi-line text properties end each physical line with "\".
                    if pending is not None:
                        pending += "\n" + line
                        if _odd_trailing_backslashes(line):
                            continue
                        line, pending = pending, None
                    elif _odd_trailing_backslashes(line):
                        pending = line
                        continue
                    if not line:
                        continue
                    self.lines_received += 1
                    parser.feed(line)
        finally:
            self._sock = None
            try:
                sock.close()
            except OSError:
                pass

    @staticmethod
    def _read_until_nul(sock: socket.socket, limit: int = 4096) -> bytes:
        data = b""
        while b"\0" not in data:
            chunk = sock.recv(1)
            if not chunk:
                raise ConnectionError("connection closed during handshake")
            data += chunk
            if len(data) > limit:
                raise ConnectionError("handshake too long")
        return data.split(b"\0", 1)[0]


class _AuthRejected(ConnectionError):
    pass


def _odd_trailing_backslashes(line: str) -> bool:
    n = 0
    for ch in reversed(line):
        if ch != "\\":
            break
        n += 1
    return n % 2 == 1
