#!/usr/bin/env python3
"""wx_live_poller の組み立て（METAR/TAF＝AWC だけ、ATIS＝SWIM を 120 秒以上あけて）と ATIS 時刻抽出。"""
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


AWC_TT = {"metar": [{"raw": "METAR RJTT 230300Z 08005KT 9999 FEW030 15/05 Q1020", "obsTime": "2026-11-23T03:00:00Z",
                     "source": "AWC", "type": "METAR", "fltCat": "VFR"}],
          "taf": {"raw": "TAF RJTT 222300Z 2300/2406 08005KT 9999 FEW030", "issueTime": "2026-11-22T23:00:00Z",
                  "validFrom": None, "validTo": None, "source": "AWC"}}


class TestBuildPayload(unittest.TestCase):
    """2026-11-24 から METAR/TAF は AWC だけ、ATIS は SWIM。"""
    def setUp(self):
        self.cfg = {"atisAirports": ["RJTT"], "profileAirports": ["RJTT", "RJDC"]}
        self.swim_raw = json.loads(FIXTURE.read_text())
        self.atis = self.swim_raw["atis"]

    def test_metar_taf_from_awc_atis_from_swim(self):
        awc = {"fetchedAt": "2026-11-23T03:20:00Z", "airports": {"RJTT": AWC_TT, "RJDC": {"metar": [], "taf": None}}}
        payload, stats = w.build_payload(self.cfg, self.atis, awc, ref=REF)
        self.assertEqual(payload["schema"], "flight-buddy-wx-live/1")
        tt = payload["airports"]["RJTT"]
        self.assertEqual(tt["metarSource"], "AWC")
        self.assertEqual(tt["tafSource"], "AWC")
        self.assertEqual(tt["atisSource"], "SWIM")
        self.assertTrue(tt["atis"]["text"].startswith("ATIS"))
        self.assertIsNone(payload["airports"]["RJDC"]["metarSource"])
        self.assertEqual(stats["metarAwc"], 1)
        self.assertNotIn("SWIM（国交省）／失敗時のみ", payload["source"])
        self.assertIn("AWC", payload["source"])

    def test_swim_profile_text_is_never_used(self):
        # 空港詳細（プロファイル）の METAR を渡す口は無い（AWC が空なら METAR は空）
        payload, stats = w.build_payload(self.cfg, self.atis, {"airports": {}}, ref=REF)
        self.assertEqual(payload["airports"]["RJTT"]["metar"], [])
        self.assertEqual(stats["metarAwc"], 0)

    def test_run_swim_refuses_profile(self):
        with self.assertRaises(ValueError):
            w.run_swim(["RJTT"], parts="profile")
        with self.assertRaises(ValueError):
            w.run_swim(["RJTT"], parts="atis,profile")

    def test_atis_meta(self):
        ident, tm = w.atis_meta("ATIS RJTT X\nM0300\nM\n230300Z 08005KT 50KM=\n", REF)
        self.assertEqual(ident, "X")
        self.assertEqual(tm, "2026-11-23T03:00:00Z")

    def test_speci_type(self):
        e = w.metar_entry("SPECI RJTT 230317Z 08020G35KT 2000 TSRA=", REF, "AWC")
        self.assertEqual(e["type"], "SPECI")
        self.assertEqual(e["obsTime"], "2026-11-23T03:17:00Z")


class TestAtisIntervalAndCycle(unittest.TestCase):
    def test_atis_due_at_least_120s(self):
        t0 = dt.datetime(2026, 11, 24, 10, 0, tzinfo=UTC)
        st = {"lastAtisRequestAt": "2026-11-24T10:00:00Z"}
        self.assertFalse(w.atis_due(st, {}, t0 + dt.timedelta(seconds=119)))
        self.assertTrue(w.atis_due(st, {}, t0 + dt.timedelta(seconds=120)))
        # 設定で短くしても 120 秒未満にはならない
        self.assertFalse(w.atis_due(st, {"atisMinSeconds": 30}, t0 + dt.timedelta(seconds=60)))
        self.assertTrue(w.atis_due({}, {}, t0))

    def test_cycle_never_calls_swim_profile_and_respects_atis_interval(self):
        calls = []
        orig_run, orig_awc = w.run_swim, w.fetch_awc
        w.run_swim = lambda icaos, **k: calls.append(("swim", tuple(icaos), k.get("parts", "atis"))) or {"ok": True, "atis": json.loads(FIXTURE.read_text())["atis"]}
        w.fetch_awc = lambda icaos, hours=12: calls.append(("awc", len(icaos))) or {"fetchedAt": "x", "airports": {"RJTT": AWC_TT}, "ok": True, "error": None, "covered": list(icaos)}
        try:
            cfg = {"atisAirports": ["RJTT"], "profileAirports": ["RJTT", "RJDC"]}
            with tempfile.TemporaryDirectory() as td:
                out, cur = os.path.join(td, "live.json"), os.path.join(td, "cur.json")
                t0 = dt.datetime(2026, 11, 24, 10, 0, tzinfo=UTC)
                for sec in (0, 60, 119, 120, 200, 240):
                    w.cycle(cfg, out, local_only=True, cursor_path=cur, kv_state_path=None, now=t0 + dt.timedelta(seconds=sec))
                swim_calls = [c for c in calls if c[0] == "swim"]
                self.assertEqual(len(swim_calls), 3)   # 0s, 120s, 240s
                self.assertTrue(all(c[2] == "atis" for c in swim_calls))
                self.assertEqual(len([c for c in calls if c[0] == "awc"]), 6)
                d = json.loads(Path(out).read_text())
                self.assertEqual(d["airports"]["RJTT"]["metarSource"], "AWC")
                self.assertEqual(d["airports"]["RJTT"]["atisSource"], "SWIM")
        finally:
            w.run_swim, w.fetch_awc = orig_run, orig_awc


class TestAllAirports(unittest.TestCase):
    def test_production_config_has_no_subset_lists(self):
        cfg = w.load_cfg()
        self.assertFalse(cfg.get("atisAirports"))
        self.assertFalse(cfg.get("profileAirports"))
        self.assertNotIn("profileCycleSeconds", cfg)
        self.assertGreaterEqual(int(cfg["pollSeconds"]), 120)
        self.assertGreaterEqual(w.atis_min_seconds(cfg), 120)
        self.assertEqual(int(cfg["kvMinWriteSeconds"]), 180)
        self.assertEqual(int(cfg["kvDailyWriteBudget"]), 600)

    def test_atis_supported_is_swim_set(self):
        atis = w.atis_supported_icaos()
        self.assertEqual(len(atis), 23)
        self.assertIn("RJTT", atis)
        self.assertIn("ROAH", atis)
        self.assertIn("ROIG", atis)
        self.assertEqual(len(set(atis)), 23)

    def test_all_domestic_airports(self):
        prof = w.profile_airports()
        self.assertGreaterEqual(len(prof), 134)
        self.assertTrue(all(x.startswith("RJ") or x.startswith("RO") for x in prof))
        atis, watched = w.watched({})
        self.assertEqual(atis, w.atis_supported_icaos())
        self.assertTrue(set(atis).issubset(set(watched)))
        self.assertGreaterEqual(len(watched), 134)

    def test_merge_keeps_uncovered_metar_and_unfetched_atis(self):
        prev = {"airports": {
            "RJTT": {"metar": [{"raw": "OLD METAR"}], "taf": {"raw": "OLD TAF"}, "metarSource": "AWC", "tafSource": "AWC",
                     "atis": {"text": "OLD ATIS", "ident": "A"}, "atisSource": "SWIM", "atisReason": None,
                     "atisFetchedAt": "2026-11-23T03:00:00Z"},
            "RJDC": {"metar": [{"raw": "OLD DC"}], "taf": None, "metarSource": "AWC", "tafSource": None,
                     "atis": None, "atisSource": None, "atisReason": "対象外", "atisFetchedAt": None},
        }, "fetchedAt": {"atis": "2026-11-23T03:00:00Z", "awc": "2026-11-23T03:00:00Z"}}
        payload = {"airports": {
            "RJTT": {"metar": [{"raw": "NEW METAR"}], "taf": {"raw": "NEW TAF"}, "metarSource": "AWC", "tafSource": "AWC",
                     "atis": {"text": "NEW ATIS", "ident": "B"}, "atisSource": "SWIM", "atisReason": None,
                     "atisFetchedAt": "2026-11-23T03:30:00Z"},
            "RJDC": {"metar": [], "taf": None, "metarSource": None, "tafSource": None,
                     "atis": None, "atisSource": None, "atisReason": "対象外", "atisFetchedAt": None},
        }, "fetchedAt": {"atis": "2026-11-23T03:30:00Z", "awc": "2026-11-23T03:30:00Z"}}
        out = w.merge_airports(prev, payload, awc_covered=["RJDC"], atis_fresh=True)
        self.assertEqual(out["airports"]["RJTT"]["metar"][0]["raw"], "OLD METAR")
        self.assertEqual(out["airports"]["RJTT"]["atis"]["ident"], "B")
        self.assertEqual(out["airports"]["RJDC"]["metar"], [])
        out2 = w.merge_airports(prev, payload, awc_covered=["RJTT"], atis_fresh=False)
        self.assertEqual(out2["airports"]["RJTT"]["metar"][0]["raw"], "NEW METAR")
        self.assertEqual(out2["airports"]["RJTT"]["atis"]["ident"], "A")
        self.assertEqual(out2["fetchedAt"]["atis"], "2026-11-23T03:00:00Z")


class TestKvWriteGate(unittest.TestCase):
    def _payload(self, metar_raw="METAR RJTT 230300Z", generated="2026-11-24T00:00:00Z",
                 atis_fetched="2026-11-24T00:00:00Z"):
        return {
            "schema": w.SCHEMA,
            "generatedAt": generated,
            "fetchedAt": {"atis": generated, "profile": generated, "awc": None},
            "swimOk": True,
            "swimReason": None,
            "stats": {"metarSwim": 1},
            "airports": {
                "RJTT": {
                    "metar": [{"raw": metar_raw, "obsTime": "2026-11-23T03:00:00Z"}],
                    "taf": None,
                    "atis": {"text": "ATIS RJTT X", "ident": "X", "time": "2026-11-23T03:00:00Z"},
                    "atisFetchedAt": atis_fetched,
                }
            },
        }

    def test_hash_ignores_volatile_timestamps_and_stats(self):
        a = self._payload(generated="2026-11-24T00:00:00Z", atis_fetched="2026-11-24T00:00:00Z")
        b = self._payload(generated="2026-11-24T00:01:30Z", atis_fetched="2026-11-24T00:01:30Z")
        b["stats"] = {"metarSwim": 99}
        b["swimOk"] = False
        b["swimReason"] = "flicker"
        b["fetchedAt"]["profile"] = "2026-11-24T00:01:30Z"
        self.assertEqual(w.payload_content_hash(a), w.payload_content_hash(b))

    def test_hash_changes_when_report_changes(self):
        a = self._payload("METAR RJTT 230300Z")
        b = self._payload("METAR RJTT 230400Z")
        c = self._payload("METAR RJTT 230300Z")
        c["airports"]["RJTT"]["atis"]["ident"] = "Y"
        self.assertNotEqual(w.payload_content_hash(a), w.payload_content_hash(b))
        self.assertNotEqual(w.payload_content_hash(a), w.payload_content_hash(c))

    def test_skip_unchanged(self):
        p = self._payload()
        now = dt.datetime(2026, 11, 24, 0, 10, tzinfo=UTC)
        st = {"utcDay": "2026-11-24", "writesToday": 3, "lastWriteAt": "2026-11-24T00:07:00Z",
              "lastWrittenHash": w.payload_content_hash(p), "pending": False}
        should, reason, st2 = w.decide_kv_write({}, p, st, now=now)
        self.assertFalse(should)
        self.assertEqual(reason, "skip(unchanged)")
        self.assertEqual(st2["writesToday"], 3)
        self.assertFalse(st2["pending"])

    def test_wait_then_put_latest(self):
        cfg = {"kvMinWriteSeconds": 180, "kvDailyWriteBudget": 600}
        p1 = self._payload("OLD")
        p2 = self._payload("NEW1")
        p3 = self._payload("NEW2")
        t0 = dt.datetime(2026, 11, 24, 0, 0, tzinfo=UTC)
        st = w.mark_kv_written({"utcDay": "2026-11-24", "writesToday": 0}, p1, now=t0)
        should, reason, st = w.decide_kv_write(cfg, p2, st, now=t0 + dt.timedelta(seconds=90))
        self.assertFalse(should)
        self.assertEqual(reason, "skip(wait)")
        self.assertTrue(st["pending"])
        # 待ち時間中の更新は捨てず、間隔後の周期で最新を書く
        should, reason, st = w.decide_kv_write(cfg, p3, st, now=t0 + dt.timedelta(seconds=180))
        self.assertTrue(should)
        self.assertEqual(reason, "put")
        st = w.mark_kv_written(st, p3, now=t0 + dt.timedelta(seconds=180))
        self.assertEqual(st["lastWrittenHash"], w.payload_content_hash(p3))
        self.assertNotEqual(st["lastWrittenHash"], w.payload_content_hash(p2))
        self.assertEqual(st["writesToday"], 2)

    def test_budget_blocks_until_utc_reset(self):
        cfg = {"kvMinWriteSeconds": 0, "kvDailyWriteBudget": 2}
        p1 = self._payload("A")
        p2 = self._payload("B")
        t0 = dt.datetime(2026, 11, 24, 23, 59, tzinfo=UTC)
        st = {"utcDay": "2026-11-24", "writesToday": 2, "lastWriteAt": "2026-11-24T23:50:00Z",
              "lastWrittenHash": w.payload_content_hash(p1), "pending": False}
        should, reason, st = w.decide_kv_write(cfg, p2, st, now=t0)
        self.assertFalse(should)
        self.assertEqual(reason, "skip(budget)")
        self.assertTrue(st["pending"])
        t1 = dt.datetime(2026, 11, 25, 0, 0, tzinfo=UTC)
        should, reason, st = w.decide_kv_write(cfg, p2, st, now=t1)
        self.assertTrue(should)
        self.assertEqual(reason, "put")
        st = w.mark_kv_written(st, p2, now=t1)
        self.assertEqual(st["utcDay"], "2026-11-25")
        self.assertEqual(st["writesToday"], 1)

    def test_defaults_and_worst_case_under_budget(self):
        self.assertEqual(w.kv_min_write_seconds({}), 180)
        self.assertEqual(w.kv_daily_write_budget({}), 600)
        cfg = w.load_cfg()
        self.assertEqual(w.kv_min_write_seconds(cfg), 180)
        self.assertEqual(w.kv_daily_write_budget(cfg), 600)
        # 内容が毎回変わっても 24h / 180s = 480 回で、日次上限 600 より少ない
        self.assertLessEqual(86400 // w.kv_min_write_seconds(cfg), w.kv_daily_write_budget(cfg))

    def test_state_file_roundtrip_and_day_roll(self):
        p = self._payload("X")
        t0 = dt.datetime(2026, 11, 24, 23, 50, tzinfo=UTC)
        with tempfile.TemporaryDirectory() as td:
            path = os.path.join(td, "kv-state.json")
            st = w.mark_kv_written({"utcDay": "2026-11-24", "writesToday": 5}, p, now=t0)
            w.write_json(path, st)
            loaded = w.load_kv_write_state(path, now=t0)
            self.assertEqual(loaded["writesToday"], 6)
            self.assertEqual(loaded["lastWrittenHash"], w.payload_content_hash(p))
            rolled = w.load_kv_write_state(path, now=dt.datetime(2026, 11, 25, 0, 0, tzinfo=UTC))
            self.assertEqual(rolled["utcDay"], "2026-11-25")
            self.assertEqual(rolled["writesToday"], 0)
            self.assertEqual(rolled["lastWrittenHash"], loaded["lastWrittenHash"])


if __name__ == "__main__":
    unittest.main()
