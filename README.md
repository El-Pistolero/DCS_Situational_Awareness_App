# DCS Situational Awareness

A desktop app for **DCS World** that shows you everything about a sortie. It works **live on a second screen** while you fly, and as a detailed **debrief** afterwards.

It reads **Tacview** data. Tacview is the program; **ACMI** (`.acmi`) is its file format. You were half-right about both!

![Live view](docs/live.png)

## What you get

| | Live (second screen) | Debrief (after the flight) |
|---|---|---|
| **Map** | Heading-up tactical map on satellite / relief ground, range rings, trails | Full replay with play/pause/scrub at 0.5× to 64×, satellite / relief / topo ground |
| **Your aircraft** | IAS, altitude, heading, Mach, AOA, G, V/S, fuel, gear/flaps | Attitude indicator, all flight data at any moment, charts over the whole flight |
| **Your inputs** | Stick / rudder deflection (via the DCS bridge) | Stick & rudder display, throttle/afterburner, brakes, hook, trigger |
| **Radar** | Your radar cone, lock lines, **RWR scope** | Lock episodes (who, range, how long, how it ended), who locked *you* |
| **Threats** | Inbound missiles with **time-to-impact** and clock position, spikes, hot bandits, SAM rings you're inside, optional audio warning | — |
| **Weapons** | Stores remaining, chaff/flare counts | Every shot: shooter, target, launch range, aspect, time of flight, **kill / miss**; gun bursts; kill list; Pk per pilot |
| **Landing** | — | Approach glidepath and centreline charts, gates at 4 to 0.25 nm, touchdown sink rate / speed / AOA / crab, stabilised-approach check, **grade** (LSO-style on the carrier) |
| **All aircraft** | Every contact with labels | Stats for every aircraft; select any of them for full telemetry |

## Install (Windows)

**Option A: the exe (recommended)**
1. On GitHub open **Actions → Build Windows exe**, click the latest run, and download **DCS-SA-windows** (or grab `DCS-SA.exe` from a Release).
2. Double-click `DCS-SA.exe`. It opens in its own window; close the window to quit.

**Option B: run from source**
1. Install [Python 3.10+](https://www.python.org/downloads/) (tick *Add to PATH*).
2. Double-click `run.bat`. For native windows instead of an app-style browser window, also run `pip install pywebview`.

To build the exe yourself, double-click `build_exe.bat`; the result is `dist\DCS-SA.exe`.

## Set up DCS (one time)

1. **Recordings for the debrief:** in DCS go to *Options → Special → Tacview*, then enable recording. Files land in `Documents\Tacview` and the app finds them automatically. You can also drag and drop any `.acmi` onto the app.
2. **Your jet live on the second screen:** open the live view (*Live view ↗* button), click **⚙ Connect**, then **Install DCS bridge into Export.lua**. Restart the mission. This streams your own aircraft (flight data, inputs, stores, RWR) and never touches your other exporters (Tacview, SRS, DCS-BIOS keep working).
3. **Everyone else live (optional):** Tacview's *real-time telemetry* streams every aircraft and missile. Enable it in the Tacview settings in DCS, then in the live view use **⚙ Connect → Tacview → Connect** (default `127.0.0.1:42674`). This needs Tacview Advanced on the PC running DCS.

On a multiplayer server the server decides what may be exported. The bridge only ever *reads*, and anything the server blocks simply doesn't appear.

**Your profile:** the app reads the active pilot from your DCS logbook (`Saved Games\DCS\MissionEditor\logbook.lua`) and uses that name to pick *your* jet in recordings and live. You can override it in `dcs-sa.toml` (see `dcs-sa.example.toml`) or click **This is me** on any aircraft.

## Try it without DCS

The app ships with a generated demo sortie (`samples/sample_sortie.acmi`): takeoff from Batumi, an AIM-120 kill, a notched R-27, a strafing pass and a landing. Open it from the recordings list. To see the live view in action without DCS, go to *⚙ Connect → Replay a recording*.

## Command line

```
python -m dcs_sa                        # desktop window (same as the exe)
python -m dcs_sa app --live             # open straight into the live view
python -m dcs_sa serve                  # browser tab instead; add --host 0.0.0.0 to use a tablet on your LAN
python -m dcs_sa analyze flight.acmi    # text debrief in the terminal (--json out.json for everything)
python -m dcs_sa serve --replay flight.acmi --speed 4   # feed the live view from a recording
python -m unittest discover -s tests -t .               # run the tests
```

## How it works

```
DCS World ─ Tacview exporter ─┬─ .acmi file ────────────▶ parser ─▶ analysis ─▶ Debrief UI
                              └─ real-time TCP :42674 ─▶ parser ─▶ live world ─▶ Live UI
          └ DCS-SA-Export.lua ── UDP :42680 (your jet) ───────────┘
```

* `dcs_sa/acmi/`: streaming ACMI 2.x parser (zip / plain / BOM, escaping, all transform variants, reference offsets).
* `dcs_sa/analysis/`: kinematics (G, turn rate, energy), weapons & kill attribution, takeoff/landing grading, radar locks, timeline.
* `dcs_sa/telemetry/`: Tacview real-time client (handshake + CRC-64 password), DCS bridge receiver, live threat picture.
* `dcs_sa/web/`: the UI (plain JavaScript, no build step). Map tiles are © Esri / OpenStreetMap / CARTO; offline it falls back to a grid.
* `dcs-scripts/DCS-SA-Export.lua`: the in-game bridge.

The app is Python standard library only. Nothing is sent anywhere except map-tile requests.

## Known limits

* ACMI has no runway database, so landings are measured against the point where you actually touched down (3.0° reference, 3.5° on a carrier).
* Stick input comes from control-surface deflection. On fly-by-wire jets (F-16, F/A-18) that's what the flight computer commanded, not raw stick position. A recording that carries Tacview's `PitchControlInput` etc. shows true inputs.
* If a recording doesn't mark weapon parents or lock targets, the app infers them (nearest launcher, closest approach) and labels the source.
