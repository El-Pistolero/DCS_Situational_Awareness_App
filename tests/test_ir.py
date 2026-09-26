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

    def test_flares_look_like_dcs_writes_them(self):
        flares = [tr for tr in self.rec.tracks.values() if "Flare" in (tr.props.get("Type") or "")]
        self.assertGreaterEqual(len(flares), 12)
        for tr in flares:
            self.assertEqual(tr.props.get("Type"), "Misc+Decoy+Flare")
            self.assertEqual(tr.props.get("Coalition"), "Neutral")
            self.assertNotIn("Parent", tr.props)
            self.assertFalse(tr.props.get("Name"))

    def test_engine_data_only_for_the_player(self):
        me, mig = self.rec.tracks["101"], self.rec.tracks["201"]
        self.assertEqual({round(v, 2) for v in me.channel("Throttle")}, {0.9, 1.02})
        self.assertIsNone(mig.channel("Throttle"))

    def test_flare_owners_and_salvos(self):
        ir = self.report["ir"]
        owners = {f["owner"] for f in ir["flares"].values()}
        self.assertEqual(owners, {"101", "201"})
        self.assertEqual([(s["n"], s["kind"]) for s in ir["salvos"]["201"]], [(6, "flare")])
        self.assertEqual([(s["n"], s["kind"]) for s in ir["salvos"]["101"]], [(8, "flare")])
        # The object rows carry the owner for the map.
        rows = {o["id"]: o for o in self.report["objects"]}
        self.assertTrue(all(rows[fid]["owner"] == f["owner"] for fid, f in ir["flares"].items()))

    def test_heat_player_recorded_ai_unknown(self):
        heat = self.report["ir"]["heat"]
        me, mig = heat["101"], heat["201"]
        self.assertEqual((me["ir"], me["irAB"], me["state"], me["src"]), (0.6, 3, "recorded", "FuelFlowWeight"))
        [(a, b)] = me["spans"]
        self.assertAlmostEqual(a, 108.4, delta=0.5)  # the break into the R-73
        self.assertEqual((mig["ir"], mig["irAB"], mig["state"]), (0.77, 4, "unknown"))

    def test_decoys_on_the_misses_only(self):
        shots = self.report["weapons"]["shots"]
        d1, d2 = shots[0]["ir"].get("decoy"), shots[1]["ir"].get("decoy")
        self.assertEqual(d1["owner"], "201")
        self.assertEqual(d2["owner"], "101")
        self.assertLess(d1["zemFlare"], IR.DECOY_ZEM)
        self.assertLess(d1["zemFlare"], IR.DECOY_RATIO * d1["zemTarget"])
        self.assertNotIn("decoy", shots[2]["ir"])
        kinds = [i["kind"] for i in self.report["timeline"]]
        self.assertEqual(kinds.count("decoy"), 2)
        self.assertEqual(kinds.count("flares"), 2)

    def test_shot_heat_and_seeker(self):
        shots = self.report["weapons"]["shots"]
        sk = shots[0]["ir"]["seeker"]
        self.assertEqual((sk["key"], sk["display"], sk["ssd"], sk["ccm"], sk["allAspect"]), ("AIM_9", "AIM-9M", 20000, 0.5, True))
        h = shots[2]["ir"]["heat"]  # the kill: from the MiG's rear quarter, its afterburner not recorded
        self.assertLess(h["tailAngle"], 30)
        self.assertIsNone(h["ab"])
        self.assertAlmostEqual(h["seen"], 0.77 * IR.aspect_factor(h["tailAngle"]), places=2)
        self.assertAlmostEqual(h["seenAB"], 4 * IR.aspect_factor(h["tailAngle"]), places=2)
        h = shots[1]["ir"]["heat"]  # the R-73 at the player: dry at launch, known from fuel flow
        self.assertIs(h["ab"], False)
        self.assertNotIn("seenAB", h)

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
