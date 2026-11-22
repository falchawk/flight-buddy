#!/usr/bin/env python3
"""ground_chart の要約・日程・照合の単体テスト。"""
import json
import os
import sys
import unittest
import datetime as dt

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import ground_chart as g
os.environ.setdefault('GROUND_SKIP_GSI', '1')

PACK = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))),
                    "data", "packs")


def latest_ap(icao):
    ids = sorted([d for d in os.listdir(PACK) if os.path.isdir(os.path.join(PACK, d))])
    for pid in reversed(ids):
        p = os.path.join(PACK, pid, "ap", f"{icao}.json")
        if os.path.isfile(p):
            return json.load(open(p))
    raise FileNotFoundError(icao)


class TestThruAndSummary(unittest.TestCase):
    def test_thru_letters(self):
        self.assertEqual(g.thru_expand("C1 THRU C14"), "C1,C2,C3,C4,C5,C6,C7,C8,C9,C10,C11,C12,C13,C14")

    def test_thru_spots(self):
        self.assertIn("66,67,68", g.thru_expand("SPOT 66 THRU 73"))

    def test_closed_twy(self):
        s, ok = g.summarize("TWY C(BTN E1 AND E8),E1,E2 CLSD DUE TO CONST")
        self.assertTrue(ok)
        self.assertIn("TWY C（E1〜E8間）", s)
        self.assertIn("閉鎖", s)
        self.assertIn("工事", s)

    def test_rwy_closed(self):
        s, ok = g.summarize("RWY 16L/34R CLSD DUE TO MAINT RMK: SEE AIP")
        self.assertTrue(ok)
        self.assertEqual(s.split(" ／")[0], "RWY 16L/34R 閉鎖")

    def test_wingspan(self):
        s, ok = g.summarize("TWY N(BTN N2 AND N5) RESTRICTED DUE TO CONST NOT AVBL FOR ACFT WITH WINGSPAN MORE THAN 52.0M")
        self.assertTrue(ok)
        self.assertIn("翼幅52.0m超は使用不可", s)

    def test_ils(self):
        s, ok = g.summarize("ILS-LOC,GP,DME FOR RWY 16L U/S DUE TO CONST")
        self.assertTrue(ok)
        self.assertIn("ILS", s)
        self.assertIn("使用不能", s)

    def test_unsure_keeps_english(self):
        s, ok = g.summarize("UNKNOWN PHRASE WITHOUT ACTION KEYWORDS")
        self.assertFalse(ok)
        self.assertEqual(s, "UNKNOWN PHRASE WITHOUT ACTION KEYWORDS")

    def test_all_twy(self):
        s, ok = g.summarize("ALL TWY CLSD DUE TO MAINT EXC ACFT WITH PRIOR PERMISSION AT LEAST 1HR BFR")
        self.assertTrue(ok)
        self.assertIn("全誘導路 閉鎖", s)
        self.assertIn("事前許可機を除く", s)

    def test_spots_reloc(self):
        s, ok = g.summarize("SPOT 401,47 RELOCATED")
        self.assertTrue(ok)
        self.assertIn("移設", s)


class TestSchedule(unittest.TestCase):
    def test_days_and_hours(self):
        sch = g.parse_schedule("08 23 1430/2100")
        self.assertEqual(sch["days"], [8, 23])
        self.assertEqual(sch["start"], 1430)
        self.assertEqual(sch["end"], 2100)
        t = dt.datetime(2026, 11, 23, 15, 0, tzinfo=dt.timezone.utc)
        self.assertTrue(g.schedule_active(sch, t, "2026-11-08T14:30:00Z", "2026-11-23T21:00:00Z"))
        t2 = dt.datetime(2026, 11, 22, 15, 0, tzinfo=dt.timezone.utc)
        self.assertFalse(g.schedule_active(sch, t2, "2026-11-08T14:30:00Z", "2026-11-23T21:00:00Z"))
        t3 = dt.datetime(2026, 11, 23, 10, 0, tzinfo=dt.timezone.utc)
        self.assertFalse(g.schedule_active(sch, t3, "2026-11-08T14:30:00Z", "2026-11-23T21:00:00Z"))

    def test_overnight(self):
        sch = g.parse_schedule("2200/0600")
        t = dt.datetime(2026, 11, 21, 1, 0, tzinfo=dt.timezone.utc)
        self.assertTrue(g.schedule_active(sch, t, None, None))
        t2 = dt.datetime(2026, 11, 21, 12, 0, tzinfo=dt.timezone.utc)
        self.assertFalse(g.schedule_active(sch, t2, None, None))


class TestMatchLivePack(unittest.TestCase):
    def test_rjtt_place_rate(self):
        items = latest_ap("RJTT")["notam"]["items"]
        payload, _, _ = g.build_airport("RJTT", items)
        st = payload["stats"]
        tot = st["total"]
        placed = st.get("exact", 0) + st.get("partial", 0)
        self.assertGreaterEqual(tot, 50)
        self.assertGreaterEqual(placed / tot, 0.80)
        self.assertTrue(payload["ok"])
        self.assertLess(payload["bytes"], 200_000)

    def test_rjff_and_rjfr(self):
        for icao, min_rate in (("RJFF", 0.80), ("RJFR", 0.80)):
            items = latest_ap(icao)["notam"]["items"]
            payload, _, _ = g.build_airport(icao, items)
            st = payload["stats"]
            tot = st["total"] or 1
            placed = st.get("exact", 0) + st.get("partial", 0)
            self.assertGreaterEqual(placed / tot, min_rate, f"{icao} {st}")
            self.assertEqual(payload["quality"], "good")



class TestCoordAndList(unittest.TestCase):
    def test_parse_circle_and_poly(self):
        e = "UNMANNED ACFT: AREA: RADIUS 404M CENTER 354333N1394306E (TOSHIMA-KU IN TOKYO)"
        ge = g.parse_coord_geoms(e)
        self.assertEqual(ge[0]["t"], "circle")
        self.assertAlmostEqual(ge[0]["r"], 404)
        self.assertAlmostEqual(ge[0]["p"][0], 35 + 43 / 60 + 33 / 3600, places=5)
        e2 = "AREA: BOUNDED BY FLW POINTS 354021N1394720E - 354021N1394719E - 354016N1394720E - 354017N1394725E - 354021N1394720E (KOTO-KU IN TOKYO)"
        ge2 = g.parse_coord_geoms(e2)
        self.assertEqual(ge2[0]["t"], "poly")
        self.assertGreaterEqual(len(ge2[0]["pts"]), 4)

    def test_summarize_coord_ja(self):
        s, ok = g.summarize_coord("OBST LGT U/S TYPE: BLDG PSN: 353924.3N1395028.3E ELEV: 506FT AMSL (KOTO-KU IN TOKYO)", "QOLAS")
        self.assertTrue(ok)
        self.assertIn("障害物灯使用不能", s)
        self.assertIn("建物", s)
        self.assertIn("江東区", s)
        s, ok = g.summarize_coord("UNMANNED ACFT: AREA: RADIUS 404M CENTER 354333N1394306E (TOSHIMA-KU IN TOKYO) WT: 4.3KG", "QWULW")
        self.assertTrue(ok)
        self.assertIn("無人機", s)
        self.assertIn("豊島区", s)
        self.assertIn("404", s)
        s, ok = g.summarize_coord("FIREWORKS: PLACE: RADIUS 50M CENTER 353754N1394607E (MINATO-KU IN TOKYO)", "QWHLW")
        self.assertTrue(ok)
        self.assertIn("花火", s)
        self.assertIn("港区", s)
        s, ok = g.summarize_coord("CRANE EXIST ABV CONICAL SFC 1.PSN: BOUNDED BY FLW POINT 353515.8N1394811.7E - 353513.0N1394814.3E - 353510.1N1394813.1E - 353512.8N1394809.0E - 353515.8N1394811.7E (OTA-KU IN TOKYO)", "QOBCE")
        self.assertTrue(ok)
        self.assertIn("クレーン", s)
        self.assertIn("大田区", s)
        s, ok = g.summarize_coord("FOUNTAIN: PLACE : 353745N1394612E (MINATO-KU IN TOKYO)", "QXXLW")
        self.assertTrue(ok)
        self.assertIn("噴水", s)

    def test_all_notams_listed_and_h1(self):
        import os
        os.environ["GROUND_SKIP_GSI"] = "1"
        items = latest_ap("RJTT")["notam"]["items"]
        payload, layout, _ = g.build_airport("RJTT", items)
        self.assertEqual(len(payload["notams"]), len(items))
        refs = {t["ref"] for t in (json.loads(open(os.path.join(g.ROOT, payload["file"])).read())["taxiways"])}
        # layout object itself
        self.assertIn("H1", layout.TWY)
        self.assertTrue(any(n.get("cat") in ("obst_lgt", "uas", "fireworks", "obst", "coord", "balloon") and n.get("geoms") for n in payload["notams"]))
        unmapped = [n for n in payload["notams"] if not n.get("geoms")]
        # リストには置けるもの以外も残る（または全部座標で置けている）
        self.assertEqual(len(payload["notams"]), len(items))
        self.assertIn("coastFile", payload)
        self.assertIn("arp", payload)


if __name__ == "__main__":

    unittest.main()
