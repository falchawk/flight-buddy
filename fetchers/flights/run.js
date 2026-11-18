// Flight Buddy: 旧 wx-brief の時刻表取得（fetchers/flights.js。wx-brief main 由来）＋ODPT全件・空港の発着案内・トキエア・rararakt（最終手段）を実行し、
// 全社の時刻表を /workspace/fb-staging/flights.json（リポジトリ外）に書き出す。scripts/auto_update.py が呼ぶ。
// 鍵は ODPT_CONSUMER_KEY（推奨）か ODPT_TOKEN。値はログにもファイルにも出さない。
const fs = require('fs');
if (!process.env.ODPT_TOKEN && process.env.ODPT_CONSUMER_KEY) process.env.ODPT_TOKEN = process.env.ODPT_CONSUMER_KEY;
const { AIRLINES, fetchAllAirlineSchedules, fetchAnaOfficialSchedule } = require('./fetchers/flights');
const { fetchOdptFull } = require('./odpt_full');
// rararakt.com は第三者がまとめたデータ（OAG由来の部分を含む）。公開サイトのパックへ丸ごと再配布しないよう既定で除外。
// ユーザーが許可した時だけ FB_ALLOW_RARARAKT=1 で使う。
// 2026-11-18 ユーザー承認：他の出典に無い便だけの最終手段として使う（FB_ALLOW_RARARAKT=0 で無効）。
const ALLOW_RARA = process.env.FB_ALLOW_RARARAKT !== '0';
const { fetchBoards } = require('./boards');
const { fetchToki } = require('./toki');
const { fetchRara } = require('./rara');
const now = () => new Date().toISOString().replace(/\.\d+Z$/, 'Z');
(async () => {
  const t0 = Date.now();
  const out = process.argv[2] || '/workspace/fb-staging/flights.json';
  let prev = null;
  try { prev = JSON.parse(fs.readFileSync(out, 'utf8')); } catch (e) { /* 初回 */ }
  const byAirline = await fetchAllAirlineSchedules();
  const ts = now();
  for (const [code, v] of Object.entries(byAirline)) {
    if (v.ok && v.source === 'rararakt') {
      byAirline[code] = { ok: false, flights: [], source: null, airline: v.airline,
        failReason: `${v.failReason ? v.failReason + ' ／ ' : ''}rararakt.com の分は別枠（rara）で出典表示つきで収録` };
    }
    const r = byAirline[code];
    r.flights = (r.flights || []).map((f) => ({ ...f, number: String(f.number).replace(/^[A-Z]+/i, '').replace(/^0+(?=\d)/, '') }));
    if (r.ok && r.flights.length) r.fetchedAt = ts;
    else if (prev && prev.byAirline && prev.byAirline[code] && prev.byAirline[code].ok && (prev.byAirline[code].flights || []).length
      && prev.byAirline[code].source !== 'rararakt') {
      // 今回失敗した会社は前回成功分を残す（古さは fetchedAt で分かる）
      byAirline[code] = { ...prev.byAirline[code], staleReason: r.failReason || '今回の取得に失敗' };
    }
  }
  // ODPT 全件（JAL・ANA。国際線・グループ会社・コードシェア番号を含む）。失敗時は前回分を残す。
  let odptFull = await fetchOdptFull().catch((e) => ({ ok: false, rows: [], airports: {}, report: [String(e && e.message)] }));
  if (odptFull.ok) {
    odptFull.fetchedAt = ts;
    // 取得に失敗した（会社・出発空港）は前回成功分の行で補う（便が日によって消えないように）
    const failed = new Set(odptFull.failed || []);
    if (failed.size && prev && prev.odptFull && Array.isArray(prev.odptFull.rows)) {
      const add = prev.odptFull.rows.filter((r) => failed.has(`${r.op}|${r.dep}`));
      odptFull.rows.push(...add); odptFull.report.push(`prevFill=${add.length}(${failed.size}件失敗)`);
    }
  }
  else if (prev && prev.odptFull && prev.odptFull.ok) odptFull = { ...prev.odptFull, staleReason: odptFull.report.join(' ') };
  // ANA 公式PDF（ODPTに無い路線・運航会社の補完用。ODPTがあっても取る）
  let anaPdf = await fetchAnaOfficialSchedule().catch((e) => ({ ok: false, flights: [], failReason: String(e && e.message) }));
  if (anaPdf.ok) { anaPdf.fetchedAt = ts; anaPdf.flights = anaPdf.flights.map((f) => ({ ...f, number: String(f.number).replace(/^0+(?=\d)/, '') })); }
  else if (prev && prev.anaPdf && prev.anaPdf.ok) anaPdf = { ...prev.anaPdf, staleReason: anaPdf.failReason };
  const keepPrev = (name, cur) => (cur.ok ? { ...cur, fetchedAt: ts } : (prev && prev[name] && prev[name].ok ? { ...prev[name], staleReason: cur.failReason || (cur.report || []).join(' ') } : cur));
  const boards = keepPrev('boards', await fetchBoards().catch((e) => ({ ok: false, rows: [], report: [String(e && e.message)] })));
  const toki = keepPrev('toki', await fetchToki().catch((e) => ({ ok: false, flights: [], failReason: String(e && e.message) })));
  const rara = ALLOW_RARA ? keepPrev('rara', await fetchRara().catch((e) => ({ ok: false, flights: [], failReason: String(e && e.message) }))) : { ok: false, flights: [], failReason: '無効' };
  const res = { schema: 'flight-buddy-flights/1', fetchedAt: ts, odpt: !!process.env.ODPT_TOKEN,
    airlines: AIRLINES.map((a) => ({ code: a.code, icao3: a.icao3, iata2: a.iata2, name: a.name, officialUrl: a.officialUrl, operationNote: a.operationNote || null })),
    byAirline, odptFull, anaPdf, boards, toki, rara };
  fs.writeFileSync(out + '.tmp', JSON.stringify(res));
  fs.renameSync(out + '.tmp', out);
  const sum = Object.entries(byAirline).map(([k, v]) => `${k}:${v.ok ? (v.flights || []).length : 'NG'}${v.source ? '(' + v.source + (v.staleReason ? ',prev' : '') + ')' : ''}`).join(' ');
  console.log(`FLIGHTS OK odpt=${res.odpt ? 'yes' : 'no'} ${sum} boards=${boards.ok ? boards.rows.length : 'NG'} toki=${toki.ok ? toki.flights.length : 'NG'} rara=${rara.ok ? rara.flights.length : 'NG'} anaPdf=${anaPdf.ok ? anaPdf.flights.length : 'NG'} odptRows=${odptFull.ok ? odptFull.rows.length + (odptFull.staleReason ? '(prev)' : '') : 'NG'} time=${((Date.now() - t0) / 1000).toFixed(0)}s`);
})().catch((e) => { console.error('FLIGHTS FAILED', e && e.message); process.exit(1); });
