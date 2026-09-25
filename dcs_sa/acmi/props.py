"""Registry of ACMI 2.x properties.

Source of truth is the Tacview ACMI specification.  Every property we know
about is classified as numeric or text so the parser can coerce values once,
at parse time, instead of guessing later.
"""

from __future__ import annotations

# --- Global (object id 0) -------------------------------------------------

GLOBAL_TEXT = {
    "DataSource",
    "DataRecorder",
    "ReferenceTime",
    "RecordingTime",
    "Author",
    "Title",
    "Category",
    "Briefing",
    "Debriefing",
    "Comments",
    "MapId",
}

GLOBAL_NUMERIC = {
    "ReferenceLongitude",
    "ReferenceLatitude",
}

# --- Per-object text properties ------------------------------------------

OBJECT_TEXT = {
    "Name",
    "Type",
    "AdditionalType",
    "ShortName",
    "LongName",
    "FullName",
    "CallSign",
    "Registration",
    "Squawk",
    "ICAO24",
    "Pilot",
    "Group",
    "Country",
    "Coalition",
    "Color",
    "Shape",
    "Debug",
    "Label",
    "Parent",
    "Next",
    "FocusedTarget",
}
# LockedTarget, LockedTarget2..LockedTarget9 hold object ids (hex strings).
OBJECT_TEXT.add("LockedTarget")
OBJECT_TEXT.update(f"LockedTarget{i}" for i in range(2, 10))

# --- Per-object numeric properties ---------------------------------------

_BASE_NUMERIC = {
    # Generic state
    "Importance",
    "Slot",
    "Disabled",
    "Visible",
    "Health",
    "Length",
    "Width",
    "Height",
    "Radius",
    # Air data
    "IAS",
    "CAS",
    "TAS",
    "Mach",
    "AOA",
    "AOS",
    "AGL",
    "HDG",
    "HDM",
    # Engines
    "Throttle",
    "Throttle2",
    "EngineRPM",
    "EngineRPM2",
    "NR",
    "NR2",
    "RotorRPM",
    "RotorRPM2",
    "Afterburner",
    # Mechanical
    "AirBrakes",
    "Flaps",
    "LandingGear",
    "LandingGearHandle",
    "Tailhook",
    "Parachute",
    "DragChute",
    # Flight controls
    "RollControlInput",
    "PitchControlInput",
    "YawControlInput",
    "RollControlPosition",
    "PitchControlPosition",
    "YawControlPosition",
    "RollTrimTab",
    "PitchTrimTab",
    "YawTrimTab",
    "AileronLeft",
    "AileronRight",
    "Elevator",
    "Rudder",
    # Radar
    "RadarMode",
    "RadarAzimuth",
    "RadarElevation",
    "RadarRoll",
    "RadarRange",
    "RadarHorizontalBeamwidth",
    "RadarVerticalBeamwidth",
    "RadarRangeGateAzimuth",
    "RadarRangeGateElevation",
    "RadarRangeGateRoll",
    "RadarRangeGateMin",
    "RadarRangeGateMax",
    "RadarRangeGateHorizontalBeamwidth",
    "RadarRangeGateVerticalBeamwidth",
    # Locked target
    "LockedTargetMode",
    "LockedTargetAzimuth",
    "LockedTargetElevation",
    "LockedTargetRange",
    # Engagement envelopes (SAM/AAA rings)
    "EngagementMode",
    "EngagementMode2",
    "EngagementRange",
    "EngagementRange2",
    "VerticalEngagementRange",
    "VerticalEngagementRange2",
    # ILS
    "LocalizerLateralDeviation",
    "GlideslopeVerticalDeviation",
    "LocalizerAngularDeviation",
    "GlideslopeAngularDeviation",
    # Pilot body / gaze
    "PilotHeadRoll",
    "PilotHeadPitch",
    "PilotHeadYaw",
    "PilotEyeGazePitch",
    "PilotEyeGazeYaw",
    "HeartRate",
    "SpO2",
    # Forces and atmosphere
    "VerticalGForce",
    "LongitudinalGForce",
    "LateralGForce",
    "QNH",
    "WindDirection",
    "WindPitch",
    "WindSpeed",
    # Weapons
    "TriggerPressed",
}

OBJECT_NUMERIC = set(_BASE_NUMERIC)
OBJECT_NUMERIC.add("FuelWeight")
OBJECT_NUMERIC.update(f"FuelWeight{i}" for i in range(2, 10))
OBJECT_NUMERIC.add("FuelVolume")
OBJECT_NUMERIC.update(f"FuelVolume{i}" for i in range(2, 10))
OBJECT_NUMERIC.add("FuelFlowWeight")
OBJECT_NUMERIC.update(f"FuelFlowWeight{i}" for i in range(2, 9))
OBJECT_NUMERIC.add("FuelFlowVolume")
OBJECT_NUMERIC.update(f"FuelFlowVolume{i}" for i in range(2, 9))

ALL_NUMERIC = OBJECT_NUMERIC | GLOBAL_NUMERIC
ALL_TEXT = OBJECT_TEXT | GLOBAL_TEXT

#: Channels derived from the ``T=`` transform rather than a named property.
TRANSFORM_CHANNELS = (
    "Longitude",
    "Latitude",
    "Altitude",
    "Roll",
    "Pitch",
    "Yaw",
    "U",
    "V",
    "Heading",
)

#: Properties holding a reference to another object id.
REFERENCE_PROPS = {"Parent", "Next", "FocusedTarget", "LockedTarget"} | {
    f"LockedTarget{i}" for i in range(2, 10)
}

#: Units, for display.  Anything absent is dimensionless.
UNITS = {
    "Longitude": "deg",
    "Latitude": "deg",
    "Altitude": "m",
    "Roll": "deg",
    "Pitch": "deg",
    "Yaw": "deg",
    "Heading": "deg",
    "IAS": "m/s",
    "CAS": "m/s",
    "TAS": "m/s",
    "AOA": "deg",
    "AOS": "deg",
    "AGL": "m",
    "HDG": "deg",
    "HDM": "deg",
    "EngineRPM": "rpm",
    "EngineRPM2": "rpm",
    "RotorRPM": "rpm",
    "RadarAzimuth": "deg",
    "RadarElevation": "deg",
    "RadarRange": "m",
    "LockedTargetAzimuth": "deg",
    "LockedTargetElevation": "deg",
    "LockedTargetRange": "m",
    "EngagementRange": "m",
    "VerticalEngagementRange": "m",
    "LocalizerLateralDeviation": "m",
    "GlideslopeVerticalDeviation": "m",
    "LocalizerAngularDeviation": "deg",
    "GlideslopeAngularDeviation": "deg",
    "VerticalGForce": "g",
    "LongitudinalGForce": "g",
    "LateralGForce": "g",
    "QNH": "hPa",
    "WindDirection": "deg",
    "WindSpeed": "m/s",
    "Length": "m",
    "Width": "m",
    "Height": "m",
    "Radius": "m",
    "HeartRate": "bpm",
    "SpO2": "%",
}
for _i in ["", *[str(i) for i in range(2, 10)]]:
    UNITS[f"FuelWeight{_i}"] = "kg"
    UNITS[f"FuelVolume{_i}"] = "l"
for _i in ["", *[str(i) for i in range(2, 9)]]:
    UNITS[f"FuelFlowWeight{_i}"] = "kg/h"
    UNITS[f"FuelFlowVolume{_i}"] = "l/h"


def is_numeric(name: str) -> bool:
    """True when *name* should be coerced to a float.

    Unknown properties fall back to text so a future Tacview release adding a
    property we have never heard of still round-trips intact.
    """
    return name in ALL_NUMERIC
