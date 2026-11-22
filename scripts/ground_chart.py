#!/usr/bin/env python3
"""空港地上図（OSM）と NOTAM の位置照合。

build_pack から呼ぶ。失敗してもパック全体は止めない。
地図は OpenStreetMap（ODbL）。画面に © OpenStreetMap contributors を出すこと。
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
                elif a == "parking_position" and t.get("ref"):
                    self.SPOT[t["ref"]].append(e)
                elif a == "apron":
                    self.APRON.append(e)
                elif a in ("terminal", "hangar"):
                    self.TERM.append(e)
                elif a == "stopway" and t.get("ref"):
                    self.RWYW.setdefault(t["ref"], [])  # ignore stopways in rwy chain
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
    return out


def write_blob(obj):
    body = json.dumps(obj, ensure_ascii=False, separators=(",", ":")).encode("utf-8")
    h = hashlib.sha256(body).hexdigest()
    rel = f"data/blobs/{h}.json"
    dst = os.path.join(ROOT, rel)
    os.makedirs(os.path.dirname(dst), exist_ok=True)
    if not os.path.exists(dst):
        with open(dst, "wb") as f:
            f.write(body)
    return rel, len(body), h


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
        q = (get_Q(it.get("text") or "") + [""] * 2)[1]
        if not is_groundish(q) and "CLSD" not in (get_E(it.get("text") or "")):
            # still resolve lights etc already covered by is_groundish
            if q[1:3] not in ("OL", "WU", "WH") if q else True:
                if not is_groundish(q):
                    continue
        if q[1:3] in ("OL", "WU", "WH"):
            continue  # 市街地の障害物灯・無人機・花火は地上図対象外
        e0 = get_E(it.get("text") or "")
        if re.match(r"REF (?:AIP|AIRAC)|TRIGGER NOTAM", e0 or ""):
            continue  # 修正通報・トリガで、地上の位置を持たない
        r = resolve(layout, it)
        if r["cat"] == "other" and not r["geoms"] and not is_groundish(r["q"]):
            continue
        ground_items.append(r)
        placed = bool(r["geoms"])
        stats["total"] += 1
        if placed and not r["unres"] and not r["approx"]:
            stats["exact"] += 1
        elif placed:
            stats["partial"] += 1
        else:
            stats["unplaced"] += 1
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
    return {
        "ok": True,
        "file": file,
        "bytes": nbytes,
        "quality": layout.quality,
        "namedRefs": layout.named_refs,
        "osmAt": layout.osm_ts,
        "stale": bool((meta or {}).get("stale")),
        "note": note,
        "attribution": "© OpenStreetMap contributors",
        "origin": lj["origin"],
        "scale": SCALE,
        "notams": notams,
        "stats": dict(stats),
        "error": err,
    }, layout, ground_items


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
                f"unplaced={st.get('unplaced', 0)} layout={payload.get('bytes')}B")
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
        h.update(json.dumps([n.get("id") for n in g.get("notams") or []], ensure_ascii=False).encode())
        h.update((g.get("error") or "").encode())
    return h.hexdigest()
