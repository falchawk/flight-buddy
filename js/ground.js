// AIRPORT タブ「地上図」：OSM の滑走路・誘導路に、パックで照合済みの NOTAM を重ねる。
(function () {
  const PIN_CAT = { rwy_closed: 1, twy_closed: 1, twy_restr: 1, spot_closed: 1, spot_reloc: 1 };
  const CAT_COLOR = {
    rwy_closed: 'var(--red)', twy_closed: 'var(--red)', spot_closed: 'var(--red)',
    twy_restr: 'var(--gc-orange)', spot_reloc: 'var(--gc-orange)',
    light: 'var(--yellow)', ils: 'var(--cyan)', marking: 'var(--gc-orange)', other: 'var(--yellow)',
  };
  const FILTER = {
    closed: ['rwy_closed', 'twy_closed', 'spot_closed'],
    restr: ['twy_restr', 'spot_reloc'],
    other: ['light', 'ils', 'marking', 'other'],
  };
  const ui = {
    icao: null, on: true,
    filter: { closed: true, restr: true, other: true },
    time: 'now', at: '', sel: null,
    view: { x: 0, y: 0, s: 1 },
  };
  let lastPack = null, lastEl = null, lastCtx = null;

  function esc(s) { return String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;'); }
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
      const night = n.sched.start >= 1400 && n.sched.end <= 2200; // 23:00–07:00 JST 帯
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
    if (FILTER.closed.includes(cat)) return ui.filter.closed;
    if (FILTER.restr.includes(cat)) return ui.filter.restr;
    return ui.filter.other;
  }
  function visibleNotams(g) {
    const t = whenMs();
    return (g.notams || []).filter((n) => isActive(n, t) && inFilter(n.cat));
  }
  function numbers(list) {
    const order = ['rwy_closed', 'twy_closed', 'twy_restr', 'spot_closed', 'spot_reloc'];
    const num = {}, rest = [];
    let i = 1;
    for (const c of order) for (const n of list) if (n.cat === c) num[n.id] = i++;
    for (const n of list) if (!num[n.id]) rest.push(n);
    return { num, rest, pinCount: i - 1 };
  }

  function View(lat, lon, mpp, W, H) {
    this.lat = lat; this.lon = lon; this.mpp = mpp; this.W = W; this.H = H;
  }
  View.prototype.xy = function (p) {
    const x = (p[1] - this.lon) * 111320 * Math.cos(35.55 * Math.PI / 180) / this.mpp + this.W / 2;
    // use actual lat for meridians of this airport
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
  function fit(layout, W, H, pad) {
    pad = pad || 18;
    const b = layout.bbox;
    const midLat = (b[0] + b[2]) / 2, midLon = (b[1] + b[3]) / 2;
    const hM = (b[2] - b[0]) * 110950, wM = (b[3] - b[1]) * 111320 * Math.cos(midLat * Math.PI / 180);
    const mpp = Math.max(wM / Math.max(1, W - pad * 2), hM / Math.max(1, H - pad * 2));
    return new View(midLat, midLon, mpp, W, H);
  }

  function pathD(V, pts) { return polyD(V, pts, false); }

  function drawLayout(V, layout, o) {
    o = o || {};
    const parts = [];
    const decO = layout.origin, sc = layout.scale;
    const poly = (arr, fill, stroke, sw) => {
      for (const raw of arr || []) {
        const p = decLine(raw, decO, sc);
        if (p.length < 2 || !p.some((q) => V.inside(q, 200))) continue;
        parts.push(`<path d="${polyD(V, p, true)}" fill="${fill}" stroke="${stroke}" stroke-width="${sw}"/>`);
      }
    };
    poly(layout.aprons, 'var(--gc-apron)', 'var(--gc-apron-s)', 0.6);
    poly(layout.terminals, 'var(--gc-term)', 'var(--gc-apron-s)', 0.6);
    const tw = Math.max(2.0, 22 / V.mpp);
    const addWays = (ways, stroke, width, cap) => {
      for (const raw of ways || []) {
        const p = decLine(raw, decO, sc);
        if (p.length < 2 || !p.some((q) => V.inside(q))) continue;
        parts.push(`<path d="${pathD(V, p)}" fill="none" stroke="${stroke}" stroke-width="${width.toFixed(1)}" stroke-linecap="${cap}" stroke-linejoin="round"/>`);
      }
    };
    addWays(layout.unnamed, 'var(--gc-twy)', tw * 0.85, 'round');
    for (const t of layout.taxiways || []) addWays(t.ways, 'var(--gc-twy)', tw, 'round');
    const rw = Math.max(5, 58 / V.mpp);
    for (const r of layout.runways || []) {
      const p = decLine(r.pts, decO, sc);
      if (p.length < 2) continue;
      parts.push(`<path d="${pathD(V, p)}" fill="none" stroke="var(--gc-rwy)" stroke-width="${rw.toFixed(1)}" stroke-linecap="butt"/>`);
      parts.push(`<path d="${pathD(V, p)}" fill="none" stroke="var(--gc-rwycl)" stroke-width="0.9" stroke-dasharray="6 5" opacity=".75"/>`);
    }
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

  function overlay(V, g, layout, list, num, sel, tw, rw) {
    const o = layout.origin, sc = layout.scale;
    const over = [], icons = [], pins = [];
    const geomPts = (n) => {
      const out = [];
      for (const gm of n.geoms || []) {
        if (gm.t === 'line') out.push({ t: 'line', pts: decLine(gm.pts, o, sc) });
        else if (gm.t === 'pt') out.push({ t: 'pt', p: decPt(gm.p, o, sc) });
        else if (gm.t === 'rwy') out.push({ t: 'rwy', id: gm.id, label: gm.label, pts: rwyPts(layout, gm.id) });
      }
      return out;
    };
    for (const n of list) {
      if (!ui.on) break;
      const c = CAT_COLOR[n.cat] || 'var(--yellow)';
      const selected = n.id === sel;
      for (const gm of geomPts(n)) {
        if (gm.t === 'line' && gm.pts.length > 1) {
          if (!gm.pts.some((p) => V.inside(p))) continue;
          const d = pathD(V, gm.pts);
          if (n.cat === 'twy_closed' || n.cat === 'twy_restr') {
            const w = tw + 2.4;
            if (selected) over.push(`<path d="${d}" fill="none" stroke="#fff" stroke-width="${w + 4}" stroke-linecap="round" opacity=".55"/>`);
            over.push(`<path d="${d}" fill="none" stroke="${c}" stroke-width="${w.toFixed(1)}" stroke-linecap="round" stroke-linejoin="round"/>`);
            if (n.cat === 'twy_closed') over.push(`<path d="${d}" fill="none" stroke="var(--gc-hatch)" stroke-width="${(w - 1).toFixed(1)}" stroke-dasharray="1.6 3.4" opacity=".85"/>`);
            else over.push(`<path d="${d}" fill="none" stroke="var(--gc-hatch)" stroke-width="${(w - 1.4).toFixed(1)}" stroke-dasharray="4 4" opacity=".7"/>`);
          } else if (n.cat === 'light' || n.cat === 'marking' || n.cat === 'ils') {
            over.push(`<path d="${d}" fill="none" stroke="${c}" stroke-width="2" stroke-dasharray=".1 3.6" stroke-linecap="round"/>`);
          }
        } else if (gm.t === 'pt') {
          if (!V.inside(gm.p)) continue;
          const [x, y] = V.xy(gm.p);
          if (n.cat === 'spot_closed') {
            over.push(`<g transform="translate(${x.toFixed(1)},${y.toFixed(1)})"><rect x="-6" y="-6" width="12" height="12" rx="2" fill="var(--gc-map)" fill-opacity=".5" stroke="${c}" stroke-width="2"/><path d="M-4,-4 L4,4 M4,-4 L-4,4" stroke="${c}" stroke-width="2"/></g>`);
          } else if (n.cat === 'spot_reloc') {
            over.push(`<g transform="translate(${x.toFixed(1)},${y.toFixed(1)})"><rect x="-6" y="-6" width="12" height="12" rx="2" fill="none" stroke="${c}" stroke-width="2" stroke-dasharray="3 2"/></g>`);
          } else if (n.cat === 'twy_closed' || n.cat === 'twy_restr') {
            over.push(`<circle cx="${x.toFixed(1)}" cy="${y.toFixed(1)}" r="${(tw + 2).toFixed(1)}" fill="none" stroke="${c}" stroke-width="2"/>`);
          }
        } else if (gm.t === 'rwy' && gm.pts.length > 1) {
          const d = pathD(V, gm.pts);
          if (n.cat === 'rwy_closed') {
            if (selected) over.push(`<path d="${d}" fill="none" stroke="#fff" stroke-width="${rw + 6}" opacity=".5"/>`);
            over.push(`<path d="${d}" fill="none" stroke="${c}" stroke-width="${(rw + 1.5).toFixed(1)}" opacity=".95"/>`);
            over.push(`<path d="${d}" fill="none" stroke="var(--gc-hatch)" stroke-width="${rw}" stroke-dasharray="2 5" opacity=".85"/>`);
            for (const e of [gm.pts[0], gm.pts[gm.pts.length - 1]]) {
              const [x, y] = V.xy(e);
              icons.push(`<g transform="translate(${x.toFixed(1)},${y.toFixed(1)})"><path d="M-6,-6 L6,6 M6,-6 L-6,6" stroke="#fff" stroke-width="5.2" stroke-linecap="round"/><path d="M-6,-6 L6,6 M6,-6 L-6,6" stroke="${c}" stroke-width="3" stroke-linecap="round"/></g>`);
            }
          } else if (n.cat === 'ils' || n.cat === 'light' || n.cat === 'marking') {
            const lab = gm.label || (gm.id || '').split('/')[0];
            const p = (lab && !String(lab).includes('/')) ? (thrOf(layout, gm.id, lab) || mid(gm.pts)) : mid(gm.pts);
            const [x, y] = V.xy(p);
            const glyph = n.cat === 'ils' ? 'slash' : n.cat === 'marking' ? 'wrench' : 'bolt';
            icons.push(bulb(x, y, c, glyph));
          }
        }
      }
      if ((n.cat === 'light' || n.cat === 'marking' || n.cat === 'ils' || n.cat === 'other') && !(n.geoms || []).some((gm) => gm.t === 'rwy')) {
        const gps = geomPts(n);
        let pt = null;
        for (const gm of gps) {
          if (gm.t === 'line' && gm.pts.some((p) => V.inside(p))) { pt = mid(gm.pts); break; }
          if (gm.t === 'pt' && V.inside(gm.p)) { pt = gm.p; break; }
        }
        if (pt) {
          const [x, y] = V.xy(pt);
          icons.push(bulb(x, y, c, n.cat === 'marking' ? 'wrench' : n.cat === 'ils' ? 'slash' : 'bolt'));
        }
      }
    }
    // labels
    const labs = [];
    for (const t of layout.taxiways || []) {
      if (!t.ref || t.ref.length > 3) continue;
      let best = null, bestL = 0;
      for (const raw of t.ways) {
        const p = decLine(raw, o, sc);
        const L = (() => { let s = 0; for (let i = 0; i < p.length - 1; i++) s += distM(p[i], p[i + 1]); return s; })();
        if (L > bestL) { bestL = L; best = p; }
      }
      if (!best || bestL < 55) continue;
      const m = mid(best);
      if (!V.inside(m, -4)) continue;
      if (V.mpp > 10 && t.ref.length > 1) continue;
      const [x, y] = V.xy(m);
      labs.push(`<text x="${x.toFixed(1)}" y="${(y + 2.4).toFixed(1)}" text-anchor="middle" font-size="${V.mpp < 9 ? 7.2 : 8}" font-weight="700" fill="var(--gc-twylab)" stroke="var(--gc-halo)" stroke-width="2.2" paint-order="stroke">${esc(t.ref)}</text>`);
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
        labs.push(`<text x="${lx.toFixed(1)}" y="${(ly + 3.5).toFixed(1)}" text-anchor="middle" font-size="10" font-weight="800" fill="var(--text)" stroke="var(--gc-halo)" stroke-width="2.6" paint-order="stroke">${esc(num)}</text>`);
      }
    }
    // pins
    const placed = [];
    for (const n of list) {
      if (!ui.on || num[n.id] == null) continue;
      const gps = geomPts(n);
      let pt = null;
      for (const gm of gps) {
        if (gm.t === 'rwy' && gm.pts && gm.pts.length) { pt = gm.pts[0]; break; }
        if (gm.t === 'pt' && V.inside(gm.p, 0)) { pt = gm.p; break; }
        if (gm.t === 'line' && gm.pts && gm.pts.some((p) => V.inside(p, 0))) { pt = mid(gm.pts); break; }
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
      const r = n.id === sel ? 9.5 : 8;
      const ring = n.id === sel ? `<circle r="${r + 4}" fill="none" stroke="#fff" stroke-width="1.6" opacity=".9"/>` : '';
      pins.push(`<g class="gc-pin" data-id="${esc(n.id)}" transform="translate(${x.toFixed(1)},${y.toFixed(1)})" style="cursor:pointer">${ring}<circle r="${r}" fill="${c}" stroke="var(--gc-halo)" stroke-width="2"/><text y="3.2" text-anchor="middle" font-size="${num[n.id] < 10 ? 9.5 : 8.6}" font-weight="800" fill="#fff">${num[n.id]}</text></g>`);
    }
    return over.join('') + labs.join('') + icons.join('') + pins.join('');
  }

  function bulb(x, y, c, glyph) {
    let g = `<g transform="translate(${x.toFixed(1)},${y.toFixed(1)})"><circle r="8" fill="${c}" stroke="var(--gc-halo)" stroke-width="1.6"/>`;
    if (glyph === 'bolt') g += `<path d="M1.5,-5 L-3,1 L0,1 L-1.5,5 L3,-1 L0,-1 Z" fill="var(--gc-halo)"/>`;
    else if (glyph === 'slash') g += `<path d="M-4,4 L4,-4" stroke="var(--gc-halo)" stroke-width="2"/><circle r="3.6" fill="none" stroke="var(--gc-halo)" stroke-width="1.6"/>`;
    else g += `<path d="M-4,4 L2,-2" stroke="var(--gc-halo)" stroke-width="2.2" stroke-linecap="round"/><circle cx="2.5" cy="-2.5" r="2.6" fill="none" stroke="var(--gc-halo)" stroke-width="1.6"/>`;
    return g + '</g>';
  }

  function bindMap(wrap, base, layout, redraw) {
    const svg = wrap.querySelector('.gc-svg');
    const stage = wrap.querySelector('.gc-map');
    let vx = ui.view.x, vy = ui.view.y, vs = ui.view.s;
    const apply = () => { svg.style.transform = `translate(${vx}px,${vy}px) scale(${vs})`; svg.style.transformOrigin = '0 0'; };
    apply();
    const set = (x, y, s) => {
      vs = Math.max(0.6, Math.min(8, s));
      vx = x; vy = y;
      ui.view = { x: vx, y: vy, s: vs };
      apply();
    };
    wrap.querySelector('[data-a=in]').onclick = () => {
      const r = stage.getBoundingClientRect();
      const cx = r.width / 2, cy = r.height / 2;
      const s2 = vs * 1.35;
      set(cx - (cx - vx) * (s2 / vs), cy - (cy - vy) * (s2 / vs), s2);
    };
    wrap.querySelector('[data-a=out]').onclick = () => {
      const r = stage.getBoundingClientRect();
      const cx = r.width / 2, cy = r.height / 2;
      const s2 = vs / 1.35;
      set(cx - (cx - vx) * (s2 / vs), cy - (cy - vy) * (s2 / vs), s2);
    };
    wrap.querySelector('[data-a=fit]').onclick = () => { set(0, 0, 1); };
    let drag = null, pointers = new Map(), pinch = null;
    stage.addEventListener('pointerdown', (e) => {
      stage.setPointerCapture(e.pointerId);
      pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
      if (pointers.size === 2) {
        const [a, b] = [...pointers.values()];
        pinch = { d: Math.hypot(a.x - b.x, a.y - b.y), s: vs, x: vx, y: vy, cx: (a.x + b.x) / 2, cy: (a.y + b.y) / 2 };
        drag = null;
      } else drag = { x: e.clientX - vx, y: e.clientY - vy };
    });
    stage.addEventListener('pointermove', (e) => {
      if (pointers.has(e.pointerId)) pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
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
    const up = (e) => { pointers.delete(e.pointerId); if (pointers.size < 2) pinch = null; if (!pointers.size) drag = null; };
    stage.addEventListener('pointerup', up);
    stage.addEventListener('pointercancel', up);
    stage.addEventListener('wheel', (e) => {
      e.preventDefault();
      const r = stage.getBoundingClientRect();
      const cx = e.clientX - r.left, cy = e.clientY - r.top;
      const s2 = vs * (e.deltaY < 0 ? 1.15 : 1 / 1.15);
      set(cx - (cx - vx) * (s2 / vs), cy - (cy - vy) * (s2 / vs), s2);
    }, { passive: false });
  }

  function render(el, pack, ctx) {
    lastPack = pack; lastEl = el; lastCtx = ctx;
    const airports = (ctx && ctx.airports) || [];
    const names = (ctx && ctx.names) || {};
    if (!ui.icao || !airports.includes(ui.icao)) ui.icao = airports[0] || ui.icao;
    const icao = ui.icao;
    const g = pack?.ground?.[icao];
    const apName = (i) => names[i] || i;

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

    const allActive = (g.notams || []).filter((n) => isActive(n, whenMs()));
    const list = visibleNotams(g);
    const { num, rest, pinCount } = numbers(list);
    const counts = {
      closed: allActive.filter((n) => FILTER.closed.includes(n.cat)).length,
      restr: allActive.filter((n) => FILTER.restr.includes(n.cat)).length,
      other: allActive.filter((n) => FILTER.other.includes(n.cat)).length,
    };

    const W = Math.max(320, el.clientWidth || 390);
    const H = Math.min(360, Math.max(280, Math.round(W * 0.72)));
    const V0 = fit(g.layout, W, H);
    const layoutSvg = drawLayout(V0, g.layout);
    const over = overlay(V0, g, g.layout, ui.on ? list : [], num, ui.sel, layoutSvg.tw, layoutSvg.rw);
    const scalePx = (500 / V0.mpp).toFixed(0);

    const pinList = list.filter((n) => num[n.id] != null).sort((a, b) => num[a.id] - num[b.id]);
    const rows = pinList.map((n) => rowHtml(n, num[n.id], n.id === ui.sel)).join('');
    const more = rest.length ? `<button type="button" class="gc-more" data-a="others">ほか灯火・表示等 ${rest.length}件${ui.filter.other ? '' : '（非表示）'} ▸</button>` : '';
    const others = (ui.sel && rest.some((n) => n.id === ui.sel) ? rest : []).concat([]);
    const otherRows = rest.map((n) => rowHtml(n, '・', n.id === ui.sel, true)).join('');

    const approxNote = list.some((n) => n.approx) ? '<div class="gc-note">一部の区間は誘導路名の地図データが足りないため、<strong>位置は概略</strong>です（誘導路全体の表示）。</div>' : '';
    const qNote = g.note ? `<div class="gc-note">${esc(g.note)}</div>` : '';
    const stale = g.stale ? '<div class="gc-note">地図データは前回取得分です（OpenStreetMap に一時接続できませんでした）。</div>' : '';

    el.innerHTML = `
      ${head(chips)}
      <div class="gc-ctl">
        <label class="gc-sw"><input type="checkbox" data-a="on"${ui.on ? ' checked' : ''}/><span>NOTAM</span></label>
        ${filt('closed', '閉鎖', 'var(--red)', counts.closed)}
        ${filt('restr', '制限', 'var(--gc-orange)', counts.restr)}
        ${filt('other', '他', 'var(--yellow)', counts.other)}
      </div>
      <div class="gc-ctl gc-time">
        <nav class="chips-sub" id="gc-time">
          <button type="button" class="chip${ui.time === 'now' ? ' active' : ''}" data-t="now">いま</button>
          <button type="button" class="chip${ui.time === 'plus3' ? ' active' : ''}" data-t="plus3">+3h</button>
          <button type="button" class="chip${ui.time === 'at' ? ' active' : ''}" data-t="at">時刻指定</button>
        </nav>
        ${ui.time === 'at' ? `<input type="datetime-local" id="gc-at" value="${esc(ui.at)}"/>` : `<span class="hint">${esc(timeLabel())}</span>`}
      </div>
      <div class="gc-map" style="height:${H}px">
        <div class="gc-svg-wrap">
          <svg class="gc-svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}" xmlns="http://www.w3.org/2000/svg">${layoutSvg.svg}${over}</svg>
        </div>
        <div class="gc-tools"><button type="button" class="gc-tb" disabled>N↑</button><button type="button" class="gc-tb" data-a="in">＋</button><button type="button" class="gc-tb" data-a="out">－</button><button type="button" class="gc-tb" data-a="fit">全体</button></div>
        <div class="gc-legend">
          <span><i class="gc-hat"></i>閉鎖</span>
          <span><i class="gc-dash"></i>制限・工事</span>
          <span><i class="gc-ic y">⚡</i>灯火等U/S</span>
          <span><i class="gc-ic c">∅</i>ILS等</span>
          <span><i class="gc-ic o">🔧</i>標示</span>
        </div>
        <div class="gc-scale"><i style="width:${scalePx}px"></i>500 m</div>
        <div class="gc-attr">${esc(g.attribution || '© OpenStreetMap contributors')}</div>
      </div>
      ${qNote}${stale}${approxNote}
      <div class="gc-sheet">
        <div class="gc-sh">地上NOTAM　${pinCount}件 <span>${esc(timeLabel())} に有効</span></div>
        ${rows || '<div class="hint">この時刻に有効な、地図に置ける閉鎖・制限はありません。</div>'}
        ${more}
        <div class="gc-others" ${rest.length && ui.filter.other ? '' : 'hidden'}>${otherRows}</div>
      </div>`;
    bindChrome(el);
    bindMap(el, V0, g.layout);
    el.querySelectorAll('.gc-pin, .gc-row').forEach((n) => {
      n.addEventListener('click', (e) => {
        const id = n.dataset.id;
        ui.sel = ui.sel === id ? null : id;
        render(el, pack, ctx);
        const row = el.querySelector(`.gc-row[data-id="${CSS.escape(id)}"]`);
        if (row) row.scrollIntoView({ block: 'nearest' });
      });
    });
  }

  function head(chips) {
    return `<nav class="chips-sub gc-airports">${chips}</nav>`;
  }

  function rowHtml(n, label, sel, icon) {
    const raw = sel ? `<pre class="gc-raw">${esc(n.e)}</pre>` : '';
    const approx = n.approx ? '<span class="gc-badge">位置は概略</span>' : '';
    const unres = (n.unres || []).length ? `<span class="gc-badge">一部未照合 ${esc(n.unres.join(', '))}</span>` : '';
    const title = n.ja ? n.summary : n.summary;
    const enNote = n.ja ? '' : '<span class="gc-badge">原文のまま</span>';
    const col = CAT_COLOR[n.cat] || 'var(--text-dim)';
    return `<div class="gc-row${sel ? ' sel' : ''}" data-id="${esc(n.id)}">
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
      b.onclick = () => { ui.icao = b.dataset.icao; ui.sel = null; ui.view = { x: 0, y: 0, s: 1 }; rerender(); };
    });
    el.querySelectorAll('.gc-chip[data-f]').forEach((b) => {
      b.onclick = () => { ui.filter[b.dataset.f] = !ui.filter[b.dataset.f]; rerender(); };
    });
    const on = el.querySelector('[data-a=on]');
    if (on) on.onchange = (e) => { ui.on = e.target.checked; rerender(); };
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
    const more = el.querySelector('[data-a=others]');
    if (more) more.onclick = () => {
      const box = el.querySelector('.gc-others');
      if (box) box.hidden = !box.hidden;
    };
  }
  function rerender() { if (lastEl) render(lastEl, lastPack, lastCtx); }

  window.FBGround = {
    render,
    setIcao(icao) { ui.icao = icao; },
    icao() { return ui.icao; },
  };
})();
