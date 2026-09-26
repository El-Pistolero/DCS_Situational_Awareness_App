"""Small things the app remembers between runs (Documents/DCS-SA/settings.json).

Kept apart from dcs-sa.toml, which is the user's own file and never written.
"""

from __future__ import annotations

import json
import os
from pathlib import Path
from typing import Any, Dict

PATH = Path.home() / "Documents" / "DCS-SA" / "settings.json"


def load() -> Dict[str, Any]:
    try:
        data = json.loads(PATH.read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return {}
    return data if isinstance(data, dict) else {}


def update(**values: Any) -> Dict[str, Any]:
    """Merge *values* in (None removes a key) and save; never raises."""
    data = load()
    for k, v in values.items():
        if v is None:
            data.pop(k, None)
        else:
            data[k] = v
    try:
        PATH.parent.mkdir(parents=True, exist_ok=True)
        tmp = PATH.with_suffix(".tmp")
        tmp.write_text(json.dumps(data, indent=1), encoding="utf-8")
        os.replace(tmp, PATH)
    except OSError:
        pass
    return data
