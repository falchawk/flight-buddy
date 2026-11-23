#!/usr/bin/env node
// Client merge + persist rules: never go backwards; LIVE only when strictly newer.
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const code = fs.readFileSync(path.join(__dirname, '../js/wx-live.js'), 'utf8');
const store = {};
const sandbox = {
  module: { exports: {} },
  exports: {},
  window: undefined,
  localStorage: {
    getItem: (k) => (k in store ? store[k] : null),
    setItem: (k, v) => { store[k] = String(v); },
    removeItem: (k) => { delete store[k]; },
  },
  Date, Math, JSON, Number, Boolean, String, Array, Object, RegExp, Error,
  parseInt, isNaN, Number: Number,
  setTimeout, clearTimeout, setInterval, clearInterval,
  console,
};
sandbox.globalThis = sandbox;
vm.runInNewContext(code, sandbox);
const L = sandbox.module.exports;

assert.strictEqual(L.isNewer(L.parseIso('2026-11-23T03:00:00Z'), L.parseIso('2026-11-23T02:30:00Z')), true);
assert.strictEqual(L.isNewer(L.parseIso('2026-11-23T02:30:00Z'), L.parseIso('2026-11-23T03:00:00Z')), false);
assert.strictEqual(L.isNewer(L.parseIso('2026-11-23T03:00:00Z'), L.parseIso('2026-11-23T03:00:00Z')), false, 'equal stays pack');
assert.strictEqual(L.isNewer(NaN, L.parseIso('2026-11-23T03:00:00Z')), false);
assert.strictEqual(L.isNewer(L.parseIso('2026-11-23T03:00:00Z'), NaN), true);

const packWx = {
  metar: [{ raw: 'METAR RJTT 230230Z 06003KT 9999', obsTime: '2026-11-23T02:30:00Z', source: 'SWIM' }],
  taf: { raw: 'TAF RJTT 222305Z 2300/2406 03006KT', issueTime: '2026-11-22T23:05:00Z', source: 'SWIM' },
  metarSource: 'SWIM', tafSource: 'SWIM',
};
const packAtis = { text: 'ATIS RJTT W\nM0230\n230230Z=', time: '2026-11-23T02:30:00Z' };
const liveNewer = {
  metar: [{ raw: 'SPECI RJTT 230317Z 08020G35KT 2000 TSRA', obsTime: '2026-11-23T03:17:00Z', source: 'SWIM', type: 'SPECI' }],
  taf: { raw: 'TAF RJTT 230305Z 2306/2406 08008KT', issueTime: '2026-11-23T03:05:00Z', source: 'SWIM' },
  atis: { text: 'ATIS RJTT X\nM0300\n230300Z=', time: '2026-11-23T03:00:00Z', ident: 'X' },
  metarSource: 'SWIM', tafSource: 'SWIM', atisSource: 'SWIM', atisFetchedAt: '2026-11-23T03:18:00Z',
};
const liveOlder = {
  metar: [{ raw: 'METAR RJTT 230200Z 04003KT', obsTime: '2026-11-23T02:00:00Z', source: 'SWIM' }],
  taf: { raw: 'TAF RJTT 221705Z', issueTime: '2026-11-22T17:05:00Z', source: 'SWIM' },
  atis: { text: 'ATIS RJTT V\nM0200\n', time: '2026-11-23T02:00:00Z' },
  metarSource: 'SWIM', tafSource: 'SWIM', atisSource: 'SWIM',
};

let m = L.mergeAirport(packWx, packAtis, liveNewer);
assert.strictEqual(m.live.metar, true);
assert.strictEqual(m.live.taf, true);
assert.strictEqual(m.live.atis, true);
assert.strictEqual(m.speci, true);
assert.ok(m.metar[0].raw.startsWith('SPECI'));

m = L.mergeAirport(packWx, packAtis, liveOlder);
assert.strictEqual(m.live.metar, false, 'older live must not replace pack METAR');
assert.strictEqual(m.live.taf, false);
assert.strictEqual(m.live.atis, false);
assert.ok(m.metar[0].raw.includes('230230Z'));

m = L.mergeAirport(packWx, packAtis, { metar: [{ raw: 'METAR RJTT 230230Z', obsTime: '2026-11-23T02:30:00Z' }], taf: packWx.taf, atis: packAtis, metarSource: 'SWIM' });
assert.strictEqual(m.live.metar, false, 'equal time stays PACK');

// persist
const saved = L.savePersisted({ schema: L.SCHEMA, generatedAt: '2026-11-23T03:18:00Z', airports: { RJTT: liveNewer } }, 'https://example.workers.dev/wx');
assert.strictEqual(saved.data.schema, L.SCHEMA);
const loaded = L.loadPersisted();
assert.strictEqual(loaded.receivedAt, saved.receivedAt);
assert.deepStrictEqual(loaded.data.airports.RJTT.atis.ident, 'X');

console.log('OK test_wx_live.js');
