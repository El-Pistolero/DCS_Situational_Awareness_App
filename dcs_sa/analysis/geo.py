"""Geodesy helpers.

ACMI stores WGS84 longitude/latitude plus altitude in metres.  Tactical
analysis wants metres in a local frame, so most of this file is conversions
between the two, using an equirectangular projection around a local origin.
Over the tens of kilometres that matter in a DCS engagement the error from
ignoring ellipsoid curvature is well under a metre.
"""

from __future__ import annotations

import math
from typing import Iterable, Optional, Sequence, Tuple

EARTH_RADIUS_M = 6371008.8
M_PER_DEG_LAT = EARTH_RADIUS_M * math.pi / 180.0

FT_PER_M = 3.280839895013123
KT_PER_MPS = 1.9438444924406046
NM_PER_M = 1.0 / 1852.0
FPM_PER_MPS = 196.85039370078738


def m_per_deg_lon(lat_deg: float) -> float:
    return M_PER_DEG_LAT * math.cos(math.radians(lat_deg))


def to_local(lon: float, lat: float, origin_lon: float, origin_lat: float) -> Tuple[float, float]:
    """Project to local east/north metres about an origin."""
    east = (lon - origin_lon) * m_per_deg_lon(origin_lat)
    north = (lat - origin_lat) * M_PER_DEG_LAT
    return east, north


def to_lonlat(east: float, north: float, origin_lon: float, origin_lat: float) -> Tuple[float, float]:
    lat = origin_lat + north / M_PER_DEG_LAT
    lon = origin_lon + east / m_per_deg_lon(origin_lat)
    return lon, lat


def ground_distance(lon1: float, lat1: float, lon2: float, lat2: float) -> float:
    """Great-circle distance in metres (haversine)."""
    p1, p2 = math.radians(lat1), math.radians(lat2)
    dp = p2 - p1
    dl = math.radians(lon2 - lon1)
    a = math.sin(dp / 2) ** 2 + math.cos(p1) * math.cos(p2) * math.sin(dl / 2) ** 2
    return 2 * EARTH_RADIUS_M * math.asin(min(1.0, math.sqrt(a)))


def slant_range(
    lon1: float, lat1: float, alt1: float,
    lon2: float, lat2: float, alt2: float,
) -> float:
    d = ground_distance(lon1, lat1, lon2, lat2)
    return math.hypot(d, alt2 - alt1)


def bearing(lon1: float, lat1: float, lon2: float, lat2: float) -> float:
    """True bearing from point 1 to point 2, degrees 0-360."""
    p1, p2 = math.radians(lat1), math.radians(lat2)
    dl = math.radians(lon2 - lon1)
    y = math.sin(dl) * math.cos(p2)
    x = math.cos(p1) * math.sin(p2) - math.sin(p1) * math.cos(p2) * math.cos(dl)
    return (math.degrees(math.atan2(y, x)) + 360.0) % 360.0


def wrap180(deg: float) -> float:
    """Normalise an angle to (-180, 180]."""
    d = (deg + 180.0) % 360.0 - 180.0
    return 180.0 if d == -180.0 else d


def wrap360(deg: float) -> float:
    return deg % 360.0


def angle_diff(a: float, b: float) -> float:
    """Signed smallest difference a - b."""
    return wrap180(a - b)


def destination(lon: float, lat: float, bearing_deg: float, distance_m: float) -> Tuple[float, float]:
    """Point *distance_m* from (lon, lat) along a true bearing."""
    east = math.sin(math.radians(bearing_deg)) * distance_m
    north = math.cos(math.radians(bearing_deg)) * distance_m
    return to_lonlat(east, north, lon, lat)


def aspect_angle(
    target_lon: float, target_lat: float, target_heading: float,
    observer_lon: float, observer_lat: float,
) -> float:
    """Target aspect: 0 deg means we are looking at the target's tail."""
    brg_to_observer = bearing(target_lon, target_lat, observer_lon, observer_lat)
    return abs(wrap180(brg_to_observer - target_heading + 180.0))


def closure_rate(
    lon1: float, lat1: float, alt1: float,
    lon2: float, lat2: float, alt2: float,
    prev: Tuple[float, float, float, float, float, float],
    dt: float,
) -> float:
    """Positive when the two objects are closing, m/s."""
    if dt <= 0:
        return 0.0
    r_now = slant_range(lon1, lat1, alt1, lon2, lat2, alt2)
    r_prev = slant_range(*prev)
    return (r_prev - r_now) / dt


def mean_position(points: Sequence[Tuple[float, float]]) -> Optional[Tuple[float, float]]:
    if not points:
        return None
    return (
        sum(p[0] for p in points) / len(points),
        sum(p[1] for p in points) / len(points),
    )


def bounds(points: Iterable[Tuple[float, float]]) -> Optional[Tuple[float, float, float, float]]:
    """(min_lon, min_lat, max_lon, max_lat) or None when there are no points."""
    min_lon = min_lat = math.inf
    max_lon = max_lat = -math.inf
    seen = False
    for lon, lat in points:
        seen = True
        min_lon = min(min_lon, lon)
        max_lon = max(max_lon, lon)
        min_lat = min(min_lat, lat)
        max_lat = max(max_lat, lat)
    return (min_lon, min_lat, max_lon, max_lat) if seen else None
