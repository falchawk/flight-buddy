#!/usr/bin/env python3
"""BRIEF 本文の「自動(初便の3時間前)」と「手動(チャットでの依頼)」の判定・記録・公開。

  verify [FILE]            リクエスト本文（stdin か FILE。JSON か「pin: 1234」形式の文章）から暗証番号を取り出し、
                           環境変数 FB_BRIEF_PIN と定数時間で比較する。暗証番号は表示・ログ・保存しない。
                           5回続けて間違えると 30 分ロック。成功したリクエストも約10分に1回まで。
  should-run-auto [--explain]
                           自動作成を「今」やるか（15分ごとの更新が毎回呼ぶ）。狙い時刻＝今日の最初の運航便（FLT）の STD−3時間（JST）。
                           便が無い日・狙い時刻が 08:30 より遅い日（午後便）・今日の duty_default.json が無い日は 08:30。
                           現在が「狙い時刻−13分」以降で、今日まだ自動を作っていなければ RUN（終了コード 0）。
                           今日 03:00 JST 以降に手動があるか、今日すでに自動を作っていれば SKIP（10）。
                           --explain は狙い時刻と理由を表示（時刻・便名・理由だけ。個人情報なし）。
  record manual|auto       作成時刻を記録（brief_state.json）。
  publish --kind K         /workspace/fb-staging/brief.md を kind(auto/manual)・作成時刻つきでパックに入れて公開
                           （auto_update.py をロック待ちで実行）。成功したら record も行う。

終了コード: 0=OK  2=暗証番号が違う  3=ロック中  4=リクエストが多すぎる  5=暗証番号が未設定  6=リクエストの形が不正/古い  10=SKIP
状態: /workspace/fb-staging/brief_state.json（時刻は JST）。暗証番号そのものは一切書かない。
テスト用: FB_NOW=2026-11-18T23:30:00Z / FB_BRIEF_STATE=/tmp/x.json
"""
import argparse
import datetime as dt
import hashlib
import hmac
import json
import os
import re
import subprocess
import sys
import time

JST = dt.timezone(dt.timedelta(hours=9))
ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
STATE = os.environ.get("FB_BRIEF_STATE", "/workspace/fb-staging/brief_state.json")
BRIEF = "/workspace/fb-staging/brief.md"
MAX_FAIL, LOCK_MIN, RATE_MIN, DAY_START_H, STALE_MIN = 5, 30, 10, 3, 30


def now():
    v = os.environ.get("FB_NOW")
    return dt.datetime.strptime(v, "%Y-%m-%dT%H:%M:%SZ").replace(tzinfo=dt.timezone.utc) if v else dt.datetime.now(dt.timezone.utc)


def jst(t):
    return t.astimezone(JST).strftime("%Y-%m-%dT%H:%M:%S+09:00")


def parse(s):
    return dt.datetime.fromisoformat(s) if s else None


def load():
    try:
        with open(STATE, encoding="utf-8") as f:
            return json.load(f)
    except Exception:  # noqa: BLE001
        return {}


def save(st):
    os.makedirs(os.path.dirname(STATE), exist_ok=True)
    tmp = STATE + ".tmp"
    with open(tmp, "w", encoding="utf-8") as f:
        json.dump(st, f, ensure_ascii=False, indent=1)
    os.replace(tmp, STATE)


def day_start(t):
    """「その日」の始まり＝03:00 JST。t が 03:00 前なら前日の 03:00。"""
    j = t.astimezone(JST)
    d = j.replace(hour=DAY_START_H, minute=0, second=0, microsecond=0)
    return d if j >= d else d - dt.timedelta(days=1)


def extract(text):
    """リクエスト本文から (pin, requestedAt)。pin は数字だけ受け付ける。"""
    pin = req = None
    try:
        d = json.loads(text)
    except Exception:  # noqa: BLE001
        d = None
        m = re.search(r"\{.*\}", text, re.S)   # 文章の中に JSON があるとき
        if m:
            try:
                d = json.loads(m.group(0))
            except Exception:  # noqa: BLE001
                d = None

    def walk(o):
        nonlocal pin, req
        if isinstance(o, dict):
            for k, v in o.items():
                if str(k).lower() == "pin" and isinstance(v, (str, int)) and pin is None:
                    pin = str(v)
                elif str(k).lower() == "requestedat" and isinstance(v, str) and req is None:
                    req = v
                else:
                    walk(v)
        elif isinstance(o, list):
            for v in o:
                walk(v)
        elif isinstance(o, str) and o.lstrip().startswith("{"):
            try:
                walk(json.loads(o))
            except Exception:  # noqa: BLE001
                pass
    walk(d)
    if pin is None:
        m = re.search(r"(?i)\bpin\b\W{0,4}(\d{4,12})\b", text)
        pin = m.group(1) if m else None
    if req is None:
        m = re.search(r"(?i)requestedAt\W{0,4}(\d{4}-\d\d-\d\dT[\d:.+Zz-]+)", text)
        req = m.group(1) if m else None
    return pin, req


def cmd_verify(a):
    t = now()
    st = load()
    pin_set = os.environ.get("FB_BRIEF_PIN", "")
    if not pin_set:
        print("VERIFY nopin: 暗証番号（環境変数 FB_BRIEF_PIN）がまだ設定されていません")
        return 5
    lu = parse(st.get("lockedUntil"))
    if lu and t < lu:
        print(f"VERIFY locked until={jst(lu)}")
        return 3
    text = open(a.file, encoding="utf-8").read() if a.file else sys.stdin.read()
    pin, req = extract(text)
    del text
    if not pin or not re.fullmatch(r"\d{1,12}", pin):
        print("VERIFY badpayload: 暗証番号（数字）が見つかりません")   # 形の不備は失敗回数に数えない
        return 6
    if req:
        try:
            r = dt.datetime.fromisoformat(req.replace("Z", "+00:00"))
            if r.tzinfo is None:
                r = r.replace(tzinfo=dt.timezone.utc)
            if abs((t - r).total_seconds()) > STALE_MIN * 60:
                print("VERIFY stale: requestedAt が古い/先の時刻です（再送信してください）")
                return 6
        except Exception:  # noqa: BLE001
            print("VERIFY badpayload: requestedAt の形式が不正です")
            return 6
    ok = hmac.compare_digest(hashlib.sha256(pin.encode()).digest(), hashlib.sha256(pin_set.encode()).digest())
    del pin
    if not ok:
        n = int(st.get("failCount") or 0) + 1
        st["failCount"] = n
        st["lastFailAt"] = jst(t)
        if n >= MAX_FAIL:
            st["lockedUntil"] = jst(t + dt.timedelta(minutes=LOCK_MIN))
            st["failCount"] = 0
            save(st)
            print(f"VERIFY wrong locked until={st['lockedUntil']}（{MAX_FAIL}回違い）")
            return 3
        save(st)
        print(f"VERIFY wrong fail={n}/{MAX_FAIL}")
        return 2
    last = parse(st.get("lastVerifiedAt"))
    if last and (t - last).total_seconds() < RATE_MIN * 60:
        print(f"VERIFY ratelimited next={jst(last + dt.timedelta(minutes=RATE_MIN))}")
        return 4
    st["failCount"] = 0
    st.pop("lockedUntil", None)
    st["lastVerifiedAt"] = jst(t)
    save(st)
    print("VERIFY ok")
    return 0


DUTY_DEFAULT = os.environ.get("FB_DUTY_DEFAULT", "/workspace/fb-staging/duty_default.json")
DEFAULT_TARGET = (8, 30)     # 便が無い日・午後便の日・duty_default.json が無い日
LEAD_H, EARLY_MIN = 3, 13    # 初便 STD の 3 時間前が狙い。15分スロットの前倒し 13 分


def target_time(t):
    """狙い時刻（JST の datetime）と理由・便名（任意）を返す。duty_default.json は duty_fetch.py（00:02 の更新）が書く今日の運航便（FLT）だけ。"""
    j = t.astimezone(JST)
    today = j.strftime("%Y-%m-%d")
    default = j.replace(hour=DEFAULT_TARGET[0], minute=DEFAULT_TARGET[1], second=0, microsecond=0)
    try:
        with open(DUTY_DEFAULT, encoding="utf-8") as f:
            dd = json.load(f)
    except Exception:  # noqa: BLE001
        return default, "duty_default.json が読めない → 08:30", None
    if dd.get("date") != today:
        return default, f"duty_default.json が今日の分ではない（{dd.get('date')}）→ 08:30", None
    firsts = []
    for f in dd.get("flights") or []:
        m = re.fullmatch(r"(\d{2}):(\d{2})", f.get("std") or "")
        if m:
            firsts.append((int(m.group(1)) * 60 + int(m.group(2)), f"{f.get('airline') or 'SFJ'}{f.get('flightNumber')}"))
    if not firsts:
        return default, "今日は運航便（FLT）なし → 08:30", None
    mins, name = min(firsts)
    tgt = j.replace(hour=0, minute=0, second=0, microsecond=0) + dt.timedelta(minutes=mins - LEAD_H * 60)
    if tgt > default:
        return default, f"初便 {name} STD {mins // 60:02d}:{mins % 60:02d} −3h は 08:30 より遅い（午後便）→ 08:30", name
    if tgt < j.replace(hour=0, minute=0, second=0, microsecond=0):
        tgt = j.replace(hour=0, minute=0, second=0, microsecond=0)
    return tgt, f"初便 {name} STD {mins // 60:02d}:{mins % 60:02d} −3h", name


def cmd_should_run_auto(a):
    t = now()
    j = t.astimezone(JST)
    st = load()
    midnight = j.replace(hour=0, minute=0, second=0, microsecond=0)
    three = midnight.replace(hour=DAY_START_H)
    lm, la = parse(st.get("lastManualAt")), parse(st.get("lastAutoAt"))
    tgt, why, _ = target_time(t)
    start = tgt - dt.timedelta(minutes=EARLY_MIN)
    head = f"target={tgt.strftime('%H:%M')} start={start.strftime('%H:%M')} ({why})"
    if lm and lm >= three and lm <= j:
        print(f"SKIP manual-done lastManual={jst(lm)}（今日 03:00 JST 以降に手動作成済み） {head}" if a.explain else f"SKIP manual-done lastManual={jst(lm)}（今日 03:00 JST 以降に手動作成済み）")
        return 10
    if la and la >= midnight and la <= j:
        print(f"SKIP auto-done lastAuto={jst(la)} {head}" if a.explain else f"SKIP auto-done lastAuto={jst(la)}")
        return 10
    if j < start:
        print(f"WAIT before-start now={j.strftime('%H:%M')} {head}" if a.explain else f"SKIP not-yet start={start.strftime('%H:%M')}")
        return 10
    print(f"RUN now={j.strftime('%H:%M')} {head}" if a.explain else "RUN")
    return 0


def cmd_record(a):
    t = now()
    st = load()
    st["lastManualAt" if a.kind == "manual" else "lastAutoAt"] = jst(t)
    save(st)
    print(f"RECORDED {a.kind} {jst(t)}")
    return 0


def cmd_publish(a):
    if not os.path.exists(BRIEF) or not open(BRIEF, encoding="utf-8").read().strip():
        print("PUBLISH FAILED: /workspace/fb-staging/brief.md がありません（先に本文を書いてください）")
        return 1
    t = now()
    meta = {"kind": a.kind, "writtenAt": t.strftime("%Y-%m-%dT%H:%M:%SZ"), "slot": None}
    with open(BRIEF + ".meta.json", "w", encoding="utf-8") as f:
        json.dump(meta, f, ensure_ascii=False)
    last = ""
    for i in range(12):   # 15分ごとの自動更新がロックを持っている間は SKIP で返るので待って再試行（最大 約6分）
        r = subprocess.run([sys.executable, os.path.join(ROOT, "scripts", "auto_update.py")], capture_output=True, text=True, timeout=700)
        last = (r.stdout.strip().splitlines() or [""])[-1] if r.stdout.strip() else r.stderr.strip()[-200:]
        line = next((x for x in r.stdout.splitlines() if x.startswith("FLIGHT-BUDDY")), last)
        if "SKIP" in line:
            time.sleep(30)
            continue
        if "FLIGHT-BUDDY OK" in line and "changed=yes" in line and "pushed=yes" in line:
            args = argparse.Namespace(kind=a.kind)
            cmd_record(args)
            print("PUBLISH OK " + line[:300])
            return 0
        print("PUBLISH FAILED " + line[:300])
        return 1
    print("PUBLISH FAILED lock-busy " + last[:200])
    return 1


def main():
    ap = argparse.ArgumentParser()
    sub = ap.add_subparsers(dest="cmd", required=True)
    v = sub.add_parser("verify"); v.add_argument("file", nargs="?")
    sr = sub.add_parser("should-run-auto"); sr.add_argument("--explain", action="store_true")
    r = sub.add_parser("record"); r.add_argument("kind", choices=["manual", "auto"])
    p = sub.add_parser("publish"); p.add_argument("--kind", required=True, choices=["manual", "auto"])
    a = ap.parse_args()
    return {"verify": cmd_verify, "should-run-auto": cmd_should_run_auto, "record": cmd_record, "publish": cmd_publish}[a.cmd](a)


if __name__ == "__main__":
    sys.exit(main())
