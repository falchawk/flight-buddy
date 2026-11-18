// Flight Buddy main
(function () {
  const APP_VERSION = '1.2.2';
  const SYNC_REPO = 'falchawk/flight-buddy';
  const $ = (id) => document.getElementById(id);
  const esc = window.FBWx.esc;
  const LS = { airports: 'fb.airports', duty: 'fb.duty', tab: 'fb.tab', notamH: 'fb.notamHours', viewPack: 'fb.viewPack', chartSel: 'fb.chartSel', theme: 'fb.theme' };
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
  const apName = (icao) => { const a = airportInfo(icao); const p = state.pack?.airports?.airports?.[icao]; return a ? a.name : (state.pack?.manifest?.airportNames?.[icao] || p?.name || icao); };
  const apCodes = (icao) => { const a = airportInfo(icao); return a ? `${a.icao} / ${a.iata}` : icao; };
  function mainAirports() {
    if (state.airports && state.airports.length) return state.airports;
    return state.pack?.manifest?.defaultAirports || ['RJTT', 'RJFF'];
  }
  const packHas = (icao) => !state.pack || (state.pack.manifest.airports || []).includes(icao);
  const missingAirports = () => mainAirports().filter((i) => !packHas(i));
  function syncUrl() {
    const list = mainAirports();
    const body = `AIRPORTS: ${list.join(',')}\n\nFlight Buddy の SETTINGS から送信（このまま Submit してください）。ボットが次回の自動更新でこの空港をパックに追加します。\n未収録: ${missingAirports().join(',') || 'なし'}`;
    return `https://github.com/${SYNC_REPO}/issues/new?labels=airports-sync&title=${encodeURIComponent('airports-sync: ' + list.join(','))}&body=${encodeURIComponent(body)}`;
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
    const wx = state.pack?.wx;
    const rows = mainAirports().map((icao) => {
      const e = wx?.airports?.[icao];
      if (!e || !e.ok) return `<tr><td>${esc(icao)}</td><td colspan="3" class="hint">${e ? '未取得' : 'パック未収録'}</td></tr>`;
      const mt = e.metar?.[0];
      const cat = mt ? (mt.fltCat || window.FBWx.flightCategory(mt.raw)) : null;
      const wind = (mt?.raw || '').match(/\b(\d{3}|VRB)(\d{2,3})(G\d{2,3})?KT\b/);
      const gusts = [...((e.taf?.raw || '').matchAll(/\b(?:\d{3}|VRB)\d{2,3}G(\d{2,3})KT\b/g))].map((m) => Number(m[1]));
      return `<tr><td><strong>${esc(icao)}</strong> <span class="hint">${esc(apName(icao))}</span></td><td>${cat ? `<span class="badge ${cat}">${cat}</span>` : ''}</td><td>${esc(wind ? wind[0] : '--')}</td><td>${gusts.length ? `<span class="hl-warn">G${Math.max(...gusts)}</span>` : '--'}</td></tr>`;
    }).join('');
    const summary = `<div class="card"><div class="card-title"><span>選択空港サマリー</span><span class="hint">METAR / TAF最大ガスト</span></div><table class="sum-table"><tbody>${rows}</tbody></table></div>`;
    const carried = b?.ok && b.carriedOver ? `<p class="hint"><span class="badge stale">前回のブリーフ</span> 本文は ${esc(fmtJst(b.writtenAt))} 作成（${esc(ageText(b.writtenAt))}）。METAR/TAF・図は最新パックの内容です。</p>` : '';
    $('brief-body').innerHTML = summary + carried + `<div class="brief-text">${b?.ok && b.text ? mdToHtml(b.text) : '<p class="hint">このパックにはボットのブリーフ本文がありません（未作成）。</p>'}</div>`;
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
      if (!e) body = `<p class="hint"><span class="badge na">パック未収録</span> SETTINGS の「Botに同期」で取得対象に追加できます（オンライン時）。</p>`;
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

  // ---------------------------------------------------------------- CHARTS（旧 Flight Buddy の8分類）
  const chartSel = lsGet(LS.chartSel, { cat: null, item: {}, variant: {}, group: {} });
  const frameIdx = {}; // `${cat}/${item}/${variant}` -> index（パック切替でリセット）
  let chartsPackId = null;
  const saveSel = () => lsSet(LS.chartSel, chartSel);
  function chip(label, active, onclick, extra = '') {
    const b = document.createElement('button'); b.className = `chip${active ? ' active' : ''}${extra}`; b.textContent = label; b.onclick = onclick; return b;
  }
  function frameAge(fr) {
    if (!fr.time) return '';
    const t = new Date(fr.time).getTime();
    if (t > Date.now()) return '';
    return ageText(fr.time);
  }
  function legacyCategory(extra) {
    return { id: 'extra', label: 'その他', defaultItem: 0, items: extra.map((c, i) => ({ id: `x${i}`, label: c.title || c.id,
      product: { type: 'series', title: c.title, source: c.source, variants: [{ id: 'main', label: c.title, defaultFrame: 0,
        frames: [{ label: [c.kind, c.level, c.validTime ? fmtUtc(c.validTime) : ''].filter(Boolean).join(' ・ '), images: [{ file: c.file }] }] }] } })) };
  }
  function chartCats() {
    const ch = state.pack?.charts;
    if (!ch) return [];
    const cats = (ch.categories || []).slice();
    if (ch.extra?.length) cats.push(legacyCategory(ch.extra));
    return cats;
  }
  function renderCharts() {
    const ch = state.pack?.charts;
    const meta = $('charts-meta'), catsNav = $('chart-cats'), itemsNav = $('chart-items'), vbox = $('chart-variants'), body = $('chart-body');
    catsNav.innerHTML = ''; itemsNav.innerHTML = ''; vbox.innerHTML = ''; body.innerHTML = '';
    if (state.pack?.manifest?.packId !== chartsPackId) { for (const k of Object.keys(frameIdx)) delete frameIdx[k]; chartsPackId = state.pack?.manifest?.packId; }
    if (!ch) { meta.textContent = 'パックがありません。'; return; }
    const cats = chartCats();
    if (!cats.length) { meta.innerHTML = '<span class="hint">このパックには図がありません（旧形式のパック）。更新をお待ちください。</span>'; return; }
    const errs = ch.errors || [];
    meta.innerHTML = `取得 ${esc(fmtJst(ch.fetchedAt))}（${esc(ageText(ch.fetchedAt))}）・ 端末に保存済み（Windy 以外はオフライン表示可）${errs.length ? ` <details class="chart-errors"><summary>今回取得できなかった図 ${errs.length}件</summary><div class="hint">${errs.map(esc).join('<br>')}</div></details>` : ''}`;
    let cat = cats.find((c) => c.id === chartSel.cat) || cats[0];
    cats.forEach((c) => catsNav.appendChild(chip(c.label, c === cat, () => { chartSel.cat = c.id; saveSel(); renderCharts(); })));
    const items = cat.items || [];
    let item = items.find((it) => it.id === chartSel.item[cat.id]) || items[cat.defaultItem || 0] || items[0];
    if (items.length > 1) items.forEach((it) => itemsNav.appendChild(chip(it.label, it === item, () => { chartSel.item[cat.id] = it.id; saveSel(); renderCharts(); })));
    if (!item) return;
    renderProduct(cat, item, vbox, body);
  }
  function renderProduct(cat, item, vbox, body) {
    const p = item.product || {};
    const key = `${cat.id}/${item.id}`;
    const panel = document.createElement('div'); panel.className = 'chart-panel';
    const head = (extra = '') => `<div class="chart-head"><span class="t">${esc(p.title || item.label)}</span><span class="hint">${p.source ? `© ${esc(p.source)}` : ''}${extra}</span></div>`;
    if (p.type === 'online') {
      const online = navigator.onLine;
      panel.innerHTML = head() + (online
        ? `<iframe class="windy-frame" src="${esc(p.embedUrl)}" loading="lazy" referrerpolicy="no-referrer" title="Windy"></iframe>`
        : '<div class="offline-box">オフラインでは表示不可<div class="hint" style="font-weight:400;margin-top:6px">Windy はオンライン専用です（端末には保存しません）。</div></div>')
        + `<div class="chart-note hint">${esc(p.note || '')} ${p.officialUrl ? `<a class="btn" href="${esc(p.officialUrl)}" target="_blank" rel="noopener">Windy で開く ↗</a>` : ''}</div>`;
      body.appendChild(panel); return;
    }
    if (p.type === 'wxtext') { renderWxText(panel, head); body.appendChild(panel); return; }
    let variants = (p.variants || []).slice();
    if (item.id === 'apseries') {
      const sel = mainAirports();
      const mine = sel.map((i) => variants.find((v) => v.id === i)).filter(Boolean);
      const missing = sel.filter((i) => !variants.some((v) => v.id === i));
      variants = mine;
      if (!mine.length) { panel.innerHTML = head() + `<div class="chart-stage"><p class="hint">選択空港（${esc(sel.join(', '))}）の飛行場時系列予報はこのパックにありません。</p></div>`; body.appendChild(panel); return; }
      if (missing.length) vbox.insertAdjacentHTML('beforeend', `<div class="hint">時系列予報なし：${esc(missing.join(', '))}</div>`);
    }
    if (!variants.length) { panel.innerHTML = head() + '<div class="chart-stage"><p class="hint">今回は取得できませんでした（前回分もありません）。</p></div>'; body.appendChild(panel); return; }
    // グループ（例：断面図（航空路）/ 断面図（経度）/ 平面図）
    const groups = [...new Set(variants.map((v) => v.group).filter(Boolean))];
    let v = variants.find((x) => x.id === chartSel.variant[key]) || variants.find((x) => x.id === p.defaultVariant) || variants[0];
    if (groups.length > 1) {
      const gwrap = document.createElement('div'); gwrap.className = 'vchips';
      groups.forEach((g) => gwrap.appendChild(chip(g, g === v.group, () => {
        chartSel.group[key] = g;
        const remembered = variants.find((x) => x.group === g && x.id === (chartSel.group[`${key}:${g}`]));
        const def = variants.find((x) => x.group === g && x.id === (p.groupDefaults?.[g] || p.defaultVariant));
        chartSel.variant[key] = (remembered || def || variants.find((x) => x.group === g)).id; saveSel(); renderCharts();
      })));
      vbox.appendChild(gwrap);
    }
    const inGroup = variants.filter((x) => !groups.length || x.group === v.group);
    const pick = (id) => { chartSel.variant[key] = id; if (v.group) chartSel.group[`${key}:${v.group}`] = id; saveSel(); renderCharts(); };
    if (inGroup.length > 10) {
      const s = document.createElement('select');
      s.innerHTML = inGroup.map((x) => `<option value="${esc(x.id)}"${x === v ? ' selected' : ''}>${esc(x.label)}${x.carriedOver ? '（前回分）' : ''}</option>`).join('');
      s.onchange = () => pick(s.value); vbox.appendChild(s);
    } else if (inGroup.length > 1) {
      const w = document.createElement('div'); w.className = 'vchips';
      inGroup.forEach((x) => w.appendChild(chip(x.label, x === v, () => pick(x.id), x.carriedOver ? ' stale' : '')));
      vbox.appendChild(w);
    }
    const frames = v.frames || [];
    const fkey = `${key}/${v.id}`;
    if (frameIdx[fkey] == null || frameIdx[fkey] >= frames.length) frameIdx[fkey] = Math.min(v.defaultFrame ?? frames.length - 1, frames.length - 1);
    const carried = p.carriedOver || v.carriedOver;
    panel.innerHTML = head(carried ? ' <span class="badge carried">前回分</span>' : '')
      + '<div class="chart-stage"><p class="hint">読み込み中…</p></div>'
      + (frames.length > 1 ? `<div class="frame-bar"><button class="btn f-prev">◀</button><span class="lbl"></span><button class="btn f-next">▶</button></div><input class="frame-slider" type="range" min="0" max="${frames.length - 1}" step="1" />` : '<div class="frame-bar"><span class="lbl"></span></div>')
      + (p.note ? `<div class="chart-note hint">${esc(p.note)}</div>` : '');
    body.appendChild(panel);
    const stage = panel.querySelector('.chart-stage'), lbl = panel.querySelector('.lbl'), slider = panel.querySelector('.frame-slider');
    let tok = 0;
    const show = async (i) => {
      i = Math.max(0, Math.min(frames.length - 1, i)); frameIdx[fkey] = i;
      const fr = frames[i];
      const age = frameAge(fr);
      lbl.textContent = `${frames.length > 1 ? `${i + 1}/${frames.length} ・ ` : ''}${fr.label || ''}${age ? `（${age}）` : ''}`;
      if (slider) slider.value = String(i);
      const my = ++tok;
      const node = await window.FBViewer.compose(fr, state.pack.imageUrl, 'inline');
      if (my !== tok) return;
      stage.innerHTML = ''; stage.appendChild(node);
      stage.insertAdjacentHTML('beforeend', '<span class="zoom-hint">タップで拡大</span>');
      // 前後のコマを先読み
      for (const j of [i + 1, i - 1]) if (frames[j]) frames[j].images.forEach((im) => state.pack.imageUrl(im.file));
    };
    if (frames.length > 1) {
      panel.querySelector('.f-prev').onclick = () => show(frameIdx[fkey] - 1);
      panel.querySelector('.f-next').onclick = () => show(frameIdx[fkey] + 1);
      slider.oninput = () => show(Number(slider.value));
    }
    stage.onclick = () => window.FBViewer.open(frames, frameIdx[fkey], state.pack.imageUrl, `${p.title || item.label}${variants.length > 1 ? ' ・ ' + v.label : ''}`, (i) => { frameIdx[fkey] = i; show(i); });
    show(frameIdx[fkey]);
  }
  function renderWxText(panel, head) {
    const wx = state.pack?.wx, atis = state.pack?.atis;
    const rows = mainAirports().map((icao) => {
      const e = wx?.airports?.[icao];
      const mt = e?.metar?.[0];
      const a = atis?.airports?.[icao];
      return `<div class="card" style="margin:8px"><div class="card-title"><span>${esc(apName(icao))} <span class="hint">${esc(apCodes(icao))}</span></span></div>
        <div class="sub-label">METAR</div>${mt ? `<div class="raw">${window.FBWx.highlight(mt.raw)}</div>` : naBox(e ? 'METAR 未取得' : 'パック未収録')}
        <div class="sub-label">TAF</div>${e?.taf ? `<div class="raw">${window.FBWx.tafLines(e.taf.raw)}</div>` : naBox('TAF 未取得')}
        <div class="sub-label">ATIS ${a && atis.fetchedAt ? `<span class="hint">${esc(fmtJst(atis.fetchedAt))}取得</span>` : ''}</div>${a ? `<pre class="raw">${esc(a.text)}</pre>` : naBox(atis?.ok ? 'ATIS なし（この空港は SWIM ATIS 対象外か応答なし）' : (atis?.note || 'ATIS 未取得'))}</div>`;
    }).join('');
    panel.innerHTML = head() + rows;
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
      else if (n.airports[icao].status) body = `<p class="hint">${esc(n.airports[icao].status)}</p>`;
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
      const sw = p.swim || null; const swOk = !!(sw && sw.ok);
      const base = airportInfo(icao);
      const lat = p.lat ?? base?.lat, lon = p.lon ?? base?.lon;
      const sun = lat != null ? window.FBSun.sunTimesJst(lat, lon, date) : null;
      const field = (k, v) => `<div class="field"><span class="k">${esc(k)}</span><span>${v == null || v === '' ? naBox() : v}</span></div>`;
      const rwy = p.runways?.length ? p.runways.map((r) => `${esc(r.id)} <span class="hint">${esc(r.dimensionFt || '')}ft${r.alignment != null ? ` / 真方位${esc(r.alignment)}°` : ''}</span>`).join('<br>') : null;
      const freqs = p.freqs?.length ? p.freqs.map((f) => `${esc(f.type)} ${esc(f.mhz)}`).join(' ／ ') : null;
      const card = document.createElement('div'); card.className = 'card';
      card.innerHTML = `<div class="card-title"><span>${esc(apName(icao))} <span class="hint">${esc(apCodes(icao))}</span></span>${state.pack?.airports?.airports?.[icao] ? '' : '<span class="badge na">パック未収録</span>'}</div>
        ${sw ? `<div class="hint" style="margin-bottom:4px">SWIM 空港情報 ${esc(fmtJst(sw.fetchedAt))}取得（${esc(ageText(sw.fetchedAt))}）${sw.ok ? '' : ' ・ 取得失敗'}</div>` : ''}
        ${swOk ? field('空港運用状況', sw.operationalStatus.length ? sw.operationalStatus.map(esc).join('<br>') : '通常') : ''}
        ${swOk ? field('使用滑走路', sw.runwaysInUse.length ? sw.runwaysInUse.map(esc).join(' ／ ') : null) : ''}
        ${field('運用時間', swOk && sw.operatingHours ? `${esc(sw.operatingHours)} <span class="hint">(SWIM)</span>` : (p.operatingHours ? esc(p.operatingHours) : null))}
        ${field('滑走路', rwy)}
        ${field('進入方式', swOk && sw.approach.length ? sw.approach.map(esc).join(' ／ ') : (p.approaches ? esc(p.approaches) : null))}
        ${swOk ? field('平均遅延', (sw.departureDelayMin != null || sw.arrivalDelayMin != null) ? `出発 ${esc(sw.departureDelayMin ?? '--')}分 ／ 到着 ${esc(sw.arrivalDelayMin ?? '--')}分` : null) : ''}
        ${swOk ? field('飛行場警報', sw.aerodromeWarning.length ? `<span class="hl-warn">${sw.aerodromeWarning.map(esc).join('<br>')}</span>` : '発表なし') : ''}
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
      const miss = missingAirports();
      $('ap-sync').innerHTML = state.pack ? (miss.length
        ? `<p class="hint"><span class="badge na">パック未収録</span> ${esc(miss.join(', '))}</p><a class="btn btn-primary" href="${syncUrl()}" target="_blank" rel="noopener">Botに同期（GitHub issue を開く）</a><p class="hint">開いたページで Submit すると、次回の自動更新（15分ごと）でパックに追加されます。オンライン時のみ。</p>`
        : `<p class="hint">選択中の空港はすべてパックに収録済みです（パック収録 ${state.pack.manifest.airports.length} 空港）。</p>`) : '';
      mainAirports().forEach((icao, i) => {
        const li = document.createElement('li');
        li.innerHTML = `<span>${esc(apName(icao))} <span class="codes">${esc(apCodes(icao))}</span>${packHas(icao) ? '' : ' <span class="badge na">パック未収録</span>'}</span><span><button class="btn" data-a="up">↑</button> <button class="btn btn-danger" data-a="rm">削除</button></span>`;
        li.querySelector('[data-a=rm]').onclick = () => { const l = mainAirports().slice(); l.splice(i, 1); state.airports = l; lsSet(LS.airports, l); renderAll(); };
        li.querySelector('[data-a=up]').onclick = () => { if (!i) return; const l = mainAirports().slice(); [l[i - 1], l[i]] = [l[i], l[i - 1]]; state.airports = l; lsSet(LS.airports, l); renderAll(); };
        ul.appendChild(li);
      });
    };
    const renderRes = () => {
      const q = search.value.trim().toUpperCase(), qj = search.value.trim();
      const ul = $('ap-results'); ul.innerHTML = '';
      if (!q) return;
      const base = (window.FB_AIRPORTS || []).slice();
      const names = state.pack?.manifest?.airportNames || {};
      Object.keys(names).forEach((icao) => { if (!base.some((x) => x.icao === icao)) base.push({ icao, iata: state.pack?.airports?.airports?.[icao]?.iata || '', name: names[icao] || icao }); });
      let res = base.filter((a) => a.icao.includes(q) || (a.iata || '').includes(q) || a.name.includes(qj) || a.name.toUpperCase().includes(q)).slice(0, 12);
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
        state.downloading = '準備中'; renderStatus();
        await window.FBPack.download(m, (d, t, db, tb) => { state.downloading = `${d}/${t}（${fmtBytes(db)} / ${fmtBytes(tb)}）`; renderStatus(); });
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

  // ---------------------------------------------------------------- THEME（auto / light / dark）
  const darkMq = window.matchMedia ? window.matchMedia('(prefers-color-scheme: dark)') : null;
  function applyTheme() {
    const t = lsGet(LS.theme, 'auto');
    const root = document.documentElement;
    if (t === 'light' || t === 'dark') root.setAttribute('data-theme', t); else root.removeAttribute('data-theme');
    const eff = t === 'auto' ? (darkMq && !darkMq.matches ? 'light' : 'dark') : t;
    const meta = document.querySelector('meta[name="theme-color"]');
    if (meta) meta.setAttribute('content', getComputedStyle(root).getPropertyValue('--bg-panel').trim() || (eff === 'light' ? '#ffffff' : '#10151d'));
    document.querySelectorAll('#theme-chips .chip').forEach((b) => b.classList.toggle('active', b.dataset.themeOpt === t));
    const note = $('theme-note');
    if (note) note.textContent = t === 'auto' ? `端末の設定に合わせます（現在：${eff === 'light' ? 'ライト' : 'ダーク'}）。この端末に保存されます。` : 'この端末に保存されます（オフラインでも有効）。';
  }
  function setupTheme() {
    document.querySelectorAll('#theme-chips .chip').forEach((b) => { b.onclick = () => { lsSet(LS.theme, b.dataset.themeOpt); applyTheme(); }; });
    if (darkMq) (darkMq.addEventListener ? darkMq.addEventListener('change', applyTheme) : darkMq.addListener(applyTheme));
    applyTheme();
  }

  async function start() {
    $('app-version').textContent = `App v${APP_VERSION}`;
    setupTheme(); setupTabs(); setupTas(); setupDuty(); setupAirportPicker();
    window.FBViewer.setup();
    $('airport-date').value = state.duty.date || todayJst();
    $('airport-date').onchange = renderAirport;
    document.querySelectorAll('#notam-period .chip').forEach((b) => { b.onclick = () => { state.notamHours = Number(b.dataset.hours); lsSet(LS.notamH, state.notamHours); renderNotam(); }; });
    $('refresh-btn').onclick = () => refresh(false);
    $('pack-redownload').onclick = () => refresh(true);
    $('pack-clear').onclick = async () => { if (!confirm('保存済みパックを消去しますか？（オフラインで見られなくなります）')) return; await window.FBPack.clearAll(); state.pack = null; renderAll(); };
    window.addEventListener('online', () => { renderStatus(); renderCharts(); refresh(false); });
    window.addEventListener('offline', () => { renderStatus(); renderCharts(); });
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
