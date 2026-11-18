// Flight Buddy main
(function () {
  const APP_VERSION = '1.0.0';
  const $ = (id) => document.getElementById(id);
  const esc = window.FBWx.esc;
  const LS = { airports: 'fb.airports', duty: 'fb.duty', tab: 'fb.tab', notamH: 'fb.notamHours', viewPack: 'fb.viewPack' };
  const lsGet = (k, d) => { try { const v = localStorage.getItem(k); return v == null ? d : JSON.parse(v); } catch { return d; } };
  const lsSet = (k, v) => localStorage.setItem(k, JSON.stringify(v));
  const AIRLINES = ['SFJ', 'ANA', 'JAL', 'SNJ', 'ADO', 'SKY', 'APJ', 'JJP', 'FDA', 'IBX'];

  const state = {
    pack: null, // {manifest, wx, notam, airports, brief, charts, imageUrl}
    packSource: '', // 'latest' | 'cached' | 'previous'
    remoteError: null,
    downloading: null,
    airports: lsGet(LS.airports, null),
    duty: lsGet(LS.duty, { date: todayJst(), buffer: 2, airline: 'SFJ', flights: [], note: '' }),
    notamHours: lsGet(LS.notamH, 24),
    chartFilter: 'ALL',
  };

  function todayJst() { return new Date(Date.now() + 9 * 3600000).toISOString().slice(0, 10); }
  function fmtJst(iso, withDate = true) {
    if (!iso) return '--';
    const d = new Date(new Date(iso).getTime() + 9 * 3600000).toISOString();
    return withDate ? `${d.slice(5, 7)}/${d.slice(8, 10)} ${d.slice(11, 16)} JST` : `${d.slice(11, 16)} JST`;
  }
  function fmtUtc(iso) { if (!iso) return '--'; const d = new Date(iso).toISOString(); return `${d.slice(8, 10)}日 ${d.slice(11, 16)}Z`; }
  function ageText(iso) {
    if (!iso) return '';
    const m = Math.round((Date.now() - new Date(iso).getTime()) / 60000);
    if (m < 1) return 'たった今'; if (m < 60) return `${m}分前`; if (m < 48 * 60) return `${Math.floor(m / 60)}時間${m % 60 ? (m % 60) + '分' : ''}前`;
    return `${Math.floor(m / 1440)}日前`;
  }
  const fmtBytes = (b) => (b > 1048576 ? `${(b / 1048576).toFixed(1)}MB` : `${Math.round((b || 0) / 1024)}KB`);
  const airportInfo = (icao) => (window.FB_AIRPORTS || []).find((a) => a.icao === icao) || null;
  const apName = (icao) => { const a = airportInfo(icao); const p = state.pack?.airports?.airports?.[icao]; return a ? a.name : (p?.name || icao); };
  const apCodes = (icao) => { const a = airportInfo(icao); return a ? `${a.icao} / ${a.iata}` : icao; };
  function mainAirports() {
    if (state.airports && state.airports.length) return state.airports;
    return state.pack?.manifest?.airports || ['RJTT', 'RJFF'];
  }
  const naBox = (text) => `<span class="na-text">${esc(text || '未取得')}</span>`;

  // ---------------------------------------------------------------- header / status
  function renderClock() {
    const now = new Date();
    const j = new Date(now.getTime() + 9 * 3600000).toISOString();
    $('clock').textContent = `${j.slice(11, 16)}J ${now.toISOString().slice(11, 16)}Z`;
  }
  function renderStatus() {
    const online = navigator.onLine;
    const net = $('net-pill');
    net.textContent = online ? 'ONLINE' : 'OFFLINE';
    net.className = `pill ${online ? 'ok' : 'off'}`;
    const m = state.pack?.manifest;
    const pp = $('pack-pill');
    const banner = $('stale-banner');
    if (!m) {
      pp.textContent = 'PACK なし'; pp.className = 'pill bad';
      $('status-text').textContent = state.downloading ? `パック保存中 ${state.downloading}` : (state.remoteError ? `パック未保存（${state.remoteError}）` : 'パック未保存');
      banner.classList.add('hidden');
      return;
    }
    const ageH = (Date.now() - new Date(m.generatedAt).getTime()) / 3600000;
    pp.textContent = `PACK ${ageText(m.generatedAt)}`;
    pp.className = `pill ${ageH > 12 ? 'bad' : ageH > 3 ? 'warn' : 'ok'}`;
    let src;
    if (state.packSource === 'previous') src = '1つ前のパックを表示中';
    else if (state.packSource === 'latest') src = '最新パック（オフライン保存済み✓）';
    else src = online ? `保存済みパックを表示中${state.remoteError ? '（最新確認に失敗）' : ''}` : 'オフライン：保存済みパックを表示中';
    if (state.downloading) src += ` ／ 新しいパック保存中 ${state.downloading}`;
    if (m.sample) src += ' ／ SAMPLE含む';
    $('status-text').textContent = `パック ${fmtJst(m.generatedAt)}（${fmtUtc(m.generatedAt)}）・ ${src}`;
    if (ageH > 3) {
      banner.textContent = ageH > 12 ? `⚠ パックが ${ageText(m.generatedAt)} のものです。最新の公式情報を確認してください。` : `パックは ${ageText(m.generatedAt)} に作成されました。`;
      banner.className = `stale-banner${ageH > 12 ? ' bad' : ''}`;
    } else banner.className = 'stale-banner hidden';
  }

  // ---------------------------------------------------------------- tabs
  function setupTabs() {
    const btns = document.querySelectorAll('.tab-btn');
    const go = (tab) => {
      btns.forEach((b) => b.classList.toggle('active', b.dataset.tab === tab));
      document.querySelectorAll('.tab-panel').forEach((p) => p.classList.toggle('active', p.id === `tab-${tab}`));
      lsSet(LS.tab, tab);
    };
    btns.forEach((b) => b.addEventListener('click', () => go(b.dataset.tab)));
    go(lsGet(LS.tab, 'brief'));
  }

  // ---------------------------------------------------------------- BRIEF
  function mdToHtml(md) {
    const lines = String(md || '').split(/\r?\n/);
    let html = '', inList = false;
    const inline = (s) => esc(s).replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>').replace(/`(.+?)`/g, '<code>$1</code>');
    for (const l of lines) {
      const h = l.match(/^(#{1,3})\s+(.*)$/), li = l.match(/^\s*[-*・]\s+(.*)$/);
      if (li) { if (!inList) { html += '<ul>'; inList = true; } html += `<li>${inline(li[1])}</li>`; continue; }
      if (inList) { html += '</ul>'; inList = false; }
      if (h) html += `<h${h[1].length}>${inline(h[2])}</h${h[1].length}>`;
      else if (l.trim()) html += `<p>${inline(l)}</p>`;
    }
    if (inList) html += '</ul>';
    return html;
  }
  function renderBrief() {
    const b = state.pack?.brief, m = state.pack?.manifest;
    if (!m) { $('brief-meta').textContent = ''; $('brief-body').innerHTML = '<p class="hint">まだパックがありません。オンラインで一度開くと自動で保存されます。</p>'; return; }
    $('brief-meta').innerHTML = `パック作成 ${esc(fmtJst(m.generatedAt))}（${esc(fmtUtc(m.generatedAt))}）${b?.writtenAt ? ` ／ 本文 ${esc(fmtJst(b.writtenAt))}` : ''}${b?.author ? ` ／ ${esc(b.author)}` : ''}`;
    $('brief-body').innerHTML = b?.ok && b.text ? mdToHtml(b.text) : '<p class="hint">このパックにはボットのブリーフ本文がありません（未作成）。</p>';
  }

  // ---------------------------------------------------------------- WX
  function renderWx() {
    const wx = state.pack?.wx;
    $('wx-meta').textContent = wx ? `取得 ${fmtJst(wx.fetchedAt)} ／ 出所 ${wx.source}` : 'パックがありません。';
    const list = $('wx-list'); list.innerHTML = '';
    for (const icao of mainAirports()) {
      const e = wx?.airports?.[icao];
      const card = document.createElement('div'); card.className = 'card';
      let body;
      if (!e) body = `<p class="hint">このパックに未収録です（次回のボット更新で追加されます）。</p>`;
      else if (!e.ok) body = `<p class="hint">未取得：${esc(e.error || '')}</p>`;
      else {
        const latest = e.metar?.[0];
        const cat = latest ? (latest.fltCat || window.FBWx.flightCategory(latest.raw)) : null;
        const dec = latest ? window.FBWx.decodeMetar(latest.raw) : [];
        body = `${e.carriedOver ? `<p class="hint"><span class="badge stale">STALE</span> 今回の取得に失敗したため前回の値です（${esc(fmtJst(e.fetchedAt))}取得）</p>` : ''}
          <div class="sub-label">METAR ${latest ? `${esc(fmtUtc(latest.obsTime))}（${esc(fmtJst(latest.obsTime, false))}）` : ''} ${cat ? `<span class="badge ${cat}">${cat}</span>` : ''}</div>
          ${latest ? `<div class="raw">${window.FBWx.highlight(latest.raw)}</div>` : naBox('METAR 未取得')}
          ${dec.length ? `<dl class="decode">${dec.map(([k, v]) => `<dt>${esc(k)}</dt><dd>${esc(v)}</dd>`).join('')}</dl>` : ''}
          ${e.metar?.length > 1 ? `<details><summary>過去のMETAR（${e.metar.length - 1}件）</summary>${e.metar.slice(1).map((x) => `<div class="raw" style="margin-top:4px">${window.FBWx.highlight(x.raw)}</div>`).join('')}</details>` : ''}
          <div class="sub-label">TAF ${e.taf ? `発表 ${esc(fmtUtc(e.taf.issueTime))} ／ 有効 ${esc(fmtUtc(e.taf.validFrom))}〜${esc(fmtUtc(e.taf.validTo))}` : ''}</div>
          ${e.taf ? `<div class="raw">${window.FBWx.tafLines(e.taf.raw)}</div>` : naBox('TAF 未取得')}`;
      }
      card.innerHTML = `<div class="card-title"><span>${esc(apName(icao))} <span class="codes hint">${esc(apCodes(icao))}</span></span></div>${body}`;
      list.appendChild(card);
    }
  }

  // ---------------------------------------------------------------- CHARTS
  async function renderCharts() {
    const charts = state.pack?.charts?.charts || [];
    const grid = $('chart-grid'); grid.innerHTML = '';
    const skipped = state.pack?.charts?.skippedRestricted || [];
    $('charts-meta').innerHTML = state.pack ? `${charts.length}枚（端末に保存済み・オフライン表示可）${charts.some((c) => c.sample) ? ' ／ <span class="badge sample">SAMPLE</span> は表示確認用の見本です' : ''}${skipped.length ? ` ／ 公開不可のため除外 ${skipped.length}枚` : ''}` : 'パックがありません。';
    const cats = ['ALL', ...new Set(charts.map((c) => c.category || 'その他'))];
    const f = $('chart-filters'); f.innerHTML = '';
    if (!cats.includes(state.chartFilter)) state.chartFilter = 'ALL';
    cats.forEach((c) => {
      const b = document.createElement('button'); b.className = `chip${c === state.chartFilter ? ' active' : ''}`; b.textContent = c;
      b.onclick = () => { state.chartFilter = c; renderCharts(); }; f.appendChild(b);
    });
    const shown = charts.filter((c) => state.chartFilter === 'ALL' || (c.category || 'その他') === state.chartFilter);
    const items = shown.map((c) => ({ ...c, info: [c.validTime ? `${fmtUtc(c.validTime)}（${fmtJst(c.validTime, false)}）` : c.validTimeHint || '', c.source || ''].filter(Boolean).join(' ・ ') }));
    if (!shown.length && state.pack) grid.innerHTML = '<p class="hint">図はありません。</p>';
    for (let i = 0; i < items.length; i++) {
      const c = items[i];
      const card = document.createElement('div'); card.className = 'chart-card';
      card.innerHTML = `<div class="thumb"><img alt="" /></div><div class="meta"><div class="t">${esc(c.title)} ${c.sample ? '<span class="badge sample">SAMPLE</span>' : ''}</div><div class="hint">${esc(c.info)}</div></div>`;
      card.onclick = () => window.FBViewer.open(items, i, state.pack.imageUrl);
      grid.appendChild(card);
      state.pack.imageUrl(c.file).then((u) => { card.querySelector('img').src = u; });
    }
  }

  // ---------------------------------------------------------------- NOTAM
  function renderNotam() {
    document.querySelectorAll('#notam-period .chip').forEach((b) => b.classList.toggle('active', Number(b.dataset.hours) === state.notamHours));
    const n = state.pack?.notam, list = $('notam-list'); list.innerHTML = '';
    const ref = state.pack ? new Date(state.pack.manifest.generatedAt).getTime() : Date.now();
    for (const icao of mainAirports()) {
      const box = document.createElement('div'); box.className = 'card';
      const items = (n?.airports?.[icao]?.items || []).slice();
      const isNew = (it) => state.notamHours > 0 && it.issued && ref - new Date(it.issued).getTime() <= state.notamHours * 3600000;
      items.sort((a, b) => (isNew(b) - isNew(a)) || String(b.issued || '').localeCompare(String(a.issued || '')));
      const newCount = items.filter(isNew).length;
      let body;
      if (!n) body = '<p class="hint">パックがありません。</p>';
      else if (!n.ok) body = `<p class="hint">未取得：${esc(n.note || '')}</p>`;
      else if (!n.airports?.[icao]) body = '<p class="hint">このパックに未収録です。</p>';
      else if (!items.length) body = '<p class="hint">該当NOTAMなし（このパックの範囲）</p>';
      else body = items.map((it) => `<div class="notam-item${state.notamHours > 0 && !isNew(it) ? ' old' : ''}"><span class="nid">${esc(it.id || '')}</span> ${isNew(it) ? '<span class="badge new">NEW</span>' : ''} <span class="hint">発行 ${esc(fmtJst(it.issued))}${it.effectiveFrom ? ` ／ 有効 ${esc(fmtUtc(it.effectiveFrom))}〜${esc(it.effectiveTo ? fmtUtc(it.effectiveTo) : 'PERM')}` : ''}</span><pre>${esc(it.text || '')}</pre></div>`).join('');
      box.innerHTML = `<div class="card-title"><span>${esc(apName(icao))} <span class="hint">${esc(apCodes(icao))}</span></span>${n?.ok && items.length ? `<span class="badge${newCount ? ' new' : ''}">${state.notamHours ? `直近 ${newCount}件 / ` : ''}全${items.length}件</span>` : ''}</div>${body}`;
      list.appendChild(box);
    }
    if (n?.source) { const p = document.createElement('p'); p.className = 'hint'; p.textContent = `出所：${n.source}`; list.appendChild(p); }
  }

  // ---------------------------------------------------------------- AIRPORT
  function renderAirport() {
    const date = $('airport-date').value || todayJst();
    const list = $('airport-list'); list.innerHTML = '';
    for (const icao of mainAirports()) {
      const p = state.pack?.airports?.airports?.[icao] || {};
      const base = airportInfo(icao);
      const lat = p.lat ?? base?.lat, lon = p.lon ?? base?.lon;
      const sun = lat != null ? window.FBSun.sunTimesJst(lat, lon, date) : null;
      const field = (k, v) => `<div class="field"><span class="k">${esc(k)}</span><span>${v == null || v === '' ? naBox() : v}</span></div>`;
      const rwy = p.runways?.length ? p.runways.map((r) => `${esc(r.id)} <span class="hint">${esc(r.dimensionFt || '')}ft${r.alignment != null ? ` / 真方位${esc(r.alignment)}°` : ''}</span>`).join('<br>') : null;
      const freqs = p.freqs?.length ? p.freqs.map((f) => `${esc(f.type)} ${esc(f.mhz)}`).join(' ／ ') : null;
      const card = document.createElement('div'); card.className = 'card';
      card.innerHTML = `<div class="card-title"><span>${esc(apName(icao))} <span class="hint">${esc(apCodes(icao))}</span></span>${state.pack?.airports?.airports?.[icao] ? '' : '<span class="badge na">パック未収録</span>'}</div>
        ${field('運用時間', p.operatingHours ? esc(p.operatingHours) : null)}
        ${field('滑走路', rwy)}
        ${field('進入方式', p.approaches ? esc(p.approaches) : null)}
        ${field('日の出・日没', sun ? `日の出 ${esc(sun.sunrise || '--:--')} / 日没 ${esc(sun.sunset || '--:--')} <span class="hint">(${esc(date)} JST)</span>` : null)}
        ${field('標高', p.elevationFt != null ? `約 ${esc(p.elevationFt)} ft` : null)}
        ${field('磁気偏差', p.magdec ? esc(p.magdec) : null)}
        ${field('周波数', freqs)}
        ${p.notes ? field('メモ', esc(p.notes)) : ''}`;
      list.appendChild(card);
    }
    if (state.pack?.airports?.source) { const s = document.createElement('p'); s.className = 'hint'; s.textContent = `出所：${state.pack.airports.source}。運用時間などは目安です。`; list.appendChild(s); }
  }

  // ---------------------------------------------------------------- DUTY
  function saveDuty() { lsSet(LS.duty, state.duty); }
  function setupDuty() {
    const d = state.duty;
    $('duty-date').value = d.date || todayJst();
    $('duty-buffer').value = String(d.buffer || 2);
    $('duty-note').value = d.note || '';
    const sel = $('duty-airline');
    sel.innerHTML = AIRLINES.map((c) => `<option${c === d.airline ? ' selected' : ''}>${c}</option>`).join('');
    $('duty-date').onchange = (e) => { d.date = e.target.value; saveDuty(); $('airport-date').value = d.date; renderAirport(); };
    $('duty-buffer').onchange = (e) => { d.buffer = Number(e.target.value); saveDuty(); };
    $('duty-note').oninput = (e) => { d.note = e.target.value; saveDuty(); };
    sel.onchange = (e) => { d.airline = e.target.value; saveDuty(); };
    $('duty-flight').oninput = (e) => { const v = e.target.value.replace(/[^0-9]/g, ''); if (v !== e.target.value) e.target.value = v; };
    const add = () => {
      const v = $('duty-flight').value.replace(/[^0-9]/g, '');
      if (!v) return;
      const fl = `${d.airline}${v}`;
      if (!d.flights.includes(fl)) d.flights.push(fl);
      $('duty-flight').value = ''; saveDuty(); renderDuty();
    };
    $('duty-add').onclick = add;
    $('duty-flight').onkeydown = (e) => { if (e.key === 'Enter') add(); };
    renderDuty();
  }
  function renderDuty() {
    const ul = $('duty-list'); ul.innerHTML = '';
    if (!state.duty.flights.length) ul.innerHTML = '<li class="hint">便が登録されていません</li>';
    state.duty.flights.forEach((f, i) => {
      const li = document.createElement('li');
      li.innerHTML = `<span><strong>${esc(f)}</strong></span><button class="btn btn-danger">削除</button>`;
      li.querySelector('button').onclick = () => { state.duty.flights.splice(i, 1); saveDuty(); renderDuty(); };
      ul.appendChild(li);
    });
    const pd = state.pack?.manifest?.duty;
    $('duty-pack').innerHTML = pd ? `ボットのパックのDUTY：${esc(pd.date || '')} ${esc((pd.flights || []).join(', '))}${pd.note ? ` ／ ${esc(pd.note)}` : ''}` : '';
  }

  // ---------------------------------------------------------------- TAS
  function setupTas() {
    window.FBTas.build($('tas-table'));
    $('tas-kt').oninput = (e) => { const v = parseFloat(e.target.value); $('tas-kmh').value = Number.isFinite(v) ? (v * 1.852).toFixed(1) : ''; };
    $('tas-kmh').oninput = (e) => { const v = parseFloat(e.target.value); $('tas-kt').value = Number.isFinite(v) ? (v / 1.852).toFixed(1) : ''; };
  }

  // ---------------------------------------------------------------- SETTINGS
  function setupAirportPicker() {
    const search = $('ap-search');
    const renderSel = () => {
      const ul = $('ap-selected'); ul.innerHTML = '';
      mainAirports().forEach((icao, i) => {
        const li = document.createElement('li');
        li.innerHTML = `<span>${esc(apName(icao))} <span class="codes">${esc(apCodes(icao))}</span></span><span><button class="btn" data-a="up">↑</button> <button class="btn btn-danger" data-a="rm">削除</button></span>`;
        li.querySelector('[data-a=rm]').onclick = () => { const l = mainAirports().slice(); l.splice(i, 1); state.airports = l; lsSet(LS.airports, l); renderAll(); };
        li.querySelector('[data-a=up]').onclick = () => { if (!i) return; const l = mainAirports().slice(); [l[i - 1], l[i]] = [l[i], l[i - 1]]; state.airports = l; lsSet(LS.airports, l); renderAll(); };
        ul.appendChild(li);
      });
    };
    const renderRes = () => {
      const q = search.value.trim().toUpperCase(), qj = search.value.trim();
      const ul = $('ap-results'); ul.innerHTML = '';
      if (!q) return;
      let res = (window.FB_AIRPORTS || []).filter((a) => a.icao.includes(q) || a.iata.includes(q) || a.name.includes(qj)).slice(0, 10);
      if (!res.length && /^[A-Z]{4}$/.test(q)) res = [{ icao: q, iata: '', name: `${q}（リスト外）` }];
      res.forEach((a) => {
        const li = document.createElement('li');
        li.innerHTML = `<span>${esc(a.name)} <span class="codes">${esc(a.icao)}${a.iata ? ' / ' + esc(a.iata) : ''}</span></span><span>${mainAirports().includes(a.icao) ? '✓' : '＋'}</span>`;
        li.onclick = () => { const l = mainAirports().slice(); if (!l.includes(a.icao)) l.push(a.icao); state.airports = l; lsSet(LS.airports, l); search.value = ''; ul.innerHTML = ''; renderAll(); };
        ul.appendChild(li);
      });
    };
    search.oninput = renderRes;
    setupAirportPicker.renderSel = renderSel;
  }
  async function renderPackInfo() {
    const box = $('pack-info');
    const packs = window.FBPack.list();
    const cur = state.pack?.manifest;
    let est = '';
    try { const e = await navigator.storage?.estimate?.(); if (e) est = `端末保存 ${fmtBytes(e.usage)} 使用`; } catch { /* ignore */ }
    let persisted = '';
    try { persisted = (await navigator.storage?.persisted?.()) ? '（永続保存：有効）' : '（永続保存：未許可）'; } catch { /* ignore */ }
    const rows = [];
    for (const p of packs) {
      const v = await window.FBPack.verify(p.packId);
      rows.push(`<li><span>${p.packId === cur?.packId ? '▶ ' : ''}${esc(fmtJst(p.generatedAt))} <span class="hint">${esc(p.packId)} ・ ${v.have}/${v.total}ファイル ・ ${fmtBytes(p.totalBytes)}</span></span><button class="btn" data-id="${esc(p.packId)}">表示</button></li>`);
    }
    box.innerHTML = `${cur ? `<div>表示中：<strong>${esc(fmtJst(cur.generatedAt))}</strong>（${esc(ageText(cur.generatedAt))}）</div><div class="hint">packId ${esc(cur.packId)} ・ 空港 ${esc(cur.airports.join(', '))}</div>` : '<div>パック未保存</div>'}
      <div class="hint">${esc(est)} ${esc(persisted)} ${state.remoteError ? `／ 最新確認エラー：${esc(state.remoteError)}` : ''}</div>
      <h3>保存済みパック（最新＋1つ前）</h3><ul class="airport-list">${rows.join('') || '<li class="hint">なし</li>'}</ul>`;
    box.querySelectorAll('button[data-id]').forEach((b) => { b.onclick = () => showPack(b.dataset.id); });
  }

  // ---------------------------------------------------------------- pack flow
  function renderAll() {
    renderStatus(); renderBrief(); renderWx(); renderCharts(); renderNotam(); renderAirport(); renderDuty();
    setupAirportPicker.renderSel && setupAirportPicker.renderSel();
    renderPackInfo();
  }
  async function showPack(packId) {
    const p = await window.FBPack.load(packId);
    if (!p) return false;
    state.pack = p;
    const packs = window.FBPack.list();
    state.packSource = packs[0]?.packId === packId ? (state.packSource === 'latest' ? 'latest' : 'cached') : 'previous';
    renderAll();
    return true;
  }
  let refreshing = false;
  async function refresh(force = false) {
    if (refreshing) return; refreshing = true;
    $('refresh-btn').classList.add('spinning');
    try {
      const m = await window.FBPack.checkRemote();
      state.remoteError = null;
      const have = window.FBPack.list().find((p) => p.packId === m.packId);
      const v = have ? await window.FBPack.verify(m.packId) : null;
      if (!have || !v.ok || force) {
        state.downloading = `0/${m.files.length}`; renderStatus();
        await window.FBPack.download(m, (d, t) => { state.downloading = `${d}/${t}`; renderStatus(); });
      }
      state.downloading = null;
      state.packSource = 'latest';
      await showPack(m.packId);
      state.packSource = 'latest';
      renderStatus();
    } catch (e) {
      state.downloading = null;
      state.remoteError = navigator.onLine ? (e.name === 'AbortError' ? 'タイムアウト' : e.message) : 'オフライン';
      if (state.packSource === 'latest') state.packSource = 'cached';
      renderStatus(); renderPackInfo();
    } finally {
      refreshing = false; $('refresh-btn').classList.remove('spinning');
    }
  }

  async function start() {
    $('app-version').textContent = `App v${APP_VERSION}`;
    setupTabs(); setupTas(); setupDuty(); setupAirportPicker();
    window.FBViewer.setup();
    $('airport-date').value = state.duty.date || todayJst();
    $('airport-date').onchange = renderAirport;
    document.querySelectorAll('#notam-period .chip').forEach((b) => { b.onclick = () => { state.notamHours = Number(b.dataset.hours); lsSet(LS.notamH, state.notamHours); renderNotam(); }; });
    $('refresh-btn').onclick = () => refresh(false);
    $('pack-redownload').onclick = () => refresh(true);
    $('pack-clear').onclick = async () => { if (!confirm('保存済みパックを消去しますか？（オフラインで見られなくなります）')) return; await window.FBPack.clearAll(); state.pack = null; renderAll(); };
    window.addEventListener('online', () => { renderStatus(); refresh(false); });
    window.addEventListener('offline', renderStatus);
    renderClock(); setInterval(() => { renderClock(); renderStatus(); }, 15000);

    if ('serviceWorker' in navigator) {
      try { await navigator.serviceWorker.register('sw.js'); } catch (e) { console.warn('SW登録失敗', e); }
    }
    try { await navigator.storage?.persist?.(); } catch { /* ignore */ }

    const packs = window.FBPack.list();
    if (packs.length) { state.packSource = 'cached'; await showPack(packs[0].packId); } else renderAll();
    refresh(false);
    document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible' && navigator.onLine) refresh(false); });
  }
  document.addEventListener('DOMContentLoaded', start);
  window.FBApp = { state, refresh };
})();
