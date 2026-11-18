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
  function highlight(raw) {
    return esc(raw).split(/\s+/).map((t) => { const c = tokenClass(t); return c ? `<span class="${c}">${t}</span>` : t; }).join(' ');
  }
  // TAFは変化群ごとに改行して表示
  function tafLines(raw) {
    const toks = String(raw || '').trim().split(/\s+/);
    const lines = []; let cur = [];
    toks.forEach((t, i) => {
      if (i > 0 && /^(TEMPO|BECMG|FM\d{6}|PROB\d{2})$/.test(t) && !(cur.length === 1 && /^PROB\d{2}$/.test(cur[0]))) { lines.push(cur); cur = []; }
      cur.push(t);
    });
    if (cur.length) lines.push(cur);
    return lines.map((l) => `<span class="tline">${highlight(l.join(' '))}</span>`).join('');
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
  window.FBWx = { esc, highlight, tafLines, decodeMetar, flightCategory };
})();
