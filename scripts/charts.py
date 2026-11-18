"""
Flight Buddy charts fetcher（旧 Flight Buddy=wx-brief の WX 図 8分類をそのまま再現）
すべて plain HTTP（ログイン不要の直リンク）。画像は内容アドレス方式で data/blobs/<sha256>.<ext> に保存し、
同じ画像はパック間で共有（端末も差分だけダウンロード）。タイムスタンプ入りURL（不変）は URL→blob を
キャッシュして再取得しない。
"""
import datetime as dt
import hashlib
import json
import os
import re
import subprocess
import tempfile
import threading
import time
import urllib.error
import urllib.request
from concurrent.futures import ThreadPoolExecutor

UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36"
UTC = dt.timezone.utc
JST = dt.timezone(dt.timedelta(hours=9))
CT_EXT = {"image/png": "png", "image/jpeg": "jpg", "image/jpg": "jpg", "image/gif": "gif", "image/webp": "webp",
          "application/pdf": "pdf"}

JMA_AIR = "https://www.data.jma.go.jp/airinfo/data"
METAIR = "https://www3.metair.go.jp/pict"
SRC_JMA = "気象庁 Japan Meteorological Agency"
SRC_METAIR = "Japan Meteorological Agency / MetAir"


def log(*a):
    print("[charts]", *a, flush=True, file=__import__("sys").stderr)


def iso(t):
    return t.astimezone(UTC).strftime("%Y-%m-%dT%H:%M:%SZ")


def ts14(t):
    return t.astimezone(UTC).strftime("%Y%m%d%H%M%S")


def parse14(s):
    return dt.datetime.strptime(s[:14], "%Y%m%d%H%M%S").replace(tzinfo=UTC)


def lbl(t):
    """'18日07:00Z（16:00 JST）'"""
    j = t.astimezone(JST)
    return f"{t.astimezone(UTC):%d}日{t.astimezone(UTC):%H:%M}Z（{j:%H:%M} JST）"


class Fetcher:
    def __init__(self, data_dir, workers=16):
        self.blob_dir = os.path.join(data_dir, "blobs")
        os.makedirs(self.blob_dir, exist_ok=True)
        self.cache_path = os.path.join(data_dir, ".cache", "urlmap.json")
        os.makedirs(os.path.dirname(self.cache_path), exist_ok=True)
        try:
            with open(self.cache_path) as f:
                self.urlmap = json.load(f)
        except Exception:  # noqa: BLE001
            self.urlmap = {}
        self.lock = threading.Lock()
        self.pool = ThreadPoolExecutor(max_workers=workers)
        self.stats = {"requests": 0, "cached": 0, "hits": 0, "bytes_new": 0, "errors": 0}

    def save(self):
        with self.lock:
            # 7日より古いエントリは捨てる
            cutoff = time.time() - 7 * 86400
            self.urlmap = {k: v for k, v in self.urlmap.items() if v.get("t", 0) > cutoff}
            with open(self.cache_path, "w") as f:
                json.dump(self.urlmap, f)

    def _raw(self, url, timeout=25, retries=2):
        last = None
        for i in range(retries + 1):
            try:
                with self.lock:
                    self.stats["requests"] += 1
                req = urllib.request.Request(url, headers={"User-Agent": UA, "Accept": "*/*", "Accept-Language": "ja,en;q=0.8"})
                with urllib.request.urlopen(req, timeout=timeout) as r:
                    return r.status, r.read(), (r.headers.get("Content-Type") or "").split(";")[0].strip().lower()
            except urllib.error.HTTPError as e:
                if e.code in (403, 404, 410):
                    return e.code, b"", ""
                last = e
            except Exception as e:  # noqa: BLE001
                last = e
            time.sleep(1.5 * (i + 1))
        with self.lock:
            self.stats["errors"] += 1
        return None, str(last).encode(), ""

    def text(self, url):
        st, body, _ = self._raw(url)
        return body.decode("utf-8", "replace") if st == 200 else None

    def store(self, body, ext):
        sha = hashlib.sha256(body).hexdigest()
        rel = f"data/blobs/{sha}.{ext}"
        p = os.path.join(self.blob_dir, f"{sha}.{ext}")
        if not os.path.exists(p):
            with open(p + ".tmp", "wb") as f:
                f.write(body)
            os.replace(p + ".tmp", p)
            with self.lock:
                self.stats["bytes_new"] += len(body)
        return rel

    def image(self, url, immutable=False):
        """画像URLを取得してblobパス(data/blobs/..)を返す。無ければNone。"""
        if immutable:
            with self.lock:
                hit = self.urlmap.get(url)
            if hit and os.path.exists(os.path.join(self.blob_dir, os.path.basename(hit["f"]))):
                with self.lock:
                    self.stats["cached"] += 1
                return hit["f"]
        st, body, ct = self._raw(url)
        if st != 200 or not body:
            return None
        ext = CT_EXT.get(ct)
        if not ext:
            if body[:4] == b"\x89PNG":
                ext = "png"
            elif body[:2] == b"\xff\xd8":
                ext = "jpg"
            else:
                return None
        rel = self.store(body, ext)
        with self.lock:
            self.stats["hits"] += 1
            if immutable:
                self.urlmap[url] = {"f": rel, "t": time.time()}
        return rel

    def pdf_page1_png(self, url):
        st, body, ct = self._raw(url, timeout=40)
        if st != 200 or body[:4] != b"%PDF":
            return None
        with tempfile.TemporaryDirectory() as td:
            pdf = os.path.join(td, "in.pdf")
            with open(pdf, "wb") as f:
                f.write(body)
            subprocess.run(["pdftoppm", "-png", "-r", "110", "-f", "1", "-l", "1", "-singlefile", pdf, os.path.join(td, "out")],
                           check=True, timeout=90, capture_output=True)
            with open(os.path.join(td, "out.png"), "rb") as f:
                png = f.read()
        return self.store(png, "png")

    def many(self, fn, items):
        return list(self.pool.map(fn, items))


def frame(label, images, time_=None, kind=None, layout=None):
    f = {"label": label, "images": [{"file": i} for i in images if i]}
    if time_:
        f["time"] = iso(time_)
    if kind:
        f["kind"] = kind
    if layout:
        f["layout"] = layout
    return f


def product(title, source, variants, default_variant=None, note=None, ptype="series"):
    return {"type": ptype, "title": title, "source": source, "note": note,
            "variants": variants, "defaultVariant": default_variant or (variants[0]["id"] if variants else None)}


def variant(vid, label, frames, default_frame=None, group=None):
    v = {"id": vid, "label": label, "frames": frames,
         "defaultFrame": default_frame if default_frame is not None else max(len(frames) - 1, 0)}
    if group:
        v["group"] = group
    return v


# =============================================================================== 1. 地上天気図
def surface_charts(F, errors):
    lst = F.text("https://www.jma.go.jp/bosai/weather_map/data/list.json")
    out = {}
    try:
        d = json.loads(lst)["asia"]
    except Exception:  # noqa: BLE001
        errors.append("地上天気図: list.json 取得失敗")
        return out
    for key, region, need, fh in (("asas", "now", "JCIasas", 0), ("fsas24", "ft24", "JCIfsas24", 24), ("fsas48", "ft48", "JCIfsas48", 48)):
        names = [n for n in d.get(region, []) if need in n and "JRcolor" in n]
        if not names:
            errors.append(f"地上天気図 {key}: 一覧に無し")
            continue
        name = names[-1]
        m = re.search(r"_C_\d+_(\d{14})_", name)
        base = parse14(m.group(1)) if m else None
        f = F.image("https://www.jma.go.jp/bosai/weather_map/data/png/" + name, immutable=True)
        if f:
            valid = base + dt.timedelta(hours=fh) if base else None
            out[key] = frame(("実況 " if fh == 0 else f"{fh}時間予想 ") + (lbl(valid) if valid else ""), [f], valid,
                             "ANALYSIS" if fh == 0 else "FORECAST")
    return out


# =============================================================================== 2. 衛星・雲頂
def himawari(F, band, errors):
    now = dt.datetime.now(UTC)
    r = now.replace(minute=now.minute // 10 * 10, second=0, microsecond=0)
    cands = [r - dt.timedelta(minutes=10 * i) for i in range(13)]
    cands = [c for c in cands if c >= now - dt.timedelta(hours=2, minutes=5)]
    res = F.many(lambda t: (t, F.image(f"https://www.data.jma.go.jp/mscweb/data/himawari/img/jpn/jpn_{band}_{t:%H%M}.jpg")), cands)
    frames = [frame(lbl(t), [f], t, "実況") for t, f in sorted(res) if f]
    if not frames:
        errors.append(f"ひまわり {band}: 取得できず")
    return frames


def cloud_top(F, errors):
    now = dt.datetime.now(UTC)
    r = now.replace(minute=now.minute // 10 * 10, second=0, microsecond=0)
    cands = [r - dt.timedelta(minutes=10 * i) for i in range(13)]
    cands = [c for c in cands if c >= now - dt.timedelta(hours=2, minutes=5)]
    res = F.many(lambda t: (t, F.image(f"{METAIR}/satellite/hf/alt/ENJP64_RJTD_{ts14(t)}.jpg", immutable=True)), cands)
    frames = [frame(lbl(t), [f], t, "実況") for t, f in sorted(res) if f]
    if not frames:
        errors.append("雲頂高度: 取得できず")
    return frames


# =============================================================================== 3. レーダー（気象庁 軽量版）
RAIN_REGIONS = [("00", "全国"), ("05", "道北西部"), ("04", "道東部"), ("06", "道南西部"), ("17", "東北北部"), ("18", "東北南部"),
                ("09", "関東"), ("11", "甲信"), ("19", "東海"), ("07", "北陸東部"), ("08", "北陸西部"), ("10", "近畿"),
                ("02", "中国"), ("16", "四国"), ("12", "九州北部"), ("13", "九州南部"), ("01", "奄美"), ("14", "沖縄本島"),
                ("03", "大東島"), ("15", "宮古八重山")]
RAIN = "https://www.jma.go.jp/bosai/rain"


def rain_time(F, path):
    t = F.text(f"{RAIN}/data/{path}/time.json")
    try:
        return dt.datetime.fromisoformat(json.loads(t)["time"]).astimezone(UTC)
    except Exception:  # noqa: BLE001
        return None


def rain_url(typ, elem, base, ft, area):
    b = ts14(base)
    return f"{RAIN}/data/{typ}/{b}/{elem}_{b}_f{ft:02d}_a{area}.png"


def offset_label(t, kind, off_min):
    clock = f"{t.astimezone(JST):%H:%M} JST"
    if kind != "予想" or off_min <= 0:
        return f"実況 {clock}"
    h, m = divmod(off_min, 60)
    o = f"+{m}分" if h == 0 else (f"+{h}時間" if m == 0 else f"+{h}時間{m}分")
    return f"予想 {o} {clock}"


def rain_series(F, errors):
    """戻り値: {nowcast|thunder|rainfc: [variant per region]}"""
    tr, tt = rain_time(F, "rain"), rain_time(F, "thunder")
    tra, tsrf, tsrf15 = rain_time(F, "ra"), rain_time(F, "srf"), rain_time(F, "srf15")
    cand = {"nowcast": [], "thunder": [], "rainfc": []}
    for key, latest, typ, step in (("nowcast", tr, "rain", 5), ("thunder", tt, "thunder", 10)):
        if not latest:
            errors.append(f"{key}: time.json 取得失敗")
            continue
        for m in range(180, -1, -step):
            t = latest - dt.timedelta(minutes=m)
            if m == 0 or t.minute % 30 == 0:
                cand[key].append((t, "実況", -m, typ, typ, t, 0))
        for s in range(1, 60 // step + 1):
            t = latest + dt.timedelta(minutes=s * step)
            if t.minute % 30 == 0:
                cand[key].append((t, "予想", s * step, typ, typ, latest, s))
    if tra:
        cand["rainfc"].append((tra, "実況", 0, "ra", "rain01", tra, 0))
        bytime = {}
        if tsrf:
            for ft in range(1, 9):
                t = tsrf + dt.timedelta(hours=ft)
                bytime[t] = (t, "予想", int((t - tra).total_seconds() // 60), "srf", "rain01", tsrf, ft)
        if tsrf15:
            for ft in range(5, 19):
                t = tsrf15 + dt.timedelta(hours=ft)
                bytime[t] = (t, "予想", int((t - tra).total_seconds() // 60), "srf15", "rain01", tsrf15, ft)
        cand["rainfc"] += [bytime[k] for k in sorted(bytime)]
    else:
        errors.append("今後の雨: time.json 取得失敗")

    maps = {}
    def getmap(area):
        return area, F.image(f"{RAIN}/const/map/map_a{area}.png", immutable=True), F.image(f"{RAIN}/const/map/border_a{area}.png", immutable=True)
    for area, m, b in F.many(getmap, [a for a, _ in RAIN_REGIONS]):
        maps[area] = (m, b)

    jobs = [(key, area, c) for key in cand for area, _ in RAIN_REGIONS for c in cand[key]]
    def get(job):
        key, area, c = job
        t, kind, off, typ, elem, base, ft = c
        return job, F.image(rain_url(typ, elem, base, ft, area), immutable=True)
    got = {}
    for (key, area, c), f in F.many(get, jobs):
        if f:
            got.setdefault((key, area), []).append((c, f))
    out = {}
    for key in cand:
        variants = []
        for area, name in RAIN_REGIONS:
            items = sorted(got.get((key, area), []), key=lambda x: x[0][0])
            mp, bd = maps.get(area, (None, None))
            frames = []
            for c, f in items:
                t, kind, off, *_ = c
                frames.append(frame(offset_label(t, kind, off), [mp, f, bd], t, kind, layout="layers"))
            if not frames:
                continue
            di = next((i for i, (c, _) in enumerate(items) if c[1] == "実況" and c[2] == 0), 0)
            variants.append(variant(f"a{area}", name, frames, di))
        if not variants:
            errors.append(f"{key}: 画像が1枚も取得できず")
        out[key] = variants
    return out


# =============================================================================== 4. 三十分大気解析
AIRWAYS = [("201", "01", "福岡-釧路"), ("202", "02", "福岡-紋別"), ("203", "03", "東京-稚内"), ("204", "04", "東京-女満別"),
           ("205", "05", "福岡-東京"), ("206", "06", "鹿児島-東京"), ("207", "07", "石垣-東京"), ("208", "08", "与那国-高松"),
           ("209", "09", "与那国-福岡"), ("299", "99", "与那国-稚内")]
MERIDIANS = [("250", "50", "145E"), ("251", "51", "142.5E"), ("252", "52", "140E"), ("253", "53", "137.5E"), ("254", "54", "135E"),
             ("255", "55", "132.5E"), ("256", "56", "130E"), ("257", "57", "127.5E"), ("258", "58", "125E"), ("259", "59", "122.5E")]
PLAN_LEVELS = ["41"] + [f"{z:02d}" for z in range(39, 10, -2)] + ["09"]  # FL410, FL390..FL110, FL090（ソースはFL奇数のみ。FL400・FL100は存在しない）
FCST_MAX_H = 6


def analysis30(F, errors):
    txt = F.text(f"{JMA_AIR}/conf/list_maiji.js") or ""
    times = sorted({parse14(m) for m in re.findall(r'ImageInfo\(\s*"(\d{14})"', txt)})
    if not times:
        errors.append("三十分大気解析: list_maiji.js 取得失敗")
    T = times[-1] if times else None
    # MetAir 予想の初期時刻: (now-2.5h) を3時間で切り捨て、無ければ3時間ずつ戻る
    now = dt.datetime.now(UTC)
    adj = now - dt.timedelta(hours=2.5)
    base = adj.replace(hour=adj.hour // 3 * 3, minute=0, second=0, microsecond=0)
    init = None
    for k in range(4):
        c = base - dt.timedelta(hours=3 * k)
        probe = F.many(lambda yy: F.image(f"{METAIR}/anl/simpllfm/WANLCS205-{yy:02d}_RJTD_{ts14(c)}.png", immutable=True), [1, 2])
        if any(probe):
            init = c
            break
    if init is None:
        errors.append("三十分大気解析: MetAir予想の初期時刻が見つからず")
    yys = []
    if init and T:
        yys = [yy for yy in range(1, 11) if T < init + dt.timedelta(hours=yy) <= T + dt.timedelta(hours=FCST_MAX_H)]

    def fc_url(kind, code, yy, ext):
        if kind == "plan":
            return f"{METAIR}/anl/multi/fllfm/WANLF21{code}-{yy:02d}_RJTD_{ts14(init)}.{ext}"
        return f"{METAIR}/anl/simpllfm/WANLCS{code}-{yy:02d}_RJTD_{ts14(init)}.{ext}"

    specs = [("plan", z, z, f"FL{int(z) * 10:03d}", "平面図") for z in PLAN_LEVELS]
    specs += [("cross", c, rr, name, "断面図（航空路）") for c, rr, name in AIRWAYS]
    specs += [("cross", c, rr, name, "断面図（経度）") for c, rr, name in MERIDIANS]
    jobs = []
    for s in specs:
        kind, code, jcode, _, _ = s
        for t in times:
            url = (f"{JMA_AIR}/pict/maiji/WANLF1{jcode}_RJTD_{ts14(t)}.PNG" if kind == "plan"
                   else f"{JMA_AIR}/pict/maiji/WANLC1{jcode}_RJTD_{ts14(t)}.PNG")
            jobs.append((s, "A", t, url))
        for yy in yys:
            jobs.append((s, "F", init + dt.timedelta(hours=yy), (kind, code, yy)))

    def get(job):
        s, ak, t, u = job
        if ak == "A":
            return job, F.image(u, immutable=True)
        kind, code, yy = u
        f = F.image(fc_url(kind, code, yy, "png"), immutable=True) or F.image(fc_url(kind, code, yy, "PNG"), immutable=True)
        return job, f
    got = {}
    for (s, ak, t, u), f in F.many(get, jobs):
        if f:
            got.setdefault(s, []).append((t, ak, f))
    variants = []
    for s in specs:
        kind, code, jcode, name, group = s
        items = sorted(got.get(s, []))
        frames = []
        for t, ak, f in items:
            if ak == "A":
                frames.append(frame(f"ANALYSIS {lbl(t)}", [f], t, "ANALYSIS"))
            else:
                yy = int((t - init).total_seconds() // 3600)
                frames.append(frame(f"FORECAST {lbl(t)}（初期 {init:%d}日{init:%H}Z +{yy}h）", [f], t, "FORECAST"))
        if not frames:
            errors.append(f"三十分大気解析 {group} {name}: 取得できず")
            continue
        di = max([i for i, fr in enumerate(frames) if fr["kind"] == "ANALYSIS"] or [0])
        vid = f"plan{code}" if kind == "plan" else f"cs{code}"
        variants.append(variant(vid, name, frames, di, group))
    note = (f"ANALYSIS＝気象庁 airinfo（毎時、直近{len(times)}時刻）、FORECAST＝MetAir（初期 {init:%d日%H}Z、解析最新時刻から+{FCST_MAX_H}hまで）。"
            "平面図は FL410・FL390〜FL110・FL090（ソースに FL400・FL100 は無い。奇数 FL のみ）。" if init else "")
    p = product("三十分大気解析", f"{SRC_JMA} / MetAir", variants, "cs205", note)
    p["groupDefaults"] = {"平面図": "plan39", "断面図（航空路）": "cs205", "断面図（経度）": "cs250"}  # 平面図の既定は FL390
    return p


# =============================================================================== 5. 高層天気図
NK = "https://n-kishou.com/ee/exp/exp01.html"


def nkishou(F, cd, cat, name):
    html = F.text(f"{NK}?cd={cd}&cat={cat}") or ""
    m = re.search(rf"https?://n-kishou\.com/ee/image4/lfax/resize/{name}_r(\d{{12}})\.png", html, re.I)
    if not m:
        return None, None
    t = dt.datetime.strptime(m.group(1), "%Y%m%d%H%M").replace(tzinfo=UTC)
    # n-kishou のファイル名時刻は JST の可能性があるため、表示は「掲載 YYYYMMDDHHMM」を併記
    return F.image(m.group(0).replace("http://", "https://"), immutable=True), m.group(1)


def upper_charts(F, errors):
    out = {}
    (a35, t35), (a78, t78), (f854, t854) = F.many(lambda a: nkishou(F, *a),
                                                 [("aupq35", "e1", "aupq35"), ("aupq78", "e1", "aupq78"), ("fxjp854", "e2", "fxjp854")])
    if a35 or a78:
        out["aupq"] = [frame(f"AUPQ35 / AUPQ78（掲載 {t35 or t78}）", [a35, a78], layout="row")]
    else:
        errors.append("AUPQ: 取得できず（n-kishou.com）")
    if f854:
        out["fxjp854"] = [frame(f"FXJP854（掲載 {t854}）", [f854])]
    else:
        errors.append("FXJP854: 取得できず（n-kishou.com）")
    f = F.image(f"{JMA_AIR}/pict/fbjp/fbjp.png")
    out["fbjp"] = [frame("FBJP 国内悪天予想図（最新）", [f])] if f else []
    if not f:
        errors.append("FBJP: 取得できず")
    for key, name in (("fxjp106", "FXJP106"),):
        got = None
        for hh in ("12", "00"):
            got = F.image(f"{JMA_AIR}/pict/nwp/fxjp106_{hh}.png")
            if got:
                out[key] = [frame(f"{name} {hh}UTC 初期", [got])]
                break
        if not got:
            errors.append(f"{name}: 取得できず")
    for key, name in (("fxfe502", "FXFE502"), ("fxfe5782", "FXFE5782")):
        got = None
        for hh in ("12", "00"):
            try:
                got = F.pdf_page1_png(f"https://www.jma.go.jp/bosai/numericmap/data/nwpmap/{key}_{hh}.pdf")
            except Exception as e:  # noqa: BLE001
                errors.append(f"{name}: PDF変換失敗 {e}")
            if got:
                out[key] = [frame(f"{name} {hh}UTC 初期（PDF 1ページ目）", [got])]
                break
        if not got:
            errors.append(f"{name}: 取得できず")
    return out


# =============================================================================== 6. 下層悪天
SIGWX_FT = ["39", "03", "06", "09", "12", "15", "18", "21", "24"]
NARROW_AREAS = [("kanto", "関東", "FBTT"), ("chubu", "中部", "FBGG"), ("kansai", "関西", "FBBB"), ("fukuoka", "福岡", "FBFF")]


def low_level(F, errors):
    res = F.many(lambda ft: (ft, F.image(f"{JMA_AIR}/pict/low-level_sigwx/fbos{ft}.png"),
                             F.image(f"{JMA_AIR}/pict/low-level_sigwx/fbtk{ft}.png")), SIGWX_FT)
    frames = [frame("時系列図（西日本・東日本）" if ft == "39" else f"FT{ft}（西日本・東日本）", [w, e], layout="stack")
              for ft, w, e in res if w or e]
    if not frames:
        errors.append("下層悪天予想図: 取得できず")
    return frames


def narrow(F, errors):
    now = dt.datetime.now(UTC).replace(minute=0, second=0, microsecond=0)
    stamps = [now - dt.timedelta(hours=h) for h in range(72) if (now - dt.timedelta(hours=h)).hour % 3 == 0]
    variants = []
    for aid, name, d in NARROW_AREAS:
        frames = []
        for code in ("39", "03"):
            res = F.many(lambda t: (t, F.image(f"{METAIR}/akuten/{d}/{d}{code}_RJTD_{t:%Y%m%d%H}0000.png", immutable=True)), stamps)
            frames = [frame(f"{t:%d}日{t:%H}:00Z（{t.astimezone(JST):%H:%M} JST）", [f], t) for t, f in sorted(res) if f]
            if frames:
                break
        if frames:
            variants.append(variant(aid, name, frames))
        else:
            errors.append(f"狭域悪天 {name}: 取得できず")
    return variants


# =============================================================================== 8. 飛行場時系列
def airport_series(F, airports, errors):
    def get(icao):
        return icao, F.image(f"{JMA_AIR}/pict/taf/QMCD98_{icao}.png"), F.image(f"{JMA_AIR}/pict/taf/QMCJ98_{icao}.png")
    variants = []
    for icao, d, j in F.many(get, airports):
        if d or j:
            variants.append(variant(icao, icao, [frame(f"{icao} 飛行場時系列予報 Part1 / Part2", [d, j], layout="stack")]))
    if not variants:
        errors.append("飛行場時系列: 取得できず")
    return variants


# =============================================================================== Windy（オンライン専用）
def windy_url(level):
    from urllib.parse import urlencode
    q = urlencode({"type": "map", "location": "coordinates", "metricRain": "default", "metricTemp": "default",
                   "metricWind": "default", "zoom": "4.25", "overlay": "wind", "level": level, "lat": "36.5",
                   "lon": "138.0", "embedMake": "true"})
    return f"https://embed.windy.com/embed.html?{q}"


# =============================================================================== 全体
def build_charts(data_dir, airports, workers=16):
    t0 = time.time()
    F = Fetcher(data_dir, workers)
    errors = []
    parts = {}
    # 大きい塊を並列に（各関数の中も並列）
    jobs = {
        "surface": lambda: surface_charts(F, errors),
        "ir": lambda: himawari(F, "b13", errors), "vis": lambda: himawari(F, "b03", errors), "wv": lambda: himawari(F, "b08", errors),
        "cloudtop": lambda: cloud_top(F, errors),
        "rain": lambda: rain_series(F, errors),
        "a30": lambda: analysis30(F, errors),
        "upper": lambda: upper_charts(F, errors),
        "lowlevel": lambda: low_level(F, errors), "narrow": lambda: narrow(F, errors),
        "apseries": lambda: airport_series(F, airports, errors),
    }
    with ThreadPoolExecutor(max_workers=len(jobs)) as top:
        futs = {k: top.submit(fn) for k, fn in jobs.items()}
        for k, fu in futs.items():
            try:
                parts[k] = fu.result()
            except Exception as e:  # noqa: BLE001
                errors.append(f"{k}: 例外 {type(e).__name__}: {e}")
                parts[k] = None
    F.save()
    s = parts.get("surface") or {}
    up = parts.get("upper") or {}
    rain = parts.get("rain") or {}

    def single(title, source, frames, note=None, default_frame=None):
        return product(title, source, [variant("main", title, frames or [], default_frame)], note=note)

    cats = [
        {"id": "aupqSurface", "label": "地上天気図", "defaultItem": 0, "items": [
            {"id": "asas", "label": "ASAS", "product": single("ASAS 地上天気図（実況）", SRC_JMA, [s["asas"]] if "asas" in s else [])},
            {"id": "fsas", "label": "FSAS", "product": product("FSAS 地上天気図（予想）", SRC_JMA, [
                variant(k, lab, [s[k]]) for k, lab in (("fsas24", "24時間後"), ("fsas48", "48時間後")) if k in s])},
        ]},
        {"id": "satellite", "label": "衛星画像", "defaultItem": 0, "items": [
            {"id": "ir", "label": "赤外", "product": single("ひまわり 赤外（B13）", SRC_JMA, parts.get("ir"))},
            {"id": "vis", "label": "可視", "product": single("ひまわり 可視（B03）", SRC_JMA, parts.get("vis"))},
            {"id": "wv", "label": "水蒸気", "product": single("ひまわり 水蒸気（B08）", SRC_JMA, parts.get("wv"))},
        ]},
        {"id": "radar", "label": "レーダーエコー", "defaultItem": 0, "items": [
            {"id": "nowcast", "label": "ナウキャスト", "product": product("降水ナウキャスト", SRC_JMA, rain.get("nowcast") or [], "a00")},
            {"id": "rainfc", "label": "今後の雨", "product": product("今後の雨（降水短時間予報）", SRC_JMA, rain.get("rainfc") or [], "a00")},
            {"id": "thunder", "label": "雷ナウキャスト", "product": product("雷ナウキャスト", SRC_JMA, rain.get("thunder") or [], "a00")},
            {"id": "cloudtop", "label": "雲頂高度", "product": single("雲頂高度", SRC_METAIR, parts.get("cloudtop"))},
        ]},
        {"id": "fxjp", "label": "三十分大気解析", "defaultItem": 0, "items": [
            {"id": "a30", "label": "三十分大気解析", "product": parts.get("a30") or product("三十分大気解析", SRC_METAIR, [])},
        ]},
        {"id": "fxfe", "label": "高層天気図", "defaultItem": 1, "items": [
            {"id": "aupq", "label": "AUPQ", "product": single("AUPQ35 / AUPQ78", "n-kishou.com（気象庁FAX図）", up.get("aupq"))},
            {"id": "fbjp", "label": "FBJP", "product": single("FBJP 国内悪天予想図", SRC_JMA, up.get("fbjp"))},
            {"id": "fxjp106", "label": "FXJP106", "product": single("FXJP106 国内航空路6・12時間予想断面図", SRC_JMA, up.get("fxjp106"))},
            {"id": "fxfe502", "label": "FXFE502", "product": single("FXFE502", SRC_JMA, up.get("fxfe502"))},
            {"id": "fxfe5782", "label": "FXFE5782", "product": single("FXFE5782", SRC_JMA, up.get("fxfe5782"))},
            {"id": "fxjp854", "label": "FXJP854", "product": single("FXJP854", "n-kishou.com（気象庁FAX図）", up.get("fxjp854"))},
        ]},
        {"id": "lowLevel", "label": "下層悪天", "defaultItem": 0, "items": [
            {"id": "lowsigwx", "label": "下層悪天予想図", "product": single("下層悪天予想図（西日本・東日本）", SRC_JMA, parts.get("lowlevel"), default_frame=0)},
            {"id": "narrow", "label": "狭域悪天予想図", "product": product("狭域悪天予想図", SRC_METAIR, parts.get("narrow") or [], "kanto")},
        ]},
        {"id": "windy", "label": "Windy", "defaultItem": 0, "items": [
            {"id": "windy390", "label": "FL390", "product": {"type": "online", "title": "Windy FL390付近の風（200hPa代用）",
                                                            "source": "Windy.com", "embedUrl": windy_url("200h"),
                                                            "officialUrl": "https://www.windy.com/?wind,200h,36.5,138.0,4.25",
                                                            "note": "FL390の気圧面は無いため200hPaで代用。オンライン専用（端末に保存しません）。"}},
            {"id": "windysfc", "label": "地上", "product": {"type": "online", "title": "Windy 地上風", "source": "Windy.com",
                                                           "embedUrl": windy_url("surface"),
                                                           "officialUrl": "https://www.windy.com/?wind,36.5,138.0,4.25",
                                                           "note": "オンライン専用（端末に保存しません）。"}},
        ]},
        {"id": "airport", "label": "AIRPORT", "defaultItem": 0, "items": [
            {"id": "metartafatis", "label": "METAR TAF ATIS", "product": {"type": "wxtext", "title": "METAR / TAF / ATIS", "source": "aviationweather.gov / SWIM"}},
            {"id": "apseries", "label": "飛行場時系列", "product": product("飛行場時系列予報", SRC_JMA, parts.get("apseries") or [], "RJTT",
                                                                     note="SETTINGS で選んだ空港を表示します。")},
        ]},
    ]
    st = dict(F.stats)
    st["seconds"] = round(time.time() - t0, 1)
    log(f"図の取得完了 {st}")
    F.pool.shutdown(wait=False)
    return {"schema": "flight-buddy-charts/2", "fetchedAt": iso(dt.datetime.now(UTC)), "categories": cats,
            "errors": sorted(errors), "stats": st}


def referenced_blobs(charts):
    out = set()
    for c in charts.get("categories", []):
        for it in c["items"]:
            for v in it["product"].get("variants") or []:
                for fr in v["frames"]:
                    for im in fr["images"]:
                        out.add(im["file"])
    for c in charts.get("extra", []):
        if c.get("file", "").startswith("data/blobs/"):
            out.add(c["file"])
    return out
