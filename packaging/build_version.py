"""Work out (and stamp in) the version for one CI build.

Every successful build of the default branch is published as a release, so
each one needs its own version number.  It is <major>.<minor> from the source
plus the CI run number, e.g. 0.1.47.  The number is written back into
``dcs_sa/__init__.py`` for that build only (never committed), so the installed
app reports the same version as the release tag it came from; otherwise its
update check would compare against the wrong thing and either nag forever or
never notice a new version.

For a build of a v* tag the tag wins and nothing is rewritten, so a hand-made
release still says exactly what the tag says.

Usage:  python packaging/build_version.py <run-number> [tag-name]
Prints the version.
"""

from __future__ import annotations

import pathlib
import re
import sys

INIT = pathlib.Path(__file__).resolve().parent.parent / "dcs_sa" / "__init__.py"
VERSION_RE = re.compile(r'^__version__ = "([^"]*)"', re.M)


def base_version(source: str) -> str:
    m = VERSION_RE.search(source)
    if not m:
        raise SystemExit(f"no __version__ found in {INIT}")
    parts = m.group(1).split(".")
    if len(parts) < 2 or not all(p.isdigit() for p in parts[:2]):
        raise SystemExit(f"unexpected __version__ {m.group(1)!r} in {INIT}")
    return f"{parts[0]}.{parts[1]}"


def build_version(source: str, run_number: str, tag: str = "") -> str:
    if tag:
        return tag.lstrip("vV")
    return f"{base_version(source)}.{int(run_number)}"


def main(argv: list) -> int:
    run_number = argv[1] if len(argv) > 1 else "0"
    tag = argv[2] if len(argv) > 2 else ""
    source = INIT.read_text(encoding="utf-8")
    version = build_version(source, run_number, tag)
    if not tag:
        INIT.write_text(VERSION_RE.sub(f'__version__ = "{version}"', source, count=1), encoding="utf-8")
    print(version)
    return 0


if __name__ == "__main__":
    raise SystemExit(main(sys.argv))
