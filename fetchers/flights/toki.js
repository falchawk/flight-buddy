// トキエア（BV）公式の時刻表ページ（https://tokiair.com/schedules/）を読む。
const CITY = { '新潟': 'RJSN', '札幌（丘珠）': 'RJCO', '丘珠': 'RJCO', '名古屋（中部）': 'RJGG', '中部': 'RJGG', '神戸': 'RJBE', '佐渡': 'RJSD', '仙台': 'RJSS', '福島': 'RJSF', '山形': 'RJSC', '花巻': 'RJSI', '富山': 'RJNT' };
const DAYMAP = { 月: 1, 火: 2, 水: 4, 木: 8, 金: 16, 土: 32, 日: 64 };
function ymd(y, m, d) { return `${y}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`; }
async function fetchToki() {
  const r = await fetch('https://tokiair.com/schedules/', { headers: { 'User-Agent': 'Mozilla/5.0' } });
  if (!r.ok) throw new Error(`HTTP ${r.status}`);
  const lines = (await r.text()).replace(/<[^>]*>/g, '\n').split('\n').map((s) => s.replace(/&nbsp;/g, ' ').trim()).filter(Boolean);
  const out = []; let period = [null, null], special = null, days = 127, dep = null, arr = null;
  for (let i = 0; i < lines.length; i++) {
    const l = lines[i];
    let m = l.match(/^(\d{4})年(\d{1,2})月(\d{1,2})日[^～~]*[～~]\s*(\d{4})?年?(\d{1,2})月(\d{1,2})日/);
    if (m && !l.startsWith('運航期間')) { period = [ymd(m[1], m[2], m[3]), ymd(m[4] || m[1], m[5], m[6])]; special = null; continue; }
    if (l.startsWith('運航期間')) {
      const ds = [...l.matchAll(/(?:(\d{4})年)?(\d{1,2})月(\d{1,2})日/g)]; let y = period[0] ? period[0].slice(0, 4) : '2026';
      const list = ds.map((d) => { if (d[1]) y = d[1]; return ymd(y, d[2], d[3]); }).sort();
      special = [list[0], list[list.length - 1]]; continue;
    }
    if (l.startsWith('運航曜日')) { days = /毎日/.test(l) ? 127 : [...l.replace(/^運航曜日：/, '')].reduce((a, c) => a | (DAYMAP[c] || 0), 0) || 127; continue; }
    m = l.match(/^(.+?)\s*✈\s*(.+)$/);
    if (m) { dep = CITY[m[1].trim()] || m[1].trim(); arr = CITY[m[2].trim()] || m[2].trim(); continue; }
    m = l.match(/^TOK\/BV(\d{1,4})$/);
    if (m && /^\d{1,2}:\d{2}$/.test(lines[i + 1] || '') && /^\d{1,2}:\d{2}$/.test(lines[i + 2] || '')) {
      const p = special || period;
      out.push({ number: m[1], depIcao: dep, arrIcao: arr, depTime: lines[i + 1].padStart(5, '0'), arrTime: lines[i + 2].padStart(5, '0'), days, from: p[0], to: p[1] });
      i += 2;
    }
  }
  return { ok: out.length > 0, flights: out, source: 'official', failReason: out.length ? null : '解析0件' };
}
module.exports = { fetchToki };
if (require.main === module) fetchToki().then((r) => console.log(r.flights.length, r.flights.slice(0, 4), r.flights.filter((f) => f.to >= '2026-11-18').length));
