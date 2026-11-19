// Flight Buddy service worker
// - アプリ本体(シェル)はインストール時に全部キャッシュ（cache-first）
// - data/packs/* は不変URL。保存済みパック(fb-pack-*)から返す（cache-first）
// - data/blobs/* は内容アドレスの画像。fb-blobs から返す（cache-first・パック間で共有）
// - 外部（Windy等）は一切キャッシュしない（オンライン専用）
// - data/latest/*, data/index.json は network-first（オフライン時はキャッシュ）
const VERSION = 'v1.9.15';
const SHELL_CACHE = `fb-shell-${VERSION}`;
const SHELL = [
  './', 'index.html', 'manifest.webmanifest', 'css/app.css',
  'js/airports-data.js', 'js/map.js', 'js/areamap.js', 'js/flights.js', 'vendor/leaflet/leaflet.js', 'vendor/leaflet/leaflet.css', 'vendor/basemap.js', 'vendor/leaflet/images/layers.png', 'vendor/leaflet/images/layers-2x.png', 'vendor/leaflet/images/marker-icon.png', 'vendor/leaflet/images/marker-icon-2x.png', 'vendor/leaflet/images/marker-shadow.png', 'js/sun.js', 'js/tas.js', 'js/vmc-designated.js', 'js/wx.js', 'js/pack.js', 'js/viewer.js', 'js/app.js',
  'icons/antlers-emblem-32.png', 'icons/antlers-emblem-66.png', 'icons/icon-180.png', 'icons/icon-192.png', 'icons/icon-512.png',
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

  if (path.startsWith('data/blobs/')) {
    e.respondWith((async () => (await (await caches.open('fb-blobs')).match(url.origin + url.pathname)) || fetch(req))());
    return;
  }
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
