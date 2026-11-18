#!/usr/bin/env python3
"""DUTY の自動入力用：StarFlyer iFlight Lite（主アカウントのみ）から「今日（JST）の乗務便」を取り、
/workspace/fb-staging/duty_default.json に書く。  {date, flights:[{airline, flightNumber, dep, arr, std, sta}], fetchedAt}

公開パックに入れるのは 便名・航空会社・日付・出発/到着空港・出発/到着時刻 だけ。乗員名・社員番号・アカウント名・機体登録記号・
地上勤務/休日などの内容は一切入れない（ここで項目を絞り、build_pack でもう一度許可リストで絞る）。
ID/パスワードは環境変数（SFJ_IFLIGHT_USERNAME / SFJ_IFLIGHT_PASSWORD）だけ。表示・ログ・保存しない。
ログイン・レポート取得は /workspace/starflyer の flights.py / check_crew.py をそのまま使う（読み込むだけで変更しない）。
運航便（activity=FLT）だけ。便乗（DHD）・待機・宿泊・休日は含めない。
"""
import datetime as dt
import json
import os
import re
import sys

JST = dt.timezone(dt.timedelta(hours=9))
OUT = "/workspace/fb-staging/duty_default.json"
STARFLYER = "/workspace/starflyer"
IATA_ICAO = {}


def _icao(code):
    return code   # 空港コードは IATA 3レター（FUK など）のまま保存。アプリが IATA/ICAO どちらも扱う


def fetch_today(day=None):
    """主アカウント（suffix ''）の今日のデータ。戻り値 dict。失敗は例外（メッセージに認証情報は入れない）。"""
    sys.path.insert(0, STARFLYER)
    import requests
    import flights as FL
    from check_crew import UA, login
    day = day or dt.datetime.now(JST).date()
    s = requests.Session()
    s.headers.update(UA)
    try:
        login(s, "")
        html, _ = FL.report_local(s, day.year, day.month - 1)
        items = FL.parse_day(html, day)["items"]
    finally:
        try:
            s.get(FL.BASE + "default.asp?LogOff=1", timeout=15)
        except Exception:  # noqa: BLE001
            pass
    out = []
    for it in items:
        if (it.get("activity") or "").strip().upper() != "FLT":
            continue
        m = re.fullmatch(r"7G0*(\d{1,4})", (it.get("flight") or "").strip().upper())
        r = re.fullmatch(r"([A-Z]{3})-([A-Z]{3})", (it.get("route") or "").strip().upper())
        if not m or not r:
            continue
        hm = lambda v: v if re.fullmatch(r"\d{2}:\d{2}", v or "") else None  # noqa: E731
        out.append({"airline": "SFJ", "flightNumber": m.group(1), "dep": r.group(1), "arr": r.group(2),
                    "std": hm(it.get("dep")), "sta": hm(it.get("arr"))})
    return {"date": day.isoformat(), "flights": out,
            "fetchedAt": dt.datetime.now(dt.timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")}


def write(path=OUT):
    d = fetch_today()
    tmp = path + ".tmp"
    with open(tmp, "w", encoding="utf-8") as f:
        json.dump(d, f, ensure_ascii=False)
    os.replace(tmp, path)
    return d


if __name__ == "__main__":
    try:
        d = write()
        print(f"DUTY OK date={d['date']} flights={','.join('SFJ' + x['flightNumber'] for x in d['flights']) or 'none'}")
    except Exception as e:  # noqa: BLE001
        print(f"DUTY FAILED {type(e).__name__}")
        sys.exit(1)
