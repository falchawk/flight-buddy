#!/usr/bin/env node
// Flight Buddy: SWIM（国交省）をサーバー側（box）で取得する入口。scripts/auto_update.py が10分ごとに呼ぶ。
// 取得コードは wx-brief main（3c60eec）の lib/swimSession.js・fetchers/swim.js・fetchers/swimAip.js をそのまま使う。
//   ログイン: GET /swim/login（XSRF）→ POST /swim/api/login → redirectUrl を辿る
//   認証情報は環境変数 SWIM_USER / SWIM_PASS だけ。ログ・ファイル・パックには一切出さない。
//   Cookie は SWIM_COOKIE_JAR（既定 /workspace/fb-secrets/swim-cookies.json, 600）にだけ保存。
// 取得間隔: 自動更新（10分ごと）の毎回、ATIS・空港プロファイル(METAR・TAF・運用情報)・NOTAM・AIP(Lost Comm) を全部取る。
//   ただし手動実行が重なっても SWIM を叩きすぎないよう、前回から5分未満の部品は取らない。--force で無視。
//   同時リクエストは SWIM_MAX_PARALLEL（既定4）まで。
//   AIP は毎回目次（1リクエスト）で各空港の AD 2 PDF の URL（AIRAC 日付入り）を確認し、変わった空港だけ PDF を取り直す。
//   PDF の取得は1回 AIP_BUDGET_S 秒（既定90秒）まで。残りは次回に回す（初回や AIRAC 切り替え直後だけ）。
// 出力: <out>/swim.json（正規化済み。scripts/swim_staging.py が読む）
'use strict';
const fs = require('fs');
const path = require('path');
const args = process.argv.slice(2);
const opt = (k, d) => { const i = args.indexOf(k); return i >= 0 ? args[i + 1] : d; };
const OUT_DIR = opt('--out', '/workspace/fb-staging/swim');
const AIRPORTS = (opt('--airports', '') || '').split(',').map((s) => s.trim().toUpperCase()).filter((s) => /^[A-Z]{4}$/.test(s));
const FORCE = args.includes('--force');
const MIN = 60 * 1000;
const INTERVAL = { atis: 5 * MIN, profile: 5 * MIN, notam: 5 * MIN, aip: 5 * MIN };
const AIP_BUDGET_MS = (Number(process.env.AIP_BUDGET_S) || 90) * 1000;
const now = () => new Date().toISOString().replace(/\.\d+Z$/, 'Z');

(async () => {
  const t0 = Date.now();
  fs.mkdirSync(OUT_DIR, { recursive: true });
  const outFile = path.join(OUT_DIR, 'swim.json');
  let prev = {};
  try { prev = JSON.parse(fs.readFileSync(outFile, 'utf8')); } catch (_e) { /* 初回 */ }
  const envSet = Boolean(process.env.SWIM_USER && process.env.SWIM_PASS);
  const out = { schema: 'fb-swim/1', envSet, airports: AIRPORTS, generatedAt: now(), atis: prev.atis || null, profile: prev.profile || null, notam: prev.notam || null, aip: prev.aip || null, log: [] };
  if (!envSet) {
    out.note = 'SWIM未設定：環境変数 SWIM_USER / SWIM_PASS が未設定です。';
    fs.writeFileSync(outFile, JSON.stringify(out));
    console.log('SWIM SKIP env-missing');
    return;
  }
  const session = require('./lib/swimSession');
  const swim = require('./swim');
  const { fetchLostCommProceduresByIcao } = require('./swimAip');
  const due = (part) => {
    const p = prev[part];
    if (FORCE || !p || !p.fetchedAt) return true;
    const have = new Set(p.airports || []);
    if (AIRPORTS.some((a) => !have.has(a))) return true;
    return Date.now() - Date.parse(p.fetchedAt) >= INTERVAL[part];
  };
  const parts = ['atis', 'profile', 'notam', 'aip'].filter(due);
  const run = async () => {
    const res = {};
    await Promise.all(parts.map(async (part) => {
      const at = now();
      try {
        if (part === 'atis') {
          const sup = AIRPORTS.filter((i) => swim.ATIS_SUPPORTED_ICAO.has(i));
          const uns = AIRPORTS.filter((i) => !swim.ATIS_SUPPORTED_ICAO.has(i));
          const r = await swim.fetchSwimAtisPart(AIRPORTS, sup, uns);
          res.atis = { fetchedAt: at, airports: AIRPORTS, ok: Boolean(r.atis && r.atis.ok), note: r.atis && r.atis.note, byIcao: r.atisByIcao };
        } else if (part === 'profile') {
          const r = await swim.fetchAirportProfilesFromSwim(AIRPORTS);
          res.profile = { fetchedAt: at, airports: AIRPORTS, ok: r.ok, byIcao: r.byIcao, metarByIcao: r.metarByIcao, tafByIcao: r.tafByIcao };
        } else if (part === 'notam') {
          const r = await swim.fetchNotamFromSwim(AIRPORTS);
          res.notam = { fetchedAt: at, airports: AIRPORTS, ok: r.ok, note: r.note || null, notesByIcao: r.notesByIcao || {}, items: r.items || [] };
        } else if (part === 'aip') {
          const prevAip = (prev.aip && prev.aip.byIcao) || {};
          const pf = prev.aip && prev.aip.fetchedAt;
          for (const k of Object.keys(prevAip)) if (prevAip[k] && !prevAip[k].fetchedAt) prevAip[k] = { ...prevAip[k], fetchedAt: pf };
          const r = await fetchLostCommProceduresByIcao(AIRPORTS, prevAip, t0 + AIP_BUDGET_MS);
          res.aip = { fetchedAt: at, airports: AIRPORTS, ok: r.ok, byIcao: r.byIcao };
        }
      } catch (e) {
        res[part] = { fetchedAt: at, airports: AIRPORTS, ok: false, error: `${(e && e.code) || ''} ${(e && e.message) || e}`.trim() };
      }
    }));
    return res;
  };
  let res = await run();
  // 保存済み Cookie のセッションが切れていて全部失敗した時は、1回だけ新規ログインしてやり直す
  if (parts.length && parts.every((p) => !res[p] || !res[p].ok)) {
    console.log('[SWIM] 全部品が失敗。保存済みセッションを破棄して再ログインします。');
    session.resetSession();
    res = await run();
  }
  for (const p of parts) {
    const r = res[p];
    // 失敗時は前回の成功分を残す（fetchedAt は前回のまま＝古さが画面に出る）
    if (r && r.ok) out[p] = r;
    else out[p] = prev[p] && prev[p].ok ? { ...prev[p], lastError: (r && (r.error || r.note)) || '取得失敗', lastTriedAt: r && r.fetchedAt } : r;
  }
  session.persistSession();
  fs.writeFileSync(outFile + '.tmp', JSON.stringify(out));
  fs.renameSync(outFile + '.tmp', outFile);
  const n = (p) => (out[p] && out[p].byIcao ? Object.values(out[p].byIcao).filter((x) => x && x.ok).length : 0);
  const T = AIRPORTS.length;
  const atisT = AIRPORTS.filter((i) => swim.ATIS_SUPPORTED_ICAO.has(i)).length;
  // 1行・空白区切りの key=value（値に空白なし）。auto_update.py がこの行を読む
  console.log(`SWIM OK fetched=${parts.join('+') || 'none'} atis=${n('atis')}/${T} profile=${n('profile')}/${T} notam=${out.notam && out.notam.ok ? out.notam.items.length : 'NG'} aip=${n('aip')}/${T} atisSupported=${atisT} req=${session.requestCount()} time=${((Date.now() - t0) / 1000).toFixed(0)}s`);
})().catch((e) => { console.log(`SWIM FAILED reason=${String((e && e.code) || (e && e.message) || 'error').replace(/\s+/g, '-').slice(0, 40)}`); process.exit(1); });
