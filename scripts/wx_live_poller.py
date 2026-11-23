#!/usr/bin/env python3
"""近リアルタイム気象ポラー（ATIS / METAR / SPECI / TAF）。

SWIM を第一出典とし、空港の取得に失敗したときだけ AWC（aviationweather.gov）に倒す。
箱上の通常の Python + Node プロセス。モデルや LLM は呼ばない（Grok Bot の使用量も使わない）。
pollSeconds ごとに走らせ、ローカル JSON を書き、設定があれば Cloudflare KV へ上げる。
対象は SWIM 対応の国内空港すべて（路線や既定空港では絞らない）。
ATIS は1リクエストで全対応空港、METAR/TAF は空港ごと（profileCycleSeconds で分割一周する）。
認証情報（SWIM / Cloudflare）は環境変数または 600 の env ファイルのみ。ログ・リポジトリ・JSON 本文に出さない。
"""
from __future__ import annotations

import argparse
import datetime as dt
import fcntl
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
    return int((cfg or {}).get("pollSeconds") or 90)


def profile_cycle_seconds(cfg):
    poll = poll_seconds(cfg)
    cycle = int((cfg or {}).get("profileCycleSeconds") or 180)
    return max(poll, cycle)


def profile_chunk_size(n, cfg):
    """profileCycleSeconds で全件を一周するよう、1周期あたりの件数を決める。"""
    if n <= 0:
        return 0
    poll = poll_seconds(cfg)
    cycle = profile_cycle_seconds(cfg)
    return max(1, min(n, (n * poll + cycle - 1) // cycle))


def next_chunk(all_icaos, cursor, size):
    n = len(all_icaos)
    if n == 0:
        return [], 0
    size = max(1, min(int(size), n))
    start = int(cursor or 0) % n
    chunk = [all_icaos[(start + i) % n] for i in range(size)]
    return chunk, (start + size) % n


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
    """SWIM 失敗時の予備。成功した空港の dict を返す。失敗しても例外は外に出さない。"""
    out, fetched = {}, iso(now_utc())
    icaos = [i for i in icaos if i]
    if not icaos:
        return {"fetchedAt": fetched, "airports": {}, "ok": True, "error": None}
    metars, tafs, err = [], [], None
    for chunk in build_pack.chunks(icaos, 40):
        ids = ",".join(chunk)
        try:
            metars += build_pack.http_get_json(f"{build_pack.AWC}/metar?ids={ids}&format=json&hours={hours}")
        except Exception as e:  # noqa: BLE001
            err = type(e).__name__
            log("AWC METAR 失敗:", err)
        try:
            tafs += build_pack.http_get_json(f"{build_pack.AWC}/taf?ids={ids}&format=json")
        except Exception as e:  # noqa: BLE001
            err = err or type(e).__name__
            log("AWC TAF 失敗:", err)
    for icao in icaos:
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
    return {"fetchedAt": fetched, "airports": out, "ok": err is None, "error": err}


def _read_swim_json(staging):
    path = os.path.join(staging, "swim.json")
    if not os.path.isfile(path):
        return {}
    try:
        with open(path, encoding="utf-8") as f:
            return json.load(f)
    except Exception:  # noqa: BLE001
        return {}


def run_swim(icaos, staging=STAGING, timeout=180, parts="atis,profile", take_lock=True):
    """SWIM ランナーを呼ぶ。take_lock=False のときは呼び出し側が swim ロックを持つ。"""
    import subprocess
    icaos = [i for i in (icaos or []) if i]
    if not icaos:
        return {"ok": True, "reason": None, "atis": None, "profile": None, "line": "SWIM skip empty"}
    os.makedirs(staging, exist_ok=True)
    if not os.path.exists(SWIM_RUNNER):
        return {"ok": False, "reason": "no-runner", "atis": None, "profile": None}
    if not (os.environ.get("SWIM_USER") and os.environ.get("SWIM_PASS")):
        return {"ok": False, "reason": "no-creds", "atis": None, "profile": None}

    def _run():
        r = subprocess.run(
            ["node", SWIM_RUNNER, "--out", staging, "--airports", ",".join(icaos),
             "--parts", parts, "--force"],
            capture_output=True, text=True, timeout=timeout,
        )
        line = next((ln for ln in reversed((r.stdout or "").strip().splitlines()) if ln.startswith("SWIM ")), "")
        # 本文や認証情報は出さない
        log(line or f"exit={r.returncode}")
        data = _read_swim_json(staging)
        ok = r.returncode == 0 and line.startswith("SWIM OK")
        return {"ok": ok, "reason": None if ok else (line or f"exit{r.returncode}"),
                "atis": data.get("atis"), "profile": data.get("profile"), "line": line}

    try:
        if take_lock:
            with swim_lock.hold(timeout_s=180):
                return _run()
        return _run()
    except TimeoutError:
        log("SWIM ロック待ちタイムアウト")
        return {"ok": False, "reason": "lock-timeout", "atis": None, "profile": None}
    except subprocess.TimeoutExpired:
        log("SWIM タイムアウト")
        return {"ok": False, "reason": "timeout", "atis": None, "profile": None}


def fetch_swim_cycle(atis_list, profile_chunk, staging=STAGING, timeout=180):
    """同じ swim ロックの中で、ATIS 全件（バッチ）とプロファイルの当該チャンクを取る。"""
    import subprocess
    try:
        with swim_lock.hold(timeout_s=180):
            atis_res = run_swim(atis_list, staging=staging, timeout=timeout, parts="atis", take_lock=False)
            prof_res = run_swim(profile_chunk, staging=staging, timeout=timeout, parts="profile", take_lock=False)
    except TimeoutError:
        log("SWIM ロック待ちタイムアウト")
        return {"ok": False, "reason": "lock-timeout", "atis": None, "profile": None,
                "atisOk": False, "profileOk": False}
    except subprocess.TimeoutExpired:
        log("SWIM タイムアウト")
        return {"ok": False, "reason": "timeout", "atis": None, "profile": None,
                "atisOk": False, "profileOk": False}
    atis_ok = bool(atis_res.get("ok"))
    prof_ok = bool(prof_res.get("ok"))
    reason = None
    if not (atis_ok and prof_ok):
        reason = "atis:%s;profile:%s" % (atis_res.get("reason") or "ok", prof_res.get("reason") or "ok")
    return {
        "ok": atis_ok or prof_ok,
        "reason": reason,
        "atis": atis_res.get("atis"),
        "profile": prof_res.get("profile"),
        "atisOk": atis_ok,
        "profileOk": prof_ok,
    }


def build_payload(cfg, swim, awc, ref=None, atis_list=None, prof_list=None, refresh_profile=None):
    """SWIM 優先。その空港の METAR/TAF/ATIS が SWIM から取れないときだけ AWC。

    refresh_profile を渡したときは、その空港だけ METAR/TAF を埋め、他は空（呼び出し側で前回分と合成）。
    """
    ref = ref or now_utc()
    if atis_list is None or prof_list is None:
        atis_list, prof_list = watched(cfg)
    if refresh_profile is None:
        refresh_profile = set(prof_list)
    else:
        refresh_profile = set(refresh_profile)
    awc_ap = (awc or {}).get("airports") or {}
    swim_ok = bool(swim and swim.get("ok"))
    atis_part = (swim or {}).get("atis") or {}
    prof_part = (swim or {}).get("profile") or {}
    atis_by = atis_part.get("byIcao") or {}
    prof_by = prof_part.get("byIcao") or {}
    airports = {}
    stats = {"metarSwim": 0, "metarAwc": 0, "tafSwim": 0, "tafAwc": 0, "atis": 0, "speci": 0}
    for icao in prof_list:
        metars, taf, metar_src, taf_src = [], None, None, None
        if icao in refresh_profile:
            pr = prof_by.get(icao) or {}
            sm = metar_entry(pr.get("metarText") or ((prof_part.get("metarByIcao") or {}).get(icao) or {}).get("text"), ref, "SWIM")
            st_raw = swim_staging._clean(pr.get("tafText") or ((prof_part.get("tafByIcao") or {}).get(icao) or {}).get("text"))
            st = None
            if st_raw:
                st = {"raw": st_raw, "issueTime": taf_issue(st_raw, ref), "validFrom": None, "validTo": None, "source": "SWIM"}
            aw = awc_ap.get(icao) or {}
            if sm:
                stats["metarSwim"] += 1
                metars = [sm]
                metar_src = "SWIM"
            else:
                metars = list(aw.get("metar") or [])
                if metars:
                    metar_src = "AWC"
                    stats["metarAwc"] += 1
            if st:
                stats["tafSwim"] += 1
                taf = st
                taf_src = "SWIM"
            else:
                taf = aw.get("taf")
                if taf:
                    taf_src = "AWC"
                    stats["tafAwc"] += 1
                else:
                    taf = None
            if metars and (metars[0].get("type") == "SPECI"):
                stats["speci"] += 1
        at = atis_by.get(icao) or {}
        atis = None
        atis_src = None
        atis_reason = None
        if at.get("ok") and at.get("text"):
            ident, tm = atis_meta(at["text"], ref)
            atis = {"text": at["text"], "time": tm, "ident": ident}
            atis_src = "SWIM"
            stats["atis"] += 1
        elif icao in atis_list:
            atis_reason = at.get("reason") or ("SWIM ATIS 未取得" if swim_ok else "SWIM 取得失敗")
        airports[icao] = {
            "metar": metars,
            "taf": taf,
            "atis": atis,
            "metarSource": metar_src,
            "tafSource": taf_src,
            "atisSource": atis_src,
            "atisReason": atis_reason,
            "atisFetchedAt": atis_part.get("fetchedAt") if atis else None,
        }
    return {
        "schema": SCHEMA,
        "generatedAt": iso(ref),
        "source": "SWIM（国交省）／失敗時のみ AWC（aviationweather.gov）",
        "fetchedAt": {
            "atis": atis_part.get("fetchedAt"),
            "profile": prof_part.get("fetchedAt"),
            "awc": (awc or {}).get("fetchedAt") if (stats["metarAwc"] or stats["tafAwc"]) else None,
        },
        "swimOk": swim_ok,
        "swimReason": None if swim_ok else (swim or {}).get("reason"),
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


def merge_airports(prev, payload, refresh_profile, atis_ok):
    """チャンク更新：今回取った METAR/TAF と、成功したときの ATIS だけ上書き。失敗分は前回を残す。"""
    prev_ap = (prev or {}).get("airports") or {}
    new_ap = (payload or {}).get("airports") or {}
    refresh_profile = set(refresh_profile or [])
    out = {}
    for icao, fresh in new_ap.items():
        old = prev_ap.get(icao)
        if not old:
            out[icao] = fresh
            continue
        merged = dict(old)
        if icao in refresh_profile:
            for k in ("metar", "taf", "metarSource", "tafSource"):
                merged[k] = fresh.get(k)
        if atis_ok:
            for k in ("atis", "atisSource", "atisReason", "atisFetchedAt"):
                merged[k] = fresh.get(k)
        out[icao] = merged
    payload = dict(payload)
    payload["airports"] = out
    if prev and not (payload.get("fetchedAt") or {}).get("atis") and (prev.get("fetchedAt") or {}).get("atis") and not atis_ok:
        fetched = dict(payload.get("fetchedAt") or {})
        fetched["atis"] = (prev.get("fetchedAt") or {}).get("atis")
        payload["fetchedAt"] = fetched
    return payload


def cycle(cfg, out_path, local_only=False, skip_awc=False, skip_swim=False, swim_override=None,
          cursor_path=CURSOR_PATH):
    t0 = time.time()
    atis_list, prof_list = watched(cfg)
    prev = read_json(out_path) if os.path.isfile(out_path) else {}
    cursor_state = read_json(cursor_path) if cursor_path and os.path.isfile(cursor_path) else {}
    cursor = int(cursor_state.get("profileCursor") or 0)
    # テストの swim_override や、まだ出力が無い初回は全件。以降はチャンク。
    first_fill = (swim_override is None and not skip_swim
                  and not (prev.get("airports") or {}))
    if first_fill or swim_override is not None or skip_swim:
        profile_chunk = list(prof_list)
        next_cursor = 0
        mode = "full"
    else:
        size = profile_chunk_size(len(prof_list), cfg)
        profile_chunk, next_cursor = next_chunk(prof_list, cursor, size)
        mode = "chunk"
    refresh_profile = set(profile_chunk)
    if skip_swim:
        swim = {"ok": False, "reason": "skipped", "atis": None, "profile": None,
                "atisOk": False, "profileOk": False}
    elif swim_override is not None:
        swim = dict(swim_override)
        swim.setdefault("atisOk", bool(swim.get("ok")))
        swim.setdefault("profileOk", bool(swim.get("ok")))
    else:
        swim = fetch_swim_cycle(atis_list, profile_chunk)
    need_awc = []
    profile_ok = bool(swim.get("profileOk")) if "profileOk" in swim else bool(swim.get("ok"))
    atis_ok = bool(swim.get("atisOk")) if "atisOk" in swim else bool(swim.get("ok"))
    if not skip_awc:
        if not profile_ok:
            need_awc = list(profile_chunk)
        else:
            prof_by = ((swim.get("profile") or {}).get("byIcao") or {})
            for icao in profile_chunk:
                pr = prof_by.get(icao) or {}
                if not swim_staging._clean(pr.get("metarText")) or not swim_staging._clean(pr.get("tafText")):
                    need_awc.append(icao)
    awc = fetch_awc(need_awc) if need_awc else {"fetchedAt": None, "airports": {}, "ok": True, "error": None}
    payload, stats = build_payload(
        cfg, swim, awc, atis_list=atis_list, prof_list=prof_list, refresh_profile=refresh_profile,
    )
    if prev.get("airports") and swim_override is None:
        payload = merge_airports(prev, payload, refresh_profile, atis_ok=atis_ok)
    write_json(out_path, payload)
    if cursor_path and swim_override is None and not skip_swim:
        write_json(cursor_path, {"profileCursor": next_cursor, "lastMode": mode,
                                 "lastChunk": profile_chunk, "updatedAt": payload.get("generatedAt")})
    kv = "skip(local)"
    if not local_only:
        kv = put_kv(json.dumps(payload, ensure_ascii=False, separators=(",", ":")))
    dt_s = time.time() - t0
    # 値に空白を入れない1行サマリー（途中で切れても読める）
    print(f"WX-LIVE {'OK' if swim.get('ok') or stats['metarAwc'] or stats['atis'] else 'FAIL'} "
          f"airports={len(payload['airports'])} mode={mode} chunk={len(profile_chunk)}/{len(prof_list)} "
          f"atis={stats['atis']} "
          f"metarSwim={stats['metarSwim']} metarAwc={stats['metarAwc']} "
          f"tafSwim={stats['tafSwim']} tafAwc={stats['tafAwc']} speci={stats['speci']} "
          f"swim={'ok' if swim.get('ok') else swim.get('reason') or 'fail'} kv={kv} t={dt_s:.0f}s", flush=True)
    return 0 if (swim.get("ok") or stats["metarAwc"] or stats["atis"] or bool((prev.get("airports") or {}) and payload.get("airports"))) else 1


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
    interval = args.interval or int(cfg.get("pollSeconds") or 90)
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
            time.sleep(max(30, interval))
    finally:
        try:
            fcntl.flock(lockf, fcntl.LOCK_UN)
        finally:
            lockf.close()


if __name__ == "__main__":
    sys.exit(main())
