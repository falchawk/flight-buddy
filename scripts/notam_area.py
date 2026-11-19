"""空域 NOTAM（NOTAM タブの「空域」）：FIR（RJJJ）のエンルート／警報 NOTAM（SWIM）と、全空港の ILS・航法援助の停波 NOTAM から、
「国内を飛ぶパイロットが更新から24時間以内に知っておきたいもの」だけを選び、地図に出せる形（種別・短いラベル・高度帯・期間・図形）にしてパックに入れる。

出所：SWIM デジタルNOTAMリクエストサービス（fetchers/swim/swim.js の fetchNotamArea：fir='RJJJ'＋スコープ enroute／warning を別々に1回ずつ）。
      ILS・航法援助は既存の空港別 NOTAM（fetchNotamFromSwim）から。取得は 6 時間ごと（NOTAM と同じ周期）。個人情報は入らない（公示された NOTAM の内容だけ）。
ふるい：障害灯（QOLAS）・障害物（QOBAW）・取消（NOTAMC）・失効済みは除く。期間が更新から30時間以内に重なるものだけ。
        制限・経路・管制系で45日を超える長期の注意喚起（米軍施設付近の VFR 自粛要請など）は常時出ていて判断に効かないので除く。
"""
import datetime as dt
import re

UTC = dt.timezone.utc
HORIZON_H = 30      # 更新時刻から 24h ＋ 取得周期（6h）の余裕
LONG_DAYS = 45

# 種別：id → (表示名, 色, 既定で表示)
CATS = {
    "volcano": ("火山", "#e8590c", True),
    "navaid": ("航法援助・ILS", "#e03131", True),
    "gnss": ("GNSS", "#9c36b5", True),
    "rocket": ("ロケット・宇宙", "#f59f00", True),
    "restricted": ("制限・訓練空域", "#d6336c", True),
    "route": ("経路・流量", "#1971c2", True),
    "event": ("イベント（航空ショー・花火 他）", "#0ca678", True),
    "atc": ("管制・空域変更", "#5c7cfa", True),
    "uav": ("無人機・気球", "#868e96", False),
}
LONG_OK = {"navaid", "gnss", "volcano", "rocket"}

COORD = re.compile(r"(\d{4}(?:\d{2})?)(\.\d+)?([NS])\s*(\d{5}(?:\d{2})?)(\.\d+)?([EW])")


def _ll(m):
    la, lo = m.group(1), m.group(4)
    lat = int(la[:2]) + int(la[2:4]) / 60 + (int(la[4:6]) / 3600 if len(la) == 6 else 0)
    lon = int(lo[:3]) + int(lo[3:5]) / 60 + (int(lo[5:7]) / 3600 if len(lo) == 7 else 0)
    return [round(lat * (1 if m.group(3) == "N" else -1), 4), round(lon * (1 if m.group(6) == "E" else -1), 4)]


def _t(s):
    try:
        return dt.datetime.strptime(s[:10], "%y%m%d%H%M").replace(tzinfo=UTC)
    except Exception:  # noqa: BLE001
        return None


def _alt(v, kind):
    if v is None:
        return None
    v = v.strip().upper()
    if re.fullmatch(r"\d{3}", v):
        n = int(v)
        if kind == "lower" and n == 0:
            return "SFC"
        if kind == "upper" and n >= 999:
            return "UNL"
        return f"{n * 100}ft" if n < 140 else f"FL{n}"
    return v.replace(" AMSL", "").replace("AMSL", "").strip()


def parse(text):
    """NOTAM 原文 → dict（q, a, b, c, d, e, f, g, kind）。"""
    t = text or ""
    q = re.search(r"Q\)\s*(\w+)/(Q\w{4})/(\w+)/(\w+)/(\w+)/(\d{3})/(\d{3})/(\d{4}[NS]\d{5}[EW])(\d{3})", t)
    a = re.search(r"A\)\s*(\w{4})", t)
    b = re.search(r"B\)\s*(\d{10})", t)
    c = re.search(r"C\)\s*(\d{10}|PERM)", t)
    e = re.search(r"E\)(.*?)(?=\n\s*[FG]\)|\Z)", t, re.S)
    fg = re.search(r"F\)\s*([^\n]*?)\s+G\)\s*([^\n)]+)", t)
    d = re.search(r"D\)(.*?)(?=\n\s*E\))", t, re.S)
    kind = re.search(r"NOTAM([NRC])\b", t)
    return {
        "code": q.group(2) if q else None,
        "qlo": q.group(6) if q else None, "qhi": q.group(7) if q else None,
        "radius": int(q.group(9)) if q else None,
        "qcoord": q.group(8) if q else None,
        "loc": a.group(1) if a else None,
        "from": _t(b.group(1)) if b else None,
        "to": None if (not c or c.group(1) == "PERM") else _t(c.group(1)),
        "perm": bool(c and c.group(1) == "PERM"),
        "sched": re.sub(r"\s+", " ", d.group(1)).strip() if d else None,
        "e": re.sub(r"\s+", " ", e.group(1)).strip() if e else "",
        "f": fg.group(1) if fg else None, "g": fg.group(2) if fg else None,
        "kind": kind.group(1) if kind else "N",
    }


def _qcenter(qc):
    m = re.match(r"(\d{2})(\d{2})([NS])(\d{3})(\d{2})([EW])", qc or "")
    if not m:
        return None
    lat = int(m.group(1)) + int(m.group(2)) / 60
    lon = int(m.group(4)) + int(m.group(5)) / 60
    return [round(lat * (1 if m.group(3) == "N" else -1), 4), round(lon * (1 if m.group(6) == "E" else -1), 4)]


def geometry(p):
    """図形：polygons（多角形のリスト）／circle（中心・半径NM）／point（Q 行の中心）／None（FIR 全域・経路など図にしない）。"""
    e = p["e"]
    upper = e.upper()
    polys = []
    for seg in re.split(r"BOUNDED BY|WI THE COORD|FLW POINTS|WITHIN THE COORD", upper)[1:]:
        seg = re.split(r"RMK|ACT AS|NAME/ID|\b\d\)\s", seg)[0]
        pts = [_ll(m) for m in COORD.finditer(seg)]
        if len(pts) >= 3:
            polys.append(pts[:-1] if pts[0] == pts[-1] else pts)
    if polys:
        return {"type": "poly", "polys": polys}
    m = re.search(r"RADIUS\s*(?:OF)?\s*(\d+(?:\.\d+)?)\s*(NM|KM|M)\b.*?(?:CENTER|CENTRE|OF)\s*" + COORD.pattern, upper)
    if not m:
        m = re.search(r"RADIUS\s*(?:OF)?\s*(\d+(?:\.\d+)?)\s*(NM|KM|M)\b.*?" + COORD.pattern, upper)
    if m:
        r = float(m.group(1))
        nm = r if m.group(2) == "NM" else r / 1.852 if m.group(2) == "KM" else r / 1852
        cm = COORD.search(upper[m.start():])
        return {"type": "circle", "c": _ll(cm), "rNm": round(nm, 3)}
    c = _qcenter(p["qcoord"])
    if c and p["radius"] is not None and p["radius"] < 100:
        return {"type": "circle", "c": c, "rNm": float(p["radius"])} if p["code"] and p["code"][1] in "RW" else {"type": "point", "c": c}
    return None


def classify(p):
    """(cat, label) か None（載せない）。"""
    code, up = p["code"] or "", (p["e"] or "").upper()
    if code in ("QOLAS", "QOBAW") or code.startswith("QO"):
        return None
    if "NO LONGER IN FORCE" in up or p["kind"] == "C":
        return None
    unavail = re.search(r"U/S|UNSERVICEABLE|OUT OF SERVICE|DO NOT USE|ON TEST|NOT AVBL|SUSPEND|UNRELIABLE|NOT PROVIDED|CLSD|CLOSED", up)
    if re.search(r"VOLCAN|ERUPT|ASH CLOUD|\bVA\b", up):
        return "volcano", "火山灰・噴火"
    if re.search(r"\bGNSS\b|\bGPS\b|\bRAIM\b|\bGBAS\b|\bSBAS\b", up) and re.search(r"INTERFER|JAMM|TEST|UNRELIABLE|U/S|OUTAGE|NOT AVBL", up):
        return "gnss", "GNSS干渉・試験" if re.search(r"INTERFER|JAMM|TEST", up) else "GNSS停止"
    if re.search(r"MODEL ROCKET", up):
        return "rocket", "模型ロケット"
    if re.search(r"ROCKET|SPACE DEBRIS|SPACE LAUNCH|LAUNCH VEHICLE|RE-?ENTRY|SPLASHDOWN", up) and "ANTIBALLISTIC" not in up:
        return "rocket", "ロケット" if "DEBRIS" not in up else "宇宙デブリ"
    if code.startswith("QI") and unavail:
        return "navaid", ("LOC停波" if re.search(r"\bLOC\b|LOCALI[ZS]ER", up) and "ILS" not in up else "GP停波" if re.search(r"GLIDE|\bGP\b", up) and "ILS" not in up else "ILS停波")
    if code.startswith("QN") or re.search(r"\b(VORTAC|VOR|DME|TACAN|NDB|TACAN)\b", up) and unavail and not code.startswith(("QR", "QW")):
        for k, lab in (("VORTAC", "VORTAC"), ("TACAN", "TACAN"), ("VOR", "VOR"), ("DME", "DME"), ("NDB", "NDB")):
            if re.search(rf"\b{k}\b", up):
                return "navaid", f"{lab}{'試験中' if 'ON TEST' in up else '停波'}"
        return "navaid", "航法援助停波"
    if code == "QWULW" or "UNMANNED" in up:
        return "uav", "無人機"
    if code == "QWLLW" or "BALLOON" in up:
        return "uav", "気球"
    if code == "QWALW" or "AIR DISPLAY" in up:
        return "event", "航空ショー"
    if code == "QWBLW" or "AEROBATIC" in up:
        return "event", "曲技飛行"
    if code == "QWHLW" or "FIREWORK" in up:
        return "event", "花火" if "FIREWORK" in up else "発破"
    if code == "QWPLW" or re.search(r"PJE|PARACHUTE|PARAGLID|HANG GLID", up):
        return "event", "パラシュート降下" if re.search(r"PJE|PARACHUTE", up) else "パラグライダー"
    if code == "QWGLW" or "GLIDER" in up:
        return "event", "グライダー"
    if code == "QWVLW" or "FORMATION" in up:
        return "event", "編隊飛行"
    if code == "QWELW" or code == "QWMLW" or re.search(r"FRNG|FIRING|SHOOTING", up):
        if re.search(r"FRNG|FIRING|SHOOTING|WEAPON", up):
            return "restricted", "射撃訓練"
        if "SIGNAL FLARE" in up:
            return "event", "信号弾"
        if "SAR" in up:
            return "restricted", "救難訓練"
        return "restricted", "訓練空域"
    if re.search(r"TEMPO RESERVED|RESERVED AIRSPACE", up):
        return "restricted", "臨時空域"
    if re.search(r"HIGH ALT TRAINING|TRAINING/TESTING AREA|TRAINING AREA", up):
        return "restricted", "高高度訓練空域" if "HIGH ALT" in up else "訓練空域"
    if re.search(r"U\.?S\.? MIL|MIL ACT|JAPAN SELF DEFENCE FORCE ACT|SELF DEFENSE FORCE ACT|MILITARY", up):
        return "restricted", "米軍訓練" if re.search(r"U\.?S\.? MIL", up) else "自衛隊訓練"
    if "WARNING AREA" in up and code.startswith("QR"):
        return "restricted", "警戒空域"
    if code in ("QRACA", "QRDCA", "QRTCA", "QRMCA", "QRPCA", "QRRCA", "QROXX", "QRACH") or code.startswith("QR"):
        return "restricted", {"QRDCA": "危険空域", "QRPCA": "飛行禁止", "QRRCA": "制限空域", "QRTCA": "臨時制限空域", "QRMCA": "訓練空域"}.get(code, "制限・訓練空域")
    if code.startswith("QPF") or "FLOW CTL" in up:
        return "route", "流量制限"
    if code.startswith("QA") or re.search(r"\bATS RTE\b|ATS ROUTE|AIRWAY|\bRTE\b", up):
        return "route", "経路閉鎖" if re.search(r"CLSD|CLOSED|NOT AVBL|U/S", up) else "経路変更"
    if code.startswith("QS") or code.startswith("QC") or re.search(r"RADAR SER|CPDLC|FREQ", up):
        if "CPDLC" in up:
            return "atc", "CPDLC停止"
        if "RADAR" in up:
            return "atc", "レーダー管制停止"
        return "atc", "管制サービス変更"
    return None


def build(swim, now=None):
    """swim.json → パックの notam_area.json（dict）。"""
    n = (swim or {}).get("notam") or {}
    area = n.get("area") or {}
    now = now or dt.datetime.now(UTC)
    t0 = dt.datetime.strptime(area.get("fetchedAt") or n.get("fetchedAt"), "%Y-%m-%dT%H:%M:%SZ").replace(tzinfo=UTC) if (area.get("fetchedAt") or n.get("fetchedAt")) else now
    horizon = t0 + dt.timedelta(hours=HORIZON_H)
    raw = list(area.get("items") or [])
    seen = {(x.get("id"), x.get("icao")) for x in raw}
    for x in n.get("items") or []:     # 既存の空港別 NOTAM から ILS・航法援助（QI/QN）だけ
        if (x.get("id"), x.get("icao")) in seen:
            continue
        if re.search(r"Q\)\s*\w+/Q[IN]\w{3}/", x.get("text") or ""):
            raw.append(x)
    out, drop = [], {"obst": 0, "nocat": 0, "time": 0, "long": 0, "cancel": 0}
    ids = set()
    for x in raw:
        p = parse(x.get("text"))
        key = (x.get("id"), p["loc"] or x.get("icao"))
        if key in ids:
            continue
        ids.add(key)
        if p["code"] and p["code"].startswith("QO"):
            drop["obst"] += 1
            continue
        if p["kind"] == "C":
            drop["cancel"] += 1
            continue
        f, to = p["from"], p["to"]
        if f is None or f > horizon or (to is not None and to < t0):
            drop["time"] += 1
            continue
        c = classify(p)
        if not c:
            drop["nocat"] += 1
            continue
        cat, label = c
        if cat not in LONG_OK and ((to or f + dt.timedelta(days=3650)) - f) > dt.timedelta(days=LONG_DAYS) and (f <= t0):
            drop["long"] += 1
            continue
        lo = _alt(p["f"], "lower") if p["f"] else _alt(p["qlo"], "lower")
        hi = _alt(p["g"], "upper") if p["g"] else _alt(p["qhi"], "upper")
        g = geometry(p)
        if g and g["type"] == "point" and cat not in ("navaid",):
            g = None
        nm = re.search(r"\b([RWDP]-\d{1,4})\b", p["e"].upper())
        out.append({
            "name": nm.group(1) if nm else None,
            "id": x.get("id") or "", "loc": p["loc"] or x.get("icao"), "code": p["code"], "cat": cat, "label": label,
            "lower": lo, "upper": hi,
            "from": f.strftime("%Y-%m-%dT%H:%M:00Z"), "to": to.strftime("%Y-%m-%dT%H:%M:00Z") if to else None, "perm": p["perm"],
            "sched": p["sched"], "geom": g, "text": p["e"][:260], "raw": (x.get("text") or "").strip()[:1500],
        })
    out.sort(key=lambda i: (i["from"], i["id"]))
    counts = {}
    for i in out:
        counts[i["cat"]] = counts.get(i["cat"], 0) + 1
    return {
        "schema": "flight-buddy-notam-area/1", "ok": bool(raw) and bool(area.get("ok") or area.get("carriedOver")),
        "fetchedAt": (area.get("fetchedAt") or n.get("fetchedAt")), "note": area.get("note"),
        "source": "SWIM デジタルNOTAMリクエストサービス（FIR RJJJ のエンルート・警報、全空港の ILS/航法援助）",
        "cats": {k: {"label": v[0], "color": v[1], "default": v[2]} for k, v in CATS.items()},
        "counts": counts, "dropped": drop, "rawCount": len(raw), "items": out,
    }
