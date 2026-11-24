// Flight Buddy: SWIM の空港ごとの問い合わせ制御（2026-11-24 航空局からの連絡を受けて追加）。
//  - exclude : そのサービスがデータを返せない空港。問い合わせない（永続。手で外すまで）。
//              初期値は空港詳細（profile）の RJBH/RJNN/RJTD/RJTX/ROHF。加えて「一度も成功したことが無い空港」が
//              エラーを返したら自動でここへ入る。
//  - backoff : エラーを返した空港は BACKOFF_H（6時間）そのサービスへ問い合わせない。
//  - everOk  : サービスごと・空港ごとの最終成功時刻（exclude の判定に使う）。
// 状態は FB_SWIM_AIRPORT_STATE（既定 /workspace/fb-staging/swim-airport-state.json）。再起動をまたいで残る。
// 読み書きは run.js の実行中だけ（auto_update.py / wx_live_poller.py とも swim ロックの中で run.js を呼ぶので同時に書かない）。
// 認証情報は扱わない。
'use strict';
const fs = require('fs');
const path = require('path');

const STATE_PATH = process.env.FB_SWIM_AIRPORT_STATE || '/workspace/fb-staging/swim-airport-state.json';
const BACKOFF_H = 6;
const SEED_EXCLUDE = { profile: ['RJBH', 'RJNN', 'RJTD', 'RJTX', 'ROHF'] };
const SERVICES = ['atis', 'profile', 'notam', 'aip'];
// 空港に依らない失敗（ログイン・設定）は空港の backoff にしない
const NON_AIRPORT_CODES = new Set(['ENV_MISSING', 'LOGIN_PAGE_FETCH_FAILED', 'LOGIN_RESPONSE_UNREADABLE', 'LOGIN_FAILED', 'NO_REDIRECT_URL', 'REDIRECT_FAILED', 'LOGIN_TIMEOUT', 'PROFILE_DISABLED']);

const iso = (ms) => new Date(ms).toISOString().replace(/\.\d+Z$/, 'Z');

function blank() {
  const st = { schema: 'fb-swim-airport-state/1', backoffHours: BACKOFF_H, exclude: {}, backoff: {}, everOk: {} };
  for (const s of SERVICES) { st.exclude[s] = {}; st.backoff[s] = {}; st.everOk[s] = {}; }
  return st;
}

function load(p = STATE_PATH, nowMs = Date.now()) {
  let st;
  try { st = JSON.parse(fs.readFileSync(p, 'utf8')); } catch (_e) { st = null; }
  if (!st || typeof st !== 'object') {
    st = blank();
    for (const [svc, list] of Object.entries(SEED_EXCLUDE)) {
      for (const icao of list) st.exclude[svc][icao] = { since: iso(nowMs), reason: 'SWIM がこの空港のデータを返さない（初期リスト）' };
    }
  }
  for (const k of ['exclude', 'backoff', 'everOk']) { st[k] = st[k] || {}; for (const s of SERVICES) st[k][s] = st[k][s] || {}; }
  st.backoffHours = BACKOFF_H;
  return st;
}

function save(st, p = STATE_PATH) {
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p + '.tmp', JSON.stringify(st, null, 1));
  fs.renameSync(p + '.tmp', p);
}

// 問い合わせてよいか。null＝よい。止める時は { kind, reason, until }
function blocked(st, svc, key, nowMs = Date.now()) {
  const ex = st.exclude[svc] && st.exclude[svc][key];
  if (ex) return { kind: 'excluded', reason: ex.reason || null, until: null };
  const b = st.backoff[svc] && st.backoff[svc][key];
  if (b && Date.parse(b.until) > nowMs) return { kind: 'backoff', reason: b.reason || null, until: b.until };
  return null;
}

function split(st, svc, keys, nowMs = Date.now()) {
  const allowed = []; const skipped = {};
  for (const k of keys) { const b = blocked(st, svc, k, nowMs); if (b) skipped[k] = b; else allowed.push(k); }
  return { allowed, skipped };
}

function markOk(st, svc, key, nowMs = Date.now()) {
  st.everOk[svc][key] = iso(nowMs);
  delete st.backoff[svc][key];
}

function isAirportError(code) { return !NON_AIRPORT_CODES.has(code || ''); }

function markError(st, svc, key, reason, nowMs = Date.now()) {
  const prev = st.backoff[svc][key];
  st.backoff[svc][key] = { at: iso(nowMs), until: iso(nowMs + BACKOFF_H * 3600 * 1000), reason: String(reason || 'エラー').slice(0, 160), count: ((prev && prev.count) || 0) + 1 };
  if (!st.everOk[svc][key] && !st.exclude[svc][key]) {
    st.exclude[svc][key] = { since: iso(nowMs), reason: `一度も取得に成功していない空港がエラーを返した（${String(reason || '').slice(0, 80)}）` };
  }
}

// 画面に出す日本語（エラーの羅列はしない）
function skipNote(svc, info) {
  const name = { atis: 'ATIS', profile: '空港詳細', notam: 'NOTAM', aip: 'AIP' }[svc] || svc;
  if (info.kind === 'excluded') return `SWIM の${name}はこの空港のデータを提供していないため、問い合わせていません。`;
  const t = info.until ? new Date(Date.parse(info.until) + 9 * 3600 * 1000).toISOString().slice(11, 16) : '';
  return `SWIM の${name}がエラーを返したため、${t ? `${t} JST まで` : 'しばらく'}この空港への問い合わせを止めています。`;
}

// 状態ファイルを初めて作る時だけ、既存の swim.json から「成功したことがある空港」を引き継ぐ
// （これが無いと、今エラーの空港がすべて「一度も成功していない」扱いで exclude に入ってしまう）
function seedEverOk(st, prev, nowMs = Date.now()) {
  const put = (svc, key, t) => { if (!st.everOk[svc][key]) st.everOk[svc][key] = t || iso(nowMs); };
  const p = prev || {};
  for (const [i, v] of Object.entries((p.atis && p.atis.byIcao) || {})) if (v && v.ok) put('atis', i, v.fetchedAt || p.atis.fetchedAt);
  for (const [i, v] of Object.entries((p.profile && p.profile.byIcao) || {})) if (v && v.ok) put('profile', i, v.fetchedAt || p.profile.fetchedAt);
  if (p.notam && p.notam.ok) {
    const bad = p.notam.notesByIcao || {};
    for (const i of p.notam.airports || []) if (!bad[i]) put('notam', i, p.notam.fetchedAt);
    if (p.notam.area && p.notam.area.ok) { put('notam', 'RJJJ-enroute', p.notam.area.fetchedAt); put('notam', 'RJJJ-warning', p.notam.area.fetchedAt); }
  }
  for (const [i, v] of Object.entries((p.aip && p.aip.byIcao) || {})) if (v && (v.ok || v.final)) put('aip', i, v.fetchedAt || p.aip.fetchedAt);
}

// SWIM 空港詳細（プロファイル）のスイッチ（config/swim.json の profileEnabled）。true と明記されている時だけ問い合わせてよい。
const SWIM_CONFIG = process.env.FB_SWIM_CONFIG || path.join(__dirname, '..', '..', '..', 'config', 'swim.json');
const PROFILE_DISABLED_NOTE = '空港詳細（SWIM）は現在停止中です。';
function profileEnabled(p = SWIM_CONFIG) {
  try { return JSON.parse(fs.readFileSync(p, 'utf8')).profileEnabled === true; } catch (_e) { return false; }
}

function summary(st, nowMs = Date.now()) {
  const out = {};
  for (const s of SERVICES) {
    const ex = Object.keys(st.exclude[s]).length;
    const bo = Object.values(st.backoff[s]).filter((b) => Date.parse(b.until) > nowMs).length;
    out[s] = `${ex}/${bo}`;
  }
  return out;
}

module.exports = { STATE_PATH, BACKOFF_H, SEED_EXCLUDE, load, save, blocked, split, markOk, markError, isAirportError, skipNote, summary, seedEverOk, iso, profileEnabled, PROFILE_DISABLED_NOTE, SWIM_CONFIG };
