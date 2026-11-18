"""
SWIM（国交省 航空情報）ステージング読み込み。
ボット（ブラウザ）が SWIM の応答 JSON を「そのまま」次の場所に保存し、ここで整形してパックに入れる。
認証情報はここでは一切扱わない（ファイルを読むだけ）。

  <staging>/notam/<ICAO>.json   … POST f2dnrq/web/FUV201/USV001 の応答（空港ごと）
  <staging>/atis.json           … POST f2atrq/web/FLV402/LGV062 の応答（複数空港まとめて1回）
  <staging>/profile/<ICAO>.json … POST f2appr/web/FLV806/LGV220 の応答（空港ごと）
  ※ どれも {"fetchedAt": "...Z", "response": <応答そのまま>} でも、応答そのままでも可（後者は mtime を取得時刻とみなす）
  ※ <staging>/notam.json（整形済み形式, examples/notam.sample.json）があれば従来どおりそちらを優先
"""
import datetime as dt
import json
import os
import re

UTC = dt.timezone.utc
JST = dt.timezone(dt.timedelta(hours=9))
MAX_AGE_H = 6  # これより古いステージングは使わない（古いATIS等を出さない）


def _load(path):
    try:
        with open(path, encoding="utf-8") as f:
            d = json.load(f)
    except Exception:  # noqa: BLE001
        return None, None
    fetched = None
    if isinstance(d, dict) and "response" in d:
        fetched = d.get("fetchedAt")
        d = d["response"]
    if not fetched:
        fetched = dt.datetime.fromtimestamp(os.path.getmtime(path), UTC).strftime("%Y-%m-%dT%H:%M:%SZ")
    return d, fetched


def _age_h(fetched):
    try:
        t = dt.datetime.strptime(fetched, "%Y-%m-%dT%H:%M:%SZ").replace(tzinfo=UTC)
        return (dt.datetime.now(UTC) - t).total_seconds() / 3600
    except Exception:  # noqa: BLE001
        return 999


def _swim_utc(s):
    """'YYYY/MM/DD HH:mm' (UTC) → ISO Z"""
    if not s or not isinstance(s, str):
        return None
    m = re.match(r"(\d{4})/(\d{2})/(\d{2})\s+(\d{2}):(\d{2})", s.strip())
    if not m:
        return None
    return f"{m[1]}-{m[2]}-{m[3]}T{m[4]}:{m[5]}:00Z"


def _issued(xml):
    if not isinstance(xml, str):
        return None
    m = re.search(r"<event:issued>([^<]+)</event:issued>", xml)
    if not m:
        return None
    v = m.group(1).strip()
    return v if v.endswith("Z") else v + ("Z" if re.match(r"\d{4}-\d\d-\d\dT\d\d:\d\d(:\d\d)?$", v) else "")


def load_notam_raw(staging, airports):
    d = os.path.join(staging, "notam")
    if not os.path.isdir(d):
        return None
    out = {"ok": True, "source": "SWIM（国交省）f2dnrq USV001 — ボットが取得", "fetchedAt": None, "airports": {}}
    got = 0
    for icao in airports:
        raw, fetched = _load(os.path.join(d, f"{icao}.json"))
        if raw is None:
            out["airports"][icao] = {"items": [], "status": "未取得"}
            continue
        if _age_h(fetched) > MAX_AGE_H:
            out["airports"][icao] = {"items": [], "status": f"未取得（ステージングが古い {fetched}）"}
            continue
        ret = (raw or {}).get("ret") or {}
        if raw.get("error") or not isinstance(ret.get("notamList"), list):
            out["airports"][icao] = {"items": [], "status": "取得失敗（応答形式が想定外）"}
            continue
        items = []
        for n in ret["notamList"]:
            items.append({"id": n.get("number") or n.get("uuid") or str(n.get("sequenceNo") or ""),
                          "issued": _issued(n.get("digitalNotam")),
                          "effectiveFrom": _swim_utc(n.get("startDate")),
                          "effectiveTo": _swim_utc(n.get("endDate")),
                          "text": n.get("list") or n.get("contents") or ""})
        out["airports"][icao] = {"items": items, "fetchedAt": fetched}
        out["fetchedAt"] = max(out["fetchedAt"] or "", fetched)
        got += 1
    if not got:
        return None
    return out


def load_atis(staging):
    raw, fetched = _load(os.path.join(staging, "atis.json"))
    if raw is None:
        return {"ok": False, "note": "ATIS 未取得（SWIM ステージング無し）", "airports": {}}
    if _age_h(fetched) > 1.5:
        return {"ok": False, "note": f"ATIS 未取得（ステージングが古い {fetched}）", "airports": {}}
    dto = ((raw or {}).get("ret") or {}).get("atisInfoDTO") or {}
    locs, texts = dto.get("locationList") or [], dto.get("fltxDataInfList") or []
    ap = {icao: {"text": texts[i]} for i, icao in enumerate(locs) if i < len(texts) and texts[i]}
    return {"ok": bool(ap), "source": "SWIM（国交省）f2atrq LGV062", "fetchedAt": fetched, "airports": ap}


def _hhmm(s):
    return f"{s[:2]}:{s[2:]}" if isinstance(s, str) and re.match(r"^\d{4}$", s) else s


def _utc_hhmm_to_jst(s):
    if not (isinstance(s, str) and re.match(r"^\d{4}$", s)):
        return None
    m = (int(s[:2]) * 60 + int(s[2:]) + 540) % 1440
    return f"{m // 60:02d}:{m % 60:02d}"


def load_profiles(staging, airports):
    d = os.path.join(staging, "profile")
    out = {}
    if not os.path.isdir(d):
        return out
    for icao in airports:
        raw, fetched = _load(os.path.join(d, f"{icao}.json"))
        if raw is None or _age_h(fetched) > MAX_AGE_H:
            continue
        r = (raw or {}).get("ret") or {}
        if raw.get("error") or (r.get("errorInfoDTO") or {}).get("result") != "OK":
            out[icao] = {"ok": False, "reason": "SWIM 応答エラー", "fetchedAt": fetched}
            continue
        arr = lambda k: r.get(k) if isinstance(r.get(k), list) else []  # noqa: E731
        out[icao] = {
            "ok": True, "fetchedAt": fetched,
            "operatingHours": (f"{_hhmm(r['serviceStartTime'])}-{_hhmm(r['serviceEndTime'])}"
                               if r.get("serviceStartTime") and r.get("serviceEndTime") else None),
            "runwaysInUse": [f"LDG RWY {x}" for x in arr("runwayNoLdg")] + [f"DEP RWY {x}" for x in arr("runwayNoDep")],
            "approach": arr("approach"),
            "operationalStatus": arr("airportUsage"),
            "sunriseJst": _utc_hhmm_to_jst(r.get("sunriseTime")),
            "sunsetJst": _utc_hhmm_to_jst(r.get("sunsetTime")),
            "departureDelayMin": r.get("departureDelayTime") if isinstance(r.get("departureDelayTime"), (int, float)) else None,
            "arrivalDelayMin": r.get("arrivalDelayTime") if isinstance(r.get("arrivalDelayTime"), (int, float)) else None,
            "aerodromeWarning": arr("aerodromeWarningWrnData"),
            "metarText": (arr("metarSpeciBodyData") or [None])[0],
            "tafText": (arr("tafBodyData") or [None])[0],
            "atisText": (arr("atisBodyData") or [None])[0],
        }
    return out
