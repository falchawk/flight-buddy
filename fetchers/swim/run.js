#!/usr/bin/env node
// Flight Buddy: SWIM（国交省）をサーバー側（box）で取得する入口。scripts/auto_update.py が15分ごとに呼ぶ。
// 取得コードは wx-brief main（3c60eec）の lib/swimSession.js・fetchers/swim.js・fetchers/swimAip.js をそのまま使う。
//   ログイン: GET /swim/login（XSRF）→ POST /swim/api/login → redirectUrl を辿る
//   認証情報は環境変数 SWIM_USER / SWIM_PASS だけ。ログ・ファイル・パックには一切出さない。
//   Cookie は SWIM_COOKIE_JAR（既定 /workspace/fb-secrets/swim-cookies.json, 600）にだけ保存。
// 取得間隔: 取る部品は scripts/auto_update.py（scripts/schedule.py）が --parts で渡す。
//   毎回（15分）＝ atis・profile（空港プロファイルは SWIM の METAR/TAF 本文を含むので毎回）、
//   6時間ごと（00/06/12/18 JST）＝ notam、1日1回（04:00 JST）＝ aip（AD 2・Lost Comm）。--parts 無しの手動実行は
//   従来どおり「前回から5分未満の部品は取らない」。--force で無視。国内の空港の組が前回と違う部品は必ず取る。
//   同時リクエストは SWIM_MAX_PARALLEL（既定4）まで。
//   AIP は毎回目次（1リクエスト）で各空港の AD 2 PDF の URL（AIRAC 日付入り）を確認し、変わった空港だけ PDF を取り直す
//   （目次が変わった時だけ PDF の ETag を HEAD で確認＝AMDT の差し替えも拾う）。PDF からは Lost Comm に加え
//   AD 2.2（標高・磁気偏差）/ AD 2.12（滑走路）/ AD 2.18（周波数）を解析して AIRPORT タブに使う（fetchers/swim/aipAd2.js）。
//   PDF の取得は1回 AIP_BUDGET_S 秒（既定90秒）まで。残りは次回に回す（初回や AIRAC 切り替え直後だけ）。
// 出力: <out>/swim.json（正規化済み。scripts/swim_staging.py が読む）
'use strict';
const fs = require('fs');
const path = require('path');
const args = process.argv.slice(2);
const opt = (k, d) => { const i = args.indexOf(k); return i >= 0 ? args[i + 1] : d; };
const OUT_DIR = opt('--out', '/workspace/fb-staging/swim');
if (!process.env.AIP_CACHE_DIR) process.env.AIP_CACHE_DIR = path.join(path.dirname(OUT_DIR), 'aip-text'); // AIP AD 2 の PDF 本文キャッシュ（パックには入れない）
const AIRPORTS = (opt('--airports', '') || '').split(',').map((s) => s.trim().toUpperCase()).filter((s) => /^[A-Z]{4}$/.test(s));
const FORCE = args.includes('--force');
const PARTS = opt('--parts', null) === null ? null : new Set(String(opt('--parts', '')).split(',').map((x) => x.trim()).filter(Boolean));
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
  const guard = require('./lib/swimGuard');
  const gst = guard.load();
  if (!gst.seededFromPrev) { guard.seedEverOk(gst, prev); gst.seededFromPrev = now(); }
  const due = (part) => {
    const p = prev[part];
    if (FORCE || !p || !p.fetchedAt) return true;
    const have = new Set(p.airports || []);
    if (AIRPORTS.some((a) => !have.has(a))) return true;
    return Date.now() - Date.parse(p.fetchedAt) >= INTERVAL[part];
  };
  const airportsChanged = (part) => { const p = prev[part]; if (!p || !p.fetchedAt) return true; const have = new Set(p.airports || []); return AIRPORTS.some((a) => !have.has(a)); };
  // --parts を付けたときはその部品だけ（--force でも他部品は増やさない）。--force の鮮度無視は due() 側。
  const parts = ['atis', 'profile', 'notam', 'aip'].filter((p) => (PARTS ? PARTS.has(p) : due(p)));
  // 2026-11-24（航空局からの連絡）：データを返せない空港（exclude）と、エラーを返してから6時間以内の空港（backoff）は
  // 問い合わせない（lib/swimGuard.js。ATIS・空港詳細・NOTAM・AIP の全部品）。止めた空港は前回の成功分を
  // その空港の取得時刻つきで残す（古すぎるかは scripts/swim_staging.py が MAX_AGE_H で判定して、日本語の一言に置き換える）。
  const skippedLog = {};
  const pPrevAt = (part, e) => (e && e.fetchedAt) || (prev[part] && prev[part].fetchedAt) || null;
  // エラーの記録は最後の試行分だけ反映する（全部品が失敗してセッションを作り直した時、1回目の失敗で止めないため）
  let pendingFails = [];
  const fail = (svc, key, code, reason) => { if (guard.isAirportError(code)) pendingFails.push([svc, key, reason]); };
  const failNote = (svc) => guard.skipNote(svc, { kind: 'backoff', until: guard.iso(Date.now() + guard.BACKOFF_H * 3600 * 1000) });
  const run = async () => {
    pendingFails = [];
    const res = {};
    await Promise.all(parts.map(async (part) => {
      const at = now();
      try {
        if (part === 'atis') {
          const supAll = AIRPORTS.filter((i) => swim.ATIS_SUPPORTED_ICAO.has(i));
          const uns = AIRPORTS.filter((i) => !swim.ATIS_SUPPORTED_ICAO.has(i));
          const { allowed: sup, skipped } = guard.split(gst, 'atis', supAll);
          skippedLog.atis = Object.keys(skipped).length;
          const r = sup.length ? await swim.fetchSwimAtisPart(AIRPORTS, sup, uns) : { atis: { ok: false, note: null }, atisByIcao: {} };
          const byIcao = {};
          for (const [i, v] of Object.entries(r.atisByIcao || {})) byIcao[i] = sup.includes(i) ? { ...v, fetchedAt: at } : v;
          if (r.atisErrorCode) for (const i of sup) fail('atis', i, r.atisErrorCode, (r.atis && r.atis.note) || 'ATIS エラー');
          else for (const i of sup) if (byIcao[i] && byIcao[i].ok) guard.markOk(gst, 'atis', i);
          const pb = (prev.atis && prev.atis.byIcao) || {};
          for (const [i, info] of Object.entries(skipped)) {
            const e = pb[i];
            byIcao[i] = e && e.ok ? { ...e, fetchedAt: pPrevAt('atis', e), skipped: info.kind } : { ok: false, text: null, reason: guard.skipNote('atis', info), skipped: info.kind };
          }
          // バッチがエラーの時は、前回の成功分を残す（取得時刻つき）
          if (r.atisErrorCode) for (const i of sup) { const e = pb[i]; if (e && e.ok) byIcao[i] = { ...e, fetchedAt: pPrevAt('atis', e), lastError: r.atis && r.atis.note }; }
          res.atis = { fetchedAt: at, airports: AIRPORTS, ok: Boolean(r.atis && r.atis.ok), merged: true, note: r.atis && r.atis.note, byIcao };
        } else if (part === 'profile') {
          const { allowed, skipped } = guard.split(gst, 'profile', AIRPORTS);
          skippedLog.profile = Object.keys(skipped).length;
          const r = allowed.length ? await swim.fetchAirportProfilesFromSwim(allowed) : { ok: false, byIcao: {}, metarByIcao: {}, tafByIcao: {} };
          const byIcao = {}; const metarByIcao = { ...(r.metarByIcao || {}) }; const tafByIcao = { ...(r.tafByIcao || {}) };
          const pp = prev.profile || {};
          const carry = (i, extra) => {
            const e = (pp.byIcao || {})[i];
            if (!(e && e.ok)) return false;
            byIcao[i] = { ...e, fetchedAt: pPrevAt('profile', e), ...extra };
            if ((pp.metarByIcao || {})[i]) metarByIcao[i] = pp.metarByIcao[i];
            if ((pp.tafByIcao || {})[i]) tafByIcao[i] = pp.tafByIcao[i];
            return true;
          };
          for (const i of allowed) {
            const v = (r.byIcao || {})[i];
            if (v && v.ok) { byIcao[i] = { ...v, fetchedAt: at }; guard.markOk(gst, 'profile', i); } else {
              if (v && v.errCode) fail('profile', i, v.errCode, v.reason);
              if (!carry(i, { lastError: v && v.reason })) byIcao[i] = v && v.errCode && guard.isAirportError(v.errCode) ? { ok: false, reason: failNote('profile') } : (v || { ok: false, reason: 'SWIM 空港詳細を取得できませんでした' });
            }
          }
          for (const [i, info] of Object.entries(skipped)) if (!carry(i, { skipped: info.kind })) byIcao[i] = { ok: false, reason: guard.skipNote('profile', info), skipped: info.kind };
          res.profile = { fetchedAt: at, airports: AIRPORTS, ok: allowed.some((i) => byIcao[i] && byIcao[i].ok && byIcao[i].fetchedAt === at), merged: true, byIcao, metarByIcao, tafByIcao };
        } else if (part === 'notam') {
          const { allowed, skipped } = guard.split(gst, 'notam', AIRPORTS);
          skippedLog.notam = Object.keys(skipped).length;
          const r = allowed.length ? await swim.fetchNotamFromSwim(allowed) : { ok: false, items: [], notesByIcao: {}, errCodeByIcao: {} };
          const pn = prev.notam || {};
          const prevAt = pn.fetchedAtByIcao || {};
          const fetchedAtByIcao = {}; const notesByIcao = { ...(r.notesByIcao || {}) }; const items = [...(r.items || [])];
          const carry = (i) => {
            if (!pn.ok && !(prevAt[i])) return false;
            if ((pn.notesByIcao || {})[i]) return false; // 前回も取れていない
            const t = prevAt[i] || pn.fetchedAt; if (!t) return false;
            items.push(...(pn.items || []).filter((it) => it.icao === i)); fetchedAtByIcao[i] = t; return true;
          };
          for (const i of allowed) {
            const code = (r.errCodeByIcao || {})[i];
            if (code || notesByIcao[i]) { fail('notam', i, code || 'ERROR', notesByIcao[i]); if (carry(i)) delete notesByIcao[i]; else if (guard.isAirportError(code || 'ERROR')) notesByIcao[i] = failNote('notam'); } else { fetchedAtByIcao[i] = at; guard.markOk(gst, 'notam', i); }
          }
          for (const [i, info] of Object.entries(skipped)) if (!carry(i)) notesByIcao[i] = guard.skipNote('notam', info);
          res.notam = { fetchedAt: at, airports: AIRPORTS, ok: Boolean(r.ok), merged: true, note: r.note || null, notesByIcao, fetchedAtByIcao, items };
          // 空域タブ用：FIR（RJJJ）のエンルート・警報 NOTAM（取れなければ前回分を残す）。scope ごとに6時間停止の対象
          const scopes = ['enroute', 'warning'].filter((sc) => !guard.blocked(gst, 'notam', `RJJJ-${sc}`));
          const a = scopes.length === 2 ? await swim.fetchNotamArea(scopes).catch((e) => ({ ok: false, items: [], note: String(e && e.message), scopeErrors: {} })) : { ok: false, items: [], note: 'SWIM 空域NOTAM：エラーのため一時的に問い合わせを止めています', scopeErrors: {} };
          for (const sc of scopes) { const c = (a.scopeErrors || {})[sc]; if (c) fail('notam', `RJJJ-${sc}`, c, a.note); else if (a.ok) guard.markOk(gst, 'notam', `RJJJ-${sc}`); }
          const pa = prev.notam && prev.notam.area;
          res.notam.area = a.ok || !pa ? { fetchedAt: at, ok: a.ok, note: a.note || null, items: a.items } : { ...pa, note: `${a.note || '取得失敗'}（前回分 ${pa.fetchedAt}）`, carriedOver: true };
        } else if (part === 'aip') {
          const prevAip = (prev.aip && prev.aip.byIcao) || {};
          const pf = prev.aip && prev.aip.fetchedAt;
          for (const k of Object.keys(prevAip)) if (prevAip[k] && !prevAip[k].fetchedAt) prevAip[k] = { ...prevAip[k], fetchedAt: pf };
          const { allowed, skipped } = guard.split(gst, 'aip', AIRPORTS);
          skippedLog.aip = Object.keys(skipped).length;
          const r = allowed.length ? await fetchLostCommProceduresByIcao(allowed, prevAip, t0 + AIP_BUDGET_MS) : { ok: false, byIcao: {} };
          const byIcao = { ...(r.byIcao || {}) };
          for (const i of allowed) {
            const v = byIcao[i];
            if (v && v.errCode) { fail('aip', i, v.errCode, v.reason); if (prevAip[i] && prevAip[i].ok) byIcao[i] = { ...prevAip[i], lastError: v.reason }; } else if (v && (v.ok || v.final)) guard.markOk(gst, 'aip', i);
          }
          for (const [i, info] of Object.entries(skipped)) byIcao[i] = prevAip[i] && prevAip[i].ok ? { ...prevAip[i], skipped: info.kind } : { ok: false, text: null, url: null, reason: guard.skipNote('aip', info), skipped: info.kind };
          res.aip = { fetchedAt: at, airports: AIRPORTS, ok: r.ok, merged: true, byIcao };
        }
      } catch (e) {
        res[part] = { fetchedAt: at, airports: AIRPORTS, ok: false, error: `${(e && e.code) || ''} ${(e && e.message) || e}`.trim() };
      }
    }));
    return res;
  };
  let res = await run();
  // 保存済み Cookie のセッションが切れていて全部失敗した時は、1回だけ新規ログインしてやり直す
  // ただし相手のサーバーがエラーを返した（*_RESPONSE_ERROR / *_HTTP_ERROR 等）時はやり直さない（同じエラーを2倍出さない。2026-11-24）
  const serverErr = pendingFails.some(([, , reason]) => !/通信エラー|タイムアウト/.test(String(reason || '')));
  if (parts.length && session.requestCount() > 0 && !serverErr && parts.every((p) => !res[p] || !res[p].ok)) {
    console.log('[SWIM] 全部品が失敗。保存済みセッションを破棄して再ログインします。');
    session.resetSession();
    res = await run();
  }
  for (const p of parts) {
    const r = res[p];
    // 失敗時は前回の成功分を残す（fetchedAt は前回のまま＝古さが画面に出る）
    if (r && (r.ok || r.merged)) out[p] = r; // merged＝止めた空港の前回分・エラー時の前回分を空港ごとに引き継ぎ済み
    else out[p] = prev[p] && prev[p].ok ? { ...prev[p], lastError: (r && (r.error || r.note)) || '取得失敗', lastTriedAt: r && r.fetchedAt } : r;
  }
  session.persistSession();
  for (const [svc, key, reason] of pendingFails) guard.markError(gst, svc, key, reason);
  guard.save(gst);
  fs.writeFileSync(outFile + '.tmp', JSON.stringify(out));
  fs.renameSync(outFile + '.tmp', outFile);
  const n = (p) => (out[p] && out[p].byIcao ? Object.values(out[p].byIcao).filter((x) => x && x.ok).length : 0);
  const T = AIRPORTS.length;
  const ad2N = out.aip && out.aip.byIcao ? Object.values(out.aip.byIcao).filter((x) => x && x.ad2 && (x.ad2.runways || []).length).length : 0;
  const atisT = AIRPORTS.filter((i) => swim.ATIS_SUPPORTED_ICAO.has(i)).length;
  // 1行・空白区切りの key=value（値に空白なし）。auto_update.py がこの行を読む
  // 今回「取れた」部品（AIP は PDF の取得が次回に回った空港が残っていれば未完了）。auto_update.py が次回予定の判定に使う
  const aipPending = out.aip && out.aip.byIcao ? Object.values(out.aip.byIcao).some((x) => x && (x.pending || x.pendingUrl)) : false;
  const okParts = parts.filter((p) => res[p] && res[p].ok && !(p === 'aip' && aipPending));
  console.log(`SWIM OK fetched=${parts.join('+') || 'none'} ok=${okParts.join('+') || 'none'} atis=${n('atis')}/${T} profile=${n('profile')}/${T} notam=${out.notam && out.notam.ok ? out.notam.items.length : 'NG'} aip=${n('aip')}/${T} ad2=${ad2N}/${T} atisSupported=${atisT} req=${session.requestCount()} skipped=${['atis', 'profile', 'notam', 'aip'].map((p) => `${p}:${skippedLog[p] || 0}`).join(',')} time=${((Date.now() - t0) / 1000).toFixed(0)}s`);
})().catch((e) => { console.log(`SWIM FAILED reason=${String((e && e.code) || (e && e.message) || 'error').replace(/\s+/g, '-').slice(0, 40)}`); process.exit(1); });
