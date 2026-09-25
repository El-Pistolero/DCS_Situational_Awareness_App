import json
import socket
import tempfile
import unittest

from dcs_sa.dcsmap import DcsMapStore


class DcsMapStoreTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        # Point requests at a socket we control, standing in for the DCS hook.
        self.hook = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
        self.hook.bind(("127.0.0.1", 0))
        self.hook.settimeout(2)
        self.store = DcsMapStore(self.tmp.name, hook_port=self.hook.getsockname()[1])

    def tearDown(self):
        self.hook.close()
        self.tmp.cleanup()

    def test_no_requests_without_a_running_mission(self):
        self.assertIsNone(self.store.get_tile(11, 1260, 757))
        self.assertFalse(self.store.is_pending(11, 1260, 757))

    def test_request_cache_and_serve(self):
        self.store.on_packet({"type": "dcs-hook", "mission": True, "theatre": "Caucasus"})
        self.assertEqual(json.loads(self.hook.recv(4096))["op"], "airbases")
        self.assertIsNone(self.store.get_tile(11, 1260, 757))
        req = json.loads(self.hook.recv(4096))
        self.assertEqual((req["op"], req["z"], req["x"], req["y"]), ("tile", 11, 1260, 757))
        self.assertTrue(self.store.is_pending(11, 1260, 757))
        n = req["n"]
        self.store.on_packet({"type": "terrain", "ok": True, "z": 11, "x": 1260, "y": 757, "n": n,
                              "h": [5] * (n * n), "s": "3" * (n * n)})
        tile = self.store.get_tile(11, 1260, 757)
        self.assertEqual((tile["n"], tile["theatre"], tile["s"][0]), (n, "Caucasus", "3"))
        # Survives a restart (cache on disk), even with DCS closed.
        again = DcsMapStore(self.tmp.name, hook_port=self.hook.getsockname()[1])
        self.assertIsNotNone(again.get_tile(11, 1260, 757))

    def test_malformed_tile_rejected(self):
        self.store.on_packet({"type": "terrain", "ok": True, "z": 11, "x": 1, "y": 1, "n": 41, "h": [1, 2], "s": "11"})
        self.assertIsNone(self.store.get_tile(11, 1, 1))

    def test_airbase_runway_heading(self):
        self.store.on_packet({"type": "airbases", "ok": True, "theatre": "Caucasus", "airbases": [
            {"name": "Batumi", "category": 0, "lat": 41.61, "lon": 41.6, "alt": 10,
             "runways": [{"name": "13", "lat": 41.61, "lon": 41.6, "course": -2.19911, "length": 2400, "width": 60}]}]})
        ab = self.store.airbases_near(41.6, 41.6)[0]
        self.assertAlmostEqual(ab["runways"][0]["heading"], 126.0, delta=0.1)
        self.assertEqual(self.store.airbases_near(0, 0), [])

    def test_unrelated_packets_pass_through(self):
        self.assertFalse(self.store.on_packet({"v": 1, "self": {}}))


if __name__ == "__main__":
    unittest.main()
