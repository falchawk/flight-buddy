// 空港の発着案内（公式サイトが公開している JSON）から、日本の航空会社の便を拾う。
// 取れるのは昨日〜明日程度（空港による）。時刻はその空港の定刻（現地＝日本時間）。
const JP2 = new Set(['JL', 'NH', 'NU', 'RC', 'XM', '3X', 'NQ', 'HD', '6J', '7G', 'FW', 'OC', 'MZ', 'BV', 'BC', 'JH', 'MM', 'GK', 'ZG', 'IJ', 'KZ', 'EH']);
const ICAO3 = { JAL: 'JL', ANA: 'NH', JTA: 'NU', RAC: 'RC', JAR: 'XM', JAC: '3X', AJX: 'NQ', ADO: 'HD', SNJ: '6J', SFJ: '7G', IBX: 'FW', ORC: 'OC', AHX: 'MZ', TOK: 'BV', SKY: 'BC', FDA: 'JH', APJ: 'MM', JJP: 'GK', TZP: 'ZG', SJO: 'IJ', NCA: 'KZ', AKX: 'EH' };
// 那覇の国内線は都市名（英語）だけなので IATA に直す
const OKA_CITY = { AMAMIOSHIMA: 'ASJ', FUKUOKA: 'FUK', HIROSHIMA: 'HIJ', IBARAKI: 'IBR', ISHIGAKI: 'ISG', IWAKUNI: 'IWK', KAGOSHIMA: 'KOJ', KITADAITO: 'KTD', KOBE: 'UKB', KOMATSU: 'KMQ', KUMAMOTO: 'KMJ', KUMEJIMA: 'UEO', MATSUYAMA: 'MYJ', MINAMIDAITO: 'MMD', MIYAKO: 'MMY', MIYAZAKI: 'KMI', 'NAGOYA/CHUBU': 'NGO', NARITA: 'NRT', OKAYAMA: 'OKJ', OKINOERABU: 'OKE', 'OSAKA/ITAMI': 'ITM', 'OSAKA/KANSAI': 'KIX', SAPPORO: 'CTS', SENDAI: 'SDJ', SHIMOJISHIMA: 'SHI', TAKAMATSU: 'TAK', TOKYO: 'HND', YONAGUNI: 'OGN', YORON: 'RNJ', NIIGATA: 'KIJ', SHIZUOKA: 'FSZ', KITAKYUSHU: 'KKJ', NAGASAKI: 'NGS', OITA: 'OIT', TOKUNOSHIMA: 'TKN', KOCHI: 'KCZ', TOKUSHIMA: 'TKS', HYAKURI: 'IBR' };
const UA = { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/124 Safari/537.36', Accept: 'application/json,*/*' };
async function getJson(url) {
  const ac = new AbortController(); const t = setTimeout(() => ac.abort(), 30000);
  try { const r = await fetch(url, { headers: UA, signal: ac.signal }); if (!r.ok) throw new Error(`HTTP ${r.status}`); return JSON.parse((await r.text()).replace(/^\uFEFF/, '')); } finally { clearTimeout(t); }
}
const num = (s) => String(s || '').replace(/^0+(?=\d)/, '');
const hm = (s) => { const m = String(s || '').match(/(\d{1,2}):?(\d{2})/); return m ? `${m[1].padStart(2, '0')}:${m[2]}` : null; };
// 1行 = { c2, num, date, ap(案内の空港IATA), dir:'D'|'A', other(相手IATA), time, type, cs:[便名], intl }

async function haneda() {
  const out = [];
  for (const kind of ['dms', 'int']) for (const dir of ['dep', 'arv']) {
    const d = await getJson(`https://tokyo-haneda.com/app_resource/flight/data/${kind}/hdacf${dir}.json`);
    for (const f of d.flight_info || []) {
      const als = (f['航空会社'] || []).map((a) => ({ c2: ICAO3[a['ＡＬコード']] || null, n: num(a['便名']), c3: a['ＡＬコード'] }));
      const all = als.map((a) => (a.c2 || a.c3) + a.n);
      const sched = f['定刻'] || '';
      const other = dir === 'dep' ? f['行先地空港コード'] : f['出発地空港コード'];
      for (const a of als) {
        if (!a.c2 || !JP2.has(a.c2)) continue;
        out.push({ c2: a.c2, num: a.n, date: sched.slice(0, 10).replace(/\//g, '-'), ap: 'HND', dir: dir === 'dep' ? 'D' : 'A', other, time: hm(sched.slice(11)), type: f['機種コード'] || '', cs: all.filter((x) => x !== a.c2 + a.n), intl: kind === 'int', via: f['経由地空港コード'] || '' });
      }
    }
  }
  return out;
}
async function fukuoka() {
  const d = await getJson('https://www.fukuoka-airport.jp/api/flight_schedule/flight_schedule.json');
  const out = [];
  for (const f of Object.values(d)) {
    const ops = [{ c2: f.airline_2cd, n: num(f.flt_num_no) }, ...(f.share_airlines || []).map((s) => ({ c2: s.airline_2cd, n: num(s.flt_num_no) }))];
    const all = ops.map((o) => o.c2 + o.n);
    for (const o of ops) {
      if (!JP2.has(o.c2)) continue;
      out.push({ c2: o.c2, num: o.n, date: f.flt_ymd, ap: 'FUK', dir: f.deparv_div === 'D' ? 'D' : 'A', other: f.tofrom_cd, time: hm(f.appointed_time), type: '', cs: all.filter((x) => x !== o.c2 + o.n), intl: f.intdom_div === 'I' });
    }
  }
  return out;
}
async function naha() {
  const out = [];
  const nat = await getJson('https://www.naha-airport.co.jp/fis/fis_national.json');
  for (const r of nat.data || []) {
    const c2 = String(r[0]).replace(/\uFEFF/g, '').trim();
    if (!JP2.has(c2)) continue;
    const s = String(r[4] || '');
    out.push({ c2, num: num(r[1]), date: `${s.slice(0, 4)}-${s.slice(4, 6)}-${s.slice(6, 8)}`, ap: 'OKA', dir: r[10] === 'A' ? 'A' : 'D', other: OKA_CITY[String(r[3]).trim()] || String(r[3]).trim(), time: `${s.slice(8, 10)}:${s.slice(10, 12)}`, type: '', cs: [], intl: false });
  }
  const flat = (items, pre = '') => { const o = {}; for (const it of items || []) { if ('value' in it) o[pre + it.id] = it.value; if (it.Item) Object.assign(o, flat(it.Item, pre + it.id + '.')); } return o; };
  const intl = await getJson('https://www.naha-airport.co.jp/fis/fis_internal.json');
  for (const fl of (intl.data && intl.data.FlightList) || []) for (const f of fl.Flight || []) {
    const o = flat(f.Item); const c2 = o['Master.AirlineCd'];
    if (!JP2.has(c2)) continue;
    const y = o.SYMD || '';
    out.push({ c2, num: num(o['Master.FltNumNo']), date: `${y.slice(0, 4)}-${y.slice(4, 6)}-${y.slice(6, 8)}`, ap: 'OKA', dir: o.DA === 'A' ? 'A' : 'D', other: o['Master.AreaCode'], time: hm(o.ST), type: '', cs: [], intl: true });
  }
  return out;
}

// ODPT の当日運航情報（JAL・ANA。全国の空港の出発・到着。国際線を含む）
async function odptLive() {
  const key = process.env.ODPT_TOKEN || process.env.ODPT_CONSUMER_KEY;
  if (!key) throw new Error('ODPT鍵なし');
  const out = []; const strip = (v) => String(v || '').replace(/^odpt\.[A-Za-z]+:/, '');
  const today = new Date(Date.now() + 9 * 3600e3).toISOString().slice(0, 10);
  for (const op of ['JAL', 'ANA']) for (const t of ['Departure', 'Arrival']) {
    const list = await getJson(`https://api.odpt.org/api/v4/odpt:FlightInformation${t}?odpt:operator=odpt.Operator:${op}&acl:consumerKey=${encodeURIComponent(key)}`);
    for (const f of list) {
      const nums = [].concat(f['odpt:flightNumber'] || []).map((x) => String(x).toUpperCase());
      const date = String(f['dc:date'] || '').slice(0, 10) || today;
      for (const n of nums) {
        const m = n.match(/^([A-Z0-9]{2})(\d{1,4})$/); if (!m || !JP2.has(m[1])) continue;
        const dep = t === 'Departure';
        out.push({ c2: m[1], num: num(m[2]), date, ap: strip(dep ? f['odpt:departureAirport'] : f['odpt:arrivalAirport']), dir: dep ? 'D' : 'A',
          other: strip(dep ? f['odpt:destinationAirport'] : f['odpt:originAirport']), time: hm(dep ? f['odpt:scheduledDepartureTime'] : f['odpt:scheduledArrivalTime']),
          type: f['odpt:aircraftType'] || '', cs: nums.filter((x) => x !== n), intl: false, odpt: true });
      }
    }
  }
  return out;
}

async function fetchBoards(log = console.log) {
  const rows = []; const report = [];
  for (const [name, fn] of [['ODPT当日', odptLive], ['HND', haneda], ['FUK', fukuoka], ['OKA', naha]]) {
    try { const r = await fn(); rows.push(...r); report.push(`${name}:${r.length}`); } catch (e) { report.push(`${name}:${e.message}`); }
  }
  log('[boards] ' + report.join(' '));
  return { ok: rows.length > 0, rows, report };
}
module.exports = { fetchBoards };
if (require.main === module) fetchBoards().then((r) => {
  const c = {}; for (const x of r.rows) c[x.c2] = (c[x.c2] || 0) + 1; console.log(c);
  require('fs').writeFileSync('/tmp/boards.json', JSON.stringify(r));
});
