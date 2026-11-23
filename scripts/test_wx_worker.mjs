import { readFileSync } from 'fs';
import { pathToFileURL } from 'url';
import assert from 'assert';

const url = pathToFileURL('/workspace/flight-buddy/relay/src/worker.js').href;
const mod = await import(url);
const worker = mod.default;
const payload = JSON.stringify({ schema: 'flight-buddy-wx-live/1', airports: { RJTT: {} } });
const env = { WX_KV: { async get(key) { return key === 'live' ? payload : null; } } };

let res = await worker.fetch(new Request('https://x.workers.dev/wx', { method: 'OPTIONS', headers: { Origin: 'https://falchawk.github.io' } }), env);
assert.strictEqual(res.status, 204);
assert.strictEqual(res.headers.get('Access-Control-Allow-Origin'), '*');

res = await worker.fetch(new Request('https://x.workers.dev/wx', { headers: { Origin: 'https://falchawk.github.io' } }), env);
assert.strictEqual(res.status, 200);
assert.strictEqual(res.headers.get('Access-Control-Allow-Origin'), '*');
assert.ok((res.headers.get('Cache-Control') || '').includes('max-age=15'));
const body = await res.json();
assert.strictEqual(body.schema, 'flight-buddy-wx-live/1');

res = await worker.fetch(new Request('https://x.workers.dev/nope'), env);
assert.strictEqual(res.status, 404);

res = await worker.fetch(new Request('https://x.workers.dev/health'), env);
assert.strictEqual((await res.json()).ok, true);

console.log('OK test_wx_worker.mjs');
