"""Live view air-to-ground data: own weapons in flight, bomblets, DCS event positions."""

import json
import math
import unittest

from dcs_sa.analysis import geo
from dcs_sa.telemetry.live_world import LiveWorld

LON0, LAT0 = 41.6, 41.6
G = 9.80665
F16 = {"Type": "Air+FixedWing", "Name": "F-16C_50", "Pilot": "Ethan", "Coalition": "Allies"}


def _pos(lon, lat, alt, **extra):
    return {"Longitude": lon, "Latitude": lat, "Altitude": alt, **extra}


def _unit(w, oid, name, coalition, lon, lat, alt=150.0):
    w.on_object(0.0, oid, _pos(lon, lat, alt), {"Type": "Ground+Vehicle", "Name": name, "Coalition": coalition})


def _mine(w, wid):
    return next((e for e in w.snapshot()["myWeapons"] if e["id"] == wid), None)


class JsowGlide:
    """An F-16 level at 7,500 m releases a JSOW that glides east at 240 m/s, 24 m/s down."""

    RELEASE, END, GS, VS = 5.0, 8.0, 240.0, -24.0

    def __init__(self):
        self.w = w = LiveWorld(["Ethan"])
        self.jet = (LON0, LAT0)
        t = 0.0
        while t < self.RELEASE:
            w.on_frame(t)
            self._jet(t, 90.0)
            t += 0.5
        self.rel = geo.destination(*self.jet, 90.0, 125.0)  # where the jet is at release
        # Where the glide from the last fed state reaches 150 m.
        self.w_end = geo.destination(*self.rel, 90.0, self.GS * (self.END - self.RELEASE))
        alt_end = 7497.0 + self.VS * (self.END - self.RELEASE)
        self.impact = geo.destination(*self.w_end, 90.0, (alt_end - 150.0) / (-self.VS / self.GS))
        _unit(w, "601", "Ural-375", "Enemies", *geo.destination(*self.impact, 0.0, 300.0))
        _unit(w, "602", "BMP-2", "Enemies", *geo.destination(*self.impact, 180.0, 1200.0))
        _unit(w, "603", "M-1 Abrams", "Allies", *geo.destination(*self.impact, 90.0, 100.0))
        t = self.RELEASE
        while t <= self.END:
            w.on_frame(t)
            # The weapon's frame first: its launcher's position is dead-reckoned.
            self.jsow(t)
            self._jet(t, 90.0 if t == self.RELEASE else 0.0)  # then turns away north
            t += 0.25

    def _jet(self, t, hdg):
        if t > 0:
            self.jet = geo.destination(*self.jet, hdg, 250.0 * 0.5 if t <= self.RELEASE else 250.0 * 0.25)
        self.w.on_object(t, "101", _pos(*self.jet, 7500.0, Yaw=hdg, TAS=250.0), F16)

    def jsow(self, t, oid="3002", name="AGM_154A", **text):
        lon, lat = geo.destination(*self.rel, 90.0, self.GS * (t - self.RELEASE))
        self.w.on_object(t, oid, _pos(lon, lat, 7497.0 + self.VS * (t - self.RELEASE), Yaw=90.0),
                         {"Type": "Weapon+Bomb", "Name": name, "Coalition": "Allies", **text})


class MyWeaponsTests(unittest.TestCase):
    def test_gliding_jsow_is_mine_with_tti_and_target(self):
        s = JsowGlide()
        snap = s.w.snapshot()
        json.dumps(snap, allow_nan=False)
        [e] = snap["myWeapons"]
        self.assertEqual((e["id"], e["family"], e["releasedAt"]), ("3002", "jsow", JsowGlide.RELEASE))
        self.assertTrue(e["estimated"])
        self.assertFalse(e["impacted"])
        self.assertAlmostEqual(e["gs"], JsowGlide.GS, delta=2.0)
        self.assertAlmostEqual(e["vs"], JsowGlide.VS, delta=0.5)
        self.assertEqual(e["impactAlt"], 150.0)  # the ground units' altitude, not 0
        # Constant ground speed along the glide: tti is the distance over gs.
        dist = geo.ground_distance(*s.w_end, e["impactLon"], e["impactLat"])
        self.assertAlmostEqual(e["tti"], dist / e["gs"], delta=0.02 * e["tti"])
        self.assertAlmostEqual(e["tti"], geo.ground_distance(*s.w_end, *s.impact) / JsowGlide.GS, delta=0.03 * e["tti"])
        self.assertLess(geo.ground_distance(e["impactLon"], e["impactLat"], *s.impact), 400.0)
        # Nearest hostile: the Ural, not the closer friendly tank or the farther BMP.
        self.assertEqual((e["targetId"], e["targetName"]), ("601", "Ural-375"))
        # Ownership was decided at release: the jet has since turned away.
        jet = next(o for o in snap["objects"] if o["id"] == "101")
        self.assertGreater(geo.ground_distance(jet["lon"], jet["lat"], *s.w_end), 600.0)

    def test_first_frame_has_no_estimate(self):
        s = JsowGlide()
        s.w.on_frame(JsowGlide.END)
        s.jsow(JsowGlide.END, "3003", "AGM_154C", Parent="101")
        e = _mine(s.w, "3003")
        self.assertIsNotNone(e)
        self.assertIsNone(e["tti"])
        self.assertIsNone(e["impactLon"])
        self.assertIsNone(e["targetId"])

    def test_dive_bomb_ballistic_tti(self):
        w = LiveWorld(["Ethan"])
        dive, v, z0, ground = math.radians(30.0), 250.0, 3000.0, 200.0
        vx, vz = v * math.cos(dive), -v * math.sin(dive)

        def jet(t):
            lon, lat = geo.destination(LON0, LAT0, 90.0, vx * t)
            z = z0 + vz * t
            # AGL from the jet: no ground units, so this sets the aim altitude.
            w.on_object(t, "101", _pos(lon, lat, z, Yaw=90.0, Pitch=-30.0, AGL=z - ground), F16)
            return lon, lat, z

        rel = None
        for i in range(9):  # 0 .. 2 s
            w.on_frame(i * 0.25)
            rel = jet(i * 0.25)
        t_rel, tau = 2.0, 0.0
        while tau <= 1.0:
            w.on_frame(t_rel + tau)
            lon, lat = geo.destination(rel[0], rel[1], 90.0, vx * tau)
            w.on_object(t_rel + tau, "3128", _pos(lon, lat, rel[2] + vz * tau - 0.5 * G * tau * tau),
                        {"Type": "Weapon+Bomb", "Name": "Mk_82", "Parent": "101", "Coalition": "Allies"})
            jet(t_rel + tau)
            tau += 0.25
        tau -= 0.25
        # Analytic vacuum fall from release to the ground.
        h = rel[2] - ground
        t_fall = (vz + math.sqrt(vz * vz + 2 * G * h)) / G
        remaining = t_fall - tau
        e = _mine(w, "3128")
        self.assertEqual(e["family"], "gp-bomb")
        self.assertAlmostEqual(e["impactAlt"], ground, places=3)
        self.assertAlmostEqual(e["tti"], remaining, delta=0.15 * remaining)
        range_true = vx * t_fall
        range_est = geo.ground_distance(rel[0], rel[1], e["impactLon"], e["impactLat"])
        self.assertAlmostEqual(range_est, range_true, delta=0.15 * range_true)

        # Falls to the ground and is removed: kept 5 s as impacted, then dropped.
        while rel[2] + vz * tau - 0.5 * G * tau * tau > ground:
            tau += 0.25
            w.on_frame(t_rel + tau)
            lon, lat = geo.destination(rel[0], rel[1], 90.0, vx * tau)
            w.on_object(t_rel + tau, "3128", _pos(lon, lat, max(ground, rel[2] + vz * tau - 0.5 * G * tau * tau)), {})
        t_gone = t_rel + tau
        w.on_remove(t_gone, "3128")
        self.assertNotIn("3128", w.launchers)
        w.on_frame(t_gone + 1.0)
        e = _mine(w, "3128")
        self.assertTrue(e["impacted"])
        self.assertEqual(e["tti"], 0.0)
        self.assertNotIn("dispensed", e)
        self.assertLess(geo.ground_distance(lon, lat, e["impactLon"], e["impactLat"]), 100.0)
        w.on_frame(t_gone + 4.9)
        self.assertIsNotNone(_mine(w, "3128"))
        w.on_frame(t_gone + 5.5)
        self.assertIsNone(_mine(w, "3128"))
        self.assertEqual(w.snapshot()["myWeapons"], [])

    def test_dispenser_opening_in_the_air(self):
        s = JsowGlide()
        s.w.on_remove(JsowGlide.END, "3002")
        s.w.on_frame(JsowGlide.END + 0.5)
        e = _mine(s.w, "3002")
        self.assertTrue(e["impacted"] and e["dispensed"])
        self.assertEqual(e["tti"], 0.0)
        self.assertLess(geo.ground_distance(*s.w_end, e["impactLon"], e["impactLat"]), 1.0)

    def test_unitary_jsow_vanishing_high_is_not_dispensed(self):
        # Plain AGM_154 is the JSOW-C: it never opens, so its impact stays predicted.
        s = JsowGlide()
        for t in (JsowGlide.END, JsowGlide.END + 0.25):
            s.w.on_frame(t)
            s.jsow(t, "3003", "AGM_154", Parent="101")
        s.w.on_remove(JsowGlide.END + 0.25, "3003")
        e = _mine(s.w, "3003")
        self.assertTrue(e["impacted"])
        self.assertNotIn("dispensed", e)
        self.assertGreater(geo.ground_distance(*s.w_end, e["impactLon"], e["impactLat"]), 10_000.0)

    def test_enemy_jet_nearby_does_not_claim_my_bomb(self):
        w = LiveWorld(["Ethan"])
        for t in (0.0, 0.5, 1.0):
            w.on_frame(t)
            w.on_object(t, "101", _pos(LON0, LAT0 + t * 0.002, 7500.0, Yaw=0.0), F16)
            # A bandit 200 m off, nearer to where the bomb appears than I am.
            w.on_object(t, "301", _pos(LON0 + 0.0024, LAT0 + t * 0.002 + 0.002, 7480.0, Yaw=0.0),
                        {"Type": "Air+FixedWing", "Name": "MiG-29S", "Coalition": "Enemies"})
        w.on_object(1.0, "5005", _pos(LON0 + 0.0012, LAT0 + 0.004, 7480.0),
                    {"Type": "Weapon+Bomb", "Name": "Mk_82", "Coalition": "Allies"})
        self.assertEqual(w.launchers["5005"], "101")
        self.assertEqual([e["id"] for e in w.snapshot()["myWeapons"]], ["5005"])

    def test_focused_sam_site_has_no_weapons(self):
        w = LiveWorld()
        _unit(w, "701", "SA-11 Buk LN 9A310M1", "Enemies", LON0, LAT0)
        w.set_focus("701")
        for t in (0.0, 0.5):
            w.on_frame(t)
            w.on_object(t, "3001", _pos(LON0, LAT0 + t * 0.005, 200.0 + t * 400.0),
                        {"Type": "Weapon+Missile", "Name": "SA9M38M1", "Parent": "701", "Coalition": "Enemies"})
        self.assertEqual(w.snapshot()["myWeapons"], [])

    def test_other_jets_weapons_are_not_mine(self):
        w = LiveWorld(["Ethan"])
        far = geo.destination(LON0, LAT0, 90.0, 50_000.0)
        for t in (0.0, 0.5, 1.0):
            w.on_frame(t)
            w.on_object(t, "101", _pos(LON0, LAT0 + t * 0.002, 7500.0, Yaw=0.0), F16)
            w.on_object(t, "201", _pos(far[0], far[1] + t * 0.002, 7000.0, Yaw=0.0),
                        {"Type": "Air+FixedWing", "Name": "FA-18C_hornet", "Pilot": "Wingman", "Coalition": "Allies"})
        bomb = {"Type": "Weapon+Bomb", "Name": "Mk_82", "Coalition": "Allies"}
        w.on_object(1.0, "5001", _pos(far[0], far[1] + 0.002, 6995.0), bomb)       # off the wingman
        w.on_object(1.0, "5002", _pos(LON0, LAT0 + 0.002, 7495.0), {**bomb, "Parent": "201"})  # Parent wins
        w.on_object(1.0, "5003", _pos(LON0, LAT0 + 0.002, 7495.0),
                    {"Type": "Weapon+Missile", "Name": "AIM_120C", "Parent": "101", "Coalition": "Allies"})
        w.on_object(1.0, "5004", _pos(LON0, LAT0 + 0.002, 7495.0), {**bomb, "Name": "GBU_12"})  # off me
        self.assertEqual([e["id"] for e in w.snapshot()["myWeapons"]], ["5004"])
        self.assertEqual(w.snapshot()["myWeapons"][0]["family"], "lgb")
        w.set_focus("201")
        self.assertEqual({e["id"] for e in w.snapshot()["myWeapons"]}, {"5001", "5002"})


class BombletTests(unittest.TestCase):
    def test_bomblets_flagged_and_capped(self):
        w = LiveWorld(["Ethan"])
        w.on_object(0.0, "101", _pos(LON0, LAT0, 3000.0, Yaw=90.0), F16)
        for i in range(200):
            t = 10.0 + i * 0.01
            lon, lat = geo.destination(LON0, LAT0, i * 1.8, 100.0)
            w.on_object(t, f"b{i}", _pos(lon, lat, 800.0, Yaw=270.0),
                        {"Type": "Weapon+Bomb", "Name": "BLU-97/B", "Coalition": "Enemies"})
        snap = w.snapshot()
        json.dumps(snap, allow_nan=False)
        subs = [o for o in snap["objects"] if o.get("sub")]
        self.assertEqual(len(subs), 150)
        self.assertEqual({o["id"] for o in subs}, {f"b{i}" for i in range(50, 200)})  # the newest
        self.assertFalse(any("trail" in o for o in subs))
        self.assertNotIn("sub", next(o for o in snap["objects"] if o["id"] == "101"))
        self.assertEqual(snap["myWeapons"], [])
        self.assertFalse(any(t["id"].startswith("b") for t in snap["threats"]))
        self.assertFalse(any(k.startswith("b") for k in w.launchers))

    def test_sd10_missile_is_not_a_bomblet(self):
        # "SD-10" is also a bomblet name; the missile must stay a threat with a trail.
        w = LiveWorld(["Ethan"])
        for t in (0.0, 0.5, 1.0):
            w.on_frame(t)
            w.on_object(t, "101", _pos(LON0, LAT0 + t * 0.002, 7500.0, Yaw=0.0), F16)
            w.on_object(t, "901", _pos(*geo.destination(LON0, LAT0, 0.0, 20_000.0 - t * 800.0), 7500.0, Yaw=180.0),
                        {"Type": "Weapon+Missile", "Name": "SD-10", "Coalition": "Enemies"})
        snap = w.snapshot()
        row = next(o for o in snap["objects"] if o["id"] == "901")
        self.assertNotIn("sub", row)
        self.assertIn("trail", row)
        self.assertEqual([(t["id"], t["text"]) for t in snap["threats"]], [("901", "MISSILE")])

    def test_name_alone_does_not_make_a_ground_unit_a_bomblet(self):
        w = LiveWorld()
        _unit(w, "702", "KB-1 bunker", "Enemies", LON0, LAT0)
        self.assertNotIn("sub", next(o for o in w.snapshot()["objects"] if o["id"] == "702"))


class DcsEventAndDestroyedTests(unittest.TestCase):
    def test_hit_and_kill_rows_carry_target_position(self):
        w = LiveWorld(["Ethan"])
        tgt = {"name": "Ural-375", "type": "Ural-375", "coalition": 1, "lat": 41.84, "lon": 42.05, "alt": 150.0}
        ini = {"name": "Viper", "player": "Ethan", "coalition": 2, "lat": None, "lon": None}
        w.on_dcs_events([
            {"kind": "hit", "t": 10.0, "initiator": ini, "target": tgt, "weapon": "BLU-97/B"},
            {"kind": "hit", "t": 10.5, "initiator": ini, "target": tgt, "weapon": "BLU-97/B"},
            {"kind": "kill", "t": 11.0, "initiator": ini, "target": {**tgt, "lat": None, "lon": None}, "weapon": "BLU-97/B"},
            {"kind": "shot", "t": 12.0, "initiator": ini, "target": tgt, "weapon": "Mk_82"},
        ])
        hit, kill, shot = w.snapshot()["events"]
        self.assertEqual(hit["count"], 2)  # still collapsed
        self.assertEqual((hit["targetLon"], hit["targetLat"]), (42.05, 41.84))
        self.assertNotIn("targetLon", kill)
        self.assertNotIn("targetLon", shot)

    def test_destroyed_rows_are_complete(self):
        w = LiveWorld()
        w.on_object(0.0, "601", _pos(42.05, 41.84, 150.0), {"Type": "Ground+Vehicle", "Name": "Ural-375", "Coalition": "Enemies"})
        w.on_remove(5.0, "601")
        [d] = w.snapshot()["destroyed"]
        self.assertEqual({k: d[k] for k in ("id", "name", "lon", "lat", "time", "coalition", "category")},
                         {"id": "601", "name": "Ural-375", "lon": 42.05, "lat": 41.84, "time": 5.0,
                          "coalition": "Enemies", "category": "ground"})


if __name__ == "__main__":
    unittest.main()
