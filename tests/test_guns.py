"""Gun rounds: classification, burst grouping, shooter inference, ballistics."""

import math
import os
import unittest

from dcs_sa.acmi import parse_file
from dcs_sa.acmi import types as T
from dcs_sa.acmi.parser import AcmiParser, RecordingBuilder
from dcs_sa.analysis.weapons import ROUND_HIT_RADIUS, analyze_weapons
from dcs_sa.samplegen import write_sample

SAMPLE = os.path.join(os.path.dirname(__file__), "..", "samples", "sample_sortie.acmi")
M_PER_DEG = 111320.0


def parse_lines(lines):
    b = RecordingBuilder()
    p = AcmiParser(b)
    for line in lines:
        p.feed(line)
    return b.finish()


class RoundClassification(unittest.TestCase):
    def test_gun_round_tags(self):
        for tags in ("Weapon+Projectile+Shell", "Projectile+Bullet", "Weapon+Bullet", "Projectile", "Weapon+Projectile"):
            self.assertEqual(T.category(T.parse_tags(tags)), "round", tags)

    def test_guided_and_debris_are_not_rounds(self):
        self.assertEqual(T.category(T.parse_tags("Weapon+Missile")), "weapon")
        self.assertEqual(T.category(T.parse_tags("Weapon+Projectile+Rocket")), "weapon")
        self.assertEqual(T.category(T.parse_tags("Misc+Shrapnel")), "clutter")


class SampleStrafe(unittest.TestCase):
    """The demo sortie fires two 1 s bursts of ballistic 20 mm rounds."""

    @classmethod
    def setUpClass(cls):
        if not os.path.exists(SAMPLE):
            write_sample(SAMPLE)
        cls.rec = parse_file(SAMPLE)
        cls.report = analyze_weapons(cls.rec)

    def test_bursts_grouped_and_attributed(self):
        bursts = self.report.bursts
        self.assertEqual([b.rounds for b in bursts], [100, 100])
        # Like real DCS output, no round carries Parent: the shooter is the
        # F-16 that was there when each round appeared.
        self.assertFalse(any(t.props.get("Parent") for t in self.rec.tracks.values() if t.category == "round"))
        self.assertTrue(all(b.launcher_id == "101" for b in bursts))
        for b in bursts:
            self.assertAlmostEqual(b.fire_rate, 100.0, delta=5.0)
            self.assertEqual(b.weapon_name, "M61A1 Vulcan")

    def test_kill_and_rounds_on_target(self):
        walk, kill = self.report.bursts
        self.assertFalse(walk.kill)
        self.assertTrue(kill.kill)
        self.assertGreater(kill.rounds_on_target, 5)
        self.assertLess(kill.closest_approach, ROUND_HIT_RADIUS)
        gun_kill = next(k for k in self.report.kills if k.weapon_kind == "gun")
        self.assertEqual((gun_kill.victim_id, gun_kill.killer_id), ("301", "101"))

    def test_rounds_follow_a_ballistic_arc(self):
        for tr in [t for t in self.rec.tracks.values() if t.category == "round"][:20]:
            alt, t = tr.series("Altitude"), list(tr.t)
            # Second difference of altitude ~ -g dt^2 on evenly spaced interior samples.
            for i in range(1, len(alt) - 2):
                dt = t[i + 1] - t[i]
                if abs((t[i] - t[i - 1]) - dt) > 1e-6:
                    continue
                accel = (alt[i + 1] - 2 * alt[i] + alt[i - 1]) / (dt * dt)
                self.assertAlmostEqual(accel, -9.81, delta=0.8)

    def test_rounds_end_on_the_ground_near_the_target(self):
        tgt = self.rec.tracks["301"].position_at(0)
        kill_burst = self.report.bursts[1]
        for rid in kill_burst.round_ids:
            end = self.rec.tracks[rid].position_at(self.rec.tracks[rid].last_seen)
            self.assertAlmostEqual(end[2], tgt[2], delta=1.0)
            d = math.hypot((end[0] - tgt[0]) * M_PER_DEG * math.cos(math.radians(tgt[1])), (end[1] - tgt[1]) * M_PER_DEG)
            self.assertLess(d, 40.0)


class AirToAirGunKill(unittest.TestCase):
    """A guns pass written the way DCS writes it: one object per round,
    Type=Projectile+Shell, Name=weapons.shells.*, no Parent, rounds sampled
    only every 0.5 s (500 m apart) - they must still be matched to the jet
    that fired them and to the target they passed within a metre of."""

    def build(self, parent=False, rival=False):
        lines = ["FileType=text/acmi/tacview", "FileVersion=2.2", "0,ReferenceLongitude=40", "0,ReferenceLatitude=40"]
        deg = lambda m: m / M_PER_DEG  # noqa: E731
        lon_m = lambda m: m / (M_PER_DEG * math.cos(math.radians(40)))  # noqa: E731
        spawns = [1.0 + 0.05 * k for k in range(7)]  # one 0.3 s trigger pull, 3 rounds per frame
        rounds = {}
        frames = sorted({round(0.05 * i, 2) for i in range(0, 81)})
        for t in frames:
            lines.append(f"#{t}")
            # Target flies east at 200 m/s at 5000 m; shooter trails 700 m behind.
            lines.append(f"A,T={lon_m(200 * t):.8f}|0|5000|0|0|90,Type=Air+FixedWing,Name=MiG-29S,Coalition=Enemies,Country=ru")
            lines.append(f"B,T={lon_m(200 * t - 700):.8f}|{deg(3):.8f}|5000|0|0|90,Type=Air+FixedWing,Name=F-16C_50,Pilot=Gunner,Coalition=Allies,Country=us")
            if rival:
                # A friendly of the target flying 40 m from the shooter: must not be credited.
                lines.append(f"C,T={lon_m(200 * t - 700):.8f}|{deg(43):.8f}|5000|0|0|90,Type=Air+FixedWing,Name=MiG-29S,Coalition=Enemies,Country=ru")
            for ts in spawns:
                for k in range(3):
                    rid = f"R{int(round(ts * 100))}{k}"
                    tau = round(t - ts, 3)
                    if tau < 0 or tau > 1.5:
                        continue
                    first = rid not in rounds
                    # Sampled at the spawn frame, then every 0.5 s.
                    if not first and abs((tau / 0.5) - round(tau / 0.5)) > 1e-6:
                        continue
                    rounds[rid] = True
                    x = 200 * ts - 700 + k + 1000 * tau
                    y = 3 - 2 * tau
                    text = ",Type=Projectile+Shell,Name=weapons.shells.M61_20_HE,Coalition=Allies,Country=us" + (",Parent=B" if parent else "") if first else ""
                    lines.append(f"{rid},T={lon_m(x):.8f}|{deg(y):.8f}|5000{text}")
                    if tau >= 1.5 - 1e-9:
                        lines.append(f"-{rid}")
            if t == 3.0:
                lines.append("0,Event=Destroyed|A|")
            if t == 3.5:
                lines.append("-A")
        return parse_lines(lines)

    def test_gun_kill_with_parent(self):
        rep = analyze_weapons(self.build(parent=True))
        self.assertEqual(len(rep.bursts), 1)
        b = rep.bursts[0]
        self.assertEqual((b.target_id, b.launcher_id, b.rounds), ("A", "B", 21))
        self.assertEqual((b.ammo, b.weapon_name), ("M61_20_HE", "M61A1 Vulcan"))
        self.assertTrue(b.kill)
        self.assertEqual(b.rounds_on_target, 21)
        self.assertLess(b.closest_approach, ROUND_HIT_RADIUS)
        self.assertEqual(rep.kills[0].killer_pilot, "Gunner")

    def test_shooter_inferred_without_parent(self):
        rep = analyze_weapons(self.build(parent=False))
        self.assertEqual(len(rep.bursts), 1)
        self.assertEqual(rep.bursts[0].launcher_id, "B")
        self.assertTrue(rep.bursts[0].kill)
        self.assertAlmostEqual(rep.bursts[0].fire_rate, 21 / 0.35, delta=1.0)

    def test_enemy_next_to_shooter_is_not_credited(self):
        rep = analyze_weapons(self.build(parent=False, rival=True))
        self.assertEqual(rep.bursts[0].launcher_id, "B")

    def test_scrambled_positions_are_not_attributed(self):
        rec = self.build(parent=False)
        tr = next(t for t in rec.tracks.values() if t.category == "round")
        tr.channels["Longitude"][1] += 1.0  # ~85 km jump in half a second
        rep = analyze_weapons(rec)
        self.assertEqual(rep.rounds["implausible"], 1)
        self.assertEqual(rep.bursts[0].rounds, 20)


class TriggerFallback(unittest.TestCase):
    def test_trigger_only_burst(self):
        rec = parse_lines(["FileType=text/acmi/tacview", "FileVersion=2.2", "#0",
                           "1,T=41|41|1000,Type=Air+FixedWing,Name=F-16C_50,TriggerPressed=0",
                           "#1", "1,TriggerPressed=1", "#2.5", "1,TriggerPressed=0", "#3", "1,T=41.01|41|1000"])
        rep = analyze_weapons(rec)
        self.assertEqual([(b.source, b.start, b.end) for b in rep.bursts], [("trigger", 1.0, 2.5)])


if __name__ == "__main__":
    unittest.main()
