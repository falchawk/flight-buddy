// rararakt.com/flightnbr/data.js（清水桂太氏の個人ツール「FLTNBR by ららら」のデータ）。
// ユーザー承認（2026-11-18）のもと、他の出典（ODPT・各社公式・空港の発着案内）に無い便だけの最終手段として使う。
const vm = require('vm');
const KEY2 = { ANA: 'NH', JAL: 'JL', AJX: 'NQ', SKY: 'BC', ADO: 'HD', SNA: '6J', JTA: 'NU', RAC: 'RC', FDA: 'JH', IBX: 'FW', ORC: 'OC', MZ: 'MZ', APJ: 'MM', JJP: 'GK', SJO: 'IJ', ZIP: 'ZG', NCA: 'KZ', SFJ: '7G', NCA2: 'CUK', DAK: 'DAK' };
async function fetchRara() {
  let r, err;
  for (let i = 0; i < 4 && !r; i++) {
    try { r = await fetch('https://rararakt.com/flightnbr/data.js', { headers: { 'User-Agent': 'Mozilla/5.0' }, signal: AbortSignal.timeout(30000) }); if (!r.ok) { err = new Error(`HTTP ${r.status}`); r = null; } } catch (e) { err = e; }
    if (!r) await new Promise((s) => setTimeout(s, 3000 * (i + 1)));
  }
  if (!r) throw err;
  const ctx = { window: {} }; vm.runInNewContext(await r.text(), ctx, { timeout: 5000 });
  const D = ctx.window.FLIGHT_DATA;
  const today = new Date(Date.now() + 9 * 3600e3).toISOString().slice(0, 10);
  const sch = D.schedules.find((s) => s.from <= today && today <= s.until) || D.schedules[D.schedules.length - 1];
  const ap = (n) => (D.airports[n] && D.airports[n].icao) || (D.airports[n] && D.airports[n].iata) || n;
  const out = [];
  for (const f of sch.flights) {
    const c2 = KEY2[f[0]]; if (!c2) continue; // 日本の会社のみ
    const flags = f[4] || 0;
    out.push({ c2, number: String(f[1]), dep: ap(f[2]), arr: ap(f[3]), via: f[5] ? ap(f[5]) : '', depTime: f[6] || '', arrTime: f[7] || '',
      cargo: !!(flags & 2), uncertain: !!(flags & 1), suspended: !!(flags & 4), note: (sch.caveats || {})[`${f[0]}${f[1]}`] || '' });
  }
  const codes = {}; for (const a of Object.values(D.airports)) if (a.iata && a.icao) codes[a.iata] = a.icao;
  return { ok: out.length > 0, codes, version: D.version, build: D.build, schedule: { name: sch.name, from: sch.from, until: sch.until }, source: D.source, flights: out };
}
module.exports = { fetchRara };
if (require.main === module) fetchRara().then((r) => { const c = {}; r.flights.forEach((f) => { c[f.c2] = (c[f.c2] || 0) + 1; }); console.log(r.version, r.schedule, c, r.flights.filter((f) => f.c2 === 'ZG').slice(0, 2)); });
