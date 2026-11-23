#!/usr/bin/env node
// レーダー LIVE の合成規則：パックのコマは残す／実況は巻き戻さない／予想は時刻順に差し込む
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const code = fs.readFileSync(path.join(__dirname, '../js/radar-live.js'), 'utf8');
const sandbox = {
  module: { exports: {} },
  exports: {},
  window: undefined,
  Date, Math, JSON, Number, Boolean, String, Array, Object, RegExp, Error,
  parseInt, isNaN, parseFloat, Infinity, NaN,
  setTimeout, clearTimeout, setInterval, clearInterval,
  console, Uint8Array, Buffer,
};
sandbox.globalThis = sandbox;
vm.runInNewContext(code, sandbox);
const L = sandbox.module.exports;

function fr(time, kind, live) {
  const d = new Date(time);
  const off = kind === '予想' ? 15 : 0;
  return {
    time, kind,
    label: L.offsetLabel(d, kind, off),
    layout: 'layers',
    live: !!live,
    images: [{ file: 'map.png' }, { file: live ? 'live.png' : `pack-${time}.png` }, { file: 'border.png' }],
  };
}

// URL / 時刻
assert.strictEqual(L.ts14(new Date('2026-11-23T03:25:00Z')), '20261123032500');
assert.strictEqual(
  L.rainUrl('rain', 'rain', new Date('2026-11-23T03:25:00Z'), 0, '00'),
  'https://www.jma.go.jp/bosai/rain/data/rain/20261123032500/rain_20261123032500_f00_a00.png'
);
assert.strictEqual(L.timeUrl('rain'), 'https://www.jma.go.jp/bosai/rain/data/rain/time.json');
assert.strictEqual(L.timeUrl('thunder'), 'https://www.jma.go.jp/bosai/rain/data/thunder/time.json');
assert.strictEqual(L.areaCode('a09'), '09');
assert.strictEqual(L.areaCode('00'), '00');
assert.ok(L.isLiveProduct('nowcast') && L.isLiveProduct('thunder'));
assert.ok(!L.isLiveProduct('rainfc') && !L.isLiveProduct('kosa'));

function slotSig(s) { return `${s.offMin},${s.ft},${L.ts14(s.time)}`; }
const slots = L.forecastSlots(new Date('2026-11-23T03:15:00Z'), 5);
assert.strictEqual(slots.map(slotSig).join('|'), '15,3,20261123033000|45,9,20261123040000');
const slotsTh = L.forecastSlots(new Date('2026-11-23T03:10:00Z'), 10);
assert.strictEqual(slotsTh.map(slotSig).join('|'), '20,2,20261123033000|50,5,20261123040000');
assert.strictEqual(L.offsetLabel(new Date('2026-11-23T03:25:00Z'), '実況', 0), '実況 12:25 JST');
assert.strictEqual(L.offsetLabel(new Date('2026-11-23T03:30:00Z'), '予想', 15), '予想 +15分 12:30 JST');

const plan = L.plannedRequests('nowcast', 'a09', new Date('2026-11-23T03:25:00Z'));
assert.strictEqual(plan.length, 3);
assert.strictEqual(plan[0].kind, '実況');
assert.ok(plan[0].url.endsWith('rain_20261123032500_f00_a09.png'));
assert.ok(plan[1].url.endsWith('rain_20261123032500_f01_a09.png')); // +5min = ft 1（12:25の次の :30）
assert.ok(plan[2].url.endsWith('rain_20261123032500_f07_a09.png')); // +35min = ft 7（13:00）
// 全地域を対象にする（地域を絞り込まない）。URL の area だけが変わる。
const plan00 = L.plannedRequests('nowcast', 'a00', new Date('2026-11-23T03:25:00Z'));
assert.ok(plan00[0].url.endsWith('_a00.png'));

assert.strictEqual(L.shouldFetch(Date.parse('2026-11-23T03:25:00Z'), Date.parse('2026-11-23T03:15:00Z'), NaN), true);
assert.strictEqual(L.shouldFetch(Date.parse('2026-11-23T03:15:00Z'), Date.parse('2026-11-23T03:15:00Z'), NaN), false, 'equal stays pack, no fetch');
assert.strictEqual(L.shouldFetch(Date.parse('2026-11-23T03:10:00Z'), Date.parse('2026-11-23T03:15:00Z'), NaN), false, 'older JMA must not fetch');
assert.strictEqual(L.shouldFetch(Date.parse('2026-11-23T03:25:00Z'), Date.parse('2026-11-23T03:15:00Z'), Date.parse('2026-11-23T03:25:00Z')), false, 'already have this live');
assert.strictEqual(L.shouldFetch(Date.parse('2026-11-23T03:30:00Z'), Date.parse('2026-11-23T03:15:00Z'), Date.parse('2026-11-23T03:25:00Z')), true);

const pack = [
  fr('2026-11-23T00:30:00Z', '実況'),
  fr('2026-11-23T01:00:00Z', '実況'),
  fr('2026-11-23T03:00:00Z', '実況'),
  fr('2026-11-23T03:15:00Z', '実況'),
  fr('2026-11-23T03:30:00Z', '予想'),
  fr('2026-11-23T04:00:00Z', '予想'),
];
assert.strictEqual(pack.length, 6);
assert.strictEqual(L.defaultObsIndex(pack), 3);
assert.strictEqual(L.latestObsTime(pack), Date.parse('2026-11-23T03:15:00Z'));

// 新しい実況を間に挿入し、同じ時刻の予想は LIVE 予想で差し替え。パックの古い実況は残る。
const live = {
  receivedAt: '2026-11-23T03:28:00Z',
  latestTime: '2026-11-23T03:25:00Z',
  frames: [
    { time: '2026-11-23T03:25:00Z', kind: '実況', label: '実況 12:25 JST', url: 'live-0325.png', receivedAt: '2026-11-23T03:28:00Z' },
    { time: '2026-11-23T03:30:00Z', kind: '予想', label: '予想 +5分 12:30 JST', offMin: 5, url: 'live-fc-0330.png', receivedAt: '2026-11-23T03:28:00Z' },
    { time: '2026-11-23T04:00:00Z', kind: '予想', label: '予想 +35分 13:00 JST', offMin: 35, url: 'live-fc-0400.png', receivedAt: '2026-11-23T03:28:00Z' },
  ],
};
let m = L.mergeFrames(pack, live);
assert.strictEqual(m.frames.length, 7, 'pack frames remain plus new 12:25 obs');
assert.strictEqual(m.frames[0].time, '2026-11-23T00:30:00Z');
assert.strictEqual(m.frames[0].live, false);
assert.ok(m.frames[0].images[1].file.startsWith('pack-'));
assert.strictEqual(m.frames[3].time, '2026-11-23T03:15:00Z');
assert.strictEqual(m.frames[3].live, false);
assert.strictEqual(m.frames[4].time, '2026-11-23T03:25:00Z');
assert.strictEqual(m.frames[4].live, true);
assert.strictEqual(m.frames[4].kind, '実況');
assert.strictEqual(m.frames[4].images[0].file, 'map.png');
assert.strictEqual(m.frames[4].images[1].url, 'live-0325.png');
assert.strictEqual(m.frames[4].images[2].file, 'border.png');
assert.strictEqual(m.frames[5].time, '2026-11-23T03:30:00Z');
assert.strictEqual(m.frames[5].live, true);
assert.strictEqual(m.frames[5].kind, '予想');
assert.strictEqual(m.frames[6].live, true);
assert.strictEqual(m.defaultFrame, 4);

// パックより古い LIVE 実況は入れない（巻き戻し禁止）
m = L.mergeFrames(pack, {
  receivedAt: '2026-11-23T03:20:00Z',
  latestTime: '2026-11-23T03:10:00Z',
  frames: [{ time: '2026-11-23T03:10:00Z', kind: '実況', label: '実況 12:10 JST', url: 'old.png' }],
});
assert.strictEqual(m.frames.length, 6);
assert.ok(!m.frames.some((f) => f.time === '2026-11-23T03:10:00Z' && f.live));
assert.strictEqual(L.defaultObsIndex(m.frames), 3);

// 同じ時刻のパック実況は上書きしない
m = L.mergeFrames(pack, {
  receivedAt: '2026-11-23T03:21:00Z',
  latestTime: '2026-11-23T03:15:00Z',
  frames: [{ time: '2026-11-23T03:15:00Z', kind: '実況', label: '実況 12:15 JST', url: 'same.png' }],
});
assert.strictEqual(m.frames.filter((f) => f.time === '2026-11-23T03:15:00Z').length, 1);
assert.strictEqual(m.frames[3].live, false);

// 12:30 が実況になったら、同じ時刻の予想を実況に置き換える。12:25 の LIVE 実況は残る。
const live2 = {
  receivedAt: '2026-11-23T03:33:00Z',
  latestTime: '2026-11-23T03:30:00Z',
  frames: [
    { time: '2026-11-23T03:30:00Z', kind: '実況', label: '実況 12:30 JST', url: 'live-0330.png', receivedAt: '2026-11-23T03:33:00Z' },
    { time: '2026-11-23T04:00:00Z', kind: '予想', label: '予想 +30分 13:00 JST', offMin: 30, url: 'live-fc2-0400.png', receivedAt: '2026-11-23T03:33:00Z' },
  ],
};
const mid = L.mergeFrames(pack, live);
m = L.mergeFrames(mid.frames.map((f) => (f.live ? { time: f.time, kind: f.kind, label: f.label, url: f.images[1].url, receivedAt: f.receivedAt } : f)).filter((f) => f.live ? true : true) && pack, {
  // merge live cache that includes both 12:25 (from prev persist) and 12:30 — simulate combined record
  receivedAt: '2026-11-23T03:33:00Z',
  latestTime: '2026-11-23T03:30:00Z',
  frames: [
    { time: '2026-11-23T03:25:00Z', kind: '実況', label: '実況 12:25 JST', url: 'live-0325.png', receivedAt: '2026-11-23T03:28:00Z' },
    ...live2.frames,
  ],
});
assert.strictEqual(m.frames.filter((f) => f.time === '2026-11-23T03:30:00Z').length, 1);
assert.strictEqual(m.frames.find((f) => f.time === '2026-11-23T03:30:00Z').kind, '実況');
assert.strictEqual(m.frames.find((f) => f.time === '2026-11-23T03:30:00Z').live, true);
assert.ok(m.frames.find((f) => f.time === '2026-11-23T03:25:00Z' && f.live && f.kind === '実況'));
assert.ok(m.frames.find((f) => f.time === '2026-11-23T03:15:00Z' && !f.live));
assert.strictEqual(m.defaultFrame, m.frames.findIndex((f) => f.time === '2026-11-23T03:30:00Z'));

// スライダー位置：古い実況を見ているときは維持。最新実況にいるときは新しい最新へ。
const merged = L.mergeFrames(pack, live).frames; // 7 frames, latest obs idx 4 (12:25)
assert.strictEqual(L.resolveIndex(pack, 3, merged), 4, 'was on pack latest obs -> new latest obs');
assert.strictEqual(L.resolveIndex(pack, 4, merged), 4, 'was on forecast -> new latest obs (idx 4 of merged, defaultObs)');
assert.strictEqual(L.resolveIndex(pack, 0, merged), 0, 'was on oldest pack obs -> stay');
assert.strictEqual(L.resolveIndex(pack, 2, merged), 2);
assert.strictEqual(L.resolveIndex(pack, 5, merged), 4, 'was on last forecast -> latest obs');

// バッジ
const liveFr = merged.find((f) => f.live && f.kind === '実況');
assert.strictEqual(L.badgeText(pack[3], { online: true }), 'PACK');
assert.strictEqual(L.badgeText(liveFr, { online: true }), 'LIVE');
assert.strictEqual(L.badgeText(liveFr, { online: false, now: Date.parse('2026-11-23T03:49:00Z') }), 'LIVE 受信 21分前');

// 以前の LIVE 実況は残り、新しい実況が後ろに付く
const acc = L.accumulateLiveFrames(
  { frames: [
    { time: '2026-11-23T03:25:00Z', kind: '実況', label: '実況 12:25 JST', url: 'a.png' },
    { time: '2026-11-23T03:30:00Z', kind: '予想', label: '予想 +5分 12:30 JST', url: 'b.png' },
  ] },
  [
    { time: '2026-11-23T03:30:00Z', kind: '実況', label: '実況 12:30 JST', url: 'c.png' },
    { time: '2026-11-23T04:00:00Z', kind: '予想', label: '予想 +30分 13:00 JST', url: 'd.png' },
  ],
  Date.parse('2026-11-23T03:15:00Z')
);
assert.strictEqual(acc.filter((f) => f.kind === '実況').map((f) => f.time).join(','), '2026-11-23T03:25:00Z,2026-11-23T03:30:00Z');
assert.strictEqual(acc.filter((f) => f.kind === '予想').length, 1);
assert.strictEqual(acc.find((f) => f.kind === '予想').time, '2026-11-23T04:00:00Z');
const accDrop = L.accumulateLiveFrames(
  { frames: [{ time: '2026-11-23T03:10:00Z', kind: '実況', url: 'old.png' }] },
  [{ time: '2026-11-23T03:25:00Z', kind: '実況', url: 'n.png' }],
  Date.parse('2026-11-23T03:15:00Z')
);
assert.ok(!accDrop.some((f) => f.time === '2026-11-23T03:10:00Z'), 'older than pack obs is dropped');

assert.ok(L.CREDIT.includes('出典：気象庁ホームページ'));
assert.ok(L.CREDIT.includes('重ねて表示'));
assert.ok(!/workers\.dev/i.test(code), 'must not call the METAR/ATIS worker');
assert.ok(!/wx-relay-config|FBWxLive|wx_live_poller/.test(code), 'must not use the METAR/ATIS live path');

console.log('OK test_radar_live.js (sync)');

(async () => {


// ---- 全地域先読み（雨・雷 × 20地域 = 40枚の最新実況）----
assert.strictEqual(L.AREAS.length, 20, 'all 20 JMA rain regions');
assert.strictEqual(new Set(L.AREAS).size, 20, 'area codes unique');
assert.strictEqual(L.AREAS.join(','), '00,05,04,06,17,18,09,11,19,07,08,10,02,16,12,13,01,14,03,15');
assert.ok(L.AREAS.every((a) => /^\d{2}$/.test(a)));
assert.strictEqual(L.PRODUCT_IDS.join(','), 'nowcast,thunder');
assert.strictEqual(L.PREFETCH_CONCURRENCY, 3);
assert.ok(L.MAX_LIVE_OBS >= 1);

const jobs = L.prefetchJobs();
assert.strictEqual(jobs.length, 40, '20 areas × 2 products, never a subset');
assert.strictEqual(jobs.filter((j) => j.product === 'nowcast').length, 20);
assert.strictEqual(jobs.filter((j) => j.product === 'thunder').length, 20);
assert.ok(jobs.every((j) => !j.obsOnly), 'every region fetches obs + forecasts');
assert.ok(L.AREAS.every((a) => jobs.some((j) => j.product === 'nowcast' && j.area === `a${a}`)));
assert.ok(L.AREAS.every((a) => jobs.some((j) => j.product === 'thunder' && j.area === `a${a}`)));

const watched = L.prefetchJobs({ product: 'nowcast', area: 'a09' });
assert.strictEqual(watched.length, 40);
assert.strictEqual(watched[0].product, 'nowcast');
assert.strictEqual(watched[0].area, 'a09');
assert.ok(watched.every((j) => !j.obsOnly), 'forecasts for all regions, including unopened');

const obsOnly = L.plannedRequests('nowcast', 'a09', new Date('2026-11-23T03:25:00Z'), { obsOnly: true });
assert.strictEqual(obsOnly.length, 1);
assert.strictEqual(obsOnly[0].kind, '実況');
assert.ok(obsOnly[0].url.endsWith('_a09.png'));

const t0325 = new Date('2026-11-23T03:25:00Z');
assert.strictEqual(L.plannedRequests('nowcast', 'a00', t0325).length, 3, 'obs + forecasts for unopened region too');
assert.strictEqual(L.plannedRequests('nowcast', 'a15', t0325).filter((r) => r.kind === '予想').length, 2);

// 欠けた予想があれば、time.json が進んでいなくても取りに行く
const obsOnlyRec = { latestTime: '2026-11-23T03:25:00Z', frames: [{ time: '2026-11-23T03:25:00Z', kind: '実況' }] };
assert.strictEqual(L.shouldFetch(Date.parse('2026-11-23T03:25:00Z'), Date.parse('2026-11-23T03:15:00Z'), Date.parse('2026-11-23T03:25:00Z')), false);
assert.ok(L.missingLiveForecasts(obsOnlyRec, 'nowcast', 'a00', t0325));
assert.ok(L.shouldRefresh(Date.parse('2026-11-23T03:25:00Z'), Date.parse('2026-11-23T03:15:00Z'), Date.parse('2026-11-23T03:25:00Z'), obsOnlyRec, 'nowcast', 'a00', t0325));
const fullRec = { latestTime: '2026-11-23T03:25:00Z', frames: L.plannedRequests('nowcast', 'a00', t0325).map((r) => ({ time: r.time, kind: r.kind })) };
assert.ok(!L.missingLiveForecasts(fullRec, 'nowcast', 'a00', t0325));
assert.ok(!L.shouldRefresh(Date.parse('2026-11-23T03:25:00Z'), Date.parse('2026-11-23T03:15:00Z'), Date.parse('2026-11-23T03:25:00Z'), fullRec, 'nowcast', 'a00', t0325));

// 地域切替：同じ有効時刻を辿る。無ければ一番近い時刻（同距離なら後ろ）。未指定は最新実況。
const byTime = L.mergeFrames(pack, live).frames;
assert.strictEqual(L.indexAtTime(byTime, '2026-11-23T03:15:00Z'), byTime.findIndex((f) => f.time === '2026-11-23T03:15:00Z'));
assert.strictEqual(L.indexAtTime(byTime, '2026-11-23T03:25:00Z'), byTime.findIndex((f) => f.time === '2026-11-23T03:25:00Z' && f.kind === '実況'));
assert.strictEqual(L.indexAtTime(byTime, '2026-11-23T03:20:00Z'), byTime.findIndex((f) => f.time === '2026-11-23T03:25:00Z'), 'tie breaks toward the later frame');
assert.strictEqual(L.indexAtTime(byTime, null), L.defaultObsIndex(byTime));

// 先読み（実況のみ）では、まだ先の予想を捨てない
const accKeepFc = L.accumulateLiveFrames(
  { frames: [
    { time: '2026-11-23T03:25:00Z', kind: '実況', url: 'a.png' },
    { time: '2026-11-23T03:30:00Z', kind: '予想', url: 'b.png' },
    { time: '2026-11-23T04:00:00Z', kind: '予想', url: 'c.png' },
  ] },
  [{ time: '2026-11-23T03:25:00Z', kind: '実況', url: 'a2.png' }],
  Date.parse('2026-11-23T03:15:00Z')
);
assert.strictEqual(accKeepFc.find((f) => f.kind === '実況').url, 'a2.png');
assert.strictEqual(accKeepFc.filter((f) => f.kind === '予想').map((f) => f.time).join(','), '2026-11-23T03:30:00Z,2026-11-23T04:00:00Z');

// 保存量の上限：古い LIVE 実況を切る。パック実況より古いものも捨てる。予想は残す。
const many = [];
for (let i = 0; i < 12; i++) {
  const t = new Date(Date.parse('2026-11-23T03:00:00Z') + i * 5 * 60000).toISOString().replace('.000Z', 'Z');
  many.push({ time: t, kind: '実況', url: `obs-${i}.png` });
}
many.push({ time: '2026-11-23T04:00:00Z', kind: '予想', url: 'fc.png' });
const pruned = L.pruneLiveFrames(many, Date.parse('2026-11-23T03:15:00Z'), 6);
assert.strictEqual(pruned.filter((f) => f.kind === '実況').length, 6);
assert.ok(!pruned.some((f) => f.time === '2026-11-23T03:00:00Z' || f.time === '2026-11-23T03:10:00Z'), 'older than pack / beyond cap dropped');
assert.ok(pruned.some((f) => f.time === '2026-11-23T03:30:00Z' && f.kind === '実況'));
assert.ok(pruned.some((f) => f.time === '2026-11-23T03:55:00Z' && f.kind === '実況'));
assert.strictEqual(pruned.filter((f) => f.kind === '予想').length, 1);

// 並列は 3 を超えない
let inflight = 0, peak = 0, ran = 0;
const t0 = Date.now();
await L.pool(jobs, L.PREFETCH_CONCURRENCY, async () => {
  inflight++;
  peak = Math.max(peak, inflight);
  await new Promise((r) => setTimeout(r, 15));
  inflight--;
  ran++;
});
assert.strictEqual(ran, 40);
assert.ok(peak <= 3, `peak concurrency ${peak} exceeds 3`);
assert.ok(peak >= 2, `expected parallel workers, peak=${peak}`);
assert.ok(Date.now() - t0 >= 40, 'pool should take multiple batches');

// prefetchAll: time.json は製品あたり1回、全地域の実況と予想を取る。
const fetches = [];
let pngInflight = 0, pngPeak = 0;
sandbox.fetch = async (url) => {
  fetches.push(url);
  if (/time\.json/.test(url)) {
    return { ok: true, json: async () => ({ time: '2026-11-23T03:25:00+00:00' }) };
  }
  pngInflight++;
  pngPeak = Math.max(pngPeak, pngInflight);
  await new Promise((r) => setTimeout(r, 5));
  pngInflight--;
  return { ok: true, headers: { get: () => 'image/png' }, blob: async () => new Uint8Array([1, 2, 3]) };
};
L._state.watch = { product: 'nowcast', area: 'a09', packFrames: pack, onUpdate: null, lastSig: null };
await L.prefetchAll('test');
const timeReqs = fetches.filter((u) => /time\.json/.test(u));
const pngReqs = fetches.filter((u) => /\.png$/.test(u));
assert.strictEqual(timeReqs.filter((u) => u.endsWith('/rain/time.json')).length, 1);
assert.strictEqual(timeReqs.filter((u) => u.endsWith('/thunder/time.json')).length, 1);
assert.ok(pngPeak <= 3, `png peak ${pngPeak} exceeds 3`);
assert.strictEqual(pngReqs.filter((u) => /_f00_/.test(u)).length, 40, 'latest obs for every region and product');
const expectNc = L.plannedRequests('nowcast', 'a00', new Date('2026-11-23T03:25:00Z'));
const expectTh = L.plannedRequests('thunder', 'a00', new Date('2026-11-23T03:25:00Z'));
assert.strictEqual(pngReqs.length, (expectNc.length + expectTh.length) * 20, 'obs+forecast for all 40 jobs');
for (const a of L.AREAS) {
  assert.ok(pngReqs.some((u) => u.endsWith(`_f00_a${a}.png`) && u.includes('/rain/')), `missing rain obs a${a}`);
  assert.ok(pngReqs.some((u) => u.endsWith(`_f00_a${a}.png`) && u.includes('/thunder/')), `missing thunder obs a${a}`);
  for (const r of expectNc.filter((x) => x.kind === '予想')) {
    assert.ok(pngReqs.includes(r.url.replace('_a00.png', `_a${a}.png`)), `missing nowcast forecast a${a} ${r.url}`);
  }
  for (const r of expectTh.filter((x) => x.kind === '予想')) {
    assert.ok(pngReqs.includes(r.url.replace('_a00.png', `_a${a}.png`)), `missing thunder forecast a${a} ${r.url}`);
  }
}
assert.ok(L.get('nowcast', 'a00'), 'prefetched unopened region is cached');
assert.ok(L.get('thunder', 'a15'), 'prefetched remote region is cached');
assert.strictEqual(L.get('nowcast', 'a00').latestTime, '2026-11-23T03:25:00Z');
assert.strictEqual(L.get('nowcast', 'a00').frames.filter((f) => f.kind === '実況').length, 1);
assert.strictEqual(L.get('nowcast', 'a00').frames.filter((f) => f.kind === '予想').length, 2);
assert.strictEqual(L.get('nowcast', 'a09').frames.filter((f) => f.kind === '予想').length, 2);
assert.ok((L.get('thunder', 'a15').frames.filter((f) => f.kind === '予想').length) === expectTh.filter((r) => r.kind === '予想').length);

// time.json が進まなければ再取得しない
const before = fetches.length;
await L.prefetchAll('test-again');
assert.strictEqual(fetches.filter((u) => /time\.json/.test(u)).length, 4, 'time.json polled again');
assert.strictEqual(fetches.filter((u) => /\.png$/.test(u)).length, pngReqs.length, 'no png refetch if time unchanged');

// 実況だけ残したキャッシュは、同じ latest でも欠けた予想を取りに行く
const keptPng = fetches.filter((u) => /\.png$/.test(u)).length;
const recA00 = L.get('nowcast', 'a00');
recA00.frames = recA00.frames.filter((f) => f.kind === '実況');
await L.prefetchAll('fill-forecasts');
const filled = fetches.filter((u) => /\.png$/.test(u)).length - keptPng;
assert.ok(filled >= 2, `expected to fill missing nowcast a00 forecasts, got ${filled}`);
assert.ok(fetches.some((u) => /rain_20261123032500_f01_a00\.png$/.test(u)));
assert.ok(fetches.some((u) => /rain_20261123032500_f07_a00\.png$/.test(u)));
assert.strictEqual(L.get('nowcast', 'a00').frames.filter((f) => f.kind === '予想').length, 2);

// time.json が進んだら最新実況と予想を取り直す
sandbox.fetch = async (url) => {
  fetches.push(url);
  if (/time\.json/.test(url)) {
    return { ok: true, json: async () => ({ time: '2026-11-23T03:30:00+00:00' }) };
  }
  return { ok: true, headers: { get: () => 'image/png' }, blob: async () => new Uint8Array([4, 5, 6]) };
};
await L.prefetchAll('test-advance');
const pngAfterObs = fetches.filter((u) => /20261123033000_f00_/.test(u));
assert.strictEqual(pngAfterObs.length, 40, 'new latest obs for all 40 when time.json advances');
const expectNc330 = L.plannedRequests('nowcast', 'a00', new Date('2026-11-23T03:30:00Z'));
const expectTh330 = L.plannedRequests('thunder', 'a00', new Date('2026-11-23T03:30:00Z'));
assert.strictEqual(fetches.filter((u) => /20261123033000_/.test(u) && /\.png$/.test(u)).length, (expectNc330.length + expectTh330.length) * 20, 'new obs+forecast for all regions');
assert.ok(L.get('nowcast', 'a00').frames.some((f) => f.time === '2026-11-23T03:25:00Z' && f.kind === '実況'), 'previous live obs kept until pruned');
assert.ok(L.get('nowcast', 'a00').frames.some((f) => f.time === '2026-11-23T03:30:00Z' && f.kind === '実況'));
assert.ok(L.get('nowcast', 'a15').frames.some((f) => f.kind === '予想' && f.time === '2026-11-23T04:00:00Z'));

// unwatch しても先読みタイマー用の状態は落とさない（タイマーはテストでは未起動）
L.unwatch();
assert.strictEqual(L._state.watch, null);
assert.ok(L.get('thunder', 'a03'), 'cache survives unwatch');

assert.ok(!/更新中/.test(code), 'must not add an updating indicator');
assert.ok(!/packDownload|FBPack|download\(/.test(code), 'must not gate prefetch on pack download');

console.log('OK test_radar_live.js');

})().catch((e) => { console.error(e); process.exit(1); });
