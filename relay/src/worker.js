// Flight Buddy wx live relay — read-only CORS JSON from KV.
// Writes are done by the box poller via the Cloudflare API (not this Worker).
// No secrets in this file.

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, HEAD, OPTIONS',
  'Access-Control-Allow-Headers': 'Accept, Content-Type',
  'Access-Control-Max-Age': '86400',
};

const CACHE = 'public, max-age=15, stale-while-revalidate=30';

function json(body, status = 200, extra = {}) {
  return new Response(typeof body === 'string' ? body : JSON.stringify(body), {
    status,
    headers: {
      'Content-Type': 'application/json; charset=utf-8',
      'Cache-Control': status === 200 ? CACHE : 'no-store',
      ...CORS,
      ...extra,
    },
  });
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (request.method === 'OPTIONS') {
      return new Response(null, { status: 204, headers: CORS });
    }
    if (request.method !== 'GET' && request.method !== 'HEAD') {
      return json({ error: 'method not allowed' }, 405);
    }
    const path = url.pathname.replace(/\/+$/, '') || '/';
    if (path === '/health') {
      return json({ ok: true, service: 'flight-buddy-wx' });
    }
    if (path !== '/' && path !== '/wx' && path !== '/live.json') {
      return json({ error: 'not found' }, 404);
    }
    if (!env.WX_KV) {
      return json({ error: 'kv not bound' }, 503);
    }
    const key = env.WX_KEY || 'live';
    const raw = await env.WX_KV.get(key);
    if (!raw) {
      return json({ error: 'no live weather yet', schema: 'flight-buddy-wx-live/1' }, 404);
    }
    const res = json(raw);
    if (request.method === 'HEAD') {
      return new Response(null, { status: 200, headers: res.headers });
    }
    return res;
  },
};
