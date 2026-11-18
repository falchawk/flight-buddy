// Flight Buddy service worker
// - アプリ本体(シェル)はインストール時に全部キャッシュ（cache-first）
// - data/packs/* は不変URL。保存済みパック(fb-pack-*)から返す（cache-first）
// - data/latest/*, data/index.json は network-first（オフライン時はキャッシュ）
const VERSION = 'v1.0.0';
const SHELL_CACHE = `fb-shell-${VERSION}`;
const SHELL = [
  './', 'index.html', 'manifest.webmanifest', 'css/app.css',
  'js/airports-data.js', 'js/sun.js', 'js/tas.js', 'js/wx.js', 'js/pack.js', 'js/viewer.js', 'js/app.js',
  'icons/icon-180.png', 'icons/icon-192.png', 'icons/icon-512.png',
];

self.addEventListener('install', (e) => {
  e.waitUntil((async () => {
    const c = await caches.open(SHELL_CACHE);
    await c.addAll(SHELL.map((p) => new Request(p, { cache: 'reload' })));
    await self.skipWaiting();
  })());
});

self.addEventListener('activate', (e) => {
  e.waitUntil((async () => {
    for (const n of await caches.keys()) if (n.startsWith('fb-shell-') && n !== SHELL_CACHE) await caches.delete(n);
    await self.clients.claim();
  })());
});

async function matchPacks(req) {
  for (const n of await caches.keys()) {
    if (!n.startsWith('fb-pack-')) continue;
    const r = await (await caches.open(n)).match(req, { ignoreSearch: true });
    if (r) return r;
  }
  return null;
}

self.addEventListener('fetch', (e) => {
  const req = e.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  if (url.origin !== location.origin) return;
  const scope = new URL(self.registration.scope).pathname;
  const path = url.pathname.startsWith(scope) ? url.pathname.slice(scope.length) : url.pathname;

  if (path.startsWith('data/packs/')) {
    e.respondWith((async () => (await matchPacks(req)) || fetch(req))());
    return;
  }
  if (path.startsWith('data/')) {
    e.respondWith((async () => {
      try {
        const res = await fetch(req, { cache: 'no-store' });
        if (res.ok) (await caches.open('fb-meta')).put(url.origin + url.pathname, res.clone());
        return res;
      } catch (err) {
        const c = await (await caches.open('fb-meta')).match(url.origin + url.pathname);
        if (c) {
          const h = new Headers(c.headers); h.set('X-FB-From-Cache', '1');
          return new Response(await c.blob(), { status: 200, headers: h });
        }
        throw err;
      }
    })());
    return;
  }
  e.respondWith((async () => {
    const c = await caches.open(SHELL_CACHE);
    const hit = await c.match(req, { ignoreSearch: true }) || (req.mode === 'navigate' ? await c.match('index.html') : null);
    if (hit) return hit;
    return fetch(req);
  })());
});

self.addEventListener('message', (e) => {
  if (e.data === 'version') e.source && e.source.postMessage({ type: 'version', version: VERSION });
});
