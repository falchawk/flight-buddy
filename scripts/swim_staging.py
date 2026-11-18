"""
SWIM（国交省 System-Wide Information Management）の取得結果をパックに入れる。
取得は fetchers/swim/run.js（wx-brief main の lib/swimSession.js・fetchers/swim.js・fetchers/swimAip.js）が
box 上で行い、<staging>/swim/swim.json（正規化済み）に書く。ここはそのファイルを読むだけ（認証情報は扱わない）。

優先順位（wx-brief main の routes/api.js・lib/metarPriority.js と同じ）
  METAR : ① SWIM（空港プロファイルの METAR 枠） ② AWC（JSON→raw） ③ Ogimet
  TAF   : ① SWIM（空港プロファイルの TAF 枠）   ② AWC
  ATIS / NOTAM / 空港プロファイル / AIP Lost Communication : SWIM のみ
"""
import datetime as dt
import json
import os
import re
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from flightcat import classify_metar  # noqa: E402

UTC = dt.timezone.utc
MAX_AGE_H = {"atis": 1.0, "profile": 3.0, "notam": 6.0, "aip": 24 * 35}  # これより古い部品は使わない


# 飛行状態の判定は scripts/flightcat.py（日本の航空法優先＋MVFR/LIFR だけ FAA）


# ---------------------------------------------------------------- 読み込み
def _age_h(iso):
    try:
        return (dt.datetime.now(UTC) - dt.datetime.strptime(iso, "%Y-%m-%dT%H:%M:%SZ").replace(tzinfo=UTC)).total_seconds() / 3600
    except Exception:  # noqa: BLE001
        return 1e9


def load_swim(staging):
    """swim.json を読み、古すぎる部品は除いた dict を返す（無ければ None）。"""
    path = os.path.join(staging, "swim", "swim.json") if staging else None
    if not path or not os.path.exists(path):
        return None
    try:
        with open(path, encoding="utf-8") as f:
            d = json.load(f)
    except Exception:  # noqa: BLE001
        return None
    for part, mx in MAX_AGE_H.items():
        p = d.get(part)
        if p and p.get("fetchedAt") and _age_h(p["fetchedAt"]) > mx:
            d[part] = {"ok": False, "stale": True, "fetchedAt": p["fetchedAt"],
                       "error": f"SWIM の{ {'atis': 'ATIS', 'profile': '空港プロファイル', 'notam': 'NOTAM', 'aip': 'AIP'}[part] }が古いため不使用（{p['fetchedAt']}取得）"}
    return d


def env_note(swim):
    if swim is None:
        return "SWIM 未取得（fetchers/swim/run.js の結果がありません）"
    if not swim.get("envSet"):
        return "SWIM未設定：環境変数 SWIM_USER / SWIM_PASS が未設定です。"
    return None


def _ms_to_iso(ms):
    return dt.datetime.fromtimestamp(ms / 1000, UTC).strftime("%Y-%m-%dT%H:%M:%SZ") if isinstance(ms, (int, float)) else None


def notam_json(swim, airports):
    """NOTAM（SWIM f2dnrq USV001）。airports はパックの NOTAM 対象（SWIM で取った空港）。"""
    note = env_note(swim)
    n = (swim or {}).get("notam") or {}
    out = {"ok": bool(n.get("ok")), "source": "SWIM（国交省）デジタルNOTAM", "fetchedAt": n.get("fetchedAt"),
           "note": note or n.get("note") or n.get("error") or n.get("lastError"), "attempted": bool(n.get("fetchedAt")),
           "airports": {}}
    notes = n.get("notesByIcao") or {}
    for icao in airports:
        items = [{"id": it.get("id"), "issued": _ms_to_iso(it.get("issuedEpoch")),
                  "effectiveFrom": _ms_to_iso(it.get("validFromEpoch")), "effectiveTo": _ms_to_iso(it.get("validToEpoch")),
                  "text": it.get("text") or "", "scopes": it.get("scopes")}
                 for it in n.get("items") or [] if it.get("icao") == icao]
        e = {"items": items}
        if not items:
            e["status"] = notes.get(icao) or (note or ("現在、有効なNOTAMはありません。" if n.get("ok") else (n.get("error") or "未取得")))
        out["airports"][icao] = e
    return out


def atis_json(swim):
    note = env_note(swim)
    a = (swim or {}).get("atis") or {}
    by = a.get("byIcao") or {}
    return {"ok": bool(a.get("ok")), "source": "SWIM（国交省）ATIS", "fetchedAt": a.get("fetchedAt"),
            "note": note or a.get("note") or a.get("error"),
            "airports": {i: {"text": v.get("text")} for i, v in by.items() if v and v.get("ok") and v.get("text")},
            "reasons": {i: v.get("reason") for i, v in by.items() if v and not v.get("ok")}}


def profiles(swim):
    """空港ごとの SWIM 空港プロファイル＋AIP Lost Communication。"""
    note = env_note(swim)
    p = (swim or {}).get("profile") or {}
    aip = (swim or {}).get("aip") or {}
    out = {}
    for icao in set((p.get("byIcao") or {}).keys()) | set((aip.get("byIcao") or {}).keys()):
        pr = dict((p.get("byIcao") or {}).get(icao) or {"ok": False, "reason": note or p.get("error") or "SWIM 空港プロファイルを取得できませんでした"})
        pr["fetchedAt"] = p.get("fetchedAt")
        if pr.get("ok"):  # 旧版の項目名に合わせる
            pr["sunriseJst"], pr["sunsetJst"] = pr.get("sunrise"), pr.get("sunset")
        lc = (aip.get("byIcao") or {}).get(icao)
        if lc:
            pr["lostComm"] = {"ok": bool(lc.get("ok")), "text": lc.get("text"), "url": lc.get("url"), "reason": lc.get("reason"),
                              "fetchedAt": lc.get("fetchedAt") or aip.get("fetchedAt"), "checkedAt": aip.get("fetchedAt")}
        ad2 = (lc or {}).get("ad2")
        if ad2 and (ad2.get("runways") or ad2.get("elevationFt") is not None or ad2.get("freqs")):
            # AIRPORT タブの標高・磁気偏差・滑走路・周波数は AIP（AD 2.2 / 2.12 / 2.18）から（NOAA より正確）
            pr["aip"] = {"url": lc.get("url"), "fetchedAt": lc.get("fetchedAt") or aip.get("fetchedAt"), "checkedAt": aip.get("fetchedAt"),
                         "elevationFt": ad2.get("elevationFt"), "magvar": {k: v for k, v in (ad2.get("magvar") or {}).items() if k != "raw"} or None, "runways": ad2.get("runways") or [],
                         "freqs": ad2.get("freqs") or [], "unparsed": ad2.get("unparsed") or []}
        out[icao] = pr
    return out


# ---------------------------------------------------------------- METAR/TAF の優先順位（lib/metarPriority.js）
def _metar_obs_iso(text, ref):
    m = re.search(r"\b(\d{2})(\d{2})(\d{2})Z\b", text or "")
    if not m:
        return None
    day, hh, mm = int(m[1]), int(m[2]), int(m[3])
    for back in (0, 1):
        y, mo = ref.year, ref.month - back
        if mo == 0:
            y, mo = y - 1, 12
        try:
            t = dt.datetime(y, mo, day, hh, mm, tzinfo=UTC)
        except ValueError:
            continue
        if t <= ref + dt.timedelta(hours=1):
            return t.strftime("%Y-%m-%dT%H:%M:%SZ")
    return None


def _clean(text):
    return (text or "").strip() or None


def apply_priority(wx, swim, targets, ogimet_fn=None):
    """wx-brief main と同じ優先順位で、targets（SWIM 対象空港）の METAR/TAF の出典を決める。
    SWIM の空港プロファイルは SWIM への負荷を抑えるため30分ごとの取得なので、AWC の観測（発表）の方が
    新しい時だけ AWC を採る（同時刻以前なら必ず SWIM）。全空港に metarSource/tafSource/category を付ける。"""
    now = dt.datetime.now(UTC)
    note = env_note(swim)
    pr = (swim or {}).get("profile") or {}
    by = pr.get("byIcao") or {}
    for icao, e in wx["airports"].items():
        e["metarSource"] = "AWC" if e.get("metar") else None
        e["tafSource"] = "AWC" if e.get("taf") else None
        if e.get("metar"):
            for m in e["metar"]:
                m["source"] = "AWC"
    for icao in targets:
        e = wx["airports"].setdefault(icao, {"icao": icao, "ok": False, "metar": [], "taf": None, "fetchedAt": wx.get("fetchedAt")})
        p = by.get(icao) or {}
        if note:
            why = "ID/PASSWORD未設定" if swim and not swim.get("envSet") else note
        elif not pr.get("ok") and pr.get("error"):
            why = pr["error"]
        elif p and p.get("ok") is False:
            why = p.get("reason") or "SWIM 空港プロファイルを取得できませんでした"
        elif p.get("ok"):
            why = "SWIM 空港プロファイルの応答にMETAR/TAF本文が含まれていませんでした"
        else:
            why = "SWIM 空港プロファイルを取得できませんでした"
        sm, st = _clean(p.get("metarText")), _clean(p.get("tafText"))
        awc_m = (e.get("metar") or [None])[0]
        # METAR
        if sm:
            obs = _metar_obs_iso(sm, now)
            if awc_m and awc_m.get("obsTime") and obs and awc_m["obsTime"] > obs:
                e["swimFailReason"] = f"SWIM の METAR（{obs[8:10]}日{obs[11:16]}Z）より AWC の観測が新しいため AWC を表示"
            else:
                e["metar"] = [{"raw": sm, "obsTime": obs, "source": "SWIM", "fltCat": classify_metar(sm)}] + [
                    m for m in (e.get("metar") or []) if not obs or (m.get("obsTime") or "") < obs]
                e["metarSource"] = "SWIM"
                e["ok"] = True
        else:
            e["swimFailReason"] = why
        if not e.get("metar") and ogimet_fn:
            og = ogimet_fn(icao)
            if og.get("ok"):
                e["metar"] = [{"raw": og["rawText"], "obsTime": _metar_obs_iso(og["rawText"], now), "source": "OGIMET",
                               "fltCat": classify_metar(og["rawText"])}]
                e["metarSource"] = "OGIMET"
                e["ok"] = True
            else:
                e["ogimetFailReason"] = og.get("reason")
        # TAF
        if st:
            m = re.search(r"\b(\d{2})(\d{2})(\d{2})Z\b", st)
            awc_t = e.get("taf") or {}
            swim_issue = f"{m[1]}{m[2]}{m[3]}" if m else ""
            awc_issue = re.search(r"\b(\d{6})Z\b", awc_t.get("raw") or "")
            if awc_issue and swim_issue and awc_issue[1] > swim_issue and abs(int(awc_issue[1][:2]) - int(swim_issue[:2])) < 2:
                e["swimTafFailReason"] = "SWIM の TAF より AWC の発表が新しいため AWC を表示"
            else:
                e["taf"] = {"raw": st, "issueTime": None, "validFrom": None, "validTo": None, "source": "SWIM"}
                e["tafSource"] = "SWIM"
                e["ok"] = True
        else:
            e["swimTafFailReason"] = why
    for e in wx["airports"].values():  # 飛行状態の判定は旧版と同じ（lib/flightCategory.js）
        for m in e.get("metar") or []:
            m["fltCat"] = classify_metar(m.get("raw")) or ("VFR" if m is (e.get("metar") or [None])[0] else None)
    wx["source"] = "SWIM（空港プロファイル）→ AWC（aviationweather.gov）→ Ogimet"
    return wx
