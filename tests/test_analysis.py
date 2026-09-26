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



class EjectedPilotTests(unittest.TestCase):
    """An ejected pilot is a person falling, not an air contact or a target."""

    def _rec(self, lines):
        import tempfile

        from dcs_sa.acmi import parse_file

        with tempfile.NamedTemporaryFile("w", suffix=".acmi", delete=False, encoding="utf-8") as fh:
            fh.write("\n".join(lines) + "\n")
            path = fh.name
        self.addCleanup(lambda: os.unlink(path))
        return parse_file(path)

    def test_a_parachutist_is_not_an_aircraft(self):
        from dcs_sa.acmi import types as T

        chute = T.parse_tags("Ground+Light+Human+Air+Parachutist")
        self.assertEqual(T.category(chute), "person")
        # Infantry is still a target worth strafing.
        self.assertEqual(T.category(T.parse_tags("Ground+Light+Human+Infantry")), "ground")
        self.assertEqual(T.category(T.parse_tags("Air+FixedWing")), "fixedwing")

    def test_a_missile_is_not_credited_with_shooting_at_a_pilot(self):
        """The pilot appears where the jet died, right by the missile's last point."""
        from dcs_sa.analysis.report import analyze

        lines = ["FileType=text/acmi/tacview", "FileVersion=2.2",
                 "0,ReferenceLongitude=41,ReferenceLatitude=41,ReferenceTime=2026-01-01T00:00:00Z", "#0",
                 "101,T=0.00|0.00|6000,Name=F-16C_50,Pilot=Me,Coalition=Allies,Type=Air+FixedWing",
                 "201,T=0.30|0.00|6000,Name=MiG-29S,Pilot=Red,Coalition=Enemies,Type=Air+FixedWing"]
        for i, t in enumerate((1.0, 2.0, 3.0)):
            lon = 0.1 * (i + 1)
            lines += [f"#{t}", f"4001,T={lon:.4f}|0.00|6000,Name=AIM_120C,Coalition=Allies,Type=Weapon+Missile"]
        # The jet dies and a pilot appears at the same spot.
        lines += ["#4", "-201", "-4001",
                  "901,T=0.30|0.00|5900,Name=PILOT_F16,Coalition=Enemies,Type=Ground+Light+Human+Air+Parachutist"]
        lines += ["#8", "901,T=0.30|0.00|5000"]
        rep = analyze(self._rec(lines))
        cats = {o["id"]: o["category"] for o in rep["objects"]}
        self.assertEqual(cats.get("901"), "person")
        for shot in rep["weapons"]["shots"]:
            self.assertNotEqual(shot.get("targetName"), "PILOT_F16", shot)
        # And it is not counted among the aircraft.
        self.assertNotIn("901", {a["id"] for a in rep["aircraft"]})

if __name__ == "__main__":
    unittest.main()
