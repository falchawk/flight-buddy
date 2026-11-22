// パックの取得・端末保存（Cache Storage）・読み出し。
// - data/latest/manifest.json をネットから確認（失敗したら保存済みパックを使う）
// - 新しいパックなら JSON 類を Cache "fb-pack-<id>" に、図の画像（data/blobs/<sha256>.<ext>）を共有 Cache "fb-blobs" に保存。
//   画像は内容アドレスなので、前のパックと同じ画像は再ダウンロードしない（差分だけ）。sha256 で検証し、
//   全部揃った時だけ「完了」として登録する（中途半端なパックは表示しない）
// - 完了パックは最新と1つ前（KEEP=2件）を保持。どちらからも参照されない画像は削除
// - v1.7〜：パックは「共有ファイル（図など）」＋「空港別ファイル（ap/<ICAO>.json と飛行場時系列の画像）」。
//   端末は SETTINGS で選んだ空港の分だけダウンロードする（選択を増やすと、オンライン時にその空港の分だけ追加で取る）
(function () {
  const BASE = new URL('./', location.href).href;
  const LS_KEY = 'fb.packs.v1';
  const KEEP = 2;
  const PARALLEL = 6;
  const BLOBS = 'fb-blobs';
  // 旧「WX だけ更新」（v1.9.x まで）が端末に残した保存（別 Cache と localStorage）。機能を廃止したので、起動時に一度だけ消す
  const LEGACY_WXO = 'fb-wx-overlay', LEGACY_LS = ['fb.wxo.v1', 'fb.wxLast.v1'];
  const cacheName = (id) => `fb-pack-${id}`;
  const packUrl = (m, path) => new URL(`${m.base}${path}`, BASE).href;
  const siteUrl = (p) => new URL(p, BASE).href;

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
  const MIME = { png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif', webp: 'image/webp', svg: 'image/svg+xml', json: 'application/json' };

  async function checkRemote() {
    const res = await fetchWithTimeout(new URL(`data/latest/manifest.json?ts=${Date.now()}`, BASE).href, { cache: 'no-store' }, 7000);
    if (res.headers.get('X-FB-From-Cache')) throw new Error('オフライン（最新を確認できません）');
    if (!res.ok) throw new Error(`manifest HTTP ${res.status}`);
    return res.json();
  }

  async function fetchVerified(url, expectSha, type) {
    let lastErr = null;
    for (let i = 0; i < 3; i++) {
      try {
        const res = await fetchWithTimeout(url, { cache: 'reload' }, 30000);
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const buf = await res.arrayBuffer();
        if (expectSha) {
          const h = await sha256Hex(buf);
          if (h && h !== expectSha) throw new Error('sha256不一致');
        }
        return new Response(buf, { headers: { 'Content-Type': type || res.headers.get('Content-Type') || 'application/octet-stream' } });
      } catch (e) { lastErr = e; await new Promise((r) => setTimeout(r, 800 * (i + 1))); }
    }
    throw lastErr;
  }

  async function pool(items, n, fn) {
    let i = 0;
    const workers = Array.from({ length: Math.min(n, items.length) }, async () => {
      while (i < items.length) { const k = i++; await fn(items[k], k); }
    });
    await Promise.all(workers);
  }

  // 選んだ空港のうち、このパックに空港別ファイルがあるもの
  const apList = (manifest, selected) => (manifest.airportFiles ? (selected || []).filter((i) => manifest.airportFiles[i]) : []);
  // 端末がダウンロードする量（共有＋選んだ空港）
  function deviceBytes(manifest, selected) {
    if (!manifest.airportFiles) return manifest.totalBytes || 0;
    const af = manifest.airportFiles;
    return (manifest.sharedBytes || 0) + apList(manifest, selected).reduce((a, i) => a + af[i].bytes + (af[i].blobs || []).reduce((x, b) => x + b.bytes, 0), 0);
  }

  // onProgress(doneFiles, totalFiles, doneBytes, totalBytesToGet)
  // selected: SETTINGS で選んだ空港。既に保存済みのファイルは飛ばすので、選択を増やした時もこれで差分だけ取れる
  async function download(manifest, onProgress, selected) {
    const cache = await caches.open(cacheName(manifest.packId));
    const bc = await caches.open(BLOBS);
    const aps = apList(manifest, selected);
    const files = (manifest.files || []).concat(aps.map((i) => manifest.airportFiles[i]));
    const blobs = (manifest.blobs || []).concat(...aps.map((i) => manifest.airportFiles[i].blobs || []));
    // 既に持っているものは飛ばす（差分のみ）
    const have = new Set((await bc.keys()).map((r) => r.url));
    const needBlobs = blobs.filter((b) => !have.has(siteUrl(b.file)));
    const needFiles = [];
    for (const f of files) if (!(await cache.match(packUrl(manifest, f.path)))) needFiles.push(f);
    const total = needFiles.length + needBlobs.length;
    const totalBytes = needFiles.reduce((a, f) => a + (f.bytes || 0), 0) + needBlobs.reduce((a, b) => a + (b.bytes || 0), 0);
    let done = 0, doneBytes = 0;
    const tick = (bytes) => { done++; doneBytes += bytes || 0; onProgress && onProgress(done, total, doneBytes, totalBytes); };
    onProgress && onProgress(0, total, 0, totalBytes);
    await pool(needFiles, PARALLEL, async (f) => {
      const url = packUrl(manifest, f.path);
      try { await cache.put(url, await fetchVerified(url, f.sha256, f.type)); } catch (e) { throw new Error(`${f.path} の保存に失敗: ${e.message}`); }
      tick(f.bytes);
    });
    await pool(needBlobs, PARALLEL, async (b) => {
      const url = siteUrl(b.file);
      const name = b.file.split('/').pop();
      const [sha, ext] = name.split('.');
      try { await bc.put(url, await fetchVerified(url, sha, MIME[ext])); } catch (e) { throw new Error(`${b.file} の保存に失敗: ${e.message}`); }
      tick(b.bytes);
    });
    await cache.put(packUrl(manifest, 'manifest.json'), new Response(JSON.stringify(manifest), { headers: { 'Content-Type': 'application/json' } }));
    const prev = list().find((p) => p.packId === manifest.packId);
    const gotAps = [...new Set([...(prev?.airports || []), ...aps])];
    const l = list().filter((p) => p.packId !== manifest.packId);
    l.push({ packId: manifest.packId, generatedAt: manifest.generatedAt, totalBytes: deviceBytes(manifest, gotAps), files: (manifest.files || []).length + gotAps.length,
      savedAt: new Date().toISOString(), base: manifest.base, newBytes: (prev?.newBytes || 0) + totalBytes, airports: manifest.airportFiles ? gotAps : null });
    l.sort((a, b) => (a.packId < b.packId ? 1 : -1));
    const keep = l.slice(0, KEEP), drop = l.slice(KEEP);
    saveList(keep);
    for (const p of drop) await caches.delete(cacheName(p.packId));
    const names = await caches.keys();
    for (const n of names) if (n.startsWith('fb-pack-') && !keep.some((p) => cacheName(p.packId) === n)) await caches.delete(n);
    await pruneBlobs(keep);
    verified.clear();
    return manifest;
  }


  async function dropLegacyOverlay() {
    try { LEGACY_LS.forEach((k) => localStorage.removeItem(k)); await caches.delete(LEGACY_WXO); } catch (e) { /* 消せなくても表示には影響しない */ }
  }

  async function manifestOf(entry) {
    const c = await caches.open(cacheName(entry.packId));
    const r = await c.match(new URL(`${entry.base}manifest.json`, BASE).href);
    return r ? r.json() : null;
  }

  async function pruneBlobs(keep) {
    const want = new Set();
    for (const p of keep) {
      const m = await manifestOf(p);
      if (!m) return; // 安全側: 目録が読めなければ消さない
      for (const b of m.blobs || []) want.add(siteUrl(b.file));
      for (const i of p.airports || []) for (const b of m.airportFiles?.[i]?.blobs || []) want.add(siteUrl(b.file));
    }
    const bc = await caches.open(BLOBS);
    for (const r of await bc.keys()) if (!want.has(r.url)) await bc.delete(r);
  }

  function setSeries(out) {
    for (const c of out.charts?.categories || []) for (const it of c.items || []) if (it.id === 'apseries') it.product.variants = Object.values(out.seriesByIcao || {});
  }
  // 空港別ファイルを、画面側が使う元の形（wx.airports / notam.airports / atis.airports / airports.airports / 飛行場時系列）に組み立てる
  async function load(packId, selected) {
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
    out.loadedAirports = new Set();
    if (manifest.airportFiles) {
      for (const k of ['wx', 'notam', 'atis', 'airports']) { out[k] = out[k] || {}; out[k].airports = {}; }
      out.atis.reasons = {};
      const series = {};
      for (const icao of apList(manifest, selected)) {
        const r = await cache.match(packUrl(manifest, manifest.airportFiles[icao].path));
        if (!r) continue;
        const d = await r.json();
        out.loadedAirports.add(icao);
        if (d.wx) out.wx.airports[icao] = d.wx;
        if (d.notam) out.notam.airports[icao] = d.notam;
        if (d.atis) out.atis.airports[icao] = d.atis;
        if (d.atisReason) out.atis.reasons[icao] = d.atisReason;
        if (d.profile) out.airports.airports[icao] = d.profile;
        if (d.series) series[icao] = d.series;
        if (d.ground) {
          out.ground = out.ground || {};
          out.ground[icao] = d.ground;
        }
      }
      out.seriesByIcao = series;
      setSeries(out);
      const bcG = await caches.open(BLOBS);
      for (const icao of Object.keys(out.ground || {})) {
        const g = out.ground[icao];
        if (!g || !g.ok || !g.file) continue;
        try {
          const r = await bcG.match(siteUrl(g.file));
          if (r) g.layout = await r.json();
          else g.loadError = '地図データの読み込みに失敗しました（再ダウンロードしてください）。';
        } catch (e) {
          g.loadError = '地図データの読み込みに失敗しました。';
        }
      }
    } else {
      for (const icao of Object.keys(out.wx?.airports || {})) out.loadedAirports.add(icao); // 旧形式（全空港入り）
    }
    dropLegacyOverlay();
    const bc = await caches.open(BLOBS);
    const blobUrls = new Map();
    out.imageUrl = async (path) => {
      if (blobUrls.has(path)) return blobUrls.get(path);
      const isBlob = path.startsWith('data/blobs/');
      const url = isBlob ? siteUrl(path) : packUrl(manifest, path);
      const r = await (isBlob ? bc : cache).match(url);
      if (!r) return url;
      const u = URL.createObjectURL(await r.blob());
      blobUrls.set(path, u);
      // メモリ節約: 古い objectURL を解放（最大 300）
      if (blobUrls.size > 300) { const [k, v] = blobUrls.entries().next().value; URL.revokeObjectURL(v); blobUrls.delete(k); }
      return u;
    };
    return out;
  }

  const verified = new Map();
  async function verify(packId, selected) {
    const key = `${packId}|${(selected || []).join(',')}`;
    if (verified.has(key)) return verified.get(key);
    const entry = list().find((p) => p.packId === packId);
    if (!entry) return { ok: false, have: 0, total: 0 };
    const cache = await caches.open(cacheName(packId));
    const m = await manifestOf(entry);
    if (!m) return { ok: false, have: 0, total: 0 };
    const aps = apList(m, selected);
    const files = m.files.concat(aps.map((i) => m.airportFiles[i]));
    const blobs = (m.blobs || []).concat(...aps.map((i) => m.airportFiles[i].blobs || []));
    let have = 0;
    for (const f of files) if (await cache.match(packUrl(m, f.path))) have++;
    const bkeys = new Set((await (await caches.open(BLOBS)).keys()).map((r) => r.url));
    for (const b of blobs) if (bkeys.has(siteUrl(b.file))) have++;
    const total = files.length + blobs.length;
    const res = { ok: have === total, have, total, bytes: deviceBytes(m, aps) };
    if (res.ok) verified.set(key, res);
    return res;
  }

  async function clearAll() {
    for (const n of await caches.keys()) if (n.startsWith('fb-pack-') || n === BLOBS) await caches.delete(n);
    localStorage.removeItem(LS_KEY);
    await dropLegacyOverlay();
    verified.clear();
  }

  window.FBPack = { list, checkRemote, download, load, verify, clearAll, cacheName, deviceBytes };
})();
