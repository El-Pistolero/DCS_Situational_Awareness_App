"""Air-to-ground: JSOW (with BLU-97 submunitions), GBU-12 and Mk-82 strikes."""

import os
import unittest

from dcs_sa.acmi import parse_file
from dcs_sa.acmi import types as T
from dcs_sa.analysis.lar import jsow_envelope
from dcs_sa.analysis.report import analyze
from dcs_sa.analysis.strike import analyze_strikes, family
from dcs_sa.analysis.weapons import analyze_weapons
from dcs_sa.samplestrike import write_strike_sample

SAMPLE = os.path.join(os.path.dirname(__file__), "..", "samples", "sample_strike.acmi")


def load():
    if not os.path.exists(SAMPLE):
        write_strike_sample(SAMPLE)
    return parse_file(SAMPLE)


class StrikeSample(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.rec = load()
        cls.report = analyze(cls.rec, ["Ethan"])
        cls.strikes = {(s["weaponName"], round(s["releaseTime"])): s for s in cls.report["strikes"]}

    def by_name(self, name):
        return [s for s in self.report["strikes"] if s["weaponName"] == name]

    def test_every_air_to_ground_weapon_is_a_strike(self):
        names = sorted(s["weaponName"] for s in self.report["strikes"])
        self.assertEqual(names, ["AGM_154", "AGM_154A", "AGM_154A", "GBU_12", "Mk_82"])
        # The SA-11 missile shot at the F-16 is not a strike.
        self.assertNotIn("SA9M38M1", names)

    def test_bomblets_belong_to_their_jsow(self):
        shots = self.report["weapons"]["shots"]
        self.assertFalse(any(s["weaponName"] == "BLU-97/B" for s in shots))
        for s in self.by_name("AGM_154A"):
            # DCS records one object for the whole load; the count is DCS's own.
            self.assertEqual((s["submunitions"], s["submunitionsRecorded"]), (145, 1))
            fp = s["footprint"]
            self.assertTrue(fp["estimated"])
            self.assertEqual((fp["major"], fp["minor"]), (100.0, 60.0))
            self.assertLess(abs(fp["bearing"] - s["release"]["heading"] % 180.0), 10.0)
            # Opened short of and above the target, as DCS does.
            self.assertGreater(s["dispense"]["altitude"] - s["impact"]["altitude"], 300)
        subs = [o for o in self.report["objects"] if o["name"] == "BLU-97/B"]
        self.assertEqual(len(subs), 2)
        self.assertTrue(all(o.get("dispenser") for o in subs))

    def test_kills_while_the_cloud_falls(self):
        # Units die before the cloud's centre lands, some well away from where
        # it lands: they are credited from where the cloud was at that moment.
        col = next(s for s in self.by_name("AGM_154A") if s["releaseTime"] < 90)
        self.assertTrue(all(d["time"] < col["impactTime"] for d in col["damage"]))
        self.assertTrue(any(d["distance"] > 150.0 for d in col["damage"]))

    def test_cluster_damage_and_kill_credit(self):
        col = next(s for s in self.by_name("AGM_154A") if s["releaseTime"] < 90)
        self.assertEqual(col["result"], "destroyed")
        self.assertGreaterEqual(len(col["damage"]), 2)
        kills = [k for k in self.report["weapons"]["kills"] if k["weaponName"] == "AGM_154A (submunitions)"]
        self.assertGreaterEqual(len(kills), 4)  # column vehicles and both SA-11 launchers
        self.assertTrue(all(k["killerPilot"] == "Ethan" for k in kills))

    def test_unitary_hits_and_the_dive_bomb_miss(self):
        c = self.by_name("AGM_154")[0]
        self.assertEqual((c["targetName"], c["result"]), ("SA-11 Buk SR 9S18M1", "destroyed"))
        self.assertLess(c["missDistance"], 15)
        gbu = self.by_name("GBU_12")[0]
        self.assertLess(gbu["missDistance"], 10)
        self.assertEqual(gbu["result"], "destroyed")
        mk = self.by_name("Mk_82")[0]
        self.assertEqual(mk["result"], "miss")
        self.assertTrue(20 < mk["missDistance"] < 80, mk["missDistance"])
        # A 30-degree dive at ~5,000 ft AGL, ~470 kt.
        self.assertLess(mk["release"]["dive"], -20)
        self.assertTrue(1200 < mk["release"]["agl"] < 2200)

    def test_release_and_fall(self):
        a = self.by_name("AGM_154A")[0]
        self.assertAlmostEqual(a["release"]["altitude"], 7620, delta=50)
        self.assertTrue(100 < a["timeOfFall"] < 260)
        self.assertGreater(a["glideRatio"], 4)
        self.assertTrue(a["envelope"]["inRange"])
        self.assertLess(a["envelope"]["rangeFraction"], 1.0)

    def test_timeline_and_targets(self):
        kinds = [i["kind"] for i in self.report["timeline"]]
        self.assertEqual(kinds.count("release"), 5)
        self.assertGreaterEqual(kinds.count("impact"), 5)
        names = {t["name"] for t in self.report["targets"]}
        self.assertIn("SA-11 Buk SR 9S18M1", names)
        self.assertTrue(any(t["destroyedBy"] == "GBU_12" for t in self.report["targets"]))


class JsowTaggedAsMissile(unittest.TestCase):
    """DCS files the JSOW under missiles; an exporter may tag it Weapon+Missile."""

    def test_still_a_strike_with_its_bomblets(self):
        rec = load()
        for tr in rec.tracks.values():
            if tr.name.startswith("AGM_154"):
                tr.props["Type"] = "Weapon+Missile"
                tr.tags = T.parse_tags("Weapon+Missile")
        rep = analyze_weapons(rec)
        strikes = analyze_strikes(rec, rep)
        jsows = [s for s in strikes if s.family == "jsow"]
        self.assertEqual(len(jsows), 3)
        self.assertEqual(sorted(s.submunitions for s in jsows), [0, 145, 145])
        self.assertEqual(sorted(s.submunitions_recorded for s in jsows), [0, 1, 1])


class Envelope(unittest.TestCase):
    def test_dcs_table_values(self):
        e = jsow_envelope(7010.0, 250.0)  # ~23,000 ft, ~M0.8
        self.assertAlmostEqual(e["rmax"] / 1852, 41, delta=3)
        self.assertTrue(6 * 1852 < e["rmin"] < 8 * 1852)
        low = jsow_envelope(300.0, 200.0)
        self.assertLess(low["rmax"], e["rmax"] / 4)

    def test_old_dcs_names(self):
        from dcs_sa.analysis.strike import clean_name, dispenser
        from dcs_sa.analysis.weapons import SUBMUNITION_RE
        self.assertEqual(clean_name("weapons.missiles.AGM_154A"), "AGM_154A")
        self.assertEqual(clean_name("weapons.bombs.CBU_97.client.launcher.cluster"), "CBU_97")
        self.assertEqual(family("weapons.bombs.GBU_12", "bomb"), "lgb")
        self.assertTrue(SUBMUNITION_RE.search("weapons.bombs.ROCKEYE.server.launcher.cluster"))
        self.assertEqual(dispenser("AGM_154A")[:2], ("BLU-97/B", 145))
        self.assertEqual(dispenser("CBU_105")[:2], ("BLU-108", 10))
        self.assertIsNone(dispenser("AGM_154"))

    def test_families(self):
        self.assertEqual(family("AGM_154A", "bomb"), "jsow")
        self.assertEqual(family("AGM_154", "missile"), "jsow")
        self.assertEqual(family("GBU_38", "bomb"), "jdam")
        self.assertEqual(family("GBU_12", "bomb"), "lgb")
        self.assertEqual(family("CBU_97", "bomb"), "cluster")
        self.assertEqual(family("Mk_82", "bomb"), "gp-bomb")
        self.assertEqual(family("AGM_65D", "missile"), "maverick")


if __name__ == "__main__":
    unittest.main()
