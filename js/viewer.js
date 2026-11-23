// 図の表示部品
// - FBViewer.compose(frame, urlFn, mode): 1コマ（単画像／横並び row／縦並び stack／重ね layers）を DOM にする
// - 全画面ビューア（ピンチ/ホイール拡大・ドラッグ移動・ダブルタップ・前後送り）
(function () {
  const el = (id) => document.getElementById(id);
  let frames = [], idx = 0, scale = 1, tx = 0, ty = 0, natW = 0, natH = 0, getUrl = null, title = '', onIndex = null, token = 0;
  const pointers = new Map(); let pinch = null, drag = null, lastTap = 0;

  // mode: 'inline' | 'full'
  async function compose(frame, urlFn, mode) {
    const wrap = document.createElement('div');
    const layout = frame.layout || (frame.images.length > 1 ? 'stack' : 'single');
    wrap.className = `fr fr-${layout} fr-${mode}`;
    const urls = await Promise.all((frame.images || []).map((im) => (im && im.url) ? im.url : urlFn(im && im.file)));
    const loads = [];
    urls.forEach((u, i) => {
      const img = new Image();
      img.alt = ''; img.draggable = false; img.decoding = 'async';
      if (layout === 'layers' && i > 0) img.className = 'layer';
      loads.push(new Promise((r) => { img.onload = r; img.onerror = r; }));
      img.src = u;
      wrap.appendChild(img);
    });
    await Promise.all(loads);
    return wrap;
  }

  function apply() { const c = el('v-content').firstElementChild; if (c) c.style.transform = `translate(${tx}px,${ty}px) scale(${scale})`; }
  function fit() {
    const st = el('v-stage').getBoundingClientRect();
    if (!natW) return;
    scale = Math.min(st.width / natW, st.height / natH);
    tx = (st.width - natW * scale) / 2; ty = (st.height - natH * scale) / 2; apply();
  }
  function zoomAt(f, cx, cy) {
    const ns = Math.max(0.05, Math.min(scale * f, 12));
    tx = cx - ((cx - tx) * ns) / scale; ty = cy - ((cy - ty) * ns) / scale; scale = ns; apply();
  }
  async function show(i, keepZoom) {
    idx = (i + frames.length) % frames.length;
    const fr = frames[idx];
    const my = ++token;
    el('v-title').textContent = title || '';
    el('v-info').textContent = `${idx + 1} / ${frames.length}${fr.label ? ' ・ ' + fr.label : ''}`;
    const node = await compose(fr, getUrl, 'full');
    if (my !== token) return;
    const box = el('v-content');
    box.innerHTML = ''; node.style.transform = 'none'; box.appendChild(node);
    natW = node.scrollWidth || 1200; natH = node.scrollHeight || 800;
    if (keepZoom) apply(); else fit();
    onIndex && onIndex(idx);
  }
  // open(frames:[{label,images:[{file}],layout}], index, urlFn, title, onIndex)
  function open(list, i, urlFn, t, cb) {
    frames = list; getUrl = urlFn; title = t || ''; onIndex = cb || null;
    el('viewer').classList.remove('hidden'); show(i);
  }
  function close() { el('viewer').classList.add('hidden'); el('v-content').innerHTML = ''; token++; }
  function center() { const r = el('v-stage').getBoundingClientRect(); return [r.width / 2, r.height / 2]; }
  function setup() {
    el('v-close').onclick = close;
    el('v-prev').onclick = () => show(idx - 1, true);
    el('v-next').onclick = () => show(idx + 1, true);
    el('v-in').onclick = () => zoomAt(1.5, ...center());
    el('v-out').onclick = () => zoomAt(1 / 1.5, ...center());
    el('v-reset').onclick = fit;
    window.addEventListener('resize', () => { if (!el('viewer').classList.contains('hidden')) fit(); });
    document.addEventListener('keydown', (e) => {
      if (el('viewer').classList.contains('hidden')) return;
      if (e.key === 'Escape') close(); if (e.key === 'ArrowLeft') show(idx - 1, true); if (e.key === 'ArrowRight') show(idx + 1, true);
    });
    const stage = el('v-stage');
    const local = (e) => { const r = stage.getBoundingClientRect(); return [e.clientX - r.left, e.clientY - r.top]; };
    stage.addEventListener('wheel', (e) => { e.preventDefault(); zoomAt(e.deltaY < 0 ? 1.15 : 1 / 1.15, ...local(e)); }, { passive: false });
    stage.addEventListener('pointerdown', (e) => {
      stage.setPointerCapture(e.pointerId); pointers.set(e.pointerId, local(e));
      if (pointers.size === 2) {
        const [a, b] = [...pointers.values()];
        pinch = { d: Math.hypot(a[0] - b[0], a[1] - b[1]), s: scale, tx, ty, cx: (a[0] + b[0]) / 2, cy: (a[1] + b[1]) / 2 }; drag = null;
      } else if (pointers.size === 1) {
        const now = Date.now();
        if (now - lastTap < 300) { const [x, y] = local(e); zoomAt(scale < 2 * fitScale() ? 2.5 : 1 / 2.5, x, y); lastTap = 0; }
        else lastTap = now;
        drag = { x: e.clientX, y: e.clientY, tx, ty };
      }
    });
    stage.addEventListener('pointermove', (e) => {
      if (!pointers.has(e.pointerId)) return;
      pointers.set(e.pointerId, local(e));
      if (pinch && pointers.size === 2) {
        const [a, b] = [...pointers.values()];
        const d = Math.hypot(a[0] - b[0], a[1] - b[1]);
        const ns = Math.max(0.05, Math.min(pinch.s * (d / pinch.d), 12));
        const cx = (a[0] + b[0]) / 2, cy = (a[1] + b[1]) / 2;
        tx = cx - ((pinch.cx - pinch.tx) * ns) / pinch.s; ty = cy - ((pinch.cy - pinch.ty) * ns) / pinch.s; scale = ns; apply();
      } else if (drag) { tx = drag.tx + (e.clientX - drag.x); ty = drag.ty + (e.clientY - drag.y); apply(); }
    });
    const up = (e) => { pointers.delete(e.pointerId); if (pointers.size < 2) pinch = null; if (pointers.size === 0) drag = null; };
    stage.addEventListener('pointerup', up); stage.addEventListener('pointercancel', up);
  }
  function fitScale() { const st = el('v-stage').getBoundingClientRect(); return natW ? Math.min(st.width / natW, st.height / natH) : 1; }
  window.FBViewer = { open, close, setup, compose };
})();
