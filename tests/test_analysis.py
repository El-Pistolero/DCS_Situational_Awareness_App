import json
import os
import unittest

from dcs_sa.acmi import parse_file
from dcs_sa.analysis.report import analyze, to_markdown
from dcs_sa.samplegen import write_sample

SAMPLE = os.path.join(os.path.dirname(__file__), "..", "samples", "sample_sortie.acmi")


class SampleSortieAnalysis(unittest.TestCase):
    """End-to-end analysis of the generated sortie, where ground truth is known."""

    @classmethod
    def setUpClass(cls):
        if not os.path.exists(SAMPLE):
            write_sample(SAMPLE)
        cls.rec = parse_file(SAMPLE)
        cls.report = analyze(cls.rec, ["Ethan"])

    def test_report_is_strict_json(self):
        json.dumps(self.report, allow_nan=False)

    def test_player_detected(self):
        self.assertEqual(self.report["player"], "101")

    def test_amraam_kill_attributed_via_lock(self):
        shots = {s["weaponName"]: s for s in self.report["weapons"]["shots"]}
        amraam = shots["AIM_120C"]
        self.assertEqual(amraam["outcome"], "kill")
        self.assertEqual(amraam["targetSource"], "lock")
        self.assertEqual(amraam["launcherPilot"], "Ethan")
        self.assertAlmostEqual(amraam["geometry"]["range"] / 1852, 21.4, delta=0.5)

    def test_r27_defeated(self):
        r27 = next(s for s in self.report["weapons"]["shots"] if s["weaponName"] == "R-27ER")
        self.assertEqual(r27["outcome"], "miss")
        self.assertEqual(r27["outcomeDetail"], "timed out")

    def test_gun_kill(self):
        bursts = self.report["weapons"]["bursts"]
        self.assertEqual(len(bursts), 2)
        self.assertEqual([b["kill"] for b in bursts], [False, True])
        self.assertTrue(all(b["targetId"] == "301" for b in bursts))

    def test_landing_graded(self):
        ld = next(l for l in self.report["landings"] if l["aircraftId"] == "101")
        self.assertEqual(ld["location"], "Batumi")
        self.assertEqual(ld["outcome"], "landed")
        self.assertIn(ld["grade"], ("A", "B"))
        self.assertTrue(100 < ld["touchdown"]["sinkRateFpm"] < 600)
        self.assertAlmostEqual(ld["approachCourse"], 126, delta=2)
        self.assertEqual(len(ld["gates"]), 6)

    def test_takeoff(self):
        to = next(t for t in self.report["takeoffs"] if t["aircraftId"] == "101")
        self.assertEqual(to["location"], "Batumi")
        self.assertTrue(to["afterburnerUsed"])
        self.assertTrue(500 < to["groundRollM"] < 1500)

    def test_lock_episodes(self):
        locks = self.report["radar"]["locks"]
        ethan = next(l for l in locks if l["ownerId"] == "101")
        self.assertEqual(ethan["targetId"], "201")
        self.assertEqual(ethan["shotsDuring"], 1)
        mig = next(l for l in locks if l["ownerId"] == "201")
        self.assertEqual(mig["endedBy"], "owner-destroyed")

    def test_markdown(self):
        md = to_markdown(self.report)
        self.assertIn("AIM_120C", md)
        self.assertIn("grade", md)

    def test_landing_detection_without_agl(self):
        rec = parse_file(SAMPLE)
        for tr in rec.tracks.values():
            tr.channels.pop("AGL", None)
        report = analyze(rec)
        times = [l["time"] for l in report["landings"] if l["aircraftId"] == "101"]
        self.assertEqual(len(times), 1)
        self.assertAlmostEqual(times[0], 580.0, delta=1.0)


if __name__ == "__main__":
    unittest.main()
