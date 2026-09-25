"""Turn an ACMI file on disk into a stream of logical lines.

Handles the three shapes DCS and Tacview produce in practice:

* ``.acmi`` that is a zip archive containing a single text entry
  (this is what Tacview writes by default, despite the extension),
* ``.acmi`` / ``.txt`` raw UTF-8 text, with or without a BOM,
* gzip, because some tooling recompresses recordings that way.

A *logical* line joins physical lines split by a trailing backslash, which is
how ACMI encodes a newline inside a text property.
"""

from __future__ import annotations

import gzip
import io
import os
import zipfile
from typing import IO, Iterator

_ZIP_MAGIC = b"PK\x03\x04"
_GZIP_MAGIC = b"\x1f\x8b"


def _count_trailing_backslashes(s: str) -> int:
    n = 0
    for ch in reversed(s):
        if ch != "\\":
            break
        n += 1
    return n


def _binary_stream(path: str | os.PathLike[str]) -> IO[bytes]:
    """Open *path* and unwrap any container, returning a binary text stream."""
    fh = open(path, "rb")
    head = fh.read(4)
    fh.seek(0)

    if head.startswith(_ZIP_MAGIC):
        # Tacview names the archive .acmi; the payload inside is a .txt.
        data = fh.read()
        fh.close()
        zf = zipfile.ZipFile(io.BytesIO(data))
        names = [n for n in zf.namelist() if not n.endswith("/")]
        if not names:
            raise ValueError(f"{path}: zip archive contains no files")
        preferred = [n for n in names if n.lower().endswith((".txt", ".acmi"))]
        return zf.open(preferred[0] if preferred else names[0])

    if head.startswith(_GZIP_MAGIC):
        fh.close()
        return gzip.open(path, "rb")

    return fh


def iter_lines(path: str | os.PathLike[str]) -> Iterator[str]:
    """Yield stripped logical lines from an ACMI recording."""
    stream = _binary_stream(path)
    try:
        text = io.TextIOWrapper(stream, encoding="utf-8-sig", errors="replace", newline="")
        pending: list[str] | None = None
        for raw in text:
            line = raw.rstrip("\r\n")
            if pending is not None:
                pending.append(line)
                if _count_trailing_backslashes(line) % 2 == 1:
                    continue
                yield "\n".join(pending)
                pending = None
                continue
            if not line:
                continue
            if _count_trailing_backslashes(line) % 2 == 1:
                pending = [line]
                continue
            yield line
        if pending is not None:
            yield "\n".join(pending)
    finally:
        try:
            stream.close()
        except Exception:  # pragma: no cover - best-effort close
            pass


def file_size(path: str | os.PathLike[str]) -> int:
    try:
        return os.path.getsize(path)
    except OSError:
        return 0


def uncompressed_size(path: str | os.PathLike[str]) -> int:
    """Best estimate of the text payload size, for progress reporting."""
    try:
        with open(path, "rb") as fh:
            head = fh.read(4)
        if head.startswith(_ZIP_MAGIC):
            with zipfile.ZipFile(path) as zf:
                infos = [i for i in zf.infolist() if not i.filename.endswith("/")]
                return sum(i.file_size for i in infos[:1]) or file_size(path)
        if head.startswith(_GZIP_MAGIC):
            return file_size(path) * 8
    except (OSError, zipfile.BadZipFile):
        pass
    return file_size(path)
