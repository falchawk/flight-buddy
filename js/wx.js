// METAR/TAF の表示（変化群の色・IFR/LIFR の要因だけ赤。端末内処理、オフライン可）
(function () {
  const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  // ---- IFR / LIFR の要因だけ赤にする（風・視程の一般的な強調表示はしない。MVFR も強調しない）
  // 判定は旧版（wx-brief main lib/flightCategory.js）と同じ：視程 < 3sm(4828m) = IFR / < 1sm(1609m) = LIFR、
  // シーリング（BKN/OVC/VV）< 1000ft = IFR / < 500ft = LIFR。要素ごとに見て、IFR 以下になっている要素だけを赤にする。
  const SM_M = 1609.344;
  function ifrToken(t, prev) {
    let m;
    if (/^\d{4}$/.test(t)) return Number(t) < 3 * SM_M; // 視程（m）。時刻 dddd/dddd や風は \d{4} だけの形にならない
    if ((m = t.match(/^(M|P)?(\d{1,2})SM$/))) return m[1] !== 'P' && Number(m[2]) < 3;
    if ((m = t.match(/^(M|P)?(\d)\/(\d)SM$/))) return m[1] !== 'P' && (prev && /^\d$/.test(prev) ? Number(prev) : 0) + Number(m[2]) / Number(m[3]) < 3;
    if ((m = t.match(/^(BKN|OVC|VV)(\d{3})(?:CB|TCU)?$/))) return Number(m[2]) * 100 < 1000;
    return false;
  }
  // 1つの文字列を空白で区切り、IFR/LIFR の要因のトークンだけ <span class="hl-ifr"> にする（RMK 以降は対象外）
  function ifrHtml(text, state) {
    const st = state || { rmk: false, prev: null };
    return String(text).split(/(\s+)/).map((t) => {
      if (!t || /^\s+$/.test(t)) return esc(t);
      if (t === 'RMK') st.rmk = true;
      const hit = !st.rmk && ifrToken(t, st.prev);
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
  function colorizeText(segment, baseOffset, found) {
    let out = ''; let cursor = 0; const st = { rmk: false, prev: null };
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
  function highlight(raw) {
    const text = String(raw || '').trim();
    const found = []; let m; TOKEN_RE.lastIndex = 0;
    while ((m = TOKEN_RE.exec(text))) found.push({ index: m.index, end: m.index + m[1].length, name: m[1] });
    return colorizeText(text, 0, found);
  }
  function tafRows(text) {
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
    const colorize = (segment, baseOffset) => colorizeText(segment, baseOffset, found);
    return { found, rows: breakPoints.map((start, i) => {
      const end = i + 1 < breakPoints.length ? breakPoints[i + 1] : text.length;
      const segment = text.slice(start, end);
      const leadingWs = segment.length - segment.replace(/^\s+/, '').length;
      const trimmed = segment.trim();
      return { trimmed, start: start + leadingWs, html: colorize(trimmed, start + leadingWs) };
    }) };
  }
  function tafLines(raw) {
    const text = String(raw || '');
    if (!text) return '';
    const { found, rows } = tafRows(text);
    if (!found.length) return esc(text);
    return rows.map((r) => r.html).join('\n');
  }
  // DUTY 用：ETD/ETA ± バッファの時間帯に重なる変化群の行を taf-line-relevant で強調（旧版と同じ判定）
  function tafLinesWithWindow(raw, win) {
    const text = String(raw || '');
    if (!text) return '';
    const { found, rows } = tafRows(text);
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
  // 簡易フライトカテゴリ（APIにfltCatが無い時用、FAA基準）
  function flightCategory(raw) {
    let vis = 10, ceil = 99999;
    String(raw || '').split(/\s+/).forEach((t) => {
      let m;
      if (/^\d{4}$/.test(t)) vis = Math.min(vis, Number(t) / 1609);
      if (t === 'CAVOK') vis = 10;
      if ((m = t.match(/^(BKN|OVC|VV)(\d{3})/))) ceil = Math.min(ceil, Number(m[2]) * 100);
    });
    if (ceil < 500 || vis < 1) return 'LIFR';
    if (ceil < 1000 || vis < 3) return 'IFR';
    if (ceil <= 3000 || vis <= 5) return 'MVFR';
    return 'VFR';
  }
  window.FBWx = { esc, highlight, tafLines, tafLinesWithWindow, flightCategory };
})();
