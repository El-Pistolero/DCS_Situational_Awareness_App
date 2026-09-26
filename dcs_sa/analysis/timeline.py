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
    "release": "medium", "impact": "medium", "decoy": "medium", "flares": "low",
}


def _item(t: float, kind: str, text: str, ids: Optional[List[str]] = None, **extra) -> Dict:
    d = {"time": t, "kind": kind, "severity": SEVERITY.get(kind, "low"), "text": text, "objectIds": ids or []}
    d.update(extra)
    return d


def _who(rec: Recording, oid: str) -> str:
    """Pilot name, else the aircraft type."""
    tr = rec.tracks.get(oid)
    return (tr.pilot or tr.name or oid) if tr is not None else oid


def _nm(m: Optional[float]) -> str:
    return f"{m * geo.NM_PER_M:.1f} nm" if m is not None else "? nm"


def build_timeline(rec: Recording, weapons, landings: Dict, radar: Dict, strikes=None, ir=None,
                   player_id: Optional[str] = None) -> List[Dict]:
    items: List[Dict] = []
    strike_ids = {st.weapon_id for st in strikes or []}
    name = lambda oid: (rec.tracks[oid].display_name if oid in rec.tracks else oid)  # noqa: E731

    for e in rec.events:
        kind = e.kind.lower()
        if kind in ("destroyed", "takenoff", "landed", "timeout"):
            continue  # represented by richer derived items below
        who = ", ".join(name(i) for i in e.object_ids)
        text = e.text if not who else (f"{who}: {e.text}" if e.text else who)
        items.append(_item(e.time, "bookmark" if kind == "bookmark" else "message", text, e.object_ids))

    for s in weapons.shots:
        if s.weapon_id in strike_ids:
            continue  # air-to-ground: release/impact items below
        who = s.launcher_pilot or s.launcher_name or "Unknown"
        tgt = f" at {s.target_pilot or s.target_name}" if s.target_name else ""
        rng = f" ({_nm(s.geometry.get('range'))})" if s.geometry.get("range") else ""
        items.append(_item(s.launch_time, "shot", f"{who} fired {s.weapon_name}{tgt}{rng}",
                           [i for i in (s.launcher_id, s.target_id, s.weapon_id) if i],
                           outcome=s.outcome))
        decoy = (s.ir or {}).get("decoy")
        if decoy:
            by = decoy.get("owner")
            whose = f"{_who(rec, by)}'s flare" if by else "a flare"
            wname = (s.ir.get("seeker") or {}).get("short") or s.weapon_name
            items.append(_item(s.launch_time + decoy["t"], "decoy",
                               f"{wname} from {who} likely went for {whose} (est.)",
                               [i for i in (s.weapon_id, by, decoy.get("flareId")) if i],
                               estimated=True))
        if s.outcome in ("miss", "damage"):
            items.append(_item(s.end_time, "shot", f"{s.weapon_name} from {who}: {s.outcome}"
                               + (f" ({s.outcome_detail})" if s.outcome_detail else ""),
                               [s.weapon_id]))
    for st in strikes or []:
        who = st.launcher_pilot or st.launcher_name or "Unknown"
        tgt = f" at {st.target_name}" if st.target_name else ""
        rel = st.release
        bits = []
        if rel.get("altitude") is not None:
            bits.append(f"{rel['altitude'] * 3.28084 / 1000:.1f}k ft")
        if st.ground_range:
            bits.append(_nm(st.ground_range))
        items.append(_item(st.release_time, "release", f"{who} released {st.weapon_name}{tgt}"
                           + (f" ({', '.join(bits)})" if bits else ""),
                           [i for i in (st.launcher_id, st.target_id, st.weapon_id) if i]))
        if st.dispense:
            items.append(_item(st.dispense["time"], "impact", f"{st.weapon_name} opened: {st.submunitions} submunitions",
                               [st.weapon_id]))
        if st.result == "in flight":
            continue
        miss = f", {st.miss_distance:.0f} m from {st.target_name}" if st.miss_distance is not None and st.target_name else ""
        dmg = f" - destroyed {', '.join(str(d['name']) for d in st.damage)}" if st.damage else ""
        items.append(_item(st.impact_time, "impact", f"{st.weapon_name} from {who} impact{miss}{dmg}",
                           [i for i in (st.weapon_id, st.target_id) if i], result=st.result))
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

    # Flare salvos that matter: the player's, and any jet's with a missile in flight at it.
    for owner, rows in ((ir or {}).get("salvos") or {}).items():
        for sv in rows:
            if sv["kind"] != "flare" or sv["n"] < 2:
                continue
            shot_at = any(s.target_id == owner and s.launch_time <= sv["t0"] <= (s.end_time or s.launch_time) + 1.0
                          for s in weapons.shots)
            if owner == player_id or shot_at:
                items.append(_item(sv["t0"], "flares", f"{_who(rec, owner)} flares x{sv['n']}", [owner]))

    items.sort(key=lambda d: (d["time"], d["kind"]))
    return items
