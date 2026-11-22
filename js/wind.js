// WIND（Wind Limitation）。滑走路ごとに「どの風向から何ktまで」を1つの包絡線で表示（背風・横風を分けない）。完全オフライン。
// 数値は SFJ 規程類（AOM REV30 / OM REV144 / OEN 050 REV1 / OEN 104 ISSUE 04/DEC/2025）で確認済みのものだけ。推測値は入れない。
(function () {
  const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const REV = { aom: 'AOM REV30', om: 'OM REV144', oen050: 'OEN 050 REV1', oen104: 'OEN 104 ISSUE 04/DEC/2025' };

  // ---------------------------------------------------------------- 制限値（数値・短いラベル・出典のみ）
  // kind: 'company' = 会社の最大値（離陸滑走開始後・着陸決定後の一時的な超過は可） / 'afm' = AFM LIMITATION（超過不可） / 'om' = OM の運用制限
  const LIMITS = {
    // 最大横風（gust 含む）。離陸・着陸同値。AOM LIM-AG-OPS RCAM
    rcam: {
      6: { xw: 38, label: '6 DRY' },
      5: { xw: 29, label: '5 GOOD（WET 3mm以下 等）' },
      4: { xw: 29, label: '4 GOOD TO MEDIUM' },
      3: { xw: 25, label: '3 MEDIUM' },
      2: { xw: 20, label: '2 MEDIUM TO POOR' },
      1: { xw: 15, label: '1 POOR' },
      0: { xw: null, label: '0 LESS THAN POOR（離着陸不可）' },
    },
    rcamRef: `${REV.aom} LIM-AG-OPS RCAM`,
    // 型式別の demonstrated crosswind（DRY）。neo 離陸は 38kt（AOM REV29 の 35kt から変更）
    demo: {
      ceo: { TO: { xw: 38, ref: `${REV.aom} LIM-AG-OPS` }, LDG: { xw: 38, ref: `${REV.aom} LIM-AG-OPS` } },
      neo: { TO: { xw: 38, ref: REV.oen050 }, LDG: { xw: 38, ref: `${REV.aom} LIM-AG-OPS` } },
    },
    // 最大背風（両型式共通）
    tailwind: { TO: 15, LDG: 15, kind: 'afm', ref: `${REV.aom} LIM-AG-OPS` },
    // 自動進入・着陸・ロールアウト（Tower 通報の Surface Wind 基準）
    autoland: { tw: 10, hw: 30, xw: 20, xwRolloutJA20_27: 15, kind: 'afm', ref: `${REV.aom} LIM-AFS` },
    // 右席の副操縦士が離着陸を操縦する場合（機長が誰であっても）
    fo: { xwFactor: 0.5, tw: 10, rwycc: [6, 5], ref: `${REV.om} 8-11-1(3)②` },
    // CAT I（RVR/CMV 1200m 未満）・CAT II
    cat1low: { xw: 10, ref: `${REV.om} 6-4` },
    cat2: { xw: 10, ref: `${REV.om} 6-5` },
    // neo 離陸のエンジン制限（横風＋背風の組合せ）。Wind Component Table（E）/ Flysmart の値。未入手のため null
    // 入手したら { points: [[背風kt, 最大横風kt], ...] } の形で入れる（それまで斜め後方は常に「要確認」）
    neoToEngine: null,
    neoToEngineRef: 'Applicable Performance Table / Wind Component Table（E）・Flysmart Takeoff',
    // 副操縦士操縦時の着陸重量（有効滑走路長・幅45m以上）
    foLdgWeight: { ref: `${REV.om} 8-11-1(3)②`, minWidthM: 45 },
  };

  const PILOTS = [
    { id: 'cap', label: '機長操縦' },
    { id: 'fo', label: '副操縦士操縦', sub: '右席' },
    { id: 'aom', label: '査察・教官操縦', sub: '右席／左席習熟中' },
  ];
  const TYPES = [{ id: 'ceo', label: 'A320ceo', sub: 'JA07MC–JA27MC' }, { id: 'neo', label: 'A320neo', sub: 'JA28MC〜' }];

  // 選択から制限値を求める（OM の制限は同時適用・最も厳しい値）
  function compute(sel) {
    const r = { permitted: true, reasons: [], xw: [], tw: [], hw: [], neoOblique: false, warn: [] };
    const rc = LIMITS.rcam[sel.rwycc];
    if (!rc || rc.xw == null) { r.permitted = false; r.reasons.push(`RWYCC ${sel.rwycc}：離着陸不可（${LIMITS.rcamRef}）`); }
    if (sel.pilot === 'fo' && !LIMITS.fo.rwycc.includes(Number(sel.rwycc))) { r.permitted = false; r.reasons.push(`副操縦士操縦は DRY / WET のみ（${LIMITS.fo.ref}）`); }
    if (!r.permitted) return r;
    const demo = LIMITS.demo[sel.type][sel.phase];
    r.xw.push({ v: Math.min(rc.xw, demo.xw), label: `RCAM RWYCC ${sel.rwycc}`, ref: sel.type === 'neo' && sel.phase === 'TO' ? `${LIMITS.rcamRef} / ${REV.oen050}` : LIMITS.rcamRef, kind: 'company' });
    r.tw.push({ v: LIMITS.tailwind[sel.phase], label: `最大背風（${sel.phase === 'TO' ? '離陸' : '着陸'}）`, ref: LIMITS.tailwind.ref, kind: 'afm' });
    if (sel.pilot === 'fo') {
      r.xw.push({ v: Math.min(rc.xw, demo.xw) * LIMITS.fo.xwFactor, label: '副操縦士操縦（AOM値の1/2）', ref: LIMITS.fo.ref, kind: 'om' });
      r.tw.push({ v: LIMITS.fo.tw, label: '副操縦士操縦', ref: LIMITS.fo.ref, kind: 'om' });
    }
    if (sel.phase === 'LDG') {
      if (sel.appr === 'cat1low') r.xw.push({ v: LIMITS.cat1low.xw, label: 'CAT I（RVR/CMV 1200m未満）', ref: LIMITS.cat1low.ref, kind: 'om' });
      if (sel.appr === 'cat2') r.xw.push({ v: LIMITS.cat2.xw, label: 'CAT II', ref: LIMITS.cat2.ref, kind: 'om' });
      if (sel.autoland) {
        const al = LIMITS.autoland;
        r.xw.push({ v: sel.rollout ? al.xwRolloutJA20_27 : al.xw, label: sel.rollout ? 'Autoland（JA20MC–JA27MC Automatic Rollout あり）' : 'Autoland', ref: al.ref, kind: 'afm' });
        r.tw.push({ v: al.tw, label: 'Autoland', ref: al.ref, kind: 'afm' });
        r.hw.push({ v: al.hw, label: 'Autoland', ref: al.ref, kind: 'afm' });
      }
    }
    if (sel.type === 'neo' && sel.phase === 'TO' && !LIMITS.neoToEngine) r.neoOblique = true;
    const pick = (arr) => arr.reduce((a, b) => (a == null || b.v < a.v ? b : a), null);
    r.XW = pick(r.xw); r.TW = pick(r.tw); r.HW = pick(r.hw);
    return r;
  }
  // 滑走路に対する相対角 th（度、風の吹いてくる方向−滑走路方位）での最大風速
  function vmax(lim, th) {
    if (!lim.permitted) return 0;
    const t = (th * Math.PI) / 180, s = Math.abs(Math.sin(t)), c = Math.cos(t);
    let v = Infinity;
    if (s > 1e-9) v = Math.min(v, lim.XW.v / s);
    if (c < -1e-9) v = Math.min(v, lim.TW.v / -c);
    if (c > 1e-9 && lim.HW) v = Math.min(v, lim.HW.v / c);
    return v;
  }
  const isOblique = (th) => { const t = (th * Math.PI) / 180; return Math.cos(t) < -1e-9 && Math.abs(Math.sin(t)) > 1e-9; };
  const norm = (d) => ((d % 360) + 360) % 360;
  const fmtV = (v) => (v > 50 ? '50+' : String(Math.floor(v + 1e-9)));
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
  const st = Object.assign({ icao: null, rwy: null, pilot: 'cap', type: 'ceo', phase: 'LDG', rwycc: 6, appr: 'none', autoland: false, rollout: false, wind: null }, lsGet());
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
    // 判定する相対角の範囲（VRB＝全周、dddVddd＝その範囲、通常＝1点）
    let ths;
    if (w.dir === 'VRB') ths = Array.from({ length: 360 }, (_, i) => i);
    else if (w.vfrom != null) { const a = toMag(w.vfrom), span = norm(w.vto - w.vfrom); ths = Array.from({ length: Math.floor(span) + 1 }, (_, i) => norm(a + i - rwy.mag)); ths.push(norm(toMag(w.vto) - rwy.mag)); }
    else ths = [norm(res.magDir - rwy.mag)];
    let worst = null;
    for (const th of ths) { const v = vmax(lim, th); if (!worst || use / v > worst.ratio) worst = { th, v, ratio: use / v }; }
    const th0 = w.dir === 'VRB' ? null : norm(res.magDir - rwy.mag);
    if (th0 != null) { const t = (th0 * Math.PI) / 180; res.hw = use * Math.cos(t); res.xw = use * Math.abs(Math.sin(t)); res.xwSide = Math.sin(t) >= 0 ? 'R' : 'L'; }
    res.worst = worst;
    if (worst.ratio > 1 + 1e-9) {
      res.state = 'ng';
      const t = (worst.th * Math.PI) / 180, xw = use * Math.abs(Math.sin(t)), c = use * Math.cos(t);
      const over = [];
      if (xw > lim.XW.v + 1e-9) over.push(`横風 ${xw.toFixed(1)}kt ＞ ${lim.XW.v}kt`);
      if (c < 0 && -c > lim.TW.v + 1e-9) over.push(`背風 ${(-c).toFixed(1)}kt ＞ ${lim.TW.v}kt`);
      if (c > 0 && lim.HW && c > lim.HW.v + 1e-9) over.push(`向かい風 ${c.toFixed(1)}kt ＞ ${lim.HW.v}kt`);
      res.msg = over.join(' ／ ');
    } else res.state = 'ok';
    if (lim.neoOblique && ths.some(isOblique) && res.state === 'ok') { res.state = 'chk'; res.msg = 'neo 離陸・斜め後方の風：エンジン制限を Wind Component Table（E）/ Flysmart で要確認'; }
    return res;
  }

  // ---------------------------------------------------------------- 図（北が上・磁方位）
  function diagram(lim, rwy, ev, w, mv) {
    const C = 160, R = 124, MAX = 50, k = R / MAX;
    const pt = (dirMag, v) => { const a = (dirMag * Math.PI) / 180; const r = Math.min(v, MAX) * k; return [C + r * Math.sin(a), C - r * Math.cos(a)]; };
    const parts = [];
    // 目盛り
    for (let v = 10; v <= MAX; v += 10) parts.push(`<circle cx="${C}" cy="${C}" r="${v * k}" class="wl-ring"/>`, `<text x="${C + 3}" y="${C - v * k + 11}" class="wl-ringlab">${v}</text>`);
    for (let d = 0; d < 360; d += 30) { const [x, y] = pt(d, MAX); parts.push(`<line x1="${C}" y1="${C}" x2="${x}" y2="${y}" class="wl-spoke"/>`); const [tx, ty] = pt(d, MAX + 7.5); parts.push(`<text x="${tx}" y="${ty + 4}" class="wl-dirlab">${d === 0 ? 'N' : d3(d)}</text>`); }
    if (lim.permitted) {
      const poly = []; for (let i = 0; i < 360; i++) poly.push(pt(rwy.mag + i, vmax(lim, i)).map((n) => n.toFixed(1)).join(','));
      parts.push(`<polygon points="${poly.join(' ')}" class="wl-env"/>`);
      if (lim.neoOblique) for (const [a, b] of [[91, 179], [181, 269]]) {
        const p = [`${C},${C}`]; for (let i = a; i <= b; i++) p.push(pt(rwy.mag + i, vmax(lim, i)).map((n) => n.toFixed(1)).join(','));
        parts.push(`<polygon points="${p.join(' ')}" class="wl-chk" fill="url(#wl-hatch)"/>`);
      }
    } else parts.push(`<text x="${C}" y="${C - 40}" class="wl-nolab">離着陸不可</text>`);
    // 滑走路（中心を通る帯。着陸・離陸方向の矢印）
    const a = (rwy.mag * Math.PI) / 180, L = 62, W = 7, ux = Math.sin(a), uy = -Math.cos(a), px = -uy, py = ux;
    const c4 = [[-L, -W], [L, -W], [L, W], [-L, W]].map(([l, w2]) => `${(C + ux * l + px * w2).toFixed(1)},${(C + uy * l + py * w2).toFixed(1)}`).join(' ');
    parts.push(`<polygon points="${c4}" class="wl-rwy"/>`);
    parts.push(`<line x1="${C - ux * (L - 14)}" y1="${C - uy * (L - 14)}" x2="${C + ux * (L - 6)}" y2="${C + uy * (L - 6)}" class="wl-rwyc" marker-end="url(#wl-arr)"/>`);
    const [lx, ly] = [C - ux * (L + 13), C - uy * (L + 13)];
    parts.push(`<text x="${lx}" y="${ly + 4}" class="wl-rwylab">${esc(rwy.id)}</text>`);
    // 現在の風
    if (ev && w && w.dir !== 'VRB' && ev.magDir != null) {
      const cls = ev.state === 'ok' ? 'ok' : ev.state === 'chk' ? 'chk' : 'ng';
      if (w.vfrom != null) { const fa = (w.ref === 'true' ? norm(w.vfrom - mv.deg) : w.vfrom), span = norm(w.vto - w.vfrom); const arc = []; for (let i = 0; i <= span; i += 2) arc.push(pt(fa + i, ev.use).map((n) => n.toFixed(1)).join(',')); parts.push(`<polyline points="${arc.join(' ')}" class="wl-varc ${cls}"/>`); }
      if (ev.usedGust) { const [mx, my] = pt(ev.magDir, w.spd); parts.push(`<circle cx="${mx}" cy="${my}" r="3.5" class="wl-wmean ${cls}"/>`); }
      const [x, y] = pt(ev.magDir, ev.use); const [x2, y2] = pt(ev.magDir, Math.max(ev.use - 9, 0));
      parts.push(`<line x1="${x}" y1="${y}" x2="${x2}" y2="${y2}" class="wl-wline ${cls}" marker-end="url(#wl-arr2)"/>`, `<circle cx="${x}" cy="${y}" r="6" class="wl-wdot ${cls}"/>`);
    }
    return `<svg viewBox="0 0 320 320" class="wl-svg" role="img" aria-label="風向別の最大風速"><defs><pattern id="wl-hatch" width="7" height="7" patternUnits="userSpaceOnUse" patternTransform="rotate(45)"><rect width="7" height="7" class="wl-hbg"/><line x1="0" y1="0" x2="0" y2="7" class="wl-hline"/></pattern><marker id="wl-arr" viewBox="0 0 10 10" refX="5" refY="5" markerWidth="5" markerHeight="5" orient="auto"><path d="M0 0L10 5L0 10z" class="wl-arrow"/></marker><marker id="wl-arr2" viewBox="0 0 10 10" refX="5" refY="5" markerWidth="4" markerHeight="4" orient="auto"><path d="M0 0L10 5L0 10z" class="wl-arrow2"/></marker></defs>${parts.join('')}</svg>`;
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
    const optCc = [6, 5, 4, 3, 2, 1, 0].map((n) => `<option value="${n}"${Number(st.rwycc) === n ? ' selected' : ''}>${esc(LIMITS.rcam[n].label)}</option>`).join('');
    const kindTag = (x) => (x.kind === 'afm' ? '<span class="wl-tag afm">AFM LIMITATION・超過不可</span>' : x.kind === 'company' ? '<span class="wl-tag co">会社最大値・一時超過可</span>' : '<span class="wl-tag om">OM 運用制限</span>');
    const limRow = (name, x, all) => `<div class="wl-lim"><span class="wl-lk">${name}</span><span class="wl-lv">${x.v % 1 ? x.v.toFixed(1) : x.v}<small>kt</small></span><span class="wl-ls">${esc(x.label)} ${kindTag(x)}<br><span class="wl-ref">${esc(x.ref)}${all.length > 1 ? `　他 ${all.filter((y) => y !== x).map((y) => `${y.v % 1 ? y.v.toFixed(1) : y.v}kt（${y.label}）`).map(esc).join('・')}` : ''}</span></span></div>`;

    // 10°ごとの表
    let table = '';
    if (lim.permitted) {
      const cur = ev?.magDir != null ? Math.round(ev.magDir / 10) * 10 % 360 : null;
      const cells = []; for (let d = 10; d <= 360; d += 10) { const th = norm(d - rwy.mag), v = vmax(lim, th); const ob = lim.neoOblique && isOblique(th); const rel = Math.cos((th * Math.PI) / 180) < -1e-9 ? 'tail' : 'head'; cells.push(`<div class="wl-cell ${rel}${ob ? ' chk' : ''}${cur === d % 360 ? ' cur' : ''}"><span>${d3(d)}°</span><b>${fmtV(v)}${ob ? '<i>※</i>' : ''}</b></div>`); }
      table = `<div class="wl-grid">${cells.join('')}</div><p class="hint wl-small">磁方位（風の吹いてくる方向）ごとの最大風速 kt（gust 含む・小数切り捨て）。50+＝50kt 超（向かい風寄りで、横風成分だけが制限）。<span class="wl-key tail">■</span>背風成分あり${lim.neoOblique ? '　※＝エンジン制限要確認' : ''}</p>`;
    }
    const evBox = ev ? `<div class="wl-result ${ev.state}"><div class="wl-rhead">${ev.state === 'ok' ? 'OK' : ev.state === 'chk' ? '要確認' : 'NG'}</div><div class="wl-rbody">${ev.msg ? `<div>${esc(ev.msg)}</div>` : ''}${ev.hw != null ? `<div>${ev.hw >= 0 ? '向かい風' : '背風'} ${Math.abs(ev.hw).toFixed(1)}kt ／ 横風 ${ev.xw.toFixed(1)}kt（${ev.xwSide === 'R' ? '右' : '左'}から）</div>` : ''}<div class="hint wl-small">${ev.magDir != null ? `風向 ${d3(ev.magDir)}°M・` : '風向 VRB（全周の最悪値で判定）・'}${ev.usedGust ? `最大風速 ${ev.use}kt で計算（${REV.om} 3-7-1(2)②）` : `${ev.use}kt で計算`}${w.vfrom != null ? '・変動範囲内の最悪値で判定' : ''}${ev.worst && ev.state !== 'ok' && w.dir !== 'VRB' ? '' : ''}${ev.worst ? `・この向きの上限 ${fmtV(ev.worst.v)}kt` : ''}</div></div></div>` : '<div class="wl-result none"><div class="wl-rbody hint">風を入力すると判定します</div></div>';

    // 副操縦士操縦時の着陸重量
    let foW = '';
    if (st.pilot === 'fo' && st.phase === 'LDG' && lim.permitted) {
      const Lm = rwy.lengthM, Wm = rwy.widthM; let t;
      if (Wm != null && Wm < LIMITS.foLdgWeight.minWidthM) t = `幅 ${Wm}m（45m 未満）：表の対象外・要確認`;
      else if (Lm == null) t = '滑走路長が不明';
      else if (Lm >= 2100) t = '2,100m 以上：DRY・WET とも最大着陸重量以下';
      else if (Lm >= 2000) t = '2,000〜2,100m：DRY 最大着陸重量以下 ／ WET 139,000 LBS 以下';
      else if (Lm >= 1800) t = '1,800〜2,000m：WET 127,000 LBS 以下（DRY の値は未収録・要確認）';
      else t = '1,800m 未満：表の範囲外・要確認';
      foW = `<div class="card wl-card"><div class="wl-h">副操縦士操縦時の着陸重量 <span class="wl-ref">${esc(LIMITS.foLdgWeight.ref)}</span></div><div>${esc(t)}</div><div class="hint wl-small">判定に使った長さ：${esc(rwy.src)} の滑走路長 ${Lm ?? '--'}m × 幅 ${Wm ?? '--'}m。規程は「有効滑走路長」なので、短縮運用・LDA（AIP AD 2.13）は別途確認。</div></div>`;
    }

    root.innerHTML = `
      <div class="wl-sel">
        <div class="row wl-row2"><label>空港<select id="wl-ap">${optAp}</select></label><label>滑走路<select id="wl-rwy">${optRw}</select></label></div>
        <div class="wl-row2 eq">${seg('phase', [{ id: 'TO', label: '離陸', sub: 'TO' }, { id: 'LDG', label: '着陸', sub: 'LDG' }], st.phase)}${seg('type', TYPES.map((t) => ({ ...t, label: t.label.replace('A320', '') })), st.type)}</div>
        ${seg('pilot', PILOTS, st.pilot)}
        <label>滑走路状態（RWYCC）<select id="wl-cc">${optCc}</select></label>
        ${st.phase === 'LDG' ? `${seg('appr', [{ id: 'none', label: '通常', sub: 'CAT I 以外' }, { id: 'cat1low', label: 'CAT I', sub: 'RVR/CMV<1200m' }, { id: 'cat2', label: 'CAT II', sub: '　' }], st.appr)}
        <div class="wl-checks"><label class="wl-ck"><input type="checkbox" id="wl-al"${st.autoland ? ' checked' : ''}> Autoland</label>${st.autoland ? `<label class="wl-ck"><input type="checkbox" id="wl-ro"${st.rollout ? ' checked' : ''}> JA20MC–JA27MC で Automatic Rollout あり</label>` : ''}</div>` : ''}
      </div>
      <div class="card wl-card">
        <div class="wl-h">RWY ${esc(rwy.id)} <span class="hint">${d3(rwy.mag)}°M（真方位 ${rwy.trueBrg.toFixed(1)}°・偏差 ${esc(mv.text)}）</span></div>
        ${lim.permitted ? `${limRow('横風', lim.XW, lim.xw)}${limRow('背風', lim.TW, lim.tw)}${lim.HW ? limRow('向かい風', lim.HW, lim.hw) : ''}` : `<div class="wl-result ng"><div class="wl-rhead">不可</div><div class="wl-rbody">${lim.reasons.map(esc).join('<br>')}</div></div>`}
        ${lim.neoOblique ? `<div class="wl-warn">neo 離陸：斜め後方の風（背風＋横風）はエンジン制限あり。${esc(LIMITS.neoToEngineRef)} で要確認（この範囲は OK と表示しません）。Flysmart では突風値を平均風の欄に入力。</div>` : ''}
        <div class="wl-fig">${diagram(lim, rwy, ev, w, mv)}</div>
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
      <details class="card wl-card wl-notes"><summary>注記</summary><ul>
        <li>OM の制限はすべて同時に適用。最も厳しい値を表示しています。</li>
        <li>横風（RCAM）は会社の最大値。離陸滑走開始後・着陸決定後の一時的な超過は可（${REV.aom} LIM-AG-OPS）。背風 15kt・Autoland 10kt は AFM LIMITATION で超過不可。</li>
        <li>滑走路状態が混在・3区分で異なる場合は最も悪い値（${REV.aom} LIM-AG-OPS）。PFC は Grooving と同じ扱い。</li>
        <li>AIREP が SNOWTAM より悪いときは機長判断で RWYCC を下げてよい。上げるのは不可。</li>
        <li>確認のタイミング：離陸＝Take-off Clearance 時の風、着陸＝Landing Clearance 時の風。超えていても 500ft AFE までに再確認して以内なら進入継続可（${REV.om} S3-7）。飛行場対空援助業務の飛行場は「Runway is clear」の時。</li>
        <li>横風成分は平均風速、最大風速の通報があればその値（${REV.om} 3-7-1(2)②）。Autoland の風は Tower 通報の Surface Wind 基準（${REV.aom} LIM-AFS）。</li>
        <li>背風 10kt を超える着陸は FLAPS FULL（${REV.aom} LIM-AG-OPS Tailwind Landing）。</li>
        <li>離着陸できない深さ：Dry snow 100mm・Wet snow 30mm・Slush / Standing water 13mm（1区分でも超えれば不可）。</li>
        <li>Route Manual の空港別の制限は未確認です。</li>
      </ul><p class="wl-ref">出典：${REV.aom} ／ ${REV.om} ／ ${REV.oen050} ／ ${REV.oen104}（Attention All Crew）。改訂時は見直しが必要。</p></details>`;

    const q = (id) => document.getElementById(id);
    q('wl-ap').onchange = (e) => { st.icao = e.target.value; st.rwy = null; if (st.wind?.src === 'metar') st.wind = null; render(); };
    q('wl-rwy').onchange = (e) => { st.rwy = e.target.value; render(); };
    q('wl-cc').onchange = (e) => { st.rwycc = Number(e.target.value); render(); };
    root.querySelectorAll('.wl-seg').forEach((g) => g.querySelectorAll('.chip').forEach((b) => { b.onclick = () => { st[g.dataset.k] = b.dataset.v; render(); }; }));
    if (q('wl-al')) q('wl-al').onchange = (e) => { st.autoland = e.target.checked; render(); };
    if (q('wl-ro')) q('wl-ro').onchange = (e) => { st.rollout = e.target.checked; render(); };
    const readIn = () => {
      const dv = q('wl-wd').value.trim().toUpperCase(); const n = (x) => (x.trim() === '' ? null : Number(x));
      st.wind = { dir: dv === '' ? null : dv === 'VRB' ? 'VRB' : norm(Number(dv)) || (Number(dv) === 360 || Number(dv) === 0 ? 360 : null), spd: n(q('wl-ws').value), gust: n(q('wl-wg').value), ref: q('wl-ref').value, src: 'manual', icao: st.icao };
      if (st.wind.dir === 'VRB' || (typeof st.wind.dir === 'number' && Number.isFinite(st.wind.dir))) { /* ok */ } else st.wind.dir = null;
      render();
    };
    ['wl-wd', 'wl-ws', 'wl-wg'].forEach((id) => { q(id).onchange = readIn; });
    q('wl-ref').onchange = readIn;
    q('wl-metar').onclick = () => { st.wind = null; render(); };
    q('wl-clear').onclick = () => { st.wind = { dir: null, spd: null, gust: null, ref: 'mag', src: 'manual', icao: st.icao }; render(); };
  }
  function setup(fn) { ctxFn = fn; }
  window.FBWind = { setup, render, compute, vmax, evaluate, runways, magVar, parseMetarWind, LIMITS };
})();
