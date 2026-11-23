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

console.log('OK test_radar_live.js');
