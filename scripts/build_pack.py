#!/usr/bin/env python3
"""
Flight Buddy pack builder
=========================
地上（ボットの端末）で実行し、オフライン用の「パック」を data/ 以下に書き出す。
標準ライブラリのみ。ネット取得はすべてリトライ付き。

出力（共有ファイル＝全端末がダウンロード／空港別＝各端末が SETTINGS で選んだ空港だけダウンロード）:
  data/packs/<packId>/manifest.json   … 目録（共有ファイル・共有の図・空港別ファイル airportFiles の一覧＋sha256＋サイズ）
  data/packs/<packId>/index.json      … 全空港の一覧（名称・位置・国・飛行状態のみ。SETTINGS の空港選択と MAP 用。小さい）
  data/packs/<packId>/ap/<ICAO>.json  … 空港別：METAR/TAF・NOTAM・ATIS・空港プロファイル（SWIM・AIP Lost Comm）・飛行場時系列の画像参照
  data/packs/<packId>/wx.json ほか    … wx / notam / atis / airports は出所・取得時刻などの共通情報だけ（空港ごとの中身は ap/）
  data/packs/<packId>/brief.json      … ボットが書いたブリーフ本文（--brief）
  data/packs/<packId>/charts.json     … 図のメタデータ（schema flight-buddy-charts/2。飛行場時系列は ap/ 側）
  data/packs/<packId>/flights.json    … 時刻表
  data/blobs/<sha256>.<ext>           … 図の画像（内容アドレス。パック間で共有・差分のみ端末へ）
  data/latest/manifest.json           … 最新パックの目録（アプリはまずこれを見る）
  data/previous/manifest.json         … 1つ前のパックの目録
  data/index.json                     … 保持中パックの一覧

使い方の例:
  python3 scripts/build_pack.py --brief /workspace/fb-staging/brief.md --swim-dir /workspace/fb-staging
  （通常は scripts/auto_update.py から呼ばれる）
"""
import argparse
import concurrent.futures
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
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import charts as chartlib  # noqa: E402
import swim_staging
from flightcat import classify_metar  # noqa: E402
import schedule  # noqa: E402
import flights_pack  # noqa: E402
import notam_area  # noqa: E402


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
NIL_RE = re.compile(r"\bNIL\s*=?\s*$")


def is_real_report(raw):
    """'METAR RJAI NIL'（観測なし）は報ではない。"""
    return bool(raw) and not NIL_RE.search(raw.strip())


def fetch_wx(airports, prev_wx, foreign=frozenset()):
    """METAR/TAF（AWC）。国内は毎回（15分ごと）。海外空港は1時間に1回だけ（schedule の wx_foreign。新規追加の空港は直ちに）。
    海外で今回取らない空港は、前回パックの値をそのまま（取得時刻 fetchedAt も前回のまま）引き継ぐ。
    戻り値 (wx, fetched=今回 AWC に問い合わせた空港の集合)。"""
    now = iso(utcnow())
    prev_ap = (prev_wx or {}).get("airports", {})
    foreign_due = schedule.is_due("wx_foreign")
    fetch_list, reused = [], []
    for icao in airports:
        if icao in foreign and not foreign_due and icao in prev_ap:
            reused.append(icao)
        else:
            fetch_list.append(icao)
    out = {"source": "aviationweather.gov (NOAA/AWC)", "fetchedAt": now, "airports": {}}
    metars, tafs, err_m, err_t = [], [], None, None
    failed_chunks = 0
    for chunk in chunks(fetch_list, 40):
        ids = ",".join(chunk)
        try:
            metars += http_get_json(f"{AWC}/metar?ids={ids}&format=json&hours=12")   # 3時間だと夜間閉鎖の空港が空になるので12時間
        except Exception as e:  # noqa: BLE001
            err_m = str(e)
            failed_chunks += 1
        try:
            tafs += http_get_json(f"{AWC}/taf?ids={ids}&format=json")
        except Exception as e:  # noqa: BLE001
            err_t = str(e)
            failed_chunks += 1
    for icao in reused:
        out["airports"][icao] = prev_ap[icao]
    for icao in fetch_list:
        ms = sorted([m for m in metars if m.get("icaoId") == icao and is_real_report(m.get("rawOb"))], key=lambda m: m.get("obsTime", 0), reverse=True)
        ts = [t for t in tafs if t.get("icaoId") == icao and is_real_report(t.get("rawTAF"))]
        ts.sort(key=lambda t: t.get("issueTime", ""), reverse=True)
        entry = {
            "icao": icao,
            "ok": bool(ms or ts),
            "fetchedAt": now,
            "metar": [
                {"raw": m.get("rawOb"), "obsTime": iso(dt.datetime.fromtimestamp(m["obsTime"], dt.timezone.utc)) if m.get("obsTime") else None,
                 "fltCat": classify_metar(m.get("rawOb"), icao) or m.get("fltCat"), "type": m.get("metarType")}
                for m in ms[:4]
            ],
            "taf": ({"raw": ts[0].get("rawTAF"), "issueTime": ts[0].get("issueTime"),
                     "validFrom": iso(dt.datetime.fromtimestamp(ts[0]["validTimeFrom"], dt.timezone.utc)) if ts[0].get("validTimeFrom") else None,
                     "validTo": iso(dt.datetime.fromtimestamp(ts[0]["validTimeTo"], dt.timezone.utc)) if ts[0].get("validTimeTo") else None}
                    if ts else None),
            "error": None,
        }
        if icao in foreign:
            entry["cadence"] = "1h"
        if not entry["ok"]:
            entry["error"] = err_m or err_t or "該当データなし"
            prev = prev_ap.get(icao)
            if prev and prev.get("ok"):
                prev = dict(prev)
                prev["metar"] = [m for m in prev.get("metar") or [] if is_real_report(m.get("raw"))]   # 過去の 'METAR xxxx NIL' は引き継がない
                if prev["metar"] or prev.get("taf"):
                    log(f"{icao}: 取得失敗のため前回パックの値を引き継ぎ（STALE表示）")
                    prev["carriedOver"] = True
                    prev["error"] = entry["error"]
                    entry = prev
        out["airports"][icao] = entry
    n_foreign_fetched = sum(1 for i in fetch_list if i in foreign)
    if foreign_due and n_foreign_fetched:
        schedule.record("wx_foreign", failed_chunks == 0 or any(out["airports"][i].get("ok") and not out["airports"][i].get("carriedOver") for i in fetch_list if i in foreign))
    log(f"AWC: 国内 {len(fetch_list) - n_foreign_fetched} 空港＋海外 {n_foreign_fetched} 空港を取得、海外 {len(reused)} 空港は前回の値を引き継ぎ（海外は1時間ごと）")
    return out, set(fetch_list)


def ogimet_prefetch(icaos, workers=8):
    """AWC に METAR が無い空港だけ Ogimet に問い合わせる（並列）。報なしの結果は60分キャッシュして叩き続けない。"""
    path = os.path.join(DATA, ".cache", "ogimet.json")
    cache = read_json(path, {}) or {}
    now_t = time.time()
    todo = [i for i in icaos if not (cache.get(i) and now_t - cache[i].get("t", 0) < 3600)]
    res = {}
    if todo:
        with concurrent.futures.ThreadPoolExecutor(max_workers=workers) as ex:
            for i, r in zip(todo, ex.map(fetch_ogimet, todo)):
                res[i] = r
                cache[i] = {"t": now_t, "r": r} if not r.get("ok") else {"t": 0, "r": r}
        write_json(path, {k: v for k, v in cache.items() if now_t - v.get("t", 0) < 7200})
    return {i: (res.get(i) or (cache.get(i) or {}).get("r") or {"ok": False, "reason": "未取得"}) for i in icaos}


def chunks(lst, n):
    for i in range(0, len(lst), n):
        yield lst[i:i + n]


def fetch_airport_profiles(airports, cfg, pack_date, stations=None):
    foreign = foreign_airports(cfg)
    static = cfg.get("airport_static", {})
    # NOAA/AWC の空港情報（SWIM AIP に無い空港の参考値）。国内は1日1回（毎日 04:00 JST）、海外空港は週1回（毎週月曜 04:00 JST）。
    # 取らない回は保存済みの応答を使う（scripts/schedule.py）。空港の顔ぶれが変わった時（config 追加）は取り直す。
    def noaa_info(group, part, cache_name):
        cache_path = os.path.join(DATA, ".cache", cache_name)
        cached = read_json(cache_path)
        if not group:
            return []
        if cached and cached.get("airports") == sorted(group) and not schedule.is_due(part):
            log(f"NOAA 空港情報（{part}）: 取得済み（{cached.get('fetchedAt')}）の応答を使用")
            return cached.get("info") or []
        info, failed = [], False
        for chunk in chunks(group, 60):
            try:
                info += http_get_json(f"{AWC}/airport?ids={','.join(chunk)}&format=json")
            except Exception as e:  # noqa: BLE001
                failed = True
                log("空港情報の取得失敗:", e)
        if failed and cached and cached.get("info"):
            info = cached["info"]   # 取れなかった時は前回の応答を流用（次の再試行は60分後）
        elif info:
            write_json(cache_path, {"airports": sorted(group), "info": info, "fetchedAt": iso(dt.datetime.now(dt.timezone.utc))})
        schedule.record(part, bool(info) and not failed)
        return info
    info = noaa_info([i for i in airports if i not in foreign], "noaa_airport", "awc_airport.json") \
        + noaa_info([i for i in airports if i in foreign], "noaa_airport_foreign", "awc_airport_foreign.json")
    by = {a.get("icaoId"): a for a in info}
    out = {"source": "国内：標高・磁気偏差・滑走路・周波数＝SWIM AIP（AD 2.2/2.12/2.18）、空港運用情報＝SWIM／日の出日没＝端末内計算。AIP に無い空港（海外・一部国内）の同項目のみ参考として NOAA（aviationweather.gov）", "airports": {}}
    for icao in airports:
        a = by.get(icao, {})
        st = static.get(icao, {})
        stn = (stations or {}).get(icao, {})
        fo0 = foreign.get(icao, {})
        lat, lon = a.get("lat", stn.get("lat", fo0.get("lat"))), a.get("lon", stn.get("lon", fo0.get("lon")))
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
            "country": (foreign or {}).get(icao, {}).get("country") or ("Japan" if (stations or {}).get(icao) else (a.get("country") or None)),
            "foreign": icao in (foreign or {}),
            "verified": (foreign or {}).get(icao, {}).get("verified", True),
            "jpAirlines": (foreign or {}).get(icao, {}).get("airlines"),
        }
        if icao in (foreign or {}):
            fo = foreign[icao]
            p = out["airports"][icao]
            p["iata"] = p["iata"] or fo.get("iata")
            p["name"] = p["name"] or fo.get("name")
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
        with open(os.path.join(charts_dir, fname), "rb") as f:
            body = f.read()
        h = hashlib.sha256(body).hexdigest()
        os.makedirs(dest_dir, exist_ok=True)
        bp = os.path.join(dest_dir, f"{h}{ext}")
        if not os.path.exists(bp):
            with open(bp, "wb") as f:
                f.write(body)
        meta["file"] = f"data/blobs/{h}{ext}"
        meta.setdefault("id", os.path.splitext(safe)[0])
        meta.setdefault("sample", False)
        meta["srcName"] = fname
        charts.append(meta)
    order = {f: i for i, f in enumerate(sidecar)}
    charts.sort(key=lambda c: order.get(c.get("srcName"), len(order)))
    return charts, skipped




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


def foreign_airports(cfg):
    """海外空港（config/foreign_airports.json）。ICAO→{country, verified, airlines...}"""
    f = cfg.get("foreign_airports_file")
    if not f:
        return {}
    d = read_json(f if os.path.isabs(f) else os.path.join(ROOT, f), {}) or {}
    return {k: v for k, v in (d.get("airports") or {}).items() if ICAO_RE.match(k)}


OGIMET = "https://www.ogimet.com/cgi-bin/getmetar"


def fetch_ogimet(icao):
    """wx-brief fetchers/publicMetar.js fetchOneOgimet と同じ（METARのみ・最終手段）。"""
    now = utcnow()
    f = lambda t: t.strftime("%Y%m%d%H%M")  # noqa: E731
    url = f"{OGIMET}?icao={icao}&begin={f(now - dt.timedelta(hours=3))}&end={f(now)}&lang=eng&header=yes"
    try:
        req = urllib.request.Request(url, headers={"User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/129.0.0.0 Safari/537.36",
                                                   "Accept": "text/plain,*/*;q=0.8"})
        with urllib.request.urlopen(req, timeout=10) as r:
            text = r.read().decode("utf-8", "replace")
    except Exception as e:  # noqa: BLE001
        return {"ok": False, "reason": str(e)}
    rows = [ln.strip() for ln in text.split("\n") if ln.strip().startswith(icao + ",")]
    if not rows:
        return {"ok": False, "reason": "直近時間帯の本文が0件でした"}
    cols = rows[-1].split(",")
    raw = re.sub(r"=\s*$", "", cols[6] if len(cols) > 6 else "").strip()
    if raw and not is_real_report(raw):
        return {"ok": False, "reason": "Ogimet の応答が NIL（観測なし）でした"}
    return {"ok": True, "rawText": raw} if raw else {"ok": False, "reason": "CSVの本文列が空でした"}


def swim_targets(cfg, airports=None):
    """SWIM（NOTAM・ATIS・空港プロファイル・AIP）を取る空港＝パックの空港のうち国内（RJ**/RO**）全部。"""
    if airports is None:
        airports, _ = resolve_airports(cfg)
    return [a for a in airports if re.match(r"^R[JO][A-Z]{2}$", a)]


def resolve_airports(cfg, override=None):
    """パックの空港＝気象庁の国内観測空港（japan_all）＋config の追加＋海外空港リスト。全部を毎回取得する。"""
    stations = japan_stations()
    if override:
        return [a.strip().upper() for a in override.split(",") if a.strip()], stations
    s = set()
    if cfg.get("airport_set") == "japan_all":
        s |= set(stations)
    s |= {a.upper() for a in cfg.get("airports", []) + cfg.get("extra_airports", [])}
    s |= set(foreign_airports(cfg))
    return sorted(a for a in s if ICAO_RE.match(a)), stations


# ----------------------------------------------------------------------------- brief / charts helpers
def pack_signature(pack_dir):
    """生成時刻を除いた中身の指紋（変化が無ければ公開をスキップするため）。"""
    h = hashlib.sha256()
    wx = read_json(os.path.join(pack_dir, "wx.json"), {})
    for icao, e in sorted(wx.get("airports", {}).items()):
        h.update(icao.encode())
        for m in e.get("metar") or []:
            h.update((m.get("raw") or "").encode())
        h.update(((e.get("taf") or {}).get("raw") or "").encode())
    for name in ("notam.json", "brief.json", "atis.json", "airports.json", "flights.json", "duty_default.json", "notam_area.json"):
        d = read_json(os.path.join(pack_dir, name), {}) or {}
        d.pop("fetchedAt", None)
        h.update(json.dumps(d, sort_keys=True, ensure_ascii=False).encode())
    c = read_json(os.path.join(pack_dir, "charts.json"), {}) or {}
    h.update(json.dumps(sorted(chartlib.referenced_blobs(c))).encode())
    return h.hexdigest()


def merge_prev_products(new, prev):
    """今回取れなかった種類（variants が空）は前回の内容を引き継ぐ（carriedOver 印付き）。"""
    if not prev or not prev.get("categories"):
        return 0
    pm = {(c["id"], it["id"]): it["product"] for c in prev["categories"] for it in c["items"]}
    n = 0
    for c in new.get("categories", []):
        for it in c["items"]:
            p = it["product"]
            if p.get("type") == "series" and not p.get("variants"):
                old = pm.get((c["id"], it["id"]))
                if old and old.get("variants"):
                    it["product"] = dict(old, carriedOver=True)
                    n += 1
            elif p.get("type") == "series" and it["id"] in ("kosa", "pm25"):
                continue   # 黄砂・PM2.5 は dust.py が自前で前回分を持つ。廃止したバリアント（例: 旧 PM2.5 の統合列）を復活させない
            elif p.get("type") == "series":  # 種類の中で欠けた variant（地域・高度等）も引き継ぐ
                old = pm.get((c["id"], it["id"])) or {}
                have = {v["id"] for v in p["variants"]}
                miss = [dict(v, carriedOver=True) for v in old.get("variants") or [] if v["id"] not in have]
                if miss:
                    p["variants"] += miss
                    n += len(miss)
    return n


# ----------------------------------------------------------------------------- 空港別ファイル
# 端末は SETTINGS で選んだ空港の ap/<ICAO>.json（＋その空港の飛行場時系列の画像）と共有ファイルだけをダウンロードする。
AP_DIR = "ap"


def split_pack(pack_dir, charts):
    """組み立て済みの wx/notam/atis/airports/charts を、共有ファイル＋空港別ファイルに分ける。
    戻り値: {ICAO: [blob path, ...]}（空港別の画像）"""
    wx = read_json(os.path.join(pack_dir, "wx.json"), {}) or {}
    notam = read_json(os.path.join(pack_dir, "notam.json"), {}) or {}
    atis = read_json(os.path.join(pack_dir, "atis.json"), {}) or {}
    prof = read_json(os.path.join(pack_dir, "airports.json"), {}) or {}
    series = {}
    for c in charts.get("categories", []):
        for it in c["items"]:
            if it["id"] == "apseries":
                for v in it["product"].get("variants") or []:
                    series[v["id"]] = v
                it["product"]["variants"] = []
                it["product"]["perAirport"] = True
    ids = sorted(set(wx.get("airports", {})) | set(prof.get("airports", {})) | set((notam.get("airports") or {})) | set(series))
    os.makedirs(os.path.join(pack_dir, AP_DIR), exist_ok=True)
    index, ap_blobs = {}, {}
    atis_reasons = atis.get("reasons") or {}
    for icao in ids:
        e = (wx.get("airports") or {}).get(icao)
        p = (prof.get("airports") or {}).get(icao)
        d = {"icao": icao, "wx": e, "notam": (notam.get("airports") or {}).get(icao), "profile": p,
             "atis": (atis.get("airports") or {}).get(icao), "atisReason": atis_reasons.get(icao), "series": series.get(icao)}
        write_json(os.path.join(pack_dir, AP_DIR, f"{icao}.json"), d)
        mt = ((e or {}).get("metar") or [{}])[0]
        index[icao] = {k: v for k, v in {"name": (p or {}).get("name"), "iata": (p or {}).get("iata"), "lat": (p or {}).get("lat"), "lon": (p or {}).get("lon"),
                                          "country": (p or {}).get("country"), "foreign": (p or {}).get("foreign"), "verified": (p or {}).get("verified"),
                                          "fltCat": mt.get("fltCat"), "series": icao in series}.items() if v is not None}
        if icao in series:
            ap_blobs[icao] = sorted({i["file"] for f in series[icao].get("frames", []) for i in f.get("images", []) if i.get("file", "").startswith("data/blobs/")})
    wx.pop("airports", None); notam.pop("airports", None); atis.pop("airports", None); atis.pop("reasons", None); prof.pop("airports", None)
    write_json(os.path.join(pack_dir, "wx.json"), wx)
    write_json(os.path.join(pack_dir, "notam.json"), notam)
    write_json(os.path.join(pack_dir, "atis.json"), atis)
    write_json(os.path.join(pack_dir, "airports.json"), prof)
    write_json(os.path.join(pack_dir, "charts.json"), charts)
    write_json(os.path.join(pack_dir, "index.json"), {"airports": index})
    return ap_blobs


BRIEF_IMG_RE = re.compile(r"!\[[^\]]*\]\(\s*brief-img/([A-Za-z0-9._-]+\.(?:png|jpe?g))\s*\)", re.I)


def brief_images(text, img_dir):
    """本文が参照する brief-img/NAME.png|jpg を blob にして {NAME: {file, bytes}} を返す（無いものは入れない＝アプリは「画像がありません」と出す）。"""
    out = {}
    os.makedirs(os.path.join(DATA, "blobs"), exist_ok=True)
    for name in dict.fromkeys(BRIEF_IMG_RE.findall(text or "")):
        p = os.path.join(img_dir, name)
        if not os.path.isfile(p):
            log(f"BRIEF 画像なし: {name}")
            continue
        body = open(p, "rb").read()
        ext = "png" if body[:4] == b"\x89PNG" else "jpg" if body[:2] == b"\xff\xd8" else None
        if not ext or not body:
            log(f"BRIEF 画像が PNG/JPG ではない: {name}")
            continue
        rel = f"data/blobs/{hashlib.sha256(body).hexdigest()}.{ext}"
        dst = os.path.join(ROOT, rel)
        if not os.path.exists(dst):
            with open(dst, "wb") as f:
                f.write(body)
        out[name] = {"file": rel, "bytes": len(body)}
    return out


def join_pack(pack_dir):
    """空港別ファイルを元の形（wx/notam/atis/airports/charts の airports 付き）に戻す（前回分の引き継ぎ用）。旧形式はそのまま。"""
    out = {k: read_json(os.path.join(pack_dir, f"{k}.json")) for k in ("wx", "notam", "atis", "airports", "charts", "flights", "brief", "duty_default", "notam_area")}
    apd = os.path.join(pack_dir, AP_DIR)
    if not os.path.isdir(apd):
        return out
    for k in ("wx", "notam", "atis", "airports"):
        out[k] = dict(out[k] or {}, airports={})
    out["atis"]["reasons"] = {}
    series = []
    for n in sorted(os.listdir(apd)):
        d = read_json(os.path.join(apd, n), {}) or {}
        icao = d.get("icao") or n[:-5]
        if d.get("wx") is not None:
            out["wx"]["airports"][icao] = d["wx"]
        if d.get("notam") is not None:
            out["notam"]["airports"][icao] = d["notam"]
        if d.get("profile") is not None:
            out["airports"]["airports"][icao] = d["profile"]
        if d.get("atis") is not None:
            out["atis"]["airports"][icao] = d["atis"]
        if d.get("atisReason"):
            out["atis"]["reasons"][icao] = d["atisReason"]
        if d.get("series"):
            series.append(d["series"])
    for c in (out.get("charts") or {}).get("categories", []):
        for it in c["items"]:
            if it["id"] == "apseries":
                it["product"]["variants"] = series
    return out


# ----------------------------------------------------------------------------- main
def build(args):
    cfg = read_json(args.config, {}) or {}
    airports, stations = resolve_airports(cfg, args.airports)
    if not airports:
        raise SystemExit("空港が指定されていません (--airports か config)")
    public_repo = cfg.get("public_repo", True)
    keep = args.keep or cfg.get("keep_packs", 3)

    now = utcnow()
    pack_id = now.strftime("%Y%m%dT%H%M%SZ")
    pack_dir = os.path.join(DATA, "packs", pack_id)
    os.makedirs(pack_dir, exist_ok=True)
    prev_manifest = read_json(os.path.join(DATA, "latest", "manifest.json"))
    prev_dir = os.path.join(DATA, "packs", prev_manifest["packId"]) if prev_manifest else None
    if prev_dir and not os.path.isdir(prev_dir):
        prev_dir = None
    prev = join_pack(prev_dir) if prev_dir else {}
    prev_wx = prev.get("wx")

    try:
        log(f"METAR/TAF取得: {len(airports)}空港")
        wx, fetched = fetch_wx(airports, prev_wx, frozenset(foreign_airports(cfg)))
        swim = swim_staging.load_swim(args.swim_dir) if args.swim_dir else None
        targets = swim_targets(cfg, airports)
        # AWC に METAR が無い空港（今回問い合わせた分だけ）は Ogimet を並列に1回だけ確認（報なしは60分キャッシュ）
        og = ogimet_prefetch([i for i in fetched if not (wx["airports"].get(i) or {}).get("metar")])
        swim_staging.apply_priority(wx, swim, [t for t in targets if t in airports], lambda i: og.get(i), fetched)
        write_json(os.path.join(pack_dir, "wx.json"), wx)
        ok_n = sum(1 for e in wx["airports"].values() if e.get("ok") and not e.get("carriedOver"))
        if ok_n == 0:
            raise RuntimeError("METAR/TAF が1空港も取得できませんでした（aviationweather.gov 障害？）")

        log("空港プロファイル作成")
        prev_prof = prev.get("airports")
        profiles = fetch_airport_profiles(airports, cfg, now.astimezone(JST).date(), stations)
        if prev_prof:  # 取得できなかった滑走路等は前回値を流用
            for icao, p in profiles["airports"].items():
                pp = prev_prof.get("airports", {}).get(icao)
                if pp and not p.get("runways"):
                    for k in ("runways", "freqs", "elevationFt", "magdec", "name", "iata"):
                        p[k] = p.get(k) or pp.get(k)
        write_json(os.path.join(pack_dir, "airports.json"), profiles)

        notam_file = args.notam_file if args.notam_file and os.path.exists(args.notam_file) else None
        if notam_file:
            write_json(os.path.join(pack_dir, "notam.json"), load_notams(notam_file, airports))
        else:
            write_json(os.path.join(pack_dir, "notam.json"), swim_staging.notam_json(swim, targets))

        # ---- 空域 NOTAM（NOTAM タブの「空域」）：FIR のエンルート／警報＋ILS・航法援助の停波（出所：SWIM）。取れなければ前回分
        try:
            na = notam_area.build(swim)
        except Exception as e:  # noqa: BLE001
            log("空域NOTAM 作成失敗:", type(e).__name__, e)
            na = None
        if (not na or not na.get("rawCount")) and prev.get("notam_area"):
            na = dict(prev["notam_area"], carriedOver=True)
        if na:
            write_json(os.path.join(pack_dir, "notam_area.json"), na)

        # ---- brief
        prev_brief = prev.get("brief")
        brief = None
        if args.brief and os.path.exists(args.brief):
            # scripts/brief_request.py publish が <brief>.meta.json に kind（auto/manual）と作成時刻を書く
            meta = read_json(args.brief + ".meta.json", {}) or {}
            mtime = meta.get("writtenAt") or iso(dt.datetime.fromtimestamp(os.path.getmtime(args.brief), dt.timezone.utc))
            if not args.brief_if_newer or os.environ.get("FB_BRIEF_FORCE") or not prev_brief or not prev_brief.get("writtenAt") or mtime > prev_brief["writtenAt"] \
                    or not prev_brief.get("ok"):
                with open(args.brief, encoding="utf-8") as f:
                    brief = {"ok": True, "text": f.read(), "author": "Grok Bot", "writtenAt": mtime, "carriedOver": False,
                             "kind": meta.get("kind") or "unknown", "slot": meta.get("slot")}
        # 前回の本文を引き継ぐのは kind が付いたもの（＝BRIEF 運用開始後に scripts/brief_request.py で公開したもの）だけ。
        # kind が無い古い本文（初回テストパックの「福岡⇔羽田」）は現在のブリーフとして出さない
        # BRIEF の画像（本文の ![説明](brief-img/NAME.png)）：<brief>の隣の brief-img/ にある PNG/JPG のうち本文が参照するものだけ、
        # 図と同じ内容アドレス方式（data/blobs/<sha256>.<ext>）でパックに入れる（オフラインで見られる）。
        if brief is not None:
            brief["images"] = brief_images(brief.get("text") or "", os.path.join(os.path.dirname(os.path.abspath(args.brief)), "brief-img"))
        if brief is None and prev_brief and prev_brief.get("ok") and prev_brief.get("kind"):
            brief = dict(prev_brief)
            brief["carriedOver"] = True
            brief["images"] = {k: v for k, v in (prev_brief.get("images") or {}).items()
                               if isinstance(v, dict) and os.path.exists(os.path.join(ROOT, v.get("file", "")))}
        if brief is None:
            brief = {"ok": False, "text": None, "author": None, "writtenAt": None, "kind": None}
        write_json(os.path.join(pack_dir, "brief.json"), brief)

        # ---- charts（旧 Flight Buddy の8分類。plain HTTP で並列取得）
        blob_dir = os.path.join(DATA, "blobs")
        prev_charts = prev.get("charts") or {}
        if prev_charts.get("schema") != "flight-buddy-charts/2":
            prev_charts = {}
        if args.no_fetch_charts:
            charts = dict(prev_charts) if prev_charts else {"schema": "flight-buddy-charts/2", "categories": [], "errors": []}
            chart_mode = "carried" if prev_charts else "none"
        else:
            try:
                charts = chartlib.build_charts(DATA, airports, workers=args.workers)
                chart_mode = "new"
            except Exception as e:  # noqa: BLE001
                log("図の取得で例外:", e)
                charts = dict(prev_charts) if prev_charts else {"schema": "flight-buddy-charts/2", "categories": [], "errors": []}
                charts.setdefault("errors", []).append(f"図の取得全体が失敗: {e}")
                chart_mode = "carried"
            carried = merge_prev_products(charts, prev_charts) if chart_mode == "new" else 0
            if carried:
                log(f"今回取れなかった図 {carried} 件は前回分を引き継ぎ")
        # 任意: --charts-dir の追加図（旧 MetAir ステージング等）
        allow_restricted = args.allow_restricted or bool(cfg.get("include_restricted", False))
        extra, skipped = [], []
        if args.charts_dir and os.path.isdir(args.charts_dir):
            extra, skipped = collect_charts(args.charts_dir, blob_dir, allow_restricted, public_repo)
        charts["extra"] = extra
        if skipped:
            log(f"restricted のため除外した図 {len(skipped)} 件: {', '.join(skipped)}")
        write_json(os.path.join(pack_dir, "charts.json"), charts)
        n_frames = sum(len(v["frames"]) for c in charts.get("categories", []) for it in c["items"]
                       for v in (it["product"].get("variants") or []))

        # ---- SWIM ステージング（ATIS・空港運用情報）
        write_json(os.path.join(pack_dir, "atis.json"), swim_staging.atis_json(swim))
        sp = swim_staging.profiles(swim)
        for icao, p in sp.items():
            profiles["airports"].setdefault(icao, {"icao": icao})["swim"] = p
        profiles["swimTargets"] = targets
        atis_d = swim_staging.atis_json(swim)
        notam_d = read_json(os.path.join(pack_dir, "notam.json"), {}) or {}
        profiles["swimSummary"] = {
            "targets": len(targets),
            "atis": len(atis_d.get("airports") or {}),
            "atisSupported": sum(1 for t in targets if "対象外" not in ((atis_d.get("reasons") or {}).get(t) or "")),
            "notam": sum(len(a.get("items") or []) for a in (notam_d.get("airports") or {}).values()),
            "profile": sum(1 for t in targets if ((profiles["airports"].get(t) or {}).get("swim") or {}).get("ok")),
            "lostComm": sum(1 for t in targets if (((profiles["airports"].get(t) or {}).get("swim") or {}).get("lostComm") or {}).get("ok")),
            # 取得元ごとの最終取得時刻（頻度は scripts/schedule.py：プロファイル/ATIS＝15分、NOTAM＝6時間、AIP・NOAA 空港情報＝1日）
            "fetched": {"atis": atis_d.get("fetchedAt"), "notam": notam_d.get("fetchedAt"),
                        "profile": ((swim or {}).get("profile") or {}).get("fetchedAt"), "aip": ((swim or {}).get("aip") or {}).get("fetchedAt"),
                        "noaa": (read_json(os.path.join(DATA, ".cache", "awc_airport.json"), {}) or {}).get("fetchedAt"),
                        "noaaForeign": (read_json(os.path.join(DATA, ".cache", "awc_airport_foreign.json"), {}) or {}).get("fetchedAt"),
                        "wxForeign": max([e.get("fetchedAt") or "" for i, e in wx["airports"].items() if i in foreign_airports(cfg)] or [""]) or None},
        }
        write_json(os.path.join(pack_dir, "airports.json"), profiles)

        # ---- 時刻表（FLIGHTS・DUTY 照合用。ボットが1日数回取得した staging をそのまま入れる。無ければ前回分）
        staging_fl = read_json(args.flights_file) if args.flights_file and os.path.exists(args.flights_file) else None
        flights = None
        if staging_fl:
            try:
                flights = flights_pack.build_flights(staging_fl, profiles)
            except Exception as e:  # noqa: BLE001
                log("時刻表の変換失敗（前回分を使用）:", e)
        if not flights and prev_dir:
            flights = prev.get("flights")
            if flights and flights.get("schema") != "flight-buddy-flights/2":
                flights = None
        write_json(os.path.join(pack_dir, "flights.json"), flights or {"schema": "flight-buddy-flights/2", "fetchedAt": None, "carriers": [], "rows": []})

        # ---- DUTY の自動入力用（今日の便）。公開してよいのは便名・航空会社・日付・出発/到着空港・時刻だけ（許可リストで絞る）
        dd = read_json(args.duty_default_file) if getattr(args, "duty_default_file", None) and os.path.exists(args.duty_default_file) else None
        if not dd and prev_dir:
            dd = prev.get("duty_default")
        if dd and re.fullmatch(r"\d{4}-\d\d-\d\d", str(dd.get("date") or "")):
            hm = lambda v: v if isinstance(v, str) and re.fullmatch(r"\d{2}:\d{2}", v) else None  # noqa: E731
            clean = {"date": dd["date"], "fetchedAt": dd.get("fetchedAt"), "source": "iFlight",
                     "flights": [{"airline": "SFJ", "flightNumber": str(f["flightNumber"]), "dep": f["dep"], "arr": f["arr"], "std": hm(f.get("std")), "sta": hm(f.get("sta"))}
                                 for f in dd.get("flights") or []
                                 if re.fullmatch(r"\d{1,4}", str(f.get("flightNumber"))) and re.fullmatch(r"[A-Z]{3,4}", str(f.get("dep"))) and re.fullmatch(r"[A-Z]{3,4}", str(f.get("arr")))]}
            write_json(os.path.join(pack_dir, "duty_default.json"), clean)

        duty = read_json(args.duty_file) if args.duty_file else (prev_manifest or {}).get("duty")

        signature = pack_signature(pack_dir)
        if args.skip_if_unchanged and prev_manifest and prev_manifest.get("signature") == signature:
            shutil.rmtree(pack_dir)
            log("前回パックから変化なし → 新しいパックは作りません")
            return {"changed": False, "packId": prev_manifest["packId"], "airports": len(prev_manifest.get("airports", [])),
                    "charts": n_frames, "chartMode": "unchanged", "chartErrors": charts.get("errors", []),
                    "chartStats": charts.get("stats")}
        ap_blob_paths = split_pack(pack_dir, charts)
    except BaseException:
        shutil.rmtree(pack_dir, ignore_errors=True)
        raise

    def fentry(p):
        rel = os.path.relpath(p, pack_dir).replace(os.sep, "/")
        return {"path": rel, "bytes": os.path.getsize(p), "sha256": sha256(p), "type": mimetypes.guess_type(p)[0] or "application/octet-stream"}

    def bentry(b):
        p = os.path.join(ROOT, b)
        return {"file": b, "bytes": os.path.getsize(p)} if os.path.exists(p) else None

    files = [fentry(os.path.join(pack_dir, n)) for n in sorted(os.listdir(pack_dir)) if n != "manifest.json" and os.path.isfile(os.path.join(pack_dir, n))]
    blobs = [x for x in (bentry(b) for b in sorted(chartlib.referenced_blobs(charts) | {v["file"] for v in (brief.get("images") or {}).values()})) if x]
    airport_files = {}
    for n in sorted(os.listdir(os.path.join(pack_dir, AP_DIR))):
        icao = n[:-5]
        airport_files[icao] = dict(fentry(os.path.join(pack_dir, AP_DIR, n)), blobs=[x for x in (bentry(b) for b in ap_blob_paths.get(icao, [])) if x])
    ap_bytes = {i: f["bytes"] + sum(b["bytes"] for b in f["blobs"]) for i, f in airport_files.items()}
    manifest = {
        "schema": SCHEMA,
        "packId": pack_id,
        "generatedAt": iso(now),
        "generator": "scripts/build_pack.py",
        "base": f"data/packs/{pack_id}/",
        "airports": airports,
        "airportNames": {i: (stations.get(i) or {}).get("site") for i in airports if stations.get(i)},
        "sample": False,   # サンプルデータは入れていない（ヘッダの「SAMPLE含む」は出さない）
        "duty": duty,
        "sections": {"wx": "wx.json", "notam": "notam.json", "airports": "airports.json", "index": "index.json",
                     "brief": "brief.json", "charts": "charts.json", "atis": "atis.json", "flights": "flights.json",
                     **({"dutyDefault": "duty_default.json"} if os.path.exists(os.path.join(pack_dir, "duty_default.json")) else {}),
                     **({"notamArea": "notam_area.json"} if os.path.exists(os.path.join(pack_dir, "notam_area.json")) else {})},
        "files": files,          # 共有ファイル（全端末がダウンロード）
        "blobs": blobs,          # 共有の図（全端末がダウンロード）
        "airportFiles": airport_files,  # 空港別（端末は SETTINGS で選んだ空港だけダウンロード）
        "packBytes": sum(f["bytes"] for f in files),
        "blobBytes": sum(b["bytes"] for b in blobs),
        "sharedBytes": sum(f["bytes"] for f in files) + sum(b["bytes"] for b in blobs),
        "airportBytes": sum(ap_bytes.values()),
        "totalBytes": sum(f["bytes"] for f in files) + sum(b["bytes"] for b in blobs) + sum(ap_bytes.values()),
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
    # 保持パックから参照されない blob を削除
    keep_blobs = set()
    for pid in ids[:keep]:
        m = read_json(os.path.join(packs_root, pid, "manifest.json"), {}) or {}
        keep_blobs |= {b["file"].split("/")[-1] for b in m.get("blobs", [])}
        keep_blobs |= {b["file"].split("/")[-1] for f in (m.get("airportFiles") or {}).values() for b in f.get("blobs", [])}
    removed = 0
    for n in os.listdir(blob_dir):
        if n not in keep_blobs:
            os.remove(os.path.join(blob_dir, n))
            removed += 1
    if removed:
        log(f"未参照の画像 {removed} 件を削除")
    index = {"schema": SCHEMA, "latest": pack_id, "packs": []}
    for pid in ids[:keep]:
        m = read_json(os.path.join(packs_root, pid, "manifest.json"), {})
        index["packs"].append({"packId": pid, "generatedAt": m.get("generatedAt"), "totalBytes": m.get("totalBytes")})
    write_json(os.path.join(DATA, "index.json"), index)
    ok_wx = sum(1 for e in wx["airports"].values() if e.get("ok") and not e.get("carriedOver"))
    log(f"完了 packId={pack_id} files={len(files)}+空港{len(airport_files)} blobs={len(blobs)} 共有={manifest['sharedBytes']}B 空港別={manifest['airportBytes']}B WX取得OK={ok_wx}/{len(airports)} "
        f"コマ={n_frames}({chart_mode}) 図エラー={len(charts.get('errors', []))}")
    return {"changed": True, "packId": pack_id, "airports": len(airports), "charts": n_frames, "chartMode": chart_mode,
            "bytes": manifest["totalBytes"], "sharedBytes": manifest["sharedBytes"], "airportBytes": ap_bytes, "blobs": len(blobs), "chartErrors": charts.get("errors", []),
            "chartStats": charts.get("stats")}


def make_parser():
    ap = argparse.ArgumentParser(description="Flight Buddy オフライン用パックを作る")
    ap.add_argument("--config", default=os.path.join(ROOT, "config", "pack_config.json"))
    ap.add_argument("--airports", help="カンマ区切りICAO（config より優先。テスト用）例: RJTT,RJFF")
    ap.add_argument("--brief", help="ブリーフ本文のテキスト/Markdownファイル")
    ap.add_argument("--brief-if-newer", action="store_true", help="--brief が前回より新しい時だけ採用（古ければ前回本文を引き継ぎ）")
    ap.add_argument("--notam-file", help="NOTAM JSON（形式は examples/notam.sample.json）")
    ap.add_argument("--charts-dir", help="任意: 追加の図フォルダ（「その他」に表示。charts.json sidecar 可）")
    ap.add_argument("--allow-restricted", action="store_true", help="--charts-dir の restricted 図も含める")
    ap.add_argument("--no-fetch-charts", action="store_true", help="図を取得せず前回分を引き継ぐ（テスト用）")
    ap.add_argument("--workers", type=int, default=16, help="図の並列取得数")
    ap.add_argument("--swim-dir", help="SWIM 取得結果のフォルダ（<dir>/swim/swim.json。fetchers/swim/run.js が書く）")
    ap.add_argument("--duty-file", help="DUTY情報JSON（任意）")
    ap.add_argument("--duty-default-file", help="DUTY自動入力用の今日の便 JSON（scripts/duty_fetch.py の出力）")
    ap.add_argument("--flights-file", help="時刻表 JSON（flight-buddy-flights/1）")
    ap.add_argument("--keep", type=int, help="保持するパック数")
    ap.add_argument("--skip-if-unchanged", action="store_true", help="中身が前回と同じならパックを作らない")
    return ap


def main():
    args = make_parser().parse_args()
    r = build(args)
    print(json.dumps(r, ensure_ascii=False))


if __name__ == "__main__":
    main()
