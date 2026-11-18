#!/usr/bin/env python3
"""
Flight Buddy pack builder
=========================
地上（ボットの端末）で実行し、オフライン用の「パック」を data/ 以下に書き出す。
標準ライブラリのみ。ネット取得はすべてリトライ付き。

出力:
  data/packs/<packId>/manifest.json   … そのパックの目録（全ファイル一覧＋sha256）
  data/packs/<packId>/wx.json         … METAR/TAF（aviationweather.gov）
  data/packs/<packId>/notam.json      … NOTAM（--notam-file で渡されたもの / 無ければ未取得）
  data/packs/<packId>/airports.json   … 空港プロファイル（滑走路・周波数・日の出日没 等）
  data/packs/<packId>/brief.json      … ボットが書いたブリーフ本文（--brief）
  data/packs/<packId>/charts.json     … 図のメタデータ
  data/packs/<packId>/charts/*        … 図の画像
  data/latest/manifest.json           … 最新パックの目録（アプリはまずこれを見る）
  data/previous/manifest.json         … 1つ前のパックの目録
  data/index.json                     … 保持中パックの一覧

使い方の例:
  python3 scripts/build_pack.py --brief /workspace/brief.md --charts-dir /workspace/metair --allow-restricted
  python3 scripts/build_pack.py --sample-charts --publish
"""
import argparse
import datetime as dt
import hashlib
import json
import math
import mimetypes
import os
import re
import shutil
import subprocess
import sys
import time
import urllib.error
import urllib.request

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
DATA = os.path.join(ROOT, "data")
SCHEMA = "flight-buddy-pack/1"
AWC = "https://aviationweather.gov/api/data"
UA = "FlightBuddyPackBuilder/1.0 (personal briefing tool)"
IMAGE_EXT = {".png", ".jpg", ".jpeg", ".gif", ".webp", ".svg"}
JST = dt.timezone(dt.timedelta(hours=9))


def log(*a):
    print("[build_pack]", *a, file=sys.stderr)


def utcnow():
    return dt.datetime.now(dt.timezone.utc).replace(microsecond=0)


def iso(t):
    return t.astimezone(dt.timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")


# ----------------------------------------------------------------------------- network
def http_get_json(url, retries=4, timeout=20):
    """GETしてJSONを返す。失敗時は指数バックオフでリトライ。204(該当なし)は[]。"""
    last = None
    for i in range(retries):
        try:
            req = urllib.request.Request(url, headers={"User-Agent": UA, "Accept": "application/json"})
            with urllib.request.urlopen(req, timeout=timeout) as r:
                if r.status == 204:
                    return []
                body = r.read().decode("utf-8")
                return json.loads(body) if body.strip() else []
        except Exception as e:  # noqa: BLE001
            last = e
            wait = 2 ** i
            log(f"GET失敗 ({i+1}/{retries}) {url} : {e} → {wait}s後に再試行")
            time.sleep(wait)
    raise RuntimeError(f"取得失敗: {url}: {last}")


# ----------------------------------------------------------------------------- sun
def sun_times(lat, lon, date, zenith=90.833):
    """NOAAの簡易式で日の出・日没(UTC datetime)を返す。極夜/白夜はNone。"""
    def calc(rising):
        n = date.timetuple().tm_yday
        lng_hour = lon / 15.0
        t = n + ((6 if rising else 18) - lng_hour) / 24.0
        m = 0.9856 * t - 3.289
        l = (m + 1.916 * math.sin(math.radians(m)) + 0.020 * math.sin(math.radians(2 * m)) + 282.634) % 360
        ra = math.degrees(math.atan(0.91764 * math.tan(math.radians(l)))) % 360
        ra = (ra + (math.floor(l / 90) * 90 - math.floor(ra / 90) * 90)) / 15.0
        sin_dec = 0.39782 * math.sin(math.radians(l))
        cos_dec = math.cos(math.asin(sin_dec))
        cos_h = (math.cos(math.radians(zenith)) - sin_dec * math.sin(math.radians(lat))) / (cos_dec * math.cos(math.radians(lat)))
        if cos_h > 1 or cos_h < -1:
            return None
        h = (360 - math.degrees(math.acos(cos_h))) if rising else math.degrees(math.acos(cos_h))
        h /= 15.0
        tt = h + ra - 0.06571 * t - 6.622
        ut = (tt - lng_hour) % 24
        base = dt.datetime(date.year, date.month, date.day, tzinfo=dt.timezone.utc)
        return base + dt.timedelta(hours=ut)
    return calc(True), calc(False)


def fix_sun_day(t, local_date):
    """UTC計算で日付がずれた場合にJSTの同日に寄せる。"""
    if t is None:
        return None
    lt = t.astimezone(JST)
    if lt.date() < local_date:
        t += dt.timedelta(days=1)
    elif lt.date() > local_date:
        t -= dt.timedelta(days=1)
    return t


# ----------------------------------------------------------------------------- fetchers
def fetch_wx(airports, prev_wx):
    ids = ",".join(airports)
    now = iso(utcnow())
    out = {"source": "aviationweather.gov (NOAA/AWC)", "fetchedAt": now, "airports": {}}
    metars, tafs, err_m, err_t = [], [], None, None
    for chunk in chunks(airports, 60):
        ids = ",".join(chunk)
        try:
            metars += http_get_json(f"{AWC}/metar?ids={ids}&format=json&hours=3")
        except Exception as e:  # noqa: BLE001
            err_m = str(e)
        try:
            tafs += http_get_json(f"{AWC}/taf?ids={ids}&format=json")
        except Exception as e:  # noqa: BLE001
            err_t = str(e)
    for icao in airports:
        ms = sorted([m for m in metars if m.get("icaoId") == icao], key=lambda m: m.get("obsTime", 0), reverse=True)
        ts = [t for t in tafs if t.get("icaoId") == icao]
        ts.sort(key=lambda t: t.get("issueTime", ""), reverse=True)
        entry = {
            "icao": icao,
            "ok": bool(ms or ts),
            "fetchedAt": now,
            "metar": [
                {"raw": m.get("rawOb"), "obsTime": iso(dt.datetime.fromtimestamp(m["obsTime"], dt.timezone.utc)) if m.get("obsTime") else None,
                 "fltCat": m.get("fltCat"), "type": m.get("metarType")}
                for m in ms[:4]
            ],
            "taf": ({"raw": ts[0].get("rawTAF"), "issueTime": ts[0].get("issueTime"),
                     "validFrom": iso(dt.datetime.fromtimestamp(ts[0]["validTimeFrom"], dt.timezone.utc)) if ts[0].get("validTimeFrom") else None,
                     "validTo": iso(dt.datetime.fromtimestamp(ts[0]["validTimeTo"], dt.timezone.utc)) if ts[0].get("validTimeTo") else None}
                    if ts else None),
            "error": None,
        }
        if not entry["ok"]:
            entry["error"] = err_m or err_t or "該当データなし"
            prev = (prev_wx or {}).get("airports", {}).get(icao)
            if prev and prev.get("ok"):
                log(f"{icao}: 取得失敗のため前回パックの値を引き継ぎ（STALE表示）")
                prev = dict(prev)
                prev["carriedOver"] = True
                prev["error"] = entry["error"]
                entry = prev
        out["airports"][icao] = entry
    return out


def chunks(lst, n):
    for i in range(0, len(lst), n):
        yield lst[i:i + n]


def fetch_airport_profiles(airports, cfg, pack_date, stations=None):
    static = cfg.get("airport_static", {})
    info = []
    for chunk in chunks(airports, 60):
        try:
            info += http_get_json(f"{AWC}/airport?ids={','.join(chunk)}&format=json")
        except Exception as e:  # noqa: BLE001
            log("空港情報の取得失敗:", e)
    by = {a.get("icaoId"): a for a in info}
    out = {"source": "aviationweather.gov airport API + 端末内計算(日の出日没)", "airports": {}}
    for icao in airports:
        a = by.get(icao, {})
        st = static.get(icao, {})
        stn = (stations or {}).get(icao, {})
        lat, lon = a.get("lat", stn.get("lat")), a.get("lon", stn.get("lon"))
        sun = []
        if lat is not None and lon is not None:
            for d in range(2):
                day = pack_date + dt.timedelta(days=d)
                sr, ss = sun_times(lat, lon, day)
                sr, ss = fix_sun_day(sr, day), fix_sun_day(ss, day)
                sun.append({"date": day.isoformat(),
                            "sunriseJst": sr.astimezone(JST).strftime("%H:%M") if sr else None,
                            "sunsetJst": ss.astimezone(JST).strftime("%H:%M") if ss else None})
        freqs = []
        for part in (a.get("freqs") or "").split(";"):
            if "," in part:
                k, v = part.split(",", 1)
                freqs.append({"type": k.strip(), "mhz": v.strip()})
        out["airports"][icao] = {
            "icao": icao,
            "iata": a.get("iataId") or stn.get("iataId"),
            "name": a.get("name") or (stations or {}).get(icao, {}).get("site"),
            "lat": lat, "lon": lon,
            "elevationFt": round(a["elev"] * 3.28084) if isinstance(a.get("elev"), (int, float)) else None,
            "magdec": a.get("magdec"),
            "runways": [{"id": r.get("id"), "dimensionFt": r.get("dimension"), "surface": r.get("surface"),
                         "alignment": r.get("alignment")} for r in a.get("runways", [])],
            "freqs": freqs,
            "sun": sun,
            "operatingHours": st.get("operatingHours"),
            "approaches": st.get("approaches"),
            "notes": st.get("notes"),
        }
    return out


def load_notams(path, airports):
    if not path:
        return {"ok": False, "source": None,
                "note": "無料で安定して使える公開NOTAMソースが無いため未取得（スタブ）。ボットがSWIM等から取得した内容を --notam-file で渡すと表示されます。",
                "airports": {i: {"items": []} for i in airports}}
    with open(path, encoding="utf-8") as f:
        d = json.load(f)
    d.setdefault("ok", True)
    d.setdefault("airports", {})
    for i in airports:
        d["airports"].setdefault(i, {"items": []})
    return d


# ----------------------------------------------------------------------------- charts
CS_RE = re.compile(r"CS_(?P<route>[A-Za-z]+-[A-Za-z]+)_(?P<kind>ANALYSIS|FORECAST)_(?P<date>\d{8})_(?P<hhmm>\d{4})UTC", re.I)
PLAN_RE = re.compile(r"CSA\w*?_FL(?P<fl>\d{3}).*?_(?P<hhmm>\d{4})UTC", re.I)
ROUTE_JA = {"fukuoka": "福岡", "tokyo": "東京", "sapporo": "札幌", "osaka": "大阪", "naha": "那覇", "wakkanai": "稚内"}


def infer_chart_meta(fname):
    """ファイル名から図の種類を推定（sidecarが無い時用）。"""
    base = os.path.splitext(fname)[0]
    m = CS_RE.search(base)
    if m:
        a, b = m.group("route").split("-")
        route = f"{ROUTE_JA.get(a.lower(), a)}-{ROUTE_JA.get(b.lower(), b)}"
        kind = "解析" if m.group("kind").upper() == "ANALYSIS" else "予想"
        d = m.group("date")
        return {"title": f"三十分大気解析 断面図 {route}（{kind}）", "category": "断面図",
                "validTime": f"{d[:4]}-{d[4:6]}-{d[6:]}T{m.group('hhmm')[:2]}:{m.group('hhmm')[2:]}:00Z",
                "source": "JMA MetAir", "restricted": True}
    m = PLAN_RE.search(base)
    if m:
        return {"title": f"三十分大気解析 平面図 FL{m.group('fl')}", "category": "平面図",
                "validTimeHint": f"{m.group('hhmm')}Z", "source": "JMA MetAir", "restricted": True}
    return {"title": base, "category": "その他", "source": "unknown", "restricted": True}


def collect_charts(charts_dir, dest_dir, allow_restricted, public_repo):
    charts, skipped = [], []
    if not charts_dir:
        return charts, skipped
    sidecar = {}
    sc_path = os.path.join(charts_dir, "charts.json")
    if os.path.exists(sc_path):
        with open(sc_path, encoding="utf-8") as f:
            raw = json.load(f)
        for c in raw.get("charts", raw if isinstance(raw, list) else []):
            sidecar[c["file"]] = c
    os.makedirs(dest_dir, exist_ok=True)
    for fname in sorted(os.listdir(charts_dir)):
        ext = os.path.splitext(fname)[1].lower()
        if ext not in IMAGE_EXT:
            continue
        meta = infer_chart_meta(fname)
        meta.update(sidecar.get(fname, {}))
        if meta.get("restricted", True) and public_repo and not allow_restricted:
            skipped.append(fname)
            continue
        safe = re.sub(r"[^A-Za-z0-9._-]", "_", fname)
        shutil.copy2(os.path.join(charts_dir, fname), os.path.join(dest_dir, safe))
        meta["file"] = f"charts/{safe}"
        meta.setdefault("id", os.path.splitext(safe)[0])
        meta.setdefault("sample", False)
        charts.append(meta)
    order = {f: i for i, f in enumerate(sidecar)}
    charts.sort(key=lambda c: order.get(os.path.basename(c["file"]), len(order)))
    return charts, skipped


def sample_chart_svg(title, sub, hue):
    lines = "".join(
        f'<line x1="0" y1="{y}" x2="1200" y2="{y}" stroke="#2a3442" stroke-width="1"/>' for y in range(0, 800, 50))
    lines += "".join(
        f'<line x1="{x}" y1="0" x2="{x}" y2="800" stroke="#2a3442" stroke-width="1"/>' for x in range(0, 1200, 50))
    waves = "".join(
        f'<path d="M0 {200+i*90} C 300 {120+i*90}, 600 {300+i*90}, 1200 {180+i*90}" stroke="hsl({hue},70%,{55-i*5}%)" stroke-width="3" fill="none"/>'
        for i in range(5))
    return f'''<svg xmlns="http://www.w3.org/2000/svg" width="1200" height="800" viewBox="0 0 1200 800">
<rect width="1200" height="800" fill="#0f141c"/>{lines}{waves}
<text x="600" y="360" font-size="120" font-weight="700" text-anchor="middle" fill="#d8b34a" opacity="0.85" font-family="sans-serif">SAMPLE / 見本</text>
<text x="600" y="450" font-size="40" text-anchor="middle" fill="#e8ecf1" font-family="sans-serif">{title}</text>
<text x="600" y="510" font-size="28" text-anchor="middle" fill="#9aa7b4" font-family="sans-serif">{sub}</text>
<text x="600" y="760" font-size="22" text-anchor="middle" fill="#9aa7b4" font-family="sans-serif">実データではありません。表示確認用のプレースホルダーです。</text>
</svg>'''


def make_sample_charts(dest_dir):
    os.makedirs(dest_dir, exist_ok=True)
    specs = [
        ("sample_plan_FL450", "三十分大気解析 平面図 FL450（見本）", "平面図", 200),
        ("sample_plan_FL300", "三十分大気解析 平面図 FL300（見本）", "平面図", 160),
        ("sample_cs_fukuoka_tokyo_analysis", "断面図 福岡-東京（解析・見本）", "断面図", 320),
        ("sample_cs_fukuoka_tokyo_fcst1h", "断面図 福岡-東京（1時間後予想・見本）", "断面図", 20),
    ]
    out = []
    for cid, title, cat, hue in specs:
        with open(os.path.join(dest_dir, cid + ".svg"), "w", encoding="utf-8") as f:
            f.write(sample_chart_svg(title, "Flight Buddy placeholder chart", hue))
        out.append({"id": cid, "title": title, "category": cat, "file": f"charts/{cid}.svg",
                    "source": "SAMPLE（プレースホルダー）", "sample": True, "restricted": False,
                    "note": "MetAir画像は公開リポジトリに載せないため見本画像を表示しています。"})
    return out


# ----------------------------------------------------------------------------- pack io
def read_json(path, default=None):
    try:
        with open(path, encoding="utf-8") as f:
            return json.load(f)
    except Exception:  # noqa: BLE001
        return default


def write_json(path, obj):
    os.makedirs(os.path.dirname(path), exist_ok=True)
    with open(path, "w", encoding="utf-8") as f:
        json.dump(obj, f, ensure_ascii=False, indent=1)
        f.write("\n")


def sha256(path):
    h = hashlib.sha256()
    with open(path, "rb") as f:
        for chunk in iter(lambda: f.read(65536), b""):
            h.update(chunk)
    return h.hexdigest()


# ----------------------------------------------------------------------------- airport set
STATION_CACHE = os.path.join(DATA, ".cache", "stations_jp.json")
ICAO_RE = re.compile(r"^[A-Z]{4}$")


def japan_stations():
    """aviationweather.gov の局一覧から日本(METAR/TAFあり)を取得。24hキャッシュ、失敗時は古いキャッシュ。"""
    cached = read_json(STATION_CACHE)
    if cached and time.time() - cached.get("ts", 0) < 86400:
        return cached["stations"]
    try:
        d = http_get_json(f"{AWC}/stationinfo?bbox=20,122,46,154&format=json", retries=3)
        st = {s["icaoId"]: {"site": s.get("site"), "iataId": s.get("iataId"), "lat": s.get("lat"), "lon": s.get("lon"),
                             "siteType": s.get("siteType")}
              for s in d if s.get("country") == "JP" and set(s.get("siteType") or []) & {"METAR", "TAF"}}
        if st:
            write_json(STATION_CACHE, {"ts": time.time(), "stations": st})
            return st
    except Exception as e:  # noqa: BLE001
        log("局一覧の取得失敗:", e)
    if cached:
        log("古い局一覧キャッシュを使用")
        return cached["stations"]
    return {}


def sync_issue_airports(repo):
    """GitHub issue（label airports-sync、作成者=リポジトリ所有者）の最新1件からICAOを読む。gh が無ければ空。"""
    owner = repo.split("/")[0]
    try:
        out = subprocess.run(["gh", "issue", "list", "-R", repo, "--label", "airports-sync", "--state", "all",
                              "--author", owner, "--limit", "1", "--json", "number,body,createdAt"],
                             capture_output=True, text=True, timeout=30, check=True).stdout
        items = json.loads(out or "[]")
    except Exception as e:  # noqa: BLE001
        log("airports-sync issue 読み取り失敗（無視）:", e)
        return [], None
    if not items:
        return [], None
    body = items[0].get("body") or ""
    m = re.search(r"AIRPORTS\s*:\s*([A-Za-z0-9 ,]+)", body)
    toks = re.findall(r"[A-Za-z]{4}", m.group(1) if m else body)
    icaos = [t.upper() for t in toks if ICAO_RE.match(t.upper())][:40]
    return icaos, {"issue": items[0]["number"], "createdAt": items[0]["createdAt"], "airports": icaos}


def resolve_airports(cfg, override=None):
    stations = japan_stations()
    if override:
        return [a.strip().upper() for a in override.split(",") if a.strip()], stations, None
    s = set()
    if cfg.get("airport_set") == "japan_all":
        s |= set(stations)
    s |= {a.upper() for a in cfg.get("airports", []) + cfg.get("extra_airports", [])}
    s |= {a.upper() for a in cfg.get("default_airports", [])}
    sync = None
    if cfg.get("sync_repo"):
        extra, sync = sync_issue_airports(cfg["sync_repo"])
        s |= set(extra)
    return sorted(a for a in s if ICAO_RE.match(a)), stations, sync


# ----------------------------------------------------------------------------- brief / charts helpers
def auto_brief_text(wx, focus):
    lines = ["# 自動サマリー（METAR/TAF）", "ボットのブリーフ本文が更新されていない時の自動生成です。"]
    for icao in focus:
        e = wx["airports"].get(icao)
        if not e or not e.get("ok"):
            lines.append(f"- **{icao}**：未取得")
            continue
        m = (e.get("metar") or [{}])[0]
        gusts = [int(g) for g in re.findall(r"\d{3}\d{2,3}G(\d{2,3})KT", (e.get("taf") or {}).get("raw") or "")]
        lines.append(f"- **{icao}** {m.get('fltCat') or ''}：{m.get('raw') or 'METARなし'}"
                     + (f"（TAF最大ガスト {max(gusts)}kt）" if gusts else ""))
    return "\n".join(lines)


def newest_valid(charts):
    v = [c.get("validTime") or "" for c in charts]
    return max(v) if v else ""


def staging_charts_meta(charts_dir):
    sc = read_json(os.path.join(charts_dir, "charts.json"), {}) or {}
    return sc.get("charts", sc if isinstance(sc, list) else [])


def pack_signature(pack_dir):
    """生成時刻を除いた中身の指紋（変化が無ければ公開をスキップするため）。"""
    h = hashlib.sha256()
    wx = read_json(os.path.join(pack_dir, "wx.json"), {})
    for icao, e in sorted(wx.get("airports", {}).items()):
        h.update(icao.encode())
        for m in e.get("metar") or []:
            h.update((m.get("raw") or "").encode())
        h.update(((e.get("taf") or {}).get("raw") or "").encode())
    for name in ("notam.json", "brief.json"):
        d = read_json(os.path.join(pack_dir, name), {})
        d.pop("fetchedAt", None)
        h.update(json.dumps(d, sort_keys=True, ensure_ascii=False).encode())
    for dirpath, _, names in sorted(os.walk(os.path.join(pack_dir, "charts"))):
        for n in sorted(names):
            h.update(n.encode())
            h.update(sha256(os.path.join(dirpath, n)).encode())
    return h.hexdigest()


# ----------------------------------------------------------------------------- main
def build(args):
    cfg = read_json(args.config, {}) or {}
    airports, stations, sync = resolve_airports(cfg, args.airports)
    if not airports:
        raise SystemExit("空港が指定されていません (--airports か config)")
    public_repo = cfg.get("public_repo", True)
    keep = args.keep or cfg.get("keep_packs", 3)
    default_airports = cfg.get("default_airports") or airports[:2]

    now = utcnow()
    pack_id = now.strftime("%Y%m%dT%H%M%SZ")
    pack_dir = os.path.join(DATA, "packs", pack_id)
    os.makedirs(pack_dir, exist_ok=True)
    prev_manifest = read_json(os.path.join(DATA, "latest", "manifest.json"))
    prev_dir = os.path.join(DATA, "packs", prev_manifest["packId"]) if prev_manifest else None
    if prev_dir and not os.path.isdir(prev_dir):
        prev_dir = None
    prev_wx = read_json(os.path.join(prev_dir, "wx.json")) if prev_dir else None

    try:
        log(f"METAR/TAF取得: {len(airports)}空港")
        wx = fetch_wx(airports, prev_wx)
        write_json(os.path.join(pack_dir, "wx.json"), wx)
        ok_n = sum(1 for e in wx["airports"].values() if e.get("ok") and not e.get("carriedOver"))
        if ok_n == 0:
            raise RuntimeError("METAR/TAF が1空港も取得できませんでした（aviationweather.gov 障害？）")

        log("空港プロファイル作成")
        prev_prof = read_json(os.path.join(prev_dir, "airports.json")) if prev_dir else None
        profiles = fetch_airport_profiles(airports, cfg, now.astimezone(JST).date(), stations)
        if prev_prof:  # 取得できなかった滑走路等は前回値を流用
            for icao, p in profiles["airports"].items():
                pp = prev_prof.get("airports", {}).get(icao)
                if pp and not p.get("runways"):
                    for k in ("runways", "freqs", "elevationFt", "magdec", "name", "iata"):
                        p[k] = p.get(k) or pp.get(k)
        write_json(os.path.join(pack_dir, "airports.json"), profiles)

        notam_file = args.notam_file if args.notam_file and os.path.exists(args.notam_file) else None
        write_json(os.path.join(pack_dir, "notam.json"), load_notams(notam_file, airports))

        # ---- brief
        prev_brief = read_json(os.path.join(prev_dir, "brief.json")) if prev_dir else None
        brief = None
        if args.brief and os.path.exists(args.brief):
            mtime = iso(dt.datetime.fromtimestamp(os.path.getmtime(args.brief), dt.timezone.utc))
            if not args.brief_if_newer or not prev_brief or not prev_brief.get("writtenAt") or mtime > prev_brief["writtenAt"] \
                    or not prev_brief.get("ok"):
                with open(args.brief, encoding="utf-8") as f:
                    brief = {"ok": True, "text": f.read(), "author": "Grok Bot", "writtenAt": mtime, "carriedOver": False}
        if brief is None and prev_brief and prev_brief.get("ok"):
            brief = dict(prev_brief)
            brief["carriedOver"] = True
        if brief is None:
            brief = {"ok": False, "text": None, "author": None, "writtenAt": None}
        brief["autoText"] = auto_brief_text(wx, default_airports)
        write_json(os.path.join(pack_dir, "brief.json"), brief)

        # ---- charts
        charts, skipped, chart_mode = [], [], "none"
        allow_restricted = args.allow_restricted or bool(cfg.get("include_restricted", False))
        prev_charts = (read_json(os.path.join(prev_dir, "charts.json"), {}) or {}).get("charts", []) if prev_dir else []
        prev_charts = [c for c in prev_charts if not c.get("sample")]
        use_staging = False
        if args.charts_dir and os.path.isdir(args.charts_dir):
            if args.charts_if_newer and prev_charts:
                st_meta = staging_charts_meta(args.charts_dir)
                use_staging = bool(st_meta) and newest_valid(st_meta) > newest_valid(prev_charts)
                if not use_staging:
                    log("ステージングの図は公開済みより新しくないため前回の図を引き継ぎ")
            else:
                use_staging = True
        if use_staging:
            charts, skipped = collect_charts(args.charts_dir, os.path.join(pack_dir, "charts"), allow_restricted, public_repo)
            chart_mode = "new"
        elif prev_charts and not args.no_carry_charts:
            os.makedirs(os.path.join(pack_dir, "charts"), exist_ok=True)
            for c in prev_charts:
                src = os.path.join(prev_dir, c["file"])
                if os.path.exists(src):
                    shutil.copy2(src, os.path.join(pack_dir, c["file"]))
                    charts.append(c)
            chart_mode = "carried"
        if skipped:
            log(f"restricted のため除外した図 {len(skipped)} 件: {', '.join(skipped)}（含めるには --allow-restricted）")
        if args.sample_charts:
            charts += make_sample_charts(os.path.join(pack_dir, "charts"))
        write_json(os.path.join(pack_dir, "charts.json"), {"charts": charts, "skippedRestricted": skipped, "mode": chart_mode})

        duty = read_json(args.duty_file) if args.duty_file else (prev_manifest or {}).get("duty")

        signature = pack_signature(pack_dir)
        if args.skip_if_unchanged and prev_manifest and prev_manifest.get("signature") == signature:
            shutil.rmtree(pack_dir)
            log("前回パックから変化なし → 新しいパックは作りません")
            return {"changed": False, "packId": prev_manifest["packId"], "airports": len(prev_manifest.get("airports", [])),
                    "charts": len(prev_charts), "chartMode": "unchanged"}
    except BaseException:
        shutil.rmtree(pack_dir, ignore_errors=True)
        raise

    files = []
    for dirpath, _, names in os.walk(pack_dir):
        for n in sorted(names):
            if n == "manifest.json":
                continue
            p = os.path.join(dirpath, n)
            rel = os.path.relpath(p, pack_dir).replace(os.sep, "/")
            files.append({"path": rel, "bytes": os.path.getsize(p), "sha256": sha256(p),
                          "type": mimetypes.guess_type(n)[0] or "application/octet-stream"})
    manifest = {
        "schema": SCHEMA,
        "packId": pack_id,
        "generatedAt": iso(now),
        "generator": "scripts/build_pack.py",
        "base": f"data/packs/{pack_id}/",
        "airports": airports,
        "defaultAirports": default_airports,
        "airportNames": {i: (stations.get(i) or {}).get("site") for i in airports if stations.get(i)},
        "sync": sync,
        "sample": any(c.get("sample") for c in charts) or not brief["ok"],
        "duty": duty,
        "sections": {"wx": "wx.json", "notam": "notam.json", "airports": "airports.json",
                     "brief": "brief.json", "charts": "charts.json"},
        "files": files,
        "totalBytes": sum(f["bytes"] for f in files),
        "signature": signature,
        "previousPackId": prev_manifest["packId"] if prev_manifest else None,
    }
    write_json(os.path.join(pack_dir, "manifest.json"), manifest)
    if prev_manifest:
        write_json(os.path.join(DATA, "previous", "manifest.json"), prev_manifest)
    write_json(os.path.join(DATA, "latest", "manifest.json"), manifest)

    packs_root = os.path.join(DATA, "packs")
    ids = sorted([d for d in os.listdir(packs_root) if os.path.isdir(os.path.join(packs_root, d))], reverse=True)
    for old in ids[keep:]:
        shutil.rmtree(os.path.join(packs_root, old))
        log("古いパックを削除:", old)
    index = {"schema": SCHEMA, "latest": pack_id, "packs": []}
    for pid in ids[:keep]:
        m = read_json(os.path.join(packs_root, pid, "manifest.json"), {})
        index["packs"].append({"packId": pid, "generatedAt": m.get("generatedAt"), "totalBytes": m.get("totalBytes")})
    write_json(os.path.join(DATA, "index.json"), index)
    ok_wx = sum(1 for e in wx["airports"].values() if e.get("ok") and not e.get("carriedOver"))
    log(f"完了 packId={pack_id} files={len(files)} size={manifest['totalBytes']}B WX取得OK={ok_wx}/{len(airports)} charts={len(charts)}({chart_mode})")
    return {"changed": True, "packId": pack_id, "airports": len(airports), "charts": len(charts), "chartMode": chart_mode,
            "bytes": manifest["totalBytes"]}


def make_parser():
    ap = argparse.ArgumentParser(description="Flight Buddy オフライン用パックを作る")
    ap.add_argument("--config", default=os.path.join(ROOT, "config", "pack_config.json"))
    ap.add_argument("--airports", help="カンマ区切りICAO（config/同期issueより優先）例: RJTT,RJFF")
    ap.add_argument("--brief", help="ブリーフ本文のテキスト/Markdownファイル")
    ap.add_argument("--brief-if-newer", action="store_true", help="--brief が前回より新しい時だけ採用（古ければ前回本文を引き継ぎ）")
    ap.add_argument("--notam-file", help="NOTAM JSON（形式は examples/notam.sample.json）")
    ap.add_argument("--charts-dir", help="図の画像フォルダ（任意で charts.json sidecar）")
    ap.add_argument("--charts-if-newer", action="store_true", help="ステージングの図が公開済みより新しい時だけ差し替え")
    ap.add_argument("--no-carry-charts", action="store_true", help="新しい図が無い時に前回の図を引き継がない")
    ap.add_argument("--allow-restricted", action="store_true", help="restricted(MetAir等)の図も含める")
    ap.add_argument("--sample-charts", action="store_true", help="見本(SAMPLE)図を入れる")
    ap.add_argument("--duty-file", help="DUTY情報JSON（任意）")
    ap.add_argument("--keep", type=int, help="保持するパック数")
    ap.add_argument("--skip-if-unchanged", action="store_true", help="中身が前回と同じならパックを作らない")
    return ap


def main():
    args = make_parser().parse_args()
    r = build(args)
    print(json.dumps(r, ensure_ascii=False))


if __name__ == "__main__":
    main()
