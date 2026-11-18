"""取得元ごとの「実行する時刻（due）」の判定。自動更新（15分ごと）の各回で、どの取得元を取るかをここで決める。

  毎回（15分ごと）   国内の METAR/TAF（SWIM 空港プロファイル→AWC→Ogimet）・ATIS・図（WX の画像）
  6時間ごと          SWIM NOTAM            … 毎日 00:00 / 06:00 / 12:00 / 18:00 JST
  1日1回             国内の空港情報         … 毎日 04:00 JST（SWIM AIP AD 2＋Lost Comm、NOAA/AWC 空港情報＝参考値）
  1時間に1回          海外空港の METAR/TAF   … 毎正時以降の最初の回（海外は取らない回は前回の値と取得時刻をそのまま引き継ぐ）
  週1回              海外空港の空港情報(NOAA) … 毎週月曜 04:00 JST
  1日1回             時刻表（全ソース）     … 毎日 04:30 JST（ODPT 全件・ANA 公式PDF・空港の発着案内・各社PDF・rararakt）
  ※ SWIM の空港プロファイルは METAR/TAF 本文を含む唯一の SWIM の応答なので、毎回取る（SWIM 優先を保つため）。

実行は :02 / :17 / :32 / :47（JST）。予定時刻（00/06/12/18時・04:00・04:30・毎正時）は「予定時刻以降の最初の回」で取るので、
実行時刻が数分ずれていても問題ない（例: 00:00 の NOTAM は 00:02 の回、毎正時の海外 WX は :02 の回）。
「予定時刻」を過ぎてから一度も成功していなければ due（＝取りこぼしても次の回で追いつく）。
失敗した時は 60 分あけて再試行（15分ごとに叩き続けない）。成功／試行の記録は staging の due-state.json。
"""
import datetime as dt
import json
import os

JST = dt.timezone(dt.timedelta(hours=9))
STATE_FILE = os.environ.get("FB_STATE_FILE", "/workspace/fb-staging/due-state.json")
RETRY_MIN = 60

# part -> None（毎回）または JST の (時, 分) のリスト
SCHEDULE = {
    "atis": None,
    "profile": None,
    "notam": [(0, 0), (6, 0), (12, 0), (18, 0)],
    "aip": [(4, 0)],
    "noaa_airport": [(4, 0)],
    "noaa_airport_foreign": [(0, 4, 0)],   # 週1回（毎週月曜 04:00 JST）。(曜日, 時, 分)、曜日は 0=月
    "wx_foreign": [(h, 0) for h in range(24)],   # 海外空港の METAR/TAF は1時間に1回（毎正時。15分ごとの実行のうち :00 以降の最初の回）
    "flights": [(4, 30)],
}
LABEL = {"noaa_airport_foreign": "海外空港情報(NOAA)", "wx_foreign": "海外METAR/TAF", "atis": "ATIS", "profile": "METAR/TAF(SWIM)", "notam": "NOTAM", "aip": "AIP", "noaa_airport": "空港情報(NOAA)", "flights": "時刻表"}


def now_utc():
    v = os.environ.get("FB_NOW")  # テスト用: 2026-11-18T19:00:00Z
    return dt.datetime.strptime(v, "%Y-%m-%dT%H:%M:%SZ").replace(tzinfo=dt.timezone.utc) if v else dt.datetime.now(dt.timezone.utc)


def _slot_times(day_date, slots):
    """その日（JST）に当たる予定時刻。slots の要素は (時, 分)＝毎日、(曜日, 時, 分)＝毎週。"""
    for sl in slots:
        if len(sl) == 3:
            wd, h, m = sl
            if day_date.weekday() != wd:
                continue
        else:
            h, m = sl
        yield dt.datetime(day_date.year, day_date.month, day_date.day, h, m, tzinfo=JST)


def latest_slot(now, slots):
    """now 以前で最も新しい予定時刻（UTC aware）。"""
    j = now.astimezone(JST)
    best = None
    for day in range(0, -9, -1):
        d = (j + dt.timedelta(days=day)).date()
        for t in _slot_times(d, slots):
            if t <= j and (best is None or t > best):
                best = t
    return best.astimezone(dt.timezone.utc)


def next_slot(now, slots):
    j = now.astimezone(JST)
    best = None
    for day in range(0, 9):
        d = (j + dt.timedelta(days=day)).date()
        for t in _slot_times(d, slots):
            if t > j and (best is None or t < best):
                best = t
    return best


def load():
    try:
        with open(STATE_FILE, encoding="utf-8") as f:
            return json.load(f)
    except Exception:  # noqa: BLE001
        return {}


def save(state):
    os.makedirs(os.path.dirname(STATE_FILE), exist_ok=True)
    tmp = STATE_FILE + ".tmp"
    with open(tmp, "w", encoding="utf-8") as f:
        json.dump(state, f, indent=1, sort_keys=True)
    os.replace(tmp, STATE_FILE)


def _t(v):
    try:
        return dt.datetime.strptime(v, "%Y-%m-%dT%H:%M:%SZ").replace(tzinfo=dt.timezone.utc)
    except Exception:  # noqa: BLE001
        return None


def iso(t):
    return t.strftime("%Y-%m-%dT%H:%M:%SZ")


def seed(state, part, ok_at_iso):
    """記録が無い取得元は、既にある取得結果の時刻（fetchedAt）を成功時刻として引き継ぐ（導入直後に全部を取り直さない）。"""
    if part not in state and ok_at_iso and _t(ok_at_iso):
        state[part] = {"okAt": ok_at_iso}


def is_due(part, state=None, now=None, force=False):
    slots = SCHEDULE[part]
    if slots is None or force or os.environ.get("FB_FORCE_DUE") == "1":
        return True
    state = load() if state is None else state
    now = now or now_utc()
    slot = latest_slot(now, slots)
    s = state.get(part) or {}
    ok, tried = _t(s.get("okAt")), _t(s.get("tryAt"))
    if ok and ok >= slot:
        return False
    if tried and tried >= slot and (now - tried) < dt.timedelta(minutes=RETRY_MIN):
        return False   # 今日の予定で失敗した直後
    return True


def mark(state, part, ok, now=None):
    now = now or now_utc()
    s = state.setdefault(part, {})
    s["tryAt"] = iso(now)
    if ok:
        s["okAt"] = iso(now)


def describe(state, now=None):
    """要約用：予定のある取得元の次回予定（JST）。"""
    now = now or now_utc()
    out = {}
    for p, slots in SCHEDULE.items():
        if slots and p != "wx_foreign":
            nx = next_slot(now, slots)
            out[p] = nx.strftime("%H:%M") if len(slots[0]) == 2 else nx.strftime("%a%H:%M")
    return out


def record(part, ok, now=None):
    """成功／試行を state ファイルに記録（読み直して書くので、別の処理が書いた他の部品を消さない）。"""
    st = load()
    mark(st, part, ok, now)
    save(st)
