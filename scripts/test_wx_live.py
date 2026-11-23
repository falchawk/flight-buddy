#!/usr/bin/env python3
"""wx_live_poller の組み立て（SWIM 優先・AWC は失敗時のみ）と ATIS 時刻抽出。"""
import datetime as dt
import json
import os
import sys
import tempfile
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "scripts"))
import wx_live_poller as w  # noqa: E402

UTC = dt.timezone.utc
FIXTURE = ROOT / "scripts" / "fixtures" / "wx_live_swim.json"
REF = dt.datetime(2026, 11, 23, 3, 20, tzinfo=UTC)


class TestBuildPayload(unittest.TestCase):
    def setUp(self):
        self.cfg = w.load_cfg()
        self.swim_raw = json.loads(FIXTURE.read_text())
        self.swim = {"ok": True, "reason": None, "atis": self.swim_raw["atis"], "profile": self.swim_raw["profile"]}

    def test_swim_preferred(self):
        payload, stats = w.build_payload(self.cfg, self.swim, {"airports": {}}, ref=REF)
        self.assertEqual(payload["schema"], "flight-buddy-wx-live/1")
        tt = payload["airports"]["RJTT"]
        self.assertEqual(tt["metarSource"], "SWIM")
        self.assertTrue(tt["metar"][0]["raw"])
        self.assertEqual(tt["metar"][0]["obsTime"], "2026-11-23T03:00:00Z")
        self.assertEqual(tt["tafSource"], "SWIM")
        self.assertEqual(tt["atisSource"], "SWIM")
        self.assertTrue(tt["atis"]["text"].startswith("ATIS"))
        self.assertGreater(stats["metarSwim"], 0)
        self.assertEqual(stats["metarAwc"], 0)

    def test_awc_only_when_swim_missing(self):
        # RJDC の METAR を欠かして AWC に倒す
        prof = json.loads(json.dumps(self.swim_raw["profile"]))
        prof["byIcao"]["RJDC"]["metarText"] = ""
        if "RJDC" in prof.get("metarByIcao") or {}:
            prof["metarByIcao"]["RJDC"]["text"] = ""
        swim = {"ok": True, "atis": self.swim_raw["atis"], "profile": prof}
        awc = {"fetchedAt": "2026-11-23T03:20:00Z", "airports": {
            "RJDC": {"metar": [{"raw": "METAR RJDC 230300Z 13006KT 9999 FEW035 15/06 Q1028", "obsTime": "2026-11-23T03:00:00Z", "source": "AWC", "type": "METAR", "fltCat": "VFR"}], "taf": None}
        }}
        payload, stats = w.build_payload(self.cfg, swim, awc, ref=REF)
        self.assertEqual(payload["airports"]["RJDC"]["metarSource"], "AWC")
        self.assertEqual(payload["airports"]["RJTT"]["metarSource"], "SWIM")
        self.assertGreaterEqual(stats["metarAwc"], 1)

    def test_awc_not_used_when_swim_has_report(self):
        awc = {"airports": {"RJTT": {"metar": [{"raw": "METAR RJTT 230330Z 00000KT 9999", "obsTime": "2026-11-23T03:30:00Z", "source": "AWC", "type": "METAR", "fltCat": "VFR"}], "taf": None}}}
        payload, _ = w.build_payload(self.cfg, self.swim, awc, ref=REF)
        # SWIM が取れているので、より新しい AWC があっても使わない
        self.assertEqual(payload["airports"]["RJTT"]["metarSource"], "SWIM")
        self.assertIn("230300Z", payload["airports"]["RJTT"]["metar"][0]["raw"])

    def test_atis_meta(self):
        ident, tm = w.atis_meta("ATIS RJTT X\nM0300\nM\n230300Z 08005KT 50KM=\n", REF)
        self.assertEqual(ident, "X")
        self.assertEqual(tm, "2026-11-23T03:00:00Z")

    def test_speci_type(self):
        e = w.metar_entry("SPECI RJTT 230317Z 08020G35KT 2000 TSRA=", REF, "SWIM")
        self.assertEqual(e["type"], "SPECI")
        self.assertEqual(e["obsTime"], "2026-11-23T03:17:00Z")

    def test_cycle_local_with_override(self):
        cfg = {"atisAirports": ["RJTT"], "profileAirports": ["RJTT", "RJDC"]}
        with tempfile.TemporaryDirectory() as td:
            out = os.path.join(td, "live.json")
            # skip network: inject swim, skip awc
            payload, stats = w.build_payload(cfg, self.swim, {"airports": {}}, ref=REF)
            w.write_json(out, payload)
            d = json.loads(Path(out).read_text())
            self.assertEqual(d["schema"], w.SCHEMA)
            self.assertIn("RJTT", d["airports"])



class TestAllAirportsAndChunks(unittest.TestCase):
    def test_production_config_has_no_subset_lists(self):
        cfg = w.load_cfg()
        self.assertFalse(cfg.get("atisAirports"))
        self.assertFalse(cfg.get("profileAirports"))
        self.assertEqual(int(cfg["pollSeconds"]), 90)
        self.assertEqual(int(cfg["profileCycleSeconds"]), 180)

    def test_atis_supported_is_swim_set(self):
        atis = w.atis_supported_icaos()
        self.assertEqual(len(atis), 23)
        self.assertIn("RJTT", atis)
        self.assertIn("ROAH", atis)
        self.assertIn("ROIG", atis)
        self.assertEqual(len(set(atis)), 23)

    def test_profile_is_all_domestic_swim_targets(self):
        prof = w.profile_airports()
        self.assertGreaterEqual(len(prof), 134)
        self.assertTrue(all(x.startswith("RJ") or x.startswith("RO") for x in prof))
        atis, watched = w.watched({})
        self.assertEqual(atis, w.atis_supported_icaos())
        self.assertTrue(set(atis).issubset(set(watched)))
        self.assertGreaterEqual(len(watched), 134)

    def test_chunk_size_and_wrap(self):
        cfg = {"pollSeconds": 90, "profileCycleSeconds": 180}
        self.assertEqual(w.profile_chunk_size(134, cfg), 67)
        icaos = [f"A{i:03d}" for i in range(134)]
        a, c1 = w.next_chunk(icaos, 0, 67)
        b, c2 = w.next_chunk(icaos, c1, 67)
        self.assertEqual(len(a), 67)
        self.assertEqual(len(b), 67)
        self.assertEqual(c2, (67 + 67) % 134)
        self.assertEqual(sorted(set(a + b)), sorted(icaos))

    def test_merge_keeps_old_metar_updates_atis(self):
        prev = {"airports": {
            "RJTT": {"metar": [{"raw": "OLD METAR"}], "taf": {"raw": "OLD TAF"},
                     "metarSource": "SWIM", "tafSource": "SWIM",
                     "atis": {"text": "OLD ATIS", "ident": "A"}, "atisSource": "SWIM",
                     "atisReason": None, "atisFetchedAt": "2026-11-23T03:00:00Z"},
            "RJDC": {"metar": [{"raw": "OLD DC"}], "taf": None, "metarSource": "SWIM",
                     "tafSource": None, "atis": None, "atisSource": None,
                     "atisReason": "対象外", "atisFetchedAt": None},
        }}
        payload = {"airports": {
            "RJTT": {"metar": [{"raw": "NEW METAR"}], "taf": {"raw": "NEW TAF"},
                     "metarSource": "SWIM", "tafSource": "SWIM",
                     "atis": {"text": "NEW ATIS", "ident": "B"}, "atisSource": "SWIM",
                     "atisReason": None, "atisFetchedAt": "2026-11-23T03:30:00Z"},
            "RJDC": {"metar": [], "taf": None, "metarSource": None, "tafSource": None,
                     "atis": None, "atisSource": None, "atisReason": "対象外", "atisFetchedAt": None},
        }, "fetchedAt": {"atis": "2026-11-23T03:30:00Z"}}
        # refresh only RJDC profile; ATIS ok so RJTT atis updates, RJTT metar stays old
        out = w.merge_airports(prev, payload, refresh_profile=["RJDC"], atis_ok=True)
        self.assertEqual(out["airports"]["RJTT"]["metar"][0]["raw"], "OLD METAR")
        self.assertEqual(out["airports"]["RJTT"]["atis"]["ident"], "B")
        self.assertEqual(out["airports"]["RJDC"]["metar"], [])
        # ATIS failure keeps previous ATIS
        out2 = w.merge_airports(prev, payload, refresh_profile=["RJTT"], atis_ok=False)
        self.assertEqual(out2["airports"]["RJTT"]["metar"][0]["raw"], "NEW METAR")
        self.assertEqual(out2["airports"]["RJTT"]["atis"]["ident"], "A")

    def test_refresh_profile_does_not_fill_other_metars(self):
        cfg = {"atisAirports": ["RJTT"], "profileAirports": ["RJTT", "RJDC"]}
        swim_raw = json.loads(FIXTURE.read_text())
        swim = {"ok": True, "atis": swim_raw["atis"], "profile": swim_raw["profile"]}
        payload, stats = w.build_payload(cfg, swim, {"airports": {}}, ref=REF, refresh_profile=["RJTT"])
        self.assertEqual(payload["airports"]["RJTT"]["metarSource"], "SWIM")
        self.assertIsNone(payload["airports"]["RJDC"]["metarSource"])
        self.assertEqual(payload["airports"]["RJDC"]["metar"], [])
        self.assertGreaterEqual(stats["metarSwim"], 1)



if __name__ == "__main__":
    unittest.main()
