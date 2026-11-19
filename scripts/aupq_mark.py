"""
AUPQ35 / AUPQ78（気象庁ベクター PDF）に目印を重ね描きした PDF を作る。失敗したら例外を投げるだけ（呼び出し側が原図にフォールバック）。
  1. 日本の海岸線をオレンジ（半透明・細線）で重ねる
     図は 140E 中心の極ステレオ投影。2 つのパネル（上段=300/700hPa、下段=500/850hPa）の枠を PDF から見つけ、
     実 PDF の経緯線・海岸線に合わせて較正した定数（下の CAL）で投影する。毎回、図の海岸線ベクターとの一致率を検査し、
     ずれていたら（図の投影が変わった等）何も描かずに例外にする。
  2. 低気圧中心の「L」を赤で上書き（PDF には文字ではなく太さ1.13の折れ線 (0,0)->(0,8)->(4.5,8) として入っている）。
     高気圧「H」（縦2本＋横1本）の青上書きは mark_h=True の時だけ（既定 off）。
PyMuPDF（import pymupdf）が必要。無ければ ImportError → 呼び出し側が原図にフォールバックする。
"""
import json
import math
import os

MARK_VER = "m1"  # 描画内容を変えたら上げる（キャッシュのキーに入る）
HERE = os.path.dirname(os.path.abspath(__file__))
# 較正（実 PDF で数値フィット: 経緯線の交点＋Natural Earth 海岸線との ICP。4 パネルで同値、中央値誤差 0.46pt）
# パネル左上(19.5, 43.0)を基準にした、北極点の位置（pt）・縮尺（pt/単位球）・中心経度
CAL = {"S": 784.85, "pole_dx": 488.35 - 19.5, "pole_dy": -128.87 - 43.0, "lon0": 140.0,
       "panel_w": 686.0, "panel_h": 467.7}
ORANGE = (1.0, 0.5, 0.0)
RED = (0.9, 0.0, 0.0)
BLUE = (0.0, 0.3, 0.95)


def _proj(lon, lat, ox, oy):
    r = CAL["S"] * math.tan(math.radians(90 - lat) / 2)
    d = math.radians(lon - CAL["lon0"])
    return (ox + CAL["pole_dx"] + r * math.sin(d), oy + CAL["pole_dy"] + r * math.cos(d))


def _clip(a, b, rc):
    """Liang–Barsky。矩形 rc=(x0,y0,x1,y1) に線分 a-b を切り取る。外なら None。"""
    x0, y0 = a
    dx, dy = b[0] - a[0], b[1] - a[1]
    t0, t1 = 0.0, 1.0
    for p, q in ((-dx, x0 - rc[0]), (dx, rc[2] - x0), (-dy, y0 - rc[1]), (dy, rc[3] - y0)):
        if p == 0:
            if q < 0:
                return None
        else:
            t = q / p
            if p < 0:
                if t > t1:
                    return None
                t0 = max(t0, t)
            else:
                if t < t0:
                    return None
                t1 = min(t1, t)
    return (x0 + t0 * dx, y0 + t0 * dy), (x0 + t1 * dx, y0 + t1 * dy)


def _panels(page):
    out = []
    for d in page.get_drawings():
        r = d["rect"]
        if d.get("items") and d["items"][0][0] == "re" and abs(r.width - CAL["panel_w"]) < 3 and abs(r.height - CAL["panel_h"]) < 3:
            out.append((r.x0, r.y0, r.x1, r.y1))
    out = sorted(set((round(a, 1), round(b, 1), round(c, 1), round(d_, 1)) for a, b, c, d_ in out), key=lambda t: t[1])
    if len(out) != 2:
        raise RuntimeError(f"パネル枠が2つ見つからない: {len(out)}")
    return out


def _chart_coast_index(page, rc):
    """図自身の細線(0.28)ポリラインの頂点を 2pt グリッドに入れる（較正の検査用）。"""
    grid = {}
    for d in page.get_drawings():
        if d["color"] != (0.0, 0.0, 0.0) or abs((d["width"] or 0) - 0.28) > 0.01 or len(d["items"]) < 3 or d["items"][0][0] != "l":
            continue
        r = d["rect"]
        if r.y0 < rc[1] - 1 or r.y1 > rc[3] + 1 or r.width > 300 or r.height > 300:
            continue
        for it in d["items"]:
            for q in (it[1], it[2]):
                grid.setdefault((int(q.x // 2), int(q.y // 2)), []).append((q.x, q.y))
    return grid


def _near(grid, x, y, tol):
    cx, cy = int(x // 2), int(y // 2)
    best = 1e9
    for i in (-1, 0, 1):
        for j in (-1, 0, 1):
            for qx, qy in grid.get((cx + i, cy + j), ()):
                best = min(best, math.hypot(qx - x, qy - y))
    return best <= tol


def mark_pdf(src, dst, mark_h=False):
    try:
        import pymupdf
    except ImportError:
        import sys
        sys.path.append(os.path.expanduser("~/.local/share/fb-pylib"))  # pip install --target で入れた置き場
        import pymupdf
    coast = json.load(open(os.path.join(HERE, "aupq_japan_coast.json")))["rings"]
    doc = pymupdf.open(src)
    page = doc[0]
    panels = _panels(page)
    stats = {"coast_segments": 0, "L": 0, "H": 0, "match": []}
    # 較正検査: 投影した海岸線の頂点のうち、図の細線の頂点から 1.5pt 以内にあるものの割合
    for rc in panels:
        grid = _chart_coast_index(page, rc)
        tot = ok = 0
        for ring in coast:
            for lon, lat in ring[::3]:
                if not (126 < lon < 146 and 30 < lat < 46):
                    continue
                x, y = _proj(lon, lat, rc[0], rc[1])
                if rc[0] < x < rc[2] and rc[1] < y < rc[3]:
                    tot += 1
                    ok += _near(grid, x, y, 1.5)
        frac = ok / tot if tot else 0.0
        stats["match"].append(round(frac, 3))
        if tot < 50 or frac < 0.6:
            raise RuntimeError(f"海岸線の位置が図とずれている（一致率 {frac:.2f}, n={tot}）")
    # 海岸線（オレンジ）
    sh = page.new_shape()
    for rc in panels:
        for ring in coast:
            pts = [_proj(lon, lat, rc[0], rc[1]) for lon, lat in ring]
            if max(p[0] for p in pts) < rc[0] or min(p[0] for p in pts) > rc[2] or max(p[1] for p in pts) < rc[1] or min(p[1] for p in pts) > rc[3]:
                continue
            cur = []
            for a, b in zip(pts, pts[1:]):
                c = _clip(a, b, rc)
                if c is None:
                    if len(cur) > 1:
                        sh.draw_polyline(cur)
                        stats["coast_segments"] += 1
                    cur = []
                    continue
                if cur and abs(cur[-1][0] - c[0][0]) < 1e-6 and abs(cur[-1][1] - c[0][1]) < 1e-6:
                    cur.append(c[1])
                else:
                    if len(cur) > 1:
                        sh.draw_polyline(cur)
                        stats["coast_segments"] += 1
                    cur = [c[0], c[1]]
            if len(cur) > 1:
                sh.draw_polyline(cur)
                stats["coast_segments"] += 1
    sh.finish(color=ORANGE, width=0.7, stroke_opacity=0.6, closePath=False, lineCap=1, lineJoin=1)
    sh.commit()
    # L / H
    sh2 = page.new_shape()
    verts, bars = [], []
    for d in page.get_drawings():
        if d["color"] != (0.0, 0.0, 0.0) or abs((d["width"] or 0) - 1.13) > 0.03:
            continue
        it = d["items"]
        if len(it) == 2 and it[0][0] == "l" and it[1][0] == "l":
            p0, p1, p2 = it[0][1], it[0][2], it[1][2]
            if abs(p1.x - p0.x) < 0.2 and 7 < p1.y - p0.y < 9 and abs(p2.y - p1.y) < 0.2 and 4 < p2.x - p1.x < 5:
                sh2.draw_polyline([p0, p1, p2])
                stats["L"] += 1
        elif len(it) == 1 and it[0][0] == "l":
            a, b = it[0][1], it[0][2]
            if abs(a.x - b.x) < 0.1 and 7 < abs(a.y - b.y) < 9:
                verts.append((a.x, min(a.y, b.y), max(a.y, b.y)))
            elif abs(a.y - b.y) < 0.1 and 4 < abs(a.x - b.x) < 5:
                bars.append((min(a.x, b.x), max(a.x, b.x), a.y))
    sh2.finish(color=RED, width=1.7, closePath=False, lineCap=1, lineJoin=1)
    sh2.commit()
    if mark_h:
        sh3 = page.new_shape()
        for x0, x1, y in bars:
            l = [v for v in verts if abs(v[0] - x0) < 0.3 and v[1] < y < v[2]]
            r = [v for v in verts if abs(v[0] - x1) < 0.3 and v[1] < y < v[2]]
            if l and r:
                sh3.draw_line((x0, l[0][1]), (x0, l[0][2]))
                sh3.draw_line((x1, r[0][1]), (x1, r[0][2]))
                sh3.draw_line((x0, y), (x1, y))
                stats["H"] += 1
        sh3.finish(color=BLUE, width=1.7, closePath=False, lineCap=1, lineJoin=1)
        sh3.commit()
    doc.save(dst, garbage=3, deflate=True)
    doc.close()
    return stats


if __name__ == "__main__":
    import sys
    print(mark_pdf(sys.argv[1], sys.argv[2], mark_h=len(sys.argv) > 3))
