"""Tacview object type tags.

``Type=Air+FixedWing`` is a ``+``-separated tag set rather than a single
enum, so classification is a matter of asking which tags are present.
"""

from __future__ import annotations

from typing import FrozenSet, Iterable

CLASSES = {"Air", "Ground", "Sea", "Weapon", "Sensor", "Navaid", "Misc"}
ATTRIBUTES = {"Static", "Heavy", "Medium", "Light", "Minor"}
BASIC_TYPES = {
    "FixedWing", "Rotorcraft", "Armor", "AntiAircraft", "Vehicle",
    "Watercraft", "Human", "Biologic", "Missile", "Rocket", "Bomb",
    "Torpedo", "Projectile", "Beam", "Decoy", "Building", "Bullseye",
    "Waypoint",
}
SPECIFIC_TYPES = {
    "Tank", "Warship", "AircraftCarrier", "Submarine", "Infantry",
    "Parachutist", "Shell", "Bullet", "Grenade", "Flare", "Chaff",
    "SmokeGrenade", "Aerodrome", "Container", "Shrapnel", "Explosion",
}

#: Tags that make an object a piece of ordnance in flight.
ORDNANCE_TAGS = frozenset({"Missile", "Rocket", "Bomb", "Torpedo", "Shell", "Projectile"})
#: Tags for expendables we do not want cluttering an engagement report.
COUNTERMEASURE_TAGS = frozenset({"Flare", "Chaff", "Decoy", "SmokeGrenade"})
#: Tags for things that are never a meaningful tactical contact.
CLUTTER_TAGS = frozenset({"Shrapnel", "Explosion", "Beam", "Grenade"})
#: Guided or powered ordnance - anything carrying one of these is not a gun round.
_NOT_ROUND = frozenset({"Missile", "Rocket", "Bomb", "Torpedo"})


def parse_tags(type_str: str | None) -> FrozenSet[str]:
    if not type_str:
        return frozenset()
    return frozenset(t.strip() for t in type_str.split("+") if t.strip())


def _has_any(tags: Iterable[str], wanted: Iterable[str]) -> bool:
    tagset = tags if isinstance(tags, (set, frozenset)) else set(tags)
    return any(w in tagset for w in wanted)


def is_air(tags: FrozenSet[str]) -> bool:
    return "Air" in tags


def is_aircraft(tags: FrozenSet[str]) -> bool:
    """An air vehicle with a crew - excludes missiles that are also tagged Air."""
    return "Air" in tags and _has_any(tags, ("FixedWing", "Rotorcraft"))


def is_weapon(tags: FrozenSet[str]) -> bool:
    return "Weapon" in tags or _has_any(tags, ORDNANCE_TAGS)


def is_guided(tags: FrozenSet[str]) -> bool:
    return _has_any(tags, ("Missile", "Torpedo"))

def is_countermeasure(tags: FrozenSet[str]) -> bool:
    return _has_any(tags, COUNTERMEASURE_TAGS)


def is_gun_round(tags: FrozenSet[str]) -> bool:
    """Cannon / machine-gun / AAA round.

    Tacview uses both ``Bullet`` and ``Shell``; some writers emit a bare
    ``Projectile``.  Rockets and missiles are ``Projectile`` too in a few
    exporters, so the guided/powered tags win.
    """
    if tags & _NOT_ROUND:
        return False
    return bool(tags & {"Bullet", "Shell"}) or ("Projectile" in tags and "Weapon" in tags) or tags == {"Projectile"}


def is_clutter(tags: FrozenSet[str]) -> bool:
    return _has_any(tags, CLUTTER_TAGS)


def is_ground(tags: FrozenSet[str]) -> bool:
    return "Ground" in tags


def is_sea(tags: FrozenSet[str]) -> bool:
    return "Sea" in tags


def is_static(tags: FrozenSet[str]) -> bool:
    return "Static" in tags or _has_any(tags, ("Building", "Aerodrome", "Bullseye", "Waypoint"))


def is_carrier(tags: FrozenSet[str]) -> bool:
    return "AircraftCarrier" in tags


def is_bullseye(tags: FrozenSet[str]) -> bool:
    return "Bullseye" in tags


def category(tags: FrozenSet[str]) -> str:
    """Single bucket used for colouring and filtering in the UI."""
    if is_bullseye(tags):
        return "bullseye"
    if is_countermeasure(tags):
        return "countermeasure"
    if is_gun_round(tags):
        return "round"
    if is_clutter(tags):
        return "clutter"
    if is_weapon(tags):
        return "weapon"
    if is_aircraft(tags):
        return "rotorcraft" if "Rotorcraft" in tags else "fixedwing"
    if is_air(tags):
        return "air"
    if is_sea(tags):
        return "sea"
    if is_ground(tags):
        return "ground"
    if "Navaid" in tags:
        return "navaid"
    return "misc"


#: Categories worth keeping a full-rate telemetry history for.
DETAILED_CATEGORIES = frozenset({"fixedwing", "rotorcraft", "air"})
