#!/usr/bin/env node
// パック保存の進行表示間引きと、先読みと同時でもメインスレッドを譲るヘルパー
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const code = fs.readFileSync(path.join(__dirname, '../js/pack.js'), 'utf8');
const ls = new Map();
const sandbox = {
  module: { exports: {} },
  exports: {},
  window: {},
  location: { href: 'https://example.test/flight-buddy/' },
  localStorage: {
    getItem: (k) => (ls.has(k) ? ls.get(k) : null),
    setItem: (k, v) => { ls.set(k, String(v)); },
    removeItem: (k) => { ls.delete(k); },
  },
  caches: { open: async () => ({}), keys: async () => [], delete: async () => {}, has: async () => false },
  crypto: { subtle: null },
  fetch: async () => { throw new Error('no network in test'); },
  URL, Response, Request, Headers, Date, Math, JSON, Number, Boolean, String, Array, Object, RegExp, Error,
  parseInt, isNaN, parseFloat, Infinity, NaN,
  setTimeout, clearTimeout, setInterval, clearInterval, console, Uint8Array, Promise,
};
sandbox.globalThis = sandbox;
sandbox.window = sandbox.window;
vm.runInNewContext(code, sandbox);
const P = sandbox.window.FBPack;
assert.ok(P, 'FBPack exported');
assert.strictEqual(P.PROGRESS_MS, 100);

(async () => {
const calls = [];
const t = P._throttleProgress((a, b) => { calls.push([a, b]); }, 40);
t(1, 10);
t(2, 10);
t(3, 10);
assert.deepStrictEqual(calls, [[1, 10]], 'first call goes through immediately');
await new Promise((r) => setTimeout(r, 60));
assert.deepStrictEqual(calls, [[1, 10], [3, 10]], 'later calls are coalesced to the last pending args');
t(4, 10);
t(5, 10);
t.flush();
assert.deepStrictEqual(calls, [[1, 10], [3, 10], [5, 10]], 'flush emits the last pending progress');

const none = P._throttleProgress(null, 40);
none(1);
none.flush();

const y0 = Date.now();
await P._yieldToMain();
assert.ok(Date.now() - y0 >= 0);

assert.ok(code.includes('yieldToMain'), 'download loop must yield to the main thread');
assert.ok(code.includes('throttleProgress'), 'progress UI must be throttled');

console.log('OK test_pack.js');
})().catch((e) => { console.error(e); process.exit(1); });
