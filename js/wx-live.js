// Flight Buddy: live ATIS / METAR / SPECI / TAF overlay on top of the pack.
// Polls the relay only while the app is visible and online. Persists the last
// successful payload so offline (and a later offline restart) still shows the
// newest live report, never an older pack report.
(function (root) {
  const SCHEMA = 'flight-buddy-wx-live/1';
  const LS_KEY = 'fb.wxLive';
  const POLL_MS = 60000;

  function relayUrl() {
    const u = (typeof window !== 'undefined' && window.FB_WX_RELAY_URL) || '';
    return String(u || '').trim();
  }
  function enabled() { return !!relayUrl(); }

  function parseIso(s) {
    if (!s) return NaN;
    const t = Date.parse(s);
    return Number.isFinite(t) ? t : NaN;
  }

  function fromRawZ(raw) {
    if (!raw) return NaN;
    const m = /\b(\d{2})(\d{2})(\d{2})Z\b/.exec(raw);
    if (!m) return NaN;
    const day = +m[1], hh = +m[2], mm = +m[3];
    const now = new Date();
    for (const back of [0, 1]) {
      const d = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - back, day, hh, mm, 0));
      if (d.getUTCDate() === day && d.getTime() <= now.getTime() + 3600000) return d.getTime();
    }
    return NaN;
  }

  function metarTime(m) {
    if (!m) return NaN;
    const t = parseIso(m.obsTime);
    return Number.isFinite(t) ? t : fromRawZ(m.raw);
  }
  function tafTime(t) {
    if (!t) return NaN;
    const x = parseIso(t.issueTime);
    return Number.isFinite(x) ? x : fromRawZ(t.raw);
  }
  function atisTime(a) {
    if (!a) return NaN;
    const x = parseIso(a.time);
    if (Number.isFinite(x)) return x;
    return fromRawZ(a.text);
  }

  // live wins only when its report time is strictly newer. Equal or older → pack.
  function isNewer(liveMs, packMs) {
    if (!Number.isFinite(liveMs)) return false;
    if (!Number.isFinite(packMs)) return true;
    return liveMs > packMs;
  }

  function isSpeci(m) {
    if (!m) return false;
    if (m.type === 'SPECI') return true;
    const raw = m.raw || '';
    return /^\s*SPECI\b/.test(raw) || /\bSPECI\b/.test(raw.slice(0, 80));
  }

  function mergeAirport(packWx, packAtis, liveAp) {
    const packM = (packWx && packWx.metar) || [];
    const liveM = (liveAp && liveAp.metar) || [];
    const useLiveM = isNewer(metarTime(liveM[0]), metarTime(packM[0]));
    const packT = packWx && packWx.taf;
    const liveT = liveAp && liveAp.taf;
    const useLiveT = isNewer(tafTime(liveT), tafTime(packT));
    const packA = packAtis && (packAtis.text ? packAtis : null);
    const liveA = liveAp && liveAp.atis;
    const useLiveA = isNewer(atisTime(liveA), atisTime(packA));
    const metar = useLiveM ? liveM : packM;
    const taf = useLiveT ? liveT : packT;
    const atis = useLiveA ? liveA : packA;
    return {
      metar,
      taf: taf || null,
      atis: atis || null,
      metarSource: useLiveM ? (liveAp.metarSource || (metar[0] && metar[0].source) || 'LIVE') : (packWx && (packWx.metarSource || (packM[0] && packM[0].source))) || null,
      tafSource: useLiveT ? (liveAp.tafSource || (liveT && liveT.source) || 'LIVE') : (packWx && (packWx.tafSource || (packT && packT.source))) || null,
      atisSource: useLiveA ? (liveAp.atisSource || 'SWIM') : (atis ? 'SWIM' : (liveAp && liveAp.atisReason) || null),
      atisReason: (!atis && liveAp && liveAp.atisReason) || null,
      atisFetchedAt: useLiveA ? (liveAp.atisFetchedAt || null) : (packAtis && packAtis.fetchedAt) || null,
      live: { metar: !!useLiveM, taf: !!useLiveT, atis: !!useLiveA },
      speci: isSpeci(metar[0]),
      ok: !!(metar[0] || taf),
      fetchedAt: packWx && packWx.fetchedAt,
      carriedOver: !!(packWx && packWx.carriedOver && !useLiveM && !useLiveT),
      ogimetFailReason: packWx && packWx.ogimetFailReason,
      swimFailReason: packWx && packWx.swimFailReason,
      swimTafFailReason: packWx && packWx.swimTafFailReason,
    };
  }

  function loadPersisted() {
    try {
      const raw = typeof localStorage !== 'undefined' ? localStorage.getItem(LS_KEY) : null;
      if (!raw) return null;
      const d = JSON.parse(raw);
      if (!d || !d.data || d.data.schema !== SCHEMA || !d.receivedAt) return null;
      return d;
    } catch (e) {
      return null;
    }
  }

  function savePersisted(data, url) {
    const blob = { receivedAt: new Date().toISOString(), url: url || relayUrl(), data };
    try {
      localStorage.setItem(LS_KEY, JSON.stringify(blob));
    } catch (e) { /* quota — in-memory copy still used this session */ }
    return blob;
  }

  const state = {
    data: null,
    receivedAt: null,
    error: null,
    source: null, // 'network' | 'persisted'
    timer: null,
    inflight: false,
    onUpdate: null,
  };

  function hydrateFromPersist() {
    if (!enabled()) return false;
    const p = loadPersisted();
    if (!p) return false;
    // 設定 URL が変わっていたら古い受信は使わない
    if (p.url && relayUrl() && p.url !== relayUrl()) return false;
    state.data = p.data;
    state.receivedAt = p.receivedAt;
    state.source = 'persisted';
    state.error = null;
    return true;
  }

  function mergedWx(pack, icao) {
    const packWx = pack && pack.wx && pack.wx.airports && pack.wx.airports[icao];
    const packAtisObj = pack && pack.atis && pack.atis.airports && pack.atis.airports[icao];
    const packAtis = packAtisObj ? { ...packAtisObj, fetchedAt: pack.atis.fetchedAt } : null;
    const liveAp = state.data && state.data.airports && state.data.airports[icao];
    if (!liveAp) {
      return packWx ? { ...packWx, atis: packAtis, live: { metar: false, taf: false, atis: false }, speci: isSpeci(packWx.metar && packWx.metar[0]) } : null;
    }
    return mergeAirport(packWx, packAtis, liveAp);
  }

  function mergedAtis(pack, icao) {
    const e = mergedWx(pack, icao);
    if (!e) return { text: null, source: null, fetchedAt: null, live: false, reason: pack && pack.atis && pack.atis.reasons && pack.atis.reasons[icao] };
    return {
      text: e.atis && e.atis.text,
      source: e.atisSource,
      fetchedAt: e.atisFetchedAt,
      live: !!(e.live && e.live.atis),
      ident: e.atis && e.atis.ident,
      time: e.atis && e.atis.time,
      reason: e.atisReason || (pack && pack.atis && pack.atis.reasons && pack.atis.reasons[icao]) || null,
    };
  }

  function ageText(iso) {
    if (!iso) return '';
    const m = Math.round((Date.now() - new Date(iso).getTime()) / 60000);
    if (m < 1) return 'たった今';
    if (m < 60) return `${m}分前`;
    if (m < 48 * 60) return `${Math.floor(m / 60)}時間${m % 60 ? (m % 60) + '分' : ''}前`;
    return `${Math.floor(m / 1440)}日前`;
  }

  function pill() {
    if (!enabled()) return { hidden: true, text: '', cls: 'pill' };
    const online = typeof navigator === 'undefined' || navigator.onLine;
    if (!state.data) {
      if (state.error) return { hidden: false, text: 'LIVE 失敗', cls: 'pill warn' };
      return { hidden: false, text: 'LIVE --', cls: 'pill' };
    }
    const age = ageText(state.receivedAt || (state.data && state.data.generatedAt));
    if (!online) return { hidden: false, text: `LIVE 受信 ${age}`, cls: 'pill warn' };
    return { hidden: false, text: `LIVE ${age}`, cls: 'pill ok' };
  }

  function tag(live) {
    return live
      ? '<span class="badge live" title="リレー受信の方が新しい">LIVE</span>'
      : '<span class="badge pack" title="パックの報">PACK</span>';
  }

  async function poll(reason) {
    if (!enabled()) return null;
    if (typeof navigator !== 'undefined' && !navigator.onLine) return state.data;
    if (typeof document !== 'undefined' && document.visibilityState && document.visibilityState !== 'visible') return state.data;
    if (state.inflight) return state.data;
    state.inflight = true;
    try {
      const url = `${relayUrl()}${relayUrl().includes('?') ? '&' : '?'}ts=${Date.now()}`;
      const ctl = typeof AbortController !== 'undefined' ? new AbortController() : null;
      const t = ctl && setTimeout(() => ctl.abort(), 8000);
      const res = await fetch(url, { cache: 'no-store', signal: ctl ? ctl.signal : undefined, headers: { Accept: 'application/json' } });
      if (t) clearTimeout(t);
      if (!res.ok) throw new Error(`http-${res.status}`);
      const data = await res.json();
      if (!data || data.schema !== SCHEMA || !data.airports) throw new Error('bad-schema');
      state.data = data;
      const saved = savePersisted(data);
      state.receivedAt = saved.receivedAt;
      state.source = 'network';
      state.error = null;
      if (typeof state.onUpdate === 'function') state.onUpdate({ reason: reason || 'poll' });
      return data;
    } catch (e) {
      state.error = (e && e.name === 'AbortError') ? 'timeout' : 'fetch';
      if (typeof state.onUpdate === 'function') state.onUpdate({ reason: 'error' });
      return null;
    } finally {
      state.inflight = false;
    }
  }

  function tick() {
    if (typeof document !== 'undefined' && document.visibilityState === 'visible' && (typeof navigator === 'undefined' || navigator.onLine)) {
      poll('interval');
    }
  }

  function start(opts) {
    state.onUpdate = opts && opts.onUpdate;
    if (!enabled()) return;
    hydrateFromPersist();
    if (typeof document !== 'undefined') {
      document.addEventListener('visibilitychange', () => {
        if (document.visibilityState === 'visible') poll('visible');
      });
    }
    if (typeof window !== 'undefined') {
      window.addEventListener('online', () => { poll('online'); });
    }
    if (state.timer) clearInterval(state.timer);
    state.timer = setInterval(tick, POLL_MS);
    if (typeof navigator === 'undefined' || navigator.onLine) poll('start');
  }

  function stop() {
    if (state.timer) { clearInterval(state.timer); state.timer = null; }
  }

  const api = {
    SCHEMA, POLL_MS, LS_KEY,
    relayUrl, enabled, parseIso, metarTime, tafTime, atisTime, isNewer, isSpeci,
    mergeAirport, mergedWx, mergedAtis, loadPersisted, savePersisted,
    hydrateFromPersist, poll, start, stop, pill, tag, ageText,
    get data() { return state.data; },
    get receivedAt() { return state.receivedAt; },
    get error() { return state.error; },
    get source() { return state.source; },
    // tests
    _state: state,
  };
  if (typeof window !== 'undefined') window.FBWxLive = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})(typeof globalThis !== 'undefined' ? globalThis : this);
