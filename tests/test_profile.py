import tempfile
import unittest
from pathlib import Path

from dcs_sa.dcs_profile import install_bridge, parse_logbook

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
            self.assertTrue((sg / "Scripts" / "Export.lua.before-dcs-sa").is_file())


if __name__ == "__main__":
    unittest.main()
