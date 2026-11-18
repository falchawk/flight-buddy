// パックの取得・端末保存（Cache Storage）・読み出し。
// - data/latest/manifest.json をネットから確認（失敗したら保存済みパックを使う）
// - 新しいパックなら、目録の全ファイル（画像含む）を Cache "fb-pack-<id>" に保存し、
//   sha256 で検証。全部揃った時だけ「完了」として登録する（中途半端なパックは表示しない）
// - 完了パックは最新と1つ前（KEEP=2件）を保持
(function () {
  const BASE = new URL('./', location.href).href;
  const LS_KEY = 'fb.packs.v1';
  const KEEP = 2;
  const cacheName = (id) => `fb-pack-${id}`;
  const packUrl = (m, path) => new URL(`${m.base}${path}`, BASE).href;

  function list() {
    try { return JSON.parse(localStorage.getItem(LS_KEY)) || []; } catch { return []; }
  }
  function saveList(l) { localStorage.setItem(LS_KEY, JSON.stringify(l)); }

  async function fetchWithTimeout(url, opts = {}, ms = 8000) {
    const ctl = new AbortController();
    const t = setTimeout(() => ctl.abort(), ms);
    try { return await fetch(url, { ...opts, signal: ctl.signal }); } finally { clearTimeout(t); }
  }
  async function sha256Hex(buf) {
    if (!crypto.subtle) return null;
    const h = await crypto.subtle.digest('SHA-256', buf);
    return [...new Uint8Array(h)].map((b) => b.toString(16).padStart(2, '0')).join('');
  }

  async function checkRemote() {
    const res = await fetchWithTimeout(new URL(`data/latest/manifest.json?ts=${Date.now()}`, BASE).href, { cache: 'no-store' }, 7000);
    if (res.headers.get('X-FB-From-Cache')) throw new Error('オフライン（最新を確認できません）');
    if (!res.ok) throw new Error(`manifest HTTP ${res.status}`);
    return res.json();
  }

  async function download(manifest, onProgress) {
    const cache = await caches.open(cacheName(manifest.packId));
    const files = manifest.files || [];
    let done = 0;
    for (const f of files) {
      const url = packUrl(manifest, f.path);
      let ok = false, lastErr = null;
      const existing = await cache.match(url);
      if (existing) ok = true;
      for (let i = 0; i < 3 && !ok; i++) {
        try {
          const res = await fetchWithTimeout(url, { cache: 'reload' }, 20000);
          if (!res.ok) throw new Error(`HTTP ${res.status}`);
          const buf = await res.clone().arrayBuffer();
          if (f.sha256) {
            const h = await sha256Hex(buf);
            if (h && h !== f.sha256) throw new Error('sha256不一致');
          }
          await cache.put(url, new Response(buf, { headers: { 'Content-Type': f.type || res.headers.get('Content-Type') || 'application/octet-stream' } }));
          ok = true;
        } catch (e) { lastErr = e; await new Promise((r) => setTimeout(r, 800 * (i + 1))); }
      }
      if (!ok) throw new Error(`${f.path} の保存に失敗: ${lastErr && lastErr.message}`);
      done++;
      onProgress && onProgress(done, files.length);
    }
    await cache.put(packUrl(manifest, 'manifest.json'), new Response(JSON.stringify(manifest), { headers: { 'Content-Type': 'application/json' } }));
    const l = list().filter((p) => p.packId !== manifest.packId);
    l.push({ packId: manifest.packId, generatedAt: manifest.generatedAt, totalBytes: manifest.totalBytes, files: files.length, savedAt: new Date().toISOString(), base: manifest.base });
    l.sort((a, b) => (a.packId < b.packId ? 1 : -1));
    const keep = l.slice(0, KEEP), drop = l.slice(KEEP);
    saveList(keep);
    for (const p of drop) await caches.delete(cacheName(p.packId));
    // 登録外の fb-pack-* キャッシュ（中断したダウンロード等）を掃除
    const names = await caches.keys();
    for (const n of names) if (n.startsWith('fb-pack-') && !keep.some((p) => cacheName(p.packId) === n) && n !== cacheName(manifest.packId)) await caches.delete(n);
    return manifest;
  }

  async function load(packId) {
    const entry = list().find((p) => p.packId === packId);
    if (!entry) return null;
    const cache = await caches.open(cacheName(packId));
    const mres = await cache.match(new URL(`${entry.base}manifest.json`, BASE).href);
    if (!mres) return null;
    const manifest = await mres.json();
    const out = { manifest };
    for (const [key, path] of Object.entries(manifest.sections || {})) {
      const r = await cache.match(packUrl(manifest, path));
      out[key] = r ? await r.json() : null;
    }
    const blobUrls = {};
    out.imageUrl = async (path) => {
      if (blobUrls[path]) return blobUrls[path];
      const r = await cache.match(packUrl(manifest, path));
      if (!r) return packUrl(manifest, path);
      blobUrls[path] = URL.createObjectURL(await r.blob());
      return blobUrls[path];
    };
    return out;
  }

  async function verify(packId) {
    const entry = list().find((p) => p.packId === packId);
    if (!entry) return { ok: false, have: 0, total: 0 };
    const cache = await caches.open(cacheName(packId));
    const m = await (await cache.match(new URL(`${entry.base}manifest.json`, BASE).href))?.json();
    if (!m) return { ok: false, have: 0, total: 0 };
    let have = 0;
    for (const f of m.files) if (await cache.match(packUrl(m, f.path))) have++;
    return { ok: have === m.files.length, have, total: m.files.length };
  }

  async function clearAll() {
    for (const n of await caches.keys()) if (n.startsWith('fb-pack-')) await caches.delete(n);
    localStorage.removeItem(LS_KEY);
  }

  window.FBPack = { list, checkRemote, download, load, verify, clearAll, cacheName };
})();
