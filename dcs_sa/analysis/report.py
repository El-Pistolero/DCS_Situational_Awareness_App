"""Top-level debrief: runs every analysis pass and assembles the result.

:func:`analyze` returns plain JSON-safe dicts so the same output feeds the web
UI, the ``--json`` CLI flag and the Markdown debrief.
"""

from __future__ import annotations

import math
from typing import Dict, Iterable, List, Optional

from ..acmi.model import Recording, Track
from . import geo
from .kinematics import derive, flight_stats
from .landing import analyze_landings
from .radar import analyze_radar
from .timeline import build_timeline
from .weapons import analyze_weapons, apply_dcs_events, find_destructions


def _json_safe(obj):
    if isinstance(obj, float):
        return None if math.isnan(obj) or math.isinf(obj) else obj
    if isinstance(obj, dict):
        return {k: _json_safe(v) for k, v in obj.items()}
    if isinstance(obj, (list, tuple)):
        return [_json_safe(v) for v in obj]
    return obj


def guess_player(rec: Recording, player_names: Iterable[str] = ()) -> Optional[Track]:
    """Pick the aircraft most likely flown by the person reviewing.

    Explicit names win.  Otherwise prefer the aircraft with the richest
    telemetry: DCS exports cockpit-level channels (fuel, AOA, IAS, radar)
    most completely for the local player's own jet.
    """
    aircraft = rec.aircraft()
    if not aircraft:
        return None
    wanted = {n.strip().lower() for n in player_names if n and n.strip()}
    if wanted:
        for tr in aircraft:
            if (tr.pilot or "").lower() in wanted:
                return tr
    mentioned = {oid for e in rec.events if e.kind in ("Message", "TakenOff", "Landed") for oid in e.object_ids}

    def score(tr: Track):
        return (len(tr.channels), tr.id in mentioned, len(tr))

    return max(aircraft, key=score)


def analyze(rec: Recording, player_names: Iterable[str] = (), dcs: Optional[Dict] = None,
            airbases: Optional[List[Dict]] = None) -> Dict:
    """Full debrief.  *dcs* is a merged flight log (values DCS reported while
    flying, see :mod:`dcsmerge`); *airbases* are runways read from DCS."""
    destructions = find_destructions(rec)
    weapons = analyze_weapons(rec, destructions)
    dcs_stats = apply_dcs_events(weapons, rec, dcs["events"]) if dcs else None
    landings = analyze_landings(rec, airbases=airbases)
    radar = analyze_radar(rec, {k: v.time for k, v in destructions.items()}, weapons.shots)
    timeline = build_timeline(rec, weapons, landings, radar)
    if dcs:
        timeline = _add_dcs_timeline(timeline, rec, dcs)

    aircraft = []
    for tr in rec.aircraft():
        stats = flight_stats(tr, derive(tr))
        aircraft.append({**tr.summary(), "stats": _json_safe(stats)})

    player = guess_player(rec, player_names)
    bullseye = rec.bullseye()
    bpos = bullseye.position_at(bullseye.first_seen) if bullseye else None

    # Bounding box of everything that moved, for the initial map view.
    pts = []
    for tr in rec.tracks.values():
        if tr.category in ("clutter", "countermeasure"):
            continue
        lon, lat = tr.channel("Longitude"), tr.channel("Latitude")
        if lon is None or lat is None:
            continue
        step = max(1, len(lon) // 50)
        pts.extend((lon[i], lat[i]) for i in range(0, len(lon), step) if lon[i] == lon[i])
    box = geo.bounds(pts)

    return _json_safe({
        "recording": rec.summary(),
        "player": player.id if player else None,
        "bullseye": {"id": bullseye.id, "longitude": bpos[0], "latitude": bpos[1]} if bpos else None,
        "bounds": list(box) if box else None,
        "objects": [tr.summary() for tr in sorted(rec.tracks.values(), key=lambda t: t.first_seen)
                    if tr.category not in ("clutter", "round")],
        "aircraft": aircraft,
        "weapons": weapons.to_dict(),
        "landings": [ld.to_dict() for ld in landings["landings"]],
        "takeoffs": [to.to_dict() for to in landings["takeoffs"]],
        "radar": {
            "locks": [e.to_dict() for e in radar["locks"]],
            "intervals": [r.to_dict() for r in radar["radar"]],
            "spikes": radar["spikes"],
        },
        "timeline": timeline,
        "dcs": ({"log": dcs["log"], "offset": dcs["offset"], "medianError": dcs["medianError"],
                 "channels": len(dcs["channels"]), "events": len(dcs["events"]), "theatre": dcs.get("theatre"),
                 **(dcs_stats or {})} if dcs else None),
        "runways": bool(airbases),
    })


def _add_dcs_timeline(items: List[Dict], rec: Recording, dcs: Dict) -> List[Dict]:
    """DCS-reported hits (grouped per shooter/target) as timeline entries."""
    out = list(items)
    groups: Dict[tuple, Dict] = {}
    for e in dcs["events"]:
        if e.get("kind") != "hit":
            continue
        who = rec.tracks.get(e.get("initiatorId") or "")
        whom = rec.tracks.get(e.get("targetId") or "")
        key = (e.get("initiatorId"), e.get("targetId"), e.get("weapon"))
        g = groups.get(key)
        if g is not None and e["time"] - g["last"] < 3.0:
            g["count"] += 1
            g["last"] = e["time"]
            continue
        wname = e.get("weapon") or "?"
        g = groups[key] = {"count": 1, "last": e["time"], "item": {
            "time": e["time"], "kind": "hit", "severity": "high",
            "objectIds": [i for i in (e.get("initiatorId"), e.get("targetId")) if i],
            "who": (who.pilot or who.name) if who else ((e.get("initiator") or {}).get("type") or "?"),
            "whom": (whom.pilot or whom.name) if whom else ((e.get("target") or {}).get("type") or "?"),
            "weapon": wname, "source": "DCS"}}
        out.append(g["item"])
    for g in groups.values():
        it = g["item"]
        n = g["count"]
        it["text"] = f"DCS: {it.pop('who')} hit {it.pop('whom')}" + (f" x{n}" if n > 1 else "") + f" ({it.pop('weapon')})"
    out.sort(key=lambda d: (d["time"], d["kind"]))
    return out


# ---------------------------------------------------------------------------
# Markdown debrief
# ---------------------------------------------------------------------------


def _clock(t: Optional[float]) -> str:
    if t is None:
        return "--:--"
    t = max(0.0, t)
    return f"{int(t // 60):02d}:{int(t % 60):02d}"


def _nm(m: Optional[float]) -> str:
    return "-" if m is None else f"{m * geo.NM_PER_M:.1f} nm"


def _kt(v: Optional[float]) -> str:
    return "-" if v is None else f"{v * geo.KT_PER_MPS:.0f} kt"


def _ft(m: Optional[float]) -> str:
    return "-" if m is None else f"{m * geo.FT_PER_M:,.0f} ft"


def to_markdown(report: Dict, focus: Optional[str] = None) -> str:
    rec = report["recording"]
    focus = focus or report.get("player")
    lines: List[str] = []
    lines.append(f"# Debrief: {rec['title']}")
    lines.append("")
    meta = [f"Duration {_clock(rec['duration'])}", f"{rec['objectCount']} objects",
            f"{rec['aircraftCount']} aircraft"]
    if rec.get("referenceTime"):
        meta.insert(0, rec["referenceTime"].replace("+00:00", "Z"))
    if rec["globals"].get("DataSource"):
        meta.append(str(rec["globals"]["DataSource"]))
    lines.append(" | ".join(meta))
    lines.append("")

    ac_by_id = {a["id"]: a for a in report["aircraft"]}
    if focus and focus in ac_by_id:
        a = ac_by_id[focus]
        s = a.get("stats", {})
        lines.append(f"## Your sortie: {a.get('pilot') or a['name']} ({a['name']})")
        lines.append("")
        lines.append("| Metric | Value |")
        lines.append("|---|---|")
        lines.append(f"| Flight time | {_clock(s.get('duration'))} |")
        lines.append(f"| Distance flown | {_nm(s.get('distance'))} |")
        lines.append(f"| Max altitude | {_ft(s.get('maxAltitude'))} |")
        lines.append(f"| Max IAS | {_kt(s.get('maxIAS'))} |")
        if s.get("maxMach") is not None:
            lines.append(f"| Max Mach | {s['maxMach']:.2f} |")
        if s.get("maxG") is not None:
            lines.append(f"| G range | {s.get('minG', 0):.1f} to {s['maxG']:.1f} g |")
        if s.get("maxAOA") is not None:
            lines.append(f"| Max AOA | {s['maxAOA']:.1f} deg |")
        if s.get("fuelUsed") is not None:
            lines.append(f"| Fuel used | {s['fuelUsed']:.0f} kg |")
        if s.get("afterburnerTime"):
            lines.append(f"| Afterburner time | {_clock(s['afterburnerTime'])} |")
        lines.append("")

    w = report["weapons"]
    if w["shots"] or w["bursts"]:
        lines.append("## Weapons employment")
        lines.append("")
        lines.append("| Time | Shooter | Weapon | Target | Range | Aspect | TOF | Result |")
        lines.append("|---|---|---|---|---|---|---|---|")
        for s in w["shots"]:
            g = s.get("geometry") or {}
            aspect = f"{g['aspect']:.0f} deg" if g.get("aspect") is not None else "-"
            lines.append(
                f"| {_clock(s['launchTime'])} | {s.get('launcherPilot') or s.get('launcherName') or '?'} "
                f"| {s['weaponName']} | {s.get('targetPilot') or s.get('targetName') or '-'} "
                f"| {_nm(g.get('range'))} | {aspect} | {s['timeOfFlight']:.1f}s | **{s['outcome']}** |"
            )
        for b in w["bursts"]:
            rng = f"{b['rangeAtOpen']:.0f} m" if b.get("rangeAtOpen") else "-"
            lines.append(
                f"| {_clock(b['start'])} | {b.get('launcherPilot') or b['launcherName']} | Gun "
                f"({b['rounds']} rds) | {b.get('targetName') or '-'} | {rng} | - "
                f"| {b['end'] - b['start']:.1f}s | **{'kill' if b['kill'] else 'no kill'}** |"
            )
        lines.append("")

    if w["kills"]:
        lines.append("## Kills and losses")
        lines.append("")
        for k in w["kills"]:
            victim = f"{k['victimPilot']} ({k['victimName']})" if k.get("victimPilot") else k["victimName"]
            if k.get("killerId"):
                by = f"{k.get('killerPilot') or k.get('killerName')} - {k.get('weaponName')}"
                miss = f", {k['missDistance']:.0f} m" if k.get("missDistance") is not None else ""
                lines.append(f"- `{_clock(k['time'])}` **{victim}** destroyed by {by}{miss}")
            else:
                lines.append(f"- `{_clock(k['time'])}` **{victim}** destroyed ({k['cause']}, {k['confidence']})")
        lines.append("")

    if report["radar"]["locks"]:
        lines.append("## Radar locks")
        lines.append("")
        lines.append("| Start | Owner | Target | Range at lock | Held | Ended |")
        lines.append("|---|---|---|---|---|---|")
        for ep in report["radar"]["locks"]:
            lines.append(
                f"| {_clock(ep['start'])} | {ep.get('ownerPilot') or ep['ownerName']} "
                f"| {ep.get('targetPilot') or ep.get('targetName') or '?'} | {_nm(ep.get('rangeStart'))} "
                f"| {ep['duration']:.0f}s | {ep['endedBy']} |"
            )
        lines.append("")

    if report["takeoffs"] or report["landings"]:
        lines.append("## Takeoffs and landings")
        lines.append("")
        for to in report["takeoffs"]:
            if focus and to["aircraftId"] != focus:
                continue
            roll = f"{to['groundRollM']:.0f} m" if to.get("groundRollM") else "-"
            lines.append(f"- `{_clock(to['time'])}` Takeoff from **{to['location']}**: "
                         f"liftoff {_kt(to.get('liftoffIas'))}, ground roll {roll}"
                         + (f", gear up +{to['gearUpAfterS']:.1f}s" if to.get("gearUpAfterS") is not None else ""))
        for ld in report["landings"]:
            if focus and ld["aircraftId"] != focus:
                continue
            td = ld["touchdown"]
            sink = f"{td['sinkRateFpm']:.0f} fpm" if td.get("sinkRateFpm") is not None else "-"
            aoa = f"{td['aoa']:.1f} deg" if td.get("aoa") is not None else "-"
            lines.append(f"- `{_clock(ld['time'])}` **{ld['outcome'].title()}** at **{ld['location']}** - "
                         f"grade **{ld['grade']}** ({ld['score']}/100)")
            lines.append(f"  - Touchdown: {_kt(td.get('ias'))}, sink {sink}, AOA {aoa}")
            if ld.get("gates"):
                gate_txt = ", ".join(
                    f"{g['distanceNm']:g} nm {g['gsDeviationDeg']:+.1f} deg" for g in ld["gates"]
                )
                lines.append(f"  - Glidepath: {gate_txt}")
            for c in ld.get("comments", []):
                lines.append(f"  - {c}")
        lines.append("")

    lines.append("## Timeline")
    lines.append("")
    for it in report["timeline"]:
        if it["kind"] in ("spiked",) and focus and focus not in it["objectIds"]:
            continue
        lines.append(f"- `{_clock(it['time'])}` [{it['kind']}] {it['text']}")
    lines.append("")
    return "\n".join(lines)
