"""Where Windows really keeps "Saved Games" and "Documents".

Both can be moved to another drive (folder Properties -> Location), and many
DCS players do so; the path under the user profile is then empty.  Windows
knows the real place (its "known folders"); elsewhere this returns None.
"""

from __future__ import annotations

import os
import uuid
from pathlib import Path
from typing import Optional

SAVED_GAMES = "4C5C32FF-BB9D-43B0-B5B4-2D72E54EAAA4"  # FOLDERID_SavedGames
DOCUMENTS = "FDD39AD0-238F-46AF-ADB4-6C85480369C7"    # FOLDERID_Documents


def known_folder(folder_id: str) -> Optional[Path]:
    if os.name != "nt":
        return None
    try:
        import ctypes
        from ctypes import wintypes

        class GUID(ctypes.Structure):
            _fields_ = [("Data1", wintypes.DWORD), ("Data2", wintypes.WORD), ("Data3", wintypes.WORD),
                        ("Data4", ctypes.c_ubyte * 8)]

        u = uuid.UUID(folder_id)
        guid = GUID(u.time_low, u.time_mid, u.time_hi_version, (ctypes.c_ubyte * 8)(*u.bytes[8:]))
        path = ctypes.c_wchar_p()
        if ctypes.windll.shell32.SHGetKnownFolderPath(ctypes.byref(guid), 0, None, ctypes.byref(path)) != 0:
            return None
        try:
            return Path(path.value) if path.value else None
        finally:
            ctypes.windll.ole32.CoTaskMemFree(path)
    except Exception:  # noqa: BLE001 - never let a lookup stop the app
        return None
