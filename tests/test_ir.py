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


class DecoyedShotIsAMiss(unittest.TestCase):
    """A missile that chased a flare must not be credited with a hit."""

    def _acmi(self, lines):
        import tempfile

        from dcs_sa.acmi import parse_file

        with tempfile.NamedTemporaryFile("w", suffix=".acmi", delete=False, encoding="utf-8") as fh:
            fh.write("\n".join(lines) + "\n")
            path = fh.name
        self.addCleanup(lambda: os.unlink(path))
        return parse_file(path)

    def test_health_lost_to_someone_else_is_not_my_hit(self):
        """A wingman's missile kills; mine went wide.  Mine is still a miss."""
        from dcs_sa.analysis.weapons import HEALTH_DAMAGE_RADIUS, analyze_weapons, find_destructions

        lines = ["FileType=text/acmi/tacview", "FileVersion=2.2",
                 "0,ReferenceLongitude=41,ReferenceLatitude=41,ReferenceTime=2026-01-01T00:00:00Z"]
        lines += ["#0",
                  "101,T=0.00|0.00|3000,Name=F-16C_50,Pilot=Me,Coalition=Allies,Type=Air+FixedWing",
                  "201,T=0.20|0.00|3000,Name=MiG-29S,Pilot=Bandit,Coalition=Enemies,Type=Air+FixedWing,Health=1.0"]
        # My AIM-9 flies past, never nearer than ~1.5 km.
        for i, t in enumerate([1.0, 2.0, 3.0, 4.0]):
            lon = 0.02 * (i + 1)
            lines += [f"#{t}", f"4001,T={lon:.5f}|0.02|3000,Name=AIM_9,Coalition=Allies,Type=Weapon+Missile",
                      f"201,T=0.20|0.00|3000,Health={1.0 if t < 3 else 0.4}"]
        lines += ["#5", "-4001"]
        rec = self._acmi(lines)
        rep = analyze_weapons(rec, find_destructions(rec))
        mine = [s for s in rep.shots if s.weapon_name == "AIM_9"]
        self.assertTrue(mine)
        self.assertGreater(mine[0].closest_approach or 0, HEALTH_DAMAGE_RADIUS)
        self.assertEqual(mine[0].outcome, "miss", mine[0].outcome_detail)

    def test_a_close_pass_still_counts_as_damage(self):
        """The proximity rule must not throw away real damage."""
        from dcs_sa.analysis.weapons import analyze_weapons, find_destructions

        lines = ["FileType=text/acmi/tacview", "FileVersion=2.2",
                 "0,ReferenceLongitude=41,ReferenceLatitude=41,ReferenceTime=2026-01-01T00:00:00Z",
                 "#0",
                 "101,T=0.00|0.00|3000,Name=F-16C_50,Pilot=Me,Coalition=Allies,Type=Air+FixedWing",
                 "201,T=0.01|0.00|3000,Name=MiG-29S,Pilot=Bandit,Coalition=Enemies,Type=Air+FixedWing,Health=1.0"]
        for t, lon in ((1.0, 0.004), (2.0, 0.008), (3.0, 0.00999)):
            lines += [f"#{t}", f"4001,T={lon:.5f}|0.00|3000,Name=AIM_9,Coalition=Allies,Type=Weapon+Missile"]
        lines += ["#4", "201,T=0.01|0.00|3000,Health=0.4", "-4001"]
        rec = self._acmi(lines)
        rep = analyze_weapons(rec, find_destructions(rec))
        mine = [s for s in rep.shots if s.weapon_name == "AIM_9"][0]
        self.assertEqual(mine.outcome, "damage", (mine.closest_approach, mine.outcome_detail))

    def test_a_decoyed_shot_is_reported_as_a_miss(self):
        """Even where health fell, a shot the IR analysis says was decoyed is a miss."""
        from dcs_sa.analysis import ir as IR

        class Shot:
            weapon_id = "4001"
            weapon_name = "AIM_9"
            outcome = "damage"
            outcome_detail = "health 1.00 -> 0.40"
            killed_id = "201"
            killed_name = "MiG-29S"
            closest_approach = 300.0
            dcs_hit = False

        shot = Shot()
        out = {"decoy": {"t": 3.0, "flareId": "9001", "method": "zem"}}
        IR._settle_decoy(shot, out, fuze=10.0)
        self.assertEqual(shot.outcome, "miss")
        self.assertIsNone(shot.killed_id)
        self.assertEqual(shot.outcome_detail, "likely went for a flare (est.)")

    def test_dcs_s_own_hit_report_still_wins(self):
        from dcs_sa.analysis import ir as IR

        class Shot:
            weapon_id = "4001"
            weapon_name = "AIM_9"
            outcome = "damage"
            outcome_detail = "DCS reported a hit"
            killed_id = None
            killed_name = None
            closest_approach = 300.0
            dcs_hit = True

        shot = Shot()
        IR._settle_decoy(shot, {"decoy": {"t": 3.0}}, fuze=10.0)
        self.assertEqual(shot.outcome, "damage")
        self.assertEqual(shot.outcome_detail, "DCS reported a hit")


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


def _acmi(lines):
    """Parse a small hand-written ACMI (frames: list of (t, [object lines]))."""
    import tempfile
    txt = ["FileType=text/acmi/tacview", "FileVersion=2.2", "0,ReferenceTime=2026-09-26T09:00:00Z",
           "0,ReferenceLongitude=41", "0,ReferenceLatitude=41"]
    for t, objs in lines:
        txt.append(f"#{t:g}")
        txt.extend(objs)
    with tempfile.NamedTemporaryFile("w", suffix=".acmi", delete=False, encoding="utf-8") as f:
        f.write("\n".join(txt) + "\n")
    return parse_file(f.name)


class ReviewFixes(unittest.TestCase):
    """Cases the adversarial review found."""

    def _chase(self, launcher_type="Air+FixedWing", launcher_name="F-16C_50", weapon="AIM_9", pilot="Ethan"):
        # A target 2 km ahead running north at 250 m/s; the missile leaves at 150 m/s (slower,
        # like a MANPADS ejection), speeds up slowly for 2 s, then hard up to 800 m/s.
        m_per_deg = 111320.0
        air = (launcher_type or "").startswith("Air")
        y0 = 250.0 * 5.0 if air else 2000.0 + 250.0 * 5.0 - 2500.0  # where the missile leaves
        frames = []
        mt, mv = 0.0, 150.0
        for k in range(0, 101):
            t = k * 0.1
            ty = 2000.0 + 250.0 * (t + 5.0)
            objs = [f"201,T=0|{ty / m_per_deg:.7f}|6000|0|0|0,Type=Air+FixedWing,Name=MiG-29S,Pilot=Ivanov,Coalition=Enemies,Color=Red"]
            if launcher_type:
                ly = 250.0 * (t + 5.0) if air else y0
                objs.append(f"101,T=0|{ly / m_per_deg:.7f}|6000|0|0|0,Type={launcher_type},"
                            f"Name={launcher_name},Pilot={pilot},Coalition=Allies,Color=Blue")
            if t >= 5.0:
                tau = t - 5.0
                if tau > 0:
                    mv = min(800.0, mv + (60.0 if tau < 2.0 else 200.0) * 0.1)
                    mt += mv * 0.1
                objs.append(f"3001,T=0|{(y0 + 3.0 + mt) / m_per_deg:.7f}|6000|0|0|0,Type=Weapon+Missile,Name={weapon},Coalition=Allies,Color=Blue")
            frames.append((t, objs))
        return frames

    def test_a_missile_slower_than_its_target_at_first_has_not_passed_it(self):
        rep = analyze(_acmi(self._chase()), ["Ethan"])
        [s] = rep["weapons"]["shots"]
        self.assertTrue(s["ir"]["series"])            # the fly-out is analysed, not cut at the first sample
        self.assertGreater(s["ir"]["series"][-1]["t"], 2.0)

    def test_no_launch_look_angle_for_ground_launchers(self):
        rep = analyze(_acmi(self._chase("Ground+AntiAircraft", "SA-18 Igla manpad", "Igla_1E", "")), [])
        shots = [s for s in rep["weapons"]["shots"] if s.get("ir")]
        self.assertTrue(shots)
        self.assertEqual(shots[0]["launcherId"], "101")
        self.assertNotIn("launch", shots[0]["ir"])  # a soldier's heading is not where the tube points

    def test_dcs_event_ir_guidance_marks_an_unknown_missile(self):
        from dcs_sa.analysis.weapons import analyze_weapons
        rec = _acmi(self._chase(weapon="MOD_HEATSEEKER"))
        rep = analyze_weapons(rec)
        [shot] = rep.shots
        self.assertIsNone(IR.seeker(shot.weapon_name))
        shot.dcs_guidance = 2  # DCS's own shot event said: IR
        IR.analyze_ir(rec, rep)
        self.assertTrue(shot.ir["seeker"]["fromEvent"])
        self.assertNotIn("launch", shot.ir)  # no DCS seeker limits to compare with

    def test_decoy_flare_existed_at_the_decoy_moment(self):
        rec = load()
        rep = analyze(rec, ["Ethan"])
        for s in rep["weapons"]["shots"]:
            d = s["ir"].get("decoy")
            if d:
                self.assertLessEqual(rec.tracks[d["flareId"]].first_seen, s["launchTime"] + d["t"] + 1e-6)

    def test_exact_type_name_wins(self):
        self.assertEqual(IR.airframe("OH-58D")["ir"], 0.2)   # not the OH58D module's 0.07
        self.assertEqual(IR.airframe("OH58D")["ir"], 0.07)

    def test_ir_sam_names(self):
        for n in ("M6 Linebacker", "M1097 Avenger", "Stinger manpad", "Strela-10M3", "SA-18 Igla manpad"):
            self.assertTrue(IR.is_ir_sam(n), n)
        for n in ("SA-11 Buk LN 9A310M1", "Tor 9A331", "ZSU-23-4 Shilka"):
            self.assertFalse(IR.is_ir_sam(n), n)

    def test_afterburner_unknown_where_the_flight_log_has_no_data(self):
        # Bridge fuel flow logged only from 60 s on; the recording starts at 0.
        t = [i * 0.5 for i in range(240)]
        ff = [float("nan") if ti < 60 else (24.0 if 80 <= ti < 90 else 3.0) for ti in t]
        st = IR.ab_state(AfterburnerRules.track("F-16C_50", t, DcsFuelFlow=ff, IAS=[200.0] * 240))
        self.assertEqual((st["state"], st["src"]), ("recorded", "DcsFuelFlow"))
        self.assertIsNone(IR.ab_at(st, 30.0))      # before the log: not known, never "dry"
        self.assertIs(IR.ab_at(st, 70.0), False)
        self.assertIs(IR.ab_at(st, 85.0), True)

    def test_live_tracker_keeps_its_dry_anchor_through_a_long_burn(self):
        tr = IR.FuelFlowAB()
        for i in range(60):
            tr.add(float(i), 3000.0, True)
        for i in range(60, 700):  # ten minutes in afterburner: the window alone has no dry mode left
            tr.add(float(i), 25000.0, True)
            tr.lit(25000.0)
        self.assertIs(tr.lit(25000.0), True)
        self.assertIs(tr.lit(3000.0), False)


class LiveFeed(unittest.TestCase):
    def test_afterburner_known_without_a_browser_watching(self):
        from dcs_sa.acmi.parser import AcmiParser
        from dcs_sa.acmi.reader import iter_lines
        from dcs_sa.telemetry.live_world import LiveWorld
        load()
        w = LiveWorld(["Ethan"])
        p = AcmiParser(w)
        snap = None
        for line in iter_lines(SAMPLE):
            if line.startswith("#") and float(line[1:]) >= 131.0:
                snap = w.snapshot()  # the first snapshot of the whole stream
                break
            p.feed(line)
        self.assertIs(snap["heat"]["ab"], True)
        flares = [o for o in snap["objects"] if o.get("cmKind") == "flare" and o.get("cmOwner")]
        self.assertTrue(all(o["cmOwnerSide"]["coalition"] for o in flares))
