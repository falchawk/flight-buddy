"""時刻表 staging（/workspace/fb-staging/flights.json、ボットが1日数回取得）→ パック用のコンパクトな flights.json。

端末はこの1ファイルだけでオフライン検索する（通信しない）。
rows: [便名(会社2レター+数字), 出発, 到着, STD, STA, 機材, 曜日ビット(月=1…日=64), 有効開始, 有効終了, 出典, 運航会社, 共同運航便名(空白区切り), 備考]
空港は ICAO（分かる場合）か IATA。時刻は現地時刻（時刻表どおり）。
"""
import json
import os

# 日本の航空会社（IATA 2レター → 表示名）。ユーザー指定の全社。コード未取得の会社も一覧に載せて「未収録」と表示する。
JP_CARRIERS = [
    ("JL", "JAL", "日本航空"), ("NU", "JTA", "日本トランスオーシャン航空"), ("XM", "JAR", "ジェイエア"),
    ("3X", "JAC", "日本エアコミューター"), ("JL*HAC", "HAC", "北海道エアシステム"), ("RC", "RAC", "琉球エアーコミューター"),
    ("NH", "ANA", "全日空"), ("EH", "AKX", "ANAウイングス"), ("NQ", "AJX", "エアージャパン"),
    ("HD", "ADO", "AIRDO"), ("6J", "SNJ", "ソラシドエア"), ("7G", "SFJ", "スターフライヤー"), ("FW", "IBX", "アイベックスエアラインズ"),
    ("OC", "ORC", "オリエンタルエアブリッジ"), ("MZ", "AMX", "天草エアライン"), ("BV", "TOK", "トキエア"),
    ("BC", "SKY", "スカイマーク"), ("JH", "FDA", "フジドリームエアラインズ"), ("MM", "APJ", "Peach"),
    ("GK", "JJP", "ジェットスター・ジャパン"), ("ZG", "TZP", "ZIPAIR"), ("IJ", "SJO", "スプリング・ジャパン"),
    ("KZ", "NCA", "日本貨物航空"), ("CUK", "CUK", "新中央航空"), ("DAK", "DAK", "第一航空"),
]
IATA2 = {c[0]: c for c in JP_CARRIERS if "*" not in c[0]}
ICAO3_TO_IATA2 = {"JAL": "JL", "ANA": "NH", "SFJ": "7G", "SNJ": "6J", "ADO": "HD", "SKY": "BC", "FDA": "JH",
                  "IBX": "FW", "APJ": "MM", "JJP": "GK"}
SRC_LABEL = {"board": "空港の発着案内", "rararakt": "rararakt（最終手段）", "toki": "トキエア公式", "odpt": "ODPT", "ana-pdf": "ANA公式PDF", "official-pdf": "公式PDF", "live": "公式サイト",
             "official": "公式", "bundle": "同梱"}


def _airport_maps(profiles, extra_airports_json):
    iata2icao, ja = {}, {}
    for icao, p in (profiles or {}).get("airports", {}).items():
        if p.get("iata"):
            iata2icao[p["iata"]] = icao
    try:
        for a in json.load(open(extra_airports_json, encoding="utf-8")).get("airports", []):
            if a.get("iata") and a.get("icao"):
                iata2icao.setdefault(a["iata"], a["icao"])
                ja[a["icao"]] = a.get("name")
    except Exception:  # noqa: BLE001
        pass
    return iata2icao, ja


def carrier_of(num):
    return num[:3] if num[:3] in ("CUK", "DAK") else num[:2]


def _norm(n):
    n = str(n).upper().replace(" ", "")
    return n[:2] + (n[2:].lstrip("0") or "0") if len(n) > 2 else n


def build_flights(staging, profiles, extra_airports_json="/workspace/fb-flights/data/airports.json"):
    if not staging:
        return None
    iata2icao, ja = _airport_maps(profiles, extra_airports_json)
    for k, v in ((staging.get("rara") or {}).get("codes") or {}).items():
        iata2icao.setdefault(k, v)
    odpt = staging.get("odptFull") or {}
    for code, name in (odpt.get("airports") or {}).items():
        if name:
            ja.setdefault(iata2icao.get(code, code), name)
    ap = lambda c: iata2icao.get(c, c) if c else c  # noqa: E731
    import datetime as _dt
    _now = _dt.datetime.utcnow() + _dt.timedelta(hours=9)
    today, yday = _now.date().isoformat(), (_now.date() - _dt.timedelta(days=1)).isoformat()
    rows, seen, status = [], set(), {}

    def add(num, dep, arr, std, sta, typ="", days=127, vf=None, vt=None, src="", op="", cs="", note=""):
        k = (num, dep, arr, std)
        if not num or k in seen:
            return False
        seen.add(k)
        rows.append([num, dep, arr, std or "", sta or "", typ or "", days, vf or "", vt or "", src, op or "", cs, note or ""])
        return True

    def bump(code, src, n, fetched, stale=None, fail=None):
        s = status.setdefault(code, {"count": 0, "sources": [], "fetchedAt": None, "stale": None, "fail": None})
        s["count"] += n
        if n and src not in s["sources"]:
            s["sources"].append(src)
        if fetched and (not s["fetchedAt"] or fetched > s["fetchedAt"]):
            s["fetchedAt"] = fetched
        s["stale"] = s["stale"] or stale
        if fail and not n:
            s["fail"] = fail

    # 1) ODPT（JAL・ANA系。運航会社・共同運航番号・曜日・有効期間つき）
    if odpt.get("ok"):
        for r in odpt.get("rows", []):
            alln = [_norm(n) for n in r.get("nums", [])]
            nums = [n for n in alln if carrier_of(n) in IATA2]
            for n in nums:
                cs = " ".join(x for x in alln if x != n)
                if add(n, ap(r["dep"]), ap(r["arr"]), r.get("std"), r.get("sta"), r.get("type"), r.get("days", 127),
                       r.get("from"), r.get("to"), "odpt", r.get("airline"), cs, r.get("note")):
                    bump(carrier_of(n), "odpt", 1, odpt.get("fetchedAt"), odpt.get("staleReason"))
    # 2) ANA 公式PDF（ODPTに無い便の補完）
    pdf = staging.get("anaPdf") or {}
    if pdf.get("ok"):
        for f in pdf.get("flights", []):
            if add("NH" + str(f["number"]), f.get("depIcao"), f.get("arrIcao"), f.get("depTime"), f.get("arrTime"),
                   f.get("aircraftType"), 127, None, None, "ana-pdf"):
                bump("NH", "ana-pdf", 1, pdf.get("fetchedAt"), pdf.get("staleReason"))
    # 3) 旧 wx-brief の会社別取得（公式サイト・PDF）
    for code, v in (staging.get("byAirline") or {}).items():
        i2 = ICAO3_TO_IATA2.get(code)
        if not i2:
            continue
        if not v.get("ok"):
            bump(i2, "", 0, None, None, v.get("failReason"))
            continue
        src = v.get("source") or "official"
        n_added = 0
        for f in v.get("flights", []):
            num = i2 + str(f.get("number", "")).lstrip("0")
            if add(num, f.get("depIcao"), f.get("arrIcao"), f.get("depTime"), f.get("arrTime"), f.get("aircraftType"),
                   127, None, None, src):
                n_added += 1
        bump(i2, src, n_added, v.get("fetchedAt") or staging.get("fetchedAt"), v.get("staleReason"))
    # 4) トキエア公式
    tk = staging.get("toki") or {}
    if tk.get("ok"):
        for f in tk.get("flights", []):
            if f.get("to") and f["to"] < today:
                continue
            if add("BV" + str(f["number"]), f.get("depIcao"), f.get("arrIcao"), f.get("depTime"), f.get("arrTime"), "",
                   f.get("days", 127), f.get("from"), f.get("to"), "toki"):
                bump("BV", "toki", 1, tk.get("fetchedAt"), tk.get("staleReason"))
    have = {r[0] for r in rows}  # 時刻表系の出典にある便名
    # 5) 空港の発着案内（羽田・福岡・那覇。昨日〜明日。時刻表に無い便名だけ）
    bd = staging.get("boards") or {}
    if bd.get("ok"):
        legs = {}
        for b in bd.get("rows", []):
            n = b["c2"] + str(b["num"])
            if n in have or not b.get("date") or b["date"] < yday:
                continue
            k = (n, b["date"], b["ap"] if b["dir"] == "D" else b["other"], b["other"] if b["dir"] == "D" else b["ap"])
            e = legs.setdefault(k, {"std": "", "sta": "", "type": b.get("type") or "", "cs": set(), "boards": set()})
            e["std" if b["dir"] == "D" else "sta"] = b.get("time") or ""
            e["cs"].update(b.get("cs") or [])
            e["boards"].add("ODPT当日運航情報" if b.get("odpt") else b["ap"] + "空港")
            e["type"] = e["type"] or b.get("type") or ""
        grp = {}  # 同じ便名・区間・時刻の日違いを1行にまとめる
        for (n, date, dep, arr), e in sorted(legs.items()):
            g = grp.setdefault((n, dep, arr, e["std"], e["sta"]), {"dates": [], "type": "", "cs": set(), "boards": set()})
            g["dates"].append(date); g["type"] = g["type"] or e["type"]; g["cs"] |= e["cs"]; g["boards"] |= e["boards"]
        for (n, dep, arr, std, sta), g in sorted(grp.items()):
            ds = sorted(g["dates"])
            dow = 0
            for d in ds:
                dow |= [1, 2, 4, 8, 16, 32, 64][__import__("datetime").date.fromisoformat(d).weekday()]
            if add(n, ap(dep), ap(arr), std, sta, g["type"], dow, ds[0], ds[-1], "board", "", " ".join(sorted(g["cs"])),
                   "発着案内（" + "・".join(sorted(g["boards"])) + "）の" + "・".join(d[5:].replace("-", "/") for d in ds) + "分"):
                bump(carrier_of(n), "board", 1, bd.get("fetchedAt"), bd.get("staleReason"))
    have = {r[0] for r in rows}
    # 6) rararakt.com（ユーザー承認の最終手段。上のどれにも無い便名だけ。出典を明示）
    ra = staging.get("rara") or {}
    if ra.get("ok"):
        for f in ra.get("flights", []):
            n = f["c2"] + str(f["number"])
            if n in have or f.get("suspended"):
                continue
            note = "；".join(x for x in ["貨物便" if f.get("cargo") else "", "判読不確実" if f.get("uncertain") else "",
                                        ("経由 " + f["via"]) if f.get("via") else "", f.get("note") or ""] if x)
            if add(n, ap(f["dep"]), ap(f["arr"]), f.get("depTime"), f.get("arrTime"), "", 127,
                   ra.get("schedule", {}).get("from"), ra.get("schedule", {}).get("until"), "rararakt", "", "", note):
                bump(carrier_of(n), "rararakt", 1, ra.get("fetchedAt"), ra.get("staleReason"))
    # 同じ便名・区間で ODPT 行がある時は、時刻だけ違う他ソースの行を落とす（ODPTを正とする）
    odpt_keys = {(r[0], r[1], r[2]) for r in rows if r[9] == "odpt"}
    rows = [r for r in rows if r[9] == "odpt" or (r[0], r[1], r[2]) not in odpt_keys]
    rows.sort(key=lambda r: (carrier_of(r[0]), int("".join(ch for ch in r[0][len(carrier_of(r[0])):] if ch.isdigit()) or 0), r[3]))
    counts = {}
    for r in rows:
        counts[carrier_of(r[0])] = counts.get(carrier_of(r[0]), 0) + 1
    carriers = []
    for c in JP_CARRIERS:
        st = status.get(c[0], {})
        carriers.append({"iata2": c[0] if "*" not in c[0] else None, "code": c[1], "name": c[2],
                         "count": counts.get(c[0], 0) if "*" not in c[0] else 0,
                         "sources": [SRC_LABEL.get(s, s) for s in st.get("sources", [])],
                         "fetchedAt": st.get("fetchedAt"), "stale": st.get("stale"), "fail": st.get("fail")})
    # 運航会社として現れる数（ODPT の airline 欄。JTA・RAC・ORC 等）
    ops = {}
    for r in rows:
        if r[10]:
            ops[r[10]] = ops.get(r[10], 0) + 1
    used = {r[1] for r in rows} | {r[2] for r in rows}
    return {"schema": "flight-buddy-flights/2", "fetchedAt": staging.get("fetchedAt"),
            "note": "時刻は時刻表（現地時刻）。運休・臨時便・当日の遅延は反映しない。",
            "cols": ["num", "dep", "arr", "std", "sta", "type", "days", "from", "to", "src", "op", "codeshare", "note"],
            "carriers": carriers, "operators": ops, "airportNames": {k: v for k, v in ja.items() if k in used and v},
            "rows": rows}
