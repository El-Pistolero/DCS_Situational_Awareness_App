"""Command line entry point.

    python -m dcs_sa                       # start the web app
    python -m dcs_sa serve --replay FILE   # web app, live view fed by a file
    python -m dcs_sa analyze FILE          # print a Markdown debrief
    python -m dcs_sa sample                # (re)generate the demo recording
"""

from __future__ import annotations

import argparse
import json
import logging
import sys
import time
from pathlib import Path
from typing import List, Optional

from . import __version__
from .config import Config


def _add_serve_args(p: argparse.ArgumentParser) -> None:
    p.add_argument("--host", help="interface to bind (default 127.0.0.1; 0.0.0.0 to allow a tablet on your LAN)")
    p.add_argument("--port", type=int, help="web port (default 8765)")
    p.add_argument("--recordings", action="append", metavar="DIR", help="extra folder to scan for .acmi files")
    p.add_argument("--player", action="append", metavar="NAME", help="your DCS pilot name, to pick 'your' jet")
    p.add_argument("--tacview", metavar="HOST[:PORT]", help="connect to Tacview real-time telemetry on start")
    p.add_argument("--tacview-password", default=None)
    p.add_argument("--replay", metavar="FILE", help="feed the live view from a recording (testing without DCS)")
    p.add_argument("--speed", type=float, default=None, help="replay speed multiplier")
    p.add_argument("--no-bridge", action="store_true", help="do not listen for the DCS Export.lua bridge")
    p.add_argument("--bridge-port", type=int, help="UDP port for the Export.lua bridge (default 42680)")
    p.add_argument("--no-browser", action="store_true", help="do not open a browser window")


def main(argv: Optional[List[str]] = None) -> int:
    parser = argparse.ArgumentParser(prog="dcs_sa", description="DCS situational awareness and debrief tool")
    parser.add_argument("--version", action="version", version=__version__)
    parser.add_argument("--config", help="path to dcs-sa.toml")
    parser.add_argument("-v", "--verbose", action="store_true")
    sub = parser.add_subparsers(dest="command")

    _add_serve_args(sub.add_parser("serve", help="start the app in a browser tab"))
    pd = sub.add_parser("app", help="start the app in its own desktop window (default)")
    _add_serve_args(pd)
    pd.add_argument("--live", action="store_true", help="open straight into the live view")

    pa = sub.add_parser("analyze", help="print a debrief for a recording")
    pa.add_argument("file")
    pa.add_argument("--json", metavar="OUT", help="also write the full analysis as JSON")
    pa.add_argument("--player", action="append", metavar="NAME")
    pa.add_argument("--focus", metavar="OBJECT_ID", help="aircraft id to write the debrief for")

    ps = sub.add_parser("sample", help="write the synthetic demo recording")
    ps.add_argument("--out", default=str(Path(__file__).resolve().parent.parent / "samples" / "sample_sortie.acmi"))

    # Bare `python -m dcs_sa --replay x` should still work.
    argv = list(sys.argv[1:] if argv is None else argv)
    cmds = ("serve", "app", "analyze", "sample")
    if not argv or argv[0].startswith("-") and argv[0] not in ("-h", "--help", "--version", "-v", "--verbose", "--config"):
        argv = ["app", *argv]
    elif argv[0] in ("-v", "--verbose", "--config") and not any(a in cmds for a in argv):
        argv = [*argv, "app"]
    args = parser.parse_args(argv)

    logging.basicConfig(
        level=logging.DEBUG if args.verbose else logging.INFO,
        format="%(asctime)s %(levelname)s %(name)s: %(message)s",
        datefmt="%H:%M:%S",
    )

    if args.command == "analyze":
        return _analyze(args)
    if args.command == "sample":
        from .samplegen import write_sample

        print(f"wrote {write_sample(args.out)}")
        return 0
    return _serve(args)


def _serve(args) -> int:
    from .server.app import serve

    cfg = _config_from(args)
    if args.command == "app":
        from .desktop import run

        return run(cfg, live_only=getattr(args, "live", False))
    try:
        serve(cfg)
    except OSError as exc:
        print(f"error: could not start server on {cfg.host}:{cfg.port}: {exc}", file=sys.stderr)
        return 2
    return 0


def _config_from(args) -> Config:
    cfg = Config.load(getattr(args, "config", None))
    if args.host:
        cfg.host = args.host
    if args.port:
        cfg.port = args.port
    if args.recordings:
        cfg.recording_dirs = [*args.recordings, *cfg.recording_dirs]
    if args.player:
        cfg.player_names = args.player
    if args.tacview:
        host, _, port = args.tacview.partition(":")
        cfg.tacview_host = host or "127.0.0.1"
        if port:
            cfg.tacview_port = int(port)
        cfg.tacview_autoconnect = True
    if args.tacview_password is not None:
        cfg.tacview_password = args.tacview_password
    if args.replay:
        cfg.replay_file = args.replay
    if args.speed:
        cfg.replay_speed = args.speed
    if args.no_bridge:
        cfg.bridge_enabled = False
    if args.bridge_port:
        cfg.bridge_port = args.bridge_port
    if args.no_browser:
        cfg.open_browser = False
    return cfg


def _analyze(args) -> int:
    from .acmi import parse_file
    from .analysis.report import analyze, to_markdown

    t0 = time.time()
    rec = parse_file(args.file)
    report = analyze(rec, args.player or [])
    print(to_markdown(report, args.focus))
    if args.json:
        with open(args.json, "w", encoding="utf-8") as fh:
            json.dump(report, fh, indent=1, allow_nan=False)
        print(f"\n(analysis JSON written to {args.json})", file=sys.stderr)
    print(f"(parsed and analysed in {time.time() - t0:.1f}s)", file=sys.stderr)
    return 0
