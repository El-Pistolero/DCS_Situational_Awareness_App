"""A single, time-ordered debrief timeline.

Merges the events the recording itself carries (``Event=Message`` and
friends) with everything the analysis layer derived, so the UI can show one
scrollable list and jump the playhead to any moment.
"""

from __future__ import annotations

from typing import Dict, List, Optional

from ..acmi.model import Recording
from . import geo

SEVERITY = {
    "kill": "high", "destroyed": "high", "shot": "medium", "hit": "high",
    "spiked": "medium", "lock": "low", "landing": "medium", "takeoff": "medium",
    "gun": "medium", "bookmark": "low", "message": "low", "radar": "low",
}


def _item(t: float, kind: str, text: str, ids: Optional[List[str]] = None, **extra) -> Dict:
    d = {"time": t, "kind": kind, "severity": SEVERITY.get(kind, "low"), "text": text, "objectIds": ids or []}
    d.update(extra)
    return d


def _nm(m: Optional[float]) -> str:
    return f"{m * geo.NM_PER_M:.1f} nm" if m is not None else "? nm"


def build_timeline(rec: Recording, weapons, landings: Dict, radar: Dict) -> List[Dict]:
    items: List[Dict] = []
    name = lambda oid: (rec.tracks[oid].display_name if oid in rec.tracks else oid)  # noqa: E731

    for e in rec.events:
        kind = e.kind.lower()
        if kind in ("destroyed", "takenoff", "landed", "timeout"):
            continue  # represented by richer derived items below
        who = ", ".join(name(i) for i in e.object_ids)
        text = e.text if not who else (f"{who}: {e.text}" if e.text else who)
        items.append(_item(e.time, "bookmark" if kind == "bookmark" else "message", text, e.object_ids))

    for s in weapons.shots:
        who = s.launcher_pilot or s.launcher_name or "Unknown"
        tgt = f" at {s.target_pilot or s.target_name}" if s.target_name else ""
        rng = f" ({_nm(s.geometry.get('range'))})" if s.geometry.get("range") else ""
        items.append(_item(s.launch_time, "shot", f"{who} fired {s.weapon_name}{tgt}{rng}",
                           [i for i in (s.launcher_id, s.target_id, s.weapon_id) if i],
                           outcome=s.outcome))
        if s.outcome in ("miss", "damage"):
            items.append(_item(s.end_time, "shot", f"{s.weapon_name} from {who}: {s.outcome}"
                               + (f" ({s.outcome_detail})" if s.outcome_detail else ""),
                               [s.weapon_id]))
    for b in weapons.bursts:
        who = b.launcher_pilot or b.launcher_name
        tgt = f" at {b.target_name}" if b.target_name else ""
        rounds = f"{b.rounds} rds" if b.rounds else "trigger"
        if b.dcs_hits is not None:
            rounds += f", {b.dcs_hits} hits (DCS)"
        items.append(_item(b.start, "gun", f"{who} gun burst{tgt} ({rounds})", [b.launcher_id]))
    for k in weapons.kills:
        victim = f"{k.victim_pilot} ({k.victim_name})" if k.victim_pilot else k.victim_name
        if k.killer_id:
            killer = k.killer_pilot or k.killer_name
            text = f"{killer} killed {victim} with {k.weapon_name}"
            if k.confirmed_by:
                text += f" ({k.confirmed_by} confirmed)"
        else:
            text = f"{victim} destroyed" + (" (probable)" if k.confidence == "probable" else "")
        items.append(_item(k.time, "kill", text, [i for i in (k.victim_id, k.killer_id) if i]))

    for to in landings.get("takeoffs", []):
        items.append(_item(to.time, "takeoff", f"{to.pilot or to.aircraft_name} took off from {to.location}",
                           [to.aircraft_id]))
    for ld in landings.get("landings", []):
        items.append(_item(ld.time, "landing",
                           f"{ld.pilot or ld.aircraft_name} {ld.outcome} at {ld.location} - grade {ld.grade}",
                           [ld.aircraft_id], landingIndex=landings["landings"].index(ld)))

    for ep in radar.get("locks", []):
        if not ep.target_id:
            continue
        who = ep.owner_pilot or ep.owner_name
        tgt = ep.target_pilot or ep.target_name
        items.append(_item(ep.start, "lock", f"{who} locked {tgt} at {_nm(ep.range_start)}",
                           [ep.owner_id, ep.target_id]))
        if ep.target_id in rec.tracks and rec.tracks[ep.target_id].category in ("fixedwing", "rotorcraft"):
            items.append(_item(ep.start, "spiked", f"{tgt} spiked by {who}", [ep.target_id, ep.owner_id]))

    items.sort(key=lambda d: (d["time"], d["kind"]))
    return items
