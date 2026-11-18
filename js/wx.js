// METAR/TAF の表示（変化群の色・IFR/LIFR の要因だけ赤。端末内処理、オフライン可）
(function () {
  const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  // ---- IFR / LIFR の要因だけ赤にする（風・視程の一般的な強調表示はしない。MVFR も強調しない）
  // 判定は scripts/flightcat.py と同じ：IFR/VFR の境界は日本の航空法（施行規則第5条第4号：地上視程 5,000m・雲高 300m≒1,000ft）、
  // MVFR/LIFR だけ FAA。視程 < 5,000m = IFR / < 1SM(1,609m) = LIFR、シーリング（BKN/OVC/VV）< 1,000ft = IFR / < 500ft = LIFR。
  // 要素ごとに見て、IFR 以下になっている要素だけを赤にする。（旧版は視程の IFR 境界が 3SM=4,828m）
  // 空港別：告示で指定された空港（js/vmc-designated.js の strict。現在 0 件）は 視程 8,000m・雲高 1,500ft(450m) が IFR の境界、
  // MVFR は 8,000m〜5SM・1,500〜3,000ft、LIFR は FAA のまま。それ以外は 5,000m・1,000ft。
  const SM_M = 1609.344, LIFR_CEIL_FT = 500, MVFR_CEIL_FT = 3000, MVFR_VIS_M = 5 * SM_M;
  const STRICT = new Set(((window.FB_VMC && window.FB_VMC.strict) || []).map((x) => String(x).toUpperCase()));
  const NORMAL = { vis: 5000, ceil: 1000, strict: false, text: '航空法 5km/1000ft' };
  const DESIGNATED = { vis: 8000, ceil: 1500, strict: true, text: '告示空港: 8km/1500ft' };
  // 海外空港（ICAO が RJ/RO 以外）は FAA の基準そのまま：IFR は 3SM 未満または 1,000ft 未満（LIFR <1SM/<500ft、MVFR 3〜5SM/1,000〜3,000ft、VFR >5SM かつ >3,000ft）。scripts/flightcat.py と同じ
  const FAA = { vis: 3 * SM_M, ceil: 1000, strict: false, faa: true, text: 'FAA基準' };
  const isForeign = (icao) => !!icao && !/^(RJ|RO)/i.test(String(icao));
  const limitsFor = (icao) => (isForeign(icao) ? FAA : icao && STRICT.has(String(icao).toUpperCase()) ? DESIGNATED : NORMAL);
  function ifrToken(t, prev, lim) {
    const IFR_VIS_M = lim.vis, IFR_CEIL_FT = lim.ceil;
    let m;
    if ((m = t.match(/^(\d{4})M?$/))) return Number(m[1]) < IFR_VIS_M;
    if ((m = t.match(/^(\d{1,2})KM$/))) return Number(m[1]) * 1000 < IFR_VIS_M; // 視程（m）。時刻 dddd/dddd や風は \d{4} だけの形にならない
    if ((m = t.match(/^(M|P)?(\d{1,2})SM$/))) return m[1] !== 'P' && Number(m[2]) * SM_M < IFR_VIS_M;
    if ((m = t.match(/^(M|P)?(\d)\/(\d)SM$/))) return m[1] !== 'P' && ((prev && /^\d$/.test(prev) ? Number(prev) : 0) + Number(m[2]) / Number(m[3])) * SM_M < IFR_VIS_M;
    if ((m = t.match(/^(BKN|OVC|VV)(\d{3})(?:CB|TCU|\/+)?$/))) return Number(m[2]) * 100 < IFR_CEIL_FT;
    return false;
  }
  // 1つの文字列を空白で区切り、IFR/LIFR の要因のトークンだけ <span class="hl-ifr"> にする（RMK 以降は対象外）
  function ifrHtml(text, state) {
    const st = state || { rmk: false, prev: null, lim: NORMAL };
    return String(text).split(/(\s+)/).map((t) => {
      if (!t || /^\s+$/.test(t)) return esc(t);
      if (t === 'RMK') st.rmk = true;
      const hit = !st.rmk && ifrToken(t, st.prev, st.lim || NORMAL);
      st.prev = t;
      return hit ? `<span class="hl-ifr">${esc(t)}</span>` : esc(t);
    }).join('');
  }
  // ---- TAF 表示：wx-brief main public/js/app.js formatTafForDisplay / formatTafForDisplayWithHighlight の移植
  // BECMG / TEMPO / FM / PROB30 / PROB40 の直前で改行し、キーワードだけに色（taf-token-*）。PROB30/40 直後の TEMPO は同じ行。
  const TOKEN_RE = /\b(BECMG|TEMPO|PROB30|PROB40|FM(?=\d))/g;
  const TOKEN_CLASS = { BECMG: 'taf-token-becmg', TEMPO: 'taf-token-tempo', FM: 'taf-token-fm', PROB30: 'taf-token-prob', PROB40: 'taf-token-prob' };
  // 変化群キーワード（BECMG/TEMPO/FM/PROB）を TAF と同じ色にし、それ以外のトークンは IFR/LIFR の要因だけ赤にする。
  // found は全文での位置、baseOffset は segment の全文上の開始位置。TAF の各行（変化群）・METAR の本文と傾向（TEMPO/BECMG）に共通。
  function colorizeText(segment, baseOffset, found, lim) {
    let out = ''; let cursor = 0; const st = { rmk: false, prev: null, lim: lim || NORMAL };
    for (const tok of found) {
      const relStart = tok.index - baseOffset; const relEnd = tok.end - baseOffset;
      if (relStart < cursor || relStart < 0 || relEnd > segment.length) continue;
      out += ifrHtml(segment.slice(cursor, relStart), st);
      out += `<span class="${TOKEN_CLASS[tok.name] || ''}">${esc(segment.slice(relStart, relEnd))}</span>`;
      st.prev = tok.name;
      cursor = relEnd;
    }
    return out + ifrHtml(segment.slice(cursor), st);
  }
  // METAR：本文はそのまま（改行しない）。TEMPO/BECMG は TAF と同じ色、IFR/LIFR の要因だけ赤
  function highlight(raw, icao) {
    const text = String(raw || '').trim();
    const found = []; let m; TOKEN_RE.lastIndex = 0;
    while ((m = TOKEN_RE.exec(text))) found.push({ index: m.index, end: m.index + m[1].length, name: m[1] });
    return colorizeText(text, 0, found, limitsFor(icao));
  }
  function tafRows(text, icao) {
    const found = []; let m; TOKEN_RE.lastIndex = 0;
    while ((m = TOKEN_RE.exec(text))) found.push({ index: m.index, end: m.index + m[1].length, name: m[1] });
    const breakPoints = [0];
    for (let i = 0; i < found.length; i++) {
      const tok = found[i];
      if (tok.name === 'TEMPO' && i > 0) {
        const prev = found[i - 1];
        if ((prev.name === 'PROB30' || prev.name === 'PROB40') && text.slice(prev.end, tok.index).trim() === '') continue;
      }
      if (tok.index > 0) breakPoints.push(tok.index);
    }
    const lim = limitsFor(icao);
    const colorize = (segment, baseOffset) => colorizeText(segment, baseOffset, found, lim);
    return { found, rows: breakPoints.map((start, i) => {
      const end = i + 1 < breakPoints.length ? breakPoints[i + 1] : text.length;
      const segment = text.slice(start, end);
      const leadingWs = segment.length - segment.replace(/^\s+/, '').length;
      const trimmed = segment.trim();
      return { trimmed, start: start + leadingWs, html: colorize(trimmed, start + leadingWs) };
    }) };
  }
  function tafLines(raw, icao) {
    const text = String(raw || '');
    if (!text) return '';
    const { found, rows } = tafRows(text, icao);
    if (!found.length) return esc(text);
    return rows.map((r) => r.html).join('\n');
  }
  // DUTY 用：ETD/ETA ± バッファの時間帯に重なる変化群の行を taf-line-relevant で強調（旧版と同じ判定）
  function tafLinesWithWindow(raw, win, icao) {
    const text = String(raw || '');
    if (!text) return '';
    const { found, rows } = tafRows(text, icao);
    if (!found.length) return esc(text);
    const has = win && Number.isFinite(win.startEpoch) && Number.isFinite(win.endEpoch) && Number.isFinite(win.anchorEpoch);
    const lead = (seg) => { const mm = seg.match(/^(BECMG|TEMPO|PROB30|PROB40|FM(?=\d))/); return mm ? mm[1] : null; };
    const resolve = (day, hour, minute, anchorEpoch) => {
      if (!Number.isFinite(day) || !Number.isFinite(hour) || !Number.isFinite(anchorEpoch)) return null;
      const anchor = new Date(anchorEpoch);
      const c = [-1, 0, 1].map((dm) => {
        let year = anchor.getUTCFullYear(); let month = anchor.getUTCMonth() + dm;
        if (month < 0) { month += 12; year -= 1; }
        if (month > 11) { month -= 12; year += 1; }
        return Date.UTC(year, month, day, hour, minute || 0, 0, 0);
      });
      c.sort((x, y) => Math.abs(x - anchorEpoch) - Math.abs(y - anchorEpoch));
      return c[0];
    };
    let headerEnd = null;
    if (has) { const hm = rows[0].trimmed.match(/(\d{2})(\d{2})\/(\d{2})(\d{2})/); if (hm) headerEnd = resolve(+hm[3], +hm[4], 0, win.anchorEpoch); }
    const overlaps = (aS, aE, bS, bE) => aS <= bE && bS <= aE;
    return rows.map((r, i) => {
      let relevant = false; const tk = lead(r.trimmed);
      if (has && tk) {
        let s0 = null; let e0 = null;
        if (tk === 'FM') {
          const fm = r.trimmed.match(/^FM(\d{2})(\d{2})(\d{2})/);
          if (fm) {
            s0 = resolve(+fm[1], +fm[2], +fm[3], win.anchorEpoch); e0 = headerEnd;
            for (let j = i + 1; j < rows.length; j++) {
              const nt = lead(rows[j].trimmed);
              if (nt === 'FM') { const n = rows[j].trimmed.match(/^FM(\d{2})(\d{2})(\d{2})/); if (n) e0 = resolve(+n[1], +n[2], +n[3], win.anchorEpoch); break; }
              if (nt === 'BECMG') { const b = rows[j].trimmed.match(/(\d{2})(\d{2})\/(\d{2})(\d{2})/); if (b) e0 = resolve(+b[1], +b[2], 0, win.anchorEpoch); break; }
            }
          }
        } else {
          const rm = r.trimmed.match(/(\d{2})(\d{2})\/(\d{2})(\d{2})/);
          if (rm) { s0 = resolve(+rm[1], +rm[2], 0, win.anchorEpoch); e0 = resolve(+rm[3], +rm[4], 0, win.anchorEpoch); }
        }
        if (s0 !== null && e0 !== null) relevant = overlaps(s0, e0, win.startEpoch, win.endEpoch);
      }
      return `<div class="taf-line${relevant ? ' taf-line-relevant' : ''}">${r.html}</div>`;
    }).join('');
  }
  // フライトカテゴリ（pack に fltCat が無い時用）。scripts/flightcat.py の classify_metar と同じ判定。判定できなければ null。
  function visM(raw) {
    const t = ` ${raw} `; let m;
    if (/\bCAVOK\b/.test(t)) return 10000;
    if ((m = t.match(/\s(M|P)?(\d{1,2})(?:\s(\d)\/(\d))?SM\b/))) return (Number(m[2]) + (m[3] && m[4] ? Number(m[3]) / Number(m[4]) : 0)) * SM_M;
    if ((m = t.match(/\s(M|P)?(\d)\/(\d)SM\b/))) return Number(m[2]) / Number(m[3]) * SM_M;
    if ((m = t.match(/\s(?:\d{3}|VRB)\d{2}(?:G\d{2})?(?:KT|MPS)\s+(?:\d{3}V\d{3}\s+)?(\d{4})M?\b/))) return Number(m[1]);
    if ((m = t.match(/\s(?:\d{3}|VRB)\d{2}(?:G\d{2})?(?:KT|MPS)\s+(?:\d{3}V\d{3}\s+)?(\d{1,2})KM\b/))) return Number(m[1]) * 1000;
    return null;
  }
  function ceilFt(raw) {
    if (/\bCAVOK\b/.test(raw)) return null;
    const hs = [...String(raw).matchAll(/\b(?:BKN|OVC|VV)(\d{3})\b/g)].map((x) => Number(x[1]) * 100);
    return hs.length ? Math.min(...hs) : null;
  }
  function flightCategory(raw0, icao) {
    if (!raw0) return null;
    const raw = String(raw0).split(/\s(?:TEMPO|BECMG|NOSIG|RMK)\b/)[0];   // トレンド(TEMPO/BECMG/NOSIG)と RMK 以降は判定に使わない
    const lim = limitsFor(icao), v = visM(raw), c = ceilFt(raw);
    const fv = v == null ? null : v < SM_M ? 'LIFR' : v < lim.vis ? 'IFR' : v <= MVFR_VIS_M ? 'MVFR' : 'VFR';
    const fc = c == null ? null : c < LIFR_CEIL_FT ? 'LIFR' : c < lim.ceil ? 'IFR' : c <= MVFR_CEIL_FT ? 'MVFR' : 'VFR';
    const rank = { LIFR: 0, IFR: 1, MVFR: 2, VFR: 3 };
    if (!fv || !fc) return fv || fc;
    return rank[fv] <= rank[fc] ? fv : fc;
  }
  window.FBWx = { esc, highlight, tafLines, tafLinesWithWindow, flightCategory, limitsFor, isForeign };
})();
