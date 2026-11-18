// ODPT FlightSchedule（JAL・ANA。国際線・グループ会社・コードシェア番号を含む）を、1000件上限に掛からないよう
// 出発空港ごとに分けて全件取得する。鍵は環境変数のみ。URL・鍵はログに出さない。
const BASE = 'https://api.odpt.org/api/v4/';
const DAYS = { Monday: 1, Tuesday: 2, Wednesday: 4, Thursday: 8, Friday: 16, Saturday: 32, Sunday: 64 };
const id = (v) => (typeof v === 'string' ? v.replace(/^odpt\.[A-Za-z]+:/, '') : null);

async function get(path, key) {
  for (let i = 0; i < 3; i++) {
    try {
      const ac = new AbortController(); const t = setTimeout(() => ac.abort(), 30000);
      const r = await fetch(`${BASE}${path}${path.includes('?') ? '&' : '?'}acl:consumerKey=${encodeURIComponent(key)}`, { signal: ac.signal });
      clearTimeout(t);
      if (r.ok) return await r.json();
      if (r.status < 500 && r.status !== 429) throw new Error(`HTTP ${r.status}`);
    } catch (e) { if (i === 2) throw new Error(e.name === 'AbortError' ? 'timeout' : e.message); }
    await new Promise((s) => setTimeout(s, 1000 * (i + 1)));
  }
  throw new Error('retry');
}

async function pool(items, n, fn) {
  const out = []; let i = 0;
  await Promise.all(Array.from({ length: n }, async () => { while (i < items.length) { const k = i++; out[k] = await fn(items[k]); } }));
  return out;
}

// 返り値: { ok, airports: {IATA: 日本語名}, rows: [{op, airline, nums[], dep, arr, std, sta, type, days, from, to, note}], report }
async function fetchOdptFull({ operators = ['JAL', 'ANA'], horizonDays = 75, log = console.log } = {}) {
  const key = process.env.ODPT_TOKEN || process.env.ODPT_CONSUMER_KEY;
  if (!key) return { ok: false, rows: [], airports: {}, report: ['ODPT鍵なし'] };
  const t0 = Date.now();
  const apList = await get('odpt:Airport', key);
  const airports = {};
  for (const a of apList) { const c = id(a['owl:sameAs']); if (c) airports[c] = (a['dc:title'] || (a['odpt:airportTitle'] || {}).ja || '').trim(); }
  const today = new Date(Date.now() + 9 * 3600e3).toISOString().slice(0, 10);
  const until = new Date(Date.now() + (9 * 3600e3) + horizonDays * 86400e3).toISOString().slice(0, 10);
  const merged = new Map(); const report = []; let errors = 0; const failed = [];
  for (const op of operators) {
    let items = 0;
    const res = await pool(Object.keys(airports), 8, async (ap) => {
      try { return await get(`odpt:FlightSchedule?odpt:operator=odpt.Operator:${op}&odpt:originAirport=odpt.Airport:${ap}`, key); } catch (e) { errors++; failed.push(`${op}|${ap}`); return []; }
    });
    for (const list of res) for (const it of list || []) {
      items++;
      const dep = id(it['odpt:originAirport']); const arr = id(it['odpt:destinationAirport']);
      const day = DAYS[id(it['odpt:calendar'])] || 127; // 曜日以外のカレンダーは毎日扱い
      for (const o of it['odpt:flightScheduleObject'] || []) {
        const from = (o['odpt:isValidFrom'] || '').slice(0, 10) || null; const to = (o['odpt:isValidTo'] || '').slice(0, 10) || null;
        if (to && to < today) continue; if (from && from > until) continue;
        const nums = [].concat(o['odpt:flightNumber'] || []).map((s) => String(s).toUpperCase().replace(/\s+/g, ''));
        if (!nums.length) continue;
        const std = o['odpt:originTime'] || null; const sta = o['odpt:destinationTime'] || null;
        const k = [nums[0], dep, arr, std, sta, from, to].join('|');
        const cur = merged.get(k);
        if (cur) { cur.days |= day; for (const n of nums) if (!cur.nums.includes(n)) cur.nums.push(n); continue; }
        merged.set(k, { op, airline: id(o['odpt:airline']) || op, nums, dep, arr, std, sta, type: o['odpt:aircraftType'] || '',
          days: day, from, to, note: (o['odpt:note'] && (o['odpt:note'].ja || o['odpt:note'].en)) || '' });
      }
    }
    report.push(`${op}:${items}item`);
  }
  const rows = [...merged.values()];
  report.push(`rows=${rows.length} err=${errors} ${((Date.now() - t0) / 1000).toFixed(0)}s`);
  log('[ODPT full] ' + report.join(' '));
  return { ok: rows.length > 0, rows, airports, report, errors, failed };
}
module.exports = { fetchOdptFull };
if (require.main === module) fetchOdptFull().then((r) => {
  require('fs').writeFileSync('/tmp/odpt_full.json', JSON.stringify(r));
  const air = {}; for (const x of r.rows) air[x.airline] = (air[x.airline] || 0) + 1;
  const pre = {}; for (const x of r.rows) for (const n of x.nums) { const p = n.match(/^[A-Z0-9]{2}/)[0]; pre[p] = (pre[p] || 0) + 1; }
  console.log(air); console.log(JSON.stringify(pre));
});
