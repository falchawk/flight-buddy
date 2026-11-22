#!/usr/bin/env python3
"""空港地上図（OSM）と NOTAM の位置照合。

build_pack から呼ぶ。失敗してもパック全体は止めない。
地図は OpenStreetMap（ODbL）。画面に © OpenStreetMap contributors を出すこと。
広域の海岸線は Natural Earth 10m Japan（パブリックドメイン）。
任意の航空写真背景は地理院タイル（出典：国土地理院）。失敗してもパックは止めない。
"""
from __future__ import annotations

import collections
import datetime as dt
import hashlib
import heapq
import json
import math
import os
import re
import time
import urllib.error
import urllib.parse
import urllib.request

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
DATA = os.path.join(ROOT, "data")
STAGING_CACHE = "/workspace/fb-staging/osm-cache"
GSI_CACHE = "/workspace/fb-staging/gsi-cache"
COAST_PATH = os.path.join(os.path.dirname(os.path.abspath(__file__)), "aupq_japan_coast.json")
CACHE_TTL_S = 7 * 24 * 3600
UA = "FlightBuddyPackBuilder/1.0 (personal briefing tool)"
OVERPASS = [
    "https://overpass.openstreetmap.fr/api/interpreter",
    "https://overpass.osm.ch/api/interpreter",
    "https://overpass-api.de/api/interpreter",
]
SCALE = 100000  # ~1.1 m / unit
SNAP_M = 250
MIN_NAMED_REFS = 8
SCHEMA = "flight-buddy-ground/1"

# SFJ 就航地＋主要国内（大阪伊丹・新千歳・那覇）
AIRPORTS = {
    "RJTT": (35.5496, 139.786, 9000),
    "RJFF": (33.5857, 130.4507, 5000),
    "RJFR": (33.846, 131.035, 5000),
    "RJBB": (34.4393, 135.2373, 9000),
    "RJOO": (34.784, 135.4398, 6000),
    "RJGG": (34.8566, 136.8057, 6000),
    "RJCC": (42.7759, 141.6917, 8000),
    "ROAH": (26.1932, 127.6458, 6000),
    "RJDC": (33.9301, 131.2782, 4000),
    "RJSS": (38.1398, 140.9186, 5000),
}

JST = dt.timezone(dt.timedelta(hours=9))


def log(*a):
    print("[ground_chart]", *a, file=os.sys.stderr if False else __import__("sys").stderr, flush=True)


# --------------------------------------------------------------------------- geometry helpers
def dist_m(a, b, lat0=None):
    lat = lat0 if lat0 is not None else (a[0] + b[0]) / 2
    return math.hypot((a[0] - b[0]) * 110950, (a[1] - b[1]) * 111320 * math.cos(math.radians(lat)))


def pts_of(e):
    if e.get("type") == "way":
        return [(p["lat"], p["lon"]) for p in e.get("geometry") or []]
    if "lat" in e:
        return [(e["lat"], e["lon"])]
    return []


def centroid(e):
    p = pts_of(e)
    if not p:
        return None
    return (sum(x[0] for x in p) / len(p), sum(x[1] for x in p) / len(p))


def centroid_pts(p):
    if not p:
        return None
    return (sum(x[0] for x in p) / len(p), sum(x[1] for x in p) / len(p))


def length_m(p):
    return sum(dist_m(p[i], p[i + 1]) for i in range(len(p) - 1)) if len(p) > 1 else 0


def _perp(p, a, b):
    if a == b:
        return dist_m(p, a)
    # project in meters
    lat = (a[0] + b[0]) / 2
    kx, ky = 111320 * math.cos(math.radians(lat)), 110950
    ax, ay = a[1] * kx, a[0] * ky
    bx, by = b[1] * kx, b[0] * ky
    px, py = p[1] * kx, p[0] * ky
    dx, dy = bx - ax, by - ay
    l2 = dx * dx + dy * dy
    t = 0 if l2 == 0 else max(0, min(1, ((px - ax) * dx + (py - ay) * dy) / l2))
    return math.hypot(px - (ax + t * dx), py - (ay + t * dy))


def simplify(p, tol_m):
    if len(p) <= 2:
        return p
    stack = [(0, len(p) - 1)]
    keep = {0, len(p) - 1}
    while stack:
        i, j = stack.pop()
        mx, mid = -1, None
        a, b = p[i], p[j]
        for k in range(i + 1, j):
            d = _perp(p[k], a, b)
            if d > mx:
                mx, mid = d, k
        if mx > tol_m and mid is not None:
            keep.add(mid)
            stack.append((i, mid))
            stack.append((mid, j))
    return [p[i] for i in range(len(p)) if i in keep]


def chain_ways(ways):
    segs = [pts_of(w) for w in ways if pts_of(w)]
    if not segs:
        return []
    chain = segs.pop(0)
    while segs:
        for i, sg in enumerate(segs):
            if not sg:
                segs.pop(i)
                break
            if sg[0] == chain[-1]:
                chain += sg[1:]
                segs.pop(i)
                break
            if sg[-1] == chain[-1]:
                chain += sg[-2::-1]
                segs.pop(i)
                break
            if sg[-1] == chain[0]:
                chain = sg[:-1] + chain
                segs.pop(i)
                break
            if sg[0] == chain[0]:
                chain = sg[::-1][:-1] + chain
                segs.pop(i)
                break
        else:
            chain += segs.pop(0)
    return chain


# --------------------------------------------------------------------------- OSM fetch
def cache_dir():
    d = STAGING_CACHE
    os.makedirs(d, exist_ok=True)
    return d


def _fetch_overpass(lat, lon, rad):
    q = (
        f'[out:json][timeout:90];('
        f'way["aeroway"](around:{int(rad)},{lat},{lon});'
        f'node["aeroway"~"^(parking_position|gate)$"](around:{int(rad)},{lat},{lon});'
        f');out geom;'
    )
    data = urllib.parse.urlencode({"data": q}).encode()
    last = None
    for ep in OVERPASS:
        try:
            req = urllib.request.Request(ep, data=data, headers={"User-Agent": UA, "Accept": "application/json"})
            with urllib.request.urlopen(req, timeout=100) as r:
                body = r.read()
            d = json.loads(body)
            if not d.get("elements"):
                last = f"{ep}: empty"
                continue
            return d
        except Exception as e:  # noqa: BLE001
            last = f"{ep}: {type(e).__name__}: {e}"
            time.sleep(0.6)
    raise RuntimeError(last or "Overpass に接続できませんでした")


def load_osm(icao, lat, lon, rad, force=False):
    """週次キャッシュ付きで OSM を返す。(data, meta)"""
    path = os.path.join(cache_dir(), f"{icao}.raw.json")
    meta_path = os.path.join(cache_dir(), f"{icao}.meta.json")
    now = time.time()
    cached = None
    if os.path.isfile(path) and os.path.getsize(path) > 500:
        try:
            cached = json.loads(open(path, encoding="utf-8").read())
        except Exception:  # noqa: BLE001
            cached = None
    meta = {}
    if os.path.isfile(meta_path):
        try:
            meta = json.loads(open(meta_path, encoding="utf-8").read())
        except Exception:  # noqa: BLE001
            meta = {}
    age = now - float(meta.get("fetchedAtUnix") or 0)
    if cached and not force and age < CACHE_TTL_S:
        return cached, dict(meta, stale=False, cacheHit=True)
    try:
        d = _fetch_overpass(lat, lon, rad)
        open(path, "w", encoding="utf-8").write(json.dumps(d, ensure_ascii=False, separators=(",", ":")))
        meta = {
            "icao": icao,
            "fetchedAt": dt.datetime.now(dt.timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"),
            "fetchedAtUnix": now,
            "osmTimestamp": (d.get("osm3s") or {}).get("timestamp_osm_base"),
            "elements": len(d.get("elements") or []),
        }
        open(meta_path, "w", encoding="utf-8").write(json.dumps(meta, ensure_ascii=False))
        return d, dict(meta, stale=False, cacheHit=False)
    except Exception as e:  # noqa: BLE001
        if cached:
            log(f"{icao}: Overpass 失敗、キャッシュを使用:", e)
            return cached, dict(meta, stale=True, cacheHit=True, fetchError=str(e)[:200])
        raise


# --------------------------------------------------------------------------- layout index
class Layout:
    def __init__(self, icao, osm):
        self.icao = icao
        self.osm_ts = (osm.get("osm3s") or {}).get("timestamp_osm_base")
        self.TWY = collections.defaultdict(list)  # ref or None
        self.RWYW = collections.defaultdict(list)
        self.SPOT = collections.defaultdict(list)
        self.APRON = []
        self.TERM = []
        self.STOP = []
        self.PARK = []
        self.unnamed = []
        for e in osm.get("elements") or []:
            t = e.get("tags") or {}
            a = t.get("aeroway")
            if e.get("type") == "way":
                if a in ("taxiway", "taxilane"):
                    ref = t.get("ref")
                    if ref:
                        self.TWY[ref].append(e)
                    else:
                        self.unnamed.append(e)
                elif a == "runway" and t.get("ref"):
                    self.RWYW[t["ref"]].append(e)
                elif a == "parking_position":
                    self.PARK.append(e)
                    if t.get("ref"):
                        self.SPOT[t["ref"]].append(e)
                elif a == "apron":
                    self.APRON.append(e)
                elif a in ("terminal", "hangar"):
                    self.TERM.append(e)
                elif a == "stopway":
                    self.STOP.append(e)
            else:
                if a in ("parking_position", "gate") and t.get("ref"):
                    self.SPOT[t["ref"]].append(e)
        self.RWY = {}
        for k, ws in self.RWYW.items():
            ch = chain_ways(ws)
            if ch:
                self.RWY[k] = ch
        self.GR = {}  # ref -> (adj, xy)
        for ref, ws in self.TWY.items():
            self.GR[ref] = self._graph(ws)
        # quality
        named = set(self.TWY)
        self.named_refs = len(named)
        nlen = sum(length_m(pts_of(w)) for ws in self.TWY.values() for w in ws)
        ulen = sum(length_m(pts_of(w)) for w in self.unnamed)
        self.named_frac = nlen / (nlen + ulen) if (nlen + ulen) else 0
        self.quality = "good" if (self.named_refs >= MIN_NAMED_REFS and self.RWY) else "limited"

    def _graph(self, ws):
        G = collections.defaultdict(list)
        xy = {}
        for w in ws:
            nodes = w.get("nodes") or []
            geom = w.get("geometry") or []
            for i, n in enumerate(nodes):
                if i >= len(geom):
                    break
                xy[n] = (geom[i]["lat"], geom[i]["lon"])
                if i:
                    m = nodes[i - 1]
                    if m not in xy:
                        continue
                    d = dist_m(xy[m], xy[n])
                    G[m].append((n, d))
                    G[n].append((m, d))
        return G, xy

    def junction(self, ref, other):
        if ref not in self.GR:
            return []
        G, xy = self.GR[ref]
        if other in self.GR:
            sh = set(xy) & set(self.GR[other][1])
            if sh:
                return list(sh)
            best = None
            for n, p in xy.items():
                for q in self.GR[other][1].values():
                    d = dist_m(p, q)
                    if best is None or d < best[0]:
                        best = (d, n)
            if best and best[0] < SNAP_M:
                return [best[1]]
            return []
        if other in self.RWY:
            rp = self.RWY[other]
            best = None
            for n, p in xy.items():
                d = min(dist_m(p, q) for q in rp)
                if best is None or d < best[0]:
                    best = (d, n)
            if best and best[0] < SNAP_M:
                return [best[1]]
        return []

    def nearest_node(self, ref, p):
        G, xy = self.GR[ref]
        return min(xy, key=lambda n: dist_m(xy[n], p))

    def near_spot(self, ref, spot):
        if spot not in self.SPOT or ref not in self.GR:
            return None
        c = centroid_pts(pts_of(self.SPOT[spot][0]))
        if not c:
            return None
        n = self.nearest_node(ref, c)
        return n, c

    def path(self, ref, sa, sb):
        G, xy = self.GR[ref]
        best = None
        for a in sa:
            dist_ = {a: 0}
            prev = {}
            h = [(0, a)]
            while h:
                d, u = heapq.heappop(h)
                if d > dist_.get(u, 1e18):
                    continue
                for v, w in G[u]:
                    nd = d + w
                    if nd < dist_.get(v, 1e18):
                        dist_[v] = nd
                        prev[v] = u
                        heapq.heappush(h, (nd, v))
            for b in sb:
                if b in dist_ and (best is None or dist_[b] < best[0]):
                    p = [b]
                    while p[-1] != a:
                        p.append(prev[p[-1]])
                    best = (dist_[b], p[::-1])
        return [xy[n] for n in best[1]] if best else None

    def runway_ref(self, txt):
        txt = (txt or "").strip()
        if txt in self.RWY:
            return txt
        for k in self.RWY:
            parts = k.split("/")
            if txt in parts:
                return k
            # 16R/16L style (both same direction)
            if "/" in txt and set(txt.split("/")) <= set(parts):
                return k
        return None

    def all_ways(self, ref):
        return [("line", pts_of(w)) for w in self.TWY.get(ref, []) if pts_of(w)]

    def seg_geom(self, ref, qual):
        """(geoms, exact). exact=False のときは誘導路全体へのフォールバック。"""
        if ref not in self.GR:
            return [], False, "missing"
        if not qual:
            return self.all_ways(ref), True, "full"
        qual = qual.replace("_", " ").strip()
        G, xy = self.GR[ref]
        m = re.match(r"(?:BTN|FM)\s+(.+?)\s+(?:AND|TO)\s+(.+)$", qual)
        if m:
            ends = [self._end_nodes(ref, x.strip()) for x in (m.group(1), m.group(2))]
            if ends[0] and ends[1]:
                p = self.path(ref, ends[0], ends[1])
                if p and len(p) > 1:
                    return [("line", p)], True, "seg"
            return self.all_ways(ref), False, "fallback"
        m = re.match(r"INT OF\s+(.+)$", qual)
        if m:
            j = self._end_nodes(ref, m.group(1).strip())
            if j:
                return [("pt", xy[j[0]])], True, "int"
            return self.all_ways(ref), False, "fallback"
        m = re.match(r"BEHIND SPOT\s+(\S+)", qual)
        if m:
            r = self.near_spot(ref, m.group(1))
            if r:
                return [("pt", xy[r[0]])], True, "behind"
            return self.all_ways(ref), False, "fallback"
        return self.all_ways(ref), False, "unknown-qual"

    def _end_nodes(self, ref, x):
        G, xy = self.GR[ref]
        if x.startswith("SPOT"):
            sp = x.split()[-1]
            r = self.near_spot(ref, sp)
            return [r[0]] if r else []
        if x.startswith("RWY"):
            rw = self.runway_ref(x[3:].strip())
            if rw:
                return self.junction(ref, rw)
            return []
        if x in self.GR or x in self.RWY:
            return self.junction(ref, x)
        return []


# --------------------------------------------------------------------------- NOTAM text
COORD_RE = re.compile(
    r"(\d{2})(\d{2})(\d{2}(?:\.\d+)?)([NS])(\d{3})(\d{2})(\d{2}(?:\.\d+)?)([EW])"
)
TOKEN_RE = re.compile(
    r"(?<![A-Z0-9/.-])([A-Z]\d{0,2}[A-Z]?)(?:\(((?:BTN|INT OF|FM|BEHIND)[^()]*)\))?(?![A-Za-z0-9/-])"
)


def get_E(text):
    m = re.search(r"\nE\)(.*?)(?=\n[FG]\)|\)\s*$)", text or "", re.S)
    return re.sub(r"\s+", " ", m.group(1)).strip() if m else ""


def get_Q(text):
    m = re.search(r"Q\)([^\n]*)", text or "")
    return (m.group(1).split("/") if m else [""] * 8)


def get_D(text):
    m = re.search(r"\nD\)(.*?)(?=\nE\))", text or "", re.S)
    return re.sub(r"\s+", " ", m.group(1)).strip() if m else None


def thru_expand(s):
    def letters(m):
        a, b = m.group(1), m.group(2)
        ma = re.match(r"([A-Z]*)(\d+)([A-Z]?)$", a)
        mb = re.match(r"([A-Z]*)(\d+)([A-Z]?)$", b)
        if ma and mb and ma.group(1) == mb.group(1) and ma.group(3) == mb.group(3):
            lo, hi = int(ma.group(2)), int(mb.group(2))
            if 0 <= hi - lo <= 40:
                return ",".join(f"{ma.group(1)}{i}{ma.group(3)}" for i in range(lo, hi + 1))
        return a + "," + b

    def nums(m):
        lo, hi = int(m.group(1)), int(m.group(2))
        if 0 <= hi - lo <= 80:
            return ",".join(str(i) for i in range(lo, hi + 1))
        return m.group(0)

    s = re.sub(r"\b([A-Z]*\d+[A-Z]?) THRU ([A-Z]*\d+[A-Z]?)\b", letters, s)
    s = re.sub(r"\b(\d+) THRU (\d+)\b", nums, s)
    return s


def parse_coords(s):
    out = []
    for m in COORD_RE.finditer(s or ""):
        la = int(m[1]) + int(m[2]) / 60 + float(m[3]) / 3600
        lo = int(m[5]) + int(m[6]) / 60 + float(m[7]) / 3600
        if m[4] == "S":
            la = -la
        if m[8] == "W":
            lo = -lo
        out.append((la, lo))
    return out


RADIUS_RE = re.compile(r"RADIUS\s+(\d+(?:\.\d+)?)\s*(KM|NM|M)?", re.I)
PLACE_RE = re.compile(
    r"\(([A-Z][A-Z0-9.'-]*(?:-KU|-SHI|-GUN|-CHO|-MACHI|-MURA|-TOWN)?)(?: IN ([A-Z][A-Z-]*))?\)"
)
TYPE_RE = re.compile(
    r"TYPE:\s*([A-Z][A-Z0-9]*(?:[ -][A-Z][A-Z0-9]*)*)(?=\s+(?:PSN|ELEV|PLACE|NUMBER|AREA|CENTER)\b|[\s.]|$)",
    re.I,
)

# よく出る市区町村。無いものはローマ字のまま出す。
_PLACE_JA = {
    "MINATO-KU": "港区", "KOTO-KU": "江東区", "OTA-KU": "大田区", "SHINAGAWA-KU": "品川区",
    "SHINJUKU-KU": "新宿区", "CHIYODA-KU": "千代田区", "TOSHIMA-KU": "豊島区", "SUMIDA-KU": "墨田区",
    "KOTO": "江東区", "MEGURO-KU": "目黒区", "SETAGAYA-KU": "世田谷区", "SHIBUYA-KU": "渋谷区",
    "BUNKYO-KU": "文京区", "TAITO-KU": "台東区", "NAKANO-KU": "中野区", "SUGINAMI-KU": "杉並区",
    "KITA-KU": "北区", "ARKAWA-KU": "荒川区", "ARAKAWA-KU": "荒川区", "ITABASHI-KU": "板橋区",
    "NERIMA-KU": "練馬区", "ADACHI-KU": "足立区", "KATSUSHIKA-KU": "葛飾区", "EDOGAWA-KU": "江戸川区",
    "CHUO-KU": "中央区", "KAWASAKI-SHI": "川崎市", "YOKOHAMA-SHI": "横浜市", "YOKOHAMA": "横浜市",
    "FUKUOKA-SHI": "福岡市", "CHIKUSHINO-SHI": "筑紫野市", "ONOJO-SHI": "大野城市",
    "ASAKURA-GUN": "朝倉郡", "KITAKYUSHU-SHI": "北九州市", "OSAKA-SHI": "大阪市",
    "SENNAN-GUN": "泉南郡", "IZUMISANO-SHI": "泉佐野市", "TAJIRI-CHO": "田尻町",
    "NAGOYA-SHI": "名古屋市", "TOKONAME-SHI": "常滑市", "YATOMI-SHI": "弥富市",
    "SAPPORO-SHI": "札幌市", "CHITOSE-SHI": "千歳市", "TOMAKOMAI-SHI": "苫小牧市",
    "NAHA-SHI": "那覇市", "SENDAI-SHI": "仙台市", "YAMAGUCHI-SHI": "山口市",
    "UBE-SHI": "宇部市", "NISHINOMIYA-SHI": "西宮市", "ITAMI-SHI": "伊丹市",
    "TOYONAKA-SHI": "豊中市",
}
_TYPE_JA = {
    "BLDG": "建物", "BUILDING": "建物", "CHIMNEY": "煙突", "TOWER": "塔", "POLE": "ポール",
    "CRANE": "クレーン", "POWER LINE TOWER": "送電鉄塔", "SCAFFOLD": "足場", "SHIP": "船舶",
    "WIND TURBINE": "風車", "ANTENNA": "アンテナ", "TANK": "タンク", "BRIDGE": "橋",
}


def parse_radius_m(s):
    m = RADIUS_RE.search(s or "")
    if not m:
        return None
    v = float(m.group(1))
    u = (m.group(2) or "M").upper()
    if u == "KM":
        return v * 1000.0
    if u == "NM":
        return v * 1852.0
    return v


def _place_of(e):
    ms = list(PLACE_RE.finditer(e or ""))
    if not ms:
        return None
    # 末尾の（…-KU IN TOKYO）を優先
    m = ms[-1]
    key = m.group(1).upper()
    return _PLACE_JA.get(key, m.group(1))


def parse_coord_geoms(e):
    """E) から点・円・多角形・線を取る。無ければ空。"""
    e = e or ""
    out = []
    # 円（RADIUS … CENTER coord）
    for m in re.finditer(r"RADIUS\s+(\d+(?:\.\d+)?)\s*(KM|NM|M)?[^\n.]{0,40}?CENTER\s*" + COORD_RE.pattern, e, re.I):
        v = float(m.group(1))
        u = (m.group(2) or "M").upper()
        r = v * 1000.0 if u == "KM" else (v * 1852.0 if u == "NM" else v)
        pts = parse_coords(m.group(0))
        if pts:
            out.append({"t": "circle", "p": pts[0], "r": r})
    if out:
        return out
    # 多角形
    bm = re.search(r"BOUNDED BY(?: FLW POINTS?)?[^\n]*", e, re.I)
    if bm:
        # その句から次のセクション（数字. or RMK or WT:）まで
        start = bm.start()
        rest = re.split(r"\s(?:WT:|NUMBER:|ELEV:|RMK:|\d+\.(?![\d]))", e[start:], maxsplit=1)[0]
        pts = parse_coords(rest)
        if len(pts) >= 3:
            if pts[0] != pts[-1]:
                pts = pts + [pts[0]]
            out.append({"t": "poly", "pts": pts})
            return out
    # 線（船舶など）
    lm = re.search(r"A LINE CONNECTING[^\n]*", e, re.I)
    if lm:
        pts = parse_coords(e[lm.start():lm.start() + 400])
        if len(pts) >= 2:
            out.append({"t": "line", "pts": pts})
            return out
    pts = parse_coords(e)
    # 重複を間引き
    seen, uniq = set(), []
    for p in pts:
        k = (round(p[0], 5), round(p[1], 5))
        if k not in seen:
            seen.add(k)
            uniq.append(p)
    for p in uniq:
        out.append({"t": "pt", "p": p})
    return out


COORD_SUB = {
    "OL": "obst_lgt",
    "OB": "obst",
    "WU": "uas",
    "WL": "balloon",
    "WH": "fireworks",
    "WP": "pg",
    "WB": "acro",
}


def cat_of_coord(q, e):
    q = q or ""
    sub = q[1:3] if len(q) >= 3 else ""
    if sub in COORD_SUB:
        return COORD_SUB[sub]
    if re.search(r"\bFOUNTAIN\b", e or ""):
        return "coord"
    if parse_coords(e or ""):
        return "coord"
    return None


def is_coordish(q, e=""):
    if cat_of_coord(q, e):
        return True
    return bool(parse_coords(e or ""))


def summarize_coord(e, q=""):
    raw = (e or "").strip()
    body = raw.split(" RMK")[0].strip()
    if not body:
        return raw, False
    place = _place_of(body)
    rad = parse_radius_m(body)
    typ_m = TYPE_RE.search(body)
    typ = None
    if typ_m:
        typ = _TYPE_JA.get(typ_m.group(1).strip().upper(), None)
    sub = (q or "")[1:3] if q else ""
    loc = "・".join(x for x in (typ, place) if x)
    rad_s = None
    if rad is not None:
        rad_s = f"半径{int(rad) if rad >= 10 and abs(rad - int(rad)) < 0.05 else rad:g}m"

    def fin(head, extras=None):
        bits = []
        for x in (typ, place, *(extras or ())):
            if x and x not in bits:
                bits.append(x)
        if extras is None and rad_s and (sub in ("WU", "WH", "WL", "WP", "WB") or "RADIUS" in body):
            if rad_s not in bits:
                bits.append(rad_s)
        tail = f"（{'・'.join(bits)}）" if bits else ""
        return head + tail, True

    if sub == "OL" or re.search(r"\bOBST LGT\b", body):
        return fin("障害物灯使用不能")
    if re.search(r"\bCRANE\b", body):
        return fin("クレーン")
    if re.search(r"\bSCAFFOLD\b", body):
        return fin("足場")
    if re.search(r"\bSHIP\b", body):
        return fin("船舶")
    if sub == "OB" or re.search(r"\bOBST\b", body):
        if re.search(r"DAY MARKING ERASED", body):
            return fin("障害物の昼間標示消去")
        return fin("障害物")
    if sub == "WU" or re.search(r"UNMANNED ACFT", body):
        extra = ["区域"] if re.search(r"BOUNDED BY", body) else []
        if rad_s:
            extra.append(rad_s)
        return fin("無人機", extra)
    if sub == "WL" or re.search(r"FREE BALLOON|ASCENT OF", body):
        return fin("気球放球")
    if sub == "WH" or re.search(r"\bFIREWORKS\b", body):
        return fin("花火")
    if sub == "WP" or re.search(r"PARA-GLD|HANG-GLD|PARAGLID", body):
        return fin("パラグライダー等")
    if sub == "WB" or re.search(r"AEROBAT", body):
        return fin("曲技飛行")
    if re.search(r"\bFOUNTAIN\b", body):
        return fin("噴水")
    if place or parse_coords(body):
        # 位置はあるが種別が不明なら原文
        return raw, False
    return raw, False


def parse_schedule(d_text):
    """D) 行 → {days: set[int]|None, start: int|None, end: int|None}（時刻は UTC の HHMM）。"""
    if not d_text:
        return None
    tm = re.search(r"(\d{4})/(\d{4})\s*$", d_text)
    days_src = d_text[: tm.start()] if tm else d_text
    days = set()
    for tok in re.findall(r"\d{1,2}(?:-\d{1,2})?", re.sub(r"\d{4}/\d{4}", "", days_src)):
        if "-" in tok:
            a, b = map(int, tok.split("-"))
            if 1 <= a <= 31 and 1 <= b <= 31:
                if a <= b:
                    days.update(range(a, b + 1))
                else:
                    days.update(range(a, 32))
                    days.update(range(1, b + 1))
        else:
            n = int(tok)
            if 1 <= n <= 31:
                days.add(n)
    if not days and not tm:
        return None
    return {
        "days": sorted(days) if days else None,
        "start": int(tm.group(1)) if tm else None,
        "end": int(tm.group(2)) if tm else None,
        "raw": d_text,
    }


def schedule_active(sched, t_utc, effective_from, effective_to):
    """t_utc: datetime aware. effective_* ISO strings."""
    if effective_from and t_utc < _parse_iso(effective_from):
        return False
    if effective_to:
        et = _parse_iso(effective_to)
        if et and t_utc > et:
            return False
    if not sched:
        return True
    if sched.get("days") and t_utc.day not in sched["days"]:
        return False
    if sched.get("start") is not None and sched.get("end") is not None:
        hm = t_utc.hour * 100 + t_utc.minute
        a, b = sched["start"], sched["end"]
        if a <= b:
            return a <= hm <= b
        return hm >= a or hm <= b
    return True


def _parse_iso(s):
    if not s:
        return None
    s = s.strip()
    if s.endswith("Z"):
        s = s[:-1] + "+00:00"
    try:
        t = dt.datetime.fromisoformat(s)
    except ValueError:
        try:
            t = dt.datetime.strptime(s[:19], "%Y-%m-%dT%H:%M:%S").replace(tzinfo=dt.timezone.utc)
        except ValueError:
            return None
    if t.tzinfo is None:
        t = t.replace(tzinfo=dt.timezone.utc)
    return t


# --------------------------------------------------------------------------- category + summary
def cat_of(q, e):
    q = q or ""
    if q.startswith("QMR") and q.endswith("LC"):
        return "rwy_closed"
    if q.startswith("QMX") and q.endswith("LC"):
        return "twy_closed"
    if q.startswith("QMX") and q.endswith("LT"):
        return "twy_restr"
    if q.startswith("QMP") and q.endswith("LC"):
        return "spot_closed"
    if q.startswith("QMP"):
        return "spot_reloc"
    if q.startswith("QIC") or q.startswith("QGA"):
        return "ils"
    if q.startswith("QL") or q.startswith("QFD"):
        return "light"
    if q.startswith("QMM") or q.startswith("QMR") and q.endswith("AW"):
        return "marking"
    if q.startswith("QMN") and "CLSD" in (e or ""):
        return "other"
    if "CLSD" in (e or ""):
        if e.startswith("RWY") or " RWY " in e:
            return "rwy_closed"
        if e.startswith("TWY") or " TWY " in e:
            return "twy_closed"
        if "SPOT" in e:
            return "spot_closed"
    if "RESTRICTED" in (e or "") or "NOT AVBL" in (e or ""):
        return "twy_restr"
    if "U/S" in (e or ""):
        return "light" if "ILS" not in (e or "") else "ils"
    return "other"


def _ja_qual(q):
    if not q:
        return ""
    q = q.replace("_", " ")
    m = re.match(r"(?:BTN|FM)\s+(.+?)\s+(?:AND|TO)\s+(.+)$", q)
    if m:
        return f"（{_ja_end(m.group(1))}〜{_ja_end(m.group(2))}間）"
    m = re.match(r"INT OF\s+(.+)$", q)
    if m:
        return f"（{_ja_end(m.group(1))}交差）"
    m = re.match(r"BEHIND SPOT\s+(\S+)", q)
    if m:
        return f"（SPOT {m.group(1)}後方）"
    return f"（{q}）"


def _ja_end(x):
    x = x.strip()
    if x.startswith("SPOT"):
        return "SPOT " + x.split()[-1]
    if x.startswith("RWY"):
        return "RWY " + x[3:].strip()
    return x


def _reason(e):
    if re.search(r"DUE TO CONST", e):
        return "工事"
    if re.search(r"DUE TO MAINT", e):
        return "保守"
    if re.search(r"DUE TO TROUBLE", e):
        return "故障"
    return None


def _wingspan(e):
    m = re.search(r"WINGSPAN MORE THAN\s+([0-9.]+)\s*M", e)
    return m.group(1) if m else None


_LIGHT = [
    (r"VISUAL-DOCKING-GUIDANCE-SYSTEM FOR SPOT ([0-9,]+)", "ドック誘導装置", "SPOT"),
    (r"ACFT-STAND-ID-SIGN FOR SPOT ([0-9,]+)", "駐機位置標識", "SPOT"),
    (r"APN-FLOOD-LGT FOR SPOT ([0-9,]+)", "エプロン投光照明", "SPOT"),
    (r"RCLL FOR RWY ([0-9LRC/]+)", "滑走路中心線灯", "RWY"),
    (r"REDL FOR RWY ([0-9LRC/]+)", "滑走路縁灯", "RWY"),
    (r"SEQUENCED-FLG-LGT FOR RWY ([0-9LRC/]+)", "進入灯（シーケンシャル）", "RWY"),
    (r"RWY-THR-ID-LGT FOR RWY ([0-9LRC/]+)", "滑走路末端識別灯", "RWY"),
    (r"LIGHTING SYSTEM CAT-?[123](?:,[123])* FOR RWY ([0-9LRC/]+)", "CAT照明", "RWY"),
    (r"APCH-GUIDANCE-LGT FOR RWY ([0-9LRC/]+)", "進入誘導灯", "RWY"),
    (r"TAXIING-GUIDANCE-SIGN FOR ([A-Z0-9,]+)", "誘導案内標識", "TWY"),
    (r"RAPID-EXIT-TWY-INDICATOR-LGT FOR ([A-Z0-9,]+)", "高速脱出誘導路指示灯", "TWY"),
    (r"TWY-CL-LGT FOR(?: TWY)? ([A-Z0-9,() ]+?) U/S", "誘導路中心線灯", "TWY"),
    (r"TWY-EDGE-LGT FOR(?: TWY)? ([A-Z0-9,() ]+?)(?: PARTLY)?", "誘導路縁灯", "TWY"),
    (r"ILS-LOC,GP,DME(?:,IM)? FOR RWY ([0-9LRC/]+)", "ILS（LOC/GP/DME）", "RWY"),
    (r"GBAS NOT AVBL", "GBAS", None),
]


def summarize(e, q_code=""):
    """確かなときだけ日本語。自信がなければ原文 E) を返す。"""
    raw = (e or "").strip()
    body = raw.split(" RMK")[0].strip()
    if not body:
        return raw, False
    reason = _reason(body)
    ws = _wingspan(body)

    def tail(base):
        bits = [reason] if reason else []
        return base + ((" ／ " + "・".join(bits)) if bits else "")

    # ILS / lighting phrases (may be combined)
    lights = []
    for pat, name, kind in _LIGHT:
        for m in re.finditer(pat, body):
            if kind is None:
                lights.append(name)
            else:
                tgt = m.group(1).strip().rstrip(",")
                tgt = re.sub(r"\s+", "", tgt)
                prefix = "RWY " if kind == "RWY" else ("SPOT " if kind == "SPOT" else "TWY ")
                if kind == "TWY" and tgt.startswith("TWY"):
                    prefix = ""
                lights.append(f"{prefix}{tgt} {name}".strip())
    if "U/S" in body or "NOT AVBL" in body:
        if re.search(r"\bILS", body) and not lights:
            rw = re.search(r"RWY ([0-9LRC/]+)", body)
            lights.append(f"RWY {rw.group(1)} ILS" if rw else "ILS")
        if lights:
            # unique preserve order
            seen, uniq = set(), []
            for x in lights:
                if x not in seen:
                    seen.add(x)
                    uniq.append(x)
            head = uniq[0] + (" ほか" if len(uniq) > 1 else "")
            verb = "使用不能"
            if "PARTLY" in body:
                verb = "一部使用不能"
            if "TEMPO INSTALLED" in body:
                verb = "一時設置"
            return tail(f"{head} {verb}"), True

    if re.search(r"\bRELOCATED\b", body):
        spots = re.findall(r"SPOT ([0-9,]+)", body)
        ids = []
        for s in spots:
            ids += s.split(",")
        if ids:
            return tail("SPOT " + ",".join(ids) + " 移設"), True

    if re.search(r"\b(ERASED|INSTALLED)\b", body) and re.search(r"\b(MARKING|GROOVING|SIGN|STRIPE)\b", body):
        rw = re.search(r"RWY ([0-9LRC/]+)", body)
        tw = re.search(r"\bTWY ([A-Z0-9(), ]+?)(?:\s+(?:PARTLY|ERASED|CL |SIDE))?", body)
        if "GROOVING" in body and rw:
            return tail(f"RWY {rw.group(1)} グルービング 一部消去等"), True
        if "OVERRUN" in body and rw:
            return tail(f"RWY {rw.group(1)} オーバーラン標示 一部消去"), True
        if tw:
            return tail(f"TWY {tw.group(1).split(' FOR')[-1].strip()[:24]} 標示消去等"), True
        if rw:
            return tail(f"RWY {rw.group(1)} 標示消去等"), True
        return tail("標示消去等"), True

    # closures / restrictions on TWY / RWY / SPOT
    closed = bool(re.search(r"\bCLSD\b", body))
    restr = bool(re.search(r"\bRESTRICTED\b|\bNOT AVBL\b", body))
    if closed or restr:
        verb = "閉鎖" if closed else "制限"
        if ws and not closed:
            verb = f"制限（翼幅{ws}m超は使用不可）"
        # TWY list
        if re.search(r"\bALL TWY\b", body):
            extra = "（事前許可機を除く）" if re.search(r"EXC ACFT WITH PRIOR PERMISSION", body) else ""
            return tail(f"全誘導路 {verb}{extra}"), True
        if re.search(r"\bTWY\b", body):
            segs = _twy_phrases(body)
            if segs:
                head = segs[0] + (" ほか" if len(segs) > 1 else "")
                return tail(f"{head} {verb}"), True
        rwys = re.findall(r"RWY\s+([0-9]{2}[LRC]?(?:/[0-9]{2}[LRC]?)?)", body)
        if rwys:
            return tail("RWY " + "・".join(rwys) + f" {verb}"), True
        spots = []
        for s in re.findall(r"SPOT ([0-9,]+)", body):
            spots += s.split(",")
        if spots and not re.search(r"\bTWY\b", body):
            return tail("SPOT " + ",".join(spots) + f" {verb}"), True
        if "COMPASS AREA" in body:
            return tail(f"コンパスエリア {verb}"), True

    # unrecognized
    return raw, False


def _twy_phrases(body):
    body2 = thru_expand(body.split(" RMK")[0])
    body2 = re.sub(r"SPOT (\d+)", r"SPOT_\1", body2)
    body2 = re.sub(r"RWY ?(\d{2}[LRC]?(?:/\d{2}[LRC]?)?)", r"RWY_\1", body2)
    # cut leading TWY
    m = re.search(r"\bTWY\b", body2)
    if not m:
        return []
    chunk = body2[m.end():]
    chunk = re.split(r"\b(?:CLSD|RESTRICTED|NOT AVBL|U/S|DUE TO|RMK)\b", chunk)[0]
    out = []
    for tok in TOKEN_RE.finditer(chunk):
        ref, q = tok.group(1), tok.group(2)
        if ref in ("FM", "TO", "AND", "BTN", "INT", "OF", "DUE", "THE", "FOR", "CAT"):
            continue
        out.append("TWY " + ref + _ja_qual(q or ""))
    return out


# --------------------------------------------------------------------------- matching
def resolve(layout: Layout, item):
    text = item.get("text") or ""
    E = thru_expand(get_E(text))
    Qs = get_Q(text)
    q = Qs[1] if len(Qs) > 1 else ""
    cat = cat_of(q, E)
    summary, ja_ok = summarize(E, q)
    sched = parse_schedule(get_D(text))
    geoms, names, unres, approx = [], [], [], False
    # runways
    for m in re.finditer(r"RWY\s+(\d{2}[LRC]?(?:/\d{2}[LRC]?)?)", E):
        rw = layout.runway_ref(m.group(1))
        if rw:
            geoms.append({"t": "rwy", "id": rw, "label": m.group(1)})
            names.append("RWY " + m.group(1))
        else:
            unres.append("RWY " + m.group(1))
    # spots
    for m in re.finditer(r"SPOT ([0-9,]+)", E.split(" RMK")[0] if "SPOT" in E else E):
        for s in m.group(1).split(","):
            if s in layout.SPOT:
                c = centroid_pts(pts_of(layout.SPOT[s][0]))
                if c:
                    geoms.append({"t": "pt", "p": c})
                    names.append("SPOT " + s)
            else:
                unres.append("SPOT " + s)
    body = E.split(" RMK")[0]
    body2 = re.sub(r"SPOT (\d+)", r"SPOT_\1", body)
    body2 = re.sub(r"RWY ?(\d{2}[LRC]?(?:/\d{2}[LRC]?)?)", r"RWY_\1", body2)
    twyctx = bool(re.search(r"\b(?:TWY|TXL|TAXILANE)\b", body2)) or (q[:3] in ("QMX", "QLX", "QLY", "QLR", "QMM") if q else False)
    if re.search(r"\bALL TWY\b", body):
        for ref in layout.TWY:
            for kind, val in layout.all_ways(ref):
                geoms.append({"t": kind, "pts" if kind == "line" else "p": val})
            names.append("TWY " + ref)
        twyctx = False  # already added all
    if twyctx:
        for m in TOKEN_RE.finditer(body2):
            ref, qual = m.group(1), m.group(2)
            if ref in ("FM", "TO", "AND", "BTN", "INT", "OF", "DUE", "THE", "FOR", "CAT", "NR"):
                continue
            if ref in layout.GR:
                g, ok, how = layout.seg_geom(ref, qual)
                for kind, val in g:
                    geoms.append({"t": kind, "pts" if kind == "line" else "p": val})
                names.append("TWY " + ref + (f"({qual})" if qual else ""))
                if not ok:
                    approx = True
            elif re.match(r"^[A-Z]\d{1,2}[A-Z]?$", ref) and ref not in ("FM",):
                # likely a taxiway name missing from OSM
                if twyctx:
                    unres.append("TWY " + ref)
    # off-airport coords are not used on the ground chart
    return {
        "id": item.get("id"),
        "q": q,
        "cat": cat,
        "e": E,
        "summary": summary,
        "ja": ja_ok,
        "from": item.get("effectiveFrom"),
        "to": item.get("effectiveTo"),
        "sched": sched,
        "approx": approx,
        "unres": unres,
        "names": names,
        "geoms": geoms,
        "issued": item.get("issued"),
    }


def is_groundish(q):
    q = q or ""
    return bool(re.match(r"Q(MX|MR|MP|MN|MM|LR|LX|LY|LC|LF|LL|LE|LA|LB|LT|LV|IC|FD|GA)", q)) or q.startswith("QXX")


# --------------------------------------------------------------------------- pack encoding
def enc_pt(p, origin):
    return [int(round((p[0] - origin[0]) * SCALE)), int(round((p[1] - origin[1]) * SCALE))]


def enc_line(pts, origin, tol=2.5):
    pts = simplify(pts, tol)
    out = []
    for p in pts:
        out.extend(enc_pt(p, origin))
    return out


def bounds_of(layout: Layout):
    lats, lons = [], []
    for ch in layout.RWY.values():
        for p in ch:
            lats.append(p[0]); lons.append(p[1])
    for ws in layout.TWY.values():
        for w in ws:
            for p in pts_of(w):
                lats.append(p[0]); lons.append(p[1])
    if not lats:
        for w in layout.unnamed + layout.APRON:
            for p in pts_of(w):
                lats.append(p[0]); lons.append(p[1])
    if not lats:
        return None
    return min(lats), min(lons), max(lats), max(lons)


def build_layout_json(layout: Layout):
    b = bounds_of(layout)
    if not b:
        return None
    origin = (b[0], b[1])
    rwys = []
    for k, ch in layout.RWY.items():
        rwys.append({"id": k, "pts": enc_line(ch, origin, 1.0)})
    twys = []
    for ref, ws in sorted(layout.TWY.items(), key=lambda x: (len(x[0]), x[0])):
        ways = [enc_line(pts_of(w), origin, 2.5) for w in ws if len(pts_of(w)) >= 2]
        ways = [w for w in ways if len(w) >= 4]
        if ways:
            twys.append({"ref": ref, "ways": ways})
    unnamed = []
    for w in layout.unnamed:
        p = pts_of(w)
        if length_m(p) < 12 or len(p) < 2:
            continue
        unnamed.append(enc_line(p, origin, 3.5))
    aprons, terms = [], []
    for e in layout.APRON:
        p = pts_of(e)
        if len(p) >= 3:
            aprons.append(enc_line(p + ([p[0]] if p[0] != p[-1] else []), origin, 6.0))
    for e in layout.TERM:
        p = pts_of(e)
        if len(p) >= 3:
            terms.append(enc_line(p + ([p[0]] if p[0] != p[-1] else []), origin, 4.0))
    spots = {}
    for ref, es in layout.SPOT.items():
        c = centroid_pts(pts_of(es[0]))
        if c:
            spots[ref] = enc_pt(c, origin)
    parking = []
    for e in layout.PARK:
        p = pts_of(e)
        if len(p) >= 2 and length_m(p) >= 8:
            parking.append(enc_line(p, origin, 2.0))
    stopways = []
    for e in layout.STOP:
        p = pts_of(e)
        if len(p) >= 2:
            stopways.append(enc_line(p, origin, 2.0))
    return {
        "schema": SCHEMA,
        "icao": layout.icao,
        "src": "OpenStreetMap",
        "attribution": "© OpenStreetMap contributors",
        "osmAt": layout.osm_ts,
        "origin": [round(origin[0], 7), round(origin[1], 7)],
        "scale": SCALE,
        "bbox": [round(x, 7) for x in b],
        "quality": layout.quality,
        "namedRefs": layout.named_refs,
        "runways": rwys,
        "taxiways": twys,
        "unnamed": unnamed,
        "aprons": aprons,
        "terminals": terms,
        "spots": spots,
        "parking": parking,
        "stopways": stopways,
    }


def encode_geoms(geoms, origin):
    out = []
    for g in geoms:
        if g["t"] == "line":
            out.append({"t": "line", "pts": enc_line(g["pts"], origin, 2.0)})
        elif g["t"] == "pt":
            out.append({"t": "pt", "p": enc_pt(g["p"], origin)})
        elif g["t"] == "rwy":
            out.append({"t": "rwy", "id": g["id"], "label": g.get("label")})
        elif g["t"] == "poly":
            out.append({"t": "poly", "pts": enc_line(g["pts"], origin, 4.0)})
        elif g["t"] == "circle":
            out.append({"t": "circle", "p": enc_pt(g["p"], origin), "r": int(round(g["r"]))})
    return out


def write_blob(obj):
    body = json.dumps(obj, ensure_ascii=False, separators=(",", ":")).encode("utf-8")
    return write_bytes(body, "json")


def write_bytes(body, ext):
    h = hashlib.sha256(body).hexdigest()
    rel = f"data/blobs/{h}.{ext}"
    dst = os.path.join(ROOT, rel)
    os.makedirs(os.path.dirname(dst), exist_ok=True)
    if not os.path.exists(dst):
        with open(dst, "wb") as f:
            f.write(body)
    return rel, len(body), h


_coast_file = None


def write_coast_blob():
    """Natural Earth 10m Japan の海岸線を簡略化して 1 個の共有 blob にする。"""
    global _coast_file
    if _coast_file:
        return _coast_file
    raw = json.loads(open(COAST_PATH, encoding="utf-8").read())
    rings = []
    for ring in raw.get("rings") or []:
        # [lon,lat] → [lat,lon]、広域用に約 400m で簡略
        pts = [(p[1], p[0]) for p in ring if len(p) >= 2]
        pts = simplify(pts, 400)
        if len(pts) >= 4:
            rings.append([[round(a, 4), round(b, 4)] for a, b in pts])
    obj = {
        "src": "Natural Earth 10m Japan",
        "attribution": "Natural Earth (public domain)",
        "rings": rings,
    }
    rel, n, _ = write_blob(obj)
    _coast_file = (rel, n)
    return _coast_file


def _merc_x(lon):
    return (lon + 180.0) / 360.0


def _merc_y(lat):
    lat = max(-85.05112878, min(85.05112878, lat))
    s = math.sin(math.radians(lat))
    return 0.5 - math.log((1 + s) / (1 - s)) / (4 * math.pi)


def _gsi_cache_dir():
    os.makedirs(GSI_CACHE, exist_ok=True)
    return GSI_CACHE


def stitch_gsi_photo(icao, bbox, force=False):
    """空港 bbox の地理院シームレス写真を 1 枚の JPEG にまとめる。失敗したら None。"""
    if os.environ.get("GROUND_SKIP_GSI"):
        return None
    try:
        from PIL import Image
    except ImportError:
        log(f"{icao}: Pillow が無いため航空写真を作れません")
        return None
    if not bbox or len(bbox) < 4:
        return None
    s, w, n, e = bbox
    pad_lat = (n - s) * 0.14
    pad_lon = (e - w) * 0.14
    s, w, n, e = s - pad_lat, w - pad_lon, n + pad_lat, e + pad_lon
    # 細長い bbox（滑走路だけ等）は短辺を最低 2.5km まで広げる
    mid0 = (s + n) / 2
    width_m = (e - w) * 111320 * math.cos(math.radians(mid0))
    height_m = (n - s) * 110950
    min_m = 2500.0
    if width_m < min_m:
        dlon = ((min_m - width_m) / 2) / (111320 * math.cos(math.radians(mid0)))
        w -= dlon; e += dlon
    if height_m < min_m:
        dlat = ((min_m - height_m) / 2) / 110950
        s -= dlat; n += dlat
    cache_path = os.path.join(_gsi_cache_dir(), f"{icao}.jpg")
    meta_path = os.path.join(_gsi_cache_dir(), f"{icao}.meta.json")
    now = time.time()
    if os.path.isfile(cache_path) and os.path.getsize(cache_path) > 8000 and not force:
        try:
            meta = json.loads(open(meta_path, encoding="utf-8").read())
        except Exception:
            meta = {}
        if now - float(meta.get("fetchedAtUnix") or 0) < CACHE_TTL_S and meta.get("bbox") == [s, w, n, e]:
            body = open(cache_path, "rb").read()
            rel, nb, _ = write_bytes(body, "jpg")
            return {"file": rel, "bytes": nb, "bbox": meta.get("outBbox") or [s, w, n, e],
                    "width": meta.get("width"), "height": meta.get("height"),
                    "src": "gsi-seamlessphoto", "z": meta.get("z")}
        # bbox が変わっていても画像があれば、再取得前にそれを使うのは危険。下で再取得。

    def tile_px(z):
        ntiles = 2 ** z
        return ntiles * 256

    def choose_z():
        mid = (s + n) / 2
        width_m = (e - w) * 111320 * math.cos(math.radians(mid))
        height_m = (n - s) * 110950
        for z in range(18, 13, -1):
            mpp = 40075016.686 * math.cos(math.radians(mid)) / (2 ** z) / 256
            pw, ph = width_m / mpp, height_m / mpp
            tx = int(pw / 256) + 2
            ty = int(ph / 256) + 2
            if tx * ty <= 80 and max(pw, ph) <= 3200:
                return z
        return 15

    z = choose_z()
    ntiles = 2 ** z
    x0 = int(_merc_x(w) * ntiles)
    x1 = int(_merc_x(e) * ntiles)
    y0 = int(_merc_y(n) * ntiles)
    y1 = int(_merc_y(s) * ntiles)
    x0, x1 = max(0, x0), min(ntiles - 1, x1)
    y0, y1 = max(0, y0), min(ntiles - 1, y1)
    cols, rows = x1 - x0 + 1, y1 - y0 + 1
    if cols * rows > 80:
        log(f"{icao}: GSI タイルが多すぎる ({cols}x{rows})、写真なし")
        return None
    img = Image.new("RGB", (cols * 256, rows * 256), (30, 40, 50))
    ok = 0
    for ty in range(y0, y1 + 1):
        for tx in range(x0, x1 + 1):
            url = f"https://cyberjapandata.gsi.go.jp/xyz/seamlessphoto/{z}/{tx}/{ty}.jpg"
            try:
                req = urllib.request.Request(url, headers={"User-Agent": UA, "Accept": "image/jpeg"})
                with urllib.request.urlopen(req, timeout=25) as r:
                    tile = r.read()
                import io
                tim = Image.open(io.BytesIO(tile)).convert("RGB")
                img.paste(tim, ((tx - x0) * 256, (ty - y0) * 256))
                ok += 1
            except Exception as ex:  # noqa: BLE001
                log(f"{icao}: GSI タイル失敗 {z}/{tx}/{ty}: {type(ex).__name__}")
            time.sleep(0.05)
    if ok < max(1, (cols * rows) // 3):
        log(f"{icao}: GSI 写真の取得が不足 ({ok}/{cols*rows})")
        return None
    # タイル境界を地理座標に戻し、要求 bbox で切り出す
    def lon_of(x):
        return x / ntiles * 360.0 - 180.0

    def lat_of(y):
        # inverse web mercator
        ny = 0.5 - y / ntiles
        return math.degrees(math.atan(math.sinh(2 * math.pi * ny)))

    west_t, north_t = lon_of(x0), lat_of(y0)
    east_t, south_t = lon_of(x1 + 1), lat_of(y1 + 1)
    W, H = img.size
    def px_x(lon):
        return (lon - west_t) / (east_t - west_t) * W
    def px_y(lat):
        # y is mercator, not linear in lat — crop in mercator space
        return (_merc_y(lat) * ntiles - y0) * 256
    l, t = px_x(w), px_y(n)
    rgt, b = px_x(e), px_y(s)
    l, t = max(0, int(math.floor(l))), max(0, int(math.floor(t)))
    rgt, b = min(W, int(math.ceil(rgt))), min(H, int(math.ceil(b)))
    if rgt - l >= 32 and b - t >= 32:
        img = img.crop((l, t, rgt, b))
        out_bbox = [s, w, n, e]
    else:
        out_bbox = [south_t, west_t, north_t, east_t]
    # 長辺 1536 に縮小
    max_edge = 1536
    if max(img.size) > max_edge:
        img.thumbnail((max_edge, max_edge), Image.Resampling.LANCZOS)
    import io
    buf = io.BytesIO()
    img.save(buf, format="JPEG", quality=72, optimize=True, progressive=True)
    body = buf.getvalue()
    with open(cache_path, "wb") as f:
        f.write(body)
    meta = {
        "icao": icao, "z": z, "bbox": [s, w, n, e], "outBbox": out_bbox,
        "width": img.size[0], "height": img.size[1], "bytes": len(body),
        "tiles": ok, "fetchedAtUnix": now,
        "fetchedAt": dt.datetime.now(dt.timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"),
    }
    open(meta_path, "w", encoding="utf-8").write(json.dumps(meta, ensure_ascii=False))
    rel, nb, _ = write_bytes(body, "jpg")
    log(f"{icao}: GSI 写真 {img.size[0]}x{img.size[1]} z{z} {nb}B tiles={ok}/{cols*rows}")
    return {"file": rel, "bytes": nb, "bbox": out_bbox, "width": img.size[0], "height": img.size[1],
            "src": "gsi-seamlessphoto", "z": z}


def build_airport(icao, items, lat=None, lon=None, rad=None, osm=None, meta=None):
    info = AIRPORTS.get(icao)
    if info:
        lat = lat or info[0]
        lon = lon or info[1]
        rad = rad or info[2]
    if lat is None or lon is None:
        return {"ok": False, "error": "空港の位置が不明なため地上図を作れませんでした。"}
    try:
        if osm is None:
            osm, meta = load_osm(icao, lat, lon, rad or 6000)
        layout = Layout(icao, osm)
    except Exception as e:  # noqa: BLE001
        return {"ok": False, "error": f"地図データ（OpenStreetMap）を取得できませんでした。次の更新で再試行します。（{type(e).__name__}）"}
    lj = build_layout_json(layout)
    if not lj:
        return {"ok": False, "error": "この空港の滑走路・誘導路の地図データが不足しています。"}
    origin = (lj["origin"][0], lj["origin"][1])
    notams = []
    stats = collections.Counter()
    ground_items = []
    for it in items or []:
        text = it.get("text") or ""
        q = (get_Q(text) + [""] * 2)[1]
        e0 = get_E(text)
        r = resolve(layout, it)
        cgeoms = parse_coord_geoms(e0)
        ccat = cat_of_coord(q, e0)
        groundish = is_groundish(q) or "CLSD" in (e0 or "")
        # 地上施設に置けず、座標があるものは座標ジオメトリを使う
        if cgeoms and (ccat or not r["geoms"]):
            if not groundish or not r["geoms"]:
                r["cat"] = ccat or r["cat"] or "coord"
                r["geoms"] = cgeoms
                sm, ja = summarize_coord(e0, q)
                r["summary"], r["ja"] = sm, ja
        ground_items.append(r)
        placed = bool(r["geoms"])
        # 地上照合の統計は従来どおり地上系だけ（既存テストのため）
        if groundish:
            stats["total"] += 1
            if placed and not r["unres"] and not r["approx"]:
                stats["exact"] += 1
            elif placed:
                stats["partial"] += 1
            else:
                stats["unplaced"] += 1
        if cgeoms and not groundish:
            stats["coord"] += 1
        stats["listed"] += 1
        notams.append({
            "id": r["id"],
            "q": r["q"],
            "cat": r["cat"],
            "summary": r["summary"],
            "ja": r["ja"],
            "e": r["e"],
            "from": r["from"],
            "to": r["to"],
            "sched": r["sched"],
            "approx": r["approx"],
            "unres": r["unres"],
            "geoms": encode_geoms(r["geoms"], origin),
        })
    file, nbytes, _ = write_blob(lj)
    err = None
    if layout.quality == "limited":
        err = None
        note = "この空港はOpenStreetMapの誘導路名が少ないため、NOTAMの位置は限られます。"
    else:
        note = None
    attr = "© OpenStreetMap contributors"
    photo = None
    try:
        photo = stitch_gsi_photo(icao, lj.get("bbox"))
    except Exception as ex:  # noqa: BLE001
        log(f"{icao}: GSI 写真失敗:", type(ex).__name__, ex)
        photo = None
    if photo:
        attr = attr + " ／ 地理院タイル（航空写真）出典：国土地理院"
    try:
        coast_file, coast_bytes = write_coast_blob()
    except Exception as ex:  # noqa: BLE001
        log(f"{icao}: 海岸線blob失敗:", type(ex).__name__, ex)
        coast_file, coast_bytes = None, 0
    payload = {
        "ok": True,
        "file": file,
        "bytes": nbytes,
        "quality": layout.quality,
        "namedRefs": layout.named_refs,
        "osmAt": layout.osm_ts,
        "stale": bool((meta or {}).get("stale")),
        "note": note,
        "attribution": attr,
        "origin": lj["origin"],
        "scale": SCALE,
        "arp": [round(lat, 6), round(lon, 6)],
        "bbox": lj["bbox"],
        "notams": notams,
        "stats": dict(stats),
        "error": err,
    }
    if photo:
        payload["photoFile"] = photo["file"]
        payload["photo"] = {k: photo[k] for k in ("bbox", "width", "height", "src", "z", "bytes")}
    if coast_file:
        payload["coastFile"] = coast_file
        payload["coastBytes"] = coast_bytes
    return payload, layout, ground_items


def build_all(notam_airports, profiles=None, prev_ground=None):
    """全対象空港を処理。戻り値: {icao: ground payload for ap/*.json}。例外は中で吸収。"""
    out = {}
    profiles = profiles or {}
    for icao in AIRPORTS:
        items = ((notam_airports or {}).get(icao) or {}).get("items") or []
        p = (profiles.get(icao) or {})
        lat, lon = p.get("lat"), p.get("lon")
        try:
            payload, _, _ = build_airport(icao, items, lat=lat, lon=lon)
            out[icao] = payload
            st = payload.get("stats") or {}
            log(f"{icao}: quality={payload.get('quality')} named={payload.get('namedRefs')} "
                f"notam={st.get('total', 0)} exact={st.get('exact', 0)} partial={st.get('partial', 0)} "
                f"unplaced={st.get('unplaced', 0)} listed={st.get('listed', 0)} coord={st.get('coord', 0)} "
                f"layout={payload.get('bytes')}B photo={((payload.get('photo') or {}).get('bytes') or 0)}B")
        except Exception as e:  # noqa: BLE001
            log(f"{icao}: 失敗:", type(e).__name__, e)
            if prev_ground and icao in prev_ground and (prev_ground[icao] or {}).get("ok"):
                g = dict(prev_ground[icao], carriedOver=True)
                out[icao] = g
                log(f"{icao}: 前回の地上図を引き継ぎ")
            else:
                out[icao] = {"ok": False, "error": "地上図を作れませんでした。次の更新で再試行します。"}
    return out


def signature_of(ground_by_icao):
    h = hashlib.sha256()
    for icao in sorted(ground_by_icao or {}):
        g = ground_by_icao[icao] or {}
        h.update(icao.encode())
        h.update((g.get("file") or "").encode())
        h.update((g.get("photoFile") or "").encode())
        h.update((g.get("coastFile") or "").encode())
        h.update(json.dumps([n.get("id") for n in g.get("notams") or []], ensure_ascii=False).encode())
        h.update((g.get("error") or "").encode())
    return h.hexdigest()
