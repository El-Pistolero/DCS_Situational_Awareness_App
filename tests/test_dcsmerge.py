"""Values read from DCS (flight log, events, runways) merged into a debrief."""

import json
import math
import os
import shutil
import tempfile
import unittest
from array import array
from datetime import datetime, timezone

from dcs_sa.acmi import parse_file
from dcs_sa.analysis import geo
from dcs_sa.analysis.dcsmerge import align, apply, find_and_merge
from dcs_sa.analysis.report import analyze, guess_player
from dcs_sa.flightlog import FlightRecorder, compact_self, list_logs, read_log
from dcs_sa.samplegen import FIELD_LAT, FIELD_LON, RWY_HDG, RWY_LEN, write_sample

SAMPLE = os.path.join(os.path.dirname(__file__), "..", "samples", "sample_sortie.acmi")
OFFSET = 37.25  # recording t = log t + OFFSET (the bridge clock starts later)
WALL0 = datetime(2026, 9, 25, 9, 0, 0, tzinfo=timezone.utc).timestamp()


def unit(rec, oid, t, player=None):
    tr = rec.tracks[oid]
    lon, lat, alt = tr.position_interp(t)
    return {"name": tr.name, "type": tr.name, "player": player, "lat": lat, "lon": lon, "alt": alt}


def write_log(path, rec, offset=OFFSET, shift_deg=0.0, events=()):
    me = rec.tracks["101"]
    rows = [{"k": "meta", "reason": "start", "theatre": "Caucasus", "player": "Ethan", "aircraft": "F-16C_50",
             "wall": WALL0 + 1}]
    t = max(0.0, me.first_seen)
    while t <= me.ends_at:
        lon, lat, alt = me.position_interp(t)
        lt = t - offset
        rows.append({"k": "self", "t": lt, "lat": lat + shift_deg, "lon": lon, "alt": alt, "wall": WALL0 + t,
                     "ctl": {"pitch": round(math.sin(t / 7.0), 3), "roll": 0.1, "yaw": 0.0},
                     "scan": {"on": True, "azHalf": 60.0, "elHalf": 4.3, "centerAz": 0.0, "centerEl": -2.0},
                     "cm": {"chaff": 60, "flare": 60}, "gun": 510, "eng": {"ff": 1.25, "rpm": [88.5, 0.0]}})
        if int(t * 4) % 8 == 0:
            u = []
            for oid, radar in (("201", True), ("304", True), ("302", False)):
                if rec.tracks[oid].alive_at(t):
                    p = unit(rec, oid, t)
                    u.append([p["name"], p["lat"] + shift_deg, p["lon"], p["alt"], radar])
            rows.append({"k": "world", "t": lt, "u": u, "wall": WALL0 + t})
        t += 0.25
    for ev in events:
        rows.append({"k": "ev", "wall": WALL0 + ev["t"] + offset, **ev})
    with open(path, "w", encoding="utf-8") as fh:
        for r in rows:
            fh.write(json.dumps(r) + "\n")


class MergeFlightLog(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        if not os.path.exists(SAMPLE):
            write_sample(SAMPLE)
        cls.rec = parse_file(SAMPLE)
        cls.dir = tempfile.mkdtemp()
        rec = cls.rec
        # DCS's own combat events, on the log's clock.
        ev = []
        for tt in (281.55, 281.6, 281.7):  # 3 rounds of burst 2 hit the BTR
            ev.append({"kind": "hit", "t": tt - OFFSET, "initiator": unit(rec, "101", tt, "Ethan"),
                       "target": unit(rec, "301", tt), "weapon": "M61_20_HE", "weaponCategory": 0})
        ev.append({"kind": "kill", "t": 281.75 - OFFSET, "initiator": unit(rec, "101", 281.75, "Ethan"),
                   "target": unit(rec, "301", 281.75), "weapon": "M61_20_HE", "weaponCategory": 0})
        # A current hook's shot: guidance and the missile's own target.
        ev.append({"kind": "shot", "t": 102.0 - OFFSET, "initiator": unit(rec, "101", 102.0, "Ethan"),
                   "weapon": "AIM_120C", "weaponCategory": 1, "guidance": 3, "weaponTarget": unit(rec, "201", 102.0)})
        # An older hook's shot (18-field line): neither.
        ev.append({"kind": "shot", "t": 112.5 - OFFSET, "initiator": unit(rec, "201", 112.5),
                   "target": {"name": "", "type": "", "player": "", "coalition": None, "lat": None, "lon": None, "alt": None},
                   "weapon": "R-27ER", "weaponCategory": 1})
        ev.append({"kind": "kill", "t": 133.7 - OFFSET, "initiator": unit(rec, "101", 133.7, "Ethan"),
                   "target": unit(rec, "201", 133.7), "weapon": "AIM_120C", "weaponCategory": 1})
        cls.events = ev
        # A log from another flight whose track never matches this recording.
        write_log(os.path.join(cls.dir, "flight-20260925-080000.jsonl"), rec, offset=5.0, shift_deg=0.5)
        write_log(os.path.join(cls.dir, "flight-20260925-090001.jsonl"), rec, events=ev)
        cls.player = guess_player(rec, ["Ethan"])
        cls.merged = find_and_merge(rec, cls.dir, cls.player)
        cls.report = analyze(rec, ["Ethan"], dcs=cls.merged)

    @classmethod
    def tearDownClass(cls):
        shutil.rmtree(cls.dir, ignore_errors=True)

    def test_picks_matching_log_and_aligns_clock(self):
        self.assertIsNotNone(self.merged)
        self.assertEqual(self.merged["log"], "flight-20260925-090001.jsonl")
        self.assertAlmostEqual(self.merged["offset"], OFFSET, delta=0.5)
        self.assertLess(self.merged["medianError"], 60.0)
        self.assertEqual(self.merged["theatre"], "Caucasus")

    def test_no_merge_without_a_matching_flight_path(self):
        only_decoy = tempfile.mkdtemp()
        try:
            write_log(os.path.join(only_decoy, "flight-20260925-080000.jsonl"), self.rec, offset=5.0, shift_deg=0.5)
            self.assertIsNone(find_and_merge(parse_file(SAMPLE), only_decoy, self.player))
        finally:
            shutil.rmtree(only_decoy, ignore_errors=True)
        offset, err = align(self.player, [{"t": 1.0, "lat": 0.0, "lon": 0.0}] * 10)
        self.assertIsNone(offset)

    def test_read_values_become_channels(self):
        chans = set(self.merged["channels"])
        for c in ("101:Elevator", "101:ScanAz", "101:ScanEl", "101:RadarActive", "101:GunAmmo", "201:RadarActive",
                  "304:RadarActive", "302:RadarActive", "101:DcsFuelFlow", "101:EngineRPM"):
            self.assertIn(c, chans)
        me = self.rec.tracks["101"]
        i = me.index_at(200.0)
        self.assertAlmostEqual(me.channels["Elevator"][i], math.sin(me.t[i] / 7.0), delta=0.15)
        self.assertEqual(me.channels["ScanAz"][i], 60.0)
        # No FuelFlowWeight in this recording: DCS's fuel flow (its units), engine 1 RPM.
        self.assertEqual(me.channels["DcsFuelFlow"][i], 1.25)
        self.assertEqual(me.channels["EngineRPM"][i], 88.5)
        self.assertNotIn("DcsFuelFlow", self.rec.tracks["102"].channels)
        # Static units keep DCS's on/off changes as their own time series.
        series = self.rec.extras["dcsRadar"]
        self.assertEqual(series["302"][1], [0.0])
        self.assertEqual(series["304"][1], [1.0])
        self.assertNotIn("RadarActive", self.rec.tracks["304"].channels)

    def test_events_mapped_to_objects(self):
        kinds = [(e["kind"], e["initiatorId"], e["targetId"]) for e in self.merged["events"]]
        self.assertIn(("kill", "101", "301"), kinds)
        self.assertIn(("kill", "101", "201"), kinds)
        self.assertEqual(sum(1 for k in kinds if k == ("hit", "101", "301")), 3)

    def test_shot_carries_the_missiles_own_target(self):
        shot = next(e for e in self.merged["events"] if e["kind"] == "shot" and e["weapon"] == "AIM_120C")
        self.assertEqual((shot["guidance"], shot["weaponTargetId"]), (3, "201"))
        aim = next(s for s in self.report["weapons"]["shots"] if s["weaponName"] == "AIM_120C")
        self.assertEqual((aim["targetId"], aim["targetSource"], aim["dcsGuidance"]), ("201", "dcs", 3))

    def test_older_hook_shots_still_merge(self):
        old = next(e for e in self.merged["events"] if e["kind"] == "shot" and e["weapon"] == "R-27ER")
        self.assertEqual((old["initiatorId"], old["guidance"], old["weaponTargetId"]), ("201", None, None))
        hit = next(e for e in self.merged["events"] if e["kind"] == "hit")
        self.assertIsNone(hit["weaponTargetId"])
        r27 = next(s for s in self.report["weapons"]["shots"] if s["weaponName"] == "R-27ER")
        self.assertTrue(r27["dcsConfirmed"])
        self.assertEqual((r27["targetId"], r27["targetSource"], r27["dcsGuidance"]), ("101", "lock", None))

    def test_gun_hits_counted_per_burst(self):
        bursts = self.report["weapons"]["bursts"]
        self.assertEqual([b["dcsHits"] for b in bursts], [0, 3])
        self.assertEqual(bursts[1]["dcsHitTargets"], {"BTR-80": 3})

    def test_kills_confirmed_by_dcs(self):
        kills = {k["victimId"]: k for k in self.report["weapons"]["kills"]}
        self.assertEqual(kills["301"]["confirmedBy"], "DCS")
        self.assertEqual(kills["201"]["confirmedBy"], "DCS")
        self.assertEqual(kills["201"]["killerId"], "101")
        shot = next(s for s in self.report["weapons"]["shots"] if s["launcherId"] == "101")
        self.assertTrue(shot["dcsConfirmed"])

    def test_report_summary_and_timeline(self):
        dcs = self.report["dcs"]
        self.assertEqual(dcs["hits"], 3)
        self.assertEqual(dcs["kills"], 2)
        texts = [i["text"] for i in self.report["timeline"]]
        self.assertTrue(any(t.startswith("DCS: Ethan hit BTR-80 x3") for t in texts), texts)
        self.assertTrue(any("(DCS confirmed)" in t for t in texts), texts)

    def test_kill_credit_corrected(self):
        rec = parse_file(SAMPLE)
        ev = [{"kind": "kill", "t": 133.7 - OFFSET, "initiator": unit(rec, "102", 133.7, "Viper 1-2"),
               "target": unit(rec, "201", 133.7), "weapon": "AIM_120C", "weaponCategory": 1}]
        d = tempfile.mkdtemp()
        try:
            write_log(os.path.join(d, "flight-20260925-090001.jsonl"), rec, events=ev)
            rep = analyze(rec, ["Ethan"], dcs=find_and_merge(rec, d, guess_player(rec, ["Ethan"])))
        finally:
            shutil.rmtree(d, ignore_errors=True)
        k = next(k for k in rep["weapons"]["kills"] if k["victimId"] == "201")
        self.assertEqual(k["killerId"], "102")
        self.assertIn("DCS credits", k["note"])
        self.assertEqual(rep["dcs"]["killsCorrected"], 1)


class ReviewRegressions(unittest.TestCase):
    """Cases from the code review of the DCS merge."""

    @classmethod
    def setUpClass(cls):
        if not os.path.exists(SAMPLE):
            write_sample(SAMPLE)

    def test_every_hit_run_gets_text(self):
        from dcs_sa.analysis.report import _add_dcs_timeline
        rec = parse_file(SAMPLE)
        ev = [{"kind": "hit", "time": t, "initiatorId": "101", "targetId": "301", "weapon": "M61_20_HE"}
              for t in (100.0, 100.1, 110.0, 110.2)]
        items = _add_dcs_timeline([], rec, {"events": ev})
        self.assertEqual([i["text"] for i in items], ["DCS: Ethan hit BTR-80 x2 (M61_20_HE)"] * 2)

    def test_parked_rows_do_not_fool_the_clock(self):
        # Long parked stretches match any offset; only moving rows count.
        rec = parse_file(SAMPLE)
        me = rec.tracks["101"]
        rows = []
        for i in range(0, 200):  # parked at the start position for 200 s
            p = me.position_interp(me.first_seen)
            rows.append({"t": -500.0 + i, "lat": p[1], "lon": p[0], "tas": 0.0})
        t = me.first_seen
        while t <= me.ends_at:
            lon, lat, _ = me.position_interp(t)
            rows.append({"t": t - 20.0, "lat": lat, "lon": lon, "tas": 150.0 if 40 < t < 560 else 0.0})
            t += 0.25
        offset, err = align(me, rows)
        self.assertAlmostEqual(offset, 20.0, delta=0.1)

    def test_parked_only_log_is_rejected(self):
        rec = parse_file(SAMPLE)
        me = rec.tracks["101"]
        p = me.position_interp(me.first_seen)
        rows = [{"t": float(i), "lat": p[1], "lon": p[0], "tas": 0.0} for i in range(600)]
        self.assertIsNone(align(me, rows)[0])

    def test_one_hit_one_shot_and_credits_follow_dcs(self):
        from dcs_sa.analysis.weapons import analyze_weapons, apply_dcs_events
        rec = parse_file(SAMPLE)
        rep = analyze_weapons(rec)
        # DCS credits Viper 1-2 with the MiG: Ethan's AIM-120 loses the kill,
        # and the shooter table follows.
        apply_dcs_events(rep, rec, [{"kind": "kill", "time": 133.7, "initiatorId": "102", "targetId": "201",
                                     "weapon": "AIM_120C", "weaponCategory": 1}])
        self.assertEqual(rep.by_shooter["102"]["kills"], 1)
        self.assertEqual(rep.by_shooter["101"]["kills"], 1)  # only the gun kill remains
        aim = next(s for s in rep.shots if s.weapon_name == "AIM_120C")
        self.assertEqual(aim.outcome, "miss")
        self.assertIn("DCS credits", aim.outcome_detail)

    def test_trigger_burst_counts_hits_over_its_whole_length(self):
        from dcs_sa.analysis.weapons import GunBurst, WeaponReport, apply_dcs_events
        rec = parse_file(SAMPLE)
        b = GunBurst("101", "F-16C_50", "Ethan", 100.0, 103.0, 0, source="trigger")
        rep = WeaponReport(shots=[], bursts=[b], kills=[], destructions=[], by_shooter={}, rounds={})
        ev = [{"kind": "hit", "time": t, "initiatorId": "101", "targetId": "301", "weapon": "M61_20_HE", "weaponCategory": 0}
              for t in (100.8, 101.5, 102.2, 103.0)]
        apply_dcs_events(rep, rec, ev)
        self.assertEqual(b.dcs_hits, 4)

    def test_weapon_target_from_dcs_replaces_the_guess(self):
        from dcs_sa.analysis.weapons import analyze_weapons, apply_dcs_events
        rec = parse_file(SAMPLE)
        rep = analyze_weapons(rec)
        r27 = next(s for s in rep.shots if s.weapon_name == "R-27ER")
        self.assertEqual((r27.target_id, r27.target_source), ("101", "lock"))
        # Two DCS shot events near the launch: the nearer one is this missile's.
        apply_dcs_events(rep, rec, [
            {"kind": "shot", "time": 113.9, "initiatorId": "201", "weapon": "R-27ER", "weaponCategory": 1,
             "guidance": 4, "weaponTargetId": "101"},
            {"kind": "shot", "time": 112.6, "initiatorId": "201", "weapon": "R-27ER", "weaponCategory": 1,
             "guidance": 4, "weaponTargetId": "102"}])
        self.assertTrue(r27.dcs_confirmed)
        self.assertEqual((r27.target_id, r27.target_name, r27.target_pilot), ("102", "F-16C_50", "Viper 1-2"))
        self.assertEqual((r27.target_source, r27.dcs_guidance), ("dcs", 4))
        # Launch geometry and miss distance are measured against DCS's target.
        lp, tp = rec.tracks["201"].position_at(r27.launch_time), rec.tracks["102"].position_at(r27.launch_time)
        self.assertAlmostEqual(r27.geometry["range"], geo.slant_range(*lp, *tp), delta=1.0)
        self.assertIsNotNone(r27.closest_approach)
        self.assertEqual(r27.to_dict()["targetSource"], "dcs")

    def test_outside_log_coverage_is_unknown(self):
        from dcs_sa.analysis.weapons import analyze_weapons, apply_dcs_events
        rec = parse_file(SAMPLE)
        rep = analyze_weapons(rec)
        apply_dcs_events(rep, rec, [], coverage=[(0.0, 200.0)])  # log ends before the strafe
        self.assertEqual([b.dcs_hits for b in rep.bursts], [None, None])
        self.assertIsNotNone(next(s for s in rep.shots if s.launch_time < 200).dcs_confirmed)


class RunwayFromDcs(unittest.TestCase):
    def test_landing_graded_against_dcs_runway(self):
        if not os.path.exists(SAMPLE):
            write_sample(SAMPLE)
        rec = parse_file(SAMPLE)
        clon, clat = geo.destination(FIELD_LON, FIELD_LAT, RWY_HDG, RWY_LEN / 2)
        airbases = [{"name": "Batumi", "category": 0, "alt": 10.0,
                     "runways": [{"name": "31", "heading": (RWY_HDG + 180) % 360, "length": RWY_LEN, "width": 45,
                                  "lon": clon, "lat": clat}]}]
        rep = analyze(rec, ["Ethan"], airbases=airbases)
        ld = next(l for l in rep["landings"] if l["pilot"] == "Ethan")
        self.assertEqual(ld["runway"]["airbase"], "Batumi")
        self.assertEqual(ld["runway"]["name"], "13")
        self.assertEqual(ld["runway"]["source"], "DCS")
        self.assertGreater(ld["touchdownFromThreshold"], 150)
        self.assertLess(ld["touchdownFromThreshold"], 914)
        # Remaining = runway left ahead when the rollout ended.
        self.assertGreater(ld["runwayRemaining"], 0)
        self.assertLess(ld["touchdownFromThreshold"] + ld["runwayRemaining"], RWY_LEN)
        self.assertTrue(rep["runways"])

    def test_no_runway_when_far_away(self):
        rec = parse_file(SAMPLE)
        rep = analyze(rec, ["Ethan"], airbases=[{"name": "Elsewhere", "category": 0, "runways": [
            {"name": "09", "heading": 90, "length": 2500, "width": 45, "lon": 44.0, "lat": 43.0}]}])
        ld = next(l for l in rep["landings"] if l["pilot"] == "Ethan")
        self.assertIsNone(ld.get("runway"))


class EngineFromDcs(unittest.TestCase):
    def test_bridge_engine_block_is_kept(self):
        base = {"t": 1.0, "self": {"lat": 35.0, "lon": 36.0}}
        row = compact_self({**base, "engine": {"fuel_internal": 3000, "rpm": {"left": 88.456, "right": 0},
                                               "temp": {"left": 700}, "flow": {"left": 0.61234, "right": 0.5}}})
        self.assertEqual(row["eng"], {"ff": 1.1123, "rpm": [88.46, 0.0]})
        # Only the numbers present; nothing when DCS gave none.
        self.assertEqual(compact_self({**base, "engine": {"flow": {"right": 2.0}, "rpm": {}}})["eng"], {"ff": 2.0})
        self.assertNotIn("eng", compact_self({**base, "engine": {"flow": {}, "rpm": {}}}))
        self.assertNotIn("eng", compact_self(base))

    def test_no_dcs_fuel_flow_over_a_recorded_one(self):
        rec = parse_file(SAMPLE)
        me = rec.tracks["101"]
        me.channels["FuelFlowWeight"] = array("d", [3100.0] * len(me.t))
        selfs = [{"t": t, "eng": {"ff": 1.5, "rpm": [None, 91.0]}} for t in me.t]
        out = apply(rec, {"path": "flight-x.jsonl", "meta": {}, "self": selfs, "world": [], "events": []}, 0.0, 0.0, me)
        self.assertNotIn("101:DcsFuelFlow", out["channels"])
        self.assertNotIn("DcsFuelFlow", me.channels)
        self.assertIn("101:EngineRPM", out["channels"])
        self.assertEqual(me.channels["EngineRPM"][10], 91.0)  # the right engine when the left is missing
        me.channels["EngineRPM"] = array("d", [50.0] * len(me.t))
        apply(rec, {"path": "flight-x.jsonl", "meta": {}, "self": selfs, "world": [], "events": []}, 0.0, 0.0, me)
        self.assertEqual(me.channels["EngineRPM"][10], 50.0)  # a recorded RPM is never replaced


class ThreatDatabase(unittest.TestCase):
    def test_lookup_by_dcs_type_name(self):
        from dcs_sa import threatdb
        self.assertEqual(threatdb.lookup("SA-11 Buk SR 9S18M1")["range"], 50000.0)
        self.assertEqual(threatdb.lookup("SNR_75V")["range"], 33000.0)  # DCS name differs
        self.assertEqual(threatdb.lookup("ZSU-23-4 Shilka")["vrange"], 2500)
        self.assertIsNone(threatdb.lookup("BTR-80"))
        self.assertIsNone(threatdb.lookup(None))

    def test_playback_labels_ring_source(self):
        from dcs_sa.server.store import RecordingStore
        rec = parse_file(SAMPLE)
        pb = RecordingStore.playback(rec)
        sam = pb["objects"]["304"]
        self.assertEqual(sam["eng"], 50000.0)
        self.assertEqual(sam["engSrc"], "Tacview database")
        self.assertNotIn("eng", pb["objects"]["301"])


class Recorder(unittest.TestCase):
    def test_bridge_and_events_round_trip(self):
        d = tempfile.mkdtemp()
        try:
            r = FlightRecorder(d)
            r.on_hook_hello({"theatre": "Syria"})
            r.on_bridge({"t": 10.0, "self": {"lat": 35.0, "lon": 36.0, "alt": 1000, "pilot": "Ethan", "name": "F-16C_50",
                                             "g": {"y": 1.2}},
                         "controls": {"pitch": 0.25, "roll": -0.1}, "scan": {"on": True, "azHalf": 30.0},
                         "engine": {"rpm": {"left": 90.0, "right": 0.0}, "flow": {"left": 1.5, "right": 0.0}},
                         "world": [{"name": "MiG-29S", "lat": 35.1, "lon": 36.1, "alt": 5000, "radar": True}]})
            r.on_events([{"kind": "hit", "t": 10.5, "weapon": "M61_20_HE"}])
            r.close()
            logs = list_logs(d)
            self.assertEqual(len(logs), 1)
            log = read_log(logs[0])
            self.assertEqual(log["meta"]["theatre"], "Syria")
            self.assertEqual(log["meta"]["player"], "Ethan")
            self.assertEqual(log["self"][0]["ctl"]["pitch"], 0.25)
            self.assertEqual(log["self"][0]["g"], 1.2)
            self.assertEqual(log["self"][0]["eng"], {"ff": 1.5, "rpm": [90.0, 0.0]})
            self.assertEqual(log["world"][0]["u"][0][4], True)
            self.assertEqual(log["events"][0]["kind"], "hit")
        finally:
            shutil.rmtree(d, ignore_errors=True)


if __name__ == "__main__":
    unittest.main()
