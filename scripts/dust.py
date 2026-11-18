"""黄砂・PM2.5 の図（WX > 衛星画像 の「黄砂」「PM2.5 実況」「PM2.5 予測」）。

  黄砂   気象庁 https://www.data.jma.go.jp/env/kosa/
           ひまわり黄砂監視画像（ダスト／トゥルーカラー）… 毎正時（実際の観測は xx:50 開始、画像名は UTC）。毎時20分頃に公開 → 直近24時間
           黄砂解析予測図 地表付近の黄砂濃度（日本域・アジア域）… 1日1回 6時頃（JST）。3時間ごと（2日先以降は6時間ごと）
           黄砂観測実況図 … 当日分は毎時10分・40分頃に更新、前日分
  PM2.5  実況  環境省そらまめ君の1時間値の分布図（作図 国立環境研究所 環境展望台、CC BY 4.0）
           予測  国立環境研究所 大気汚染予測システム VENUS（CC BY-NC 4.0）。1日1回計算（JST 14時台）。3時間ごと

取得の頻度は各ソースの更新周期に合わせ、scripts/schedule.py の予定（kosa_* / pm25_*）に従う。予定外の回は前回の結果をそのまま使う。
同じ URL で中身が入れ替わる配信（黄砂解析予測図・VENUS）は、リスト／ページの内容から作った「版」をキーに blob を持つので、
更新された時だけ取り直す。気象庁の PNG は画素が変わらない可逆 WebP にして小さくする。
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


# ----------------------------------------------------------------------------- 各部品。戻り値は {variant_id: {"label","frames","note"?}}
def himawari_kosa(F, errors, now):
    out = {}
    for code, vid, label in (("DST", "dust", "ダスト画像"), ("TRM", "true", "トゥルーカラー")):
        js = F.text(f"{KOSA}/himawari/kosa_js/{code}Time.js")
        stamps = sorted(set(re.findall(r'imgSat\[i\+\+\]\s*=\s*"(\d{12})"', js or "")))[-24:]
        if not stamps:
            errors.append(f"黄砂 ひまわり{label}: 時刻リスト取得失敗")
            continue
        rels = F.many(lambda s: F.image(f"{KOSA}/himawari/img/{code}/{s}_{code}.jpg", immutable=True), stamps)
        frames = []
        for s, rel in zip(stamps, rels):
            # 画像名は観測開始（UTC）。気象庁のページは +10分 を表示時刻にしている（毎正時の観測）。それに合わせる
            t = _stamp_utc(s) + dt.timedelta(minutes=10)
            fr = _fr(C.lbl(t), rel, t)
            if fr:
                frames.append(fr)
        if frames:
            out[vid] = {"label": label, "frames": frames}
        else:
            errors.append(f"黄砂 ひまわり{label}: 画像なし")
    return out


def kosa_forecast(F, errors, now):
    out = {}
    for area, vid, label, lst, path, suffix in (("jp", "fc_jp", "予測 日本域", "s_jpjp_list.js", "surf/jp", "kosafcst-s_jp_jp"),
                                               ("as", "fc_as", "予測 アジア域", "s_jpas_list.js", "surf/as", "kosafcst-s_jp_as")):
        txt = F.text(f"{KOSA}/fcst/list_js/{lst}")
        if not txt:
            errors.append(f"黄砂解析予測図({label}): リスト取得失敗")
            continue
        ver = hashlib.sha1(txt.encode()).hexdigest()[:10]
        fc = re.findall(r'imgFcst\[i\+\+\]\s*=\s*"(\d{12})"', txt)
        an = re.findall(r'imgAnly\[n\+\+\]\s*=\s*"(\d{12})"', txt)
        items = sorted([(s, "予測") for s in fc] + [(s, "解析") for s in an])
        lo, hi = now - dt.timedelta(hours=12), now + dt.timedelta(hours=48)
        items = [(s, k) for s, k in items if lo <= _stamp_jst(s) <= hi]
        rels = F.many(lambda it: keyed_image(F, f"{KOSA}/fcst/img/{path}/{it[0]}_{suffix}.png", f"kosa:{ver}:{area}:{it[0]}", to_webp=True), items)
        frames = []
        for (s, k), rel in zip(items, rels):
            t = _stamp_jst(s)
            fr = _fr(f"{k} {C.lbl(t)}", rel, t, k)
            if fr:
                frames.append(fr)
        if frames:
            out[vid] = {"label": label, "frames": frames, "ver": ver, "newest": max(fc) if fc else "0"}
        else:
            errors.append(f"黄砂解析予測図({label}): 画像なし")
    return out


def kosa_obs(F, errors, now):
    j = now.astimezone(JST)
    frames = []
    for d, tag in ((j - dt.timedelta(days=1), "前日分"), (j, "当日分")):
        ymd = d.strftime("%Y%m%d")
        rel, lm = F.image_cond(f"{KOSA}/obs/img/jp/{ymd}_kosaobs_jp_jp.png")
        if rel:
            t = lm or now
            frames.append(C.frame(f"{tag} {d:%d日}（更新 {t.astimezone(JST):%H:%M} JST）", [rel], t))
    if not frames:
        errors.append("黄砂観測実況図: 取得失敗")
        return {}
    return {"obs": {"label": "観測実況（視程）", "frames": frames}}


def pm25_obs(F, errors, now):
    j = now.astimezone(JST).replace(minute=0, second=0, microsecond=0)
    hours = [j - dt.timedelta(hours=h) for h in range(11, -1, -1)]
    def get(t):
        ym = t.strftime("%Y/%m")
        return F.image(f"{SORA}/{ym}/PM2.5_{t:%Y%m%d%H}.jpg", immutable=True)
    rels = F.many(get, hours)
    frames = []
    for t, rel in zip(hours, rels):
        tu = t.astimezone(UTC)
        fr = _fr(f"実況 {C.lbl(tu)}", rel, tu, "実況")
        if fr:
            frames.append(fr)
    if not frames:
        errors.append("PM2.5 実況（そらまめ君）: 取得失敗")
        return {}
    return {"obs": {"label": "実況（1時間値）", "frames": frames}}


def pm25_venus(F, errors, now, prev_sig=None):
    h = {}
    st, _, _ = F._raw(f"{VENUS}/table.html", retries=1, hdrs=h, method="HEAD")
    if st != 200:
        errors.append("PM2.5 予測（VENUS）: 取得失敗")
        return {}
    ver = hashlib.sha1(f"{h.get('etag', '')}|{h.get('last-modified', '')}".encode()).hexdigest()[:10]
    run = F.parse_lm(h)
    out = {}
    j0 = (now.astimezone(JST) - dt.timedelta(hours=4)).replace(minute=0, second=0, microsecond=0)
    for area, vid, label, step in (("JPN", "jp", "日本周辺", 3), ("ASA", "as", "東アジア", 6)):
        hours = []
        for k in range(0, 52):
            t = j0 + dt.timedelta(hours=k)
            if t.hour % step == 0:
                hours.append(t)
        def get(t, area=area):
            return keyed_image(F, f"{VENUS}/{area}/PM25/{t:%Y/%m}/{area}_PM25_{t:%Y%m%d%H}.jpg", f"venus:{ver}:{area}:{t:%Y%m%d%H}")
        rels = F.many(get, hours)
        frames = []
        for t, rel in zip(hours, rels):
            tu = t.astimezone(UTC)
            fr = _fr(f"{'予測' if tu > now else '計算'} {C.lbl(tu)}", rel, tu)
            if fr:
                frames.append(fr)
        if frames:
            out[vid] = {"label": label, "frames": frames, "ver": ver, "run": C.iso(run) if run else None}
        else:
            errors.append(f"PM2.5 予測（VENUS {label}）: 画像なし")
    return out


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


def _trim(part, now, past_h):
    out = {}
    for vid, v in part.items():
        fr = [f for f in v["frames"] if not f.get("time") or dt.datetime.strptime(f["time"], "%Y-%m-%dT%H:%M:%SZ").replace(tzinfo=UTC) >= now - dt.timedelta(hours=past_h)]
        if fr:
            out[vid] = dict(v, frames=fr)
    return out


def collect(F, errors):
    """5つの部品（予定の回だけ取る）をまとめて返す。戻り値 {part: {variant_id: {...}}}。"""
    now = schedule.now_utc()
    cache = _load(F)
    jobs = {"kosa_himawari": (himawari_kosa, 24), "kosa_fcst": (kosa_forecast, 12), "kosa_obs": (kosa_obs, 48),
            "pm25_obs": (pm25_obs, 12), "pm25_venus": (pm25_venus, 6)}
    res = {}
    for name, (fn, past_h) in jobs.items():
        c = cache.get(name)
        have = c and c.get("part") and _ok_blobs(F, c["part"])
        if have and not schedule.is_due(name):
            res[name] = _trim(c["part"], now, past_h + 60)
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
            cache[name] = {"part": part, "at": C.iso(now)}
            res[name] = part
        elif have:
            res[name] = _trim(c["part"], now, past_h + 60)   # 取れなかった時は前回分
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


def products(F, errors):
    """衛星画像カテゴリに足す3項目 [(id, label, product)]。"""
    p = collect(F, errors)
    now = schedule.now_utc()

    def vs(order):
        out = []
        for vid, vmap in order:
            v = vmap.get(vid)
            if v and v["frames"]:
                fr = sorted(v["frames"], key=lambda f: f.get("time") or "")
                dflt = _closest_idx(fr, now) if v.get("ver") else None   # 予測系は「いま」に近いコマを最初に出す
                out.append(C.variant(vid, v["label"], fr, dflt))
        return out

    kd = vs([("dust", p.get("kosa_himawari", {})), ("true", p.get("kosa_himawari", {})), ("fc_jp", p.get("kosa_fcst", {})),
             ("fc_as", p.get("kosa_fcst", {})), ("obs", p.get("kosa_obs", {}))])
    dust = C.product("黄砂（ひまわり監視画像・解析予測図・観測実況）", SRC_KOSA, kd, kd[0]["id"] if kd else None,
                     note="ダスト画像：黄砂・火山灰などの砂じんがピンク〜赤紫に写ります（毎時、観測から約20分後に公開）。トゥルーカラー：昼間のみ。"
                          "予測：地表付近（地表〜上空約1km）の黄砂濃度を 日本域／アジア域 で3時間ごと（解析＝前日分、予測＝約3日先まで）。1日1回 6時頃（JST）に更新。"
                          "観測実況：全国の官署の黄砂の有無と視程（km）。当日分は毎時10・40分頃に更新。時刻は JST（Z併記）。")
    pm_o = vs([("obs", p.get("pm25_obs", {}))])
    pm_f = vs([("jp", p.get("pm25_venus", {})), ("as", p.get("pm25_venus", {}))])
    runs = [v.get("run") for v in (p.get("pm25_venus") or {}).values() if v.get("run")]
    run_txt = ""
    if runs:
        try:
            r = dt.datetime.strptime(runs[0], "%Y-%m-%dT%H:%M:%SZ").replace(tzinfo=UTC)
            run_txt = f"計算の更新 {r.astimezone(JST):%d日%H:%M} JST（{r:%H:%M}Z）。"
        except Exception:  # noqa: BLE001
            pass
    pm_obs = C.product("PM2.5 実況（1時間値）", SRC_SORA, pm_o, "obs",
                       note="全国の大気汚染常時監視局（そらまめ君）の PM2.5 1時間値（µg/m³）。速報値。時刻は JST（その時間の値。公開は約1時間半後）。")
    pm_fc = C.product("PM2.5 予測（VENUS）", SRC_VENUS, pm_f, "jp",
                      note="PM2.5 濃度の数値予測と地上風（矢印）。3時間ごと（東アジアは6時間ごと）、約2.5日先まで。1日1回計算。" + run_txt + "時刻は JST（Z併記）。")
    return [("kosa", "黄砂", dust), ("pm25", "PM2.5 実況", pm_obs), ("pm25fc", "PM2.5 予測", pm_fc)]
