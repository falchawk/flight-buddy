// ============================================================================
// fetchers/swim.js
// -----------------------------------------------------------------------------
// SWIM（国交省 System-Wide Information Management）からは、これまで「ATIS情報
// リクエストサービス」だけを取得していましたが、2026-09-28のご指示により
// 「デジタルNOTAMリクエストサービス」（NOTAM）も接続しました。通常METAR・TAFは
// 引き続きSWIM側では取得しません（②AWC・③Ogimetにフォールバック。
// lib/metarPriority.js参照。MET-AIRからのMETAR/TAF取得＝旧fetchers/metair.jsは
// 全廃済み）。
//
// 【ブラウザで実地確認した本物のATIS API（推測なし）】
// ログイン後、以下のURLへPOSTするとXML相当の内容がJSONで返ってくることを
// 実際のアカウントで確認済み（RJTT・RJAAで本物のATIS本文を取得できた）。
//   POST https://web.swim.mlit.go.jp/f2atrq/web/FLV402/LGV062
//   body: {
//     msgHeader: { jnlInfo: { jnlRegistFlag: 0 }, tsusuInfo: {} },
//     ctrlInfo: {}, ctrlHeader: {},
//     searchConditionsDTO: { dispcnt: "1", locationList: ["RJTT", ...] }
//   }
//   応答: { error:false, ret: { errorInfoDTO:{result:"OK"},
//            atisInfoDTO: { locationList:[...], fltxDataInfList:[...] } } }
//   （locationListとfltxDataInfListは同じ並び順。取れなかった空港は
//     locationListに含まれない）
//
// このサービスが対応する空港は、実際の画面（空港選択トグル）で確認できた
// 以下の23空港のみです。それ以外の空港が設定されている場合は「この空港は
// SWIM ATISの対象外です」と表示し、推測でリクエストには含めません。
//
// 【ブラウザで実地確認した本物のNOTAM API（推測なし。2026-09-28）】
// 検索画面 https://web.swim.mlit.go.jp/f2dnrq/browse/FUV201（サービス番号
// S2019）を、ログイン済みセッション（ATISと共通。lib/swimSession.js）のまま
// 開き、実際にfetch/XHRを監視して確認した本物のPOST先・request/response：
//   POST https://web.swim.mlit.go.jp/f2dnrq/web/FUV201/USV001
//   body（ICAO1つにつき1回。下記の理由で複数ICAOをまとめない）:
//   {
//     msgHeader: { jnlInfo: { jnlRegistFlag: 0 }, tsusuInfo: {} },
//     ctrlInfo: {}, ctrlHeader: {},
//     nof: '', fir: '', location: '<ICAO>',
//     notamCode: '', series: '', notamNr: '', uuid: '',
//     scopeAerodrome: '0', scopeEnroute: '1', scopeWarning: '1',
//     lower: '', upper: '', keyword: '', keywordAndOr: '0',
//     displayValidAll: 0,
//     validDatetimeFromDate: '', validDatetimeFromTime: '',
//     validDatetimeToDate: '', validDatetimeToTime: '',
//     numberOfDisplay: 0, searchFlg: 0
//   }
//   応答: { error:false, ret: { result:'0', notamList: [ {
//     location, number, startDate:'YYYY/MM/DD HH:mm'（UTC。digitalNotam内の
//     AIXM（gml:beginPosition等）の実時刻と突き合わせて確認済み）, endDate,
//     contents（E)行のみの短い抜粋）, list（AFTN形式のNOTAM全文。Q)/A)/B)/C)/
//     D)/E)行を含む本物の原文。①原文はこちらを使う）, digitalNotam（AIXM XML
//     文字列。<event:issued>から発行時刻を取れる）, scopes, ... } ] } }
//
// 【実地確認で分かった、推測しなかったら気付けなかった2点】
// 1) scopeAerodrome/scopeEnroute/scopeWarningは「0＝選択（チェックあり）、
//    1＝除外（チェックなし）」という直感と逆の実装。検索画面で実際に
//    チェックボックスの状態とリクエスト内容を突き合わせて確認済み。
// 2) locationフィールドに複数ICAOをスペース区切りでまとめて渡しても正しく
//    絞り込まれない（RJTT単独=1件・RJAA単独=45件に対し、"RJTT RJAA"を1回で
//    投げると246件返り、内容も単純な合算と一致しなかった）。そのため、
//    必ず空港（ICAO）ごとに1回ずつPOSTする（下記fetchNotamForIcao）。
//
// 範囲は「①飛行場のみ」（今回のご指示どおり。エンルートは今は必須でない）。
// ②短い日本語要約は、誤訳リスクを避けるため今回は実装していません（原文の
// みを表示。「取れれば」という任意のご指示だったため、安全側に倒した）。
// ============================================================================

const { swimFetch } = require('./lib/swimSession');
const { classifyMetarText } = require('./lib/flightCategory');

// lib/swimSession.jsが投げるエラーのerr.code（またはこのファイル自身が
// 付けるcode）を、画面に短く出すための日本語ラベルに変換する
// （「サイレントにAWCへ落とすな。理由を見えるようにする」というご指示のため）。
const SWIM_REASON_LABELS = {
  ENV_MISSING: 'ID/PASSWORD未設定',
  LOGIN_PAGE_FETCH_FAILED: 'ログインページ取得失敗',
  LOGIN_FAILED: 'ログイン失敗',
  LOGIN_RESPONSE_UNREADABLE: 'ログイン応答エラー',
  NO_REDIRECT_URL: 'ログイン応答エラー',
  REDIRECT_FAILED: 'ログイン後の遷移失敗',
  FETCH_FAILED: '通信エラー',
  ATIS_HTTP_ERROR: 'ATIS取得失敗',
  ATIS_RESPONSE_ERROR: 'ATIS応答エラー',
  NOTAM_HTTP_ERROR: 'NOTAM取得失敗',
  NOTAM_RESPONSE_ERROR: 'NOTAM応答エラー',
  TIMEOUT: 'タイムアウト',
};
function shortSwimLabel(err) {
  return (err && err.code && SWIM_REASON_LABELS[err.code]) || '取得失敗';
}

const ATIS_SUPPORTED_ICAO = new Set([
  'RJCC', 'RJCH', 'RJSS', 'RJAA', 'RJTT', 'RJSN', 'RJGG', 'RJOO', 'RJBB', 'RJBE',
  'RJOA', 'RJOT', 'RJOM', 'RJOK', 'RJFF', 'RJFS', 'RJFU', 'RJFT', 'RJFO', 'RJFM',
  'RJFK', 'ROAH', 'ROIG',
]);

const ATIS_REQUEST_URL = 'https://web.swim.mlit.go.jp/f2atrq/web/FLV402/LGV062';

// SWIM NOTAM用の実在URL（上の説明コメント参照。2026-09-28に実地確認済み。
// 推測で別URLを増やさない）。
const NOTAM_REQUEST_URL = 'https://web.swim.mlit.go.jp/f2dnrq/web/FUV201/USV001';

function buildNotamRequestBody(icao) {
  return {
    msgHeader: { jnlInfo: { jnlRegistFlag: 0 }, tsusuInfo: {} },
    ctrlInfo: {},
    ctrlHeader: {},
    nof: '',
    fir: '',
    location: icao,
    notamCode: '',
    series: '',
    notamNr: '',
    uuid: '',
    // 実地確認済み：0=選択（含める）、1=除外。今回のご指示「範囲の初期は
    // 飛行場。エンルートは今は必須でない」により、飛行場のみ選択する。
    scopeAerodrome: '0',
    scopeEnroute: '1',
    scopeWarning: '1',
    lower: '',
    upper: '',
    keyword: '',
    keywordAndOr: '0',
    displayValidAll: 0,
    validDatetimeFromDate: '',
    validDatetimeFromTime: '',
    validDatetimeToDate: '',
    validDatetimeToTime: '',
    numberOfDisplay: 0,
    searchFlg: 0,
  };
}

// "YYYY/MM/DD HH:mm"（実地確認済み・UTC）をUTC epoch(ms)に変換する。
// 想定と違う形式なら（推測せず）nullを返す。
function parseSwimNotamUtc(str) {
  if (typeof str !== 'string') return null;
  const m = str.match(/^(\d{4})\/(\d{2})\/(\d{2})\s+(\d{2}):(\d{2})$/);
  if (!m) return null;
  const y = Number(m[1]);
  const mo = Number(m[2]);
  const d = Number(m[3]);
  const h = Number(m[4]);
  const mi = Number(m[5]);
  return Date.UTC(y, mo - 1, d, h, mi, 0, 0);
}

// digitalNotam（AIXM XML文字列）から<event:issued>...</event:issued>
// （ISO8601・UTC）を取り出す。無ければ（推測せず）nullを返す。
function extractIssuedEpoch(digitalNotamXml) {
  if (typeof digitalNotamXml !== 'string') return null;
  const m = digitalNotamXml.match(/<event:issued>([^<]+)<\/event:issued>/);
  if (!m) return null;
  const t = Date.parse(m[1]);
  return Number.isFinite(t) ? t : null;
}

// 空港（ICAO）ごとに1回POSTする（上のコメントのとおり、複数ICAOをlocationへ
// まとめて渡すと実地確認して正しく絞り込まれないことが分かったため、まとめない）。
async function fetchNotamForIcao(icao) {
  const res = await swimFetch(NOTAM_REQUEST_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(buildNotamRequestBody(icao)),
  });
  if (!res.ok) {
    const err = new Error(`HTTP ${res.status}`);
    err.code = 'NOTAM_HTTP_ERROR';
    err.httpStatus = res.status;
    throw err;
  }
  let json;
  try {
    json = await res.json();
  } catch (_err) {
    const err = new Error('NOTAM応答を読み取れませんでした。');
    err.code = 'NOTAM_RESPONSE_ERROR';
    err.httpStatus = res.status;
    throw err;
  }
  if (json.error || !json.ret || json.ret.result !== '0') {
    const err = new Error((json && json.errMsg) || 'NOTAM応答の形式が想定と異なります。');
    err.code = 'NOTAM_RESPONSE_ERROR';
    err.httpStatus = res.status;
    throw err;
  }
  const notamList = Array.isArray(json.ret.notamList) ? json.ret.notamList : [];
  return notamList.map((n) => ({
    id: n.number || n.uuid || (n.sequenceNo != null ? String(n.sequenceNo) : ''),
    icao: n.location || icao,
    text: n.list || n.contents || '',
    validFromEpoch: parseSwimNotamUtc(n.startDate),
    validToEpoch: parseSwimNotamUtc(n.endDate),
    issuedEpoch: extractIssuedEpoch(n.digitalNotam),
    scopes: n.scopes || null,
  }));
}

// 失敗理由を空港ごとに割り当てるための道具（atisByIcao側の
// unavailableAtisByIcaoと同じ考え方）。「SWIM NOTAM」というラベルを必ず
// 含めておく（画面側でそのまま出せるように。「失敗時はHTTPと『SWIM NOTAM』
// と理由」というご指示のため。HTTPを伴わない失敗＝環境変数未設定などは
// HTTPの記載を省く＝実際に通信していないのにHTTPを騙らない）。
function unavailableNotamByIcao(icaos, reason) {
  const out = {};
  for (const icao of icaos) out[icao] = reason;
  return out;
}

/**
 * SWIMからNOTAMを取得する（メイン空港のICAOごとに1回ずつ、実地確認済みの
 * f2dnrq/FUV201/USV001へPOST。ATISと同じswimFetch()がログインセッションを
 * 自動的に使い回す／必要なら再ログインするため、NOTAMのために別ログインを
 * 増やすことはない）。
 * 環境変数未設定・対象空港なしのときは通信を一切行わず、同期的に安全な結果を
 * 返す（routes/api.jsのbuildSwimFallback()がawait無しで呼ぶ経路があるための
 * 構造。fetchSwimDocuments()側の5箇所は必ずawaitして使う）。
 * @param {string[]} icaoCodes 対象空港のICAOコード一覧（メイン空港）
 * @returns {object|Promise<object>} { ok, items, note, notesByIcao, attempted }
 *   items は lib/notamMatch.js が期待する { id, icao, text, validFromEpoch,
 *   validToEpoch } を満たす（issuedEpoch・scopesは追加情報として付与）。
 */
function fetchNotamFromSwim(icaoCodes) {
  const requestedIcaos = Array.isArray(icaoCodes) ? [...new Set(icaoCodes.filter(Boolean))] : [];

  if (!process.env.SWIM_USER || !process.env.SWIM_PASS) {
    return {
      ok: false,
      items: [],
      note: 'SWIM NOTAM：環境変数 SWIM_USER / SWIM_PASS が未設定です。',
      notesByIcao: unavailableNotamByIcao(requestedIcaos, 'SWIM NOTAM：ID/PASSWORD未設定'),
      attempted: false,
    };
  }
  if (requestedIcaos.length === 0) {
    return {
      ok: false,
      items: [],
      note: 'メイン空港が設定されていません。',
      notesByIcao: {},
      attempted: false,
    };
  }

  return fetchNotamFromSwimAsync(requestedIcaos);
}

async function fetchNotamFromSwimAsync(requestedIcaos) {
  const items = [];
  const notesByIcao = {};
  console.log('[SWIM] NOTAM取得開始 対象空港:', requestedIcaos.join(','));

  await Promise.all(requestedIcaos.map(async (icao) => {
    try {
      const icaoItems = await fetchNotamForIcao(icao);
      items.push(...icaoItems);
      console.log(`[SWIM] NOTAM取得成功 ${icao}: ${icaoItems.length}件`);
    } catch (err) {
      const label = shortSwimLabel(err);
      const httpPart = err && err.httpStatus ? `HTTP ${err.httpStatus}` : 'HTTP不明';
      notesByIcao[icao] = `SWIM NOTAM：${httpPart}：${label}`;
      console.error(`[SWIM] NOTAM取得失敗 ${icao}:`, httpPart, label, '-', err && err.message);
    }
  }));

  const anyOk = requestedIcaos.some((icao) => !notesByIcao[icao]);
  return {
    ok: anyOk,
    items,
    note: anyOk ? null : 'SWIM NOTAM：どの空港のNOTAMも取得できませんでした。',
    notesByIcao,
    attempted: true,
  };
}

// ============================================================================
// 【ブラウザで実地確認した本物の空港プロファイルAPI（推測なし。2026-09-28）】
// 検索画面 https://web.swim.mlit.go.jp/f2appr/browse/flv800s001 のサイドバー
// （吹き出しアイコン／NOTAMアイコン）をクリックすると開く「空港詳細」
// ダイアログ（flv800s007-airport-detail）が使っている本物のPOST先・
// request/responseを、実際にログイン済みセッションで動かして確認しました。
//
// URLと送るフィールド名は、アプリ自身が配信している本物のJS
// （f2appr/main.js＝難読化されているが実際にブラウザへ送られてくる
// ソースそのもの。推測ではなく実際にfetchして読んだ）から読み取ったもの：
//   - Flv999RestApiService.getAirportDetail(t) が
//     POST <base>/FLV806/LGV220 を呼ぶ（base="web"。f2appr配下で解決される）
//   - 呼び出し元 Flv800s007AirportDetailComponent.getAirportDetail() が
//     FLV806001AirportDetailFlowInputData に
//     aerodrome・callerKind(=1)・notamExtractPeriodFrom/To をセットして送る
//     （NOTAM抽出期間サービス＝FLV807と同じnotamExtractPeriodServiceの値を
//     そのまま使い回している）
// その上で、実際にRJTTを選択し、NOTAM抽出期間（カレンダーアイコン）を
// 確定させてから吹き出しアイコンをクリックし、本物のダイアログが実データ
// （空港運用状況・使用滑走路・進入方式・運用時間・日の出日没・平均遅延・
// ATIS/METAR/TAF本文・NOTAM・飛行場警報）を表示することと、そのとき実際に
// 飛んだPOSTの応答が下記の形であることを確認しました（2026-09-28、RJTT）。
//
//   POST https://web.swim.mlit.go.jp/f2appr/web/FLV806/LGV220
//   body: {
//     aerodrome: '<ICAO>',
//     callerKind: 1,
//     notamExtractPeriodFrom: 'YYYY/MM/DD HH:mm:00',  // UTC。実地確認済み書式
//     notamExtractPeriodTo:   'YYYY/MM/DD HH:mm:00',
//   }
//   応答: { error:false, ret: { errorInfoDTO:{result:'OK'},
//     airportUsage: string[],              // 【空港運用状況】
//     runwayNoDep: string[], runwayNoLdg: string[],  // 【使用滑走路】
//     approach: string[],                  // 【進入方式】
//     serviceStartTime, serviceEndTime: 'HHmm',      // 【空港運用時間】
//     sunriseTime, sunsetTime: 'HHmm',               // 【日の出・日没】（UTC）
//     departureDelayTime, arrivalDelayTime: number,  // 【平均遅延時間】（分）
//     aerodromeWarningWrnData: string[],   // 【飛行場警報】
//     atisBodyData: string[], metarSpeciBodyData: string[], tafBodyData: string[],
//     notamResultList: [...]  // f2dnrqのNOTAMと同じ形。二重取得を避けるため、
//                              // ここでは使わず既存のfetchNotamFromSwimの結果を
//                              // そのまま流用する（ご指示どおり）。
//   } }
//
// 実地確認で得られた本物のサンプル（2026-09-28, RJTT）：
//   airportUsage: ["RWY 04/22 滑走路閉鎖","RWY 16R/34L 滑走路閉鎖"]
//   runwayNoDep: ["05"], runwayNoLdg: ["34R"], approach: ["ILS Y RWY34R"]
//   serviceStartTime:"0000" serviceEndTime:"2359"
//   sunriseTime:"2033" sunsetTime:"0830"（UTC）
//   departureDelayTime:18 arrivalDelayTime:17
//   metarSpeciBodyData:["RJTT  281400\nM     M 281400Z 33005KT 15KM -SHRA
//     FEW010CU BKN130AC 23/22\n      Q1010/A2985=\n"]
//   tafBodyData:["RJTT  281105\nTAF   281105Z 2812/2918 01006KT 8000 ...=\n"]
//
// 【空のとき】aerodromeWarningWrnData等が[]のときは「警報が現在無い」という
// 意味で、「未取得」（取得自体に失敗）とは区別する（ご指示どおり）。
// リクエスト自体が失敗した空港だけ、8項目すべてを「未取得」として扱う
// （routes/api.js・public/js/app.js側の表示ロジック）。
//
// METAR/TAFがこの画面から取れたときは、lib/metarPriority.jsの①SWIM枠へ
// そのまま渡す（既存のMETAR優先順位ロジックは変更しない。TAFにはこのターンで
// ①SWIM枠を新設した＝既存のAWC/Ogimetの動きは変えていない）。表示ラベルを
// 「SWIM」ではなく「SWIM 空港プロファイル」にするのは routes/api.js側
// （表示用の文字列を置き換えるだけ。lib/metarPriority.js内部の
// source==='SWIM'という比較ロジックはそのまま）。
// ============================================================================

const AIRPORT_DETAIL_URL = 'https://web.swim.mlit.go.jp/f2appr/web/FLV806/LGV220';

function pad2(n) {
  return String(n).padStart(2, '0');
}

// "YYYY/MM/DD HH:mm:00"（UTC。NOTAM抽出期間ダイアログの実地確認済み書式に
// ":00"を足したもの＝Flv800s007AirportDetailComponentのソースで確認済み）。
function formatSwimProfilePeriod(date) {
  return `${date.getUTCFullYear()}/${pad2(date.getUTCMonth() + 1)}/${pad2(date.getUTCDate())} ${pad2(date.getUTCHours())}:${pad2(date.getUTCMinutes())}:00`;
}

function buildAirportDetailRequestBody(icao, fromDate, toDate) {
  return {
    aerodrome: icao,
    callerKind: 1,
    notamExtractPeriodFrom: formatSwimProfilePeriod(fromDate),
    notamExtractPeriodTo: formatSwimProfilePeriod(toDate),
  };
}

// "HHmm" → "HH:mm"。4桁の数字以外は（推測せず）nullを返す。
function formatHHmm(str) {
  if (typeof str !== 'string' || !/^\d{4}$/.test(str)) return null;
  return `${str.slice(0, 2)}:${str.slice(2)}`;
}

// "HHmm"（UTC）→ "HH:mm"（JST = UTC+9）。sunriseTime/sunsetTime専用。
// 4桁の数字以外は（推測せず）nullを返す。
function formatHHmmUtcToJst(str) {
  if (typeof str !== 'string' || !/^\d{4}$/.test(str)) return null;
  const utcHour = parseInt(str.slice(0, 2), 10);
  const minute = str.slice(2);
  const jstHour = (utcHour + 9) % 24;
  return `${pad2(jstHour)}:${minute}`;
}

async function fetchAirportProfileForIcao(icao) {
  const now = new Date();
  const to = new Date(now.getTime() + 24 * 60 * 60 * 1000);
  const res = await swimFetch(AIRPORT_DETAIL_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(buildAirportDetailRequestBody(icao, now, to)),
  });
  if (!res.ok) {
    const err = new Error(`HTTP ${res.status}`);
    err.code = 'PROFILE_HTTP_ERROR';
    err.httpStatus = res.status;
    throw err;
  }
  let json;
  try {
    json = await res.json();
  } catch (_err) {
    const err = new Error('空港プロファイル応答を読み取れませんでした。');
    err.code = 'PROFILE_RESPONSE_ERROR';
    err.httpStatus = res.status;
    throw err;
  }
  if (json.error || !json.ret || !json.ret.errorInfoDTO || json.ret.errorInfoDTO.result !== 'OK') {
    const msg = (json.exception && json.exception.message) || '空港プロファイル応答の形式が想定と異なります。';
    const err = new Error(msg);
    err.code = 'PROFILE_RESPONSE_ERROR';
    err.httpStatus = res.status;
    throw err;
  }
  const r = json.ret;
  const operatingHours = (r.serviceStartTime && r.serviceEndTime)
    ? `${formatHHmm(r.serviceStartTime) || r.serviceStartTime}-${formatHHmm(r.serviceEndTime) || r.serviceEndTime}`
    : null;
  const runwaysInUse = [
    ...(Array.isArray(r.runwayNoLdg) ? r.runwayNoLdg.map((x) => `LDG RWY ${x}`) : []),
    ...(Array.isArray(r.runwayNoDep) ? r.runwayNoDep.map((x) => `DEP RWY ${x}`) : []),
  ];
  const metarText = Array.isArray(r.metarSpeciBodyData) && r.metarSpeciBodyData[0] ? r.metarSpeciBodyData[0] : null;
  const tafText = Array.isArray(r.tafBodyData) && r.tafBodyData[0] ? r.tafBodyData[0] : null;
  return {
    ok: true,
    operatingHours,
    runwaysInUse,
    approach: Array.isArray(r.approach) ? r.approach : [],
    sunrise: formatHHmmUtcToJst(r.sunriseTime),
    sunset: formatHHmmUtcToJst(r.sunsetTime),
    departureDelayMin: typeof r.departureDelayTime === 'number' ? r.departureDelayTime : null,
    arrivalDelayMin: typeof r.arrivalDelayTime === 'number' ? r.arrivalDelayTime : null,
    operationalStatus: Array.isArray(r.airportUsage) ? r.airportUsage : [],
    aerodromeWarning: Array.isArray(r.aerodromeWarningWrnData) ? r.aerodromeWarningWrnData : [],
    metarText,
    tafText,
  };
}

function unavailableAirportProfileByIcao(icaos, reason) {
  const out = {};
  for (const icao of icaos) out[icao] = { ok: false, reason };
  return out;
}

/**
 * SWIM空港プロファイル（FLV806/LGV220）から、メイン空港ごとの運用情報・
 * METAR/TAF本文を取得する。NOTAMはこの応答にも含まれるが、二重取得を
 * 避けるため取得せず、既存のfetchNotamFromSwim（f2dnrq）の結果を
 * routes/api.js側で空港ごとにグループ化して流用する（ご指示どおり）。
 * @param {string[]} icaoCodes 対象空港のICAOコード一覧（メイン空港）
 * @returns {Promise<{ok:boolean, byIcao:object, metarByIcao:object, tafByIcao:object, attempted:boolean}>}
 */
async function fetchAirportProfilesFromSwim(icaoCodes) {
  const requestedIcaos = Array.isArray(icaoCodes) ? [...new Set(icaoCodes.filter(Boolean))] : [];

  if (!process.env.SWIM_USER || !process.env.SWIM_PASS) {
    return {
      ok: false,
      byIcao: unavailableAirportProfileByIcao(requestedIcaos, 'SWIM 空港プロファイル：ID/PASSWORD未設定'),
      metarByIcao: {},
      tafByIcao: {},
      attempted: false,
    };
  }
  if (requestedIcaos.length === 0) {
    return { ok: false, byIcao: {}, metarByIcao: {}, tafByIcao: {}, attempted: false };
  }

  const byIcao = {};
  const metarByIcao = {};
  const tafByIcao = {};
  console.log('[SWIM] 空港プロファイル取得開始 対象空港:', requestedIcaos.join(','));

  await Promise.all(requestedIcaos.map(async (icao) => {
    try {
      const profile = await fetchAirportProfileForIcao(icao);
      byIcao[icao] = profile;
      if (profile.metarText) {
        metarByIcao[icao] = { text: profile.metarText, obsTimeMs: Date.now(), category: classifyMetarText(profile.metarText).category };
      }
      if (profile.tafText) {
        tafByIcao[icao] = { text: profile.tafText, category: null };
      }
      console.log(`[SWIM] 空港プロファイル取得成功 ${icao}`);
    } catch (err) {
      const label = shortSwimLabel(err);
      const httpPart = err && err.httpStatus ? `HTTP ${err.httpStatus}` : 'HTTP不明';
      byIcao[icao] = { ok: false, reason: `SWIM 空港プロファイル：${httpPart}：${label}` };
      console.error(`[SWIM] 空港プロファイル取得失敗 ${icao}:`, httpPart, label, '-', err && err.message);
    }
  }));

  const anyOk = requestedIcaos.some((icao) => byIcao[icao] && byIcao[icao].ok);
  return { ok: anyOk, byIcao, metarByIcao, tafByIcao, attempted: true };
}

// 2026-09-28のご指示により、ATISを「全空港1箱」ではなく「空港ごとに1行」で
// 出せるように、AIRPORT画面向けにICAOごとのATIS状態も返すようにした
// （既存の atis フィールド＝全空港まとめたテキストは、他に使っている箇所が
// 無いことを確認した上でそのまま残してある。互換性のため）。
// どの空港も個別データが無いとき（環境未設定・SWIM全体が失敗等）に、要求
// された空港すべてへ同じ理由を割り当てるための道具。
function unavailableAtisByIcao(icaos, reason) {
  const out = {};
  for (const icao of icaos) {
    out[icao] = { ok: false, text: null, reason };
  }
  return out;
}

/**
 * SWIMからATIS・NOTAMを取得する。
 * @param {string[]} icaoCodes 対象空港のICAOコード一覧（メイン空港）
 */
async function fetchSwimDocuments(icaoCodes) {
  const requestedIcaos = Array.isArray(icaoCodes) ? [...new Set(icaoCodes.filter(Boolean))] : [];
  const supportedIcaos = requestedIcaos.filter((icao) => ATIS_SUPPORTED_ICAO.has(icao));
  const unsupportedIcaos = requestedIcaos.filter((icao) => !ATIS_SUPPORTED_ICAO.has(icao));

  // 2026-10-07のご指示：ATIS・NOTAM・空港プロファイルは互いに独立したSWIMの
  // 別エンドポイントで、どちらかの結果を使って組み立てたりしていない
  // （ensureLoggedIn()は複数箇所から同時に呼ばれてもログイン処理が1回だけに
  // なるよう元から作られている＝lib/swimSession.js参照）。今まで「NOTAM・
  // 空港プロファイルを待ってからATISを取る」という順番待ちになっていたのを
  // やめ、3つとも最初から同時に投げる（取得先・取得内容・返す内容の形は
  // 一切変えていない。ATIS部分をfetchSwimAtisPart()に切り出しただけ）。
  const [notamResult, airportProfileResult, atisPart] = await Promise.all([
    fetchNotamFromSwim(requestedIcaos),
    fetchAirportProfilesFromSwim(requestedIcaos),
    fetchSwimAtisPart(requestedIcaos, supportedIcaos, unsupportedIcaos),
  ]);

  return {
    metar: atisPart.metar,
    taf: atisPart.taf,
    atis: atisPart.atis,
    atisByIcao: atisPart.atisByIcao,
    notam: notamResult,
    metarByIcao: airportProfileResult.metarByIcao,
    tafByIcao: airportProfileResult.tafByIcao,
    airportProfileByIcao: airportProfileResult.byIcao,
  };
}

/**
 * fetchSwimDocuments()の軽量版（2026-10-09のご指示：WX部分更新ボタンの
 * 所要時間短縮のため）。WX部分更新（POST /api/update-wx）はNOTAMを一切
 * 使わない（NOTAMタブはこのボタンの対象外）ため、NOTAM（fetchNotamFromSwim）
 * は呼ばずに、ATIS・空港プロファイル（METAR/TAF）の2つだけを同時に取りに
 * 行う。取得先・取得内容・判定ロジックはfetchSwimDocuments()と完全に同じ
 * （fetchAirportProfilesFromSwim・fetchSwimAtisPartをそのまま呼ぶだけで、
 * これらの関数自体は一切変更していない）。fetchSwimDocuments()自体も
 * 変更していない（全体更新/api/updateとNOTAMタブは従来どおりこちらを使う）。
 */
async function fetchSwimAtisAndProfile(icaoCodes) {
  const requestedIcaos = Array.isArray(icaoCodes) ? [...new Set(icaoCodes.filter(Boolean))] : [];
  const supportedIcaos = requestedIcaos.filter((icao) => ATIS_SUPPORTED_ICAO.has(icao));
  const unsupportedIcaos = requestedIcaos.filter((icao) => !ATIS_SUPPORTED_ICAO.has(icao));

  const [airportProfileResult, atisPart] = await Promise.all([
    fetchAirportProfilesFromSwim(requestedIcaos),
    fetchSwimAtisPart(requestedIcaos, supportedIcaos, unsupportedIcaos),
  ]);

  return {
    metar: atisPart.metar,
    taf: atisPart.taf,
    atis: atisPart.atis,
    atisByIcao: atisPart.atisByIcao,
    metarByIcao: airportProfileResult.metarByIcao,
    tafByIcao: airportProfileResult.tafByIcao,
    // ルート側（routes/api.jsの/update-wx）がSWIM METAR/TAFの失敗理由を
    // 空港ごとに詳しく出すために使う。fetchAirportProfilesFromSwim()が
    // もともと計算済みの値をそのまま返すだけで、通信は増えない。
    airportProfileByIcao: airportProfileResult.byIcao,
  };
}

// ATIS部分だけを切り出した関数（2026-10-07のご指示により、NOTAM・空港
// プロファイルと同時に投げられるようにするため）。内容はfetchSwimDocuments
// に元からあったATIS取得処理と完全に同じ（分岐・文言・判定は何も変えて
// いない。切り出しただけ）。
async function fetchSwimAtisPart(requestedIcaos, supportedIcaos, unsupportedIcaos) {
  if (!process.env.SWIM_USER || !process.env.SWIM_PASS) {
    return {
      metar: null, // 通常METARはSWIMでは取得しない（MET-AIR優先＋AWC）
      taf: null, // TAFもSWIMでは取得しない（MET-AIR優先＋AWC）
      atis: unavailable('SWIM未設定：環境変数 SWIM_USER / SWIM_PASS が未設定です。', 'ID/PASSWORD未設定'),
      atisByIcao: unavailableAtisByIcao(requestedIcaos, 'ID/PASSWORD未設定'),
    };
  }

  if (supportedIcaos.length === 0) {
    const note = unsupportedIcaos.length
      ? `設定中のメイン空港はSWIM ATISの対象外です（対象：${[...ATIS_SUPPORTED_ICAO].join('/')}）。`
      : 'メイン空港が設定されていません。';
    return {
      metar: null,
      taf: null,
      atis: unavailable(note),
      atisByIcao: unavailableAtisByIcao(requestedIcaos, unsupportedIcaos.length ? 'SWIM ATISの対象外空港です。' : 'メイン空港が設定されていません。'),
    };
  }

  try {
    console.log('[SWIM] ATIS取得開始 対象空港:', supportedIcaos.join(','));
    const res = await swimFetch(ATIS_REQUEST_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        msgHeader: { jnlInfo: { jnlRegistFlag: 0 }, tsusuInfo: {} },
        ctrlInfo: {},
        ctrlHeader: {},
        searchConditionsDTO: { dispcnt: '1', locationList: supportedIcaos },
      }),
    });

    if (!res.ok) {
      console.error('[SWIM] ATIS取得HTTPエラー:', res.status);
      const err = new Error(`HTTP ${res.status}`);
      err.code = 'ATIS_HTTP_ERROR';
      throw err;
    }
    const json = await res.json();
    if (json.error || !json.ret || !json.ret.atisInfoDTO) {
      console.error('[SWIM] ATIS応答の形式が想定と異なる:', json && json.errMsg);
      const err = new Error((json.errMsg && json.errMsg) || 'ATIS応答の形式が想定と異なります。');
      err.code = 'ATIS_RESPONSE_ERROR';
      throw err;
    }
    console.log('[SWIM] ATIS取得成功');

    const dto = json.ret.atisInfoDTO;
    const gotIcaos = Array.isArray(dto.locationList) ? dto.locationList : [];
    const texts = Array.isArray(dto.fltxDataInfList) ? dto.fltxDataInfList : [];
    const textByIcao = {};
    gotIcaos.forEach((icao, i) => {
      if (texts[i]) textByIcao[icao] = texts[i];
    });

    const blocks = [];
    const atisByIcao = {};
    for (const icao of supportedIcaos) {
      if (textByIcao[icao]) {
        blocks.push(textByIcao[icao]);
        atisByIcao[icao] = { ok: true, text: textByIcao[icao], reason: null };
      } else {
        blocks.push(`${icao}: 取得失敗（この時刻のATISが応答に含まれていません）`);
        atisByIcao[icao] = { ok: false, text: null, reason: '取得失敗（この時刻のATISが応答に含まれていません）' };
      }
    }
    for (const icao of unsupportedIcaos) {
      blocks.push(`${icao}: SWIM ATISの対象外空港です。`);
      atisByIcao[icao] = { ok: false, text: null, reason: 'SWIM ATISの対象外空港です。' };
    }

    const anyOk = supportedIcaos.some((icao) => Boolean(textByIcao[icao]));
    return {
      metar: null,
      taf: null,
      atis: {
        key: 'swim_atis',
        title: 'ATIS',
        sourceGroup: 'SWIM',
        ok: anyOk,
        kind: 'text',
        text: blocks.join('\n\n'),
        label: '通常',
        note: anyOk ? null : '取得失敗：どの空港のATISも取得できませんでした。',
        flightCategory: null,
      },
      atisByIcao,
    };
  } catch (err) {
    const label = shortSwimLabel(err);
    console.error('[SWIM] ATIS取得失敗:', label, '-', err.message);
    return {
      metar: null,
      taf: null,
      atis: unavailable(`${label}：${err.message}`, label),
      atisByIcao: unavailableAtisByIcao(requestedIcaos, label),
    };
  }
}

function unavailable(note, reason) {
  return {
    key: 'swim_atis',
    title: 'ATIS',
    sourceGroup: 'SWIM',
    ok: false,
    kind: 'text',
    text: null,
    label: '通常',
    note,
    reason: reason || null, // AIRPORT画面向けの短い失敗理由（無ければnull）
    flightCategory: null,
  };
}

// routes/api.js側の二重の安全弁（withHardTimeout）専用：fetchSwimDocuments()が
// 万一想定外に固まった・例外を投げた場合でも、同じ形の「空だが安全な」結果を
// 返せるようにする（ATIS・NOTAMともに「取得失敗」表示になるが、更新全体は
// 止めない）。ここでは対象ICAO一覧を受け取れない構造（withHardTimeoutが
// label文字列だけを渡す）ため、fetchNotamFromSwim()は呼ばずに、ATISと同じ
// その場限りの安全な結果をNOTAM分も直接組み立てる（偽のNOTAMを出さないため、
// 中身は必ず空のitems＋理由のnoteのみ）。
function buildSwimFallback(label) {
  const shortLabel = label || '取得失敗（想定外）';
  return {
    metar: null,
    taf: null,
    atis: unavailable(`${shortLabel}：SWIMの処理が想定より長くかかった、または想定外に失敗しました。`, shortLabel),
    notam: {
      ok: false,
      items: [],
      note: `SWIM NOTAM：${shortLabel}：SWIMの処理が想定より長くかかった、または想定外に失敗しました。`,
      notesByIcao: {},
      attempted: false,
    },
    metarByIcao: {},
    tafByIcao: {},
    airportProfileByIcao: {},
  };
}

// Flight Buddy: 部品ごとに取得間隔を変えるため（fetchers/swim/run.js）、内部関数も公開する（中身は wx-brief main のまま）。
module.exports = { fetchSwimDocuments, fetchSwimAtisAndProfile, buildSwimFallback, fetchNotamFromSwim, fetchAirportProfilesFromSwim, fetchSwimAtisPart, ATIS_SUPPORTED_ICAO };
