"""Heat-seekers and flares: the synthetic dogfight demo."""

import os
import unittest

from dcs_sa.acmi import parse_file
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

    def test_regenerates_identically(self):
        import tempfile
        with tempfile.TemporaryDirectory() as d:
            path = write_dogfight_sample(os.path.join(d, "x.acmi"))
            with open(path, encoding="utf-8") as a, open(SAMPLE, encoding="utf-8") as b:
                self.assertEqual(a.read(), b.read())


if __name__ == "__main__":
    unittest.main()
