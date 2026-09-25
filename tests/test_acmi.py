import io
import math
import os
import tempfile
import unittest
import zipfile

from dcs_sa.acmi import parse_file
from dcs_sa.acmi.parser import AcmiParser, RecordingBuilder, norm_id, split_unescaped, unescape

HEADER = "FileType=text/acmi/tacview\nFileVersion=2.2\n"


def parse_text(text):
    b = RecordingBuilder()
    p = AcmiParser(b)
    for line in text.splitlines():
        p.feed(line)
    return b.finish(), p


class EscapingTests(unittest.TestCase):
    def test_split_respects_escaped_commas(self):
        self.assertEqual(split_unescaped(r"a=1,b=x\,y,c=3", ","), ["a=1", r"b=x\,y", "c=3"])

    def test_unescape(self):
        self.assertEqual(unescape(r"a\, b \| c \\ d"), "a, b | c \\ d")

    def test_norm_id(self):
        self.assertEqual(norm_id("00a1"), "A1")
        self.assertEqual(norm_id("0"), "0")


class ParserTests(unittest.TestCase):
    def test_reference_offsets_are_added(self):
        rec, _ = parse_text(HEADER + "0,ReferenceLongitude=40\n0,ReferenceLatitude=30\n#0\n1,T=1.5|2.5|100,Type=Air+FixedWing\n")
        self.assertEqual(rec.tracks["1"].position_at(0), (41.5, 32.5, 100.0))

    def test_empty_transform_slots_keep_previous_value(self):
        rec, _ = parse_text(HEADER + "#0\n1,T=1|2|100|0|5|90,Type=Air+FixedWing\n#1\n1,T=|2.1|||6|\n")
        tr = rec.tracks["1"]
        self.assertEqual(tr.state_at(1)["Longitude"], 1.0)
        self.assertEqual(tr.state_at(1)["Latitude"], 2.1)
        self.assertEqual(tr.state_at(1)["Yaw"], 90.0)
        self.assertEqual(tr.state_at(1)["Pitch"], 6.0)

    def test_nine_value_transform(self):
        rec, _ = parse_text(HEADER + "#0\n1,T=1|2|3|4|5|6|7|8|9\n")
        s = rec.tracks["1"].state_at(0)
        self.assertEqual((s["U"], s["V"], s["Heading"]), (7.0, 8.0, 9.0))

    def test_events_and_removal(self):
        rec, _ = parse_text(HEADER + "#0\n1,T=1|2|3,Type=Air+FixedWing\n#5\n0,Event=Destroyed|1|\n0,Event=Message|1|hi\\, there\n-1\n")
        self.assertEqual(rec.tracks["1"].removed_at, 5.0)
        self.assertEqual([e.kind for e in rec.events], ["Destroyed", "Message"])
        self.assertEqual(rec.events[1].text, "hi, there")
        self.assertEqual(rec.events[0].object_ids, ["1"])

    def test_bookmark_without_object(self):
        rec, _ = parse_text(HEADER + "#0\n0,Event=Bookmark|Merge\n")
        self.assertEqual((rec.events[0].object_ids, rec.events[0].text), ([], "Merge"))

    def test_multiline_text_property(self):
        rec, _ = parse_text(HEADER + "0,Briefing=line one\\\nline two\n")
        # Physical-line joining happens in the reader; the parser sees the joined line.
        self.assertIn("line one", rec.globals["Briefing"])

    def test_text_history_tracks_lock_changes(self):
        rec, _ = parse_text(HEADER + "#0\n1,T=1|2|3,Type=Air+FixedWing,LockedTarget=2\n#4\n1,LockedTarget=3\n")
        tr = rec.tracks["1"]
        self.assertEqual(tr.text_at("LockedTarget", 2), "2")
        self.assertEqual(tr.text_at("LockedTarget", 5), "3")

    def test_unknown_property_kept_as_text(self):
        rec, p = parse_text(HEADER + "#0\n1,T=1|2|3,FutureThing=42\n")
        self.assertEqual(rec.tracks["1"].props["FutureThing"], "42")
        self.assertTrue(p.warnings)

    def test_static_object_lives_until_end(self):
        rec, _ = parse_text(HEADER + "#0\n9,T=1|2|0,Type=Ground+AntiAircraft\n1,T=1|2|3\n#100\n1,T=1.1|2|3\n")
        self.assertTrue(rec.tracks["9"].alive_at(90))


class ReaderTests(unittest.TestCase):
    def test_zip_and_plain_files_parse_identically(self):
        body = HEADER + "0,Title=Zip test\n#0\n1,T=1|2|3,Type=Air+FixedWing,Name=F-16C\n"
        with tempfile.TemporaryDirectory() as d:
            plain = os.path.join(d, "a.txt.acmi")
            with open(plain, "w", encoding="utf-8-sig") as fh:  # with BOM
                fh.write(body)
            zipped = os.path.join(d, "b.zip.acmi")
            with zipfile.ZipFile(zipped, "w") as zf:
                zf.writestr("b.txt.acmi", body)
            for path in (plain, zipped):
                rec = parse_file(path)
                self.assertEqual(rec.title, "Zip test")
                self.assertEqual(rec.tracks["1"].name, "F-16C")

    def test_continuation_lines(self):
        with tempfile.TemporaryDirectory() as d:
            path = os.path.join(d, "c.acmi")
            with open(path, "w") as fh:
                fh.write(HEADER + "0,Briefing=first\\\nsecond\n")
            self.assertEqual(parse_file(path).globals["Briefing"], "first\nsecond")


if __name__ == "__main__":
    unittest.main()
