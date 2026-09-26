import tempfile
import unittest
from pathlib import Path

from dcs_sa.dcs_profile import BRIDGE_NAME, HOOK_NAME, bridge_source, install_bridge, parse_logbook, refresh_bridge

LOGBOOK = '''logbook = {
    ["players"] = {
        [1] = { ["name"] = "New callsign", ["statistics"] = { ["name"] = "ignored" } },
        [2] = { ["name"] = "Ethan", ["rank"] = 3 },
    },
    ["currentPlayer"] = 2,
}'''


class ProfileTests(unittest.TestCase):
    def test_current_player_by_index(self):
        self.assertEqual(parse_logbook(LOGBOOK), {"players": ["New callsign", "Ethan"], "current": "Ethan"})

    def test_current_player_by_name(self):
        text = LOGBOOK.replace('["currentPlayer"] = 2', '["currentPlayer"] = "Ethan"')
        self.assertEqual(parse_logbook(text)["current"], "Ethan")

    def test_install_bridge_preserves_existing_exporters(self):
        with tempfile.TemporaryDirectory() as d:
            sg = Path(d) / "DCS"
            (sg / "Scripts").mkdir(parents=True)
            export = sg / "Scripts" / "Export.lua"
            export.write_text("dofile('Tacview.lua')")
            install_bridge(sg)
            install_bridge(sg)
            text = export.read_text()
            self.assertIn("Tacview.lua", text)
            self.assertEqual(text.count("DCS-SA-Export.lua"), 1)
            self.assertTrue((sg / "Scripts" / "DCS-SA-Export.lua").is_file())
            self.assertTrue((sg / "Scripts" / "Hooks" / "DCS-SA-Hook.lua").is_file())
            self.assertTrue((sg / "Scripts" / "Export.lua.before-dcs-sa").is_file())

    def test_refresh_bridge_updates_only_installed_scripts(self):
        with tempfile.TemporaryDirectory() as d:
            fresh = Path(d) / "DCS.openbeta"
            (fresh / "Scripts").mkdir(parents=True)
            self.assertEqual(refresh_bridge(fresh), [])  # never installed: left alone
            self.assertFalse((fresh / "Scripts" / BRIDGE_NAME).exists())

            sg = Path(d) / "DCS"
            (sg / "Scripts").mkdir(parents=True)
            install_bridge(sg)
            export = (sg / "Scripts" / "Export.lua").read_text()
            self.assertEqual(refresh_bridge(sg), [])  # already current
            (sg / "Scripts" / BRIDGE_NAME).write_text("-- old version")
            (sg / "Scripts" / "Hooks" / HOOK_NAME).unlink()
            self.assertEqual(len(refresh_bridge(sg)), 2)
            self.assertEqual((sg / "Scripts" / BRIDGE_NAME).read_bytes(), bridge_source().read_bytes())
            self.assertTrue((sg / "Scripts" / "Hooks" / HOOK_NAME).is_file())
            self.assertEqual((sg / "Scripts" / "Export.lua").read_text(), export)


if __name__ == "__main__":
    unittest.main()
