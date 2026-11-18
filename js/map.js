// MAP（旧 Flight Buddy の MAP タブに相当）
// - Leaflet（同梱・オフライン可）＋同梱の基図（Natural Earth 簡略化 GeoJSON。全世界＋東アジア詳細）
// - オンライン時だけ任意で背景タイル（Esri Dark/Light Gray）を重ねる（キャッシュしない）
// - 空港: パック内の全空港を飛行状態（VFR/MVFR/IFR/LIFR）の色で表示。選択空港は大きく＋ICAOラベル
//   タップでポップアップ（METAR / TAF / NOTAM件数）。経緯線、現在地（位置情報、オフラインでも可）
(function () {
  const CAT = { VFR: '#00C853', MVFR: '#2196F3', IFR: '#E53935', LIFR: '#C2185B' }; // wx-brief main public/js/map.js FLIGHT_CATEGORY_COLORS と同じ
  const KASHIMA = [35.9919, 140.6403];
  // 鹿島アントラーズ公式エンブレム（空港の点と同じ大きさ＝14px（選択中の点 14px・通常の点 10px）。2x 用に縮小済みの icons/antlers-emblem-32.png。鹿シルエットは廃止）
  const EMBLEM = '<img class="emb" src="icons/antlers-emblem-32.png" alt="" draggable="false">';
  const PLANE = '<svg viewBox="0 0 24 24" width="16" height="16"><path d="M12 2 L13.2 8.5 L22 13.5 L22 15.3 L13.2 12.3 L13.5 18.5 L16.5 20.5 L16.5 22 L12 20.8 L7.5 22 L7.5 20.5 L10.5 18.5 L10.8 12.3 L2 15.3 L2 13.5 L10.8 8.5 Z" fill="#29B6F6" stroke="#0d3c5c" stroke-width="0.8" stroke-linejoin="round"/></svg>';
  let map = null, base = null, tiles = null, apLayer = null, grat = null, posMarker = null, fitted = false, tilesWanted = true, geoStarted = false;
  const isLight = () => getComputedStyle(document.documentElement).getPropertyValue('color-scheme').trim() === 'light';

  function baseLayer() {
    const B = window.FB_BASEMAP;
    if (!B) return L.layerGroup();
    const R = B.region_bbox;
    const inReg = (ring) => ring.every(([x, y]) => x >= R[0] && x <= R[1] && y >= R[2] && y <= R[3]);
    const toLL = (ring) => ring.map(([x, y]) => [y, x]);
    // 地域内は詳細版、地域外は全世界版（地域と重なる世界版の輪郭は描かない）
    const world = B.world.filter((r) => !inReg(r)).map(toLL);
    const region = B.region.map(toLL);
    const style = { className: 'fb-land', weight: 1, fillOpacity: 1, interactive: false };
    // 専用 pane（tilePane=200 より下）。オンラインの背景タイルが上に来るので、地名（Reference タイル）が陸地ポリゴンに隠れない
    const st = { ...style, pane: 'land' };
    return L.layerGroup([L.polygon(world, st), L.polygon(region, st)]);
  }
  function tileLayer() {
    const v = isLight() ? 'World_Light_Gray' : 'World_Dark_Gray';
    return L.layerGroup([
      L.tileLayer(`https://services.arcgisonline.com/ArcGIS/rest/services/Canvas/${v}_Base/MapServer/tile/{z}/{y}/{x}`, { maxZoom: 12, attribution: '&copy; Esri, HERE, Garmin, FAO, NOAA, USGS, &copy; OpenStreetMap contributors' }),
      // 地名（Reference）は経緯線・空港マーカーより下、背景より上の専用 pane。pointer-events なし
      L.tileLayer(`https://services.arcgisonline.com/ArcGIS/rest/services/Canvas/${v}_Reference/MapServer/tile/{z}/{y}/{x}`, { maxZoom: 12, pane: 'labels' }),
    ]);
  }
  function syncTiles() {
    if (!map) return;
    const want = tilesWanted && navigator.onLine;
    if (want && !tiles) { tiles = tileLayer().addTo(map); }
    if (!want && tiles) { map.removeLayer(tiles); tiles = null; }
    const b = document.querySelector('.fb-tiles-btn');
    if (b) { b.classList.toggle('on', want); b.title = navigator.onLine ? '背景タイル（オンライン）' : 'オフライン：同梱の基図のみ'; b.disabled = !navigator.onLine; }
  }
  // 経緯線の間隔は旧版（wx-brief public/js/map.js graticuleStepForZoom）と同じ：zoom ≤4 → 10°、≤6 → 5°、≤8 → 2°、それ以上 → 1°
  function updateGraticule() {
    if (!map) return;
    grat.clearLayers();
    const z = map.getZoom(), step = z <= 4 ? 10 : z <= 6 ? 5 : z <= 8 ? 2 : 1;
    const b = map.getBounds(), opt = { pane: 'grat', className: 'fb-grat', weight: 1, interactive: false };
    const lbl = (p, text) => L.marker(p, { pane: 'grat', interactive: false, keyboard: false, icon: L.divIcon({ className: 'fb-grat-lbl', html: text, iconSize: [40, 14] }) }).addTo(grat);
    for (let lat = Math.ceil(b.getSouth() / step) * step; lat <= b.getNorth(); lat += step) {
      L.polyline([[lat, b.getWest()], [lat, b.getEast()]], opt).addTo(grat);
      lbl(map.containerPointToLatLng([24, map.latLngToContainerPoint([lat, b.getWest()]).y]), `${Math.abs(lat)}${lat >= 0 ? 'N' : 'S'}`);
    }
    for (let lon = Math.ceil(b.getWest() / step) * step; lon <= b.getEast(); lon += step) {
      L.polyline([[b.getSouth(), lon], [b.getNorth(), lon]], opt).addTo(grat);
      const v = ((lon + 540) % 360) - 180;
      lbl(map.containerPointToLatLng([map.latLngToContainerPoint([b.getNorth(), lon]).x, 10]), `${Math.abs(v)}${v >= 0 ? 'E' : 'W'}`);
    }
  }
  function showPos(lat, lon) {
    if (posMarker) posMarker.setLatLng([lat, lon]);
    else posMarker = L.marker([lat, lon], { zIndexOffset: 1000, icon: L.divIcon({ className: 'fb-pos', html: `<span class="halo"></span>${PLANE}`, iconSize: [34, 34] }) }).addTo(map);
  }
  // ---- 現在地。失敗の理由は画面に出す（旧版は console.warn のみで、端末では原因が見えなかった）
  let geoMsgEl = null, geoMsgTimer = null, geoDeniedShown = false;
  function geoMsg(text, ms) {
    if (!map) return;
    if (!geoMsgEl) { geoMsgEl = document.createElement('div'); geoMsgEl.className = 'fb-geo-msg'; map.getContainer().appendChild(geoMsgEl); }
    geoMsgEl.textContent = text; geoMsgEl.style.display = 'block';
    clearTimeout(geoMsgTimer); geoMsgTimer = setTimeout(() => { geoMsgEl.style.display = 'none'; }, ms || 7000);
  }
  function geoError(err, manual) {
    console.warn('[FBMap] 位置情報を取得できませんでした', err && err.code, err && err.message);
    if (err && err.code === 1) {
      if (manual || !geoDeniedShown) geoMsg('位置情報が許可されていません。iPhone：設定 > プライバシーとセキュリティ > 位置情報サービス で、Safari（ホーム画面のアプリ）を「使用中のみ」にしてください。', 10000);
      geoDeniedShown = true;
    } else if (manual) {
      geoMsg(err && err.code === 3 ? '現在地の取得に時間がかかっています。取得でき次第表示します。' : '現在地を取得できません（電波状況など）。取得でき次第表示します。', 6000);
    }
  }
  function startWatch() {
    if (geoStarted) return; geoStarted = true;
    navigator.geolocation.watchPosition((q) => showPos(q.coords.latitude, q.coords.longitude), (e) => { if (e && e.code === 1) geoStarted = false; geoError(e, false); }, { enableHighAccuracy: false, maximumAge: 30000, timeout: 30000 });
  }
  function locate(fly) {
    if (!navigator.geolocation) { if (fly) geoMsg('この端末では位置情報を使えません。', 5000); return; }
    // 取得は fly（ボタン）でもそうでなくても同じ。自動のときは地図を動かさない
    navigator.geolocation.getCurrentPosition((p) => {
      showPos(p.coords.latitude, p.coords.longitude);
      if (fly) map.setView([p.coords.latitude, p.coords.longitude], Math.max(map.getZoom(), 10));
      startWatch();
    }, (e) => { geoError(e, fly); if (!e || e.code !== 1) startWatch(); }, { enableHighAccuracy: false, timeout: 15000, maximumAge: 30000 });
  }
  function control(html, title, cls, onClick) {
    const C = L.Control.extend({ options: { position: 'topright' }, onAdd() {
      const b = L.DomUtil.create('button', `fb-map-btn ${cls}`); b.type = 'button'; b.title = title; b.innerHTML = html;
      L.DomEvent.disableClickPropagation(b); L.DomEvent.on(b, 'click', onClick); return b;
    } });
    return new C();
  }
  function init(el) {
    if (map) return map;
    map = L.map(el, { zoomControl: true, preferCanvas: false, worldCopyJump: true, minZoom: 2, maxZoom: 12, attributionControl: true }).setView([36.2, 138.3], 5);
    map.attributionControl.setPrefix('Natural Earth');
    map.createPane('land'); map.getPane('land').style.zIndex = 150;                                              // 同梱の基図（オフライン用）。背景タイルの下
    map.createPane('labels'); map.getPane('labels').style.zIndex = 250; map.getPane('labels').style.pointerEvents = 'none'; // 地名
    map.createPane('grat'); map.getPane('grat').style.zIndex = 350; map.getPane('grat').style.pointerEvents = 'none';     // 経緯線
    base = baseLayer().addTo(map);
    grat = L.layerGroup().addTo(map);
    apLayer = L.layerGroup().addTo(map);
    L.marker(KASHIMA, { icon: L.divIcon({ className: 'fb-kashima', html: EMBLEM, iconSize: [14, 14], iconAnchor: [7, 7] }) }).addTo(map).bindPopup('KASHIMA');
    control('<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><circle cx="12" cy="12" r="3"/><path d="M12 2v4M12 18v4M2 12h4M18 12h4"/></svg>', '現在地', 'fb-locate', () => locate(true)).addTo(map);
    control('<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7"><path d="M12 3l9 5-9 5-9-5 9-5z"/><path d="M3 13l9 5 9-5"/></svg>', '背景タイル（オンライン）', 'fb-tiles-btn', () => { tilesWanted = !tilesWanted; try { localStorage.setItem('fb.mapTiles', JSON.stringify(tilesWanted)); } catch (e) { /* */ } syncTiles(); }).addTo(map);
    try { const v = JSON.parse(localStorage.getItem('fb.mapTiles')); if (v === false) tilesWanted = false; } catch (e) { /* */ }
    map.on('moveend zoomend', updateGraticule);
    window.addEventListener('resize', () => { map.invalidateSize(); updateGraticule(); });
    window.addEventListener('online', syncTiles); window.addEventListener('offline', syncTiles);
    syncTiles(); updateGraticule(); locate(false);
    return map;
  }
  // airports: [{icao, name, codes, lat, lon, cat, sel, popupHtml}]
  function render(el, airports) {
    init(el);
    apLayer.clearLayers();
    const selPts = [];
    for (const a of airports.slice().sort((x, y) => x.sel - y.sel)) {
      const color = CAT[a.cat] || 'var(--text-faint)';
      const html = a.sel
        ? `<span class="ring"></span><span class="dot" style="background:${color}"></span><b class="ap-code">${a.icao}</b>`
        : `<span class="dot" style="background:${color}"></span>`;
      const m = L.marker([a.lat, a.lon], { zIndexOffset: a.sel ? 500 : 0, icon: L.divIcon({ className: `fb-ap${a.sel ? ' sel' : ''}`, html, iconSize: a.sel ? [26, 26] : [12, 12] }) });
      m.bindTooltip(`${a.name} ${a.codes}${a.cat ? ' ・ ' + a.cat : ''}`, { direction: 'top', offset: [0, -6] });
      m.bindPopup(() => a.popupHtml(), { maxWidth: 320, className: 'fb-popup' });
      m.addTo(apLayer);
      if (a.sel && a.lat > 18 && a.lat < 50 && a.lon > 118 && a.lon < 155) selPts.push([a.lat, a.lon]); // 初期表示は日本周辺の選択空港に合わせる（海外はパンで）
    }
    if (!fitted && selPts.length) { map.fitBounds(selPts, { padding: [40, 40], maxZoom: 7 }); fitted = true; }
  }
  function refreshTheme() { if (tiles) { map.removeLayer(tiles); tiles = null; syncTiles(); } }
  function invalidate() { if (map) setTimeout(() => map.invalidateSize(), 30); }
  window.FBMap = { render, invalidate, refreshTheme, get map() { return map; } };
})();
