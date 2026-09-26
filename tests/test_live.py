import json
import socket
import threading
import time
import unittest
import urllib.request
from pathlib import Path

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


class _TempSettings:
    """Keep the tests away from the real Documents/DCS-SA/settings.json."""

    def setUp(self):
        import tempfile
        from unittest import mock

        from dcs_sa import usersettings

        self._tmp = tempfile.TemporaryDirectory()
        self.settings_path = Path(self._tmp.name) / "settings.json"
        patcher = mock.patch.object(usersettings, "PATH", self.settings_path)
        patcher.start()
        self.addCleanup(patcher.stop)
        self.addCleanup(self._tmp.cleanup)


class ServerTests(_TempSettings, unittest.TestCase):
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
            key = next(r["key"] for r in recs if r["sample"] and r["name"] == "sample_sortie.acmi")
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

            for bad in ("../../etc", "0123456789abcdef"):
                with self.assertRaises(urllib.error.HTTPError) as ctx:
                    post("/api/open-debrief", {"key": bad})
                self.assertEqual(ctx.exception.code, 404)
            self.assertEqual(post("/api/open-debrief", {"key": key}), {"ok": False})  # no desktop window
            self.assertEqual(post("/api/open-debrief", {}), {"ok": False})
            opened = []
            app.open_debrief = opened.append
            self.assertEqual(post("/api/open-debrief", {"key": key}), {"ok": True})
            # No key: a second launch asking the running copy to show its window.
            self.assertEqual(post("/api/open-debrief", {"key": ""}), {"ok": True})
            self.assertEqual(opened, [key, None])
            # Another website open in the browser must not drive the app.
            for headers in ({"Origin": "https://evil.example"}, {"Origin": "null"},
                            {"Sec-Fetch-Site": "cross-site"}, {"Host": "rebind.evil.example"}):
                req = urllib.request.Request(url.rstrip("/") + "/api/player", data=b'{"names": ["x"]}',
                                             headers=headers, method="POST")
                with self.assertRaises(urllib.error.HTTPError) as ctx:
                    urllib.request.urlopen(req, timeout=5)
                self.assertEqual(ctx.exception.code, 403, headers)
            port = url.rstrip("/").rsplit(":", 1)[1]
            for origin in (f"http://127.0.0.1:{port}", f"http://localhost:{port}"):
                host = origin.split("//")[1]
                req = urllib.request.Request(f"http://127.0.0.1:{port}/api/open-live", data=b"{}",
                                             headers={"Origin": origin, "Host": host, "Sec-Fetch-Site": "same-origin"},
                                             method="POST")
                self.assertEqual(json.loads(urllib.request.urlopen(req, timeout=5).read()), {"ok": False})
            html = urllib.request.urlopen(url, timeout=5).read()
            self.assertIn(b"review.js", html)
            self.assertIn(b"guide.js", urllib.request.urlopen(url + "guide", timeout=5).read())
            guide = urllib.request.urlopen(url + "api/guide", timeout=5).read().decode("utf-8")
            self.assertIn("## Step 3: Try it with a demo flight", guide)
            with self.assertRaises(urllib.error.HTTPError):
                urllib.request.urlopen(url + "static/../../dcs_sa/config.py", timeout=5)
        finally:
            stop(app, httpd)



class RememberedSettingsTests(_TempSettings, unittest.TestCase):
    def _start(self):
        from dcs_sa.config import Config
        from dcs_sa.server.app import start

        cfg = Config()
        cfg.port = 0
        cfg.bridge_enabled = False
        cfg.recording_dirs = []
        return start(cfg)

    def test_tacview_connection_and_pilot_name_are_remembered(self):
        from dcs_sa.server.app import stop

        def post(url, path, body):
            req = urllib.request.Request(url.rstrip("/") + path, data=json.dumps(body).encode(), method="POST")
            return json.loads(urllib.request.urlopen(req, timeout=5).read())

        app, httpd, url = self._start()
        try:
            self.assertIsNone(app.live.source_kind)  # nothing saved yet: no connection attempt
            post(url, "/api/live/source", {"type": "tacview", "host": "127.0.0.1", "port": 9, "password": "pw"})
            post(url, "/api/player", {"names": [" Viper 1-1 ", "Ethan", "Viper 1-1"]})
        finally:
            stop(app, httpd)
        saved = json.loads(self.settings_path.read_text())
        self.assertEqual(saved["tacview"], {"host": "127.0.0.1", "port": 9, "password": "pw", "autoconnect": True})
        self.assertEqual(saved["playerNames"], ["Viper 1-1", "Ethan"])

        app, httpd, url = self._start()  # next run
        try:
            self.assertEqual(app.live.source_kind, "tacview")
            self.assertEqual((app.cfg.tacview_host, app.cfg.tacview_port), ("127.0.0.1", 9))
            self.assertEqual(app.cfg.player_names[:2], ["Viper 1-1", "Ethan"])
            post(url, "/api/live/source", {"type": "none"})
        finally:
            stop(app, httpd)
        self.assertFalse(json.loads(self.settings_path.read_text())["tacview"]["autoconnect"])
        app, httpd, url = self._start()
        try:
            self.assertIsNone(app.live.source_kind)  # disconnected on purpose: stays off
        finally:
            stop(app, httpd)


class UpdateCheckTests(unittest.TestCase):
    def test_version_compare(self):
        from dcs_sa.update import is_newer, version_tuple

        self.assertEqual(version_tuple("v1.10.2"), (1, 10, 2))
        self.assertEqual(version_tuple("nonsense"), (0,))
        self.assertTrue(is_newer("v0.2.0", "0.1.0"))
        self.assertTrue(is_newer("1.10.0", "1.9.0"))       # not a string compare
        self.assertFalse(is_newer("0.1.0", "0.1.0"))
        self.assertFalse(is_newer("0.0.9", "0.1.0"))

    def test_offline_is_quiet(self):
        from dcs_sa.update import UpdateChecker, fetch_latest

        # Unreachable host: no exception, no claim of an update.
        self.assertEqual(fetch_latest("http://127.0.0.1:9/none"), {})
        c = UpdateChecker(enabled=False)
        st = c.status()
        self.assertFalse(st["available"])
        self.assertFalse(st["enabled"])
        self.assertEqual(st["current"], __import__("dcs_sa").__version__)

    def test_a_newer_release_is_reported(self):
        import threading

        from dcs_sa import update as up

        release = {"tag_name": "v9.9.9", "html_url": "https://github.com/x/y/releases/tag/v9.9.9",
                   "assets": [{"name": "DCS-SA.exe", "browser_download_url": "https://e/1"},
                              {"name": "DCS-SA-Setup.exe", "browser_download_url": "https://e/2"}]}
        c = up.UpdateChecker(enabled=True)
        real, done = up.fetch_latest, threading.Event()
        up.fetch_latest = lambda *a, **k: release
        try:
            c.status()
            for _ in range(100):
                st = c.status()
                if st.get("checked"):
                    break
                done.wait(0.05)
        finally:
            up.fetch_latest = real
        self.assertTrue(st["available"])
        self.assertEqual(st["latest"], "9.9.9")
        self.assertEqual(st["download"], "https://e/2")  # the installer, not the loose exe


class BuildVersionTests(unittest.TestCase):
    """packaging/build_version.py: what CI stamps into each build."""

    def setUp(self):
        import importlib.util

        spec = importlib.util.spec_from_file_location(
            "build_version", Path(__file__).resolve().parent.parent / "packaging" / "build_version.py")
        self.bv = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(self.bv)

    def test_run_number_becomes_the_patch(self):
        src = '__version__ = "0.1.0"\n'
        self.assertEqual(self.bv.build_version(src, "47"), "0.1.47")
        self.assertEqual(self.bv.build_version('__version__ = "2.10.3"\n', "5"), "2.10.5")

    def test_a_tag_wins_over_the_run_number(self):
        self.assertEqual(self.bv.build_version('__version__ = "0.1.0"\n', "47", "v1.2.3"), "1.2.3")

    def test_versions_only_ever_go_up(self):
        from dcs_sa.update import is_newer

        src = '__version__ = "0.1.0"\n'
        seq = [self.bv.build_version(src, str(n)) for n in (46, 47, 48)]
        self.assertTrue(all(is_newer(b, a) for a, b in zip(seq, seq[1:])), seq)
        # A later minor keeps rising even though the run number carries on.
        self.assertTrue(is_newer(self.bv.build_version('__version__ = "0.2.0"\n', "49"), seq[-1]))

    def test_a_build_does_not_think_itself_out_of_date(self):
        from dcs_sa.update import is_newer

        # What CI publishes as the tag is what the build reports as its version.
        released = self.bv.build_version('__version__ = "0.1.0"\n', "47")
        self.assertFalse(is_newer(released, released))

    def test_the_stamp_is_written_back(self):
        import shutil
        import subprocess
        import sys
        import tempfile

        root = Path(__file__).resolve().parent.parent
        with tempfile.TemporaryDirectory() as d:
            copy = Path(d) / "repo"
            (copy / "packaging").mkdir(parents=True)
            (copy / "dcs_sa").mkdir()
            shutil.copy(root / "packaging" / "build_version.py", copy / "packaging")
            (copy / "dcs_sa" / "__init__.py").write_text('"""doc."""\n\n__version__ = "0.1.0"\n')
            out = subprocess.run([sys.executable, "packaging/build_version.py", "47"],
                                 cwd=copy, capture_output=True, text=True, check=True)
            self.assertEqual(out.stdout.strip(), "0.1.47")
            text = (copy / "dcs_sa" / "__init__.py").read_text()
            self.assertIn('__version__ = "0.1.47"', text)
            self.assertIn('"""doc."""', text)   # nothing else touched

    def test_a_tag_build_leaves_the_source_alone(self):
        import shutil
        import subprocess
        import sys
        import tempfile

        root = Path(__file__).resolve().parent.parent
        with tempfile.TemporaryDirectory() as d:
            copy = Path(d) / "repo"
            (copy / "packaging").mkdir(parents=True)
            (copy / "dcs_sa").mkdir()
            shutil.copy(root / "packaging" / "build_version.py", copy / "packaging")
            (copy / "dcs_sa" / "__init__.py").write_text('__version__ = "0.1.0"\n')
            out = subprocess.run([sys.executable, "packaging/build_version.py", "47", "v9.9.9"],
                                 cwd=copy, capture_output=True, text=True, check=True)
            self.assertEqual(out.stdout.strip(), "9.9.9")
            self.assertIn('__version__ = "0.1.0"', (copy / "dcs_sa" / "__init__.py").read_text())


class ConsoleTests(unittest.TestCase):
    """The diagnostics buffer behind the console panel."""

    def test_keeps_the_newest_and_counts_problems(self):
        from dcs_sa.diagnostics import ConsoleBuffer

        c = ConsoleBuffer(capacity=3)
        for i in range(5):
            c.add("INFO", f"line {i}")
        c.add("WARNING", "careful")
        c.add("ERROR", "broken")
        rows = c.entries()
        self.assertEqual([r["message"] for r in rows], ["line 4", "careful", "broken"])
        self.assertEqual(c.counts()["warnings"], 1)
        self.assertEqual(c.counts()["errors"], 1)
        self.assertEqual([r["seq"] for r in rows], [5, 6, 7])   # numbering survives the drop

    def test_since_returns_only_what_is_new(self):
        from dcs_sa.diagnostics import ConsoleBuffer

        c = ConsoleBuffer()
        c.add("INFO", "one")
        first = c.entries()[-1]["seq"]
        self.assertEqual(c.entries(since=first), [])
        c.add("INFO", "two")
        self.assertEqual([r["message"] for r in c.entries(since=first)], ["two"])

    def test_it_captures_the_app_s_own_logging(self):
        import logging

        from dcs_sa.diagnostics import ConsoleBuffer

        c = ConsoleBuffer()
        logger = logging.getLogger("dcs_sa.test_only")
        logger.addHandler(c)
        logger.setLevel(logging.INFO)
        try:
            logger.info("bridge: receiving")
            logger.debug("too quiet to show")
            logger.warning("port busy")
        finally:
            logger.removeHandler(c)
        rows = c.entries()
        self.assertEqual([r["message"] for r in rows], ["bridge: receiving", "port busy"])
        self.assertEqual(rows[0]["source"], "test_only")   # the dcs_sa. prefix is dropped
        self.assertEqual(rows[1]["level"], "WARNING")

    def test_a_broken_log_call_never_raises_into_the_app(self):
        import logging

        from dcs_sa.diagnostics import ConsoleBuffer

        c = ConsoleBuffer()
        rec = logging.LogRecord("x", logging.INFO, __file__, 1, "%d apples", ("not a number",), None)
        c.emit(rec)   # must not raise
        self.assertIn("unprintable", c.entries()[-1]["message"])

    def test_the_api_serves_and_accepts_entries(self):
        from dcs_sa.config import Config
        from dcs_sa.diagnostics import console
        from dcs_sa.server.app import start, stop

        console.clear()
        cfg = Config()
        cfg.port = 0
        cfg.bridge_enabled = False
        cfg.recording_dirs = []
        app, httpd, url = start(cfg)
        try:
            got = json.loads(urllib.request.urlopen(url + "api/console", timeout=5).read())
            self.assertTrue(any("starting" in e["message"] for e in got["entries"]), got["entries"])
            # A page reporting its own error lands in the same buffer.
            req = urllib.request.Request(url + "api/console", method="POST",
                                         data=json.dumps({"level": "ERROR", "message": "page blew up"}).encode())
            urllib.request.urlopen(req, timeout=5)
            after = json.loads(urllib.request.urlopen(url + "api/console", timeout=5).read())
            self.assertEqual(after["entries"][-1]["message"], "page blew up")
            self.assertEqual(after["entries"][-1]["source"], "page")
            self.assertEqual(after["errors"], 1)
            # An unknown level is refused rather than stored.
            bad = urllib.request.Request(url + "api/console", method="POST",
                                         data=json.dumps({"level": "SHOUT", "message": "x"}).encode())
            with self.assertRaises(urllib.error.HTTPError) as ctx:
                urllib.request.urlopen(bad, timeout=5)
            self.assertEqual(ctx.exception.code, 400)
        finally:
            stop(app, httpd)
            console.clear()


class PausedMissionTests(unittest.TestCase):
    """DCS stops exporting while paused; the map must not follow a frozen jet."""

    def _world(self):
        w = LiveWorld(["Ethan"])
        w.set_status("tacview", "connected")
        w.on_frame(0.0)     # a frame is what marks the stream as alive
        w.on_object(0.0, "101", {"Longitude": 41.0, "Latitude": 41.0, "Altitude": 3000, "Yaw": 90},
                    {"Type": "Air+FixedWing", "Coalition": "Allies", "Pilot": "Ethan", "Name": "F-16C_50"})
        return w

    def _bridge(self, lon, lat, ias=300.0):
        return {"t": 10.0, "self": {"lon": lon, "lat": lat, "alt": 3000.0, "hdg": 90.0,
                                    "ias": ias, "pilot": "Ethan", "name": "F-16C_50"}}

    def test_a_live_stream_still_wins(self):
        w = self._world()
        w.ingest_bridge(self._bridge(41.5, 41.5))
        pos = w.objects["101"].position()
        self.assertAlmostEqual(pos[0], 41.0, places=3)   # Tacview is fresh, so it decides

    def test_a_quiet_stream_hands_over_to_the_bridge(self):
        w = self._world()
        w.wall_updated = time.time() - 30.0     # DCS paused: nothing on the stream for a while
        w.ingest_bridge(self._bridge(41.5, 41.5))
        pos = w.objects["101"].position()
        self.assertAlmostEqual(pos[0], 41.5, places=3)
        self.assertAlmostEqual(pos[1], 41.5, places=3)
        self.assertAlmostEqual(w.objects["101"].values["IAS"], 300.0)

    def test_a_stream_that_has_said_nothing_yet_does_not_hold_the_map_hostage(self):
        w = LiveWorld(["Ethan"])
        w.set_status("tacview", "connected")   # connected, but no frame has arrived
        w.on_object(0.0, "101", {"Longitude": 41.0, "Latitude": 41.0, "Altitude": 3000, "Yaw": 90},
                    {"Type": "Air+FixedWing", "Coalition": "Allies", "Pilot": "Ethan", "Name": "F-16C_50"})
        w.ingest_bridge(self._bridge(41.5, 41.5))
        self.assertAlmostEqual(w.objects["101"].position()[0], 41.5, places=3)

    def test_the_rest_of_the_picture_is_left_alone(self):
        w = self._world()
        w.on_object(0.0, "201", {"Longitude": 42.0, "Latitude": 42.0, "Altitude": 6000},
                    {"Type": "Air+FixedWing", "Coalition": "Enemies"})
        w.wall_updated = time.time() - 30.0
        w.ingest_bridge(self._bridge(41.5, 41.5))
        # Only my jet moves; a frozen bandit is better than an invented one.
        self.assertAlmostEqual(w.objects["201"].position()[0], 42.0, places=3)

    def test_the_stream_takes_over_again_when_it_resumes(self):
        w = self._world()
        w.wall_updated = time.time() - 30.0
        w.ingest_bridge(self._bridge(41.5, 41.5))
        w.on_frame(20.0)    # the mission is running again
        w.on_object(20.0, "101", {"Longitude": 41.9, "Latitude": 41.9, "Altitude": 3000, "Yaw": 90}, {})
        w.ingest_bridge(self._bridge(41.6, 41.6))
        self.assertAlmostEqual(w.objects["101"].position()[0], 41.9, places=3)

    def test_with_no_stream_at_all_the_bridge_still_builds_the_picture(self):
        w = LiveWorld(["Ethan"])
        w.ingest_bridge(self._bridge(41.2, 41.2))
        self.assertIn("self", w.objects)


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
