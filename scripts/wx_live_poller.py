#!/usr/bin/env python3
"""近リアルタイム気象ポラー（ATIS / METAR / SPECI / TAF）。

2026-11-24（航空局から SWIM 空港詳細へのエラー多発の連絡を受けて）から:
  METAR/SPECI・TAF ＝ AWC（aviationweather.gov）だけ。SWIM の空港詳細（f2appr/FLV806/LGV220）はこのポラーから一切呼ばない。
  ATIS ＝ SWIM（f2atrq の1リクエストで全対応空港）。前回の問い合わせから atisMinSeconds（120秒未満にはしない）経った時だけ。
           エラーを返した空港は6時間問い合わせない（fetchers/swim/lib/swimGuard.js。auto_update と共通の状態ファイル）。
           SWIM へは swim ロックの中だけで問い合わせる（15分ごとの auto_update と重ならない）。
箱上の通常の Python + Node プロセス。モデルや LLM は呼ばない（Grok Bot の使用量も使わない）。
pollSeconds ごとに走らせ、ローカル JSON を書き、設定があれば Cloudflare KV へ上げる。
対象は国内の全空港（pack の japan_all の RJ**/RO**。路線や既定空港では絞らない）。
認証情報（SWIM / Cloudflare）は環境変数または 600 の env ファイルのみ。ログ・リポジトリ・JSON 本文に出さない。
"""
from __future__ import annotations

import argparse
import datetime as dt
import fcntl
import hashlib
import json
import os
import re
import sys
import time
import urllib.error
import urllib.request

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, os.path.join(ROOT, "scripts"))
import build_pack  # noqa: E402
import flightcat  # noqa: E402
import swim_lock  # noqa: E402
import swim_staging  # noqa: E402

UTC = dt.timezone.utc
CFG_PATH = os.path.join(ROOT, "config", "wx_relay.json")
SWIM_RUNNER = os.path.join(ROOT, "fetchers", "swim", "run.js")
OUT_DEFAULT = os.environ.get("FB_WX_LIVE_FILE", "/workspace/fb-staging/wx-live.json")
STAGING = os.environ.get("FB_WX_LIVE_SWIM_DIR", "/workspace/fb-staging/wx-live-swim")
CURSOR_PATH = os.environ.get("FB_WX_LIVE_CURSOR", "/workspace/fb-staging/wx-live-cursor.json")
KV_STATE_PATH = os.environ.get("FB_WX_LIVE_KV_STATE", "/workspace/fb-staging/wx-live-kv-state.json")
LOCK = os.environ.get("FB_WX_LIVE_LOCK", "/tmp/flight-buddy-wx-live.lock")
SCHEMA = "flight-buddy-wx-live/1"
UA = "FlightBuddyWxLive/1.0 (+https://falchawk.github.io/flight-buddy/)"


def log(*a):
    print("[wx_live]", *a, file=sys.stderr, flush=True)


def now_utc():
    return dt.datetime.now(UTC)


def iso(t):
    if t is None:
        return None
    if isinstance(t, str):
        return t
    return t.astimezone(UTC).strftime("%Y-%m-%dT%H:%M:%SZ")


def load_cfg(path=CFG_PATH):
    with open(path, encoding="utf-8") as f:
        return json.load(f)


def _uniq(seq):
    seen, out = set(), []
    for x in seq:
        if x and x not in seen:
            seen.add(x)
            out.append(x)
    return out


def atis_supported_icaos():
    """SWIM が ATIS を返す空港。出典は fetchers/swim/swim.js の ATIS_SUPPORTED_ICAO のみ。"""
    path = os.path.join(ROOT, "fetchers", "swim", "swim.js")
    with open(path, encoding="utf-8") as f:
        text = f.read()
    m = re.search(r"ATIS_SUPPORTED_ICAO\s*=\s*new Set\(\s*\[([^\]]+)\]", text)
    if not m:
        raise RuntimeError("ATIS_SUPPORTED_ICAO を swim.js から読めない")
    return _uniq(re.findall(r"['\"]([A-Z]{4})['\"]", m.group(1)))


def profile_airports():
    """SWIM 国内プロファイル対象＝japan_all の RJ**/RO** すべて。路線では絞らない。"""
    pack_cfg = build_pack.read_json(os.path.join(ROOT, "config", "pack_config.json"), {}) or {}
    return _uniq(x.upper() for x in build_pack.swim_targets(pack_cfg))


def poll_seconds(cfg):
    return int((cfg or {}).get("pollSeconds") or 120)


def atis_min_seconds(cfg):
    """SWIM ATIS（1リクエストで全対応空港）の最短間隔。2026-11-24 のご指示で 120 秒より短くしない。"""
    v = (cfg or {}).get("atisMinSeconds")
    return max(120, int(v if v is not None else 120))



def kv_min_write_seconds(cfg):
    v = (cfg or {}).get("kvMinWriteSeconds")
    return 180 if v is None else max(0, int(v))


def kv_daily_write_budget(cfg):
    v = (cfg or {}).get("kvDailyWriteBudget")
    return 600 if v is None else max(0, int(v))


def watched(cfg):
    """本番は全国内 SWIM 対象。テスト用に cfg へ明示リストを置ける（部分集合運用ではない）。"""
    if (cfg or {}).get("atisAirports") or (cfg or {}).get("profileAirports"):
        atis = _uniq(x.upper() for x in (cfg.get("atisAirports") or []))
        prof = _uniq(x.upper() for x in (cfg.get("profileAirports") or []))
    else:
        atis = atis_supported_icaos()
        prof = profile_airports()
    # プロファイル対象は ATIS 対象も必ず含める（漏れ防止）
    return atis, _uniq(prof + atis)


def atis_meta(text, ref):
    """ATIS 本文から情報識別と発表時刻（ISO）を取る。"""
    if not text:
        return None, None
    ident = None
    m = re.search(r"^ATIS\s+\S+\s+([A-Z])\b", text, re.M)
    if m:
        ident = m.group(1)
    obs = swim_staging._metar_obs_iso(text, ref)
    if not obs:
        hm = re.search(r"\bM(\d{4})\b", text)
        if hm:
            # M0230 → その日（ref 基準）の HHMMZ
            fake = f"XX {ref.day:02d}{hm.group(1)}Z"
            obs = swim_staging._metar_obs_iso(fake.replace("XX ", ""), ref)
            if not obs:
                day, hh, mm = ref.day, int(hm.group(1)[:2]), int(hm.group(1)[2:])
                try:
                    t = dt.datetime(ref.year, ref.month, day, hh, mm, tzinfo=UTC)
                    if t > ref + dt.timedelta(hours=1):
                        t -= dt.timedelta(days=1)
                    obs = iso(t)
                except ValueError:
                    obs = None
    return ident, obs


def metar_type(raw):
    if not raw:
        return None
    head = raw.lstrip().split("\n", 1)[0]
    if re.search(r"\bSPECI\b", raw[:80]) or head.startswith("SPECI"):
        return "SPECI"
    if re.search(r"\bMETAR\b", raw[:80]) or head.startswith("METAR"):
        return "METAR"
    return None


def metar_entry(raw, ref, source):
    raw = (raw or "").strip()
    if not raw or not build_pack.is_real_report(raw):
        return None
    obs = swim_staging._metar_obs_iso(raw, ref)
    typ = metar_type(raw)
    icao = None
    m = re.search(r"\b([A-Z]{4})\b", raw)
    if m:
        icao = m.group(1)
    return {
        "raw": raw,
        "obsTime": obs,
        "source": source,
        "fltCat": flightcat.classify_metar(raw, icao) if icao else None,
        "type": typ,
    }


def taf_issue(raw, ref):
    if not raw:
        return None
    m = re.search(r"\b(\d{6})Z\b", raw)
    if not m:
        return swim_staging._metar_obs_iso(raw, ref)
    dd, hh, mm = int(m.group(1)[:2]), int(m.group(1)[2:4]), int(m.group(1)[4:6])
    for back in (0, 1):
        y, mo = ref.year, ref.month - back
        if mo == 0:
            y, mo = y - 1, 12
        try:
            t = dt.datetime(y, mo, dd, hh, mm, tzinfo=UTC)
        except ValueError:
            continue
        if t <= ref + dt.timedelta(hours=1):
            return iso(t)
    return None


def fetch_awc(icaos, hours=12):
    """METAR/SPECI・TAF（AWC）。covered＝METAR と TAF の両方の問い合わせが成功したチャンクの空港。失敗しても例外は外に出さない。"""
    out, fetched, covered = {}, iso(now_utc()), []
    icaos = [i for i in icaos if i]
    if not icaos:
        return {"fetchedAt": fetched, "airports": {}, "ok": True, "error": None, "covered": []}
    metars, tafs, err = [], [], None
    for chunk in build_pack.chunks(icaos, 40):
        ids = ",".join(chunk)
        good = True
        try:
            metars += build_pack.http_get_json(f"{build_pack.AWC}/metar?ids={ids}&format=json&hours={hours}") or []
        except Exception as e:  # noqa: BLE001
            err, good = type(e).__name__, False
            log("AWC METAR 失敗:", err)
        try:
            tafs += build_pack.http_get_json(f"{build_pack.AWC}/taf?ids={ids}&format=json") or []
        except Exception as e:  # noqa: BLE001
            err, good = err or type(e).__name__, False
            log("AWC TAF 失敗:", err)
        if good:
            covered += list(chunk)
    cov = set(covered)
    for icao in icaos:
        if icao not in cov:
            continue
        ms = sorted(
            [m for m in metars if m.get("icaoId") == icao and build_pack.is_real_report(m.get("rawOb"))],
            key=lambda m: m.get("obsTime") or 0,
            reverse=True,
        )
        ts = [t for t in tafs if t.get("icaoId") == icao and build_pack.is_real_report(t.get("rawTAF"))]
        ts.sort(key=lambda t: t.get("issueTime") or "", reverse=True)
        metar = []
        for m in build_pack.metar_last_3h(ms):
            obs = iso(dt.datetime.fromtimestamp(m["obsTime"], UTC)) if m.get("obsTime") else None
            typ = m.get("metarType") or metar_type(m.get("rawOb"))
            metar.append({
                "raw": m.get("rawOb"),
                "obsTime": obs,
                "source": "AWC",
                "fltCat": flightcat.classify_metar(m.get("rawOb"), icao) or m.get("fltCat"),
                "type": typ,
            })
        taf = None
        if ts:
            t0 = ts[0]
            issue = t0.get("issueTime")
            if isinstance(issue, (int, float)):
                issue = iso(dt.datetime.fromtimestamp(issue, UTC))
            taf = {
                "raw": t0.get("rawTAF"),
                "issueTime": issue,
                "validFrom": iso(dt.datetime.fromtimestamp(t0["validTimeFrom"], UTC)) if t0.get("validTimeFrom") else None,
                "validTo": iso(dt.datetime.fromtimestamp(t0["validTimeTo"], UTC)) if t0.get("validTimeTo") else None,
                "source": "AWC",
            }
        out[icao] = {"metar": metar, "taf": taf}
    return {"fetchedAt": fetched, "airports": out, "ok": err is None, "error": err, "covered": covered}


def _read_swim_json(staging):
    path = os.path.join(staging, "swim.json")
    if not os.path.isfile(path):
        return {}
    try:
        with open(path, encoding="utf-8") as f:
            return json.load(f)
    except Exception:  # noqa: BLE001
        return {}


def run_swim(icaos, staging=STAGING, timeout=180, parts="atis", take_lock=True):
    """SWIM ランナーを ATIS だけで呼ぶ（空港詳細＝プロファイルはこのポラーからは一切呼ばない。2026-11-24）。
    take_lock=False のときは呼び出し側が swim ロックを持つ。"""
    import subprocess
    if parts != "atis":
        raise ValueError("wx_live_poller は SWIM の ATIS 以外を呼ばない")
    icaos = [i for i in (icaos or []) if i]
    if not icaos:
        return {"ok": True, "reason": None, "atis": None, "line": "SWIM skip empty"}
    os.makedirs(staging, exist_ok=True)
    if not os.path.exists(SWIM_RUNNER):
        return {"ok": False, "reason": "no-runner", "atis": None}
    if not (os.environ.get("SWIM_USER") and os.environ.get("SWIM_PASS")):
        return {"ok": False, "reason": "no-creds", "atis": None}

    def _run():
        r = subprocess.run(
            ["node", SWIM_RUNNER, "--out", staging, "--airports", ",".join(icaos), "--parts", "atis"],
            capture_output=True, text=True, timeout=timeout,
        )
        line = next((ln for ln in reversed((r.stdout or "").strip().splitlines()) if ln.startswith("SWIM ")), "")
        # 本文や認証情報は出さない
        log(line or f"exit={r.returncode}")
        data = _read_swim_json(staging)
        ok = r.returncode == 0 and line.startswith("SWIM OK") and " ok=atis" in line
        return {"ok": ok, "reason": None if ok else (line or f"exit{r.returncode}"), "atis": data.get("atis"), "line": line}

    try:
        if take_lock:
            with swim_lock.hold(timeout_s=180):
                return _run()
        return _run()
    except TimeoutError:
        log("SWIM ロック待ちタイムアウト")
        return {"ok": False, "reason": "lock-timeout", "atis": None}
    except subprocess.TimeoutExpired:
        log("SWIM タイムアウト")
        return {"ok": False, "reason": "timeout", "atis": None}


def atis_due(state, cfg, now=None):
    """前回 SWIM ATIS を問い合わせた時刻から atisMinSeconds（>=120秒）経っていれば True。再起動をまたいで守る。"""
    now = now or now_utc()
    last = parse_iso_utc((state or {}).get("lastAtisRequestAt"))
    return last is None or (now - last).total_seconds() >= atis_min_seconds(cfg)


def build_payload(cfg, atis_part, awc, ref=None, atis_list=None, prof_list=None):
    """METAR/SPECI・TAF は AWC だけ、ATIS は SWIM（atis_part＝run.js が書いた swim.json の atis）。"""
    ref = ref or now_utc()
    if atis_list is None or prof_list is None:
        atis_list, prof_list = watched(cfg)
    awc_ap = (awc or {}).get("airports") or {}
    atis_part = atis_part or {}
    atis_by = atis_part.get("byIcao") or {}
    airports = {}
    stats = {"metarAwc": 0, "tafAwc": 0, "atis": 0, "speci": 0}
    for icao in prof_list:
        aw = awc_ap.get(icao) or {}
        metars = list(aw.get("metar") or [])
        taf = aw.get("taf") or None
        if metars:
            stats["metarAwc"] += 1
            if metars[0].get("type") == "SPECI":
                stats["speci"] += 1
        if taf:
            stats["tafAwc"] += 1
        at = atis_by.get(icao) or {}
        atis = atis_src = atis_reason = atis_at = None
        if at.get("ok") and at.get("text"):
            ident, tm = atis_meta(at["text"], ref)
            atis = {"text": at["text"], "time": tm, "ident": ident}
            atis_src = "SWIM"
            atis_at = at.get("fetchedAt") or atis_part.get("fetchedAt")
            stats["atis"] += 1
        elif icao in atis_list:
            atis_reason = at.get("reason") or "SWIM ATIS 未取得"
        airports[icao] = {
            "metar": metars,
            "taf": taf,
            "atis": atis,
            "metarSource": "AWC" if metars else None,
            "tafSource": "AWC" if taf else None,
            "atisSource": atis_src,
            "atisReason": atis_reason,
            "atisFetchedAt": atis_at,
        }
    return {
        "schema": SCHEMA,
        "generatedAt": iso(ref),
        "source": "METAR/SPECI・TAF：AWC（aviationweather.gov）／ATIS：SWIM（国交省）",
        "fetchedAt": {"atis": atis_part.get("fetchedAt"), "awc": (awc or {}).get("fetchedAt")},
        "swimOk": bool(atis_part.get("ok")),
        "swimReason": None,
        "airports": airports,
        "stats": stats,
    }, stats


def put_kv(body: str):
    token = os.environ.get("CLOUDFLARE_API_TOKEN") or ""
    acct = os.environ.get("CLOUDFLARE_ACCOUNT_ID") or ""
    ns = os.environ.get("CLOUDFLARE_KV_NAMESPACE_ID") or ""
    key = os.environ.get("CLOUDFLARE_KV_KEY") or "live"
    if not (token and acct and ns):
        return "skip(no-cf)"
    url = f"https://api.cloudflare.com/client/v4/accounts/{acct}/storage/kv/namespaces/{ns}/values/{key}"
    req = urllib.request.Request(url, data=body.encode("utf-8"), method="PUT",
                                  headers={"Authorization": f"Bearer {token}",
                                           "Content-Type": "application/json",
                                           "User-Agent": UA})
    try:
        with urllib.request.urlopen(req, timeout=30) as r:
            raw = r.read().decode("utf-8", "replace")
        try:
            d = json.loads(raw)
            ok = bool(d.get("success"))
        except Exception:  # noqa: BLE001
            ok = r.status == 200
        return "ok" if ok else "fail(cf-api)"
    except urllib.error.HTTPError as e:
        log("KV アップロード失敗:", e.code)  # 本文にはトークンや詳細を出さない
        return f"fail(http-{e.code})"
    except Exception as e:  # noqa: BLE001
        log("KV アップロード失敗:", type(e).__name__)
        return "fail(net)"


def write_json(path, data):
    os.makedirs(os.path.dirname(path) or ".", exist_ok=True)
    tmp = path + ".tmp"
    with open(tmp, "w", encoding="utf-8") as f:
        json.dump(data, f, ensure_ascii=False, separators=(",", ":"))
        f.write("\n")
    os.replace(tmp, path)


def read_json(path):
    try:
        with open(path, encoding="utf-8") as f:
            return json.load(f)
    except Exception:  # noqa: BLE001
        return {}


# 内容比較から外す（毎回変わる時刻や、周期ごとの統計。空港の報そのものではない）
_KV_VOLATILE_KEYS = frozenset({
    "generatedAt", "fetchedAt", "atisFetchedAt", "stats", "swimOk", "swimReason",
})


def content_for_hash(payload):
    """KV に上げる中身のうち、揮発的な時刻・統計を除いた木。"""
    if isinstance(payload, dict):
        return {k: content_for_hash(v) for k, v in payload.items() if k not in _KV_VOLATILE_KEYS}
    if isinstance(payload, list):
        return [content_for_hash(x) for x in payload]
    return payload


def payload_content_hash(payload):
    canonical = json.dumps(content_for_hash(payload), ensure_ascii=False, separators=(",", ":"), sort_keys=True)
    return hashlib.sha256(canonical.encode("utf-8")).hexdigest()


def utc_day(t=None):
    t = t or now_utc()
    if t.tzinfo is None:
        t = t.replace(tzinfo=UTC)
    return t.astimezone(UTC).strftime("%Y-%m-%d")


def kv_state_for_day(state, now=None):
    """UTC 日が変わっていたら当日カウンタだけリセット。ハッシュと保留は引き継ぐ。"""
    now = now or now_utc()
    day = utc_day(now)
    st = dict(state or {})
    if st.get("utcDay") != day:
        st["utcDay"] = day
        st["writesToday"] = 0
        st["budgetLogged"] = False
    return st


def load_kv_write_state(path, now=None):
    raw = read_json(path) if path and os.path.isfile(path) else {}
    return kv_state_for_day(raw, now=now)


def parse_iso_utc(s):
    if not s:
        return None
    if isinstance(s, dt.datetime):
        t = s
        return t if t.tzinfo else t.replace(tzinfo=UTC)
    t = dt.datetime.fromisoformat(str(s).replace("Z", "+00:00"))
    return t if t.tzinfo else t.replace(tzinfo=UTC)


def decide_kv_write(cfg, payload, state, now=None):
    """内容が変わり、最短間隔を過ぎ、日次上限未満なら書く。更新は捨てず、間隔後の周期に回す。

    戻り値: (should_write, reason, new_state)
    reason は put / skip(unchanged) / skip(wait) / skip(budget)
    """
    now = now or now_utc()
    st = kv_state_for_day(state, now=now)
    digest = payload_content_hash(payload)
    if digest != st.get("lastWrittenHash"):
        st["pending"] = True
    else:
        st["pending"] = False

    if not st.get("pending"):
        return False, "skip(unchanged)", st

    budget = kv_daily_write_budget(cfg)
    writes = int(st.get("writesToday") or 0)
    if writes >= budget:
        if not st.get("budgetLogged"):
            log("KV 日次書き込み上限に達したので UTC 0時まで書き込みを停止",
                f"writesToday={writes} budget={budget}")
            st["budgetLogged"] = True
        return False, "skip(budget)", st

    last = parse_iso_utc(st.get("lastWriteAt"))
    min_s = kv_min_write_seconds(cfg)
    if last is not None and (now - last).total_seconds() < min_s:
        return False, "skip(wait)", st
    return True, "put", st


def mark_kv_written(state, payload, now=None):
    now = now or now_utc()
    st = kv_state_for_day(state, now=now)
    st["writesToday"] = int(st.get("writesToday") or 0) + 1
    st["lastWriteAt"] = iso(now)
    st["lastWrittenHash"] = payload_content_hash(payload)
    st["pending"] = False
    st["budgetLogged"] = False
    return st


def merge_airports(prev, payload, awc_covered, atis_fresh):
    """AWC が応答した空港だけ METAR/TAF を、今回 ATIS を取った時だけ ATIS を上書き。それ以外は前回を残す。"""
    prev_ap = (prev or {}).get("airports") or {}
    new_ap = (payload or {}).get("airports") or {}
    awc_covered = set(awc_covered or [])
    out = {}
    for icao, fresh in new_ap.items():
        old = prev_ap.get(icao)
        if not old:
            out[icao] = fresh
            continue
        merged = dict(old)
        if icao in awc_covered:
            for k in ("metar", "taf", "metarSource", "tafSource"):
                merged[k] = fresh.get(k)
        if atis_fresh:
            for k in ("atis", "atisSource", "atisReason", "atisFetchedAt"):
                merged[k] = fresh.get(k)
        out[icao] = merged
    payload = dict(payload)
    payload["airports"] = out
    fetched = dict(payload.get("fetchedAt") or {})
    pf = (prev or {}).get("fetchedAt") or {}
    if not atis_fresh and pf.get("atis"):
        fetched["atis"] = pf.get("atis")
    if not awc_covered and pf.get("awc"):
        fetched["awc"] = pf.get("awc")
    payload["fetchedAt"] = fetched
    return payload


def cycle(cfg, out_path, local_only=False, skip_awc=False, skip_swim=False, atis_override=None, awc_override=None,
          cursor_path=CURSOR_PATH, kv_state_path=KV_STATE_PATH, now=None):
    t0 = time.time()
    now = now or now_utc()
    atis_list, prof_list = watched(cfg)
    prev = read_json(out_path) if os.path.isfile(out_path) else {}
    state = read_json(cursor_path) if cursor_path and os.path.isfile(cursor_path) else {}
    # ATIS（SWIM）：前回の問い合わせから 120 秒以上経った時だけ。空港ごとの6時間停止は run.js（lib/swimGuard.js）
    atis_state = "skip(wait)"
    atis_part = None
    if atis_override is not None:
        atis_part, atis_state = atis_override, "override"
    elif skip_swim:
        atis_state = "skip(flag)"
    elif atis_due(state, cfg, now):
        state["lastAtisRequestAt"] = iso(now)      # 問い合わせ前に記録（失敗しても 120 秒は空ける）
        if cursor_path:
            write_json(cursor_path, state)
        res = run_swim(atis_list)
        atis_part = res.get("atis")
        atis_state = "ok" if res.get("ok") else "fail"
    if atis_part is None:
        atis_part = _read_swim_json(STAGING).get("atis") if atis_override is None and not skip_swim else None
    atis_fresh = atis_state in ("ok", "override")
    # METAR/SPECI・TAF：AWC だけ（SWIM の空港詳細は呼ばない）
    if awc_override is not None:
        awc = awc_override
    elif skip_awc:
        awc = {"fetchedAt": None, "airports": {}, "ok": True, "error": None, "covered": []}
    else:
        awc = fetch_awc(prof_list)
    covered = awc.get("covered")
    if covered is None:
        covered = list((awc.get("airports") or {}).keys())
    payload, stats = build_payload(cfg, atis_part, awc, ref=now, atis_list=atis_list, prof_list=prof_list)
    if prev.get("airports"):
        payload = merge_airports(prev, payload, covered, atis_fresh=atis_fresh)
    write_json(out_path, payload)
    kv = "skip(local)"
    kv_state = load_kv_write_state(kv_state_path) if kv_state_path else kv_state_for_day({})
    writes_today = int(kv_state.get("writesToday") or 0)
    if not local_only:
        should, kv, kv_state = decide_kv_write(cfg, payload, kv_state)
        if should:
            result = put_kv(json.dumps(payload, ensure_ascii=False, separators=(",", ":")))
            if result == "ok":
                kv_state = mark_kv_written(kv_state, payload)
                kv = "put"
            else:
                kv = result
        if kv_state_path:
            write_json(kv_state_path, kv_state)
        writes_today = int(kv_state.get("writesToday") or 0)
    dt_s = time.time() - t0
    # 値に空白を入れない1行サマリー（途中で切れても読める）
    print(f"WX-LIVE {'OK' if stats['metarAwc'] or stats['atis'] else 'FAIL'} "
          f"airports={len(payload['airports'])} metarTaf=AWC awc={'ok' if awc.get('ok') else awc.get('error') or 'fail'} "
          f"awcAirports={len(covered)} metar={stats['metarAwc']} taf={stats['tafAwc']} speci={stats['speci']} "
          f"swimAtis={atis_state} atis={stats['atis']} lastAtisReq={state.get('lastAtisRequestAt')} swimProfile=none "
          f"kv={kv} writesToday={writes_today} t={dt_s:.0f}s", flush=True)
    return 0 if (stats["metarAwc"] or stats["atis"] or payload.get("airports")) else 1


def acquire_self_lock():
    f = open(LOCK, "w")
    try:
        fcntl.flock(f, fcntl.LOCK_EX | fcntl.LOCK_NB)
    except BlockingIOError:
        return None
    return f


def main(argv=None):
    ap = argparse.ArgumentParser(description="Flight Buddy 近リアルタイム気象ポラー")
    ap.add_argument("--once", action="store_true", help="1回だけ取得して終了")
    ap.add_argument("--loop", action="store_true", help="pollSeconds 間隔で繰り返す")
    ap.add_argument("--local", action="store_true", help="KV に上げずローカルファイルだけ書く")
    ap.add_argument("--out", default=OUT_DEFAULT)
    ap.add_argument("--interval", type=int, default=0, help="秒（省略時は config の pollSeconds）")
    ap.add_argument("--skip-awc", action="store_true")
    ap.add_argument("--skip-swim", action="store_true")
    args = ap.parse_args(argv)
    cfg = load_cfg()
    interval = args.interval or poll_seconds(cfg)
    if not args.once and not args.loop:
        args.once = True
    lockf = acquire_self_lock()
    if lockf is None:
        print("WX-LIVE SKIP: 別のポラーが実行中")
        return 0
    try:
        if args.once:
            return cycle(cfg, args.out, local_only=args.local, skip_awc=args.skip_awc, skip_swim=args.skip_swim)
        while True:
            try:
                cycle(cfg, args.out, local_only=args.local, skip_awc=args.skip_awc, skip_swim=args.skip_swim)
            except Exception as e:  # noqa: BLE001
                log("周期失敗:", type(e).__name__)
                print(f"WX-LIVE FAIL {type(e).__name__}", flush=True)
            time.sleep(max(60, interval))
    finally:
        try:
            fcntl.flock(lockf, fcntl.LOCK_UN)
        finally:
            lockf.close()


if __name__ == "__main__":
    sys.exit(main())
