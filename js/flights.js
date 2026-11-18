// FLIGHTS：パックの時刻表（flights.json）だけで便名検索する。通信はしない（見つからない時の外部リンクはオンライン時のみ表示）。
(function (root) {
  // ICAO3 / 呼び方 → IATA2
  const ALIAS = { JAL: 'JL', ANA: 'NH', JTA: 'NU', SFJ: '7G', SNJ: '6J', SNA: '6J', ADO: 'HD', SKY: 'BC', FDA: 'JH', IBX: 'FW',
    APJ: 'MM', JJP: 'GK', ORC: 'OC', AMX: 'MZ', AHX: 'MZ', RAC: 'RC', ZIP: 'ZG', ZIPAIR: 'ZG', TZP: 'ZG', SJO: 'IJ', AJX: 'NQ', JAC: '3X', JAR: 'XM', TOK: 'BV', NCA: 'KZ', AKX: 'EH' };
  const C3 = new Set(['CUK', 'DAK']);
  const carrierOf = (num) => (C3.has(num.slice(0, 3)) ? num.slice(0, 3) : num.slice(0, 2));
  const DAY_BIT = [64, 1, 2, 4, 8, 16, 32]; // getUTCDay(): 日=0

  function parseQuery(raw) {
    const t = String(raw || '').normalize('NFKC').trim().toUpperCase().replace(/\s|-/g, '');
    if (!t) return null;
    const m = t.match(/^([A-Z]{3}(?=\d)|[A-Z][A-Z0-9](?=\d)|\d[A-Z](?=\d))?(\d{1,4})$/);
    if (!m) return { bad: true };
    let c = m[1] || null;
    if (c && c.length === 3 && !C3.has(c)) c = ALIAS[c] || c;
    return { carrier: c, number: m[2].replace(/^0+(?=\d)/, '') };
  }

  // 便の運航判定（日付 'YYYY-MM-DD'）。true=運航 / false=運航なし
  function operatesOn(row, date) {
    if (!date) return true;
    const [, , , , , , days, from, to] = row;
    if (from && date < from) return false;
    if (to && date > to) return false;
    const dow = new Date(date + 'T00:00:00Z').getUTCDay();
    return !days || (days & DAY_BIT[dow]) !== 0;
  }

  // q: 文字列, opts: {carrier:'ALL'|IATA2, date, exact}
  function search(data, q, opts = {}) {
    const rows = (data && data.rows) || [];
    const pq = parseQuery(q);
    if (!pq || pq.bad) return { query: pq, results: [] };
    const scope = opts.carrier && opts.carrier !== 'ALL' ? opts.carrier : null;
    const out = [];
    for (const r of rows) {
      const c = carrierOf(r[0]), n = r[0].slice(c.length);
      if (scope && c !== scope) continue;
      if (pq.carrier && c !== pq.carrier) continue;
      if (opts.exact ? n !== pq.number : !n.includes(pq.number)) continue;
      out.push(r);
    }
    const date = opts.date || null;
    // 完全一致 → 本日運航 → 会社・番号・時刻
    const nn = (r) => r[0].slice(carrierOf(r[0]).length);
    out.sort((a, b) => ((nn(b) === pq.number) - (nn(a) === pq.number))
      || (operatesOn(b, date) - operatesOn(a, date))
      || carrierOf(a[0]).localeCompare(carrierOf(b[0])) || (parseInt(nn(a), 10) - parseInt(nn(b), 10)) || a[3].localeCompare(b[3]));
    return { query: pq, results: out };
  }

  function daysText(d) {
    if (!d || d === 127) return '毎日';
    return ['月', '火', '水', '木', '金', '土', '日'].filter((_, i) => d & (1 << i)).join('');
  }
  const api = { parseQuery, search, operatesOn, daysText, ALIAS, carrierOf };
  if (typeof module !== 'undefined') module.exports = api; else root.FBFlights = api;
})(typeof window !== 'undefined' ? window : globalThis);
