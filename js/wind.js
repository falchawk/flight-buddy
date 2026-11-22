// WIND（Wind Limitation）。滑走路ごとに「どの風向から何ktまで」を1つの範囲で表示（背風・横風を分けない）。完全オフライン。
// 主たる出典は Applicable Performance Table / Wind Component Table REV6（値と印は表のとおり）。AOM と食い違えば AOM が優先。
// ほかの数値も SFJ 規程類（AOM REV30 / OM REV144 / OEN 050 REV1 / OEN 104 ISSUE 04/DEC/2025）で確認済みのものだけ。推測値は入れない。
(function () {
  const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const REV = { aom: 'AOM REV30', om: 'OM REV144', oen050: 'OEN 050 REV1', oen104: 'OEN 104 ISSUE 04/DEC/2025' };

  const WCT = {
    ref: 'Applicable Performance Table / Wind Component Table REV6（10/SEP/2026）',
    // 行＝機首からの風の角度 0〜180°（10°ごと・左右同じ）。値は許容風速 kt（gust 含む）。印は表のとおり
    // 列：RWYCC 6 DRY / 5 GOOD / 4 GOOD-MED / 3 MED / 2 MED-POOR / 1 POOR（着陸はさらに CAT I(1) RVR/CMV<1200m・CAT II/Autoland）
    TO_NEO: [
      ['*80', '*80', '*80', '*80', '*80', '*80'],  // 0°
      ['*80', '*80', '*80', '*80', '*80', '*80'],  // 10°
      ['*80', '*80', '*80', '73', '58', '43'],  // 20°
      ['76', '58', '58', '50', '40', '30'],  // 30°
      ['59', '45', '45', '38', '31', '23'],  // 40°
      ['49', '37', '37', '32', '26', '19'],  // 50°
      ['43', '33', '33', '28', '23', '17'],  // 60°
      ['40', '30', '30', '26', '21', '15'],  // 70°
      ['38', '29', '29', '25', '20', '15'],  // 80°
      ['38', '29', '29', '25', '20', '15'],  // 90°
      ['E31', '29', '29', '25', '20', '15'],  // 100°
      ['E28', 'E28', 'E28', '26', '21', '15'],  // 110°
      ['E25', 'E25', 'E25', 'E25', '23', '17'],  // 120°
      ['T23', 'T23', 'T23', 'T23', 'T23', '19'],  // 130°
      ['T19', 'T19', 'T19', 'T19', 'T19', 'T19'],  // 140°
      ['T17', 'T17', 'T17', 'T17', 'T17', 'T17'],  // 150°
      ['T15', 'T15', 'T15', 'T15', 'T15', 'T15'],  // 160°
      ['T15', 'T15', 'T15', 'T15', 'T15', 'T15'],  // 170°
      ['T15', 'T15', 'T15', 'T15', 'T15', 'T15'],  // 180°
    ],
    TO_CEO: [
      ['*80', '*80', '*80', '*80', '*80', '*80'],  // 0°
      ['*80', '*80', '*80', '*80', '*80', '*80'],  // 10°
      ['*80', '*80', '*80', '73', '58', '43'],  // 20°
      ['76', '58', '58', '50', '40', '30'],  // 30°
      ['59', '45', '45', '38', '31', '23'],  // 40°
      ['49', '37', '37', '32', '26', '19'],  // 50°
      ['43', '33', '33', '28', '23', '17'],  // 60°
      ['40', '30', '30', '26', '21', '15'],  // 70°
      ['38', '29', '29', '25', '20', '15'],  // 80°
      ['38', '29', '29', '25', '20', '15'],  // 90°
      ['38', '29', '29', '25', '20', '15'],  // 100°
      ['40', '30', '30', '26', '21', '15'],  // 110°
      ['T30', 'T30', 'T30', '28', '23', '17'],  // 120°
      ['T23', 'T23', 'T23', 'T23', 'T23', '19'],  // 130°
      ['T19', 'T19', 'T19', 'T19', 'T19', 'T19'],  // 140°
      ['T17', 'T17', 'T17', 'T17', 'T17', 'T17'],  // 150°
      ['T15', 'T15', 'T15', 'T15', 'T15', 'T15'],  // 160°
      ['T15', 'T15', 'T15', 'T15', 'T15', 'T15'],  // 170°
      ['T15', 'T15', 'T15', 'T15', 'T15', 'T15'],  // 180°
    ],
    LDG: [
      ['*80', '*80', '*80', '*80', '*80', '*80', '*80', 'H30'],  // 0°
      ['*80', '*80', '*80', '*80', '*80', '*80', '57', 'H30'],  // 10°
      ['*80', '*80', '*80', '73', '58', '43', '29', '29'],  // 20°
      ['76', '58', '58', '50', '40', '30', '20', '20'],  // 30°
      ['59', '45', '45', '38', '31', '23', '15', '15'],  // 40°
      ['49', '37', '37', '32', '26', '19', '13', '13'],  // 50°
      ['43', '33', '33', '28', '23', '17', '11', '11'],  // 60°
      ['40', '30', '30', '26', '21', '15', '10', '10'],  // 70°
      ['38', '29', '29', '25', '20', '15', '10', '10'],  // 80°
      ['38', '29', '29', '25', '20', '15', '10', '10'],  // 90°
      ['38', '29', '29', '25', '20', '15', '10', '10'],  // 100°
      ['40', '30', '30', '26', '21', '15', '10', '10'],  // 110°
      ['T30', 'T30', 'T30', '28', '23', '17', '11', '11'],  // 120°
      ['T23', 'T23', 'T23', 'T23', 'T23', '19', '13', '13'],  // 130°
      ['T19', 'T19', 'T19', 'T19', 'T19', 'T19', '15', 'T13'],  // 140°
      ['T17', 'T17', 'T17', 'T17', 'T17', 'T17', 'T17', 'T11'],  // 150°
      ['T15', 'T15', 'T15', 'T15', 'T15', 'T15', 'T15', 'T10'],  // 160°
      ['T15', 'T15', 'T15', 'T15', 'T15', 'T15', 'T15', 'T10'],  // 170°
      ['T15', 'T15', 'T15', 'T15', 'T15', 'T15', 'T15', 'T10'],  // 180°
    ],
  };
  // 印：* 制限なし（80 と表示）／ T 背風制限（15kt、CAT II/Autoland は 10kt）／ E エンジン制限 ／ H 向かい風 30kt 制限
  const MARKS = {
    '*': { label: '制限なし（80 と表示）', kind: 'none' },
    T: { label: '背風制限（15kt・CAT II/Autoland は 10kt）', kind: 'afm' },
    E: { label: 'エンジン制限', kind: 'eng' },
    H: { label: '向かい風 30kt 制限', kind: 'afm' },
    F: { label: '副操縦士操縦の条件からアプリで計算', kind: 'app' },
    '': { label: '横風制限（RCAM・会社の最大値）', kind: 'company' },
  };
  const COLS = { 6: 0, 5: 1, 4: 2, 3: 3, 2: 4, 1: 5, cat1: 6, cat2al: 7 };
  const COL_LABEL = { 6: 'RWYCC 6 DRY', 5: 'RWYCC 5 GOOD', 4: 'RWYCC 4 GOOD-MED', 3: 'RWYCC 3 MED', 2: 'RWYCC 2 MED-POOR', 1: 'RWYCC 1 POOR', cat1: 'CAT I(1) RVR/CMV<1200m', cat2al: 'CAT II/Autoland' };
  const RWYCC = { 6: '6 DRY', 5: '5 GOOD（WET 3mm以下 等）', 4: '4 GOOD TO MEDIUM', 3: '3 MEDIUM', 2: '2 MEDIUM TO POOR', 1: '1 POOR', 0: '0 LESS THAN POOR（離着陸不可）' };
  // 副操縦士（右席）が離着陸を操縦する場合（機長が誰であっても）。表には含まれないのでアプリで計算
  const FO = { xwFactor: 0.5, tw: 10, rwycc: [6, 5], ref: `${REV.om} 8-11-1(3)②` };
  const REFS = { rcam: `${REV.aom} LIM-AG-OPS RCAM`, tw: `${REV.aom} LIM-AG-OPS`, afs: `${REV.aom} LIM-AFS`, cat1: `${REV.om} 6-4`, cat2: `${REV.om} 6-5`, neoTo: REV.oen050 };

  const PILOTS = [
    { id: 'cap', label: '機長操縦' },
    { id: 'fo', label: '副操縦士操縦', sub: '右席' },
    { id: 'aom', label: '査察・教官操縦', sub: '右席／左席習熟中' },
  ];
  const TYPES = [{ id: 'ceo', label: 'A320ceo', sub: 'JA07MC–JA27MC' }, { id: 'neo', label: 'A320neo', sub: 'JA28MC〜' }];
  const parseCell = (s) => { const m = String(s).match(/^([*TEH]?)(\d+)$/); return { mark: m[1], v: Number(m[2]), text: String(s), noLimit: m[1] === '*' }; };
  const fold = (th) => { const a = Math.abs((((th % 360) + 540) % 360) - 180); return a; }; // 0〜180
  function geom(xw, tw, a) { const t = (a * Math.PI) / 180, s = Math.abs(Math.sin(t)), c = Math.cos(t); let v = Infinity; if (s > 1e-9) v = Math.min(v, xw / s); if (c < -1e-9) v = Math.min(v, tw / -c); return v; }

  // 選択 → 使う列と条件
  function compute(sel) {
    const r = { permitted: true, reasons: [], cols: [], fo: null, notes: [] };
    if (!RWYCC[sel.rwycc] || Number(sel.rwycc) === 0) { r.permitted = false; r.reasons.push(`RWYCC 0：離着陸不可（${REFS.rcam}）`); }
    if (sel.pilot === 'fo' && !FO.rwycc.includes(Number(sel.rwycc))) { r.permitted = false; r.reasons.push(`副操縦士操縦は DRY / WET のみ（${FO.ref}）`); }
    if (!r.permitted) return r;
    r.table = sel.phase === 'LDG' ? WCT.LDG : sel.type === 'neo' ? WCT.TO_NEO : WCT.TO_CEO;
    r.tableName = sel.phase === 'LDG' ? 'Landing（ceo・neo 共通）' : sel.type === 'neo' ? 'Takeoff NEO（JA28MC〜）' : 'Takeoff CEO';
    r.cols.push(String(sel.rwycc));
    if (sel.phase === 'LDG') {
      if (sel.appr === 'cat1low') r.cols.push('cat1');
      if (sel.appr === 'cat2' || sel.autoland) r.cols.push('cat2al');
    }
    if (sel.pilot === 'fo') {
      const xw90 = parseCell(r.table[9][COLS[sel.rwycc]]).v;
      r.fo = { xw: xw90 * FO.xwFactor, tw: FO.tw, xw90 };
    }
    return r;
  }
  // 表の行（10°ごと）の値。複数の列・副操縦士条件のうち最も厳しいもの
  function rowCell(lim, row) {
    let best = null;
    for (const c of lim.cols) { const cell = parseCell(lim.table[row][COLS[c]]); cell.col = c; if (!best || cell.v < best.v) best = cell; }
    if (lim.fo) { const g = Math.floor(geom(lim.fo.xw, lim.fo.tw, row * 10) + 1e-9); if (g < best.v) best = { mark: 'F', v: g, text: `F${g}`, col: 'fo' }; }
    return best;
  }
  // 任意の角度：10°の行ならその値、行の間は両隣の厳しい方（アプリ独自・安全側）
  function cellAt(lim, th) {
    const a = fold(th), lo = Math.floor(a / 10 + 1e-9), hi = Math.ceil(a / 10 - 1e-9);
    const c1 = rowCell(lim, lo), c2 = rowCell(lim, Math.min(hi, 18));
    let c = c2.v < c1.v ? { ...c2 } : { ...c1 };
    c.between = lo !== hi; c.rows = c.between ? [lo * 10, hi * 10] : [lo * 10];
    if (lim.fo && c.between) { const g = Math.floor(geom(lim.fo.xw, lim.fo.tw, a) + 1e-9); if (g < c.v) c = { mark: 'F', v: g, text: `F${g}`, col: 'fo', between: true, rows: c.rows }; }
    return c;
  }
  const vmax = (lim, th) => (lim.permitted ? cellAt(lim, th).v : 0);
  const norm = (d) => ((d % 360) + 360) % 360;
  const d3 = (d) => String(Math.round(norm(d)) || 360).padStart(3, '0');

  // ---------------------------------------------------------------- 空港・滑走路データ（SWIM AIP AD 2.12 の真方位＋AD 2.2 の磁気偏差）
  function magVar(prof) {
    const mv = prof?.swim?.aip?.magvar;
    if (mv && mv.deg != null) return { deg: Number(mv.deg) * (mv.dir === 'E' ? 1 : -1), text: `${mv.deg}°${mv.dir}${mv.year ? `（${mv.year}）` : ''}`, src: 'SWIM AIP AD 2.2' };
    const m = String(prof?.magdec || '').match(/^(\d+(?:\.\d+)?)\s*([EW])$/);
    if (m) return { deg: Number(m[1]) * (m[2] === 'E' ? 1 : -1), text: `${m[1]}°${m[2]}`, src: '参考 NOAA' };
    return null;
  }
  // 戻り値: [{id, trueBrg, mag, lengthM, widthM, src}]  mag = 真方位 − 偏差（東偏が＋）
  function runways(prof) {
    const mv = magVar(prof); if (!mv) return [];
    const aip = prof?.swim?.aip?.runways;
    if (aip?.length) return aip.filter((r) => r.trueBrg != null).map((r) => ({ id: r.id, trueBrg: Number(r.trueBrg), mag: norm(Number(r.trueBrg) - mv.deg), lengthM: r.lengthM, widthM: r.widthM, src: 'SWIM AIP AD 2.12' }));
    const out = [];
    for (const r of prof?.runways || []) {
      if (r.alignment == null) continue; const [a, b] = String(r.id).split('/'); const dim = String(r.dimensionFt || '').match(/(\d+)x(\d+)/);
      const lm = dim ? Math.round(dim[1] * 0.3048) : null, wm = dim ? Math.round(dim[2] * 0.3048) : null;
      if (a) out.push({ id: a, trueBrg: Number(r.alignment), mag: norm(r.alignment - mv.deg), lengthM: lm, widthM: wm, src: '参考 NOAA' });
      if (b) out.push({ id: b, trueBrg: norm(Number(r.alignment) + 180), mag: norm(r.alignment + 180 - mv.deg), lengthM: lm, widthM: wm, src: '参考 NOAA' });
    }
    return out;
  }
  // METAR の風（真方位）。dddff(Gff)KT / VRB / dddVddd / MPS
  function parseMetarWind(raw) {
    const s = String(raw || '').replace(/\s+/g, ' ');
    const m = s.match(/\b(\d{3}|VRB)(\d{2,3})(?:G(\d{2,3}))?(KT|MPS)\b/); if (!m) return null;
    const k = m[4] === 'MPS' ? 1.94384 : 1;
    const w = { dir: m[1] === 'VRB' ? 'VRB' : Number(m[1]), spd: Math.round(Number(m[2]) * k), gust: m[3] ? Math.round(Number(m[3]) * k) : null, raw: m[0] };
    const v = s.slice(m.index + m[0].length).match(/^\s(\d{3})V(\d{3})\b/); if (v) { w.vfrom = Number(v[1]); w.vto = Number(v[2]); w.raw += ` ${v[1]}V${v[2]}`; }
    return w;
  }

  // ---------------------------------------------------------------- 状態
  const LSK = 'fb.wind';
  const lsGet = () => { try { return JSON.parse(localStorage.getItem(LSK) || '{}'); } catch { return {}; } };
  const st = Object.assign({ icao: null, rwy: null, pilot: 'cap', type: 'ceo', phase: 'LDG', rwycc: 6, appr: 'none', autoland: false, wind: null }, lsGet());
  const save = () => { try { localStorage.setItem(LSK, JSON.stringify(st)); } catch { /* ignore */ } };
  let ctxFn = () => ({ airports: [] });

  // ---------------------------------------------------------------- 評価
  function evaluate(lim, rwy, w, mv) {
    if (!w || w.spd == null || !Number.isFinite(w.spd)) return null;
    const use = w.gust != null && Number.isFinite(w.gust) && w.gust > w.spd ? w.gust : w.spd;
    const toMag = (d) => (w.ref === 'true' ? norm(d - mv.deg) : norm(d));
    const res = { use, usedGust: use !== w.spd, magDir: w.dir === 'VRB' ? null : toMag(w.dir) };
    if (!lim.permitted) { res.state = 'ng'; res.msg = '離着陸不可の条件'; return res; }
    if (use === 0) { res.state = 'ok'; res.msg = '静穏'; return res; }
    let ths;
    if (w.dir === 'VRB') ths = Array.from({ length: 181 }, (_, i) => i);
    else if (w.vfrom != null) { const a0 = toMag(w.vfrom), span = norm(w.vto - w.vfrom); ths = Array.from({ length: Math.floor(span) + 1 }, (_, i) => norm(a0 + i - rwy.mag)); ths.push(norm(toMag(w.vto) - rwy.mag)); }
    else ths = [norm(res.magDir - rwy.mag)];
    let worst = null;
    for (const th of ths) { const c = cellAt(lim, th); const ratio = use / c.v; if (!worst || ratio > worst.ratio) worst = { th, a: fold(th), cell: c, ratio }; }
    res.worst = worst;
    if (res.magDir != null) { const t = (norm(res.magDir - rwy.mag) * Math.PI) / 180; res.hw = use * Math.cos(t); res.xw = use * Math.abs(Math.sin(t)); res.xwSide = Math.sin(t) >= 0 ? 'R' : 'L'; res.angle = fold(res.magDir - rwy.mag); }
    const c = worst.cell;
    res.state = use > c.v ? 'ng' : 'ok';
    res.msg = `許容 ${c.text}kt（${w.dir === 'VRB' ? '全周で最も厳しい角度 ' : ''}${Number.isInteger(+worst.a.toFixed(1)) ? worst.a.toFixed(0) : worst.a.toFixed(1)}°${c.between ? `→表の ${c.rows.join('°/')}° の厳しい方` : ''}・${MARKS[c.mark]?.label || ''}${c.col && c.col !== 'fo' ? `・${COL_LABEL[c.col]}` : ''}）`;
    return res;
  }

  // ---------------------------------------------------------------- 図（北が上・磁方位）
  function diagram(lim, rwy, ev, w, mv) {
    const C = 160, R = 124, MAX = 50, k = R / MAX;
    const pt = (dirMag, v) => { const a = (dirMag * Math.PI) / 180; const r = Math.min(v, MAX) * k; return [C + r * Math.sin(a), C - r * Math.cos(a)]; };
    const parts = [];
    for (let v = 10; v <= MAX; v += 10) parts.push(`<circle cx="${C}" cy="${C}" r="${v * k}" class="wl-ring"/>`, `<text x="${C + 3}" y="${C - v * k + 11}" class="wl-ringlab">${v}</text>`);
    for (let d = 0; d < 360; d += 30) { const [x, y] = pt(d, MAX); parts.push(`<line x1="${C}" y1="${C}" x2="${x}" y2="${y}" class="wl-spoke"/>`); const [tx, ty] = pt(d, MAX + 7.5); parts.push(`<text x="${tx}" y="${ty + 4}" class="wl-dirlab">${d === 0 ? 'N' : d3(d)}</text>`); }
    if (lim.permitted) {
      const poly = []; for (let i = 0; i < 720; i++) { const th = i / 2; poly.push(pt(rwy.mag + th, vmax(lim, th)).map((n) => n.toFixed(1)).join(',')); }
      parts.push(`<polygon points="${poly.join(' ')}" class="wl-env"/>`);
      // エンジン制限（E）の範囲を強調
      for (const sgn of [1, -1]) for (let row = 0; row <= 18; row++) {
        const c = rowCell(lim, row); if (c.mark !== 'E') continue;
        const p = [`${C},${C}`]; for (let a = row * 10 - 5; a <= row * 10 + 5; a += 0.5) p.push(pt(rwy.mag + sgn * a, vmax(lim, a)).map((n) => n.toFixed(1)).join(','));
        parts.push(`<polygon points="${p.join(' ')}" class="wl-eng"/>`);
      }
    } else parts.push(`<text x="${C}" y="${C - 40}" class="wl-nolab">離着陸不可</text>`);
    const a = (rwy.mag * Math.PI) / 180, L = 62, W = 7, ux = Math.sin(a), uy = -Math.cos(a), px = -uy, py = ux;
    const c4 = [[-L, -W], [L, -W], [L, W], [-L, W]].map(([l, w2]) => `${(C + ux * l + px * w2).toFixed(1)},${(C + uy * l + py * w2).toFixed(1)}`).join(' ');
    parts.push(`<polygon points="${c4}" class="wl-rwy"/>`);
    parts.push(`<line x1="${C - ux * (L - 14)}" y1="${C - uy * (L - 14)}" x2="${C + ux * (L - 6)}" y2="${C + uy * (L - 6)}" class="wl-rwyc" marker-end="url(#wl-arr)"/>`);
    const [lx, ly] = [C - ux * (L + 13), C - uy * (L + 13)];
    parts.push(`<text x="${lx}" y="${ly + 4}" class="wl-rwylab">${esc(rwy.id)}</text>`);
    if (ev && w && w.dir !== 'VRB' && ev.magDir != null) {
      const cls = ev.state === 'ok' ? 'ok' : 'ng';
      if (w.vfrom != null) { const fa = (w.ref === 'true' ? norm(w.vfrom - mv.deg) : w.vfrom), span = norm(w.vto - w.vfrom); const arc = []; for (let i = 0; i <= span; i += 2) arc.push(pt(fa + i, ev.use).map((n) => n.toFixed(1)).join(',')); parts.push(`<polyline points="${arc.join(' ')}" class="wl-varc ${cls}"/>`); }
      if (ev.usedGust) { const [mx, my] = pt(ev.magDir, w.spd); parts.push(`<circle cx="${mx}" cy="${my}" r="3.5" class="wl-wmean ${cls}"/>`); }
      const [x, y] = pt(ev.magDir, ev.use); const [x2, y2] = pt(ev.magDir, Math.max(ev.use - 9, 0));
      parts.push(`<line x1="${x}" y1="${y}" x2="${x2}" y2="${y2}" class="wl-wline ${cls}" marker-end="url(#wl-arr2)"/>`, `<circle cx="${x}" cy="${y}" r="6" class="wl-wdot ${cls}"/>`);
    }
    return `<svg viewBox="0 0 320 320" class="wl-svg" role="img" aria-label="風向別の許容風速"><defs><marker id="wl-arr" viewBox="0 0 10 10" refX="5" refY="5" markerWidth="5" markerHeight="5" orient="auto"><path d="M0 0L10 5L0 10z" class="wl-arrow"/></marker><marker id="wl-arr2" viewBox="0 0 10 10" refX="5" refY="5" markerWidth="4" markerHeight="4" orient="auto"><path d="M0 0L10 5L0 10z" class="wl-arrow2"/></marker></defs>${parts.join('')}</svg>`;
  }

  // ---------------------------------------------------------------- 画面
  const seg = (name, items, cur) => `<div class="vchips wl-seg" data-k="${name}">${items.map((i) => `<button type="button" class="chip${String(i.id) === String(cur) ? ' active' : ''}" data-v="${esc(i.id)}">${esc(i.label)}${i.sub ? `<small>${esc(i.sub)}</small>` : ''}</button>`).join('')}</div>`;
  function render() {
    const root = document.getElementById('wind-root'); if (!root) return;
    const ctx = ctxFn();
    const aps = ctx.airports.filter((a) => runways(a.profile).length);
    if (!aps.length) { root.innerHTML = '<p class="hint">滑走路データのある空港がありません（SETTINGS で空港を選び、パックをダウンロードしてください）。</p>'; return; }
    if (!aps.some((a) => a.icao === st.icao)) st.icao = aps[0].icao;
    const ap = aps.find((a) => a.icao === st.icao), rws = runways(ap.profile), mv = magVar(ap.profile);
    if (!rws.some((r) => r.id === st.rwy)) st.rwy = rws[0].id;
    const rwy = rws.find((r) => r.id === st.rwy);
    const metarW = parseMetarWind(ap.metar?.raw);
    if (!st.wind || (st.wind.src === 'metar' && st.wind.icao !== ap.icao)) st.wind = metarW ? { ...metarW, ref: 'true', src: 'metar', icao: ap.icao, obs: ap.metar?.obsTime || null } : { dir: null, spd: null, gust: null, ref: 'mag', src: 'manual', icao: ap.icao };
    if (st.phase === 'TO') { st.autoland = false; st.appr = 'none'; }
    save();
    const lim = compute(st);
    const w = st.wind;
    const ev = w && w.dir != null && w.spd != null ? evaluate(lim, rwy, w, mv) : null;

    const optAp = aps.map((a) => `<option value="${esc(a.icao)}"${a.icao === st.icao ? ' selected' : ''}>${esc(a.label)}</option>`).join('');
    const optRw = rws.map((r) => `<option value="${esc(r.id)}"${r.id === st.rwy ? ' selected' : ''}>${esc(r.id)}・${d3(r.mag)}°M</option>`).join('');
    const optCc = [6, 5, 4, 3, 2, 1, 0].map((n) => `<option value="${n}"${Number(st.rwycc) === n ? ' selected' : ''}>${esc(RWYCC[n])}</option>`).join('');
    const tag = (c) => { const k = c.mark === '' && (c.col === 'cat1' || c.col === 'cat2al') ? 'om' : MARKS[c.mark]?.kind; if (k === 'om') return '<span class="wl-tag om">OM 運用制限</span>'; return k === 'afm' ? '<span class="wl-tag afm">AFM LIMITATION・超過不可</span>' : k === 'company' ? '<span class="wl-tag co">会社最大値・一時超過可</span>' : k === 'eng' ? '<span class="wl-tag eng">エンジン制限</span>' : k === 'app' ? '<span class="wl-tag om">アプリ計算</span>' : ''; };
    const markCls = (c) => ({ '*': 'nl', T: 't', E: 'e', H: 'h', F: 'f', '': 'x' }[c.mark]);

    // 早見（真横 90°・真後ろ 180°）と、角度別の表（左右の磁方位つき）
    let summary = '', table = '';
    if (lim.permitted) {
      const c90 = rowCell(lim, 9), c180 = rowCell(lim, 18), c0 = rowCell(lim, 0);
      const box = (name, c) => `<div class="wl-sum"><span class="wl-lk">${name}</span><span class="wl-lv m-${markCls(c)}">${esc(c.text)}<small>kt</small></span>${tag(c)}</div>`;
      summary = `<div class="wl-sums">${box('真横 90°', c90)}${box('真後ろ 180°', c180)}${box('正面 0°', c0)}</div>
        <div class="hint wl-small">使用列：${esc(lim.tableName)} ／ ${lim.cols.map((c) => esc(COL_LABEL[c])).join(' と ')}${lim.cols.length > 1 ? '（厳しい方）' : ''}${lim.fo ? ` ／ 副操縦士操縦：横風 ${lim.fo.xw}kt（RWYCC 90° 値 ${lim.fo.xw90} の 1/2）・背風 ${lim.fo.tw}kt で計算（${esc(FO.ref)}）` : ''}</div>`;
      const hiRows = ev?.worst ? ev.worst.cell.rows : (ev?.angle != null ? [Math.round(ev.angle / 10) * 10] : []);
      const rows = []; for (let r = 0; r <= 18; r++) {
        const c = rowCell(lim, r), a = r * 10;
        const dirs = a === 0 ? d3(rwy.mag) : a === 180 ? d3(rwy.mag + 180) : `${d3(rwy.mag - a)} ／ ${d3(rwy.mag + a)}`;
        rows.push(`<tr class="${hiRows.includes(a) ? 'cur' : ''}${a > 90 ? ' tail' : ''}"><td>${a}°</td><td class="m-${markCls(c)}">${esc(c.text)}</td><td>${dirs}</td></tr>`);
      }
      table = `<table class="wl-tbl"><thead><tr><th>機首から</th><th>許容 kt</th><th>風向（磁）左 ／ 右</th></tr></thead><tbody>${rows.join('')}</tbody></table>
        <p class="hint wl-small">印：<b class="m-nl">*</b> 制限なし（80 と表示）・<b class="m-t">T</b> 背風制限（15kt、CAT II/Autoland は 10kt）・<b class="m-e">E</b> エンジン制限・<b class="m-h">H</b> 向かい風 30kt 制限・印なし＝横風制限（RCAM）${lim.fo ? '・<b class="m-f">F</b> 副操縦士操縦の条件（OM）からアプリで計算（小数切り捨て）' : ''}。許容風速は gust 含む。表にない角度は安全側（制限が厳しい方）で判定（アプリ独自）。</p>`;
    }
    const evBox = ev ? `<div class="wl-result ${ev.state}"><div class="wl-rhead">${ev.state === 'ok' ? 'OK' : 'NG'}</div><div class="wl-rbody"><div>${esc(ev.msg)}</div>${ev.hw != null ? `<div>${ev.hw >= 0 ? '向かい風' : '背風'} ${Math.abs(ev.hw).toFixed(1)}kt ／ 横風 ${ev.xw.toFixed(1)}kt（${ev.xwSide === 'R' ? '右' : '左'}から）</div>` : ''}<div class="hint wl-small">${ev.magDir != null ? `風向 ${d3(ev.magDir)}°M（機首から ${ev.angle.toFixed(1)}°）・` : '風向 VRB（全周の最悪値で判定）・'}${ev.usedGust ? `最大風速 ${ev.use}kt で判定（${REV.om} 3-7-1(2)②）` : `${ev.use}kt で判定`}${w.vfrom != null ? '・変動範囲内の最悪値' : ''}</div></div></div>` : '<div class="wl-result none"><div class="wl-rbody hint">風を入力すると判定します</div></div>';

    let foW = '';
    if (st.pilot === 'fo' && st.phase === 'LDG' && lim.permitted) {
      const Lm = rwy.lengthM, Wm = rwy.widthM; let t;
      if (Wm != null && Wm < 45) t = `幅 ${Wm}m（45m 未満）：表の対象外・要確認`;
      else if (Lm == null) t = '滑走路長が不明';
      else if (Lm >= 2100) t = '2,100m 以上：DRY・WET とも最大着陸重量以下';
      else if (Lm >= 2000) t = '2,000〜2,100m：DRY 最大着陸重量以下 ／ WET 139,000 LBS 以下';
      else if (Lm >= 1800) t = '1,800〜2,000m：WET 127,000 LBS 以下（DRY の値は未収録・要確認）';
      else t = '1,800m 未満：表の範囲外・要確認';
      foW = `<div class="card wl-card"><div class="wl-h">副操縦士操縦時の着陸重量 <span class="wl-ref">${esc(FO.ref)}</span></div><div>${esc(t)}</div><div class="hint wl-small">判定に使った長さ：${esc(rwy.src)} の滑走路長 ${Lm ?? '--'}m × 幅 ${Wm ?? '--'}m。規程は「有効滑走路長（幅45m以上）」なので、短縮運用・LDA（AIP AD 2.13）は別途確認。</div></div>`;
    }

    root.innerHTML = `
      <div class="wl-sel">
        <div class="wl-row2"><label>空港<select id="wl-ap">${optAp}</select></label><label>滑走路<select id="wl-rwy">${optRw}</select></label></div>
        <div class="wl-row2 eq">${seg('phase', [{ id: 'TO', label: '離陸', sub: 'TO' }, { id: 'LDG', label: '着陸', sub: 'LDG' }], st.phase)}${seg('type', TYPES.map((t) => ({ ...t, label: t.label.replace('A320', '') })), st.type)}</div>
        ${seg('pilot', PILOTS, st.pilot)}
        <label>滑走路状態（RWYCC）<select id="wl-cc">${optCc}</select></label>
        ${st.phase === 'LDG' ? `${seg('appr', [{ id: 'none', label: '通常', sub: 'CAT I 以外' }, { id: 'cat1low', label: 'CAT I', sub: 'RVR/CMV<1200m' }, { id: 'cat2', label: 'CAT II', sub: '\u3000' }], st.appr)}
        <div class="wl-checks"><label class="wl-ck"><input type="checkbox" id="wl-al"${st.autoland ? ' checked' : ''}> Autoland（CAT II/Autoland 列）</label></div>` : ''}
      </div>
      <div class="card wl-card">
        <div class="wl-h">RWY ${esc(rwy.id)} <span class="hint">${d3(rwy.mag)}°M（真方位 ${rwy.trueBrg.toFixed(1)}°・偏差 ${esc(mv.text)}）</span></div>
        ${lim.permitted ? summary : `<div class="wl-result ng"><div class="wl-rhead">不可</div><div class="wl-rbody">${lim.reasons.map(esc).join('<br>')}</div></div>`}
        <div class="wl-fig">${diagram(lim, rwy, ev, w, mv)}</div>
        <p class="hint wl-small wl-figkey">緑＝許容範囲（中心からの距離＝風速 kt・外周 50kt で打ち切り）。${lim.permitted && [...Array(19).keys()].some((r) => rowCell(lim, r).mark === 'E') ? '<span class="m-e">■</span>＝エンジン制限（E）の角度。' : ''}矢印は滑走路の進行方向。</p>
        <div class="wl-wind">
          <div class="wl-h2">風 ${w?.src === 'metar' ? `<span class="hint">METAR ${esc(w.raw || '')}${w.obs ? `（${esc(w.obs.slice(11, 16))}Z）` : ''}</span>` : '<span class="hint">手入力</span>'}</div>
          <div class="wl-inrow">
            <label>風向<input id="wl-wd" type="text" inputmode="numeric" maxlength="3" value="${w?.dir ?? ''}" placeholder="270"></label>
            <label>風速<input id="wl-ws" type="number" inputmode="numeric" value="${w?.spd ?? ''}" placeholder="kt"></label>
            <label>最大風速<input id="wl-wg" type="number" inputmode="numeric" value="${w?.gust ?? ''}" placeholder="G"></label>
            <label>方位<select id="wl-ref"><option value="true"${w?.ref === 'true' ? ' selected' : ''}>真（気象電文）</option><option value="mag"${w?.ref !== 'true' ? ' selected' : ''}>磁（ATIS/TWR）</option></select></label>
          </div>
          <div class="row"><button type="button" class="btn" id="wl-metar"${metarW ? '' : ' disabled'}>最新 METAR を入れる</button><button type="button" class="btn" id="wl-clear">クリア</button></div>
          <p class="hint wl-small">気象電文の風は真方位、それ以外は磁方位（${REV.om} 3-7-1(2)③）。真方位は偏差 ${esc(mv.text)} で磁方位に直して判定。VRB は全周、dddVddd は範囲内の最悪値。</p>
          ${evBox}
        </div>
        ${table}
      </div>
      ${foW}
      <details class="card wl-card wl-notes"><summary>注記・出典</summary><ul>
        <li>参考用の補助です。AOM が優先。使用にあたっては PF / PM で確認してください。</li>
        <li>OM の制限はすべて同時に適用。最も厳しい値を表示しています。</li>
        <li>横風（RCAM）は会社の最大値で、離陸滑走開始後・着陸決定後の一時的な超過は可（${REV.aom} LIM-AG-OPS）。背風 15kt・Autoland 10kt は AFM LIMITATION で超過不可。</li>
        <li>副操縦士（右席）の操縦は機長が誰であっても OM の制限（横風は AOM 値の 1/2・背風 10kt・DRY/WET のみ）。表には含まれないのでアプリで計算（${esc(FO.ref)}）。AOM の値になるのは右席の査察・教官が操縦する場合と、左席で機長業務を習熟中の副操縦士（OM 8-11-2(3)）。</li>
        <li>滑走路状態が混在・3区分で異なる場合は最も悪い値（${REV.aom} LIM-AG-OPS）。AIREP が SNOWTAM より悪いときは機長判断で RWYCC を下げてよい。上げるのは不可。</li>
        <li>確認のタイミング：離陸＝Take-off Clearance 時の風、着陸＝Landing Clearance 時の風。超えていても 500ft AFE までに再確認して以内なら進入継続可（${REV.om} S3-7）。飛行場対空援助業務の飛行場は「Runway is clear」の時。</li>
        <li>横風成分は平均風速、最大風速の通報があればその値（${REV.om} 3-7-1(2)②）。Autoland の風は Tower 通報の Surface Wind 基準（${REV.aom} LIM-AFS）。Flysmart では突風値を平均風の欄に入力。</li>
        <li>離着陸できない深さ：Dry snow 100mm・Wet snow 30mm・Slush / Standing water 13mm（1区分でも超えれば不可）。</li>
        <li>滑走路別の冊子（Wind Component Table_RWY別 REV1）もありますが、ここでは相対角の表と滑走路の磁方位（AIP の真方位−磁気偏差）から求めています。</li>
        <li>表にない角度（10° の間）は両隣の行の厳しい方で判定（アプリ独自）。</li>
        <li>Route Manual の空港別の制限は未確認です。</li>
      </ul><p class="wl-ref">出典：${esc(WCT.ref)} ／ ${REV.aom} ／ ${REV.om} ／ ${REV.oen050} ／ ${REV.oen104}（Attention All Crew）。改訂時は見直しが必要。</p></details>`;

    const q = (id) => document.getElementById(id);
    q('wl-ap').onchange = (e) => { st.icao = e.target.value; st.rwy = null; if (st.wind?.src === 'metar') st.wind = null; render(); };
    q('wl-rwy').onchange = (e) => { st.rwy = e.target.value; render(); };
    q('wl-cc').onchange = (e) => { st.rwycc = Number(e.target.value); render(); };
    root.querySelectorAll('.wl-seg').forEach((g) => g.querySelectorAll('.chip').forEach((b) => { b.onclick = () => { st[g.dataset.k] = b.dataset.v; render(); }; }));
    if (q('wl-al')) q('wl-al').onchange = (e) => { st.autoland = e.target.checked; render(); };
    const readIn = () => {
      const dv = q('wl-wd').value.trim().toUpperCase(); const n = (x) => (x.trim() === '' ? null : Number(x));
      let dir = null; if (dv === 'VRB') dir = 'VRB'; else if (dv !== '' && Number.isFinite(Number(dv))) dir = norm(Number(dv)) || 360;
      st.wind = { dir, spd: n(q('wl-ws').value), gust: n(q('wl-wg').value), ref: q('wl-ref').value, src: 'manual', icao: st.icao };
      render();
    };
    ['wl-wd', 'wl-ws', 'wl-wg'].forEach((id) => { q(id).onchange = readIn; });
    q('wl-ref').onchange = readIn;
    q('wl-metar').onclick = () => { st.wind = null; render(); };
    q('wl-clear').onclick = () => { st.wind = { dir: null, spd: null, gust: null, ref: 'mag', src: 'manual', icao: st.icao }; render(); };
  }
  function setup(fn) { ctxFn = fn; }
  window.FBWind = { setup, render, compute, rowCell, cellAt, vmax, evaluate, runways, magVar, parseMetarWind, WCT };
})();
