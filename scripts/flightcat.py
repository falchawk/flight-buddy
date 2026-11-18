"""飛行状態（VFR/MVFR/IFR/LIFR）の判定。日本の航空法優先＋日本に無い区分だけ FAA の基準。

  IFR/VFR の境界 ＝ 航空法施行規則 第5条第4号（管制圏内の空港等の有視界気象状態）
                   地上視程 5,000m 以上 かつ 雲高 300m(≒1,000ft) 以上 → VFR 側。
                   視程 < 5,000m または シーリング(BKN/OVC/VV) < 1,000ft → IFR 以下
  MVFR / LIFR      ＝ 日本に無い区分なので FAA の基準
                   MVFR: 視程 5,000m〜5SM(約8,047m) または シーリング 1,000〜3,000ft
                   LIFR: 視程 < 1SM(約1,609m) または シーリング < 500ft
  告示空港        ＝ 同号イ・ロの括弧書き（管制圏内で国土交通大臣が告示で指定した空港）は 地上視程 8,000m・雲高 450m(≒1,500ft)。
                   js/vmc-designated.js の strict に載っている空港だけ IFR の境界を 視程 < 8,000m / シーリング < 1,500ft にする。
                   MVFR は 8,000m〜5SM かつ/または 1,500〜3,000ft、LIFR は FAA のまま。
                   【2026-11-18 確認：指定の告示は無く、現在 strict は 0 件。出典: AIP Japan ENR 1.2 §1.2（SWIM AIP, AIRAC 2026-10-29）、
                    航空法施行規則第5条第4号、国土交通省告示第776号（平成17年。調布・但馬・天草は圏外の空港に 5km/300m を適用する別の指定）】
  海外空港        ＝ ICAO が RJ/RO 以外（日本の空港でない）は FAA の基準そのまま：
                   LIFR: 視程 <1SM または シーリング <500ft ／ IFR: 1SM〜<3SM または 500〜<1,000ft
                   MVFR: 3〜5SM または 1,000〜3,000ft ／ VFR: >5SM かつ >3,000ft
視程・シーリングの悪い方を採用する。js/wx.js の flightCategory と同じ判定（変えるときは両方）。
旧版（wx-brief lib/flightCategory.js）は IFR/VFR の境界が視程 3SM(4,828m)。それ以外の区分は同じ。
"""
import json
import os
import re

M_PER_SM = 1609.344
IFR_VIS_M = 5000.0      # 航空法施行規則 第5条第4号イ
IFR_CEIL_FT = 1000      # 同ロ（300m ≒ 984ft。METAR は100ft刻みなので 1,000ft 未満と同じ）
LIFR_VIS_M = M_PER_SM   # 1SM（FAA）
LIFR_CEIL_FT = 500      # FAA
MVFR_VIS_M = 5 * M_PER_SM   # 5SM（FAA）
MVFR_CEIL_FT = 3000     # FAA

FAA_IFR_VIS_M = 3 * M_PER_SM   # 海外空港：IFR は 3SM(4,828m) 未満（FAA）

STRICT_IFR_VIS_M = 8000.0   # 告示空港（施行規則第5条第4号イの括弧書き）
STRICT_IFR_CEIL_FT = 1500   # 同ロの括弧書き（450m ≒ 1,476ft。METAR は100ft刻みなので 1,500ft 未満と同じ）


def _load_strict():
    """js/vmc-designated.js（window.FB_VMC = {...};）の strict を読む。アプリと同じファイルが正本。"""
    path = os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "js", "vmc-designated.js")
    with open(path, encoding="utf-8") as f:
        m = re.search(r"window\.FB_VMC\s*=\s*(\{.*?\});", f.read(), re.S)
    return frozenset(str(x).upper() for x in json.loads(m[1]).get("strict", []))


STRICT_AIRPORTS = _load_strict()


def is_foreign(icao):
    """日本の空港（ICAO が RJ/RO で始まる）以外。"""
    return bool(icao) and not str(icao).upper().startswith(("RJ", "RO"))


def limits(icao=None):
    """空港ごとの IFR 境界 (視程m, シーリングft, 告示空港か)。海外空港は FAA（IFR は 3SM・1,000ft 未満）。"""
    if is_foreign(icao):
        return FAA_IFR_VIS_M, IFR_CEIL_FT, False
    if icao and str(icao).upper() in STRICT_AIRPORTS:
        return STRICT_IFR_VIS_M, STRICT_IFR_CEIL_FT, True
    return IFR_VIS_M, IFR_CEIL_FT, False


_RANK = {"LIFR": 0, "IFR": 1, "MVFR": 2, "VFR": 3}


def vis_m(text):
    t = f" {text} "
    if re.search(r"\bCAVOK\b", t):
        return 10000.0
    m = re.search(r"\s(M|P)?(\d{1,2})(?:\s(\d)/(\d))?SM\b", t)
    if m:
        sm = float(m[2])
        if m[3] and m[4]:
            sm += float(m[3]) / float(m[4])
        return sm * M_PER_SM
    m = re.search(r"\s(M|P)?(\d)/(\d)SM\b", t)
    if m:
        return float(m[2]) / float(m[3]) * M_PER_SM
    # 風の直後（風向変動 140V220 があればその後）の4桁＝視程(m)
    m = re.search(r"\s(?:\d{3}|VRB)\d{2}(?:G\d{2})?(?:KT|MPS)\s+(?:\d{3}V\d{3}\s+)?(\d{4})M?\b", t)  # 気象庁の自動観測は 5000M の書き方もある
    if m:
        return float(m[1])
    m = re.search(r"\s(?:\d{3}|VRB)\d{2}(?:G\d{2})?(?:KT|MPS)\s+(?:\d{3}V\d{3}\s+)?(\d{1,2})KM\b", t)  # 自動観測の 7KM
    if m:
        return float(m[1]) * 1000
    return None


def ceil_ft(text):
    if re.search(r"\bCAVOK\b", text):
        return None
    hs = [int(h) * 100 for h in re.findall(r"\b(?:BKN|OVC|VV)(\d{3})\b", text)]
    return min(hs) if hs else None


def cat_vis(v, icao=None):
    if v is None:
        return None
    if v < LIFR_VIS_M:
        return "LIFR"
    if v < limits(icao)[0]:
        return "IFR"
    if v <= MVFR_VIS_M:
        return "MVFR"
    return "VFR"


def cat_ceil(c, icao=None):
    if c is None:
        return None
    if c < LIFR_CEIL_FT:
        return "LIFR"
    if c < limits(icao)[1]:
        return "IFR"
    if c <= MVFR_CEIL_FT:
        return "MVFR"
    return "VFR"


def classify_metar(text, icao=None):
    """METAR 本文から飛行状態。判定できなければ None。icao が告示空港なら 8km/1,500ft 基準。"""
    if not text:
        return None
    fc, fv = cat_ceil(ceil_ft(text), icao), cat_vis(vis_m(text), icao)
    if not fc and not fv:
        return None
    if not fc:
        return fv
    if not fv:
        return fc
    return fc if _RANK[fc] <= _RANK[fv] else fv
