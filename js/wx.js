// METAR/TAF のハイライトと簡易デコード（端末内処理、オフライン可）
(function () {
  const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const GROUP = /^(TEMPO|BECMG|FM\d{6}|PROB\d{2}|NOSIG|RMK)$/;
  const DANGER_WX = /(TS|FZ|SN|GR|GS|FG|SQ|FC|VA|DS|SS|PL|\+)/;
  const WARN_WX = /^(-|VC)?(SH|RA|DZ|BR|HZ|DU|SA|BL|DR)+$/;
  function tokenClass(t) {
    if (GROUP.test(t)) return 'hl-grp';
    let m = t.match(/^(\d{3}|VRB)(\d{2,3})(G(\d{2,3}))?(KT|MPS)$/);
    if (m) {
      const mult = m[5] === 'MPS' ? 1.944 : 1;
      const spd = Number(m[2]) * mult, g = m[4] ? Number(m[4]) * mult : 0;
      const mx = Math.max(spd, g);
      return mx >= 35 ? 'hl-danger' : (mx >= 25 || g) ? 'hl-warn' : '';
    }
    if (/^\d{4}$/.test(t) && !/^\d{4}\/\d{4}$/.test(t)) {
      const v = Number(t); return v < 1600 ? 'hl-danger' : v < 5000 ? 'hl-warn' : '';
    }
    m = t.match(/^(BKN|OVC|VV)(\d{3})(CB|TCU)?$/);
    if (m) { const b = Number(m[2]); if (b <= 5) return 'hl-danger'; if (b <= 10 || m[3]) return 'hl-warn'; return ''; }
    if (/^(FEW|SCT)\d{3}(CB|TCU)$/.test(t)) return 'hl-warn';
    if (/^WS/.test(t)) return 'hl-danger';
    if (/^(\+|-|VC)?[A-Z]{2,8}$/.test(t) && /^(\+|-|VC)?(MI|BC|PR|DR|BL|SH|TS|FZ)?(DZ|RA|SN|SG|IC|PL|GR|GS|UP|BR|FG|FU|VA|DU|SA|HZ|PO|SQ|FC|SS|DS)+$/.test(t)) {
      if (DANGER_WX.test(t) && !/^-(SH)?RA$/.test(t)) return 'hl-danger';
      if (WARN_WX.test(t)) return 'hl-warn';
      return 'hl-warn';
    }
    return '';
  }
  // METAR は旧版（wx-brief main）と同じく本文をそのまま表示（色付けしない）
  function highlight(raw) { return esc(raw); }
  // ---- TAF 表示：wx-brief main public/js/app.js formatTafForDisplay / formatTafForDisplayWithHighlight の移植
  // BECMG / TEMPO / FM / PROB30 / PROB40 の直前で改行し、キーワードだけに色（taf-token-*）。PROB30/40 直後の TEMPO は同じ行。
  const TOKEN_RE = /\b(BECMG|TEMPO|PROB30|PROB40|FM(?=\d))/g;
  const TOKEN_CLASS = { BECMG: 'taf-token-becmg', TEMPO: 'taf-token-tempo', FM: 'taf-token-fm', PROB30: 'taf-token-prob', PROB40: 'taf-token-prob' };
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
    const colorize = (segment, baseOffset) => {
      let out = ''; let cursor = 0;
      for (const tok of found) {
        const relStart = tok.index - baseOffset; const relEnd = tok.end - baseOffset;
        if (relStart < cursor || relStart < 0 || relEnd > segment.length) continue;
        out += esc(segment.slice(cursor, relStart));
        out += `<span class="${TOKEN_CLASS[tok.name] || ''}">${esc(segment.slice(relStart, relEnd))}</span>`;
        cursor = relEnd;
      }
      return out + esc(segment.slice(cursor));
    };
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
  const COVER = { FEW: '少', SCT: '散在', BKN: '多', OVC: '全天', VV: '垂直視程' };
  function decodeMetar(raw) {
    const out = [];
    const toks = String(raw || '').split(/\s+/);
    const clouds = [], wx = [];
    for (const t of toks) {
      if (t === 'TEMPO' || t === 'BECMG' || t === 'NOSIG' || t === 'RMK') break;
      let m;
      if ((m = t.match(/^(\d{3}|VRB)(\d{2,3})(G(\d{2,3}))?KT$/))) out.push(['風', `${m[1] === 'VRB' ? '不定' : m[1] + '°'} ${Number(m[2])}kt${m[4] ? ` 最大瞬間 ${Number(m[4])}kt` : ''}`]);
      else if ((m = t.match(/^(\d{3})V(\d{3})$/))) out.push(['風向変動', `${m[1]}°〜${m[2]}°`]);
      else if (/^\d{4}$/.test(t)) out.push(['視程', t === '9999' ? '10km以上' : `${Number(t)}m`]);
      else if (t === 'CAVOK') out.push(['視程', 'CAVOK']);
      else if ((m = t.match(/^(FEW|SCT|BKN|OVC|VV)(\d{3}|\/\/\/)(CB|TCU|\/\/\/)?$/))) clouds.push(`${COVER[m[1]]}(${m[1]}) ${m[2] === '///' ? '---' : Number(m[2]) * 100 + 'ft'}${m[3] && m[3] !== '///' ? ' ' + m[3] : ''}`);
      else if ((m = t.match(/^(M?\d{2})\/(M?\d{2})$/))) out.push(['気温/露点', `${m[1].replace('M', '-')}℃ / ${m[2].replace('M', '-')}℃`]);
      else if ((m = t.match(/^Q(\d{4})$/))) out.push(['QNH', `${Number(m[1])} hPa（${(Number(m[1]) * 0.02953).toFixed(2)} inHg）`]);
      else if ((m = t.match(/^A(\d{4})$/))) out.push(['QNH', `${m[1].slice(0, 2)}.${m[1].slice(2)} inHg`]);
      else if (tokenClass(t) && /^(\+|-|VC)?[A-Z]{2,8}$/.test(t) && !/^(METAR|SPECI|AUTO|COR)$/.test(t) && !/^R[A-Z]{3}$/.test(t)) wx.push(t);
    }
    if (wx.length) out.push(['天気', wx.join(' ')]);
    if (clouds.length) out.push(['雲', clouds.join(' / ')]);
    const trend = (String(raw).match(/\b(TEMPO|BECMG|NOSIG)\b.*$/) || [])[0];
    if (trend) out.push(['傾向', trend]);
    return out;
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
  window.FBWx = { esc, highlight, tafLines, tafLinesWithWindow, decodeMetar, flightCategory };
})();
