// Flight Buddy main
(function () {
  const APP_VERSION = '1.9.8';
  const REPO = 'falchawk/flight-buddy';
  const $ = (id) => document.getElementById(id);
  const esc = window.FBWx.esc;
  const LS = { airports: 'fb.airports', duty: 'fb.duty', tab: 'fb.tab', notamH: 'fb.notamHours', viewPack: 'fb.viewPack', chartSel: 'fb.chartSel', theme: 'fb.theme' };
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
    { const w = state.pack?.wxOverlay, wl = wxLastText(); if (w) src += ` ／ 気象はパック ${hhmmJ(w.generatedAt)} 分に更新済み`; if (wl) src += ` ／ ${wl}`; }
    $('status-text').textContent = `パック ${fmtJst(m.generatedAt)}（${fmtUtc(m.generatedAt)}）・ ${src}`;
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
      if (tab === 'map') setTimeout(() => { try { renderMap(); } catch (e) { console.warn(e); } }, 0);
    };
    btns.forEach((b) => b.addEventListener('click', () => go(b.dataset.tab)));
    let t0 = lsGet(LS.tab, 'map');
    if (t0 === 'charts') t0 = 'wx'; // 旧版（v1.2）のCHARTSタブは WX に統合
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
  const briefKindLabel = (b) => b?.kind === 'auto' ? '自動(08:30)' : b?.kind === 'manual' ? '手動' : '作成方法不明';
  function renderBrief() {
    const b = state.pack?.brief, m = state.pack?.manifest;
    if (!m) { $('brief-meta').textContent = ''; $('brief-body').innerHTML = '<p class="hint">まだパックがありません。オンラインで一度開くと自動で保存されます。</p>'; return; }
    $('brief-meta').innerHTML = `パック作成 ${esc(fmtJst(m.generatedAt))}（${esc(fmtUtc(m.generatedAt))}）${b?.ok && b?.writtenAt ? ` ／ 本文 ${esc(fmtJst(b.writtenAt))}（${esc(briefKindLabel(b))}）` : ''}${b?.ok && b?.author ? ` ／ ${esc(b.author)}` : ''}`;
    const wx = state.pack?.wx;
    const rows = mainAirports().map((icao) => {
      const e = wx?.airports?.[icao];
      if (!e || !e.ok) return `<tr><td>${esc(icao)}</td><td colspan="3" class="hint">${e ? '未取得' : esc(missText(icao))}</td></tr>`;
      const mt = e.metar?.[0];
      const cat = mt ? (window.FBWx.flightCategory(mt.raw, icao) || mt.fltCat) : null;
      const wind = (mt?.raw || '').match(/\b(\d{3}|VRB)(\d{2,3})(G\d{2,3})?KT\b/);
      const gusts = [...((e.taf?.raw || '').matchAll(/\b(?:\d{3}|VRB)\d{2,3}G(\d{2,3})KT\b/g))].map((m) => Number(m[1]));
      return `<tr><td><strong>${esc(icao)}</strong> <span class="hint">${esc(apName(icao))}</span></td><td>${cat ? `<span class="badge ${cat}">${cat}</span>` : ''}</td><td>${esc(wind ? wind[0] : '--')}</td><td>${gusts.length ? `G${Math.max(...gusts)}` : '--'}</td></tr>`;
    }).join('');
    const summary = `<div class="card"><div class="card-title"><span>選択空港サマリー</span><span class="hint">METAR / TAF最大ガスト</span></div><table class="sum-table"><tbody>${rows}</tbody></table></div>`;
    const carried = b?.ok && b.carriedOver ? `<p class="hint"><span class="badge stale">前回のブリーフ</span> 本文は ${esc(fmtJst(b.writtenAt))} 作成（${esc(ageText(b.writtenAt))}）。METAR/TAF・図は最新パックの内容です。</p>` : '';
    $('brief-body').innerHTML = summary + carried + `<div class="brief-text">${b?.ok && b.text ? mdToHtml(b.text) : '<p class="hint">いまのブリーフ本文はまだありません。毎日 08:30（JST）に自動で作られます。</p>'}</div>`;
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
    if (wx) list.insertAdjacentHTML('beforeend', `<p class="hint" style="margin:0 14px">取得 ${esc(fmtJst(wx.fetchedAt))} ／ 出所 ${esc(wx.source)}</p><div class="legend" style="margin:4px 14px">TAF：<span class="taf-token-becmg">BECMG</span> <span class="taf-token-tempo">TEMPO</span> <span class="taf-token-fm">FM</span> <span class="taf-token-prob">PROB30/40</span>（旧版と同じ色。ライトモードは見やすいよう同じ色相で濃いめ）。METAR の TEMPO/BECMG も同じ色。<span class="hl-ifr">赤</span>＝IFR/LIFR の要因（視程 5000m 未満・シーリング 1000ft 未満）。MVFR は強調しません。<br>飛行状態：IFR/VFR の境界は日本の航空法（施行規則第5条第4号）＝視程 5000m・雲高 300m(1000ft)。国土交通大臣が告示で指定した空港（管制圏内で 8km/450m。<b>告示空港: 8km/1500ft</b>）だけは 視程 8000m・雲高 1500ft(450m) が境界で、MVFR は 8000m〜5SM・1500〜3000ft（<b>現在、指定されている空港は 0 件</b>。AIP Japan ENR 1.2 で確認。指定されると各空港のカードに「告示空港: 8km/1500ft」と出ます）。日本に無い MVFR/LIFR は FAA 基準。VFR 視程 &gt;5SM かつ シーリング &gt;3000ft ／ MVFR 視程 5000m〜5SM または 1000〜3000ft ／ IFR 視程 &lt;5000m または &lt;1000ft ／ LIFR 視程 &lt;1SM または &lt;500ft。</div>`);
    for (const icao of mainAirports()) {
      const e = wx?.airports?.[icao];
      const card = document.createElement('div'); card.className = 'card';
      let body;
      if (!e) body = `<p class="hint"><span class="badge na">${packHas(icao) ? '未ダウンロード' : 'パック未収録'}</span> ${esc(missText(icao))}</p>`;
      else if (!e.ok) body = `<div class="sub-label">METAR</div>${naBox('METAR なし（aviationweather.gov にこの局の配信がありません）')}<div class="sub-label">TAF</div>${naBox('TAF なし（この局は TAF を出していないか配信がありません）')}`;
      else {
        const latest = e.metar?.[0];
        const cat = latest ? (window.FBWx.flightCategory(latest.raw, icao) || latest.fltCat) : null;
        body = `${e.carriedOver ? `<p class="hint"><span class="badge stale">STALE</span> 今回の取得に失敗したため前回の値です（${esc(fmtJst(e.fetchedAt))}取得）</p>` : (apProf(icao)?.foreign && e.fetchedAt ? `<p class="hint">METAR/TAF 取得 ${esc(fmtJst(e.fetchedAt))}（${esc(ageText(e.fetchedAt))}）・海外空港は1時間ごとに更新</p>` : '')}
          <div class="sub-label">METAR ${latest ? `${esc(fmtUtc(latest.obsTime))}（${esc(fmtJst(latest.obsTime, false))}）` : ''} ${cat ? `<span class="badge ${cat}">${cat}</span>` : ''} <span class="vmc-basis${window.FBWx.limitsFor(icao).strict ? ' strict' : ''}" title="${window.FBWx.limitsFor(icao).faa ? '飛行状態の判定基準（FAA：IFR は 3SM 未満または 1,000ft 未満）' : '飛行状態の IFR 境界（航空法施行規則第5条第4号）'}">${esc(window.FBWx.limitsFor(icao).text)}</span> <span class="doc-status ${latest ? 'ok' : 'fail'}">${esc(e.metarSource || 'NONE')}</span></div>
          ${latest ? `<div class="raw">${window.FBWx.highlight(latest.raw, icao)}</div>` : naBox('METAR 未取得')}
          ${srcNotes(e, 'metar')}
          ${e.metar?.length > 1 ? `<details><summary>過去のMETAR（${e.metar.length - 1}件）</summary>${e.metar.slice(1).map((x) => `<div class="raw" style="margin-top:4px">${window.FBWx.highlight(x.raw, icao)}</div>`).join('')}</details>` : ''}
          <div class="sub-label">TAF ${e.taf && e.taf.issueTime ? `発表 ${esc(fmtUtc(e.taf.issueTime))} ／ 有効 ${esc(fmtUtc(e.taf.validFrom))}〜${esc(fmtUtc(e.taf.validTo))}` : ''} <span class="doc-status ${e.taf ? 'ok' : 'fail'}">${esc(e.tafSource || 'NONE')}</span></div>
          ${e.taf ? `<div class="raw">${window.FBWx.tafLines(e.taf.raw, icao)}</div>` : naBox('TAF 未取得')}
          ${srcNotes(e, 'taf')}`;
      }
      const a = atis?.airports?.[icao];
      if (!e && state.pack?.manifest?.airportFiles && !loaded(icao)) { /* 未ダウンロード：ATIS 欄も出さない */ } else
      if (apProf(icao)?.foreign) body += `<div class="sub-label">ATIS</div>${naBox('海外空港の ATIS は対象外（国内 SWIM のみ）')}`; else
      body += `<div class="sub-label">ATIS ${a && atis.fetchedAt ? `<span class="hint">${esc(fmtJst(atis.fetchedAt))}取得</span>` : ''} <span class="doc-status ${a ? 'ok' : 'fail'}">${a ? 'SWIM' : '未取得'}</span></div>${a ? `<pre class="raw">${esc(a.text)}</pre>` : naBox(`未取得${atis?.reasons?.[icao] ? `（${atis.reasons[icao]}）` : (atis?.note ? `（${atis.note}）` : '')}`)}`;
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
      const e = wx[icao], mt = e?.metar?.[0];
      // 選んでいない空港は一覧（index.json）の飛行状態だけ（METAR 本文などは選んだ空港の分だけダウンロード）
      const cat = mt ? (window.FBWx.flightCategory(mt.raw, icao) || mt.fltCat) : (idx[icao]?.fltCat || null);
      list.push({ icao, lat, lon, cat, sel: sel.includes(icao), name: apName(icao), codes: apCodes(icao),
        popupHtml: () => {
          const n = state.pack?.notam?.airports?.[icao];
          const nn = n?.items?.length;
          return `<div class="pop-title"><b>${esc(apName(icao))}</b> <span class="codes">${esc(apCodes(icao))}</span> ${cat ? `<span class="badge ${cat}">${cat}</span>` : '<span class="badge na">METARなし</span>'}</div>
            ${!e && state.pack?.manifest?.airportFiles ? `<p class="hint">${sel.includes(icao) ? esc(missText(icao)) : 'この空港は選択していません。SETTINGS で選ぶと METAR/TAF・NOTAM などをこの端末にダウンロードします。'}</p>` : ''}
            ${mt ? `<div class="sub-label">METAR ${esc(fmtUtc(mt.obsTime))}</div><div class="raw">${window.FBWx.highlight(mt.raw, icao)}</div>` : ''}
            ${e?.taf ? `<div class="sub-label">TAF</div><div class="raw">${window.FBWx.tafLines(e.taf.raw, icao)}</div>` : ''}
            ${e ? `<div class="hint" style="margin-top:6px">${state.pack?.notam?.ok ? `NOTAM ${nn != null ? nn + '件' : '未収録'}` : 'NOTAM 未取得'}</div>` : ''}`;
        } });
    }
    window.FBMap.render(el, list);
    window.FBMap.invalidate();
    const shown = list.filter((x) => x.sel).length;
    $('map-meta').textContent = state.pack ? `空港 ${list.length}（選択 ${shown}）・ METAR ${fmtJst(state.pack.wx?.fetchedAt)}` : 'パックがありません。';
  }


  // ---------------------------------------------------------------- FLIGHTS（パックの時刻表から便名検索。通信しない）
  const fl = { carrier: lsGet('fb.flCarrier', 'ALL'), date: null };
  const apShort = (code) => { const p = state.pack?.airports?.airports?.[code]; const a = airportInfo(code); const nm = a?.name || state.pack?.flights?.airportNames?.[code] || p?.name || ''; const iata = a?.iata || p?.iata || (code.length === 3 ? code : ''); return { iata: iata || code, name: nm }; };
  const SRC_JA = { odpt: 'ODPT', 'ana-pdf': 'ANA公式PDF', 'official-pdf': '公式PDF', live: '公式サイト', official: '公式', toki: 'トキエア公式', board: '空港の発着案内', rararakt: 'rararakt' };
  function setupFlights() {
    fl.date = todayJst();
    $('fl-date').value = fl.date;
    $('fl-date').onchange = (e) => { fl.date = e.target.value || todayJst(); renderFlights(); };
    $('fl-search').oninput = () => renderFlights();
  }
  function renderFlights() {
    const d = state.pack?.flights, res = $('fl-results'), cbar = $('fl-carriers');
    if (!d || !d.rows) { res.innerHTML = '<p class="hint">パックに時刻表がありません（次回の自動更新で入ります）。</p>'; cbar.innerHTML = ''; $('fl-status').innerHTML = ''; return; }
    const have = (d.carriers || []).filter((c) => c.count > 0);
    cbar.innerHTML = '';
    cbar.appendChild(chip('ALL', fl.carrier === 'ALL', () => { fl.carrier = 'ALL'; lsSet('fb.flCarrier', 'ALL'); renderFlights(); }));
    have.forEach((c) => cbar.appendChild(chip(c.code, fl.carrier === c.iata2, () => { fl.carrier = c.iata2; lsSet('fb.flCarrier', c.iata2); renderFlights(); })));
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
    if (n?.source) { const p = document.createElement('p'); p.className = 'hint'; p.textContent = `出所：${n.source}${n.fetchedAt ? `（${fmtJst(n.fetchedAt)}取得・${ageText(n.fetchedAt)}）` : ''} ／ 6時間ごとに更新（00/06/12/18時 JST）`; list.appendChild(p); }
    if (navigator.onLine) { const p = document.createElement('p'); p.innerHTML = '<a href="https://top.swim.mlit.go.jp" target="_blank" rel="noopener">SWIM portal（公式）を開く ▶</a>'; list.appendChild(p); }
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
      $('duty-flight').value = ''; saveDuty(); renderDuty(); ensureAirports();
    };
    $('duty-add').onclick = add;
    $('duty-flight').onkeydown = (e) => { if (e.key === 'Enter') add(); };
    renderDuty();
  }
  function tafWindow(icao, date, hhmm, label) {
    const e = state.pack?.wx?.airports?.[icao];
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
    const ul = $('duty-list'); ul.innerHTML = '';
    if (!state.duty.flights.length) ul.innerHTML = '<li class="hint">便が登録されていません</li>';
    state.duty.flights.forEach((f, i) => {
      const li = document.createElement('li');
      li.innerHTML = `<span><strong>${esc(f)}</strong>${dutyLeg(f)}</span><button class="btn btn-danger">削除</button>`;
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
    renderStatus(); renderBrief(); renderMap(); renderCharts(); renderNotam(); renderAirport(); renderDuty(); renderFlights(); renderSwimStatus();
    setupAirportPicker.renderSel && setupAirportPicker.renderSel();
    renderPackInfo();
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
  const hhmmJ = (iso) => fmtJst(iso, false).replace(' JST', 'J');
  function wxLastText() {
    const l = window.FBPack.wxLast();
    return l ? `WX更新 ${hhmmJ(l.at)}（${l.status === 'updated' ? '気象のみ最新化' : '最新でした'}）` : '';
  }
  async function wxRefresh() {
    if (refreshing) return;
    const btn = $('wx-btn');
    if (!navigator.onLine) { toast('オフラインです。WXの更新はオンラインで行えます（保存済みの気象を表示中）', true); return; }
    if (!state.pack?.manifest) { toast('先に右上の「更新」でパックを保存してください', true); return; }
    refreshing = true; btn.classList.add('spinning'); $('refresh-btn').disabled = true; btn.disabled = true;
    try {
      const baseId = state.pack.manifest.packId;
      const r = await window.FBPack.wxRefresh(wantedAirports(), (t) => { state.downloading = t; renderStatus(); }, async () => { await showPack(baseId); });
      state.downloading = null;
      await showPack(baseId);
      const mb = r.bytes > 1048576 ? `${(r.bytes / 1048576).toFixed(1)}MB` : `${Math.round(r.bytes / 1024)}KB`;
      toast(r.status === 'same'
        ? `WX：すでに最新です（パック ${hhmmJ(r.generatedAt)} 作成。新しいデータはボットが約15分ごとに公開）`
        : `WX 更新 ${hhmmJ(new Date().toISOString())}：${r.airports}空港の METAR/TAF/ATIS＋WXの図（新しい画像 ${r.blobsNew}枚・${mb}）。パック ${hhmmJ(r.generatedAt)} 作成分`);
    } catch (e) {
      state.downloading = null;
      toast(`WXの更新に失敗：${navigator.onLine ? (e.name === 'AbortError' ? 'タイムアウト' : e.message) : 'オフライン'}（保存済みの気象を表示中）`, true);
    } finally {
      refreshing = false; btn.classList.remove('spinning'); btn.disabled = false; $('refresh-btn').disabled = false; renderStatus();
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
    window.FBMap && window.FBMap.refreshTheme();
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

  function setupFeedback() {
    const ta = $('feedback-text'); ta.value = lsGet('fb.feedback', '');
    const link = () => { $('feedback-send').href = `https://github.com/${REPO}/issues/new?labels=feedback&title=${encodeURIComponent('feedback: ' + (ta.value.split('\n')[0] || '').slice(0, 40))}&body=${encodeURIComponent(ta.value + '\n\n（Flight Buddy SETTINGS から送信）')}`; };
    ta.oninput = link; link();
    $('feedback-save').onclick = () => { lsSet('fb.feedback', ta.value); $('feedback-saved-msg').classList.remove('hidden'); setTimeout(() => $('feedback-saved-msg').classList.add('hidden'), 1500); };
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
    setupTheme(); setupTabs(); setupTas(); setupDuty(); setupFlights(); setupAirportPicker(); setupFeedback();
    window.FBViewer.setup();
    $('airport-date').value = state.duty.date || todayJst();
    $('airport-date').onchange = renderAirport;
    document.querySelectorAll('#notam-period .chip').forEach((b) => { b.onclick = () => { state.notamHours = Number(b.dataset.hours); lsSet(LS.notamH, state.notamHours); renderNotam(); }; });
    $('refresh-btn').onclick = () => refresh(false);
    $('wx-btn').onclick = wxRefresh;
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
  window.FBApp = { state, refresh, ensureAirports };
})();
