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
            for i in range(1, len(alt) - 1):
                dt = t[i + 1] - t[i]
                if abs((t[i] - t[i - 1]) - dt) > 1e-6:
                    continue
                accel = (alt[i + 1] - 2 * alt[i] + alt[i - 1]) / (dt * dt)
                self.assertAlmostEqual(accel, -9.81, delta=0.8)

    def test_rounds_reach_the_target_although_deleted_before_impact(self):
        # Like DCS, the sample deletes a round on impact without an impact
        # sample; carried on to its removal time, each path reaches the target.
        from dcs_sa.analysis.weapons import _closest_approach, _weapon_samples
        tgt = self.rec.tracks["301"]
        kill_burst = self.report.bursts[1]
        for rid in kill_burst.round_ids:
            tr = self.rec.tracks[rid]
            self.assertLess(tr.t[-1], tr.removed_at)  # no sample at the impact point
            _, miss, _ = _closest_approach(_weapon_samples(tr), [tgt], float("inf"))
            self.assertLess(miss, 40.0)

    def test_rounds_start_ahead_of_the_shooter(self):
        jet = self.rec.tracks["101"]
        for b in self.report.bursts:
            for rid in b.round_ids[:12]:
                tr = self.rec.tracks[rid]
                p0, p1 = tr.position_at(tr.t[0]), tr.position_at(tr.t[1])
                j = jet.position_interp(tr.t[0])
                kx = M_PER_DEG * math.cos(math.radians(j[1]))
                fwd = ((p1[0] - p0[0]) * kx, (p1[1] - p0[1]) * M_PER_DEG)
                rel = ((p0[0] - j[0]) * kx, (p0[1] - j[1]) * M_PER_DEG)
                self.assertGreaterEqual(fwd[0] * rel[0] + fwd[1] * rel[1], -1.0, rid)  # not behind the jet


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


class RoundsDeletedOnImpact(unittest.TestCase):
    """DCS deletes a round when it hits, so its last sample is up to a frame
    short of the target and there is no impact sample."""

    def build(self, frame=0.25, range_m=700.0, bursts=((1.0, 0.0),), kill_at=None, removal=True):
        lines = ["FileType=text/acmi/tacview", "FileVersion=2.2", "0,ReferenceLongitude=40", "0,ReferenceLatitude=40"]
        deg = lambda m: m / M_PER_DEG  # noqa: E731
        lon_m = lambda m: m / (M_PER_DEG * math.cos(math.radians(40)))  # noqa: E731
        spawn = {}
        for b0, dy in bursts:
            for k in range(8):  # 8 rounds per burst, 0.05 s apart
                spawn[f"R{int(b0 * 100)}{k}"] = (b0 + 0.05 * k, dy)
        alive = set()
        steps = int(6.0 / 0.05)
        for i in range(steps + 1):
            t = round(i * 0.05, 2)
            lines.append(f"#{t}")
            lines.append(f"A,T={lon_m(200 * t):.8f}|0|5000|0|0|90,Type=Air+FixedWing,Name=MiG-29S,Coalition=Enemies,Country=ru")
            lines.append(f"B,T={lon_m(200 * t - range_m):.8f}|0|5000|0|0|90,Type=Air+FixedWing,Name=F-16C_50,Pilot=Gunner,Coalition=Allies,Country=us")
            for rid, (ts, dy) in spawn.items():
                tau = t - ts
                if tau < -1e-9:
                    continue
                x = 200 * ts - range_m + 1000 * tau
                hit_tau = range_m / 800.0  # closes at 1000 - 200 m/s
                if tau > hit_tau + 1e-9:
                    if rid in alive:
                        if removal:
                            lines.append(f"-{rid}")
                        alive.discard(rid)
                        spawn[rid] = (ts, dy)
                    continue
                on_frame = abs(t / frame - round(t / frame)) < 1e-6
                first = rid not in alive and tau < 0.05
                if not (on_frame or first) or (rid not in alive and not first):
                    continue
                text = ",Type=Projectile+Shell,Name=weapons.shells.M61_20_HE,Coalition=Allies,Country=us" if first else ""
                alive.add(rid)
                lines.append(f"{rid},T={lon_m(x):.8f}|{deg(dy):.8f}|5000{text}")
            if kill_at is not None and abs(t - kill_at) < 1e-6:
                lines.append("0,Event=Destroyed|A|")
        return parse_lines(lines)

    def test_hits_count_although_last_sample_is_short(self):
        rec = self.build(frame=0.25)
        rep = analyze_weapons(rec)
        self.assertEqual(len(rep.bursts), 1)
        b = rep.bursts[0]
        self.assertEqual((b.launcher_id, b.target_id), ("B", "A"))
        self.assertEqual(b.rounds_on_target, 8)
        self.assertLess(b.closest_approach, ROUND_HIT_RADIUS)

    def test_close_range_rounds_not_credited_to_the_target(self):
        # At 300 m, rounds first seen a frame late are nearer the target than
        # the shooter; they must still belong to B.
        rep = analyze_weapons(self.build(frame=0.25, range_m=300.0))
        self.assertEqual({b.launcher_id for b in rep.bursts}, {"B"})

    def test_kill_goes_to_the_burst_that_landed_last(self):
        # Burst 1 passes 2 m from A (damage), burst 2 passes 8 m and A dies.
        rec = self.build(bursts=((1.0, 2.0), (3.0, 8.0)), kill_at=4.2)
        rep = analyze_weapons(rec)
        self.assertEqual(len(rep.bursts), 2)
        self.assertEqual([b.kill for b in rep.bursts], [False, True])


class PlaybackShapes(unittest.TestCase):
    def test_round_without_removal_ends_at_its_last_sample(self):
        from dcs_sa.server.store import RecordingStore
        rec = RoundsDeletedOnImpact().build(removal=False)
        pb = RecordingStore.playback(rec)
        for r in pb["rounds"]:
            self.assertLessEqual(r["end"], r["t"][-1] + 1e-6)

    def test_ground_radar_gets_its_own_times(self):
        # A search radar sweeping at 60 deg/s: positions are sampled every
        # 5 s for ground units, which would alias the sweep backwards.
        from dcs_sa.server.store import RecordingStore
        lines = ["FileType=text/acmi/tacview", "FileVersion=2.2", "0,ReferenceLongitude=40", "0,ReferenceLatitude=40",
                 "#0", "S,T=0.1|0.1|100,Type=Ground+AntiAircraft,Name=SA-11 Buk SR 9S18M1,Coalition=Enemies,RadarMode=1,RadarHorizontalBeamwidth=3,RadarVerticalBeamwidth=30"]
        for i in range(1, 81):
            lines += [f"#{i * 0.25}", f"S,RadarAzimuth={((i * 15 + 180) % 360) - 180}"]
        pb = RecordingStore.playback(parse_lines(lines))
        rd = pb["objects"]["S"]["radar"]
        self.assertIn("t", rd)
        self.assertEqual(len(rd["t"]), len(rd["az"]))
        steps = [b - a for a, b in zip(rd["t"], rd["t"][1:])]
        self.assertLessEqual(max(steps), 0.5 + 1e-6)
        # Consecutive samples turn the same way (clockwise), never 60 deg back.
        turns = [((b - a + 180) % 360) - 180 for a, b in zip(rd["az"][1:], rd["az"][2:])]
        self.assertTrue(all(x > 0 for x in turns), turns[:10])


class TriggerFallback(unittest.TestCase):
    def test_trigger_only_burst(self):
        rec = parse_lines(["FileType=text/acmi/tacview", "FileVersion=2.2", "#0",
                           "1,T=41|41|1000,Type=Air+FixedWing,Name=F-16C_50,TriggerPressed=0",
                           "#1", "1,TriggerPressed=1", "#2.5", "1,TriggerPressed=0", "#3", "1,T=41.01|41|1000"])
        rep = analyze_weapons(rec)
        self.assertEqual([(b.source, b.start, b.end) for b in rep.bursts], [("trigger", 1.0, 2.5)])


if __name__ == "__main__":
    unittest.main()
