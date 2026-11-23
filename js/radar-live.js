// レーダーエコー（ナウキャスト・雷ナウキャスト）の近リアルタイム表示
// 気象庁 bosai/rain の time.json と地域別オーバーレイ PNG を、開いている地域だけ直接取得する。
// METAR/ATIS 用の中継サーバーは使わない（気象の文字電文の速度に影響させない）。
// パックのコマは残し、新しい実況と予想だけを時刻順に差し込む。
(function (root) {
  const PRODUCTS = {
    nowcast: { id: 'nowcast', timePath: 'rain', typ: 'rain', elem: 'rain', stepMin: 5 },
    thunder: { id: 'thunder', timePath: 'thunder', typ: 'thunder', elem: 'thunder', stepMin: 10 },
  };
  const RAIN_BASE = 'https://www.jma.go.jp/bosai/rain';
  const CREDIT_PAGE = 'https://www.jma.go.jp/bosai/rain/';
  const CREDIT = '出典：気象庁ホームページ（https://www.jma.go.jp/bosai/rain/）。気象庁の画像を地図・境界と重ねて表示しています。';
  const POLL_MS = 60 * 1000;
  const DB_NAME = 'fb-radar-live';
  const DB_STORE = 'frames';
  const DB_VER = 1;

  const state = {
    cache: Object.create(null), // key -> record (with Blobs / object URLs)
    watch: null,
    timer: null,
    listeners: false,
    objectUrls: [],
  };

  function isLiveProduct(id) { return !!PRODUCTS[id]; }
  function areaCode(variantId) {
    const m = String(variantId || '').match(/^a?(\d{2})$/i);
    return m ? m[1] : null;
  }
  function recKey(product, areaId) { return `${product}:${areaId}`; }

  function parseIso(s) {
    if (!s) return NaN;
    const t = Date.parse(s);
    return Number.isFinite(t) ? t : NaN;
  }
  function isNewer(a, b) { return Number.isFinite(a) && (!Number.isFinite(b) || a > b); }

  function pad2(n) { return String(n).padStart(2, '0'); }
  function ts14(d) {
    const x = (d instanceof Date) ? d : new Date(d);
    return `${x.getUTCFullYear()}${pad2(x.getUTCMonth() + 1)}${pad2(x.getUTCDate())}${pad2(x.getUTCHours())}${pad2(x.getUTCMinutes())}${pad2(x.getUTCSeconds())}`;
  }
  function toIsoZ(d) {
    const x = (d instanceof Date) ? d : new Date(d);
    return x.toISOString().replace(/\.\d{3}Z$/, 'Z');
  }
  function fmtJstHm(d) {
    const x = (d instanceof Date) ? d : new Date(d);
    const j = new Date(x.getTime() + 9 * 3600000);
    return `${pad2(j.getUTCHours())}:${pad2(j.getUTCMinutes())}`;
  }
  function fmtJst(iso, withDate) {
    if (!iso) return '--';
    const d = new Date(new Date(iso).getTime() + 9 * 3600000).toISOString();
    return withDate ? `${d.slice(5, 7)}/${d.slice(8, 10)} ${d.slice(11, 16)} JST` : `${d.slice(11, 16)} JST`;
  }
  function ageText(iso, now) {
    if (!iso) return '';
    const m = Math.round(((now || Date.now()) - new Date(iso).getTime()) / 60000);
    if (m < 1) return 'たった今'; if (m < 60) return `${m}分前`;
    if (m < 48 * 60) return `${Math.floor(m / 60)}時間${m % 60 ? (m % 60) + '分' : ''}前`;
    return `${Math.floor(m / 1440)}日前`;
  }

  function timeUrl(timePath) { return `${RAIN_BASE}/data/${timePath}/time.json`; }
  function rainUrl(typ, elem, baseDate, ft, area) {
    const b = ts14(baseDate);
    return `${RAIN_BASE}/data/${typ}/${b}/${elem}_${b}_f${pad2(ft)}_a${area}.png`;
  }

  function forecastSlots(latest, stepMin) {
    const start = (latest instanceof Date) ? latest : new Date(latest);
    const out = [];
    const n = Math.floor(60 / stepMin);
    for (let s = 1; s <= n; s++) {
      const t = new Date(start.getTime() + s * stepMin * 60000);
      if (t.getUTCMinutes() % 30 === 0) out.push({ time: t, offMin: s * stepMin, ft: s });
    }
    return out;
  }

  function offsetLabel(t, kind, offMin) {
    const clock = `${fmtJstHm(t)} JST`;
    if (kind !== '予想' || !offMin || offMin <= 0) return `実況 ${clock}`;
    const h = Math.floor(offMin / 60), m = offMin % 60;
    const o = h === 0 ? `+${m}分` : (m === 0 ? `+${h}時間` : `+${h}時間${m}分`);
    return `予想 ${o} ${clock}`;
  }

  function isObs(fr) {
    return String(fr?.kind || '') === '実況' || String(fr?.label || '').startsWith('実況');
  }
  function frameTimeMs(fr) { return parseIso(fr && fr.time); }

  function latestObsTime(frames) {
    let max = NaN;
    for (const fr of frames || []) {
      if (!isObs(fr)) continue;
      const t = frameTimeMs(fr);
      if (isNewer(t, max)) max = t;
    }
    return max;
  }

  function defaultObsIndex(frames) {
    let idx = 0;
    for (let i = 0; i < (frames || []).length; i++) if (isObs(frames[i])) idx = i;
    return idx;
  }

  function insertByTime(list, fr) {
    const t = frameTimeMs(fr);
    let i = 0;
    while (i < list.length && frameTimeMs(list[i]) <= t) i++;
    list.splice(i, 0, fr);
  }

  function layerImages(packFrames, overlayImg) {
    const src = (packFrames || []).find((f) => f.images && f.images.length);
    const images = src ? src.images.slice() : [];
    if (images.length >= 2) images[1] = overlayImg;
    else if (images.length === 1) images.push(overlayImg);
    else return [overlayImg];
    return images;
  }

  function toDisplayFrame(lf, rec, packFrames) {
    const overlay = lf.url ? { url: lf.url } : (lf.objectUrl ? { url: lf.objectUrl } : null);
    return {
      label: lf.label,
      time: typeof lf.time === 'string' ? lf.time : toIsoZ(lf.time),
      kind: lf.kind,
      layout: 'layers',
      live: true,
      receivedAt: lf.receivedAt || rec.receivedAt,
      images: overlay ? layerImages(packFrames, overlay) : (lf.images || []),
    };
  }

  // パックのコマは残す。同じ有効時刻では、実況は予想に勝つ。パック実況は上書きしない。
  function mergeFrames(packFrames, liveRecord) {
    const out = (packFrames || []).map((fr) => Object.assign({}, fr, { live: false }));
    const packLatestObs = latestObsTime(out);
    if (!liveRecord || !liveRecord.frames || !liveRecord.frames.length) {
      return { frames: out, defaultFrame: defaultObsIndex(out), receivedAt: null };
    }
    for (const lf of liveRecord.frames) {
      const t = frameTimeMs(lf);
      if (!Number.isFinite(t)) continue;
      const liveFr = toDisplayFrame(lf, liveRecord, packFrames);
      const idx = out.findIndex((fr) => frameTimeMs(fr) === t);
      if (isObs(lf)) {
        if (Number.isFinite(packLatestObs) && t < packLatestObs) continue;
        if (idx >= 0) {
          if (isObs(out[idx]) && !out[idx].live) continue; // 同じ時刻のパック実況は残す
          out[idx] = liveFr;
        } else insertByTime(out, liveFr);
      } else {
        if (idx >= 0) {
          if (isObs(out[idx])) continue;
          out[idx] = liveFr;
        } else insertByTime(out, liveFr);
      }
    }
    return { frames: out, defaultFrame: defaultObsIndex(out), receivedAt: liveRecord.receivedAt || null };
  }

  // 古い実況を見ているときはその時刻を保つ。最新実況または予想にいるときは新しい最新実況へ。
  function resolveIndex(oldFrames, oldIndex, newFrames) {
    if (!newFrames || !newFrames.length) return 0;
    const i0 = Math.max(0, Math.min(oldIndex == null ? -1 : oldIndex, (oldFrames || []).length - 1));
    const old = (oldFrames || [])[i0];
    const wasLatestObs = i0 === defaultObsIndex(oldFrames || []);
    const wasForecast = old && !isObs(old);
    if (oldIndex == null || oldIndex < 0 || wasLatestObs || wasForecast) return defaultObsIndex(newFrames);
    if (old && old.time) {
      const i = newFrames.findIndex((fr) => fr.time === old.time && isObs(fr) === isObs(old));
      if (i >= 0) return i;
    }
    return Math.min(Math.max(0, oldIndex), newFrames.length - 1);
  }


  // 以前取った LIVE 実況（5分ごと）は残し、新しい実況と今回の予想を足す。パックより古い実況は捨てる。
  function accumulateLiveFrames(prev, fetched, packLatestObsMs) {
    const keep = [];
    const fetchedTimes = new Set((fetched || []).map((fr) => fr.time));
    for (const fr of (prev && prev.frames) || []) {
      if (!isObs(fr)) continue;
      const t = frameTimeMs(fr);
      if (!isNewer(t, packLatestObsMs)) continue;
      if (fetchedTimes.has(fr.time) || fetchedTimes.has(toIsoZ(fr.time))) continue;
      keep.push(fr);
    }
    return keep.concat(fetched || []);
  }

  function shouldFetch(jmaLatestMs, packLatestObsMs, lastLiveMs) {
    return isNewer(jmaLatestMs, packLatestObsMs) && isNewer(jmaLatestMs, lastLiveMs);
  }

  function plannedRequests(productId, areaId, latest) {
    const prod = PRODUCTS[productId];
    const area = areaCode(areaId);
    if (!prod || !area || !latest) return [];
    const t = (latest instanceof Date) ? latest : new Date(latest);
    const req = [{ kind: '実況', time: toIsoZ(t), ft: 0, url: rainUrl(prod.typ, prod.elem, t, 0, area) }];
    for (const slot of forecastSlots(t, prod.stepMin)) {
      req.push({ kind: '予想', time: toIsoZ(slot.time), ft: slot.ft, offMin: slot.offMin, url: rainUrl(prod.typ, prod.elem, t, slot.ft, area) });
    }
    return req;
  }

  function badgeText(fr, opts) {
    const online = !opts || opts.online !== false;
    if (!fr || !fr.live) return 'PACK';
    const rec = fr.receivedAt || (opts && opts.receivedAt);
    if (!online) return `LIVE 受信 ${ageText(rec, opts && opts.now)}`;
    return 'LIVE';
  }

  function badgeHtml(fr, opts) {
    const text = badgeText(fr, opts);
    const live = !!(fr && fr.live);
    const valid = fr && fr.time ? fmtJst(fr.time, false) : '';
    const cls = live ? 'badge live' : 'badge pack';
    const rec = fr && (fr.receivedAt || (opts && opts.receivedAt));
    const extra = live && rec && opts && opts.online !== false ? ` 有効 ${valid}` : (live ? ` 有効 ${valid}` : '');
    return `<span class="${cls}" data-radar-src="${live ? 'live' : 'pack'}" data-valid="${fr && fr.time ? String(fr.time) : ''}">${esc(text)}</span>${valid ? ` <span class="radar-valid hint">${esc(extra.trim())}</span>` : ''}`;
  }

  function esc(s) { return String(s || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;'); }

  function rememberUrl(u) {
    if (u) state.objectUrls.push(u);
    if (state.objectUrls.length > 80) {
      const old = state.objectUrls.shift();
      try { URL.revokeObjectURL(old); } catch (e) { /* ignore */ }
    }
    return u;
  }

  function attachObjectUrls(rec) {
    if (!rec || !rec.frames) return rec;
    for (const fr of rec.frames) {
      if (fr.objectUrl || fr.url) continue;
      if (fr.overlay && typeof URL !== 'undefined' && URL.createObjectURL) {
        fr.objectUrl = rememberUrl(URL.createObjectURL(fr.overlay));
      } else if (fr.overlayB64) {
        fr.url = fr.overlayB64.indexOf('data:') === 0 ? fr.overlayB64 : `data:image/png;base64,${fr.overlayB64}`;
      }
    }
    return rec;
  }

  function get(product, areaId) {
    const rec = state.cache[recKey(product, areaId)];
    return rec ? attachObjectUrls(rec) : null;
  }

  // ----- IndexedDB（無ければメモリのみ。テスト環境でも動く）
  function idbAvailable() { return typeof indexedDB !== 'undefined'; }
  function idbOpen() {
    return new Promise((resolve, reject) => {
      const req = indexedDB.open(DB_NAME, DB_VER);
      req.onupgradeneeded = () => { req.result.createObjectStore(DB_STORE); };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
  }
  function blobToB64(blob) {
    return new Promise((resolve, reject) => {
      const r = new FileReader();
      r.onload = () => resolve(String(r.result));
      r.onerror = () => reject(r.error);
      r.readAsDataURL(blob);
    });
  }
  async function savePersisted(rec) {
    state.cache[recKey(rec.product, rec.area)] = rec;
    if (!idbAvailable()) return;
    try {
      const serial = {
        product: rec.product, area: rec.area,
        latestTime: rec.latestTime, receivedAt: rec.receivedAt,
        frames: await Promise.all((rec.frames || []).map(async (fr) => ({
          time: fr.time, kind: fr.kind, offMin: fr.offMin, label: fr.label,
          overlayB64: fr.overlayB64 || (fr.overlay ? await blobToB64(fr.overlay) : null),
        }))),
      };
      const db = await idbOpen();
      await new Promise((resolve, reject) => {
        const tx = db.transaction(DB_STORE, 'readwrite');
        tx.objectStore(DB_STORE).put(serial, recKey(rec.product, rec.area));
        tx.oncomplete = () => resolve();
        tx.onerror = () => reject(tx.error);
      });
      db.close();
    } catch (e) { /* 永続化失敗でもメモリ上の表示は続ける */ }
  }
  async function hydrate() {
    if (!idbAvailable()) return;
    try {
      const db = await idbOpen();
      const rows = await new Promise((resolve, reject) => {
        const tx = db.transaction(DB_STORE, 'readonly');
        const req = tx.objectStore(DB_STORE).getAll();
        req.onsuccess = () => resolve(req.result || []);
        req.onerror = () => reject(req.error);
      });
      db.close();
      for (const rec of rows) {
        if (!rec || !rec.product || !rec.area) continue;
        state.cache[recKey(rec.product, rec.area)] = attachObjectUrls(rec);
      }
    } catch (e) { /* ignore */ }
  }

  async function fetchJson(url) {
    const r = await fetch(url, { cache: 'no-store' });
    if (!r.ok) throw new Error(`time.json HTTP ${r.status}`);
    return r.json();
  }
  async function fetchPng(url) {
    const r = await fetch(url, { cache: 'no-store' });
    if (!r.ok) return null;
    const ct = (r.headers.get('content-type') || '').toLowerCase();
    if (ct && ct.indexOf('image') < 0 && ct.indexOf('octet-stream') < 0) return null;
    return r.blob();
  }

  async function refresh(productId, areaId, packFrames) {
    const prod = PRODUCTS[productId];
    const area = areaCode(areaId);
    if (!prod || !area) return get(productId, areaId);
    const prev = get(productId, areaId);
    const packLatest = latestObsTime(packFrames || []);
    const lastLive = prev ? parseIso(prev.latestTime) : NaN;
    if (typeof navigator !== 'undefined' && navigator && navigator.onLine === false) return prev || null;
    if (typeof fetch !== 'function') return prev || null;
    let latest;
    try {
      const tj = await fetchJson(timeUrl(prod.timePath));
      latest = new Date(parseIso(tj.time));
      if (!Number.isFinite(+latest)) return prev || null;
    } catch (e) { return prev || null; }
    const jmaMs = +latest;
    if (!shouldFetch(jmaMs, packLatest, lastLive)) return prev || null;
    const reqs = plannedRequests(productId, areaId, latest);
    const fetched = [];
    for (const req of reqs) {
      const blob = await fetchPng(req.url);
      if (!blob) { if (req.kind === '実況') return prev || null; continue; }
      fetched.push({
        time: req.time, kind: req.kind, offMin: req.offMin || 0,
        label: offsetLabel(new Date(req.time), req.kind, req.offMin || 0),
        overlay: blob,
      });
    }
    if (!fetched.length) return prev || null;
    const frames = accumulateLiveFrames(prev, fetched, packLatest);
    const rec = {
      product: productId, area: areaId,
      latestTime: toIsoZ(latest),
      receivedAt: toIsoZ(new Date()),
      frames,
    };
    attachObjectUrls(rec);
    await savePersisted(rec);
    return rec;
  }

  function wxRadarVisible() {
    if (typeof document === 'undefined') return !!state.watch;
    const wx = document.getElementById('tab-wx');
    return !!(state.watch && wx && wx.classList.contains('active') && (!document.visibilityState || document.visibilityState === 'visible'));
  }

  function tick(reason) {
    const w = state.watch;
    if (!w || !wxRadarVisible()) return Promise.resolve(null);
    return refresh(w.product, w.area, w.packFrames).then((rec) => {
      if (!rec) return rec;
      const sig = `${rec.latestTime}|${rec.receivedAt}|${(rec.frames || []).length}`;
      if (sig !== w.lastSig) {
        w.lastSig = sig;
        if (typeof w.onUpdate === 'function') w.onUpdate(rec);
      }
      return rec;
    }).catch(() => null);
  }

  function watch(opts) {
    state.watch = {
      product: opts.product,
      area: opts.area,
      packFrames: opts.packFrames || [],
      onUpdate: opts.onUpdate,
      lastSig: null,
    };
    ensureListeners();
    if (state.timer) clearInterval(state.timer);
    state.timer = setInterval(() => tick('interval'), POLL_MS);
    return tick(opts.reason || 'watch');
  }

  function unwatch() {
    state.watch = null;
    if (state.timer) { clearInterval(state.timer); state.timer = null; }
  }

  function ensureListeners() {
    if (state.listeners || typeof window === 'undefined') return;
    state.listeners = true;
    window.addEventListener('online', () => tick('online'));
    document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible') tick('visible'); });
  }

  async function start() {
    ensureListeners();
    await hydrate();
  }

  const api = {
    PRODUCTS, RAIN_BASE, CREDIT, CREDIT_PAGE, POLL_MS,
    isLiveProduct, areaCode, parseIso, isNewer, ts14, toIsoZ, fmtJst, fmtJstHm, ageText,
    timeUrl, rainUrl, forecastSlots, offsetLabel, plannedRequests,
    isObs, latestObsTime, defaultObsIndex, mergeFrames, resolveIndex, accumulateLiveFrames, shouldFetch,
    badgeText, badgeHtml, get, refresh, watch, unwatch, start, tick, hydrate,
    _state: state,
    _savePersisted: savePersisted,
  };
  if (typeof window !== 'undefined') window.FBRadarLive = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})(typeof globalThis !== 'undefined' ? globalThis : this);
