"""黄砂・PM2.5 の図（WX > 衛星画像 の「黄砂」「PM2.5」）。軽く・速く：黄砂は予測5枚＋観測1枚、PM2.5 は実況1枚＋予測5枚の必要な分だけ取る。

  黄砂   気象庁 https://www.data.jma.go.jp/env/kosa/
           予測 日本域 … 黄砂解析予測図（地表付近の黄砂濃度）。1日1回 6時頃（JST）更新、3時間ごと。「いまに一番近い時刻」＋その先3時間ごとの4コマ（計5コマ）
           観測実況（視程） … 黄砂観測実況図は「1日1枚」（その日の分を毎時10・40分頃に更新）で3時間ごとの図は無い → 当日の1枚だけ（無ければ取れる一番新しい1枚）
  PM2.5  1つの「PM2.5」タブに2つのサブタブ（バリアント）。2つは別々のコマ列で、混ぜない。
           実況 … 環境省そらまめ君の1時間値（作図 国立環境研究所 環境展望台、CC BY 4.0）の最新1枚
           予測 … 国立環境研究所 VENUS 日本周辺（CC BY-NC 4.0。1日1回計算、3時間ごと）。「いま以降で一番早い時刻」から3時間ごとの5コマ（12時間先まで、過去は無し）
           東アジアは取らない。

取得の頻度は各ソースの更新周期に合わせ、scripts/schedule.py の予定（kosa_* / pm25_*）に従う。リスト／ヘッダだけ（軽い）を予定の回に取り、
画像は必要な枚数だけ取る（同じ「版」＋時刻の画像は端末に持った分をそのまま使う）。同じ URL で中身が入れ替わる配信（黄砂解析予測図・VENUS）は
リスト／ヘッダから作った「版」をキーに blob を持つので、更新された時だけ取り直す。気象庁の PNG は画素が変わらない可逆 WebP にして小さくする。
"""
import datetime as dt
import hashlib
import io
import json
import os
import re
import time

import charts as C
import schedule

UTC, JST = C.UTC, C.JST
KOSA = "https://www.data.jma.go.jp/env/kosa"
SORA = "https://venus.nies.go.jp/soramame/map/PM2.5"
VENUS = "https://venus.nies.go.jp/datadepot/gmtmap"
SRC_KOSA = "気象庁 Japan Meteorological Agency"
SRC_SORA = "環境省 そらまめ君（速報値）／作図 国立環境研究所 環境展望台 CC BY 4.0"
SRC_VENUS = "国立環境研究所 大気汚染予測システム VENUS（https://venus.nies.go.jp/）CC BY-NC 4.0"
PART_FILE = "dust_parts.json"
CACHE_V = 3


def _stamp_utc(s):
    return dt.datetime.strptime(s[:12], "%Y%m%d%H%M").replace(tzinfo=UTC)


def _stamp_jst(s):
    return dt.datetime.strptime(s[:12].ljust(12, "0"), "%Y%m%d%H%M").replace(tzinfo=JST).astimezone(UTC)


def _jst_hour(t):
    return t.astimezone(JST).strftime("%Y%m%d%H")


def keyed_image(F, url, key, to_webp=False, hdrs=None):
    """版（key）つきで取得。同じ key があればネットワークを使わない。to_webp=True は PNG を可逆 WebP にする（画素は同じ）。"""
    with F.lock:
        hit = F.urlmap.get(key)
    if hit and os.path.exists(os.path.join(F.blob_dir, os.path.basename(hit["f"]))):
        with F.lock:
            hit["t"] = time.time()
            F.stats["cached"] += 1
        return hit["f"]
    h = {} if hdrs is None else hdrs
    st, body, ct = F._raw(url, hdrs=h)
    if st != 200 or not body:
        return None
    ext = C.CT_EXT.get(ct) or ("png" if body[:4] == b"\x89PNG" else "jpg" if body[:2] == b"\xff\xd8" else None)
    if not ext:
        return None
    if to_webp and ext == "png":
        from PIL import Image
        im = Image.open(io.BytesIO(body))
        im = im.convert("RGBA" if im.mode == "RGBA" else "RGB")
        b = io.BytesIO()
        im.save(b, "WEBP", lossless=True, quality=100, method=6)
        if len(b.getvalue()) < len(body):
            body, ext = b.getvalue(), "webp"
    rel = F.store(body, ext)
    with F.lock:
        F.stats["hits"] += 1
        F.urlmap[key] = {"f": rel, "t": time.time()}
    return rel


def _closest_idx(frames, now):
    best, bi = None, max(len(frames) - 1, 0)
    for i, f in enumerate(frames):
        t = dt.datetime.strptime(f["time"], "%Y-%m-%dT%H:%M:%SZ").replace(tzinfo=UTC) if f.get("time") else None
        if t and t <= now and (best is None or t > best):
            best, bi = t, i
    return bi


def _fr(label, rel, t, kind=None):
    return C.frame(label, [rel], t, kind) if rel else None


# ----------------------------------------------------------------------------- 各部品。戻り値は {variant_id: {...}}
def kosa_forecast(F, errors, now):
    """黄砂解析予測図 日本域の「時刻リスト」だけ（画像は products() で必要な5枚だけ取る）。"""
    txt = F.text(f"{KOSA}/fcst/list_js/s_jpjp_list.js")
    if not txt:
        errors.append("黄砂解析予測図(日本域): リスト取得失敗")
        return {}
    ver = hashlib.sha1(txt.encode()).hexdigest()[:10]
    fc = re.findall(r'imgFcst\[i\+\+\]\s*=\s*"(\d{12})"', txt)
    an = re.findall(r'imgAnly\[n\+\+\]\s*=\s*"(\d{12})"', txt)
    items = sorted([(s, "予測") for s in fc] + [(s, "解析") for s in an])
    if not items:
        errors.append("黄砂解析予測図(日本域): 時刻なし")
        return {}
    return {"fc_jp": {"label": "予測 日本域", "frames": [], "items": items, "ver": ver, "newest": max(fc) if fc else "0"}}


def kosa_obs(F, errors, now):
    """黄砂観測実況図（1日1枚）。当日の1枚だけ。早朝などで当日分がまだ無い時は、取れる一番新しい1枚（前日・前々日）にして、何日の分かをラベルに書く。"""
    j = now.astimezone(JST)
    for back, tag in ((0, "当日"), (1, "前日"), (2, "前々日")):
        d = j - dt.timedelta(days=back)
        rel, lm = F.image_cond(f"{KOSA}/obs/img/jp/{d:%Y%m%d}_kosaobs_jp_jp.png")
        if rel:
            t = lm or now
            lab = f"{tag}分 {d:%m/%d}（更新 {t.astimezone(JST):%H:%M} JST）" if back else f"{tag} {d:%m/%d}（更新 {t.astimezone(JST):%H:%M} JST）"
            return {"obs": {"label": "観測実況（視程）", "frames": [C.frame(lab, [rel], t)]}}
    errors.append("黄砂観測実況図: 取得失敗")
    return {}


def pm25_obs(F, errors, now):
    """そらまめ君の最新の1時間値1枚（公開は約1.5時間後なので、いまの時刻から遡って最初に取れたもの）。"""
    j = now.astimezone(JST).replace(minute=0, second=0, microsecond=0)
    for h in range(0, 7):
        t = j - dt.timedelta(hours=h)
        rel = F.image(f"{SORA}/{t:%Y/%m}/PM2.5_{t:%Y%m%d%H}.jpg", immutable=True)
        if rel:
            tu = t.astimezone(UTC)
            return {"obs": {"label": "実況（1時間値）", "frames": [C.frame(f"実況 {C.lbl(tu)}", [rel], tu, "実況")]}}
    errors.append("PM2.5 実況（そらまめ君）: 取得失敗")
    return {}


def pm25_venus(F, errors, now, prev_sig=None):
    """VENUS のヘッダ（版・計算時刻）だけ。画像は products() で必要な2枚だけ取る。"""
    h = {}
    st, _, _ = F._raw(f"{VENUS}/table.html", retries=1, hdrs=h, method="HEAD")
    if st != 200:
        errors.append("PM2.5 予測（VENUS）: 取得失敗")
        return {}
    if "table.html" not in (h.get("x-final-url") or "table.html"):
        # メンテナンス中などでトップへ転送された（200 の別ページ）。版（ver）を作らず失敗扱い＝前回分を使う
        errors.append("PM2.5 予測（VENUS）: サーバー停止中（トップへ転送）")
        return {}
    ver = hashlib.sha1(f"{h.get('etag', '')}|{h.get('last-modified', '')}".encode()).hexdigest()[:10]
    run = F.parse_lm(h)
    return {"jp": {"label": "日本周辺", "frames": [], "ver": ver, "run": C.iso(run) if run else None}}


# ----------------------------------------------------------------------------- 取得頻度の制御（前回の結果を保存して、予定外の回はそれを使う）
def _cache_path(F):
    return os.path.join(os.path.dirname(F.cache_path), PART_FILE)


def _load(F):
    try:
        with open(_cache_path(F), encoding="utf-8") as f:
            return json.load(f)
    except Exception:  # noqa: BLE001
        return {}


def _ok_blobs(F, part):
    return all(os.path.exists(os.path.join(F.blob_dir, os.path.basename(im["file"])))
               for v in part.values() for fr in v["frames"] for im in fr["images"])


def _load_last_fc(F):
    """最後に取れた PM2.5 予測のコマ（画像が端末に残っているものだけ）。"""
    fr = (_load(F).get("pm25_fc_last") or {}).get("frames") or []
    ok = [f for f in fr if f.get("images") and all(os.path.exists(os.path.join(F.blob_dir, os.path.basename(im["file"]))) for im in f["images"])]
    return ok if len(ok) == len(fr) else []


def _save_last_fc(F, frames):
    c = _load(F)
    c["pm25_fc_last"] = {"frames": frames, "at": C.iso(schedule.now_utc())}
    try:
        tmp = _cache_path(F) + ".tmp"
        with open(tmp, "w", encoding="utf-8") as f:
            json.dump(c, f, ensure_ascii=False)
        os.replace(tmp, _cache_path(F))
    except Exception:  # noqa: BLE001
        pass


def collect(F, errors):
    """3つの部品（予定の回だけ取る）をまとめて返す。戻り値 {part: {variant_id: {...}}}。"""
    now = schedule.now_utc()
    cache = _load(F)
    cache.pop("kosa_himawari", None)   # ダスト画像・トゥルーカラーは廃止
    jobs = {"kosa_fcst": kosa_forecast, "kosa_obs": kosa_obs, "pm25_obs": pm25_obs, "pm25_venus": pm25_venus}
    res = {}
    for name, fn in jobs.items():
        c = cache.get(name)
        if c and c.get("v") != CACHE_V:
            c = None   # 旧形式（v1.9.8 の全コマ版）の保存分は使わない
        have = c and c.get("part") and _ok_blobs(F, c["part"])
        if have and not schedule.is_due(name):
            res[name] = c["part"]
            continue
        errs = []
        try:
            part = fn(F, errs, now)
        except Exception as e:  # noqa: BLE001
            part, errs = {}, errs + [f"{name}: 例外 {type(e).__name__}: {e}"]
        ok = bool(part)
        if name == "kosa_fcst" and ok:   # 6時頃の更新がまだ反映されていない（最新の予測時刻が3日先に届いていない）なら失敗扱い＝60分後に再試行
            newest = min(v.get("newest", "0") for v in part.values())
            ok = _stamp_jst(newest).astimezone(JST).date() >= (now.astimezone(JST) + dt.timedelta(days=3)).date()
        schedule.record(name, ok)
        if part:
            cache[name] = {"part": part, "at": C.iso(now), "v": CACHE_V}
            res[name] = part
        elif have:
            res[name] = c["part"]   # 取れなかった時は前回分
            errs.append(f"{name}: 前回分を使用")
        errors.extend(errs)
    try:
        tmp = _cache_path(F) + ".tmp"
        with open(tmp, "w", encoding="utf-8") as f:
            json.dump(cache, f, ensure_ascii=False)
        os.replace(tmp, _cache_path(F))
    except Exception:  # noqa: BLE001
        pass
    return res


def pick_forecast(items, now, n=5, step_h=3):
    """items=[(stamp,kind)] を時刻順に。いまに一番近いコマ＋その先 step_h（3）時間ごとの n-1 コマ（計 n=5 コマ）。
    リストの終わりに届かず揃わない時は、5コマ揃う一番遅い開始に前へずらす（それも無ければ最後の n コマ）。"""
    if not items:
        return []
    ts = [_stamp_jst(s) for s, _ in items]
    i = min(range(len(items)), key=lambda k: abs((ts[k] - now).total_seconds()))
    at = {t: k for k, t in enumerate(ts)}
    for st in range(i, -1, -1):
        idx = [at.get(ts[st] + dt.timedelta(hours=step_h * m)) for m in range(n)]
        if None not in idx:
            return [items[k] for k in idx]
    return items[-n:]


def pm25_steps(now, step_h=3, n=5):
    """PM2.5 予測（VENUS）の n コマ。JST で step_h の倍数の時刻のうち「いま以降で一番早い」時刻（過去は使わない。
    いまに一番近い時刻が1分でも過去なら次の時刻を1コマ目にする）、その先 step_h 時間ごとに計 n コマ（5コマなら12時間先まで）。"""
    j = now.astimezone(JST).replace(minute=0, second=0, microsecond=0)
    t = j
    while t < now or t.hour % step_h != 0:
        t += dt.timedelta(hours=1)
    return [t + dt.timedelta(hours=step_h * m) for m in range(n)]


def products(F, errors):
    """衛星画像カテゴリに足す2項目 [(id, label, product)]。必要な画像（黄砂予測5＋観測1＋PM2.5 実況1＋予測5）だけ取る。"""
    p = collect(F, errors)
    now = schedule.now_utc()

    # ---- 黄砂
    kd = []
    fcv = (p.get("kosa_fcst") or {}).get("fc_jp")
    if fcv:
        sel = pick_forecast([tuple(x) for x in fcv["items"]], now)
        rels = F.many(lambda it: keyed_image(F, f"{KOSA}/fcst/img/surf/jp/{it[0]}_kosafcst-s_jp_jp.png", f"kosa:{fcv['ver']}:jp:{it[0]}", to_webp=True), sel)
        frames = []
        for (s, k), rel in zip(sel, rels):
            t = _stamp_jst(s)
            fr = _fr(f"{k} {C.lbl(t)}", rel, t, k)
            if fr:
                frames.append(fr)
        if frames:
            kd.append(C.variant("fc_jp", fcv["label"], frames, 0))
        else:
            errors.append("黄砂解析予測図(日本域): 画像なし")
    ov = (p.get("kosa_obs") or {}).get("obs")
    if ov and ov["frames"]:
        kd.append(C.variant("obs", ov["label"], sorted(ov["frames"], key=lambda f: f.get("time") or ""), None))
    dust = C.product("黄砂（解析予測図・観測実況）", SRC_KOSA, kd, kd[0]["id"] if kd else None,
                     note="予測：地表付近（地表〜上空約1km）の黄砂濃度（日本域）。いまに一番近い時刻とその先4コマ（3時間ごと、計5コマ）。1日1回 6時頃（JST）に更新。"
                          "観測実況：全国の官署の黄砂の有無と視程（km）。1日1枚の図（当日分は毎時10・40分頃に更新）なので当日の1枚だけ（早朝で当日分がまだ無い時は取れる一番新しい1枚で、何日の分かを表示）。時刻は JST（Z併記）。")

    # ---- PM2.5（実況1・予測5 の2つのサブタブ）
    pm_obs, pm_fc = [], []
    obs = (p.get("pm25_obs") or {}).get("obs")
    obs_fr = (obs or {}).get("frames") or []
    pm_obs.extend(obs_fr[-1:])
    vv = (p.get("pm25_venus") or {}).get("jp")
    run_txt = ""
    if vv:
        steps = pm25_steps(now)
        def get(t):
            return keyed_image(F, f"{VENUS}/JPN/PM25/{t:%Y/%m}/JPN_PM25_{t:%Y%m%d%H}.jpg", f"venus:{vv['ver']}:JPN:{t:%Y%m%d%H}")
        rels = F.many(get, steps)
        got = 0
        for t, rel in zip(steps, rels):
            tu = t.astimezone(UTC)
            fr = _fr(f"予測 {C.lbl(tu)}", rel, tu)
            if fr:
                pm_fc.append(fr); got += 1
        if got:
            _save_last_fc(F, pm_fc)
        else:
            # 取れたコマが0（VENUS 停止中・計算の切替え直後など）：タブを空にしない。前回パックの予測コマを（過去になっていても）そのまま出す
            last = _load_last_fc(F)
            if last:
                pm_fc.extend(last)
                errors.append("PM2.5 予測（VENUS 日本周辺）: 新しい画像が取れず前回分を表示")
            else:
                errors.append("PM2.5 予測（VENUS 日本周辺）: 画像なし")
        if vv.get("run"):
            try:
                r = dt.datetime.strptime(vv["run"], "%Y-%m-%dT%H:%M:%SZ").replace(tzinfo=UTC)
                run_txt = f"予測の計算の更新 {r.astimezone(JST):%d日%H:%M} JST（{r:%H:%M}Z）。"
            except Exception:  # noqa: BLE001
                pass
    if not obs_fr:
        errors.append("PM2.5 実況（そらまめ君）: 画像なし")
    pv = []
    if pm_obs:
        pv.append(C.variant("pm_obs", "実況", pm_obs, None))
    if pm_fc:
        fcv_ = C.variant("pm_fc", "予測", pm_fc, 0)
        pv.append(fcv_)
    pm_p = C.product("PM2.5", f"{SRC_SORA}（実況）／ {SRC_VENUS}（予測）", pv, pv[0]["id"] if pv else None,
                     note="実況：環境省そらまめ君の全国の PM2.5 1時間値 µg/m³（速報値）の最新1枚。"
                          "予測：VENUS 日本周辺（PM2.5 濃度と地上風の矢印）の、いま以降で一番早い時刻から3時間ごとの5コマ（12時間先まで）。パック作成時点では過去のコマは無く、作成後に時刻が過ぎたコマもそのまま表示します。"
                          + run_txt + "時刻は JST（Z併記）。")
    return [("kosa", "黄砂", dust), ("pm25", "PM2.5", pm_p)]
