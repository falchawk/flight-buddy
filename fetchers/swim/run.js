#!/usr/bin/env node
// Flight Buddy: SWIM（国交省）をサーバー側（box）で取得する入口。scripts/auto_update.py が10分ごとに呼ぶ。
// 取得コードは wx-brief main（3c60eec）の lib/swimSession.js・fetchers/swim.js・fetchers/swimAip.js をそのまま使う。
//   ログイン: GET /swim/login（XSRF）→ POST /swim/api/login → redirectUrl を辿る
//   認証情報は環境変数 SWIM_USER / SWIM_PASS だけ。ログ・ファイル・パックには一切出さない。
//   Cookie は SWIM_COOKIE_JAR（既定 /workspace/fb-secrets/swim-cookies.json, 600）にだけ保存。
// 取得間隔（SWIM への負荷を抑える）: ATIS 10分 / 空港プロファイル(METAR・TAF・運用情報) 30分 / NOTAM 30分 / AIP(Lost Comm) 24時間
//   ※ 空港が増えた時はその部品をすぐ取り直す。--force で全部取り直し。
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
const INTERVAL = { atis: 9.5 * MIN, profile: 29.5 * MIN, notam: 29.5 * MIN, aip: 24 * 60 * MIN };
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
          const r = await fetchLostCommProceduresByIcao(AIRPORTS);
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
  console.log(`SWIM OK parts=${parts.join('+') || 'none(not due)'} atis=${n('atis')} profile=${n('profile')} notam=${out.notam && out.notam.ok ? out.notam.items.length : 'NG'} aip=${n('aip')} / ${AIRPORTS.length}空港 time=${((Date.now() - t0) / 1000).toFixed(0)}s`);
})().catch((e) => { console.log('SWIM FAILED', (e && e.code) || '', (e && e.message) || e); process.exit(1); });
