"""Heat-seekers and flares: the synthetic dogfight demo."""

import math
import os
import unittest

from dcs_sa.acmi import parse_file
from dcs_sa.analysis import ir as IR
from dcs_sa.analysis.report import analyze
from dcs_sa.sampledogfight import write_dogfight_sample

SAMPLE = os.path.join(os.path.dirname(__file__), "..", "samples", "sample_dogfight.acmi")


def load():
    if not os.path.exists(SAMPLE):
        write_dogfight_sample(SAMPLE)
    return parse_file(SAMPLE)


class DogfightSample(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.rec = load()
        cls.report = analyze(cls.rec, ["Ethan"])

    def test_shots_and_outcomes(self):
        shots = [(s["weaponName"], s["launcherPilot"], s["outcome"]) for s in self.report["weapons"]["shots"]]
        self.assertEqual(shots, [("AIM_9", "Ethan", "miss"), ("P_73", "Ivanov", "miss"), ("AIM_9", "Ethan", "kill")])
        [kill] = self.report["weapons"]["kills"]
        self.assertEqual((kill["victimName"], kill["killerPilot"]), ("MiG-29S", "Ethan"))

    def test_countermeasures_look_like_dcs_writes_them(self):
        cms = [tr for tr in self.rec.tracks.values() if "Decoy" in (tr.props.get("Type") or "")]
        kinds = sorted(tr.props["Type"] for tr in cms)
        self.assertEqual((kinds.count("Misc+Decoy+Flare"), kinds.count("Misc+Decoy+Chaff")), (16, 4))
        for tr in cms:
            self.assertEqual(tr.props.get("Coalition"), "Neutral")
            self.assertNotIn("Parent", tr.props)
            self.assertFalse(tr.props.get("Name"))
            life = tr.ends_at - tr.first_seen
            self.assertAlmostEqual(life, 12.0 if "Chaff" in tr.props["Type"] else 9.0, delta=0.6)

    def test_engine_data_only_for_the_player(self):
        me, mig = self.rec.tracks["101"], self.rec.tracks["201"]
        self.assertEqual({round(v, 2) for v in me.channel("Throttle")}, {0.9, 1.02})
        self.assertIsNone(mig.channel("Throttle"))

    def test_flare_owners_and_salvos(self):
        ir = self.report["ir"]
        self.assertEqual([(s["n"], s["kind"]) for s in ir["salvos"]["201"]], [(6, "flare"), (2, "flare")])
        self.assertEqual(sorted((s["n"], s["kind"]) for s in ir["salvos"]["101"]), [(4, "chaff"), (8, "flare")])
        # The object rows carry the owner (DCS writes none), inferred from the nearest jet.
        cms = [o for o in self.report["objects"] if o.get("cmKind")]
        self.assertEqual(len(cms), 20)
        self.assertEqual({o["cmOwner"] for o in cms}, {"101", "201"})
        self.assertFalse(any(o.get("cmAmbiguous") for o in cms))
        self.assertTrue(all(5.0 <= o["cmDist"] <= 20.0 for o in cms))
        self.assertEqual(sorted({o["cmSalvo"] for o in cms}), [2, 4, 6, 8])

    def test_heat_player_recorded_ai_unknown(self):
        heat = self.report["ir"]["heat"]
        me, mig = heat["101"], heat["201"]
        self.assertEqual((me["ir"], me["irAB"], me["state"], me["src"]), (0.6, 3, "recorded", "FuelFlowWeight"))
        s2, s3 = (s["launchTime"] for s in self.report["weapons"]["shots"][1:])
        # Hot as the R-73 comes off the rail, out of it while flaring; then chasing the MiG.
        (a1, b1), (a2, b2) = me["spans"]
        for got, want in ((a1, s2 - 8.0), (b1, s2 + 1.0), (a2, s2 + 17.0), (b2, s3 + 0.5)):
            self.assertAlmostEqual(got, want, delta=1.0)
        self.assertEqual((mig["ir"], mig["irAB"], mig["state"], mig["spans"]), (0.77, 4, "unknown", []))

    def test_decoys_on_the_misses_only(self):
        shots = self.report["weapons"]["shots"]
        d1, d2 = shots[0]["ir"].get("decoy"), shots[1]["ir"].get("decoy")
        self.assertEqual(d1["owner"], "201")
        self.assertEqual(d2["owner"], "101")
        self.assertLess(d1["zemFlare"], IR.DECOY_ZEM)
        self.assertLess(d1["zemFlare"], IR.DECOY_RATIO * d1["zemTarget"])
        self.assertNotIn("decoy", shots[2]["ir"])
        self.assertEqual(shots[0]["outcomeDetail"], "likely went for a flare (est.)")
        # The flare it went for is the one it then flew past.
        self.assertEqual(d1["flareId"], shots[0]["ir"]["nearestFlare"]["id"])
        self.assertLess(shots[0]["ir"]["nearestFlare"]["dist"], 30)
        self.assertEqual(self.report["ir"]["decoys"], 2)
        items = self.report["timeline"]
        self.assertEqual([i["text"] for i in items if i["kind"] == "flares"],
                         ["Ivanov flares x6", "Ethan flares x8", "Ivanov flares x2"])
        self.assertEqual([i["text"] for i in items if i["kind"] == "decoy"],
                         ["AIM-9M from Ethan likely went for Ivanov's flare (est.)",
                          "R-73 from Ivanov likely went for Ethan's flare (est.)"])

    def test_shot_heat_and_seeker(self):
        shots = self.report["weapons"]["shots"]
        sk = shots[0]["ir"]["seeker"]
        self.assertEqual((sk["key"], sk["display"], sk["ssd"], sk["ccm"], sk["allAspect"]), ("AIM_9", "AIM-9M", 20000, 0.5, True))
        h = shots[2]["ir"]["heat"]  # the kill: from the MiG's rear quarter, its afterburner not recorded
        self.assertLess(h["tailAngle"], 30)
        self.assertIsNone(h["ab"])
        self.assertAlmostEqual(h["seen"], 0.77 * IR.aspect_factor(h["tailAngle"]), places=2)
        self.assertAlmostEqual(h["seenAB"], 4 * IR.aspect_factor(h["tailAngle"]), places=2)
        h = shots[1]["ir"]["heat"]  # the R-73 at the player: in afterburner at launch, known from fuel flow
        self.assertIs(h["ab"], True)
        self.assertEqual(h["abSrc"], "FuelFlowWeight")
        self.assertAlmostEqual(h["seen"], 3 * IR.aspect_factor(h["tailAngle"]), places=2)
        self.assertNotIn("seenAB", h)
        self.assertEqual(shots[1]["ir"]["flares"]["chaff"], 4)
        for s in shots:  # the 3D tail angle agrees with the 2D aspect
            self.assertLess(abs(s["ir"]["heat"]["tailAngle"] - s["geometry"]["aspect"]), 5.0)
            self.assertFalse(s["ir"]["launch"]["outsideLookAngle"])

    def test_regenerates_identically(self):
        import tempfile
        with tempfile.TemporaryDirectory() as d:
            path = write_dogfight_sample(os.path.join(d, "x.acmi"))
            with open(path, encoding="utf-8") as a, open(SAMPLE, encoding="utf-8") as b:
                self.assertEqual(a.read(), b.read())


if __name__ == "__main__":
    unittest.main()


class Tables(unittest.TestCase):
    def test_seeker_lookup_by_dcs_name_alias_and_prefix(self):
        for name, key in (("AIM_9", "AIM_9"), ("AIM-9M", "AIM_9"), ("weapons.missiles.AIM_9", "AIM_9"), ("R-73", "P_73"),
                          ("P_73", "P_73"), ("AIM-9L", "AIM-9L"), ("AIM_9X", "AIM_9X"), ("R-60M", "P_60")):
            self.assertEqual(IR.seeker(name)["key"], key, name)

    def test_only_ir_missiles_are_ir(self):
        # Never by name: a radar or command-guided missile is not in DCS's IR table.
        for name in ("AIM_120C", "P_27PE", "R-3R", "9M33", "SA9M330", "AIM_7", "GBU_12", "", None):
            self.assertIsNone(IR.seeker(name), name)
        # ... and DCS says what it is instead (Head_Type: 2 active radar, 6 semi-active).
        self.assertEqual([IR.guidance(n) for n in ("AIM_120C", "R-27ER", "SA9M38M1", "9M33", "R-3R", "SA_IRIS_T_SL")],
                         [2, 6, 6, 6, 6, 6])
        self.assertIsNone(IR.guidance("AIM_9"))  # IR: seeker(), not guidance()

    def test_table_values(self):
        t = IR.table()
        self.assertEqual((len(t["planes"]), len(t["missiles"])), (170, 42))
        self.assertTrue(t["planeSrc"]["F-16C_50"].endswith("F-16C_50.lua:1056"))
        sk = IR.seeker("AIM_9")
        self.assertEqual((sk["offBoresight"], sk["gimbal"], sk["trackRate"], sk["fuze"], sk["power"], sk["short"]),
                         (17.2, 45.3, 35.0, 8, 60, "AIM-9M"))
        r73 = IR.seeker("R-73")
        self.assertEqual((r73["key"], r73["short"], r73["gimbal"], r73["power"]), ("P_73", "R-73", 75.1, 23))
        self.assertEqual((IR.seeker("RIM_116A")["ssd"], IR.seeker("RIM_116A")["ccm"]), (10500, 0.5))
        self.assertEqual((IR.seeker("FIM_92C")["ssd"], IR.seeker("FIM_92C")["gimbal"]), (9500, 30.0))
        self.assertEqual(IR.seeker("9M31")["key"], "SA9M31")
        self.assertIsNone(IR.seeker("SA9M31")["trackRate"])  # DCS's 99.9 "unused" marker
        self.assertNotIn(5723.8, [m.get("trackRate") for m in t["missiles"].values()])

    def test_rear_aspect_seekers(self):
        self.assertFalse(IR.seeker("GAR-8")["allAspect"])
        self.assertTrue(IR.seeker("P_73")["allAspect"])

    def test_airframes(self):
        self.assertEqual(IR.airframe("F-16C_50"), {"type": "F-16C_50", "ir": 0.6, "irAB": 3})
        self.assertEqual(IR.airframe("FA-18C_hornet")["ir"], 0.75)
        self.assertEqual(IR.airframe("F/A-18C")["ir"], 0.73)  # DCS's older AI Hornet is its own type
        self.assertIsNone(IR.airframe("A-10C")["irAB"])  # no afterburner
        self.assertIsNone(IR.airframe("Not A Plane"))

    def test_aspect_factor(self):
        self.assertAlmostEqual(IR.aspect_factor(0), 1.5)
        self.assertAlmostEqual(IR.aspect_factor(90), 1.0)
        self.assertAlmostEqual(IR.aspect_factor(180), 0.5)

    def test_zem(self):
        # Target 1 km ahead crossing at 100 m/s, missile closing at 500 m/s: passes 200 m off.
        zem, tgo = IR._zem((0.0, 1000.0, 0.0), (100.0, -500.0, 0.0))
        self.assertAlmostEqual(tgo, 1000 * 500 / (100 ** 2 + 500 ** 2), places=6)
        self.assertAlmostEqual(zem, 1000 * 100 / math.hypot(100, 500), places=6)


class LiveHeat(unittest.TestCase):
    """The dogfight streamed into the live view, as the Tacview real-time feed would."""

    @classmethod
    def setUpClass(cls):
        from dcs_sa.acmi.parser import AcmiParser
        from dcs_sa.acmi.reader import iter_lines
        from dcs_sa.telemetry.live_world import LiveWorld
        load()
        cls.snaps = {}
        w = LiveWorld(["Ethan"])
        p = AcmiParser(w)
        want = [100.0, 110.2, 116.0, 131.0, 141.0]
        for line in iter_lines(SAMPLE):
            if line.startswith("#") and want and float(line[1:]) >= want[0]:
                cls.snaps[want.pop(0)] = w.snapshot()
            if line.startswith("#"):
                w.snapshot()  # the heat tracker samples on snapshots, as the server's clients do
            p.feed(line)

    def test_r73_is_an_ir_threat(self):
        [m] = [t for t in self.snaps[110.2]["threats"] if t["kind"] == "missile"]
        self.assertTrue(m["ir"])
        self.assertEqual((m["seeker"], m["text"]), ("R-73", "IR MISSILE"))
        self.assertIn(m["sees"], ("tail", "beam", "nose"))
        self.assertAlmostEqual(m["heatFactor"], IR.aspect_factor({"tail": 0, "beam": 90, "nose": 180}[m["sees"]]), delta=0.5)

    def test_own_heat(self):
        before, after, chase = (self.snaps[k]["heat"] for k in (100.0, 116.0, 131.0))
        self.assertEqual((before["type"], before["ir"], before["irAB"]), ("F-16C_50", 0.6, 3))
        self.assertIsNone(before["ab"])  # dry so far, but never seen lit: not yet known
        self.assertEqual((after["ab"], after["src"]), (False, "fuel flow"))  # out of it after the R-73
        self.assertIs(chase["ab"], True)

    def test_fuel_flow_tracker(self):
        tr = IR.FuelFlowAB()
        for i in range(40):
            tr.add(float(i), 3000.0, True)
        self.assertIsNone(tr.lit(3000.0))  # only one mode seen
        for i in range(40, 45):
            tr.add(float(i), 25000.0, True)
        self.assertIs(tr.lit(25000.0), True)
        self.assertIs(tr.lit(3100.0), False)
        self.assertIsNone(tr.lit(10000.0))  # between the two
        tr.add(44.5, 1.0, True)  # within a second: ignored
        tr.add(50.0, 1e6, False)  # on the ground: ignored
        self.assertEqual(len(tr.samples), 45)


class AfterburnerRules(unittest.TestCase):
    """Afterburner is read from recorded data only, never guessed."""

    @staticmethod
    def track(name, t, **channels):
        from dcs_sa.acmi.model import Track
        tr = Track("1", 0.0)
        tr.props["Name"] = name
        for i, ti in enumerate(t):
            tr.append(ti, {k: v[i] for k, v in channels.items()}, {"Name": name} if i == 0 else {})
        tr.finalize()
        return tr

    def test_type_without_afterburner_is_exact(self):
        tr = self.track("Su-25T", [0.0, 1.0, 2.0], Afterburner=[1.0, 1.0, 1.0])
        self.assertEqual(IR.ab_state(tr)["state"], "noAB")

    def test_fuel_flow_two_modes(self):
        t = [i * 0.5 for i in range(200)]
        ff = [24000.0 if 40 <= i < 80 else 3000.0 for i in range(200)]
        st = IR.ab_state(self.track("F-16C_50", t, FuelFlowWeight=ff, IAS=[200.0] * 200))
        self.assertEqual((st["state"], st["src"]), ("recorded", "FuelFlowWeight"))
        self.assertEqual(st["spans"], [[20.0, 40.0]])
        self.assertIs(IR.ab_at(st, 30.0), True)
        self.assertIs(IR.ab_at(st, 50.0), False)

    def test_mostly_afterburner_is_unknown(self):
        t = [i * 0.5 for i in range(200)]
        ff = [24000.0 if i >= 20 else 3000.0 for i in range(200)]  # 90% lit: no dry anchor
        self.assertEqual(IR.ab_state(self.track("F-16C_50", t, FuelFlowWeight=ff, IAS=[200.0] * 200))["state"], "unknown")

    def test_one_mode_is_unknown(self):
        t = [i * 0.5 for i in range(200)]
        ff = [3000.0 + 5000.0 * (i % 10) / 10 for i in range(200)]  # never above 3 x P25
        self.assertEqual(IR.ab_state(self.track("F-16C_50", t, FuelFlowWeight=ff, IAS=[200.0] * 200))["state"], "unknown")

    def test_throttle_is_never_used(self):
        t = [i * 0.5 for i in range(100)]
        st = IR.ab_state(self.track("FA-18C_hornet", t, Throttle=[1.0] * 100, IAS=[200.0] * 100))
        self.assertEqual(st["state"], "unknown")

    def test_band_turns_unknown_after_two_seconds(self):
        t = [i * 0.5 for i in range(200)]
        ff = [24000.0 if 40 <= i < 60 else 9000.0 if 60 <= i < 80 else 3000.0 for i in range(200)]
        st = IR.ab_state(self.track("F-16C_50", t, FuelFlowWeight=ff, IAS=[200.0] * 200))
        self.assertIs(IR.ab_at(st, 31.0), True)    # in the band, held
        self.assertIsNone(IR.ab_at(st, 35.0))      # then not known
        self.assertIs(IR.ab_at(st, 45.0), False)


class DecoySuppression(unittest.TestCase):
    def test_a_kill_is_never_a_decoy(self):
        rec = load()
        from dcs_sa.analysis.weapons import analyze_weapons, _weapon_samples
        rep = analyze_weapons(rec)
        shot = rep.shots[0]
        owners = IR.flare_owners(rec)
        samples = _weapon_samples(rec.tracks[shot.weapon_id])
        self.assertIn("decoy", IR.analyze_ir_shot(rec, shot, owners, {}, samples))
        shot.outcome, shot.outcome_detail = "kill", ""  # as DCS's own kill event would make it
        out = IR.analyze_ir_shot(rec, shot, owners, {}, samples)
        self.assertNotIn("decoy", out)
        self.assertIn("nearestFlare", out)
