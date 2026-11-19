// 空域 NOTAM の地図（NOTAM タブ > 空域）。MAP タブと同じ同梱基図（オフライン可）・経緯線・（オンライン時だけ）背景タイルを使う別インスタンス。
// 種別ごとの色で、多角形／円／ポイントを描く。タップで短い要約（原文は折りたたみ）。
(function () {
  let map = null, base = null, tiles = null, grat = null, layer = null, markers = new Map(), fitted = false;
  const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

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
  function syncTiles() {
    if (!map || !window.FBMap) return;
    const want = window.FBMap.tilesOn() && navigator.onLine;
    if (want && !tiles) tiles = window.FBMap.tileLayer().addTo(map);
    if (!want && tiles) { map.removeLayer(tiles); tiles = null; }
  }
  function init(el) {
    if (map && map.getContainer() === el) return map;
    if (map) { map.remove(); map = null; }
    map = L.map(el, { zoomControl: true, worldCopyJump: false, minZoom: 4, maxZoom: 11, attributionControl: true }).setView([36.0, 136.5], 5);
    map.attributionControl.setPrefix('Natural Earth');
    map.createPane('land'); map.getPane('land').style.zIndex = 150;
    map.createPane('labels'); map.getPane('labels').style.zIndex = 250; map.getPane('labels').style.pointerEvents = 'none';
    map.createPane('grat'); map.getPane('grat').style.zIndex = 350; map.getPane('grat').style.pointerEvents = 'none';
    map.createPane('areas'); map.getPane('areas').style.zIndex = 420;
    base = window.FBMap.baseLayer().addTo(map);
    grat = L.layerGroup().addTo(map);
    layer = L.layerGroup().addTo(map);
    map.on('moveend zoomend', updateGraticule);
    window.addEventListener('online', syncTiles); window.addEventListener('offline', syncTiles);
    syncTiles(); updateGraticule();
    fitted = false;
    return map;
  }
  const centroid = (pts) => { let la = 0, lo = 0; pts.forEach((p) => { la += p[0]; lo += p[1]; }); return [la / pts.length, lo / pts.length]; };

  // items: [{id, cat, label, geom, ...}]、cats: {id:{color}}、popupHtml(item)、onPick(item)
  function render(el, items, cats, popupHtml, labelsOn) {
    init(el);
    layer.clearLayers(); markers = new Map();
    const bounds = [];
    for (const it of items) {
      const g = it.geom; if (!g) continue;
      const color = cats[it.cat]?.color || '#888';
      const lab = labelsOn ? { permanent: true, direction: 'center', className: `area-lbl cat-${it.cat}`, opacity: 1 } : null;
      const shapes = [];
      if (g.type === 'poly') for (const poly of g.polys) shapes.push(L.polygon(poly, { pane: 'areas', color, weight: 1.6, fillColor: color, fillOpacity: it.cat === 'uav' ? 0.12 : 0.2 }));
      else if (g.type === 'circle') {
        const r = g.rNm * 1852;
        shapes.push(r < 400 ? L.circleMarker(g.c, { pane: 'areas', radius: 7, color: '#fff', weight: 1.5, fillColor: color, fillOpacity: 0.95 }) : L.circle(g.c, { pane: 'areas', radius: r, color, weight: 1.6, fillColor: color, fillOpacity: it.cat === 'uav' ? 0.12 : 0.2 }));
      } else if (g.type === 'point') {
        shapes.push(L.marker(g.c, { pane: 'areas', icon: L.divIcon({ className: 'area-pt', html: `<span style="background:${color}">⚠</span>`, iconSize: [22, 22], iconAnchor: [11, 11] }) }));
      }
      for (const s of shapes) {
        s.bindPopup(() => popupHtml(it), { maxWidth: 300, className: 'fb-popup' });
        s.addTo(layer);
        (markers.get(it.key) || markers.set(it.key, []).get(it.key)).push(s);
        const c = s.getBounds ? s.getBounds().getCenter() : s.getLatLng();
        bounds.push([c.lat, c.lng]);
      }
      if (lab && shapes.length) shapes[0].bindTooltip(it.label, lab);
    }
    if (!fitted) { map.setView([36.0, 136.5], 5); fitted = true; }
    setTimeout(() => { map.invalidateSize(); updateGraticule(); }, 30);
  }
  function focus(key) {
    const arr = markers.get(key); if (!arr || !arr.length || !map) return false;
    const s = arr[0];
    const b = s.getBounds ? s.getBounds() : L.latLngBounds([s.getLatLng(), s.getLatLng()]);
    map.fitBounds(b.pad(0.6), { maxZoom: 9 });
    s.openPopup(s.getBounds ? b.getCenter() : undefined);
    return true;
  }
  function refreshTheme() { if (tiles) { map.removeLayer(tiles); tiles = null; syncTiles(); } }
  function invalidate() { if (map) setTimeout(() => { map.invalidateSize(); updateGraticule(); }, 30); }
  window.FBAreaMap = { render, focus, refreshTheme, invalidate, esc };
})();
