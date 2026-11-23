// NOTAM タブ「地上図」：OSM の滑走路・誘導路に、パックで照合済みの NOTAM を重ねる。
(function () {
  const PIN_CAT = {
    rwy_closed: 1, twy_closed: 1, twy_restr: 1, spot_closed: 1, spot_reloc: 1,
    obst_lgt: 1, obst: 1, uas: 1, balloon: 1, fireworks: 1, pg: 1, acro: 1, coord: 1,
  };
  const CAT_COLOR = {
    rwy_closed: 'var(--red)', twy_closed: 'var(--red)', spot_closed: 'var(--red)',
    twy_restr: 'var(--gc-orange)', spot_reloc: 'var(--gc-orange)',
    light: 'var(--yellow)', ils: 'var(--cyan)', marking: 'var(--gc-orange)', other: 'var(--yellow)',
    obst_lgt: '#e0b422', obst: '#c46b2a', uas: '#8b6cff', balloon: '#e86b8a',
    fireworks: '#e23d5b', pg: '#2fb57a', acro: '#1aadbf', coord: '#7a8ba1',
  };
  const FILTER = {
    closed: ['rwy_closed', 'twy_closed', 'spot_closed'],
    restr: ['twy_restr', 'spot_reloc'],
    other: ['light', 'ils', 'marking', 'other'],
    obst: ['obst_lgt', 'obst'],
    activity: ['uas', 'balloon', 'fireworks', 'pg', 'acro', 'coord'],
  };
  const ui = {
    icao: null, on: true,
    filter: { closed: true, restr: true, other: true, obst: true, activity: true },
    time: 'now', at: '', sel: null, hi: [],
    scope: 'airport', photo: true,
    viewA: { x: 0, y: 0, s: 1 },
    viewW: { x: 0, y: 0, s: 1 },
  };
  let lastPack = null, lastEl = null, lastCtx = null;

  function esc(s) { return String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;'); }
  function viewOf() { return ui.scope === 'wide' ? ui.viewW : ui.viewA; }
  function setView(v) { if (ui.scope === 'wide') ui.viewW = v; else ui.viewA = v; }
  function whenMs() {
    if (ui.time === 'plus3') return Date.now() + 3 * 3600000;
    if (ui.time === 'at' && ui.at) {
      const t = Date.parse(ui.at + ':00+09:00');
      if (Number.isFinite(t)) return t;
    }
    return Date.now();
  }
  function isActive(n, t) {
    if (n.from && t < Date.parse(n.from)) return false;
    if (n.to) {
      const et = Date.parse(n.to);
      if (Number.isFinite(et) && t > et) return false;
    }
    const s = n.sched;
    if (!s) return true;
    const d = new Date(t);
    if (s.days && s.days.length && !s.days.includes(d.getUTCDate())) return false;
    if (s.start != null && s.end != null) {
      const hm = d.getUTCHours() * 100 + d.getUTCMinutes();
      return s.start <= s.end ? (s.start <= hm && hm <= s.end) : (hm >= s.start || hm <= s.end);
    }
    return true;
  }
  function pad(n) { return String(n).padStart(2, '0'); }
  function fmtJst(iso) {
    if (!iso) return '—';
    const t = Date.parse(iso);
    if (!Number.isFinite(t)) return iso;
    const d = new Date(t + 9 * 3600000);
    return `${d.getUTCMonth() + 1}/${d.getUTCDate()} ${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}`;
  }
  function hmmToJst(hmm) {
    const h = Math.floor(hmm / 100), m = hmm % 100;
    let tot = h * 60 + m + 9 * 60;
    tot = ((tot % 1440) + 1440) % 1440;
    return `${pad(Math.floor(tot / 60))}:${pad(tot % 60)}`;
  }
  function periodText(n) {
    const a = `${fmtJst(n.from)} – ${n.to ? fmtJst(n.to) : 'PER'} JST`;
    if (n.sched && n.sched.start != null) {
      const js = hmmToJst(n.sched.start), je = hmmToJst(n.sched.end);
      const night = n.sched.start >= 1400 && n.sched.end <= 2200;
      return `${a} ・ ${js}–${je}${night ? ' ・ 夜間のみ' : ''}${n.sched.days ? ' ・ 指定日' : ''}`;
    }
    return a;
  }
  function timeLabel() {
    const t = new Date(whenMs() + 9 * 3600000);
    return `${t.getUTCMonth() + 1}/${t.getUTCDate()} ${pad(t.getUTCHours())}:${pad(t.getUTCMinutes())} JST`;
  }
  function decPt(p, o, sc) { return [o[0] + p[0] / sc, o[1] + p[1] / sc]; }
  function decLine(pts, o, sc) {
    const out = [];
    for (let i = 0; i < (pts || []).length; i += 2) out.push(decPt([pts[i], pts[i + 1]], o, sc));
    return out;
  }
  function distM(a, b) {
    return Math.hypot((a[0] - b[0]) * 110950, (a[1] - b[1]) * 111320 * Math.cos((a[0] + b[0]) / 2 * Math.PI / 180));
  }
  function mid(pts) {
    let L = 0;
    for (let i = 0; i < pts.length - 1; i++) L += distM(pts[i], pts[i + 1]);
    let acc = 0;
    for (let i = 0; i < pts.length - 1; i++) {
      const d = distM(pts[i], pts[i + 1]);
      if (acc + d >= L / 2) {
        const f = d ? (L / 2 - acc) / d : 0;
        return [pts[i][0] + (pts[i + 1][0] - pts[i][0]) * f, pts[i][1] + (pts[i + 1][1] - pts[i][1]) * f];
      }
      acc += d;
    }
    return pts[0];
  }
  function inFilter(cat) {
    for (const k of Object.keys(FILTER)) {
      if (FILTER[k].includes(cat)) return !!ui.filter[k];
    }
    return !!ui.filter.other;
  }
  function allActive(g) {
    const t = whenMs();
    return (g.notams || []).filter((n) => isActive(n, t));
  }
  function hasGeom(n) { return (n.geoms || []).length > 0; }

  function numbers(list) {
    const order = ['rwy_closed', 'twy_closed', 'twy_restr', 'spot_closed', 'spot_reloc',
      'obst_lgt', 'obst', 'uas', 'balloon', 'fireworks', 'pg', 'acro', 'coord'];
    const num = {}, rest = [];
    let i = 1;
    for (const c of order) for (const n of list) if (n.cat === c && hasGeom(n)) num[n.id] = i++;
    for (const n of list) if (hasGeom(n) && num[n.id] == null) rest.push(n);
    return { num, rest, pinCount: i - 1 };
  }

  function View(lat, lon, mpp, W, H) {
    this.lat = lat; this.lon = lon; this.mpp = mpp; this.W = W; this.H = H;
  }
  View.prototype.xy = function (p) {
    const xx = (p[1] - this.lon) * 111320 * Math.cos(this.lat * Math.PI / 180) / this.mpp + this.W / 2;
    const y = -(p[0] - this.lat) * 110950 / this.mpp + this.H / 2;
    return [xx, y];
  };
  View.prototype.inside = function (p, m) {
    m = m == null ? 16 : m;
    const [x, y] = this.xy(p);
    return x >= -m && x <= this.W + m && y >= -m && y <= this.H + m;
  };
  function polyD(V, P, close) {
    let d = '';
    for (let i = 0; i < P.length; i++) {
      const [x, y] = V.xy(P[i]);
      d += (i ? 'L' : 'M') + x.toFixed(1) + ',' + y.toFixed(1);
    }
    return close ? d + 'Z' : d;
  }
  function pathD(V, pts) { return polyD(V, pts, false); }
  function circlePts(c, rM, n) {
    n = n || 64;
    const pts = [];
    const clat = Math.cos(c[0] * Math.PI / 180);
    for (let i = 0; i <= n; i++) {
      const a = i / n * 2 * Math.PI;
      pts.push([c[0] + rM * Math.cos(a) / 110950, c[1] + rM * Math.sin(a) / (111320 * clat)]);
    }
    return pts;
  }
  function fit(layout, W, H, pad) {
    pad = pad || 18;
    const b = layout.bbox;
    const midLat = (b[0] + b[2]) / 2, midLon = (b[1] + b[3]) / 2;
    const hM = (b[2] - b[0]) * 110950, wM = (b[3] - b[1]) * 111320 * Math.cos(midLat * Math.PI / 180);
    const mpp = Math.max(wM / Math.max(1, W - pad * 2), hM / Math.max(1, H - pad * 2));
    return new View(midLat, midLon, mpp, W, H);
  }
  function fitWide(g, layout, list, W, H) {
    const b = layout.bbox;
    let s = b[0], w = b[1], n = b[2], e = b[3];
    const arp = g.arp || [(s + n) / 2, (w + e) / 2];
    const o = layout.origin, sc = layout.scale;
    const expandP = (p, extraM) => {
      extraM = extraM || 0;
      const dlat = extraM / 110950, dlon = extraM / (111320 * Math.cos(((p[0] + arp[0]) / 2) * Math.PI / 180));
      s = Math.min(s, p[0] - dlat); n = Math.max(n, p[0] + dlat);
      w = Math.min(w, p[1] - dlon); e = Math.max(e, p[1] + dlon);
    };
    // 最低 8 NM
    expandP(arp, 8 * 1852);
    for (const item of list || []) {
      for (const gm of item.geoms || []) {
        if (gm.t === 'pt' || gm.t === 'circle') expandP(decPt(gm.p, o, sc), gm.t === 'circle' ? (gm.r || 0) : 0);
        else if (gm.pts) decLine(gm.pts, o, sc).forEach((p) => expandP(p, 0));
      }
    }
    const midLat = (s + n) / 2, midLon = (w + e) / 2;
    const hM = (n - s) * 110950, wM = (e - w) * 111320 * Math.cos(midLat * Math.PI / 180);
    const mpp = Math.max(wM / Math.max(1, W - 28), hM / Math.max(1, H - 28), 25);
    return new View(midLat, midLon, mpp, W, H);
  }

  function ns(x, y, inner, ids, cls) {
    return `<g class="gc-ns ${cls || ''}" data-x="${x.toFixed(1)}" data-y="${y.toFixed(1)}"${ids ? ` data-ids="${esc(ids)}"` : ''} transform="translate(${x.toFixed(1)},${y.toFixed(1)})">${inner}</g>`;
  }
  function hitPath(d, ids, fill) {
    if (fill) return `<path class="gc-hit" d="${d}" fill="#000" fill-opacity="0.01" stroke="#000" stroke-width="18" stroke-linejoin="round" opacity="0" data-ids="${esc(ids)}" pointer-events="all"/>`;
    return `<path class="gc-hit gc-nss" d="${d}" fill="none" stroke="#000" stroke-width="22" stroke-linecap="round" stroke-linejoin="round" opacity="0" data-ids="${esc(ids)}" pointer-events="stroke"/>`;
  }

  function drawPhoto(V, g) {
    if (!ui.photo || ui.scope === 'wide' || !g.photoUrl || !g.photo || !g.photo.bbox) return '';
    const b = g.photo.bbox;
    const [x0, y0] = V.xy([b[2], b[1]]);
    const [x1, y1] = V.xy([b[0], b[3]]);
    const w = x1 - x0, h = y1 - y0;
    if (w < 8 || h < 8) return '';
    return `<image href="${esc(g.photoUrl)}" x="${x0.toFixed(1)}" y="${y0.toFixed(1)}" width="${w.toFixed(1)}" height="${h.toFixed(1)}" preserveAspectRatio="none" opacity=".92"/>`;
  }
  function drawCoast(V, coast) {
    if (!coast || !coast.rings) return '';
    let d = '';
    const m = Math.max(V.W, V.H) * 2;
    for (const ring of coast.rings) {
      if (!ring.length) continue;
      if (!ring.some((p) => V.inside(p, m))) continue;
      d += polyD(V, ring, true);
    }
    if (!d) return '';
    return `<path class="gc-nss" d="${d}" fill="var(--gc-land)" fill-rule="evenodd" stroke="var(--gc-coast)" stroke-width="1.2"/>`;
  }
  function drawRings(V, arp) {
    if (!arp) return '';
    const parts = [];
    const maxR = Math.hypot(V.W, V.H) * V.mpp * 0.85;
    for (const nmi of [2, 5, 10, 15, 20, 30, 40, 50]) {
      const r = nmi * 1852;
      if (r > maxR * 1.2) continue;
      const pts = circlePts(arp, r, 80);
      parts.push(`<path class="gc-nss" data-dash="5 5" d="${pathD(V, pts)}" fill="none" stroke="var(--gc-ring)" stroke-width="1" stroke-dasharray="5 5" opacity=".5"/>`);
      const [x, y] = V.xy([arp[0], arp[1] + nmi * 1852 / (111320 * Math.cos(arp[0] * Math.PI / 180))]);
      parts.push(ns(x, y, `<text y="3" text-anchor="middle" font-size="9" font-weight="700" fill="var(--gc-ring)" stroke="var(--gc-halo)" stroke-width="2.4" paint-order="stroke">${nmi} NM</text>`));
    }
    return parts.join('');
  }
  function drawApOutline(V, layout) {
    const b = layout.bbox;
    const pts = [[b[0], b[1]], [b[0], b[3]], [b[2], b[3]], [b[2], b[1]], [b[0], b[1]]];
    return `<path class="gc-nss" data-dash="4 3" d="${pathD(V, pts)}" fill="none" stroke="var(--gc-apout)" stroke-width="1.4" stroke-dasharray="4 3" opacity=".85"/>`;
  }

  function drawLayout(V, layout, o) {
    o = o || {};
    const parts = [];
    const decO = layout.origin, sc = layout.scale;
    const faded = o.photo ? ' opacity=".48"' : '';
    const poly = (arr, fill, stroke, sw) => {
      for (const raw of arr || []) {
        const p = decLine(raw, decO, sc);
        if (p.length < 2 || !p.some((q) => V.inside(q, 200))) continue;
        parts.push(`<path d="${polyD(V, p, true)}" fill="${fill}" stroke="${stroke}" stroke-width="${sw}"${faded}/>`);
      }
    };
    poly(layout.aprons, 'var(--gc-apron)', 'var(--gc-apron-s)', 0.6);
    poly(layout.terminals, 'var(--gc-term)', 'var(--gc-apron-s)', 0.6);
    const tw = Math.max(2.0, 22 / V.mpp);
    const addWays = (ways, stroke, width, cap, opac) => {
      const op = opac != null ? ` opacity="${opac}"` : faded;
      for (const raw of ways || []) {
        const p = decLine(raw, decO, sc);
        if (p.length < 2 || !p.some((q) => V.inside(q))) continue;
        parts.push(`<path d="${pathD(V, p)}" fill="none" stroke="${stroke}" stroke-width="${width.toFixed(1)}" stroke-linecap="${cap}" stroke-linejoin="round"${op}/>`);
      }
    };
    addWays(layout.unnamed, 'var(--gc-twy)', tw * 0.85, 'round');
    addWays(layout.parking, 'var(--gc-park)', Math.max(1.1, tw * 0.42), 'butt', o.photo ? '.4' : '.75');
    for (const t of layout.taxiways || []) addWays(t.ways, 'var(--gc-twy)', tw, 'round');
    const rw = Math.max(5, 58 / V.mpp);
    for (const r of layout.runways || []) {
      const p = decLine(r.pts, decO, sc);
      if (p.length < 2) continue;
      parts.push(`<path d="${pathD(V, p)}" fill="none" stroke="var(--gc-rwy)" stroke-width="${rw.toFixed(1)}" stroke-linecap="butt"${faded}/>`);
      parts.push(`<path class="gc-nss" data-dash="6 5" d="${pathD(V, p)}" fill="none" stroke="var(--gc-rwycl)" stroke-width="0.9" stroke-dasharray="6 5" opacity=".75"/>`);
    }
    addWays(layout.stopways, 'var(--gc-rwy)', rw * 0.7, 'butt', o.photo ? '.4' : '.7');
    return { svg: parts.join(''), tw, rw };
  }

  function rwyEnds(layout, id) {
    const r = (layout.runways || []).find((x) => x.id === id);
    if (!r) return [];
    const p = decLine(r.pts, layout.origin, layout.scale);
    return p.length ? [p[0], p[p.length - 1]] : [];
  }
  function rwyPts(layout, id) {
    const r = (layout.runways || []).find((x) => x.id === id);
    return r ? decLine(r.pts, layout.origin, layout.scale) : [];
  }
  function thrOf(layout, id, num) {
    const p = rwyPts(layout, id);
    if (p.length < 2) return null;
    const h = parseInt(String(num).replace(/[LRC]/, ''), 10) * 10;
    const hi = p[0][0] > p[p.length - 1][0] ? p[0] : p[p.length - 1];
    const lo = hi === p[0] ? p[p.length - 1] : p[0];
    return (h >= 90 && h < 270) ? hi : lo;
  }

  function geomPts(n, layout) {
    const o = layout.origin, sc = layout.scale;
    const out = [];
    for (const gm of n.geoms || []) {
      if (gm.t === 'line') out.push({ t: 'line', pts: decLine(gm.pts, o, sc) });
      else if (gm.t === 'poly') out.push({ t: 'poly', pts: decLine(gm.pts, o, sc) });
      else if (gm.t === 'pt') out.push({ t: 'pt', p: decPt(gm.p, o, sc) });
      else if (gm.t === 'circle') out.push({ t: 'circle', p: decPt(gm.p, o, sc), r: gm.r || 0 });
      else if (gm.t === 'rwy') out.push({ t: 'rwy', id: gm.id, label: gm.label, pts: rwyPts(layout, gm.id) });
    }
    return out;
  }

  function overlay(V, g, layout, list, num, sel, tw) {
    const over = [], hits = [], icons = [], pins = [];
    const vs = viewOf().s || 1;
    for (const n of list) {
      if (!ui.on) break;
      const c = CAT_COLOR[n.cat] || 'var(--yellow)';
      const selected = n.id === sel || (ui.hi || []).includes(n.id);
      const ids = n.id;
      for (const gm of geomPts(n, layout)) {
        if (gm.t === 'line' && gm.pts.length > 1) {
          if (!gm.pts.some((p) => V.inside(p))) continue;
          const d = pathD(V, gm.pts);
          if (n.cat === 'twy_closed' || n.cat === 'twy_restr' || n.cat === 'rwy_closed') {
            const w = tw + 2.4;
            if (selected) over.push(`<path class="gc-nss" d="${d}" fill="none" stroke="#fff" stroke-width="${w + 5}" stroke-linecap="round" opacity=".55"/>`);
            over.push(`<path class="gc-nss gc-feat" data-ids="${esc(ids)}" d="${d}" fill="none" stroke="${c}" stroke-width="${w.toFixed(1)}" stroke-linecap="round" stroke-linejoin="round"/>`);
            if (n.cat === 'twy_closed' || n.cat === 'rwy_closed') {
              over.push(`<path class="gc-nss gc-feat" data-dash="1.6 3.4" data-ids="${esc(ids)}" d="${d}" fill="none" stroke="var(--gc-hatch)" stroke-width="${(w - 1).toFixed(1)}" stroke-dasharray="${(1.6 / vs).toFixed(2)} ${(3.4 / vs).toFixed(2)}" opacity=".85"/>`);
            } else {
              over.push(`<path class="gc-nss gc-feat" data-dash="4 4" data-ids="${esc(ids)}" d="${d}" fill="none" stroke="var(--gc-hatch)" stroke-width="${(w - 1.4).toFixed(1)}" stroke-dasharray="${(4 / vs).toFixed(2)} ${(4 / vs).toFixed(2)}" opacity=".7"/>`);
            }
          } else if (n.cat === 'light' || n.cat === 'marking' || n.cat === 'ils') {
            over.push(`<path class="gc-nss gc-feat" data-dash=".1 3.6" data-ids="${esc(ids)}" d="${d}" fill="none" stroke="${c}" stroke-width="2" stroke-dasharray="${(0.1 / vs).toFixed(2)} ${(3.6 / vs).toFixed(2)}" stroke-linecap="round"/>`);
          } else {
            over.push(`<path class="gc-nss gc-feat" data-ids="${esc(ids)}" d="${d}" fill="none" stroke="${c}" stroke-width="2" stroke-linecap="round"/>`);
          }
          hits.push(hitPath(d, ids));
        } else if (gm.t === 'poly' && gm.pts.length > 2) {
          if (!gm.pts.some((p) => V.inside(p, 40))) continue;
          const d = polyD(V, gm.pts, true);
          if (selected) over.push(`<path class="gc-nss" d="${d}" fill="#fff" fill-opacity=".12" stroke="#fff" stroke-width="3"/>`);
          over.push(`<path class="gc-nss gc-feat" data-ids="${esc(ids)}" d="${d}" fill="${c}" fill-opacity=".28" stroke="${c}" stroke-width="1.6"/>`);
          hits.push(hitPath(d, ids, true));
        } else if (gm.t === 'circle') {
          if (!V.inside(gm.p, 80)) continue;
          const rPix = (gm.r || 0) / V.mpp;
          const pts = circlePts(gm.p, Math.max(gm.r || 0, 8 * V.mpp), 64);
          const d = polyD(V, circlePts(gm.p, gm.r || 8 * V.mpp, 64), true);
          if (selected) over.push(`<path class="gc-nss" d="${d}" fill="#fff" fill-opacity=".1" stroke="#fff" stroke-width="3"/>`);
          over.push(`<path class="gc-nss gc-feat" data-ids="${esc(ids)}" d="${d}" fill="${c}" fill-opacity=".22" stroke="${c}" stroke-width="1.5"/>`);
          hits.push(hitPath(d, ids, true));
          if (rPix < 18) {
            const [x, y] = V.xy(gm.p);
            hits.push(ns(x, y, `<circle r="16" fill="#000" opacity="0"/>`, ids, 'gc-hit'));
          }
        } else if (gm.t === 'pt') {
          if (!V.inside(gm.p)) continue;
          const [x, y] = V.xy(gm.p);
          if (n.cat === 'spot_closed') {
            over.push(ns(x, y, `<rect x="-6" y="-6" width="12" height="12" rx="2" fill="var(--gc-map)" fill-opacity=".5" stroke="${c}" stroke-width="2"/><path d="M-4,-4 L4,4 M4,-4 L-4,4" stroke="${c}" stroke-width="2"/><circle r="16" fill="#000" opacity="0"/>`, ids, 'gc-feat'));
          } else if (n.cat === 'spot_reloc') {
            over.push(ns(x, y, `<rect x="-6" y="-6" width="12" height="12" rx="2" fill="none" stroke="${c}" stroke-width="2" stroke-dasharray="3 2"/><circle r="16" fill="#000" opacity="0"/>`, ids, 'gc-feat'));
          } else if (n.cat === 'twy_closed' || n.cat === 'twy_restr') {
            over.push(ns(x, y, `<circle r="${(tw + 2).toFixed(1)}" fill="none" stroke="${c}" stroke-width="2"/><circle r="16" fill="#000" opacity="0"/>`, ids, 'gc-feat'));
          } else if (PIN_CAT[n.cat] && num[n.id] == null) {
            icons.push(typeIcon(x, y, c, n.cat, ids));
          }
        } else if (gm.t === 'rwy' && gm.pts && gm.pts.length) {
          const d = pathD(V, gm.pts);
          const w = Math.max(6, 58 / V.mpp) + 3;
          over.push(`<path class="gc-nss gc-feat" data-ids="${esc(ids)}" d="${d}" fill="none" stroke="${c}" stroke-width="${w.toFixed(1)}" stroke-linecap="butt" opacity=".55"/>`);
          if (n.cat === 'rwy_closed') over.push(`<path class="gc-nss gc-feat" data-dash="1.6 3.4" data-ids="${esc(ids)}" d="${d}" fill="none" stroke="var(--gc-hatch)" stroke-width="${(w - 2).toFixed(1)}" stroke-dasharray="${(1.6 / vs).toFixed(2)} ${(3.4 / vs).toFixed(2)}"/>`);
          hits.push(hitPath(d, ids));
        }
      }
    }
    // 灯火・ILS などのアイコン
    for (const n of list) {
      if (!ui.on) break;
      if (!['light', 'marking', 'ils'].includes(n.cat)) continue;
      const c = CAT_COLOR[n.cat] || 'var(--yellow)';
      const gps = geomPts(n, layout);
      let pt = null;
      for (const gm of gps) {
        if (gm.t === 'line' && gm.pts.some((p) => V.inside(p))) { pt = mid(gm.pts); break; }
        if (gm.t === 'pt' && V.inside(gm.p)) { pt = gm.p; break; }
        if (gm.t === 'rwy' && gm.pts && gm.pts.some((p) => V.inside(p))) { pt = gm.pts[0]; break; }
      }
      if (pt) {
        const [x, y] = V.xy(pt);
        icons.push(bulb(x, y, c, n.cat === 'marking' ? 'wrench' : n.cat === 'ils' ? 'slash' : 'bolt', n.id));
      }
    }
    // 座標系でピン番号が無いもの（広域の点）にもアイコン
    for (const n of list) {
      if (!ui.on || !PIN_CAT[n.cat] || num[n.id] != null) continue;
      const gps = geomPts(n, layout);
      let pt = null;
      for (const gm of gps) {
        if (gm.t === 'pt' && V.inside(gm.p)) { pt = gm.p; break; }
        if (gm.t === 'circle' && V.inside(gm.p, 40)) { pt = gm.p; break; }
        if ((gm.t === 'poly' || gm.t === 'line') && gm.pts && gm.pts.some((p) => V.inside(p))) { pt = mid(gm.pts); break; }
      }
      if (pt) {
        const [x, y] = V.xy(pt);
        icons.push(typeIcon(x, y, CAT_COLOR[n.cat], n.cat, n.id));
      }
    }
    // ラベル（誘導路名は全 named ref。拡大時は衝突が減る）
    const labs = labelsOf(V, layout, viewOf().s || 1);
    // pins
    const placed = [];
    for (const n of list) {
      if (!ui.on || num[n.id] == null) continue;
      const gps = geomPts(n, layout);
      let pt = null;
      for (const gm of gps) {
        if (gm.t === 'rwy' && gm.pts && gm.pts.length) { pt = gm.pts[0]; break; }
        if (gm.t === 'pt' && V.inside(gm.p, 0)) { pt = gm.p; break; }
        if (gm.t === 'circle' && V.inside(gm.p, 40)) { pt = gm.p; break; }
        if ((gm.t === 'poly' || gm.t === 'line') && gm.pts && gm.pts.some((p) => V.inside(p, 0))) { pt = mid(gm.pts); break; }
      }
      if (!pt) continue;
      let [x, y] = V.xy(pt);
      for (let k = 0; k < 24; k++) {
        let mv = false;
        for (const [px, py] of placed) {
          if (Math.hypot(px - x, py - y) < 16) {
            const ang = (x === px && y === py) ? 0.7 : Math.atan2(y - py, x - px);
            x += Math.cos(ang) * 5; y += Math.sin(ang) * 5; mv = true;
          }
        }
        if (!mv) break;
      }
      placed.push([x, y]);
      const c = CAT_COLOR[n.cat] || 'var(--red)';
      const r = (n.id === sel || (ui.hi || []).includes(n.id)) ? 9.5 : 8;
      const ring = (n.id === sel || (ui.hi || []).includes(n.id)) ? `<circle r="${r + 4}" fill="none" stroke="#fff" stroke-width="1.6" opacity=".9"/>` : '';
      pins.push(ns(x, y, `${ring}<circle r="${r}" fill="${c}" stroke="var(--gc-halo)" stroke-width="2"/><text y="3.2" text-anchor="middle" font-size="${num[n.id] < 10 ? 9.5 : 8.6}" font-weight="800" fill="#fff">${num[n.id]}</text><circle r="16" fill="#000" opacity="0"/>`, n.id, 'gc-pin'));
    }
    return { over: over.join('') + hits.join(''), marks: labs.join('') + icons.join('') + pins.join('') };
  }

  function wayLength(p) {
    let L = 0;
    for (let i = 0; i < p.length - 1; i++) L += distM(p[i], p[i + 1]);
    return L;
  }
  function alongPts(p, n) {
    const out = [];
    if (!p || p.length < 2) return out;
    const seg = [];
    let L = 0;
    for (let i = 0; i < p.length - 1; i++) { const d = distM(p[i], p[i + 1]); seg.push(d); L += d; }
    if (L < 0.5) { out.push(p[0]); return out; }
    const count = Math.max(1, n | 0);
    for (let k = 0; k < count; k++) {
      const target = ((k + 0.5) / count) * L;
      let acc = 0;
      for (let i = 0; i < p.length - 1; i++) {
        if (acc + seg[i] >= target || i === p.length - 2) {
          const u = seg[i] ? Math.max(0, Math.min(1, (target - acc) / seg[i])) : 0;
          out.push([p[i][0] + (p[i + 1][0] - p[i][0]) * u, p[i][1] + (p[i + 1][1] - p[i][1]) * u]);
          break;
        }
        acc += seg[i];
      }
    }
    return out;
  }
  function taxiCandidates(layout) {
    const o = layout.origin, sc = layout.scale;
    const out = [];
    for (const t of layout.taxiways || []) {
      if (!t.ref) continue;
      const ways = [];
      let totalL = 0, best = null, bestL = 0;
      for (const raw of t.ways || []) {
        const p = decLine(raw, o, sc);
        if (p.length < 2) continue;
        const L = wayLength(p);
        if (!L) continue;
        ways.push(p);
        totalL += L;
        if (L > bestL) { bestL = L; best = p; }
      }
      if (!ways.length) continue;
      out.push({ ref: t.ref, ways, best, L: totalL, bestL });
    }
    return out;
  }
  function lodKeep(t, mpp, showAll) {
    if (showAll) return true;
    const major = t.ref.length === 1;
    // 概観〜広域：長い幹線（1文字の誘導路）だけ
    if (mpp > 22) return major && t.L >= 80;
    if (mpp > 14) return major || t.L >= 420;
    // 中間：短い枝（H1 など）を出し始める
    if (mpp > 9) return major || t.L >= 130 || (t.ref.length === 2 && t.L >= 70);
    if (mpp > 5.5) return t.ref.length <= 2 || t.L >= 40;
    return true;
  }
  // 配置計画（検証用にも使う）。max zoom では OSM にある ref を落とさない。
  function taxiLabelPlan(V, layout, zoomS) {
    const mpp = V.mpp / (zoomS || 1);
    const showAll = (zoomS || 1) >= 7.5 || mpp <= 4.2;
    const occupied = [];
    const collide = (x, y, w) => {
      for (const b of occupied) {
        if (Math.abs(b[0] - x) < (b[2] + w) / 2 && Math.abs(b[1] - y) < 10) return true;
      }
      return false;
    };
    const perp = (p, dist) => {
      if (!p || p.length < 2) return [0, 0];
      const a = p[0], b = p[p.length - 1];
      const [x0, y0] = V.xy(a), [x1, y1] = V.xy(b);
      const dx = x1 - x0, dy = y1 - y0, L = Math.hypot(dx, dy) || 1;
      return [-dy / L * dist, dx / L * dist];
    };
    const cands = taxiCandidates(layout).filter((t) => lodKeep(t, mpp, showAll));
    cands.sort((a, b) => {
      const ma = a.ref.length === 1 ? 0 : 1, mb = b.ref.length === 1 ? 0 : 1;
      if (ma !== mb) return ma - mb;
      return b.L - a.L || a.ref.localeCompare(b.ref);
    });
    const placed = [];
    for (const t of cands) {
      const fs = t.ref.length > 2 ? 7 : (mpp < 9 ? 7.4 : 8);
      const w = t.ref.length * fs * 0.72 + 4;
      const samples = [];
      const nAlong = showAll ? 6 : (t.ref.length === 1 ? 5 : 3);
      for (const way of (t.ref.length === 1 || showAll ? t.ways : [t.best])) {
        alongPts(way, nAlong).forEach((pt) => samples.push({ pt, way }));
      }
      let pick = null;
      for (const s of samples) {
        if (!V.inside(s.pt, -2) && !showAll) continue;
        if (!V.inside(s.pt, 40) && showAll) continue;
        let [x, y] = V.xy(s.pt);
        if (!collide(x, y, w)) { pick = { x, y, fs, w, ref: t.ref }; break; }
        const [nx, ny] = perp(s.way, 9);
        if (!collide(x + nx, y + ny, w)) { pick = { x: x + nx, y: y + ny, fs, w, ref: t.ref }; break; }
        if (!collide(x - nx, y - ny, w)) { pick = { x: x - nx, y: y - ny, fs, w, ref: t.ref }; break; }
      }
      if (!pick && showAll) {
        // 最大拡大：螺旋で空いた位置を探し、それでも駄目なら中点に置く（欠落させない）
        const anchor = (t.best && V.inside(mid(t.best), 80)) ? mid(t.best) : (samples[0] ? samples[0].pt : null);
        if (anchor) {
          let [x, y] = V.xy(anchor);
          for (let k = 0; k < 48; k++) {
            const ang = k * 2.399, rad = 5 + k * 2.6;
            const xx = x + Math.cos(ang) * rad, yy = y + Math.sin(ang) * rad;
            if (!collide(xx, yy, w)) { x = xx; y = yy; break; }
          }
          pick = { x, y, fs, w, ref: t.ref };
        }
      }
      if (!pick) continue;
      occupied.push([pick.x, pick.y, pick.w]);
      placed.push(pick);
    }
    return placed;
  }
  function labelsOf(V, layout, zoomS) {
    const labs = [];
    const o = layout.origin, sc = layout.scale;
    for (const t of taxiLabelPlan(V, layout, zoomS)) {
      labs.push(ns(t.x, t.y + 2.4, `<text text-anchor="middle" font-size="${t.fs}" font-weight="700" fill="var(--gc-twylab)" stroke="var(--gc-halo)" stroke-width="2.4" paint-order="stroke">${esc(t.ref)}</text>`));
    }
    for (const r of layout.runways || []) {
      const parts = r.id.split('/');
      const p = decLine(r.pts, o, sc);
      if (p.length < 2) continue;
      for (const num of parts) {
        const thr = thrOf(layout, r.id, num) || (num === parts[0] ? p[0] : p[p.length - 1]);
        const other = thr === p[0] ? p[p.length - 1] : p[0];
        const [x, y] = V.xy(thr), [ox, oy] = V.xy(other);
        const dx = x - ox, dy = y - oy, L = Math.hypot(dx, dy) || 1;
        const lx = x + dx / L * 13, ly = y + dy / L * 13;
        labs.push(ns(lx, ly + 3.5, `<text text-anchor="middle" font-size="10" font-weight="800" fill="var(--text)" stroke="var(--gc-halo)" stroke-width="2.6" paint-order="stroke">${esc(num)}</text>`));
      }
    }
    return labs;
  }

  function bulb(x, y, c, glyph, ids) {
    let g = `<circle r="8" fill="${c}" stroke="var(--gc-halo)" stroke-width="1.6"/>`;
    if (glyph === 'bolt') g += `<path d="M1.5,-5 L-3,1 L0,1 L-1.5,5 L3,-1 L0,-1 Z" fill="var(--gc-halo)"/>`;
    else if (glyph === 'slash') g += `<path d="M-4,4 L4,-4" stroke="var(--gc-halo)" stroke-width="2"/><circle r="3.6" fill="none" stroke="var(--gc-halo)" stroke-width="1.6"/>`;
    else g += `<path d="M-4,4 L2,-2" stroke="var(--gc-halo)" stroke-width="2.2" stroke-linecap="round"/><circle cx="2.5" cy="-2.5" r="2.6" fill="none" stroke="var(--gc-halo)" stroke-width="1.6"/>`;
    g += `<circle r="16" fill="#000" opacity="0"/>`;
    return ns(x, y, g, ids, 'gc-feat gc-icon');
  }
  function typeIcon(x, y, c, cat, ids) {
    let g = `<circle r="8" fill="${c}" stroke="var(--gc-halo)" stroke-width="1.6"/>`;
    if (cat === 'obst_lgt') g += `<path d="M1.4,-4.8 L-2.8,1 L0.2,1 L-1.2,4.8 L3,-1 L0.4,-1 Z" fill="var(--gc-halo)"/>`;
    else if (cat === 'obst') g += `<path d="M0,-5 L5,4 L-5,4 Z" fill="none" stroke="var(--gc-halo)" stroke-width="1.6" stroke-linejoin="round"/>`;
    else if (cat === 'uas') g += `<circle cx="-3" cy="-3" r="1.4" fill="var(--gc-halo)"/><circle cx="3" cy="-3" r="1.4" fill="var(--gc-halo)"/><circle cx="-3" cy="3" r="1.4" fill="var(--gc-halo)"/><circle cx="3" cy="3" r="1.4" fill="var(--gc-halo)"/><rect x="-1.4" y="-1.4" width="2.8" height="2.8" fill="var(--gc-halo)"/>`;
    else if (cat === 'balloon') g += `<circle cy="-1.2" r="3.2" fill="none" stroke="var(--gc-halo)" stroke-width="1.5"/><path d="M0,2 L0,5" stroke="var(--gc-halo)" stroke-width="1.4"/>`;
    else if (cat === 'fireworks') g += `<path d="M0,-5 L0,5 M-5,0 L5,0 M-3.5,-3.5 L3.5,3.5 M3.5,-3.5 L-3.5,3.5" stroke="var(--gc-halo)" stroke-width="1.3"/>`;
    else if (cat === 'pg') g += `<path d="M-5,2 Q0,-6 5,2" fill="none" stroke="var(--gc-halo)" stroke-width="1.5"/><path d="M0,-2 L0,4" stroke="var(--gc-halo)" stroke-width="1.3"/>`;
    else if (cat === 'acro') g += `<path d="M-4,2 C-4,-5 4,-5 4,2" fill="none" stroke="var(--gc-halo)" stroke-width="1.5"/><path d="M-2,2 L4,4" stroke="var(--gc-halo)" stroke-width="1.3"/>`;
    else g += `<rect x="-3.2" y="-3.2" width="6.4" height="6.4" transform="rotate(45)" fill="none" stroke="var(--gc-halo)" stroke-width="1.5"/>`;
    g += `<circle r="16" fill="#000" opacity="0"/>`;
    return ns(x, y, g, ids, 'gc-feat gc-icon');
  }

  function idsFromEvent(e) {
    const ids = [];
    const seen = new Set();
    const stack = (typeof document.elementsFromPoint === 'function')
      ? document.elementsFromPoint(e.clientX, e.clientY)
      : [e.target];
    for (const el of stack) {
      if (!el || !el.closest) break;
      if (!el.closest('.gc-map')) break;
      if (el.closest('.gc-tools, .gc-legend, .gc-scale, .gc-attr')) continue;
      const a = el.closest('[data-ids], [data-id]');
      if (!a) continue;
      const raw = a.getAttribute('data-ids') || a.getAttribute('data-id') || '';
      raw.split(',').forEach((id) => {
        if (id && !seen.has(id)) { seen.add(id); ids.push(id); }
      });
    }
    return ids;
  }
  function applyHighlight(root) {
    const hi = ui.hi || [];
    root.querySelectorAll('.gc-row').forEach((r) => r.classList.toggle('hi', hi.includes(r.dataset.id)));
    root.querySelectorAll('.gc-ns, .gc-feat, .gc-pin, .gc-hit, [data-ids]').forEach((n) => {
      const raw = n.getAttribute('data-ids') || n.getAttribute('data-id') || '';
      const hit = raw.split(',').some((id) => hi.includes(id));
      n.classList.toggle('hi', hit);
    });
  }
  function scrollToHi(root) {
    if (!ui.hi || !ui.hi.length) return;
    for (const id of ui.hi) {
      const row = root.querySelector(`.gc-row[data-id="${CSS.escape(id)}"]`);
      if (row) { row.scrollIntoView({ block: 'nearest', behavior: 'smooth' }); return; }
    }
  }

  function bindMap(wrap, V0) {
    const svg = wrap.querySelector('.gc-svg');
    const stage = wrap.querySelector('.gc-map');
    const world = svg.querySelector('.gc-world');
    let vx = viewOf().x, vy = viewOf().y, vs = viewOf().s;
    const scaleEl = wrap.querySelector('.gc-scale');
    const apply = () => {
      if (world) world.setAttribute('transform', `translate(${vx} ${vy}) scale(${vs})`);
      const inv = 1 / vs;
      svg.querySelectorAll('.gc-ns').forEach((gEl) => {
        const x = gEl.getAttribute('data-x'), y = gEl.getAttribute('data-y');
        gEl.setAttribute('transform', `translate(${x},${y}) scale(${inv})`);
      });
      svg.querySelectorAll('[data-dash]').forEach((pEl) => {
        const parts = (pEl.dataset.dash || '').split(/\s+/).map(Number).filter((n) => Number.isFinite(n));
        if (parts.length) pEl.setAttribute('stroke-dasharray', parts.map((v) => (v / vs).toFixed(2)).join(' '));
      });
      if (scaleEl) {
        const mpp = V0.mpp / vs;
        let meters = 500, label = '500 m';
        if (mpp > 40) { meters = 1852; label = '1 NM'; }
        if (mpp > 90) { meters = 1852 * 2; label = '2 NM'; }
        if (mpp > 180) { meters = 1852 * 5; label = '5 NM'; }
        if (mpp < 6) { meters = 200; label = '200 m'; }
        const px = Math.max(18, meters / mpp);
        const i = scaleEl.querySelector('i');
        if (i) i.style.width = `${px.toFixed(0)}px`;
        const txt = scaleEl.querySelector('span');
        if (txt) txt.textContent = label;
        else scaleEl.appendChild(Object.assign(document.createElement('span'), { textContent: label }));
      }
      setView({ x: vx, y: vy, s: vs });
    };
    apply();
    const set = (x, y, s) => {
      vs = Math.max(0.55, Math.min(12, s));
      vx = x; vy = y;
      apply();
    };
    const zoomAt = (cx, cy, s2) => set(cx - (cx - vx) * (s2 / vs), cy - (cy - vy) * (s2 / vs), s2);
    wrap.querySelector('[data-a=in]').onclick = () => {
      const r = stage.getBoundingClientRect();
      zoomAt(r.width / 2, r.height / 2, vs * 1.35);
      rerender();
    };
    wrap.querySelector('[data-a=out]').onclick = () => {
      const r = stage.getBoundingClientRect();
      zoomAt(r.width / 2, r.height / 2, vs / 1.35);
      rerender();
    };
    wrap.querySelector('[data-a=fit]').onclick = () => { set(0, 0, 1); rerender(); };
    let drag = null, pointers = new Map(), pinch = null, moved = false, downAt = null;
    let wheelTimer = 0;
    stage.addEventListener('pointerdown', (e) => {
      if (e.target.closest && e.target.closest('.gc-tools, .gc-legend, .gc-scale, .gc-attr')) return;
      stage.setPointerCapture(e.pointerId);
      pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
      moved = false;
      downAt = { x: e.clientX, y: e.clientY };
      if (pointers.size === 2) {
        const [a, b] = [...pointers.values()];
        pinch = { d: Math.hypot(a.x - b.x, a.y - b.y), s: vs, x: vx, y: vy };
        drag = null;
      } else drag = { x: e.clientX - vx, y: e.clientY - vy };
    });
    stage.addEventListener('pointermove', (e) => {
      if (pointers.has(e.pointerId)) pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
      if (downAt && Math.hypot(e.clientX - downAt.x, e.clientY - downAt.y) > 8) moved = true;
      if (pinch && pointers.size === 2) {
        const [a, b] = [...pointers.values()];
        const d = Math.hypot(a.x - b.x, a.y - b.y);
        const r = stage.getBoundingClientRect();
        const cx = (a.x + b.x) / 2 - r.left, cy = (a.y + b.y) / 2 - r.top;
        const s2 = pinch.s * (d / (pinch.d || 1));
        set(cx - (cx - pinch.x) * (s2 / pinch.s), cy - (cy - pinch.y) * (s2 / pinch.s), s2);
        return;
      }
      if (drag) set(e.clientX - drag.x, e.clientY - drag.y, vs);
    });
    const up = (e) => {
      const wasPinch = !!pinch;
      pointers.delete(e.pointerId);
      if (pointers.size < 2) pinch = null;
      if (!pointers.size) {
        drag = null;
        if (wasPinch) { rerender(); return; }
        if (!moved) {
          const ids = idsFromEvent(e);
          if (ids.length) {
            ui.hi = ids;
            if (ids.length === 1) ui.sel = ids[0];
            applyHighlight(lastEl || wrap);
            scrollToHi(lastEl || wrap);
          } else {
            ui.hi = [];
            ui.sel = null;
            applyHighlight(lastEl || wrap);
            lastEl && lastEl.querySelectorAll('.gc-raw').forEach((n) => n.remove());
          }
        }
      }
    };
    stage.addEventListener('pointerup', up);
    stage.addEventListener('pointercancel', up);
    stage.addEventListener('wheel', (e) => {
      e.preventDefault();
      const r = stage.getBoundingClientRect();
      const cx = e.clientX - r.left, cy = e.clientY - r.top;
      zoomAt(cx, cy, vs * (e.deltaY < 0 ? 1.15 : 1 / 1.15));
      clearTimeout(wheelTimer);
      wheelTimer = setTimeout(() => rerender(), 180);
    }, { passive: false });
  }

  function render(el, pack, ctx) {
    lastPack = pack; lastEl = el; lastCtx = ctx;
    const airports = (ctx && ctx.airports) || [];
    const names = (ctx && ctx.names) || {};
    if (!ui.icao || !airports.includes(ui.icao)) ui.icao = airports[0] || ui.icao;
    const icao = ui.icao;
    const g = pack?.ground?.[icao];
    const chips = airports.map((i) => `<button type="button" class="chip${i === icao ? ' active' : ''}" data-icao="${esc(i)}">${esc(i)}</button>`).join('');
    const filt = (k, label, color, n) =>
      `<button type="button" class="gc-chip${ui.filter[k] ? ' on' : ''}" data-f="${k}"><b style="background:${color}"></b>${label} ${n}</button>`;

    if (!g) {
      el.innerHTML = head(chips) + `<div class="gc-msg">この空港の地上図は、このパックに入っていません。対応空港は主要国内空港（羽田・福岡・北九州・関西・伊丹・中部・新千歳・那覇・仙台など）です。次のパック更新後に表示されます。</div>`;
      bindChrome(el);
      return;
    }
    if (!g.ok) {
      el.innerHTML = head(chips) + `<div class="gc-msg">${esc(g.error || '地上図を表示できません。次の更新で再試行します。')}</div>`;
      bindChrome(el);
      return;
    }
    if (!g.layout) {
      el.innerHTML = head(chips) + `<div class="gc-msg">${esc(g.loadError || '地図データを読み込めませんでした。SETTINGS からパックを再ダウンロードしてください。')}</div>`;
      bindChrome(el);
      return;
    }

    const active = allActive(g);
    const mapped = active.filter(hasGeom);
    const unmapped = active.filter((n) => !hasGeom(n));
    const mapList = ui.on ? mapped.filter((n) => inFilter(n.cat)) : [];
    const { num, rest } = numbers(mapped);
    const counts = {
      closed: active.filter((n) => FILTER.closed.includes(n.cat)).length,
      restr: active.filter((n) => FILTER.restr.includes(n.cat)).length,
      other: active.filter((n) => FILTER.other.includes(n.cat)).length,
      obst: active.filter((n) => FILTER.obst.includes(n.cat)).length,
      activity: active.filter((n) => FILTER.activity.includes(n.cat)).length,
    };

    const W = Math.max(320, el.clientWidth || 390);
    const H = Math.min(360, Math.max(280, Math.round(W * 0.72)));
    const V0 = ui.scope === 'wide' ? fitWide(g, g.layout, mapped, W, H) : fit(g.layout, W, H);
    const photoOn = ui.photo && ui.scope === 'airport' && !!g.photoUrl;
    const layoutSvg = drawLayout(V0, g.layout, { photo: photoOn });
    const ov = overlay(V0, g, g.layout, mapList, num, ui.sel, layoutSvg.tw);
    const coast = ui.scope === 'wide' ? drawCoast(V0, g.coast) : '';
    const rings = ui.scope === 'wide' ? drawRings(V0, g.arp) + drawApOutline(V0, g.layout) : '';
    const photo = drawPhoto(V0, g);
    const vs0 = viewOf().s || 1;
    const scaleMpp = V0.mpp / vs0;
    const scalePx = (500 / scaleMpp).toFixed(0);

    const pinList = mapped.filter((n) => num[n.id] != null).sort((a, b) => num[a.id] - num[b.id]);
    const rows = pinList.map((n) => rowHtml(n, num[n.id], n.id === ui.sel || (ui.hi || []).includes(n.id))).join('');
    const otherRows = rest.map((n) => rowHtml(n, '・', n.id === ui.sel || (ui.hi || []).includes(n.id), true)).join('');
    const unRows = unmapped.map((n) => rowHtml(n, '・', n.id === ui.sel || (ui.hi || []).includes(n.id), true)).join('');

    const approxNote = mapList.some((n) => n.approx) ? '<div class="gc-note">一部の区間は誘導路名の地図データが足りないため、<strong>位置は概略</strong>です（誘導路全体の表示）。</div>' : '';
    const qNote = g.note ? `<div class="gc-note">${esc(g.note)}</div>` : '';
    const stale = g.stale ? '<div class="gc-note">地図データは前回取得分です（OpenStreetMap に一時接続できませんでした）。</div>' : '';
    const hasPhoto = !!(g.photoUrl && g.photo);
    const attr = ui.scope === 'wide'
      ? ((g.coast && g.coast.attribution) ? `${g.attribution || '© OpenStreetMap contributors'} ／ ${g.coast.attribution}` : (g.attribution || '© OpenStreetMap contributors ／ Natural Earth（海岸線）'))
      : (g.attribution || '© OpenStreetMap contributors');

    el.innerHTML = `
      ${head(chips)}
      <div class="gc-ctl">
        <nav class="chips-sub gc-scope">
          <button type="button" class="chip${ui.scope === 'airport' ? ' active' : ''}" data-scope="airport">空港</button>
          <button type="button" class="chip${ui.scope === 'wide' ? ' active' : ''}" data-scope="wide">広域</button>
        </nav>
        ${hasPhoto && ui.scope === 'airport' ? `<label class="gc-sw"><input type="checkbox" data-a="photo"${ui.photo ? ' checked' : ''}/><span>写真</span></label>` : ''}
        <label class="gc-sw"><input type="checkbox" data-a="on"${ui.on ? ' checked' : ''}/><span>NOTAM</span></label>
      </div>
      <div class="gc-ctl">
        ${filt('closed', '閉鎖', 'var(--red)', counts.closed)}
        ${filt('restr', '制限', 'var(--gc-orange)', counts.restr)}
        ${filt('other', '他', 'var(--yellow)', counts.other)}
        ${filt('obst', '障害', '#c46b2a', counts.obst)}
        ${filt('activity', '飛行', '#8b6cff', counts.activity)}
      </div>
      <div class="gc-ctl gc-time">
        <nav class="chips-sub" id="gc-time">
          <button type="button" class="chip${ui.time === 'now' ? ' active' : ''}" data-t="now">いま</button>
          <button type="button" class="chip${ui.time === 'plus3' ? ' active' : ''}" data-t="plus3">+3h</button>
          <button type="button" class="chip${ui.time === 'at' ? ' active' : ''}" data-t="at">時刻指定</button>
        </nav>
        ${ui.time === 'at' ? `<input type="datetime-local" id="gc-at" value="${esc(ui.at)}"/>` : `<span class="hint">${esc(timeLabel())}</span>`}
      </div>
      <div class="gc-map${ui.scope === 'wide' ? ' wide' : ''}${photoOn ? ' photo' : ''}" style="height:${H}px">
        <div class="gc-svg-wrap">
          <svg class="gc-svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}" xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink">
            <g class="gc-world" transform="translate(${viewOf().x} ${viewOf().y}) scale(${viewOf().s})">
              <g class="gc-geom">${photo}${coast}${rings}${layoutSvg.svg}</g>
              <g class="gc-over">${ov.over}</g>
              <g class="gc-marks">${ov.marks}</g>
            </g>
          </svg>
        </div>
        <div class="gc-tools"><button type="button" class="gc-tb" disabled>N↑</button><button type="button" class="gc-tb" data-a="in">＋</button><button type="button" class="gc-tb" data-a="out">－</button><button type="button" class="gc-tb" data-a="fit">全体</button></div>
        <div class="gc-legend">
          <span><i class="gc-hat"></i>閉鎖</span>
          <span><i class="gc-dash"></i>制限</span>
          <span><i class="gc-ic y">⚡</i>灯火</span>
          <span><i class="gc-ic obst">▲</i>障害</span>
          <span><i class="gc-ic act">✦</i>飛行</span>
        </div>
        <div class="gc-scale"><i style="width:${scalePx}px"></i><span>500 m</span></div>
        <div class="gc-attr">${esc(attr)}</div>
      </div>
      ${qNote}${stale}${approxNote}
      <div class="gc-sheet">
        <div class="gc-sh">地上NOTAM　${pinList.length}件 <span>${esc(timeLabel())} に有効（地図に置けるもの）</span></div>
        ${rows || '<div class="hint">この時刻に、地図に置ける閉鎖・制限・座標付きNOTAMはありません。</div>'}
        ${otherRows ? `<div class="gc-sh gc-sub">灯火・表示等　${rest.length}件</div>${otherRows}` : ''}
        <div class="gc-unmapped">
          <div class="gc-sh gc-sub">地図に置けないNOTAM　${unmapped.length}件</div>
          ${unRows || '<div class="hint">この時刻に、地図に置けないNOTAMはありません。</div>'}
        </div>
      </div>`;
    bindChrome(el);
    bindMap(el, V0);
    function inAirportView(item) {
      const b = g.layout.bbox;
      const pad = 0.01;
      for (const gm of geomPts(item, g.layout)) {
        const pts = gm.pts || (gm.p ? [gm.p] : []);
        if (pts.some((q) => q[0] >= b[0] - pad && q[0] <= b[2] + pad && q[1] >= b[1] - pad && q[1] <= b[3] + pad)) return true;
      }
      return false;
    }
    el.querySelectorAll('.gc-row').forEach((n) => {
      n.addEventListener('click', () => {
        const id = n.dataset.id;
        ui.sel = ui.sel === id ? null : id;
        ui.hi = [id];
        const item = (g.notams || []).find((x) => x.id === id);
        if (item && hasGeom(item) && ui.scope === 'airport' && !inAirportView(item)) {
          ui.scope = 'wide';
          ui.viewW = { x: 0, y: 0, s: 1 };
        }
        render(el, pack, ctx);
        const row = el.querySelector(`.gc-row[data-id="${CSS.escape(id)}"]`);
        if (row) row.scrollIntoView({ block: 'nearest' });
      });
    });
    applyHighlight(el);
  }

  function head(chips) {
    return `<nav class="chips-sub gc-airports">${chips}</nav>`;
  }

  function rowHtml(n, label, sel, icon) {
    const raw = (sel && ui.sel === n.id) ? `<pre class="gc-raw">${esc(n.e)}</pre>` : '';
    const approx = n.approx ? '<span class="gc-badge">位置は概略</span>' : '';
    const unres = (n.unres || []).length ? `<span class="gc-badge">一部未照合 ${esc(n.unres.join(', '))}</span>` : '';
    const title = n.summary;
    const enNote = n.ja ? '' : '<span class="gc-badge">原文のまま</span>';
    const col = CAT_COLOR[n.cat] || 'var(--text-dim)';
    const hi = (ui.hi || []).includes(n.id);
    return `<div class="gc-row${sel || hi ? ' hi' : ''}${ui.sel === n.id ? ' sel' : ''}" data-id="${esc(n.id)}">
      <div class="gc-pn" style="background:${icon ? 'transparent' : col};color:${icon ? 'var(--text-dim)' : '#fff'}">${icon ? '·' : label}</div>
      <div class="gc-rb">
        <div class="gc-rt">${esc(title)}</div>
        <div class="gc-rs"><span class="gc-id">${esc(n.id)}</span>${approx}${unres}${enNote}</div>
        <div class="gc-rw">${esc(periodText(n))}</div>
        ${raw}
      </div>
    </div>`;
  }

  function bindChrome(el) {
    el.querySelectorAll('.gc-airports .chip').forEach((b) => {
      b.onclick = () => {
        ui.icao = b.dataset.icao; ui.sel = null; ui.hi = [];
        ui.viewA = { x: 0, y: 0, s: 1 }; ui.viewW = { x: 0, y: 0, s: 1 };
        rerender();
      };
    });
    el.querySelectorAll('.gc-scope .chip').forEach((b) => {
      b.onclick = () => { ui.scope = b.dataset.scope; rerender(); };
    });
    el.querySelectorAll('.gc-chip[data-f]').forEach((b) => {
      b.onclick = () => { ui.filter[b.dataset.f] = !ui.filter[b.dataset.f]; rerender(); };
    });
    const on = el.querySelector('[data-a=on]');
    if (on) on.onchange = (e) => { ui.on = e.target.checked; rerender(); };
    const ph = el.querySelector('[data-a=photo]');
    if (ph) ph.onchange = (e) => { ui.photo = e.target.checked; rerender(); };
    el.querySelectorAll('#gc-time .chip').forEach((b) => {
      b.onclick = () => {
        ui.time = b.dataset.t;
        if (ui.time === 'at' && !ui.at) {
          const d = new Date(Date.now() + 9 * 3600000);
          ui.at = `${d.toISOString().slice(0, 16)}`;
        }
        rerender();
      };
    });
    const at = el.querySelector('#gc-at');
    if (at) at.onchange = (e) => { ui.at = e.target.value; rerender(); };
  }
  function rerender() { if (lastEl) render(lastEl, lastPack, lastCtx); }

  function labelCoverage(layout, mpp, zoomS) {
    const b = layout.bbox;
    const midLat = (b[0] + b[2]) / 2, midLon = (b[1] + b[3]) / 2;
    const hM = (b[2] - b[0]) * 110950, wM = (b[3] - b[1]) * 111320 * Math.cos(midLat * Math.PI / 180);
    const W = Math.max(240, wM / mpp + 80), H = Math.max(240, hM / mpp + 80);
    const V = new View(midLat, midLon, mpp, W, H);
    const all = taxiCandidates(layout).map((x) => x.ref);
    const placed = taxiLabelPlan(V, layout, zoomS || 1).map((x) => x.ref);
    const set = new Set(placed);
    return { all, placed, missing: all.filter((r) => !set.has(r)), mpp, zoomS: zoomS || 1, W, H };
  }
  window.FBGround = {
    render,
    setIcao(icao) { ui.icao = icao; },
    icao() { return ui.icao; },
    taxiLabelPlan,
    taxiCandidates,
    labelCoverage,
  };
})();
