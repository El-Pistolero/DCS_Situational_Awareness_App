import json
import os
import tempfile
import unittest
from pathlib import Path

from dcs_sa.acmi import parse_file
from dcs_sa.analysis.report import analyze
from dcs_sa.career import CareerStore, summarise, totals

SAMPLES = Path(__file__).resolve().parent.parent / "samples"


def record(name, key=None):
    report = analyze(parse_file(str(SAMPLES / f"{name}.acmi")), ["Ethan"])
    return summarise(key or name, report, path=str(SAMPLES / f"{name}.acmi"), modified=1.0)


class SummariseTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.sortie = record("sample_sortie")
        cls.dogfight = record("sample_dogfight")

    def test_it_records_the_player_not_the_mission(self):
        self.assertEqual(self.sortie["profile"], "Ethan")
        self.assertEqual(self.sortie["aircraft"], "F-16C_50")
        # The MiG also fires in the dogfight; only my shots are counted.
        self.assertEqual(self.dogfight["shots"], 2)
        self.assertEqual(self.dogfight["kills"], 1)

    def test_kills_are_split_by_what_was_killed(self):
        self.assertEqual(self.sortie["airKills"], 1)
        self.assertEqual(self.sortie["groundKills"], 1)
        self.assertEqual(self.sortie["against"]["MiG-29S"]["kills"], 1)
        self.assertEqual(self.sortie["against"]["MiG-29S"]["category"], "fixedwing")

    def test_weapons_are_counted_by_name(self):
        self.assertEqual(self.sortie["byWeapon"]["AIM_120C"], {"fired": 1, "hits": 1, "misses": 0, "kills": 1, "dcsHits": 0, "decoyed": 0})
        self.assertEqual(self.dogfight["byWeapon"]["AIM_9"]["fired"], 2)
        self.assertEqual(self.dogfight["byWeapon"]["AIM_9"]["kills"], 1)

    def test_guns_and_landings_come_through(self):
        self.assertEqual(self.sortie["guns"], {"bursts": 2, "rounds": 200, "kills": 1})
        self.assertEqual(self.sortie["landings"], 1)
        self.assertEqual(self.sortie["grades"], ["A"])


class ScoringTests(unittest.TestCase):
    """A shot at a jet only counts when the jet went down."""

    def setUp(self):
        from dcs_sa.career import _scored

        self.scored = _scored

    def test_a_jet_that_flew_home_is_a_miss(self):
        self.assertEqual(self.scored("damage", "fixedwing"), "miss")
        self.assertEqual(self.scored("damage", "rotorcraft"), "miss")
        self.assertEqual(self.scored("kill", "fixedwing"), "hit")
        self.assertEqual(self.scored("miss", "fixedwing"), "miss")

    def test_damage_still_counts_on_the_ground(self):
        # A truck that survives a near miss was still hit by something real.
        self.assertEqual(self.scored("damage", "ground"), "hit")
        self.assertEqual(self.scored("damage", "sea"), "hit")
        self.assertEqual(self.scored("kill", "ground"), "hit")

    def test_an_undecided_shot_counts_neither_way(self):
        self.assertIsNone(self.scored("active", "fixedwing"))
        self.assertIsNone(self.scored("unknown", "ground"))
        self.assertIsNone(self.scored("", ""))

    def test_an_intercepted_shot_is_a_miss(self):
        self.assertEqual(self.scored("intercepted", "ground"), "miss")

    def test_a_damaged_but_living_jet_does_not_inflate_accuracy(self):
        from dcs_sa.career import summarise, totals

        report = {
            "recording": {"title": "t", "duration": 100.0},
            "player": "101",
            "aircraft": [{"id": "101", "pilot": "Ethan", "name": "F-16C_50"}],
            "objects": [{"id": "201", "category": "fixedwing"}, {"id": "301", "category": "ground"}],
            "weapons": {"shots": [
                {"launcherId": "101", "weaponName": "AIM_9", "targetId": "201", "outcome": "damage"},
                {"launcherId": "101", "weaponName": "AIM_9", "targetId": "201", "outcome": "kill"},
                {"launcherId": "101", "weaponName": "Mk_82", "targetId": "301", "outcome": "damage"},
            ], "kills": [], "bursts": []},
        }
        row = summarise("k", report)
        self.assertEqual(row["byWeapon"]["AIM_9"], {"fired": 2, "hits": 1, "misses": 1, "kills": 1, "dcsHits": 0, "decoyed": 0})
        self.assertEqual(row["byWeapon"]["Mk_82"]["hits"], 1)
        t = totals([row])
        self.assertAlmostEqual(t["accuracy"], 2 / 3)


class TotalsTests(unittest.TestCase):
    def test_records_add_up(self):
        rows = [record(n) for n in ("sample_sortie", "sample_strike", "sample_dogfight")]
        t = totals(rows)
        self.assertEqual(t["missions"], 3)
        self.assertEqual(t["kills"], sum(r["kills"] for r in rows))
        self.assertEqual(t["against"]["MiG-29S"]["kills"], 2)   # one in each air engagement
        self.assertEqual(t["byWeapon"]["AGM_154A"]["fired"], 2)
        self.assertEqual(t["byAircraft"]["F-16C_50"]["missions"], 3)

    def test_accuracy_ignores_undecided_shots(self):
        row = {"shots": 10, "hits": 3, "misses": 1, "kills": 3}
        t = totals([row])
        self.assertEqual(t["decided"], 4)
        self.assertAlmostEqual(t["accuracy"], 0.75)   # not 3/10

    def test_no_missions_means_no_accuracy_rather_than_zero(self):
        t = totals([])
        self.assertEqual(t["missions"], 0)
        self.assertIsNone(t["accuracy"])


class DrillDownTests(unittest.TestCase):
    """Every figure has to be openable: one row per shot and kill."""

    @classmethod
    def setUpClass(cls):
        cls.dogfight = record("sample_dogfight")

    def test_every_shot_and_kill_has_a_row(self):
        events = self.dogfight["events"]
        shots = [e for e in events if e["outcome"] != "kill"]
        kills = [e for e in events if e["outcome"] == "kill"]
        self.assertEqual(len(shots) + len([e for e in events if e["outcome"] == "kill" and "killOf" not in e]),
                         len([e for e in events if "killOf" not in e]))
        self.assertTrue(kills)
        for e in events:
            self.assertIn("t", e)
            self.assertIn("weapon", e)
            self.assertIn("scored", e)

    def test_rows_are_in_time_order(self):
        times = [e["t"] for e in self.dogfight["events"] if e["t"] is not None]
        self.assertEqual(times, sorted(times))

    def test_a_decoyed_shot_is_flagged_and_counted(self):
        decoyed = [e for e in self.dogfight["events"] if e["decoyed"]]
        self.assertTrue(decoyed, "the demo dogfight has an AIM-9 that goes for a flare")
        self.assertEqual(decoyed[0]["scored"], "miss")
        self.assertEqual(self.dogfight["byWeapon"]["AIM_9"]["decoyed"], len(decoyed))


class IncludeTests(unittest.TestCase):
    """Missions can be left out of the totals without being forgotten."""

    def setUp(self):
        self._tmp = tempfile.TemporaryDirectory()
        self.store = CareerStore(str(Path(self._tmp.name) / "career.json"))
        self.addCleanup(self._tmp.cleanup)
        self.store.remember({"key": "a", "profile": "E", "kills": 3, "shots": 4, "hits": 3, "misses": 1})
        self.store.remember({"key": "b", "profile": "E", "kills": 7, "shots": 7, "hits": 7, "misses": 0})

    def test_unticking_drops_it_from_the_totals_but_keeps_the_record(self):
        self.assertEqual(totals(self.store.records())["kills"], 10)
        self.assertTrue(self.store.set_included("b", False))
        self.assertEqual(totals(self.store.records())["kills"], 3)
        self.assertEqual(len(self.store.records()), 2)          # still listed
        self.assertFalse(self.store.included("b"))

    def test_the_choice_survives_a_restart(self):
        self.store.set_included("b", False)
        again = CareerStore(str(self.store.path))
        self.assertEqual(totals(again.records())["kills"], 3)
        self.assertFalse(again.included("b"))

    def test_reopening_a_mission_does_not_silently_re_include_it(self):
        self.store.set_included("b", False)
        self.store.remember({"key": "b", "profile": "E", "kills": 7})   # analysed again
        self.assertFalse(self.store.included("b"))
        self.assertEqual(totals(self.store.records())["kills"], 3)

    def test_ticking_it_back_on_restores_the_totals(self):
        self.store.set_included("b", False)
        self.store.set_included("b", True)
        self.assertEqual(totals(self.store.records())["kills"], 10)

    def test_an_unknown_mission_is_refused(self):
        self.assertFalse(self.store.set_included("nope", False))


class StoreTests(unittest.TestCase):
    def setUp(self):
        self._tmp = tempfile.TemporaryDirectory()
        self.path = Path(self._tmp.name) / "career.json"
        self.addCleanup(self._tmp.cleanup)

    def test_records_survive_a_restart_and_do_not_duplicate(self):
        s = CareerStore(str(self.path))
        s.remember(record("sample_sortie"))
        s.remember(record("sample_sortie"))       # same key: replaced, not added
        s.remember(record("sample_dogfight"))
        self.assertEqual(len(s.records()), 2)
        again = CareerStore(str(self.path))       # a fresh run reads the file
        self.assertEqual(len(again.records()), 2)
        self.assertEqual(again.profiles(), ["Ethan"])

    def test_records_are_filtered_by_pilot(self):
        s = CareerStore(str(self.path))
        mine = record("sample_sortie")
        theirs = dict(record("sample_dogfight"), key="other", profile="Ivanov")
        s.remember(mine)
        s.remember(theirs)
        self.assertEqual([r["profile"] for r in s.records("Ethan")], ["Ethan"])
        self.assertEqual(len(s.records("all")), 2)
        self.assertEqual(sorted(s.profiles()), ["Ethan", "Ivanov"])

    def test_a_corrupt_file_is_not_fatal(self):
        self.path.write_text("{ this is not json")
        s = CareerStore(str(self.path))
        self.assertEqual(s.records(), [])
        s.remember(record("sample_sortie"))       # and it recovers by rewriting
        self.assertEqual(len(CareerStore(str(self.path)).records()), 1)

    def test_forget_and_clear(self):
        s = CareerStore(str(self.path))
        s.remember(record("sample_sortie"))
        self.assertTrue(s.forget("sample_sortie"))
        self.assertFalse(s.forget("sample_sortie"))
        s.remember(record("sample_dogfight"))
        s.clear()
        self.assertEqual(s.records(), [])

    def test_opening_a_recording_records_it(self):
        import time
        import urllib.request

        from dcs_sa.config import Config
        from dcs_sa.server.app import start, stop

        cfg = Config()
        cfg.port = 0
        cfg.bridge_enabled = False
        cfg.recording_dirs = []
        cfg.upload_dir = str(Path(self._tmp.name) / "recordings")
        app, httpd, url = start(cfg)
        try:
            get = lambda p: json.loads(urllib.request.urlopen(url.rstrip("/") + p, timeout=10).read())
            key = next(r["key"] for r in get("/api/recordings")["recordings"] if r["name"] == "sample_sortie.acmi")
            deadline = time.time() + 30
            while get(f"/api/recording/{key}/load")["state"] != "ready" and time.time() < deadline:
                time.sleep(0.1)
            career = get("/api/career")
            self.assertEqual(career["totals"]["missions"], 1)
            self.assertEqual(career["missions"][0]["key"], key)
            self.assertIn("Ethan", career["profiles"])
        finally:
            stop(app, httpd)


if __name__ == "__main__":
    unittest.main()
