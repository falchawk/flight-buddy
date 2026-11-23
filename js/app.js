// Flight Buddy main
(function () {
  const APP_VERSION = '1.9.39';
  const $ = (id) => document.getElementById(id);
  const esc = window.FBWx.esc;
  const LS = { areaHide: 'fb.areaHide', notamMode: 'fb.notamMode', airports: 'fb.airports', duty: 'fb.duty', tab: 'fb.tab', notamH: 'fb.notamHours', viewPack: 'fb.viewPack', chartSel: 'fb.chartSel', theme: 'fb.theme' };
  const lsGet = (k, d) => { try { const v = localStorage.getItem(k); return v == null ? d : JSON.parse(v); } catch { return d; } };
  const lsSet = (k, v) => localStorage.setItem(k, JSON.stringify(v));
  const AIRLINES = ['SFJ', 'ANA', 'JAL', 'SNJ', 'ADO', 'SKY', 'APJ', 'JJP', 'FDA', 'IBX', 'JTA', 'RAC', 'ORC', 'AMX', 'TOK', 'AJX', 'TZP', 'SJO', 'NCA'];

  // 新しい端末で最初に選ばれている空港（端末だけの初期値。ボットは全空港を取得し、端末は選んだ空港の分だけダウンロード）。
  // 保存が無ければこの初期値、1空港以下に減っていてユーザーが一度も編集していなければ初期値に戻す（旧版の自己修復と同じ）。
  const DEFAULT_MAIN_AIRPORTS = ['RJTT', 'RJBB', 'RJGG', 'RJSS', 'RJFF', 'RJDC', 'RJFR'];
  function resolveInitialAirports() {
    const saved = lsGet('fb.airports', null);
    if (saved === null) return DEFAULT_MAIN_AIRPORTS.slice();
    const list = saved.map((i) => (i === 'YPAS' ? 'YBAS' : i)); // YPAS→YBAS 訂正（2026-11-18）
    if (Array.isArray(list) && list.length <= 1 && !lsGet('fb.airportsUserModified', false)) {
      lsSet('fb.airports', DEFAULT_MAIN_AIRPORTS);
      return DEFAULT_MAIN_AIRPORTS.slice();
    }
    return list;
  }
  // 選択を変えたら、増えた空港の分だけ（オンライン時）すぐダウンロードする
  const setAirports = (l) => { state.airports = l; lsSet(LS.airports, l); lsSet('fb.airportsUserModified', true); setTimeout(() => window.FBApp?.ensureAirports(), 0); };
  const state = {
    pack: null, // {manifest, wx, notam, airports, brief, charts, imageUrl}
    packSource: '', // 'latest' | 'cached' | 'previous'
    remoteError: null,
    downloading: null,
    airports: resolveInitialAirports(),
    duty: lsGet(LS.duty, { date: todayJst(), buffer: 2, airline: 'SFJ', flights: [], note: '', source: null, manualOn: null }),
    notamHours: lsGet(LS.notamH, 24),
    notamMode: lsGet(LS.notamMode, 'ap'),
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
  // 全空港の一覧（index.json：名称・位置・国・飛行状態だけ）。旧形式のパックは airports.json から
  const apIdx = (icao) => state.pack?.index?.airports?.[icao] || state.pack?.airports?.airports?.[icao] || null;
  const apName = (icao) => { const a = airportInfo(icao); const p = apIdx(icao); return a ? a.name : (state.pack?.manifest?.airportNames?.[icao] || p?.name || icao); };
  const apCodes = (icao) => { const a = airportInfo(icao); const p = apIdx(icao); const iata = a?.iata || p?.iata; return iata ? `${icao} / ${iata}` : icao; };
  const apProf = (icao) => state.pack?.airports?.airports?.[icao] || apIdx(icao) || null;
  const COUNTRY_JA = { Japan: '日本', Taiwan: '台湾', 'South Korea': '韓国', Korea: '韓国', China: '中国', 'Hong Kong': '香港', Macau: 'マカオ', Philippines: 'フィリピン', Thailand: 'タイ', Vietnam: 'ベトナム', Singapore: 'シンガポール', Malaysia: 'マレーシア', Indonesia: 'インドネシア', India: 'インド', Australia: 'オーストラリア', 'United States': 'アメリカ', USA: 'アメリカ', Guam: 'グアム', 'Northern Mariana Islands': '北マリアナ諸島', France: 'フランス', Germany: 'ドイツ', Spain: 'スペイン', Sweden: 'スウェーデン', Austria: 'オーストリア', Greece: 'ギリシャ', Bulgaria: 'ブルガリア', 'United Arab Emirates': 'アラブ首長国連邦', Canada: 'カナダ', 'United Kingdom': 'イギリス', Russia: 'ロシア', Mongolia: 'モンゴル', Cambodia: 'カンボジア', Myanmar: 'ミャンマー', 'New Zealand': 'ニュージーランド', Ireland: 'アイルランド', Netherlands: 'オランダ', Italy: 'イタリア', Azerbaijan: 'アゼルバイジャン', Brazil: 'ブラジル', 'Cabo Verde': 'カーボベルデ', Cyprus: 'キプロス', 'Guam (US)': 'グアム（米）', Kazakhstan: 'カザフスタン', 'Northern Mariana Islands (US)': '北マリアナ諸島（米）', Palau: 'パラオ', Portugal: 'ポルトガル', Pakistan: 'パキスタン', Switzerland: 'スイス', 'New Caledonia': 'ニューカレドニア', Belgium: 'ベルギー', Finland: 'フィンランド', Oman: 'オマーン', Fiji: 'フィジー', Bahrain: 'バーレーン', Denmark: 'デンマーク', Iceland: 'アイスランド', Turkey: 'トルコ', Croatia: 'クロアチア', Iran: 'イラン', Egypt: 'エジプト', 'Saudi Arabia': 'サウジアラビア', Qatar: 'カタール', Venezuela: 'ベネズエラ', Latvia: 'ラトビア', Kuwait: 'クウェート', Mexico: 'メキシコ', Lebanon: 'レバノン', 'United States Minor Outlying Islands': 'アメリカ領小離島' };
  const countryJa = (c) => COUNTRY_JA[c] || c || '不明';
  // 画面に出す順は旧版と同じ北→南（緯度が高い方が先、同じなら経度が大きい＝東が先）。手動の並べ替えはしない
  const apPos = (icao) => { const a = airportInfo(icao), p = apIdx(icao); return { lat: a?.lat ?? p?.lat ?? -999, lon: a?.lon ?? p?.lon ?? -999 }; };
  function mainAirports() {
    const l = (state.airports && state.airports.length) ? state.airports : DEFAULT_MAIN_AIRPORTS;
    return [...l].sort((x, y) => { const a = apPos(x), b = apPos(y); return (b.lat - a.lat) || (b.lon - a.lon) || x.localeCompare(y); });
  }
  const packHas = (icao) => !state.pack || (state.pack.manifest.airports || []).includes(icao);
  const loaded = (icao) => !!state.pack?.loadedAirports?.has(icao);
  // 選んだ空港の中身が無い理由（パックに無い／まだこの端末にダウンロードしていない）
  const missText = (icao) => (!packHas(icao) ? 'このパックに未収録の空港です' : (navigator.onLine ? 'この空港のデータをダウンロード中…' : 'この端末にまだダウンロードしていません（オンラインになると自動で取得）'));
  // DUTY の便の出発・到着空港（DUTY の TAF 表示用に、選んだ空港と一緒にダウンロードする）
  function dutyAirports() {
    const d = state.pack?.flights; if (!d?.rows || !window.FBFlights) return [];
    const out = new Set();
    for (const f of state.duty.flights || []) {
      try {
        const r = window.FBFlights.search(d, f, { exact: true, date: state.duty.date || todayJst() }).results.filter((x) => window.FBFlights.operatesOn(x, state.duty.date || todayJst()));
        r.slice(0, 2).forEach((x) => { out.add(x[1]); out.add(x[2]); });
      } catch { /* ignore */ }
    }
    return [...out].filter((i) => /^[A-Z]{4}$/.test(i));
  }
  // この端末がダウンロードする空港＝SETTINGS で選んだ空港＋DUTY の区間の空港
  const wantedAirports = () => [...new Set([...mainAirports(), ...dutyAirports()])];
  const naBox = (text) => `<span class="na-text">${esc(text || '未取得')}</span>`;

  // ---------------------------------------------------------------- header / status
  function renderClock() {
    const now = new Date();
    const zs = now.toISOString();
    const js = new Date(now.getTime() + 9 * 3600000).toISOString();
    const md = (s) => `${s.slice(5, 7)}/${s.slice(8, 10)}`;
    const hm = (s) => s.slice(11, 19);
    const set = (id, v) => { const el = $(id); if (el) el.textContent = v; };
    set('ck-j-date', md(js)); set('ck-j-time', hm(js));
    set('ck-z-date', md(zs)); set('ck-z-time', hm(zs));
    const el = $('clock');
    if (el) el.setAttribute('aria-label', `JST ${md(js)} ${hm(js)} / Z ${md(zs)} ${hm(zs)}`);
  }
  function startClock() {
    renderClock();
    if (startClock.t) clearTimeout(startClock.t);
    if (startClock.i) clearInterval(startClock.i);
    const toNext = 1000 - (Date.now() % 1000);
    startClock.t = setTimeout(() => {
      renderClock();
      startClock.i = setInterval(renderClock, 1000);
    }, toNext);
  }
  function setupBrandLightbox() {
    const btn = $('brand-emb-btn'), lb = $('brand-lightbox');
    if (!btn || !lb) return;
    const open = () => { lb.hidden = false; try { lb.focus(); } catch (e) { /* ignore */ } };
    const close = () => { if (lb.hidden) return; lb.hidden = true; try { btn.focus(); } catch (e) { /* ignore */ } };
    btn.addEventListener('click', open);
    lb.addEventListener('click', close);
    document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && !lb.hidden) { e.preventDefault(); close(); } });
  }

  function liveOn() { return !!(window.FBWxLive && window.FBWxLive.enabled()); }
  function wxOf(icao) {
    if (liveOn()) return window.FBWxLive.mergedWx(state.pack, icao);
    return state.pack?.wx?.airports?.[icao] || null;
  }
  function liveTag(isLive) { return liveOn() ? window.FBWxLive.tag(!!isLive) : ''; }

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
      const lp0 = $('wx-live-pill');
      if (lp0) {
        if (!liveOn()) lp0.hidden = true;
        else { const info = window.FBWxLive.pill(); lp0.hidden = !!info.hidden; lp0.textContent = info.text; lp0.className = info.cls; }
      }
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
    const lp = $('wx-live-pill');
    if (lp) {
      if (!liveOn()) { lp.hidden = true; }
      else {
        const info = window.FBWxLive.pill();
        lp.hidden = !!info.hidden;
        lp.textContent = info.text;
        lp.className = info.cls;
      }
    }
    if (ageH > 3) {
      banner.textContent = ageH > 12 ? `⚠ パックが ${ageText(m.generatedAt)} のものです。` : `パックは ${ageText(m.generatedAt)} に作成されました。`;
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
      if (tab === 'notam') setTimeout(() => { try { applyNotamMode(); } catch (e) { console.warn(e); } }, 0);
      if (tab === 'map') setTimeout(() => { try { renderMap(); } catch (e) { console.warn(e); } }, 0);
      if (tab === 'flights') setTimeout(() => { try { syncFlightsDate(); } catch (e) { console.warn(e); } }, 0);
    };
    btns.forEach((b) => b.addEventListener('click', () => go(b.dataset.tab)));
    let t0 = lsGet(LS.tab, 'map');
    if (t0 === 'charts') t0 = 'wx'; // 旧版（v1.2）のCHARTSタブは WX に統合
    if (t0 === 'brief') { t0 = 'wx'; chartSel.cat = 'brief'; saveSel(); } // BRIEF は WX の最初のサブタブに移動（保存済みのタブが BRIEF なら WX → BRIEF を開く）
    if (!document.getElementById(`tab-${t0}`)) t0 = 'map';
    go(t0);
    go.current = () => lsGet(LS.tab, 'map');
    setupTabs.go = go;
  }

  // ---------------------------------------------------------------- BRIEF
  function mdToHtml(md) {
    const lines = String(md || '').split(/\r?\n/);
    let html = '', inList = false;
    const inline = (s) => esc(s).replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>').replace(/`(.+?)`/g, '<code>$1</code>');
    const cells = (l) => { let t = l.trim(); if (t.startsWith('|')) t = t.slice(1); if (t.endsWith('|')) t = t.slice(0, -1); return t.replace(/\\\|/g, '\u0000').split('|').map((c) => c.replace(/\u0000/g, '|').trim()); };
    const isSep = (l) => /^\s*\|?\s*:?-{2,}:?\s*(\|\s*:?-{2,}:?\s*)*\|?\s*$/.test(l) && l.includes('-');
    const isRow = (l) => /^\s*\|.*\|\s*$/.test(l) || (l.includes('|') && l.trim().length > 2 && !/^\s*[-*・]\s/.test(l) && !/^#/.test(l));
    const closeList = () => { if (inList) { html += '</ul>'; inList = false; } };
    for (let i = 0; i < lines.length; i++) {
      const l = lines[i];
      // 表（Markdown）：ヘッダ行＋区切り行（|---|）＋本文行
      if (isRow(l) && i + 1 < lines.length && isSep(lines[i + 1]) && cells(l).length > 1) {
        closeList();
        const head = cells(l), al = cells(lines[i + 1]).map((c) => (/^:-+:$/.test(c) ? 'center' : /-:$/.test(c) ? 'right' : ''));
        const td = (t, c, k) => `<${t}${al[k] ? ` style="text-align:${al[k]}"` : ''}>${inline(c)}</${t}>`;
        let t = `<div class="md-table"><table><thead><tr>${head.map((c, k) => td('th', c, k)).join('')}</tr></thead><tbody>`;
        i += 2;
        for (; i < lines.length && lines[i].trim() && lines[i].includes('|'); i++) {
          const r = cells(lines[i]);
          t += `<tr>${head.map((_, k) => td('td', r[k] ?? '', k)).join('')}</tr>`;
        }
        i--;
        html += t + '</tbody></table></div>';
        continue;
      }
      // 画像：![説明](brief-img/NAME.png)
      const im = l.match(/^\s*!\[([^\]]*)\]\(\s*brief-img\/([A-Za-z0-9._-]+)\s*\)\s*$/);
      if (im) {
        closeList();
        html += `<figure class="brief-fig"><img data-bimg="${esc(im[2])}" alt="${esc(im[1])}" loading="lazy" /><span class="zoom-hint">タップで拡大</span>${im[1] ? `<figcaption>${inline(im[1])}</figcaption>` : ''}</figure>`;
        continue;
      }
      const h = l.match(/^(#{1,3})\s+(.*)$/), li = l.match(/^\s*[-*・]\s+(.*)$/);
      if (li) { if (!inList) { html += '<ul>'; inList = true; } html += `<li>${inline(li[1])}</li>`; continue; }
      closeList();
      if (h) html += `<h${h[1].length}>${inline(h[2])}</h${h[1].length}>`;
      else if (/^\s*-{3,}\s*$/.test(l)) html += '<hr>';
      else if (l.trim()) html += `<p>${inline(l)}</p>`;
    }
    closeList();
    return html;
  }
  // 本文中の画像（パックの blob。オフラインでも出る）。タップで全画面ビューア
  function hydrateBriefImages(root, b) {
    root.querySelectorAll('img[data-bimg]').forEach((img) => {
      const ent = b?.images?.[img.dataset.bimg];
      if (!ent?.file) { img.closest('figure').innerHTML = `<span class="hint">（画像がありません：${esc(img.dataset.bimg)}）</span>`; return; }
      state.pack.imageUrl(ent.file).then((u) => { img.src = u; });
      const alt = img.alt || 'BRIEF 図';
      img.closest('figure').onclick = () => window.FBViewer.open([{ label: alt, images: [{ file: ent.file }] }], 0, state.pack.imageUrl, alt, () => {});
    });
  }
  const briefKindLabel = (b) => b?.kind === 'auto' ? '自動' : b?.kind === 'manual' ? '手動' : '作成方法不明';
  function renderBrief() {
    const b = state.pack?.brief, m = state.pack?.manifest;
    if (!m) { $('brief-meta').textContent = ''; $('brief-body').innerHTML = '<p class="hint">まだパックがありません。オンラインで一度開くと自動で保存されます。</p>'; return; }
    $('brief-meta').innerHTML = b?.ok && b?.writtenAt ? `${esc(fmtJst(b.writtenAt))}（${esc(briefKindLabel(b))}）` : '';
    const carried = b?.ok && b.carriedOver ? `<p class="hint"><span class="badge stale">前回のブリーフ</span> 本文は ${esc(fmtJst(b.writtenAt))} 作成（${esc(ageText(b.writtenAt))}）。METAR/TAF・図は最新パックの内容です。</p>` : '';
    $('brief-body').innerHTML = carried + `<div class="brief-text">${b?.ok && b.text ? mdToHtml(b.text) : '<p class="hint">いまのブリーフ本文はまだありません。自動作成は、その日の初便の3時間前（便が無い日・午後便の日は 08:30）までに行います。</p>'}</div>`;
    hydrateBriefImages($('brief-body'), b);
  }

  // ---------------------------------------------------------------- WX
  // WX > AIRPORT > METAR TAF ATIS（旧版と同じ場所）。空港ごとに1つの箱に METAR・デコード・TAF・ATIS
  // 旧版と同じ「使わなかった出典の理由」（SWIM: … / AWC: …）
  function srcNotes(e, kind) {
    const sw = kind === 'metar' ? e.swimFailReason : e.swimTafFailReason;
    const src = kind === 'metar' ? e.metarSource : e.tafSource;
    const out = [];
    if (sw && src !== 'SWIM') out.push(`SWIM: ${sw}`);
    if (kind === 'metar' && e.ogimetFailReason && !src) out.push(`Ogimet: ${e.ogimetFailReason}`);
    if (!src && e.error) out.push(`AWC: ${e.error}`);
    return out.map((t) => `<div class="doc-note">${esc(t)}</div>`).join('');
  }
  function renderWxCards(list) {
    const wx = state.pack?.wx, atis = state.pack?.atis;
    if (wx) {
      let liveHint = '';
      if (liveOn() && window.FBWxLive.receivedAt) {
        const rec = window.FBWxLive.receivedAt;
        liveHint = ` ／ LIVE ${navigator.onLine ? '更新' : '受信'} ${esc(fmtJst(rec))}（${esc(ageText(rec))}）`;
      }
      list.insertAdjacentHTML('beforeend', `<p class="hint" style="margin:0 14px">取得 ${esc(fmtJst(wx.fetchedAt))} ／ 出所 ${esc(wx.source)}${liveHint}</p><div class="legend" style="margin:4px 14px">TAF：<span class="taf-token-becmg">BECMG</span> <span class="taf-token-tempo">TEMPO</span> <span class="taf-token-fm">FM</span> <span class="taf-token-prob">PROB30/40</span>（旧版と同じ色。ライトモードは見やすいよう同じ色相で濃いめ）。METAR の TEMPO/BECMG も同じ色。<span class="hl-ifr">赤</span>＝IFR/LIFR の要因（視程 5000m 未満・シーリング 1000ft 未満）。MVFR は強調しません。<br>飛行状態：IFR/VFR の境界は日本の航空法（施行規則第5条第4号）＝視程 5000m・雲高 300m(1000ft)。国土交通大臣が告示で指定した空港（管制圏内で 8km/450m。<b>告示空港: 8km/1500ft</b>）だけは 視程 8000m・雲高 1500ft(450m) が境界で、MVFR は 8000m〜5SM・1500〜3000ft（<b>現在、指定されている空港は 0 件</b>。AIP Japan ENR 1.2 で確認。指定されると各空港のカードに「告示空港: 8km/1500ft」と出ます）。日本に無い MVFR/LIFR は FAA 基準。VFR 視程 &gt;5SM かつ シーリング &gt;3000ft ／ MVFR 視程 5000m〜5SM または 1000〜3000ft ／ IFR 視程 &lt;5000m または &lt;1000ft ／ LIFR 視程 &lt;1SM または &lt;500ft。</div>`); }
    for (const icao of mainAirports()) {
      const e = wxOf(icao);
      const card = document.createElement('div'); card.className = 'card';
      let body;
      if (!e) body = `<p class="hint"><span class="badge na">${packHas(icao) ? '未ダウンロード' : 'パック未収録'}</span> ${esc(missText(icao))}</p>`;
      else if (!e.ok) body = `<div class="sub-label">METAR</div>${naBox('METAR なし（aviationweather.gov にこの局の配信がありません）')}<div class="sub-label">TAF</div>${naBox('TAF なし（この局は TAF を出していないか配信がありません）')}`;
      else {
        const latest = e.metar?.[0];
        const cat = latest ? (window.FBWx.flightCategory(latest.raw, icao) || latest.fltCat) : null;
        const speci = !!(e.speci || (latest && window.FBWxLive && window.FBWxLive.isSpeci(latest)));
        body = `${e.carriedOver ? `<p class="hint"><span class="badge stale">STALE</span> 今回の取得に失敗したため前回の値です（${esc(fmtJst(e.fetchedAt))}取得）</p>` : (apProf(icao)?.foreign && e.fetchedAt ? `<p class="hint">METAR/TAF 取得 ${esc(fmtJst(e.fetchedAt))}（${esc(ageText(e.fetchedAt))}）・海外空港は1時間ごとに更新</p>` : '')}
          <div class="sub-label${speci ? ' speci-now' : ''}">${speci ? 'SPECI' : 'METAR'} ${latest ? `${esc(fmtUtc(latest.obsTime))}（${esc(fmtJst(latest.obsTime, false))}）` : ''} ${speci ? '<span class="badge speci">SPECI</span>' : ''} ${liveTag(e.live && e.live.metar)} ${cat ? `<span class="badge ${cat}">${cat}</span>` : ''} <span class="vmc-basis${window.FBWx.limitsFor(icao).strict ? ' strict' : ''}" title="${window.FBWx.limitsFor(icao).faa ? '飛行状態の判定基準（FAA：IFR は 3SM 未満または 1,000ft 未満）' : '飛行状態の IFR 境界（航空法施行規則第5条第4号）'}">${esc(window.FBWx.limitsFor(icao).text)}</span> <span class="doc-status ${latest ? 'ok' : 'fail'}">${esc(e.metarSource || 'NONE')}</span></div>
          ${latest ? `<div class="raw${speci ? ' speci-now' : ''}">${window.FBWx.highlight(latest.raw, icao)}</div>` : naBox('METAR 未取得')}
          ${srcNotes(e, 'metar')}
          ${e.metar?.length > 1 ? `<details><summary>過去のMETAR（直近3時間・${e.metar.length - 1}件）</summary>${e.metar.slice(1).map((x) => `<div class="raw" style="margin-top:4px">${window.FBWx.highlight(x.raw, icao)}</div>`).join('')}</details>` : ''}
          <div class="sub-label">TAF ${e.taf && e.taf.issueTime ? `発表 ${esc(fmtUtc(e.taf.issueTime))} ／ 有効 ${esc(fmtUtc(e.taf.validFrom))}〜${esc(fmtUtc(e.taf.validTo))}` : ''} ${liveTag(e.live && e.live.taf)} <span class="doc-status ${e.taf ? 'ok' : 'fail'}">${esc(e.tafSource || 'NONE')}</span></div>
          ${e.taf ? `<div class="raw">${window.FBWx.tafLines(e.taf.raw, icao)}</div>` : naBox('TAF 未取得')}
          ${srcNotes(e, 'taf')}`;
      }
      const aLive = liveOn() ? window.FBWxLive.mergedAtis(state.pack, icao) : null;
      const a = aLive ? (aLive.text ? { text: aLive.text } : null) : atis?.airports?.[icao];
      const atisFetched = aLive ? aLive.fetchedAt : atis?.fetchedAt;
      const atisLive = !!(aLive && aLive.live);
      const atisReason = aLive ? aLive.reason : (atis?.reasons?.[icao]);
      if (!e && state.pack?.manifest?.airportFiles && !loaded(icao)) { /* 未ダウンロード：ATIS 欄も出さない */ } else
      if (apProf(icao)?.foreign) body += `<div class="sub-label">ATIS</div>${naBox('海外空港の ATIS は対象外（国内 SWIM のみ）')}`; else
      body += `<div class="sub-label">ATIS ${a && atisFetched ? `<span class="hint">${esc(fmtJst(atisFetched))}取得</span>` : ''} ${liveTag(atisLive)} <span class="doc-status ${a ? 'ok' : 'fail'}">${a ? (aLive && aLive.source ? esc(aLive.source) : 'SWIM') : '未取得'}</span></div>${a ? `<pre class="raw">${esc(a.text)}</pre>` : naBox(`未取得${atisReason ? `（${atisReason}）` : (atis?.note ? `（${atis.note}）` : '')}`)}`;
      const fp = apProf(icao);
      card.innerHTML = `<div class="card-title"><span>${esc(apName(icao))} <span class="codes hint">${esc(apCodes(icao))}</span></span>${fp?.foreign ? `<span class="badge">${esc(countryJa(fp.country))}</span>` : ''}</div>${body}`;
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
  function isAnalysisFrame(fr) {
    return String(fr?.kind || '') === 'ANALYSIS' || String(fr?.label || '').startsWith('ANALYSIS');
  }
  function latestAnalysisIndex(frames) {
    let idx = -1;
    for (let i = 0; i < frames.length; i++) if (isAnalysisFrame(frames[i])) idx = i;
    return idx;
  }
  function legacyCategory(extra) {
    return { id: 'extra', label: 'その他', defaultItem: 0, items: extra.map((c, i) => ({ id: `x${i}`, label: c.title || c.id,
      product: { type: 'series', title: c.title, source: c.source, variants: [{ id: 'main', label: c.title, defaultFrame: 0,
        frames: [{ label: [c.kind, c.level, c.validTime ? fmtUtc(c.validTime) : ''].filter(Boolean).join(' ・ '), images: [{ file: c.file }] }] }] } })) };
  }
  function isDustItem(it) {
    return it && (it.id === 'kosa' || it.id === 'pm25' || it.label === '黄砂' || it.label === 'PM2.5');
  }
  function chartCats() {
    const ch = state.pack?.charts;
    if (!ch) return [];
    // 黄砂・PM2.5 はレーダーエコーのサブタブへ（既にそこにあるパックはそのまま。旧パックは衛星画像などから移す）
    const cats = (ch.categories || []).map((c) => ({ ...c, items: (c.items || []).slice() }));
    const moved = [];
    for (const c of cats) {
      if (c.id === 'radar' || c.label === 'レーダーエコー') continue;
      const keep = [];
      for (const it of c.items) {
        if (isDustItem(it)) moved.push(it);
        else keep.push(it);
      }
      c.items = keep;
    }
    const radar = cats.find((c) => c.id === 'radar' || c.label === 'レーダーエコー');
    if (radar && moved.length) {
      const have = new Set((radar.items || []).map((it) => it.id));
      for (const it of moved) {
        if (!have.has(it.id)) { radar.items.push(it); have.add(it.id); }
      }
      let changed = false;
      for (const it of moved) {
        for (const from of [...cats.map((c) => c.id), 'satellite', 'kosa', 'pm25', 'dust']) {
          if (!from || from === radar.id) continue;
          const oldKey = `${from}/${it.id}`;
          const newKey = `${radar.id}/${it.id}`;
          if (chartSel.variant[oldKey] != null && chartSel.variant[newKey] == null) {
            chartSel.variant[newKey] = chartSel.variant[oldKey]; changed = true;
          }
          if (chartSel.item[from] === it.id) {
            if (chartSel.cat === from) { chartSel.cat = radar.id; changed = true; }
            if (!chartSel.item[radar.id]) { chartSel.item[radar.id] = it.id; changed = true; }
          }
        }
        if (chartSel.cat === it.id) { chartSel.cat = radar.id; chartSel.item[radar.id] = it.id; changed = true; }
      }
      if (changed) saveSel();
    }
    const out = cats.filter((c) => (c.items && c.items.length) || c.id === 'radar' || c.label === 'レーダーエコー');
    if (ch.extra?.length) out.push(legacyCategory(ch.extra));
    return out;
  }
  function renderCharts() {
    if (window.FBRadarLive) window.FBRadarLive.unwatch();
    const ch = state.pack?.charts;
    const meta = $('charts-meta'), catsNav = $('chart-cats'), itemsNav = $('chart-items'), vbox = $('chart-variants'), body = $('chart-body');
    catsNav.innerHTML = ''; itemsNav.innerHTML = ''; vbox.innerHTML = ''; body.innerHTML = '';
    if (state.pack?.manifest?.packId !== chartsPackId) { for (const k of Object.keys(frameIdx)) delete frameIdx[k]; chartsPackId = state.pack?.manifest?.packId; }
    // WX の最初のサブタブ＝BRIEF（旧・独立タブ）。最後に選んだサブタブは従来どおり覚えている。初めて開いた時の既定は BRIEF
    const cats = [{ id: 'brief', label: 'BRIEF' }, ...chartCats()];
    let cat = cats.find((c) => c.id === chartSel.cat) || cats[0];
    cats.forEach((c) => catsNav.appendChild(chip(c.label, c === cat, () => { chartSel.cat = c.id; saveSel(); renderCharts(); })));
    const isBrief = cat.id === 'brief';
    $('brief-pane').hidden = !isBrief; meta.hidden = isBrief;
    if (isBrief) { meta.innerHTML = ''; renderBrief(); return; }
    if (!ch) { meta.textContent = 'パックがありません。'; return; }
    if (cats.length < 2) { meta.innerHTML = '<span class="hint">このパックには図がありません（旧形式のパック）。更新をお待ちください。</span>'; return; }
    const errs = ch.errors || [];
    meta.innerHTML = `取得 ${esc(fmtJst(ch.fetchedAt))}（${esc(ageText(ch.fetchedAt))}）・ 端末に保存済み（Windy 以外はオフライン表示可）${errs.length ? ` <details class="chart-errors"><summary>今回取得できなかった図 ${errs.length}件</summary><div class="hint">${errs.map(esc).join('<br>')}</div></details>` : ''}`;
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
    // 三十分大気解析：平面図（高度）と断面図（航空路）は、選択部（セレクト／チップ）の左右に「隣へ移動」ボタン（端では押せない）
    const stepWrap = (mid) => {
      if (!(v.group === '平面図' || v.group === '断面図（航空路）')) return mid;
      const plan = v.group === '平面図';
      const flNum = (x) => parseInt(String(x.label).replace(/[^0-9]/g, ''), 10) || 0;
      // 平面図：◀＝1つ低い高度、▶＝1つ高い高度（高度の数値順）。航空路：◀＝リストの1つ前、▶＝1つ後
      const ordered = plan ? inGroup.slice().sort((a, b) => flNum(a) - flNum(b)) : inGroup.slice();
      const i = ordered.indexOf(v);
      const prev = i > 0 ? ordered[i - 1] : null, next = i >= 0 && i < ordered.length - 1 ? ordered[i + 1] : null;
      const wrap = document.createElement('div'); wrap.className = 'sel-step';
      const mk = (txt, target, label) => { const b = document.createElement('button'); b.type = 'button'; b.className = 'btn sel-step-btn'; b.textContent = txt; b.setAttribute('aria-label', label + (target ? `：${target.label}` : '')); b.title = b.getAttribute('aria-label'); b.disabled = !target; if (target) b.onclick = () => pick(target.id); return b; };
      wrap.appendChild(mk('◀', prev, plan ? '1つ低い高度へ' : '前の断面へ'));
      wrap.appendChild(mid);
      wrap.appendChild(mk('▶', next, plan ? '1つ高い高度へ' : '次の断面へ'));
      return wrap;
    };
    if (inGroup.length > 10 || (inGroup.length > 1 && (v.group === '平面図' || v.group === '断面図（航空路）'))) {
      const s = document.createElement('select');
      s.innerHTML = inGroup.map((x) => `<option value="${esc(x.id)}"${x === v ? ' selected' : ''}>${esc(x.label)}${x.carriedOver ? '（前回分）' : ''}</option>`).join('');
      s.onchange = () => pick(s.value);
      vbox.appendChild(stepWrap(s));
    } else if (inGroup.length > 1) {
      const w = document.createElement('div'); w.className = 'vchips';
      // 三十分大気解析の断面図（経度）：左右の並びを逆にして西（122.5E）→東（145E）の順に表示する
      const shown = v.group === '断面図（経度）' ? inGroup.slice().reverse() : inGroup;
      shown.forEach((x) => w.appendChild(chip(x.label, x === v, () => pick(x.id), x.carriedOver ? ' stale' : '')));
      vbox.appendChild(stepWrap(w));
    }
    // PM2.5 予測：パック作成時点で「いま以降で一番早い時刻」から5コマ。開いた後に過去になっても作成時のまま全コマ表示する
    const packFrames = v.frames || [];
    const radarLive = !!(window.FBRadarLive && window.FBRadarLive.isLiveProduct(item.id));
    let frames = packFrames;
    if (radarLive) {
      const cached = window.FBRadarLive.get(item.id, v.id);
      if (cached) frames = window.FBRadarLive.mergeFrames(packFrames, cached).frames;
    }
    if (!frames.length) { panel.innerHTML = head() + '<div class="chart-stage"><p class="hint">表示できるコマがありません。</p></div>'; body.appendChild(panel); return; }
    const fkey = `${key}/${v.id}`;
    if (frameIdx[fkey] == null || frameIdx[fkey] >= frames.length) {
      frameIdx[fkey] = radarLive
        ? window.FBRadarLive.defaultObsIndex(frames)
        : Math.min(v.defaultFrame ?? frames.length - 1, frames.length - 1);
    }
    const carried = p.carriedOver || v.carriedOver;
    const latestI = (cat.id === 'fxjp' || item.id === 'a30') ? latestAnalysisIndex(frames) : -1;
    const latestBtnHtml = (latestI >= 0 && frames.length > 1)
      ? '<button type="button" class="btn f-latest" aria-label="最新の ANALYSIS に戻る">最新</button>' : '';
    const credit = radarLive ? `<div class="chart-note hint">${esc(window.FBRadarLive.CREDIT)}</div>` : '';
    const note = p.note ? `<div class="chart-note hint">${esc(p.note.replace('アプリを開いた時に過去になったコマは自動で隠す。', ''))}</div>` : '';
    panel.innerHTML = head(carried ? ' <span class="badge carried">前回分</span>' : '')
      + '<div class="chart-stage"><p class="hint">読み込み中…</p></div>'
      + (frames.length > 1 ? `<div class="frame-bar"><button type="button" class="btn f-prev">◀</button><span class="lbl"></span>${latestBtnHtml}<button type="button" class="btn f-next">▶</button></div><input class="frame-slider" type="range" min="0" max="${frames.length - 1}" step="1" />` : '<div class="frame-bar"><span class="lbl"></span></div>')
      + note + credit;
    body.appendChild(panel);
    const stage = panel.querySelector('.chart-stage'), lbl = panel.querySelector('.lbl'), slider = panel.querySelector('.frame-slider');
    const latestBtn = panel.querySelector('.f-latest');
    let tok = 0;
    const urlFn = state.pack.imageUrl;
    const show = async (i) => {
      if (!frames.length) return;
      i = Math.max(0, Math.min(frames.length - 1, i)); frameIdx[fkey] = i;
      const fr = frames[i];
      const age = frameAge(fr);
      if (radarLive && lbl) {
        const badge = window.FBRadarLive.badgeHtml(fr, { online: navigator.onLine, receivedAt: fr.receivedAt });
        lbl.innerHTML = `${frames.length > 1 ? `${i + 1}/${frames.length} ・ ` : ''}${esc(fr.label || '')}${age ? `（${esc(age)}）` : ''} ${badge}`;
      } else if (lbl) {
        lbl.textContent = `${frames.length > 1 ? `${i + 1}/${frames.length} ・ ` : ''}${fr.label || ''}${age ? `（${age}）` : ''}`;
      }
      if (slider) { slider.max = String(Math.max(0, frames.length - 1)); slider.value = String(i); }
      if (latestBtn) {
        const atLatest = i === latestI;
        latestBtn.disabled = atLatest;
        latestBtn.setAttribute('aria-disabled', atLatest ? 'true' : 'false');
      }
      const my = ++tok;
      const node = await window.FBViewer.compose(fr, urlFn, 'inline');
      if (my !== tok || !panel.isConnected) return;
      stage.innerHTML = ''; stage.appendChild(node);
      if (fr.live) stage.dataset.radarLive = '1'; else delete stage.dataset.radarLive;
      stage.dataset.frameTime = fr.time || '';
      stage.insertAdjacentHTML('beforeend', '<span class="zoom-hint">タップで拡大</span>');
      // 前後のコマを先読み
      for (const j of [i + 1, i - 1]) if (frames[j]) frames[j].images.forEach((im) => { if (im && im.file && !im.url) urlFn(im.file); });
    };
    const bindControls = () => {
      const prev = panel.querySelector('.f-prev'), next = panel.querySelector('.f-next'), sl = panel.querySelector('.frame-slider');
      if (prev) prev.onclick = () => show(frameIdx[fkey] - 1);
      if (next) next.onclick = () => show(frameIdx[fkey] + 1);
      if (latestBtn) latestBtn.onclick = () => { if (latestI >= 0) show(latestI); };
      if (sl) sl.oninput = () => show(Number(sl.value));
    };
    bindControls();
    stage.onclick = () => window.FBViewer.open(frames, frameIdx[fkey], urlFn, `${p.title || item.label}${variants.length > 1 ? ' ・ ' + v.label : ''}`, (i) => { frameIdx[fkey] = i; show(i); });
    show(frameIdx[fkey]);
    if (radarLive) {
      window.FBRadarLive.watch({
        product: item.id,
        area: v.id,
        packFrames,
        reason: 'open',
        onUpdate: (rec) => {
          if (!panel.isConnected) return;
          const merged = window.FBRadarLive.mergeFrames(packFrames, rec);
          const nextI = window.FBRadarLive.resolveIndex(frames, frameIdx[fkey], merged.frames);
          frames = merged.frames;
          if (slider) slider.max = String(Math.max(0, frames.length - 1));
          else if (frames.length > 1 && !panel.querySelector('.frame-slider')) {
            const bar = panel.querySelector('.frame-bar');
            if (bar && !bar.querySelector('.f-prev')) {
              bar.insertAdjacentHTML('afterbegin', '<button type="button" class="btn f-prev">◀</button>');
              bar.insertAdjacentHTML('beforeend', '<button type="button" class="btn f-next">▶</button>');
            }
            bar.insertAdjacentHTML('afterend', `<input class="frame-slider" type="range" min="0" max="${frames.length - 1}" step="1" />`);
            bindControls();
          }
          show(nextI);
        },
      });
    }
  }
  function renderWxText(panel, head) {
    panel.innerHTML = head();
    const box = document.createElement('div'); box.className = 'wx-cards';
    panel.appendChild(box);
    renderWxCards(box);
  }

  // ---------------------------------------------------------------- MAP（旧版の MAP タブ：Leaflet＋同梱基図、オフライン可）
  function renderMap() {
    const el = $('map-box');
    if (!el || !window.L || !window.FBMap) return;
    if (!$('tab-map').classList.contains('active')) { renderMap.dirty = true; return; }
    renderMap.dirty = false;
    const wx = state.pack?.wx?.airports || {};
    const prof = state.pack?.airports?.airports || {};
    const idx = state.pack?.index?.airports || {};
    const sel = mainAirports();
    const list = [];
    const ids = new Set([...(state.pack?.manifest?.airports || []), ...sel]);
    for (const icao of ids) {
      const a = airportInfo(icao), p = prof[icao] || idx[icao];
      const lat = p?.lat ?? a?.lat, lon = p?.lon ?? a?.lon;
      if (lat == null || lon == null) continue;
      const e = liveOn() ? window.FBWxLive.mergedWx(state.pack, icao) : wx[icao], mt = e?.metar?.[0];
      // 選んでいない空港は一覧（index.json）の飛行状態だけ（METAR 本文などは選んだ空港の分だけダウンロード）
      const cat = mt ? (window.FBWx.flightCategory(mt.raw, icao) || mt.fltCat) : (idx[icao]?.fltCat || null);
      list.push({ icao, lat, lon, cat, sel: sel.includes(icao), name: apName(icao), codes: apCodes(icao),
        popupHtml: () => {
          const n = state.pack?.notam?.airports?.[icao];
          const nn = n?.items?.length;
          return `<div class="pop-title"><b>${esc(apName(icao))}</b> <span class="codes">${esc(apCodes(icao))}</span> ${cat ? `<span class="badge ${cat}">${cat}</span>` : '<span class="badge na">METARなし</span>'}</div>
            ${!e && state.pack?.manifest?.airportFiles ? `<p class="hint">${sel.includes(icao) ? esc(missText(icao)) : 'この空港は選択していません。SETTINGS で選ぶと METAR/TAF・NOTAM などをこの端末にダウンロードします。'}</p>` : ''}
            ${mt ? `<div class="sub-label">${(e.speci || (window.FBWxLive && window.FBWxLive.isSpeci(mt))) ? 'SPECI' : 'METAR'} ${esc(fmtUtc(mt.obsTime))} ${liveTag(e.live && e.live.metar)}</div><div class="raw${(e.speci || (window.FBWxLive && window.FBWxLive.isSpeci(mt))) ? ' speci-now' : ''}">${window.FBWx.highlight(mt.raw, icao)}</div>` : ''}
            ${e?.taf ? `<div class="sub-label">TAF ${liveTag(e.live && e.live.taf)}</div><div class="raw">${window.FBWx.tafLines(e.taf.raw, icao)}</div>` : ''}
            ${e ? `<div class="hint" style="margin-top:6px">${state.pack?.notam?.ok ? `NOTAM ${nn != null ? nn + '件' : '未収録'}` : 'NOTAM 未取得'}</div>` : ''}`;
        } });
    }
    window.FBMap.render(el, list);
    window.FBMap.invalidate();
    const shown = list.filter((x) => x.sel).length;
    $('map-meta').textContent = state.pack ? `空港 ${list.length}（選択 ${shown}）・ METAR ${fmtJst(state.pack.wx?.fetchedAt)}` : 'パックがありません。';
  }


  // ---------------------------------------------------------------- FLIGHTS（パックの時刻表から便名検索。通信しない）
  const fl = { carrier: lsGet('fb.flCarrier', 'ALL'), date: null, manual: false };
  const apShort = (code) => { const p = state.pack?.airports?.airports?.[code]; const a = airportInfo(code); const nm = a?.name || state.pack?.flights?.airportNames?.[code] || p?.name || ''; const iata = a?.iata || p?.iata || (code.length === 3 ? code : ''); return { iata: iata || code, name: nm }; };
  const SRC_JA = { odpt: 'ODPT', 'ana-pdf': 'ANA公式PDF', 'official-pdf': '公式PDF', live: '公式サイト', official: '公式', toki: 'トキエア公式', board: '空港の発着案内', rararakt: 'rararakt' };
  // MAP の判定基準：初期は非表示。凡例（VFR/MVFR/IFR/LIFR）を押すとそのカテゴリの基準を表示（もう一度押すと閉じる）。航空法（国内）と FAA基準（海外）を分けて書く
  const CAT_CRITERIA = {
    VFR: ['国内（航空法）：IFR・MVFR のどちらにも当たらない（視程 5SM 超 かつ 雲高 3000ft 超）', 'FAA基準（海外・RJ/RO 以外）：視程 5SM 超 かつ 雲高 3000ft 超'],
    MVFR: ['国内（航空法）：視程 5000m〜5SM または 雲高 1000〜3000ft', 'FAA基準（海外・RJ/RO 以外）：視程 3〜5SM または 雲高 1000〜3000ft'],
    IFR: ['国内（航空法施行規則§5）：視程 5000m 未満 または 雲高 1000ft 未満。告示空港（8km/450m）は 視程 8000m 未満 または 1500ft 未満（現在 指定 0 件）', 'FAA基準（海外・RJ/RO 以外）：視程 1SM 以上 3SM 未満 または 雲高 500ft 以上 1000ft 未満'],
    LIFR: ['国内・海外とも FAA 基準：視程 1SM 未満 または 雲高 500ft 未満'],
  };
  function setupMapLegend() {
    const box = $('map-thresh'); const legend = document.querySelector('.map-legend');
    if (!box || !legend) return;
    let cur = null;
    legend.addEventListener('click', (e) => {
      const b = e.target.closest('[data-cat]'); if (!b) return;
      const c = b.dataset.cat; cur = cur === c ? null : c;
      legend.querySelectorAll('[data-cat]').forEach((x) => x.setAttribute('aria-expanded', String(x.dataset.cat === cur)));
      if (!cur) { box.classList.add('hidden'); box.innerHTML = ''; return; }
      box.innerHTML = `<b>${esc(cur)}</b><br>` + CAT_CRITERIA[cur].map((t) => esc(t)).join('<br>');
      box.classList.remove('hidden');
    });
  }
  // DATE は今日（JST）を既定にする。localStorage には保存しない（次回起動は必ず今日）。
  // 手動で別日を選んだときだけ、この起動のあいだはその日付を保つ。タブ再表示・日付の繰り越し・visibilitychange では、手動でなければ今日に戻す。
  function applyFlightsDate(date, render) {
    const el = $('fl-date');
    fl.date = date;
    if (el && el.value !== date) el.value = date;
    if (render) renderFlights();
  }
  function syncFlightsDate() {
    const today = todayJst();
    const el = $('fl-date');
    if (fl.manual && fl.date && fl.date !== today) {
      if (el && el.value !== fl.date) el.value = fl.date;
      return;
    }
    const prev = fl.date;
    fl.manual = false;
    const need = prev !== today || (el && el.value !== today);
    applyFlightsDate(today, need && prev != null && prev !== today);
  }
  function scheduleFlightsDateRollover() {
    if (scheduleFlightsDateRollover.t) clearTimeout(scheduleFlightsDateRollover.t);
    const shifted = Date.now() + 9 * 3600000;
    const [y, m, d] = todayJst().split('-').map(Number);
    const ms = Math.max(500, Date.UTC(y, m - 1, d + 1) - shifted + 50);
    scheduleFlightsDateRollover.t = setTimeout(() => { syncFlightsDate(); scheduleFlightsDateRollover(); }, ms);
  }
  function setupFlights() {
    fl.manual = false;
    applyFlightsDate(todayJst(), false);
    $('fl-date').onchange = (e) => {
      const today = todayJst();
      const v = e.target.value;
      if (!v || v === today) { fl.manual = false; applyFlightsDate(today, true); return; }
      fl.manual = true;
      applyFlightsDate(v, true);
    };
    $('fl-search').oninput = () => renderFlights();
    scheduleFlightsDateRollover();
    document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible') syncFlightsDate(); });
    window.addEventListener('pageshow', () => syncFlightsDate());
  }
  function renderFlights() {
    const d = state.pack?.flights, res = $('fl-results'), cbar = $('fl-carriers');
    if (!d || !d.rows) { res.innerHTML = '<p class="hint">パックに時刻表がありません（次回の自動更新で入ります）。</p>'; cbar.innerHTML = ''; $('fl-status').innerHTML = ''; return; }
    const have = (d.carriers || []).filter((c) => c.count > 0);
    cbar.innerHTML = '';
    { const a = chip('ALL', fl.carrier === 'ALL', () => { fl.carrier = 'ALL'; lsSet('fb.flCarrier', 'ALL'); renderFlights(); }); a.classList.add('al-all'); cbar.appendChild(a); }
    have.forEach((c) => { const b = chip(c.code, fl.carrier === c.iata2, () => { fl.carrier = c.iata2; lsSet('fb.flCarrier', c.iata2); renderFlights(); }); b.dataset.c = c.code; b.innerHTML = `<span class="al-t">${[...c.code].map((ch) => `<i>${esc(ch)}</i>`).join('')}</span>`; b.setAttribute('aria-label', c.name || c.code); cbar.appendChild(b); });
    if (fl.carrier !== 'ALL' && !have.some((c) => c.iata2 === fl.carrier)) fl.carrier = 'ALL';
    const q = $('fl-search').value;
    // 収録状況
    $('fl-status').innerHTML = `<p class="hint">時刻表の取得 ${esc(fmtJst(d.fetchedAt))}（${esc(ageText(d.fetchedAt))}。1日1回・4時台 JST に全ソースを取得）・ ${d.rows.length}行。${esc(d.note || '')}</p><table class="tbl"><tr><th>会社</th><th>便数</th><th>出典</th></tr>${(d.carriers || []).map((c) => `<tr><td>${esc(c.name)} <span class="codes">${esc(c.iata2 || c.code)}</span></td><td>${c.count ? c.count : '<span class="badge na">未収録</span>'}</td><td class="hint">${c.count ? esc(c.sources.join('・')) + (c.stale ? ' <span class="badge stale">前回分</span>' : '') : esc(c.iata2 ? (c.fail ? '取得失敗' : '取得元なし（今後対応）') : '親会社の便名で運航（JL）')}</td></tr>`).join('')}</table>
      ${d.operators ? `<p class="hint">ODPTで運航会社が分かる便：${Object.entries(d.operators).map(([k, v]) => `${esc(k)} ${v}`).join(' ・ ')}</p>` : ''}`;
    if (!q.trim()) { res.innerHTML = `<p class="hint">便名を入力してください。収録 ${have.map((c) => c.code).join(' ')}</p>`; return; }
    const r = window.FBFlights.search(d, q, { carrier: fl.carrier, date: fl.date });
    if (r.query?.bad) { res.innerHTML = '<p class="hint">便名の形が読み取れません（例：NH774 / 774）。</p>'; return; }
    const MAX = 80;
    const rows = r.results.slice(0, MAX).map((x) => {
      const [num, dep, arr, std, sta, type, days, from, to, src, op, cs, note] = x;
      const on = window.FBFlights.operatesOn(x, fl.date);
      const A = apShort(dep), B = apShort(arr);
      return `<li class="fl-row${on ? '' : ' fl-off'}"><div class="fl-top"><strong class="fl-num">${esc(num)}</strong>
        <span class="fl-route"><b>${esc(A.iata)}</b> ${esc(std || '--:--')} → <b>${esc(B.iata)}</b> ${esc(sta || '--:--')}</span>
        ${on ? '' : `<span class="badge na">${src === 'board' ? '発着案内に無い日' : 'この日は運航なし'}</span>`}${src === 'rararakt' ? '<span class="badge stale">rararakt</span>' : ''}</div>
        <div class="hint">${esc(A.name)} → ${esc(B.name)}${type ? ` ・ 機材 ${esc(type)}` : ''} ・ ${esc(window.FBFlights.daysText(days))}${from || to ? ` ・ ${esc((from || '').slice(5))}〜${esc((to || '').slice(5))}` : ''}${op && op !== 'JAL' && op !== 'ANA' ? ` ・ 運航 ${esc(op)}` : ''}${cs ? ` ・ 共同 ${esc(cs.split(' ').slice(0, 4).join(' '))}${cs.split(' ').length > 4 ? '…' : ''}` : ''}${note ? ` ・ ${esc(note)}` : ''} ・ ${esc(SRC_JA[src] || src)}</div></li>`;
    });
    let html = rows.length ? `<p class="hint">${r.results.length}件${r.results.length > MAX ? `（先頭${MAX}件）` : ''} ・ 時刻は現地時刻（時刻表）</p><ul class="flight-list">${rows.join('')}</ul>` : '<p class="hint">パックの時刻表に見つかりません。</p>';
    if (!rows.length || r.query?.carrier || r.results.every((x) => x[9] === 'rararakt')) {
      const code = r.query?.carrier ? r.query.carrier + r.query.number : (r.results[0] ? r.results[0][0] : null);
      if (!rows.length) {
        const cinfo = (d.carriers || []).find((c) => c.iata2 === r.query?.carrier);
        if (cinfo && !cinfo.count) html += `<p class="hint"><span class="badge na">未収録</span> ${esc(cinfo.name)} の時刻表はまだパックに入っていません。</p>`;
      }
      const onlyRara = rows.length && r.results.every((x) => x[9] === 'rararakt');
      if (code && (!rows.length || onlyRara)) html += (onlyRara ? '<p class="hint">この便は rararakt にしかありません。Google でも確認できます。</p>' : '') + (navigator.onLine
        ? `<p><a class="btn" href="https://www.google.com/search?q=${encodeURIComponent(code + ' フライト 運航状況')}" target="_blank" rel="noopener">Google で検索</a></p><p class="hint">外部サイト（オンライン時のみ）。</p>`
        : '<p class="hint">オフラインのため外部サイトでの確認はできません。</p>');
    }
    res.innerHTML = html;
  }

  // ---------------------------------------------------------------- NOTAM
  // ---- NOTAM > 空域（FIR のエンルート／警報＋ILS・航法援助の停波。地図・種別ごとの色・短いラベル・高度帯・JST の期間。パックの notam_area.json から。オフライン可）
  const areaOverlap = (it, now) => new Date(it.from).getTime() <= now + 24 * 3600000 && (!it.to || new Date(it.to).getTime() >= now);
  function areaAlt(it) { return `${it.lower || 'SFC'}〜${it.upper || 'UNL'}`; }
  function areaWhen(it) {
    const f = fmtJst(it.from), t = it.to ? fmtJst(it.to) : (it.perm ? '恒久' : '終了未定');
    return `${f} → ${t}`;
  }
  function areaState(it, now) {
    const f = new Date(it.from).getTime();
    if (f <= now) return { cls: 'on', text: '発効中' };
    const h = Math.round((f - now) / 3600000);
    return { cls: 'soon', text: h < 1 ? 'まもなく' : `${h}時間後から` };
  }
  function areaPopup(it) {
    const e = (x) => esc(x ?? '');
    return `<div class="area-pop"><div class="ap-h"><span class="area-badge" style="background:${esc(state.pack?.notamArea?.cats?.[it.cat]?.color || '#888')}">${e(it.label)}</span> <b>${e(it.name || '')}</b> <span class="hint">${e(it.loc)} ・ ${e(it.id)}</span></div>
      <div>高度 <b>${e(areaAlt(it))}</b></div><div>${e(areaWhen(it))}</div>${it.sched ? `<div class="hint">時間帯 ${e(it.sched)}</div>` : ''}
      <div class="ap-t">${e(it.text)}</div><details><summary>原文</summary><pre class="raw">${e(it.raw)}</pre></details></div>`;
  }
  function renderNotamArea() {
    const na = state.pack?.notamArea, meta = $('area-meta'), catsNav = $('area-cats'), list = $('area-list'), legend = $('area-legend'), mapEl = $('area-map');
    catsNav.innerHTML = ''; list.innerHTML = ''; legend.innerHTML = '';
    if (!state.pack) { meta.textContent = 'パックがありません。'; return; }
    if (!na) { meta.innerHTML = '<span class="hint">このパックに空域NOTAMがありません。次の更新（6時間ごと）をお待ちください。</span>'; return; }
    const now = Date.now();
    const defHide = Object.entries(na.cats).filter(([, v]) => !v.default).map(([k]) => k);
    const hide = new Set(lsGet(LS.areaHide, defHide));
    const all = na.items.filter((it) => areaOverlap(it, now)).map((it, i) => ({ ...it, key: `${it.id}|${it.loc}|${i}` }));
    const count = {}; all.forEach((it) => { count[it.cat] = (count[it.cat] || 0) + 1; });
    const shown = all.filter((it) => !hide.has(it.cat));
    meta.innerHTML = `取得 ${esc(fmtJst(na.fetchedAt))}（${esc(ageText(na.fetchedAt))}）・ 出所：${esc(na.source)} ・ 表示 <b>${shown.length}</b> / ${all.length}件（いまから24時間以内に有効になる・なっているもの）${na.carriedOver || na.note ? ` <span class="badge stale">${esc(na.note || '前回分')}</span>` : ''}`;
    for (const [k, v] of Object.entries(na.cats)) {
      if (!count[k]) continue;
      const b = document.createElement('button'); b.className = `chip area-chip${hide.has(k) ? ' off' : ''}`;
      b.innerHTML = `<i style="background:${esc(v.color)}"></i>${esc(v.label)} <span class="n">${count[k]}</span>`;
      b.onclick = () => { if (hide.has(k)) hide.delete(k); else hide.add(k); lsSet(LS.areaHide, [...hide]); renderNotamArea(); };
      catsNav.appendChild(b);
    }
    const geo = shown.filter((it) => it.geom), nogeo = shown.filter((it) => !it.geom);
    legend.innerHTML = `<span class="lg"><i class="lg-poly"></i>空域（多角形）</span><span class="lg"><i class="lg-circle"></i>円・半径</span><span class="lg"><i class="lg-dot"></i>小さな区域（花火など）</span><span class="lg"><i class="lg-pt">⚠</i>航法援助・ILS（位置は概略）</span>${nogeo.length ? `<span class="lg hint">図にできない ${nogeo.length}件は下の一覧のみ</span>` : ''}`;
    if (window.FBAreaMap && window.L) window.FBAreaMap.render(mapEl, geo, na.cats, areaPopup, geo.length <= 40);
    const card = (it) => {
      const st = areaState(it, now), c = na.cats[it.cat];
      const d = document.createElement('div'); d.className = 'area-item'; d.style.borderLeftColor = c.color;
      d.innerHTML = `<div class="ai-h"><span class="area-badge" style="background:${esc(c.color)}">${esc(it.label)}</span>${it.name ? ` <b>${esc(it.name)}</b>` : ''} <span class="hint">${esc(it.loc)}</span><span class="ai-st ${st.cls}">${esc(st.text)}</span></div>
        <div class="ai-m"><span>高度 <b>${esc(areaAlt(it))}</b></span><span>${esc(areaWhen(it))}</span></div>
        <div class="ai-t">${esc(it.text.slice(0, 150))}${it.text.length > 150 ? '…' : ''}</div>
        <details><summary>原文</summary><pre class="raw">${esc(it.raw)}</pre></details>`;
      if (it.geom) { d.classList.add('click'); d.querySelector('.ai-h').onclick = () => { mapEl.scrollIntoView({ block: 'center', behavior: 'smooth' }); setTimeout(() => window.FBAreaMap.focus(it.key), 250); }; }
      return d;
    };
    const sorted = shown.slice().sort((a, b) => (areaState(a, now).cls === 'on' ? 0 : 1) - (areaState(b, now).cls === 'on' ? 0 : 1) || a.from.localeCompare(b.from));
    const head = document.createElement('h3'); head.className = 'area-h'; head.textContent = `一覧（${sorted.length}件）`; list.appendChild(head);
    if (!sorted.length) list.insertAdjacentHTML('beforeend', '<p class="hint">該当なし（種別の絞り込みを確認してください）。</p>');
    sorted.forEach((it) => list.appendChild(card(it)));
  }
  function applyNotamMode() {
    const mode = (state.notamMode === 'area' || state.notamMode === 'ground') ? state.notamMode : 'ap';
    state.notamMode = mode;
    document.querySelectorAll('#notam-mode .chip').forEach((b) => b.classList.toggle('active', b.dataset.mode === mode));
    $('notam-ap').hidden = mode !== 'ap';
    $('notam-area').hidden = mode !== 'area';
    const ground = $('notam-ground');
    if (ground) ground.hidden = mode !== 'ground';
    if (!$('tab-notam').classList.contains('active')) return;
    if (mode === 'area') { renderNotamArea(); window.FBAreaMap && window.FBAreaMap.invalidate(); }
    if (mode === 'ground') renderNotamGround();
  }
  function renderNotamGround() {
    const el = $('notam-ground'); if (!el || !window.FBGround) return;
    const names = {};
    for (const icao of mainAirports()) names[icao] = `${apName(icao)} ${apCodes(icao)}`;
    window.FBGround.render(el, state.pack, { airports: mainAirports(), names });
  }
  function renderNotam() {
    applyNotamMode();
    document.querySelectorAll('#notam-period .chip').forEach((b) => b.classList.toggle('active', Number(b.dataset.hours) === state.notamHours));
    const n = state.pack?.notam, list = $('notam-list'); list.innerHTML = '';
    // 期間＝パック作成時刻（generatedAt。無ければ現在）からさかのぼった 3H/1D/1W。判定は発行時刻（issued）。ALL(0)は絞らない。有効期間や DUTY とは無関係。
    const ref = state.pack ? new Date(state.pack.manifest.generatedAt).getTime() : Date.now();
    const inPeriod = (it) => !state.notamHours || (it.issued && ref - new Date(it.issued).getTime() <= state.notamHours * 3600000);
    for (const icao of mainAirports()) {
      const box = document.createElement('div'); box.className = 'card';
      const items = (n?.airports?.[icao]?.items || []).slice();
      items.sort((a, b) => String(b.issued || '').localeCompare(String(a.issued || '')));
      const shown = items.filter(inPeriod);
      const hidden = items.length - shown.length;
      let body;
      if (!n) body = '<p class="hint">パックがありません。</p>';
      else if (!n.ok) body = `<p class="hint">未取得：${esc(n.note || '')}</p>`;
      else if (!n.airports?.[icao]) body = '<p class="hint">このパックに未収録です。</p>';
      else if (n.airports[icao].status) body = `<p class="hint">${esc(n.airports[icao].status)}</p>`;
      else if (!items.length) body = '<p class="hint">該当NOTAMなし（このパックの範囲）</p>';
      else {
        const hideNote = hidden > 0 ? `<p class="hint">期間外 ${hidden}件は非表示</p>` : '';
        const rows = shown.map((it) => `<div class="notam-item"><span class="nid">${esc(it.id || '')}</span> <span class="hint">発行 ${esc(fmtJst(it.issued))}${it.effectiveFrom ? ` ／ 有効 ${esc(fmtUtc(it.effectiveFrom))}〜${esc(it.effectiveTo ? fmtUtc(it.effectiveTo) : 'PERM')}` : ''}</span><pre>${esc(it.text || '')}</pre></div>`).join('');
        body = (shown.length ? hideNote + rows : `<p class="hint">この期間に発行されたNOTAMはありません。</p>${hideNote}`);
      }
      const badge = n?.ok && items.length ? `<span class="badge">${state.notamHours ? `${shown.length}件` : `全${items.length}件`}</span>` : '';
      box.innerHTML = `<div class="card-title"><span>${esc(apName(icao))} <span class="hint">${esc(apCodes(icao))}</span></span>${badge}</div>${body}`;
      list.appendChild(box);
    }
    if (n?.source) { const p = document.createElement('p'); p.className = 'hint'; p.textContent = `出所：${n.source}${n.fetchedAt ? `（${fmtJst(n.fetchedAt)}取得・${ageText(n.fetchedAt)}）` : ''} ／ 6時間ごとに更新（00/06/12/18時 JST）`; list.appendChild(p); }
    if (navigator.onLine) { const p = document.createElement('p'); p.innerHTML = '<a href="https://top.swim.mlit.go.jp" target="_blank" rel="noopener">SWIM portal（公式）を開く ▶</a>'; list.appendChild(p); }
  }

  // ---------------------------------------------------------------- AIRPORT
  function renderAirport() {
    const date = $('airport-date').value || todayJst();
    const list = $('airport-list'); if (!list) return; list.innerHTML = '';
    for (const icao of mainAirports()) {
      const p = state.pack?.airports?.airports?.[icao] || {};
      const sw = p.swim || null; const swOk = !!(sw && sw.ok);
      const base = airportInfo(icao);
      const lat = p.lat ?? base?.lat, lon = p.lon ?? base?.lon;
      const sun = lat != null ? window.FBSun.sunTimesJst(lat, lon, date) : null;
      const field = (k, v) => `<div class="field"><span class="k">${esc(k)}</span><span>${v == null || v === '' ? naBox() : v}</span></div>`;
      // 標高・磁気偏差・滑走路・周波数：国内は SWIM AIP（AD 2.2 / 2.12 / 2.18）。AIP に無い空港・項目は参考として NOAA（aviationweather.gov）を明記して出す
      const aip = sw?.aip || null;
      const airac = (aip?.url || '').match(/\/html\/(\d{4})(\d{2})(\d{2})\//);
      const srcAip = `<span class="src ok" title="${esc(aip?.url || '')}">SWIM AIP${airac ? ` AIRAC ${airac[1]}-${airac[2]}-${airac[3]}` : ''}</span>`;
      const srcNoaa = '<span class="src ref">参考 (NOAA)</span>';
      const tag = (html, fromAip) => (html == null ? null : `${html} ${fromAip ? srcAip : srcNoaa}`);
      const rwyAip = aip?.runways?.length ? aip.runways.map((r) => { const sub = [r.surface, r.pcr, r.thrElevFt != null ? `THR ${r.thrElevFt}ft` : ''].filter(Boolean).map(esc).join(' / '); return `<div class="rwy-row">${esc(r.id)} <span class="hint">${esc(r.lengthM)}×${esc(r.widthM)}m${r.trueBrg != null ? ` / 真方位${esc(Number(r.trueBrg).toFixed(2))}°` : ''}</span>${sub ? `<div class="hint rwy-sub">${sub}</div>` : ''}</div>`; }).join('') : null;
      const rwyNoaa = p.runways?.length ? p.runways.map((r) => `${esc(r.id)} <span class="hint">${esc(r.dimensionFt || '')}ft${r.alignment != null ? ` / 真方位${esc(r.alignment)}°` : ''}</span>`).join('<br>') : null;
      const rwy = rwyAip ? tag(rwyAip, true) : tag(rwyNoaa, false);
      const mv = aip?.magvar && aip.magvar.deg != null ? `${esc(aip.magvar.deg)}°${esc(aip.magvar.dir)}${aip.magvar.year ? `（${esc(aip.magvar.year)}）` : ''}${aip.magvar.annualChange ? ` <span class="hint">年変化 ${esc(aip.magvar.annualChange)}</span>` : ''}` : null;
      const elev = aip?.elevationFt != null ? `${esc(aip.elevationFt)} ft <span class="hint">(${esc(Math.round(aip.elevationFt * 0.3048))} m)</span>` : null;
      const fmtF = (f) => `<div>${esc(f.service)} <span class="hint">${esc(f.callsign || '')}</span> ${f.mhz.map((m) => (m === f.primary ? `<strong>${esc(m)}</strong>` : esc(m))).join(' / ')}${f.emergency?.length ? ` <span class="hint">緊急 ${f.emergency.map(esc).join('/')}</span>` : ''}${f.hours ? ` <span class="hint">(${esc(f.hours)})</span>` : ''}</div>`;
      const freqAip = aip?.freqs?.length ? aip.freqs.map(fmtF).join('') + '<div class="hint">太字＝主周波数</div>' : null;
      const freqNoaa = p.freqs?.length ? p.freqs.map((f) => `${esc(f.type)} ${esc(f.mhz)}`).join(' ／ ') : null;
      const freqs = freqAip ? tag(freqAip, true) : tag(freqNoaa, false);
      const card = document.createElement('div'); card.className = 'card';
      if (state.pack?.manifest?.airportFiles && !loaded(icao)) {
        card.innerHTML = `<div class="card-title"><span>${esc(apName(icao))} <span class="hint">${esc(apCodes(icao))}</span></span><span class="badge na">${packHas(icao) ? '未ダウンロード' : 'パック未収録'}</span></div><p class="hint">${esc(missText(icao))}</p>${sun ? field('日の出・日没', `日の出 ${esc(sun.sunrise || '--:--')} / 日没 ${esc(sun.sunset || '--:--')} <span class="hint">(${esc(date)} JST・端末で計算)</span>`) : ''}`;
        list.appendChild(card); continue;
      }
      card.innerHTML = `<div class="card-title"><span>${esc(apName(icao))} <span class="hint">${esc(apCodes(icao))}</span></span>${state.pack?.airports?.airports?.[icao] ? (p.foreign ? `<span class="badge">${esc(countryJa(p.country))}${p.verified === false ? '・出典弱' : ''}</span>` : '') : '<span class="badge na">パック未収録</span>'}</div>
        ${sw ? `<div class="hint" style="margin-bottom:4px"><span class="doc-status ${swOk ? 'ok' : 'fail'}">${swOk ? 'SWIM' : '未取得'}</span> SWIM 空港情報 ${esc(fmtJst(sw.fetchedAt))}取得（${esc(ageText(sw.fetchedAt))}）</div>${!swOk && sw.reason ? `<div class="doc-note">${esc(sw.reason)}</div>` : ''}` : ''}
        ${swOk ? field('空港運用状況', sw.operationalStatus.length ? sw.operationalStatus.map(esc).join('<br>') : '通常') : ''}
        ${swOk ? field('使用滑走路', sw.runwaysInUse.length ? sw.runwaysInUse.map(esc).join(' ／ ') : null) : ''}
        ${field('運用時間', swOk && sw.operatingHours ? `${esc(sw.operatingHours)} <span class="hint">(SWIM)</span>` : (p.operatingHours ? esc(p.operatingHours) : null))}
        ${field('滑走路', rwy)}
        ${field('進入方式', swOk && sw.approach.length ? sw.approach.map(esc).join(' ／ ') : (p.approaches ? esc(p.approaches) : null))}
        ${swOk ? field('平均遅延', (sw.departureDelayMin != null || sw.arrivalDelayMin != null) ? `出発 ${esc(sw.departureDelayMin ?? '--')}分 ／ 到着 ${esc(sw.arrivalDelayMin ?? '--')}分` : null) : ''}
        ${swOk ? field('飛行場警報', sw.aerodromeWarning.length ? `<span class="hl-warn">${sw.aerodromeWarning.map(esc).join('<br>')}</span>` : '発表なし') : ''}
        ${field('日の出・日没', swOk && date === todayJst() && (sw.sunriseJst || sw.sunsetJst) ? `日の出 ${esc(sw.sunriseJst || '--:--')} / 日没 ${esc(sw.sunsetJst || '--:--')} <span class="hint">(SWIM)</span>` : (sun ? `日の出 ${esc(sun.sunrise || '--:--')} / 日没 ${esc(sun.sunset || '--:--')} <span class="hint">(${esc(date)} JST・端末で計算)</span>` : null))}
        ${field('標高', elev ? tag(elev, true) : tag(p.elevationFt != null ? `約 ${esc(p.elevationFt)} ft` : null, false))}
        ${field('磁気偏差', mv ? tag(mv, true) : tag(p.magdec ? esc(p.magdec) : null, false))}
        ${field('周波数', freqs)}
        ${p.notes ? field('メモ', esc(p.notes)) : ''}
        ${aip?.unparsed?.length ? `<div class="doc-note">AIP から読み取れなかった項目：${esc(aip.unparsed.join('・'))}（その項目は NOAA 参考値）</div>` : ''}
        ${p.foreign ? '' : `<details class="lost-comm-details field"><summary>Lost Communication Procedures &#9662;</summary>${sw?.lostComm?.ok && sw.lostComm.text ? `<div class="lost-comm-source">SWIM（AIP AD 2 ${esc(icao)}${sw.lostComm.fetchedAt ? `・${esc(fmtJst(sw.lostComm.fetchedAt))}取得` : ''}）</div><div class="lost-comm-body">${esc(sw.lostComm.text)}</div>` : `<div class="lost-comm-body">未取得${sw?.lostComm?.reason ? `（${esc(sw.lostComm.reason)}）` : (state.pack?.airports?.swimTargets && !state.pack.airports.swimTargets.includes(icao) ? '（SWIM の取得対象外）' : '')}</div>`}</details>`}`;
      list.appendChild(card);
    }
    if (state.pack?.airports?.source) { const s = document.createElement('p'); s.className = 'hint'; s.textContent = `出所：${state.pack.airports.source}`; list.appendChild(s); }
  }

  // ---------------------------------------------------------------- DUTY
  function saveDuty() { lsSet(LS.duty, state.duty); }
  // DUTY の自動入力：パックの今日の便（duty_default.json）を、まだ今日手動で触っていない時だけ入れる。
  // 便の追加・削除・日付変更をした日（manualOn＝その日）は、その人の手動の内容を次の日まで残す。
  function markDutyManual() { const d = state.duty; d.source = 'manual'; d.manualOn = todayJst(); }
  function applyDutyDefault() {
    const dd = state.pack?.dutyDefault, d = state.duty, today = todayJst();
    if (!dd || dd.date !== today || !Array.isArray(dd.flights)) return false;
    if (d.manualOn === today) return false;                       // 今日はこの端末で手動編集済み → そのまま
    const flights = dd.flights.map((f) => `${f.airline || 'SFJ'}${f.flightNumber}`);
    const key = `${dd.date}|${flights.join(',')}`;
    if (d.source === 'auto' && d.autoKey === key && d.date === today) return false;   // すでに同じ内容を入れてある
    d.date = today; d.flights = flights; d.source = 'auto'; d.autoKey = key; d.autoFetchedAt = dd.fetchedAt || null; d.manualOn = null;
    saveDuty();
    const dateEl = $('duty-date'); if (dateEl) dateEl.value = today;
    const apd = $('airport-date'); if (apd) apd.value = today;
    return true;
  }
  function setupDuty() {
    const d = state.duty;
    $('duty-date').value = d.date || todayJst();
    $('duty-buffer').value = String(d.buffer || 2);
    $('duty-note').value = d.note || '';
    const sel = $('duty-airline');
    sel.innerHTML = AIRLINES.map((c) => `<option${c === d.airline ? ' selected' : ''}>${c}</option>`).join('');
    $('duty-date').onchange = (e) => { d.date = e.target.value; markDutyManual(); saveDuty(); $('airport-date').value = d.date; renderAirport(); renderDuty(); };
    $('duty-buffer').onchange = (e) => { d.buffer = Number(e.target.value); saveDuty(); };
    $('duty-note').oninput = (e) => { d.note = e.target.value; saveDuty(); };
    sel.onchange = (e) => { d.airline = e.target.value; saveDuty(); };
    $('duty-flight').oninput = (e) => { const v = e.target.value.replace(/[^0-9]/g, ''); if (v !== e.target.value) e.target.value = v; };
    const add = () => {
      const v = $('duty-flight').value.replace(/[^0-9]/g, '');
      if (!v) return;
      const fl = `${d.airline}${v}`;
      if (!d.flights.includes(fl)) d.flights.push(fl);
      markDutyManual();
      $('duty-flight').value = ''; saveDuty(); renderDuty(); ensureAirports();
    };
    $('duty-add').onclick = add;
    $('duty-flight').onkeydown = (e) => { if (e.key === 'Enter') add(); };
    renderDuty();
  }
  function tafWindow(icao, date, hhmm, label) {
    const e = wxOf(icao);
    const buf = Number(state.duty.buffer || 2);
    const win = hhmm ? (() => { const [h, m] = hhmm.split(':').map(Number); const t = h * 60 + m; const f = (x) => { x = ((x % 1440) + 1440) % 1440; return `${String(Math.floor(x / 60)).padStart(2, '0')}:${String(x % 60).padStart(2, '0')}`; }; return `${f(t - buf * 60)}〜${f(t + buf * 60)}`; })() : '';
    const head = `<div class="sub-label">${esc(label)} ${esc(apCodes(icao))}${win ? ` ・ 時間帯 ${esc(win)}（現地）` : ''}</div>`;
    if (!e) return head + naBox(missText(icao));
    // 旧版 buildLegTafBlock と同じ：定刻（JST）±バッファに重なる変化群の行を強調
    let wi = null;
    if (hhmm && date && /^R[JO]/.test(icao)) { const t = Date.parse(`${date}T${hhmm}:00+09:00`); if (Number.isFinite(t)) wi = { startEpoch: t - buf * 3600000, endEpoch: t + buf * 3600000, anchorEpoch: t }; }
    return head + (e.taf ? `<div class="raw">${window.FBWx.tafLinesWithWindow(e.taf.raw, wi, icao)}</div>` : naBox('TAF なし')) + (e.metar?.[0] ? `<div class="raw">${window.FBWx.highlight(e.metar[0].raw, icao)}</div>` : '');
  }
  function dutyLeg(f) {
    const d = state.pack?.flights;
    if (!d?.rows) return '<span class="duty-leg hint">パックに時刻表がありません</span>';
    const r = window.FBFlights.search(d, f, { exact: true, date: state.duty.date || todayJst() }).results.filter((x) => window.FBFlights.operatesOn(x, state.duty.date || todayJst()));
    if (!r.length) return '<span class="duty-leg hint">この日の時刻表に見つかりません（FLIGHTS で確認）</span>';
    return r.slice(0, 2).map((x) => `<span class="duty-leg">${esc(apShort(x[1]).iata)} ${esc(x[3] || '--:--')} → ${esc(apShort(x[2]).iata)} ${esc(x[4] || '--:--')}${x[5] ? ` ・ ${esc(x[5])}` : ''} <span class="hint">${esc(SRC_JA[x[9]] || x[9])}</span>${tafWindow(x[1], state.duty.date, x[3], '出発')}${tafWindow(x[2], state.duty.date, x[4], '到着')}</span>`).join('');
  }
  function renderDuty() {
    const srcEl = $('duty-src');
    if (srcEl) {
      const dd = state.pack?.dutyDefault, d = state.duty;
      srcEl.textContent = d.source === 'auto' ? `自動入力（iFlight）${d.autoFetchedAt ? ` ・ ${fmtJst(d.autoFetchedAt)}取得` : ''}` : d.source === 'manual' ? '手動' : '';
      srcEl.className = `duty-src ${d.source || ''}`;
      srcEl.title = dd ? `自動入力用の便：${dd.date}（${dd.flights?.length || 0}便）` : '';
    }
    const ul = $('duty-list'); ul.innerHTML = '';
    if (!state.duty.flights.length) ul.innerHTML = '<li class="hint">便が登録されていません</li>';
    state.duty.flights.forEach((f, i) => {
      const li = document.createElement('li');
      li.innerHTML = `<span><strong>${esc(f)}</strong>${dutyLeg(f)}</span><button class="btn btn-danger">削除</button>`;
      li.querySelector('button').onclick = () => { state.duty.flights.splice(i, 1); markDutyManual(); saveDuty(); renderDuty(); };
      ul.appendChild(li);
    });
    const pd = state.pack?.manifest?.duty;
    $('duty-pack').innerHTML = pd ? `ボットのパックのDUTY：${esc(pd.date || '')} ${esc((pd.flights || []).join(', '))}${pd.note ? ` ／ ${esc(pd.note)}` : ''}` : '';
  }

  // ---------------------------------------------------------------- TAS
  // ---------------------------------------------------------------- WIND（Wind Limitation）
  function setupWind() {
    if (!window.FBWind) return;
    window.FBWind.setup(() => ({
      airports: wantedAirports().map((icao) => ({
        icao, label: `${icao} ${apName(icao)}`,
        profile: state.pack?.airports?.airports?.[icao] || null,
        metar: (wxOf(icao)?.metar && wxOf(icao).metar[0]) || null,
      })),
    }));
  }
  function renderWind() { try { window.FBWind?.render(); } catch (e) { console.warn(e); } }
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
      const m = state.pack?.manifest;
      const bytes = m && window.FBPack.deviceBytes ? window.FBPack.deviceBytes(m, wantedAirports()) : 0;
      $('ap-sync').innerHTML = m ? `<p class="hint">ボットはパックの全 ${m.airports.length} 空港を取得しています（国内：METAR/TAF・ATIS・図は15分ごと、NOTAM は6時間ごと、空港情報と時刻表は1日1回。海外：METAR/TAF は1時間ごと、空港情報は週1回）。この端末にダウンロードするのは、ここで選んだ空港${dutyAirports().some((i) => !mainAirports().includes(i)) ? '（＋DUTY の区間の空港）' : ''}と共通の図だけです${m.airportFiles ? `（今の選択で約 ${fmtBytes(bytes)}）` : ''}。空港を増やすと、オンライン時にその空港の分だけ追加で取得します。</p>` : '';
      mainAirports().forEach((icao, i) => {
        const li = document.createElement('li');
        li.innerHTML = `<span>${esc(apName(icao))} <span class="codes">${esc(apCodes(icao))}</span>${!packHas(icao) ? ' <span class="badge na">パック未収録</span>' : (state.pack && !loaded(icao) ? ' <span class="badge na">未ダウンロード</span>' : '')}</span><span><button class="btn btn-danger" data-a="rm">削除</button></span>`;
        li.querySelector('[data-a=rm]').onclick = () => { const l = mainAirports().slice(); l.splice(i, 1); setAirports(l); renderAll(); };
        ul.appendChild(li);
      });
    };
    const renderRes = () => {
      const q = search.value.trim().toUpperCase(), qj = search.value.trim();
      const ul = $('ap-results'); ul.innerHTML = '';
      if (!q) return;
      // 選べるのはパックに入っている空港（ボットが取得している全空港）
      const ids = state.pack?.manifest?.airports || (window.FB_AIRPORTS || []).map((x) => x.icao);
      const base = ids.map((icao) => { const a = airportInfo(icao), p = apIdx(icao); return { icao, iata: a?.iata || p?.iata || '', name: `${a?.name || state.pack?.manifest?.airportNames?.[icao] || p?.name || icao}${p?.foreign ? '（' + countryJa(p.country) + '）' : ''}` }; });
      const res = base.filter((a) => a.icao.includes(q) || (a.iata || '').includes(q) || a.name.includes(qj) || a.name.toUpperCase().includes(q)).slice(0, 12);
      if (!res.length) ul.innerHTML = '<li class="hint">パックの空港に見つかりません</li>';
      res.forEach((a) => {
        const li = document.createElement('li');
        li.innerHTML = `<span>${esc(a.name)} <span class="codes">${esc(a.icao)}${a.iata ? ' / ' + esc(a.iata) : ''}</span></span><span>${mainAirports().includes(a.icao) ? '✓' : '＋'}</span>`;
        li.onclick = () => { const l = mainAirports().slice(); if (!l.includes(a.icao)) l.push(a.icao); setAirports(l); search.value = ''; ul.innerHTML = ''; renderAll(); };
        ul.appendChild(li);
      });
    };
    search.oninput = renderRes;
    const renderBrowse = () => {
      const box = $('ap-browse'); if (!box) return;
      const prof = Object.fromEntries((state.pack?.manifest?.airports || []).map((i) => [i, apIdx(i) || {}]));
      const ids = state.pack?.manifest?.airports || [];
      if (!ids.length) { box.innerHTML = ''; return; }
      const groups = {};
      for (const icao of ids) { const c = prof[icao]?.country || (airportInfo(icao) ? 'Japan' : null); (groups[countryJa(c)] = groups[countryJa(c)] || []).push(icao); }
      const order = Object.keys(groups).sort((a, b) => (a === '日本' ? -1 : b === '日本' ? 1 : a.localeCompare(b, 'ja')));
      const sel = mainAirports();
      box.innerHTML = `<h3>パック収録空港（国別・${ids.length}）</h3>` + order.map((g) => `<details class="ap-group"${g !== '日本' && groups[g].some((i) => sel.includes(i)) ? ' open' : ''}><summary>${esc(g)} <span class="hint">${groups[g].length}</span></summary><ul class="airport-list">${groups[g].sort().map((icao) => `<li data-icao="${esc(icao)}"><span>${esc(apName(icao))} <span class="codes">${esc(apCodes(icao))}</span>${prof[icao]?.verified === false ? ' <span class="badge na">出典弱</span>' : ''}</span><span>${sel.includes(icao) ? '✓' : '＋'}</span></li>`).join('')}</ul></details>`).join('');
      box.querySelectorAll('li[data-icao]').forEach((li) => { li.onclick = () => { const l = mainAirports().slice(); const i = l.indexOf(li.dataset.icao); if (i >= 0) l.splice(i, 1); else l.push(li.dataset.icao); setAirports(l); renderAll(); }; });
    };
    setupAirportPicker.renderSel = () => { renderSel(); renderBrowse(); };
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
      const v = await window.FBPack.verify(p.packId, wantedAirports());
      rows.push(`<li><span>${p.packId === cur?.packId ? '▶ ' : ''}${esc(fmtJst(p.generatedAt))} <span class="hint">${esc(p.packId)} ・ ${v.have}/${v.total}ファイル ・ ${fmtBytes(p.totalBytes)}</span></span><button class="btn" data-id="${esc(p.packId)}">表示</button></li>`);
    }
    box.innerHTML = `${cur ? `<div>表示中：<strong>${esc(fmtJst(cur.generatedAt))}</strong>（${esc(ageText(cur.generatedAt))}）</div><div class="hint">packId ${esc(cur.packId)} ・ パックの空港 ${cur.airports.length}（この端末に保存：${esc([...(state.pack.loadedAirports || [])].join(', ') || 'なし')}）</div>${cur.airportFiles ? `<div class="hint">この端末のダウンロード量：約 ${fmtBytes(window.FBPack.deviceBytes(cur, [...(state.pack.loadedAirports || [])]))}（共通 ${fmtBytes(cur.sharedBytes)}＋選んだ空港。全空港なら ${fmtBytes(cur.totalBytes)}）</div>` : ''}` : '<div>パック未保存</div>'}
      <div class="hint">${esc(est)} ${esc(persisted)} ${state.remoteError ? `／ 最新確認エラー：${esc(state.remoteError)}` : ''}</div>
      <h3>保存済みパック（最新＋1つ前）</h3><ul class="airport-list">${rows.join('') || '<li class="hint">なし</li>'}</ul>`;
    box.querySelectorAll('button[data-id]').forEach((b) => { b.onclick = () => showPack(b.dataset.id); });
  }

  // ---------------------------------------------------------------- pack flow
  function renderAll() {
    const dutyChanged = applyDutyDefault();
    renderStatus(); renderMap(); renderCharts(); renderNotam(); renderAirport(); renderDuty(); renderFlights(); renderWind(); renderSwimStatus();
    setupAirportPicker.renderSel && setupAirportPicker.renderSel();
    renderPackInfo();
    if (dutyChanged) ensureAirports();   // 自動入力した便の空港をこの端末にもダウンロード
  }
  async function showPack(packId) {
    const p = await window.FBPack.load(packId, wantedAirports());
    if (!p) return false;
    state.pack = p;
    const packs = window.FBPack.list();
    state.packSource = packs[0]?.packId === packId ? (state.packSource === 'latest' ? 'latest' : 'cached') : 'previous';
    renderAll();
    return true;
  }
  // 空港の選択・DUTY を変えた時：今のパックに足りない空港の分だけ取る（オフラインなら次にオンラインになった時）
  async function ensureAirports() {
    renderAll();
    const cur = state.pack?.manifest;
    if (!cur?.airportFiles) return;
    const v = await window.FBPack.verify(cur.packId, wantedAirports());
    if (v.ok) { await showPack(cur.packId); return; }
    if (!navigator.onLine) return;
    if (refreshing) { setTimeout(ensureAirports, 1500); return; }
    if (state.packSource === 'previous') { refresh(false); return; }
    refreshing = true;
    try {
      await window.FBPack.download(cur, (d, t, db, tb) => { state.downloading = `${d}/${t}（${fmtBytes(db)} / ${fmtBytes(tb)}）`; renderStatus(); }, wantedAirports());
      state.downloading = null;
      await showPack(cur.packId);
    } catch (e) {
      state.downloading = null; state.remoteError = e.message; renderStatus();
    } finally { refreshing = false; }
  }
  let refreshing = false;
  async function refresh(force = false) {
    if (refreshing) return; refreshing = true;
    $('refresh-btn').classList.add('spinning');
    try {
      const m = await window.FBPack.checkRemote();
      state.remoteError = null;
      const have = window.FBPack.list().find((p) => p.packId === m.packId);
      const v = have ? await window.FBPack.verify(m.packId, wantedAirports()) : null;
      const prog = (d, t, db, tb) => { state.downloading = `${d}/${t}（${fmtBytes(db)} / ${fmtBytes(tb)}）`; renderStatus(); };
      if (!have || !v.ok || force) {
        state.downloading = '準備中'; renderStatus();
        await window.FBPack.download(m, prog, wantedAirports());
      }
      state.downloading = null;
      state.packSource = 'latest';
      await showPack(m.packId);
      // 新しい時刻表で DUTY の区間の空港が増えた時はその分も取る
      const v2 = await window.FBPack.verify(m.packId, wantedAirports());
      if (!v2.ok) { await window.FBPack.download(m, prog, wantedAirports()); state.downloading = null; await showPack(m.packId); }
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


  // ---------------------------------------------------------------- WX だけ更新（公開パックの気象部分だけ。端末は外部の気象サイトに直接アクセスしない）
  let toastTimer = null;
  function toast(text, bad = false, ms = 6000) {
    const t = $('toast'); if (!t) return;
    t.textContent = text; t.className = `toast show${bad ? ' bad' : ''}`;
    clearTimeout(toastTimer); toastTimer = setTimeout(() => { t.className = 'toast'; }, ms);
  }
  // ---------------------------------------------------------------- THEME（auto / light / dark）
  const darkMq = window.matchMedia ? window.matchMedia('(prefers-color-scheme: dark)') : null;
  function applyTheme() {
    const t = lsGet(LS.theme, 'auto');
    const root = document.documentElement;
    if (t === 'light' || t === 'dark') root.setAttribute('data-theme', t); else root.removeAttribute('data-theme');
    const eff = t === 'auto' ? (darkMq && !darkMq.matches ? 'light' : 'dark') : t;
    const meta = document.querySelector('meta[name="theme-color"]');
    window.FBMap && window.FBMap.refreshTheme();
    window.FBAreaMap && window.FBAreaMap.refreshTheme();
    if (meta) meta.setAttribute('content', getComputedStyle(root).getPropertyValue('--bg-panel-solid').trim() || (eff === 'light' ? '#ffffff' : '#10151d'));
    // ヘッダーのテーマボタン：現在のモードのアイコン＋title/aria-label（押すと 自動→ライト→ダーク→自動）
    const tb = $('theme-btn');
    if (tb) {
      const NAME = { auto: `自動（端末設定。現在：${eff === 'light' ? 'ライト' : 'ダーク'}）`, light: 'ライト', dark: 'ダーク' }, NEXT = { auto: 'light', light: 'dark', dark: 'auto' }, NEXT_NAME = { light: 'ライト', dark: 'ダーク', auto: '自動' };
      tb.dataset.mode = t;
      tb.title = `表示：${NAME[t]}（タップで${NEXT_NAME[NEXT[t]]}）`;
      tb.setAttribute('aria-label', `表示：${NAME[t]}。押すと${NEXT_NAME[NEXT[t]]}に切り替え`);
    }
  }
  function setupTheme() {
    $('theme-btn').onclick = () => { const cur = lsGet(LS.theme, 'auto'); lsSet(LS.theme, cur === 'auto' ? 'light' : cur === 'light' ? 'dark' : 'auto'); applyTheme(); };
    if (darkMq) (darkMq.addEventListener ? darkMq.addEventListener('change', applyTheme) : darkMq.addListener(applyTheme));
    applyTheme();
  }

  function renderSwimStatus() {
    const el = $('swim-status'); if (!el) return;
    const p = state.pack; if (!p) { el.textContent = 'パックがありません。'; return; }
    const at = p.atis, n = p.notam;
    const sm = p.airports?.swimSummary;
    const targets = p.airports?.swimTargets || [];
    if (!sm) { el.textContent = 'このパックには SWIM の集計がありません。'; return; }
    const ft = sm.fetched || {}, age = (t) => (t ? `${esc(fmtJst(t))}（${esc(ageText(t))}）` : '時刻不明');
    el.innerHTML = `ボットが取得：国内 ${sm.targets}空港（パックの国内空港すべて）。取得元ごとの頻度と最終取得：<br>`
      + `ATIS（15分ごと）：${at?.ok ? `${sm.atis}空港（SWIM ATIS の対象は${sm.atisSupported}空港） ・ ${age(at.fetchedAt)}` : esc(at?.note || '未取得')}<br>`
      + `空港プロファイル＝SWIM の METAR/TAF（15分ごと）：${sm.profile}/${sm.targets}空港 ・ ${age(ft.profile)}<br>`
      + `NOTAM（6時間ごと＝00/06/12/18時 JST）：${n?.ok ? `${sm.notam}件 ・ ${age(n.fetchedAt)}` : esc(n?.note || '未取得')}<br>`
      + `AIP（AD 2・Lost Communication。1日1回＝4時台 JST）：Lost Comm ${sm.lostComm}/${sm.targets}空港（AIP に該当項目がある空港のみ） ・ ${age(ft.aip)}<br>`
      + `NOAA 空港情報・国内（参考値。1日1回＝4時台 JST）：${age(ft.noaa)}<br>`
      + `海外空港：METAR/TAF は1時間ごと（直近の取得 ${age(ft.wxForeign)}）、空港情報（NOAA）は週1回＝月曜4時台 JST（${age(ft.noaaForeign)}）。海外の ATIS・NOTAM は対象外<br>`
      + `<span class="hint">この端末には SETTINGS で選んだ空港の分だけ保存されます（${targets.length ? `国内の選択 ${mainAirports().filter((i) => targets.includes(i)).length}空港` : ''}）。</span>`;
  }
  async function start() {
    $('app-version').textContent = `App v${APP_VERSION}`;
    setupTheme(); setupTabs(); setupTas(); setupWind(); setupDuty(); setupFlights(); setupMapLegend(); setupAirportPicker(); try { localStorage.removeItem('fb.feedback'); } catch (e) { /* 旧 FEEDBACK 欄の保存分を片付け */ }
    window.FBViewer.setup();
    $('airport-date').value = state.duty.date || todayJst();
    $('airport-date').onchange = renderAirport;
    document.querySelectorAll('#notam-mode .chip').forEach((b) => { b.onclick = () => { state.notamMode = b.dataset.mode; lsSet(LS.notamMode, state.notamMode); applyNotamMode(); }; });
    document.querySelectorAll('#notam-period .chip').forEach((b) => { b.onclick = () => { state.notamHours = Number(b.dataset.hours); lsSet(LS.notamH, state.notamHours); renderNotam(); }; });
    $('refresh-btn').onclick = () => refresh(false);
    $('pack-redownload').onclick = () => refresh(true);
    $('pack-clear').onclick = async () => { if (!confirm('保存済みパックを消去しますか？（オフラインで見られなくなります）')) return; await window.FBPack.clearAll(); state.pack = null; renderAll(); };
    window.addEventListener('online', () => { renderStatus(); renderCharts(); refresh(false); });
    window.addEventListener('offline', () => { renderStatus(); renderCharts(); });
    startClock();
    setupBrandLightbox();
    setInterval(() => { renderStatus(); }, 15000);
    document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible') renderClock(); });

    if ('serviceWorker' in navigator) {
      try { await navigator.serviceWorker.register('sw.js'); } catch (e) { console.warn('SW登録失敗', e); }
    }
    try { await navigator.storage?.persist?.(); } catch { /* ignore */ }

    if (window.FBRadarLive) {
      try { await window.FBRadarLive.start(); } catch (err) { console.warn(err); }
    }
    if (window.FBWxLive) {
      window.FBWxLive.start({ onUpdate() {
        try { renderStatus(); renderCharts(); renderMap(); renderDuty(); renderWind(); } catch (err) { console.warn(err); }
      } });
    }
    const packs = window.FBPack.list();
    if (packs.length) { state.packSource = 'cached'; await showPack(packs[0].packId); } else renderAll();
    refresh(false);
    document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible' && navigator.onLine) refresh(false); });
  }
  document.addEventListener('DOMContentLoaded', start);
  window.FBApp = { state, refresh, ensureAirports };
})();
