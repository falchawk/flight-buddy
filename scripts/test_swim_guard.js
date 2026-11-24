#!/usr/bin/env node
// SWIM の空港ごとの問い合わせ制御（fetchers/swim/lib/swimGuard.js と run.js）を、模擬 fetch で確かめる（実際の SWIM には出ない）。
//  - 初期の除外空港（RJBH など）には問い合わせない
//  - エラーを返した空港は6時間問い合わせない（前回の成功分を取得時刻つきで残す）
//  - 一度も成功していない空港がエラーを返したら除外リストへ
//  - 相手がエラーを返した時はセッションを作り直して全部やり直さない
//  - ATIS のバッチがエラーなら対象空港を6時間止める
'use strict';
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');

const ROOT = path.join(__dirname, '..');
const RUN = path.join(ROOT, 'fetchers', 'swim', 'run.js');
const STUB = path.join(__dirname, 'fixtures', 'swim_fetch_stub.js');
const guard = require(path.join(ROOT, 'fetchers', 'swim', 'lib', 'swimGuard.js'));
const td = fs.mkdtempSync(path.join(os.tmpdir(), 'swimguard-'));
const out = path.join(td, 'swim');
const state = path.join(td, 'state.json');
const jar = path.join(td, 'jar', 'cookies.json');
const log = path.join(td, 'calls.log');
const cfgOn = path.join(td, 'swim-on.json');
fs.writeFileSync(cfgOn, JSON.stringify({ profileEnabled: true }));
let cfgPath = cfgOn;
fs.mkdirSync(out, { recursive: true });
fs.mkdirSync(path.dirname(jar), { recursive: true });
fs.writeFileSync(jar, JSON.stringify({ loggedIn: true, cookies: [{ name: 'S', value: 'stub', domain: 'web.swim.mlit.go.jp', hostOnly: true }] }));
const old = '2026-11-24T08:00:00Z';
fs.writeFileSync(path.join(out, 'swim.json'), JSON.stringify({
  profile: { fetchedAt: old, ok: true, airports: ['RJTT', 'RJAA'], byIcao: { RJTT: { ok: true, metarText: 'OLD' }, RJAA: { ok: true, metarText: 'METAR RJAA OLD' } }, metarByIcao: {}, tafByIcao: {} },
  notam: { fetchedAt: old, ok: true, airports: ['RJTT', 'RJAA'], notesByIcao: {}, items: [{ id: 'X', icao: 'RJAA', text: 'old notam' }], area: { ok: true, fetchedAt: old, items: [] } },
  atis: { fetchedAt: old, ok: true, airports: ['RJTT', 'RJAA'], byIcao: { RJTT: { ok: true, text: 'ATIS RJTT Z' }, RJAA: { ok: true, text: 'ATIS RJAA Z' } } },
}));
const AIRPORTS = 'RJTT,RJAA,RJBH,RJXX';
const run = (parts, plan) => {
  fs.writeFileSync(log, '');
  const env = { ...process.env, SWIM_USER: 'stub', SWIM_PASS: 'stub', SWIM_COOKIE_JAR: jar, FB_SWIM_AIRPORT_STATE: state, SWIM_STUB_LOG: log, SWIM_STUB_PLAN: JSON.stringify(plan || {}), FB_SWIM_CONFIG: cfgPath };
  const so = execFileSync('node', ['-r', STUB, RUN, '--out', out, '--airports', AIRPORTS, '--parts', parts], { env, encoding: 'utf8' });
  return { line: so.trim().split('\n').filter((l) => l.startsWith('SWIM ')).pop(), calls: fs.readFileSync(log, 'utf8').trim().split('\n').filter(Boolean), swim: JSON.parse(fs.readFileSync(path.join(out, 'swim.json'), 'utf8')), st: JSON.parse(fs.readFileSync(state, 'utf8')) };
};

// 1回目：RJAA（成功歴あり）と RJXX（成功歴なし）が空港詳細でエラー
let r = run('profile,notam', { profileErr: ['RJAA', 'RJXX'] });
const prof1 = r.calls.filter((c) => c.startsWith('profile ')).map((c) => c.split(' ')[1]).sort();
assert.deepStrictEqual(prof1, ['RJAA', 'RJTT', 'RJXX'], 'RJBH（初期の除外）には問い合わせない／エラーでもやり直さない');
assert.ok(!r.calls.some((c) => c.startsWith('OTHER')), r.calls.join('\n'));
assert.ok(r.st.exclude.profile.RJBH && r.st.exclude.profile.RJXX && !r.st.exclude.profile.RJAA);
assert.ok(r.st.backoff.profile.RJAA && r.st.backoff.profile.RJXX);
const until = Date.parse(r.st.backoff.profile.RJAA.until) - Date.parse(r.st.backoff.profile.RJAA.at);
assert.strictEqual(until, 6 * 3600 * 1000);
assert.strictEqual(r.swim.profile.byIcao.RJAA.ok, true, 'RJAA は前回の成功分を残す');
assert.strictEqual(r.swim.profile.byIcao.RJAA.fetchedAt, old, '前回分には前回の取得時刻');
assert.strictEqual(r.swim.profile.byIcao.RJTT.metarText.includes('241000Z'), true);
assert.ok(/提供していない/.test(r.swim.profile.byIcao.RJBH.reason), r.swim.profile.byIcao.RJBH.reason);
assert.ok(!/HTTP|exception/.test(r.swim.profile.byIcao.RJXX.reason || ''), '画面向けはエラーの羅列でなく日本語の一言');
assert.strictEqual(r.calls.filter((c) => c.startsWith('notam ')).length, 4 + 2, 'NOTAM は全空港＋空域2件（空港詳細の除外は NOTAM には効かない）');
console.log('run1', r.line);

// 2回目：止めた空港には問い合わせない。NOTAM で RJTT がエラー
r = run('profile,notam', { notamErr: ['RJTT'] });
const prof2 = r.calls.filter((c) => c.startsWith('profile ')).map((c) => c.split(' ')[1]);
assert.deepStrictEqual(prof2, ['RJTT']);
assert.ok(r.st.backoff.notam.RJTT);
console.log('run2', r.line);

// 3回目：NOTAM の RJTT は6時間止まる
r = run('notam', {});
const n3 = r.calls.filter((c) => c.startsWith('notam ')).map((c) => c.split(' ')[1]);
assert.ok(!n3.includes('RJTT'), n3.join(','));
assert.ok(r.swim.notam.fetchedAtByIcao.RJTT, 'RJTT の NOTAM は前回分を取得時刻つきで残す');

// ATIS：バッチがエラー → 対象（ここでは ATIS 対応の RJTT・RJAA）を6時間止め、次は問い合わせない
r = run('atis', { atisErr: true });
assert.strictEqual(r.calls.filter((c) => c.startsWith('atis ')).length, 1, 'ATIS のエラーでやり直さない');
assert.ok(r.st.backoff.atis.RJTT && r.st.backoff.atis.RJAA);
assert.strictEqual(r.swim.atis.byIcao.RJTT.text, 'ATIS RJTT Z', '前回の ATIS を残す');
r = run('atis', {});
assert.strictEqual(r.calls.filter((c) => c.startsWith('atis ')).length, 0);
console.log('run5', r.line);

// 6時間後は問い合わせる
const st = JSON.parse(fs.readFileSync(state, 'utf8'));
for (const svc of Object.keys(st.backoff)) for (const k of Object.keys(st.backoff[svc])) st.backoff[svc][k].until = '2000-01-01T00:00:00Z';
fs.writeFileSync(state, JSON.stringify(st));
r = run('atis,profile', {});
assert.strictEqual(r.calls.filter((c) => c.startsWith('atis ')).length, 1);
assert.deepStrictEqual(r.calls.filter((c) => c.startsWith('profile ')).map((c) => c.split(' ')[1]).sort(), ['RJAA', 'RJTT'], 'RJXX は除外のまま、RJAA は再開');

// 空港詳細の停止（config/swim.json profileEnabled=false）：backoff が切れていても、エラー歴が無くても一切問い合わせない
for (const cfg of [path.join(ROOT, 'config', 'swim.json'), path.join(td, 'missing.json')]) {
  cfgPath = cfg;
  r = run('atis,profile,notam', {});
  assert.strictEqual(r.calls.filter((c) => c.startsWith('profile ')).length, 0, `profile disabled (${cfg})`);
  assert.ok(r.calls.some((c) => c.startsWith('atis ')) && r.calls.some((c) => c.startsWith('notam ')), 'ATIS・NOTAM は従来どおり');
  for (const i of ['RJTT', 'RJAA', 'RJXX', 'RJBH']) {
    assert.strictEqual(r.swim.profile.byIcao[i].ok, false);
    assert.strictEqual(r.swim.profile.byIcao[i].reason, '空港詳細（SWIM）は現在停止中です。');
  }
  assert.deepStrictEqual(r.swim.profile.metarByIcao, {});
}
assert.strictEqual(JSON.parse(fs.readFileSync(path.join(ROOT, 'config', 'swim.json'), 'utf8')).profileEnabled, false, '航空局の了承までは false のまま');
// swim.js 側の二重の止め具（run.js を通らない呼び出しでも問い合わせない）
process.env.FB_SWIM_CONFIG = path.join(ROOT, 'config', 'swim.json');
process.env.SWIM_USER = 'x'; process.env.SWIM_PASS = 'x';
let fetched = 0; const realFetch = globalThis.fetch; globalThis.fetch = async () => { fetched++; throw new Error('no'); };
const swimMod = require(path.join(ROOT, 'fetchers', 'swim', 'swim.js'));
swimMod.fetchAirportProfilesFromSwim(['RJTT', 'RJAA']).then((pr) => {
  assert.strictEqual(fetched, 0);
  assert.strictEqual(pr.disabled, true);
  globalThis.fetch = realFetch;
  console.log('profile disabled OK');
});

// skipNote / split
const g = guard.load(path.join(td, 'none.json'));
assert.deepStrictEqual(Object.keys(g.exclude.profile).sort(), ['RJBH', 'RJNN', 'RJTD', 'RJTX', 'ROHF']);
assert.deepStrictEqual(guard.split(g, 'profile', ['RJTT', 'RJBH']).allowed, ['RJTT']);
fs.rmSync(td, { recursive: true, force: true });
console.log('test_swim_guard OK');
