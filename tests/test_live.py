import json
import socket
import threading
import time
import unittest
import urllib.request

from dcs_sa.acmi.model import Event
from dcs_sa.telemetry.live_world import LiveWorld
from dcs_sa.telemetry.realtime import RealtimeTelemetryClient, crc64_we, hash_password


class HashTests(unittest.TestCase):
    def test_crc64_we_check_value(self):
        self.assertEqual(crc64_we(b"123456789"), 0x62EC59E3F1A4F00A)

    def test_empty_password_is_zero(self):
        self.assertEqual(hash_password(""), "0")


class FakeTacviewHost:
    """Minimal real-time telemetry host: handshake, then a few ACMI lines."""

    def __init__(self, lines):
        self.lines = lines
        self.sock = socket.socket()
        self.sock.bind(("127.0.0.1", 0))
        self.sock.listen(1)
        self.port = self.sock.getsockname()[1]
        self.client_handshake = b""
        threading.Thread(target=self._serve, daemon=True).start()

    def _serve(self):
        conn, _ = self.sock.accept()
        conn.sendall(b"XtraLib.Stream.0\nTacview.RealTimeTelemetry.0\nTest Host\n\0")
        while b"\0" not in self.client_handshake:
            self.client_handshake += conn.recv(1)
        for line in self.lines:
            conn.sendall(line.encode() + b"\n")
        time.sleep(1.0)
        conn.close()


class RealtimeClientTests(unittest.TestCase):
    def test_handshake_and_stream(self):
        host = FakeTacviewHost([
            "FileType=text/acmi/tacview", "FileVersion=2.2",
            "0,ReferenceLongitude=41", "0,ReferenceLatitude=41",
            "#0", "101,T=0.5|0.5|3000|0|0|90,Type=Air+FixedWing,Name=F-16C,Pilot=Ethan,Coalition=Allies",
            "201,T=0.6|0.5|3000|0|0|270,Type=Air+FixedWing,Name=MiG-29,Coalition=Enemies,LockedTarget=101,LockedTargetMode=1",
            "#1", "0,Event=Message|101|hello",
        ])
        world = LiveWorld(["Ethan"])
        client = RealtimeTelemetryClient(world, port=host.port, client_name="tester",
                                         on_status=lambda s, d: world.set_status("tacview", s, d))
        client.start()
        deadline = time.time() + 5
        while time.time() < deadline and len(world.events) < 1:
            time.sleep(0.05)
        client.stop()
        self.assertIn(b"Tacview.RealTimeTelemetry.0\ntester\n0\0", host.client_handshake)
        snap = world.snapshot()
        self.assertEqual(snap["focus"], "101")
        self.assertEqual({o["id"] for o in snap["objects"]}, {"101", "201"})
        self.assertAlmostEqual(next(o for o in snap["objects"] if o["id"] == "101")["lon"], 41.5)
        spikes = [t for t in snap["threats"] if t.get("spike")]
        self.assertEqual(spikes[0]["id"], "201")
        self.assertEqual(snap["events"][0]["text"], "hello")
        json.dumps(snap, allow_nan=False)


class LiveWorldTests(unittest.TestCase):
    def test_inbound_missile_threat_with_time_to_impact(self):
        w = LiveWorld()
        w.on_object(0, "1", {"Longitude": 41.0, "Latitude": 41.0, "Altitude": 5000, "Yaw": 0}, {"Type": "Air+FixedWing", "Coalition": "Allies"})
        w.on_object(0, "2", {"Longitude": 41.0, "Latitude": 41.3, "Altitude": 5000}, {"Type": "Air+FixedWing", "Coalition": "Enemies"})
        for i, t in enumerate((0.0, 1.0)):
            w.on_object(t, "1", {"Latitude": 41.0 + i * 0.001}, {})
            w.on_object(t, "M", {"Longitude": 41.0, "Latitude": 41.2 - i * 0.008, "Altitude": 5000, "Yaw": 180},
                        {"Type": "Weapon+Missile", "Parent": "2", "Coalition": "Enemies"})
        missile = next(t for t in w.snapshot()["threats"] if t["kind"] == "missile")
        self.assertEqual(missile["clock"], 12)
        self.assertGreater(missile["tti"], 0)

    def test_bridge_only_mode_synthesises_ownship(self):
        w = LiveWorld()
        w.ingest_bridge({"t": 1, "self": {"lat": 41.6, "lon": 41.6, "alt": 1000, "hdg": 90, "name": "F-16C_50"}})
        snap = w.snapshot()
        self.assertEqual(snap["focus"], "self")
        self.assertIsNotNone(snap["ownship"])

    def test_scan_zone_stays_on_own_jet_when_focus_moves(self):
        w = LiveWorld()
        w.set_status("tacview", "connected")
        w.on_object(0, "A", {"Longitude": 41.6, "Latitude": 41.6, "Altitude": 5000, "Yaw": 90},
                    {"Type": "Air+FixedWing", "Name": "F-16C_50", "Pilot": "Ethan", "Coalition": "Allies"})
        w.on_object(0, "B", {"Longitude": 41.7, "Latitude": 41.7, "Altitude": 6000, "Yaw": 270},
                    {"Type": "Air+FixedWing", "Name": "MiG-29S", "Pilot": "Ivanov", "Coalition": "Enemies"})
        w.ingest_bridge({"t": 1, "self": {"lat": 41.6, "lon": 41.6, "alt": 5000, "pilot": "Ethan", "name": "F-16C_50"},
                         "scan": {"on": True, "azHalf": 30.0, "elHalf": 4.0}})
        w.set_focus("B")
        snap = w.snapshot()
        rows = {o["id"]: o for o in snap["objects"]}
        self.assertEqual(snap["ownId"], "A")
        self.assertIn("ScanAz", rows["A"]["v"])
        self.assertNotIn("ScanAz", rows["B"]["v"])

    def test_aaa_far_below_is_not_in_wez(self):
        w = LiveWorld()
        w.on_object(0, "A", {"Longitude": 41.6, "Latitude": 41.6, "Altitude": 9000, "Yaw": 90},
                    {"Type": "Air+FixedWing", "Name": "F-16C_50", "Coalition": "Allies"})
        w.on_object(0, "S", {"Longitude": 41.6, "Latitude": 41.601, "Altitude": 100},
                    {"Type": "Ground+AntiAircraft", "Name": "ZSU-23-4 Shilka", "Coalition": "Enemies"})
        w.set_focus("A")
        self.assertNotIn("S", {t["id"] for t in w.snapshot()["threats"]})
        w.on_object(1, "A", {"Altitude": 1500}, {})
        self.assertIn("S", {t["id"] for t in w.snapshot()["threats"]})

    def test_collapsed_hits_without_weapon_have_no_empty_brackets(self):
        w = LiveWorld()
        ev = {"kind": "hit", "t": 1.0, "initiator": {"name": "SAM1"}, "target": {"name": "Viper"}, "weapon": ""}
        w.on_dcs_events([ev, {**ev, "t": 1.5}])
        self.assertEqual(w.events[-1]["text"], "SAM1 hit Viper x2")

    def test_event_kept(self):
        w = LiveWorld()
        w.on_event(Event(1.0, "Destroyed", ["5"], ""))
        self.assertEqual(w.snapshot()["events"][0]["kind"], "Destroyed")


class ServerTests(unittest.TestCase):
    def test_api_smoke(self):
        from dcs_sa.config import Config
        from dcs_sa.server.app import start, stop

        cfg = Config()
        cfg.port = 0
        cfg.bridge_enabled = False
        cfg.recording_dirs = []
        app, httpd, url = start(cfg)
        try:
            get = lambda p: json.loads(urllib.request.urlopen(url.rstrip("/") + p, timeout=10).read())
            recs = get("/api/recordings")["recordings"]
            key = next(r["key"] for r in recs if r["sample"])
            deadline = time.time() + 20
            while get(f"/api/recording/{key}/load")["state"] != "ready" and time.time() < deadline:
                time.sleep(0.1)
            analysis = get(f"/api/recording/{key}/analysis")
            self.assertEqual(analysis["player"], "101")
            self.assertIn("101", get(f"/api/recording/{key}/playback")["objects"])
            summary = get(f"/api/recording/{key}/summary")
            self.assertEqual(summary["aircraftCount"], 3)
            self.assertAlmostEqual(summary["duration"], 595.0, delta=1)

            def post(path, body):
                req = urllib.request.Request(url.rstrip("/") + path, data=json.dumps(body).encode(), method="POST")
                return json.loads(urllib.request.urlopen(req, timeout=5).read())

            for bad in ("../../etc", "0123456789abcdef", ""):
                with self.assertRaises(urllib.error.HTTPError) as ctx:
                    post("/api/open-debrief", {"key": bad})
                self.assertEqual(ctx.exception.code, 404)
            self.assertEqual(post("/api/open-debrief", {"key": key}), {"ok": False})  # no desktop window
            opened = []
            app.open_debrief = opened.append
            self.assertEqual(post("/api/open-debrief", {"key": key}), {"ok": True})
            self.assertEqual(opened, [key])
            html = urllib.request.urlopen(url, timeout=5).read()
            self.assertIn(b"review.js", html)
            with self.assertRaises(urllib.error.HTTPError):
                urllib.request.urlopen(url + "static/../../dcs_sa/config.py", timeout=5)
        finally:
            stop(app, httpd)



class LiveSessionTests(unittest.TestCase):
    def test_reset_starts_a_new_session(self):
        w = LiveWorld()
        w.on_event(Event(1.0, "Message", [], "old"))
        first = w.snapshot()["session"]
        w.reset()
        snap = w.snapshot()
        self.assertEqual(snap["session"], first + 1)
        self.assertEqual(snap["events"], [])

    def test_rounds_listed_separately_and_not_threats(self):
        w = LiveWorld()
        w.on_object(0, "1", {"Longitude": 41.0, "Latitude": 41.0, "Altitude": 1000, "Yaw": 0}, {"Type": "Air+FixedWing", "Coalition": "Allies"})
        w.on_object(0, "E", {"Longitude": 41.0, "Latitude": 41.05, "Altitude": 1000}, {"Type": "Air+FixedWing", "Coalition": "Enemies"})
        for t in (0.0, 0.25):
            w.on_object(t, "R", {"Longitude": 41.0, "Latitude": 41.04 - t * 0.01, "Altitude": 1000}, {"Type": "Projectile+Bullet", "Coalition": "Enemies"})
        snap = w.snapshot()
        self.assertEqual([r["id"] for r in snap["rounds"]], ["R"])
        self.assertEqual(len(snap["rounds"][0]["trail"]), 2)
        self.assertNotIn("R", {o["id"] for o in snap["objects"]})
        self.assertNotIn("R", {t["id"] for t in snap["threats"]})


if __name__ == "__main__":
    unittest.main()
