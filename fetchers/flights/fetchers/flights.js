// ============================================================================
// fetchers/flights.js
// -----------------------------------------------------------------------------
// 「今日の便」欄に入力した便名（例: SFJ70）から、出発地・到着地・定刻を
// 調べるためのファイルです。
//
// 用語メモ：
// ・IATA コード＝旅行サイトなどで見る2文字の会社コード（例: JAL=JL）
// ・ICAO/コールサイン用コード＝運航でよく使う3文字の会社コード（例: JAL=JAL、
//   スターフライヤー=SFJ）。仕様書の「SFJ70」はこちらの形。
// ・「74」でも「SFJ74」でもヒットする検索は、画面側（public/js/app.js）で
//   行っています（ここでは時刻表データを用意するだけ）。
//
// 【今の状態（SKY/JJP/ANA/JALのPDF・XML機械解析を追加した回）】
// ・公式サイトから実際に取得・解析しているのは次の9社：
//     - SFJ（スターフライヤー）……既存。HTML（2ページ）＋同梱の控え。
//     - IBX（IBEXエアラインズ）…公式サイトの時刻表ページ
//       （https://www.ibexair.co.jp/timetable/）は全路線・両シーズンの表が
//       1ページのHTMLに直接載っているため、そのまま解析する。
//     - SNJ（ソラシドエア）………公式サイトの時刻表インデックス
//       （https://www.solaseedair.jp/timetable/）には路線ごとのページ一覧が
//       JavaScriptで後から描き込まれる形になっており、サーバー側のfetch
//       （このアプリのように画面を描画しないやり方）では一覧を読み取れな
//       かった（実際にNode.jsから取得して確認済み）。そのため、SFJの
//       SFJ_ROUTESと同じやり方で、実在を確認済みの14路線をSOLASEED_ROUTES
//       として書き出しておき、各路線ページ（例: /timetable/miya-hane/。
//       このページ自体はサーバー側からの取得でも中身の表がそのまま読める）
//       のHTMLの表を解析する。機種（738＝ボーイング737-800）も取れるので
//       入れている。
//     - FDA（フジドリームエアラインズ）…公式サイトの時刻表一覧
//       （https://www.fujidream.co.jp/timetable/）はサーバー側からの取得
//       でも路線ページへのリンク一覧がそのままHTMLに載っているため、毎回
//       この一覧ページを取りに行って路線の一覧を作り、各路線ページ（例:
//       /timetable/timetable_nkm_fuk.html）のHTMLの表を解析する。
//     - ADO（AIRDO）…………公式サイトの時刻表ページ
//       （https://www.airdo.jp/plan/timetable/）には、路線・シーズンごとの
//       見出し（<h3 data-anc="...">に有効期間つき）とその直後に往路・復路
//       2つぶんの表がそのままHTMLに載っている（JavaScript実行前の生HTML
//       でも同じ内容が返ることをユーザーのMac上のブラウザから直接fetchして
//       確認済み）ため、そのまま解析する。
//       【今回の修正】ラベルの「⇒」が実際にはHTML実体参照`&rArr;`のまま
//       出力されており、それを普通の記号に戻していなかったため、方向判定が
//       常に失敗して便が0件になり、毎回rararakt.com行きになっていた不具合
//       を修正した（decodeAdoEntities参照）。本番で source が'live'に
//       なっていない主因はこれだった可能性が高い。
//     - SKY（スカイマーク）…………今回追加。公式サイトの時刻表ページ
//       （https://www.skymark.co.jp/ja/timetabeleandfares/）の生HTMLに
//       載っている更新履歴一覧から、今日の日付に合う季節の時刻表PDFへの
//       リンクを見つけ、PDFのテキスト（pdftotext -layout）を解析する
//       （PDFのリンクを直しただけでなく、表をJSONに落とすところまで実装。
//       fetchSkySchedule参照）。
//     - JJP（Jetstar Japan）………今回追加。公式サイトの案内ページ
//       （https://www.jetstar.com/jp/ja/help/flight-schedules）から現在の
//       季節の国内線PDFを見つけて同様にテキスト解析する（fetchJjpSchedule
//       参照）。
//   FDA・IBEX・AIRDO・SKY・JJPのように公式の一覧・時刻表ページを毎回
//   そのまま解析できる場合はそうしており、ソラシドのようにそれができない
//   場合だけ、実在を確認済みの一覧を書き出す（どの場合も、季節ごとの
//   ファイル名などを先読みで決め打ちすることはしていない＝推測URLは
//   使わない）。
// ・JAL・ANA……今回、公式サイトから機械可読なデータを取得する方法を新たに
//   見つけて追加した（fetchJalOfficialSchedule／fetchAnaOfficialSchedule
//   参照）。
//     - JAL：時刻表検索フォームが裏で使っている路線別XML
//       （https://www.jal.co.jp/dom/time/xml/{ご搭乗月}/{出発地}_{到着地}.xml）
//       を、実在を確認済みの主要36路線（JAL_ROUTES）ぶんだけ取得する
//       （JALの国内線は100路線以上あり、存在しない組み合わせへの総当たりは
//       JALのサーバーへの負荷が大きすぎるため、確認済みの主要路線に限定。
//       将来路線を追加する場合はJAL_ROUTESに追記する）。
//     - ANA：「国内線 PDF時刻表ダウンロード」の「全エリア」PDF（1ファイルに
//       全路線を含む）をテキスト解析する（fetchAnaOfficialSchedule参照。
//       埋め込みフォントの都合で漢字がUnicodeの康熙部首に化けている点は
//       `.normalize('NFKC')`＋個別置換で解決済み）。
//   どちらも1.ODPT（ODPT_TOKEN設定時のみ）→2.公式→3.rararakt（最終手段）
//   の順で試す（fetchJalOrAnaSchedule）。2026-09-26のご指示により、ODPTの
//   申請が通ったため、公式より先にODPTを試す順に変更した（ODPTが未設定・
//   エラー・0件のときは黙って2の公式に進む）。
// ・Peach（APJ）……公式の国内線時刻表PDFは実在し内容も見えるが、便名列
//   だけがPDF自身の埋め込みフォント（ToUnicode CMap）の不具合で文字化け
//   しており（例:"MM053"が別のUnicode文字の並びとして抽出される。pdf.jsで
//   実際に確認済み）、SKY・JJPと同じ方法では正しい便名を機械的に取り出せ
//   ない。poppler/pdftotextでもPDF自身のデータが原因のため同様に文字化け
//   する。誤った便名を出す方が「出さない」より危険なため、今回もPDFの
//   自動解析はしていない（同梱の控えも無いため、最終手段のrararaktのみ）。
//
// 【取得の優先順位】
// 会社ごとに、次の順で自動取得を試み、成功した時点でそれ以降は試さない
// （withRararaktFallback() / fetchJalOrAnaSchedule() にまとめてある）。
//   1. 公式サイト（HTML・XML・PDF）……SFJ・SNJ・FDA・IBEX・AIRDOはHTML、
//      JALは路線別XML、SKY・JJP・ANAはPDFのテキスト解析。
//   2. 同梱の控え（バンドルJSON）……現状はSFJのみ（data/sfj_timetable.json、
//      最後に成功した表とその時刻を保持）。1が失敗したときだけ使う。SKY・
//      JJP・ANA・APJ（Peach）には同梱の控えが無いため、1が失敗したら
//      そのまま3（APJのみ）または4（他社）に進む。
//   3. ODPT……JAL・ANAのみ。ただしこの2社に限っては、下のリストの1（公式）
//      より先に試す（ODPT_TOKEN設定時のみ。fetchJalOrAnaSchedule参照）。
//   4. rararakt.com（非公式・最終手段）……1〜3のいずれも無い、または全部
//      失敗したときだけ最後の手段として試す。常時の既定ソースにはしない。
// 画面（public/js/app.js）には、実際に使われたsourceに応じて「公式HTML／
// 公式PDF／バンドル／ODPT／非公式最終手段」の5分類のどれかを表示する
// （result.sourceが 'live'→公式HTML、'official-pdf'→公式PDF、
// 'bundled-json'→バンドル、'odpt'→ODPT、'rararakt'→非公式最終手段）。
// ・どの会社も、取得に失敗したときは呼び出し側（routes/api.js）が
//   「前回成功データ」を使う仕組みになっています（元からある仕組みで、
//   sourceが'live'または'official-pdf'のときだけ保存されるため、
//   rararakt.com利用時はここには保存されません＝非公式データを「公式の
//   前回成功分」と混同しません）。
//
// 【会社をまたぐ「同じ便名」の扱いについて】
// J-AIRはJAL便名（JL）で、ANA WINGSはANA便名（NH）で出ることが多いため、
// このアプリでは別会社としては分けず、それぞれJAL・ANAの欄の注記
// （operationNote）で説明するだけにしている（仕様どおり）。
//
// 【SFJの取得について（4回目の修正）】
// 実機（Render）でSFJのライブ取得が失敗し続けていたため、ユーザーのMac上の
// ブラウザ（Claudeのブラウザ機能）で公式サイトの生HTMLを直接確認したところ、
// URL自体（index_biz2.html／index_biz.html。どちらもJS不要の静的HTMLで、
// 発着時刻の表がそのままHTMLに載っている）は前回の修正から変わっておらず
// 正しかったのですが、解析側に次の2つの不具合があることが分かりました。
//   1. 見出し（例:「羽田空港（東京）&rarr; 北九州空港」）の矢印がHTMLの
//      実体参照（&rarr;・&hArr;）のまま出力されており、それを普通の
//      「→」の文字として復号していなかったため、「向き」の判定が常に
//      失敗し、便が1件も採用されていなかった。
//   2. 便名・出発時刻・到着時刻が表の中でtd/thごとに別々の行になって
//      おり（同じ1行の中に便名と時刻2つが同居する形ではなかった）、
//      それを前提にしていた「1行だけを見る」解析ロジックが、そもそも
//      このページの実際の構造と合っていなかった。
// このため、今回はIBEX・ソラシド・FDAと同じやり方（HTMLの行に平らに
// 崩さず、路線見出し(h3)とその直後の表(table)を直接HTMLの正規表現で
// 拾う方式）に作り直しました。矢印の実体参照は decodeSfjEntities() で
// 先に普通の記号へ戻し、路線の向きは見出しの前後どちらのテキストに
// どちらの空港名が入っているかで判定します（detectSfjDirectionFromHeading）。
// 取得の流れ自体（2ページ取得→ダメなら同梱の控え）は変えていません。
//   1. まず公式サイトの2ページに直接アクセスして取得を試みる。
//      index_biz2.html: https://www.starflyer.jp/sf_biz/timetable/index_biz2.html
//      index_biz.html : https://www.starflyer.jp/sf_biz/timetable/index_biz.html
//   2. どちらのページも取れない・解析できないときは、同梱の控え
//      （data/sfj_timetable.json。公式サイトを見て人が書き起こしたデータ）を
//      代わりに使う（fetchSfjSchedule → loadSfjBundledTimetable 参照）。
// 画面には、1で成功したときは「公式から取得」、2を使ったときは
// 「控え（最終成功/同梱）」と表示します（public/js/app.js 側）。
// data/sfj_timetable.json には、表に実際に載っている便番号だけを入れています
// （例えば北九州→羽田はSFJ70から始まりSFJ71は無い、といった欠番も含めて
// そのままにしてあります）。ページの構成が変わって新しい便が増減した場合は、
// このファイルも手動で更新が必要です。
//
// 「2026年10月25日～2027年3月27日」のように西暦つきで期間が書かれている
// 見出しがあれば、それを「そのページに載っている時刻表の有効期間」として
// 覚えておきます。2ページ（今の期間／次の期間）の両方に同じ「発着空港＋便名」
// が重複して載っていたら、今日の日付（JST）が入っている方を優先します
// （pickFlightsPreferToday。IBEX/ソラシド/FDAと共通のヘルパーをそのまま
// 使っています）。表が1つしか無い（重複していない）便は、その期間が今日と
// ずれていてもそのまま採用します。西暦が省略された「12月1日～2月28日は
// ◯◯に変更」のような一時的な注記は「有効期間」としては扱いません（誤判定を
// 避けるため、年が両方はっきり書かれているものだけを対象にしています）。
//
// 【正直な注意】
// この開発環境からは starflyer.jp / ibexair.co.jp / solaseedair.jp /
// fujidream.co.jp への通信がすべてブロックされていて、実際のページの生HTML
// 構造までは開発環境からは確認できません。SFJ・IBEX・ソラシド・FDAはいずれも
// ユーザーのMac上のブラウザ（Claudeのブラウザ機能）で実際に公式ページを開き、
// 生のHTML構造を直接確認したうえで解析ロジックを作っています（推測はして
// いません）。ただし将来サイトのHTML構造が変わった場合は、解析件数が0件に
// なり、失敗として扱われます（誤った時刻を出すよりは安全側）。
// 判定の目印として「SFJ70は北九州→羽田便」という、実際に確認できている事実を
// 使い、取得できたときに簡易チェック（食い違っていてもエラーにはせず、
// サーバーのログに警告を出すだけ）を行っています。
// もし実際に更新ボタンを押しても便が出てこない、または食い違いの警告が出る
// 場合は、下の parseSfjPage() のTODOコメントを見て、実際のページの
// HTMLを見ながら調整してください。
// ============================================================================

const fs = require('fs');
const path = require('path');
const { todayJstDateString } = require('../lib/jstDate');
const { fetchPdfBuffer } = require('../lib/pdfPreview');
const { extractPdfText } = require('../lib/pdfText');

// 会社の一覧。icao3 は便名検索で使う3文字コード（例: SFJ70 の "SFJ" 部分）。
// source は fetchAllAirlineSchedules() 内で「どの取得方法を使うか」を選ぶ
// ためのキー（実際の取得結果につくラベルである result.source とは別物。
// 後者は 'live'（公式HTML）／'official-pdf'（公式PDF）／'bundled-json'
// （同梱の控え）／'odpt'／'rararakt'（非公式・最終手段）の5種類で、
// 画面（public/js/app.js）にはこれをもとに「公式HTML／公式PDF／バンドル／
// ODPT／非公式最終手段」の5分類で表示する）。
const AIRLINES = [
  { code: 'JAL', icao3: 'JAL', iata2: 'JL', name: '日本航空 (JAL)', officialUrl: 'https://www.jal.co.jp/jp/ja/dom/route/time/', source: 'jal-official', operationNote: '一部便はJ-AIRが運航' },
  { code: 'ANA', icao3: 'ANA', iata2: 'NH', name: '全日空 (ANA)', officialUrl: 'https://www.ana.co.jp/ja/jp/guide/plan/airinfo/dom-timetable/', source: 'ana-official', operationNote: '一部便はANA WINGSが運航' },
  { code: 'SFJ', icao3: 'SFJ', iata2: '7G', name: 'スターフライヤー (SFJ)', officialUrl: 'https://www.starflyer.jp/sf_biz/timetable/index_biz.html', source: 'sfj-html' },
  { code: 'SNJ', icao3: 'SNJ', iata2: '6J', name: 'ソラシドエア', officialUrl: 'https://www.solaseedair.jp/timetable/', source: 'sna-html' },
  { code: 'ADO', icao3: 'ADO', iata2: 'HD', name: 'AIRDO', officialUrl: 'https://www.airdo.jp/plan/timetable/', source: 'ado-html' },
  { code: 'SKY', icao3: 'SKY', iata2: 'BC', name: 'スカイマーク', officialUrl: 'https://www.skymark.co.jp/ja/timetabeleandfares/', source: 'sky-pdf' },
  { code: 'FDA', icao3: 'FDA', iata2: 'JH', name: 'フジドリームエアラインズ (FDA)', officialUrl: 'https://www.fujidream.co.jp/timetable/', source: 'fda-html' },
  { code: 'IBX', icao3: 'IBX', iata2: 'FW', name: 'IBEX', officialUrl: 'https://www.ibexair.co.jp/timetable/', source: 'ibex-html' },
  { code: 'APJ', icao3: 'APJ', iata2: 'MM', name: 'Peach', officialUrl: 'https://www.flypeach.com/lm/st/routemap', source: 'rararakt' },
  { code: 'JJP', icao3: 'JJP', iata2: 'GK', name: 'Jetstar Japan', officialUrl: 'https://www.jetstar.com/jp/ja/help/flight-schedules', source: 'jjp-pdf' },
];

// ODPTの空港表記（"odpt.Airport:HND"のようなIATAコード付きの値）を、
// data/airports.jsonから作った既存のIATA_TO_ICAO（下のほうで定義）で
// ICAOコードに変換する。対応が無い空港はnull（推測で埋めない）。
const ODPT_AIRPORT_PREFIX = 'odpt.Airport:';
function odptAirportToIcao(value) {
  if (typeof value !== 'string' || !value) return null;
  const iata = value.startsWith(ODPT_AIRPORT_PREFIX) ? value.slice(ODPT_AIRPORT_PREFIX.length) : value;
  return IATA_TO_ICAO[iata] || null;
}

// odpt:flightScheduleObject[] の1要素（実際に1便ぶんの情報を持つのはここ。
// 2026-09-28のご指示により、便名等は外側のitemではなくこの入れ子の中に
// あることが実際のRenderログ（HTTP200・1000件）で確認された）の中の
// odpt:flightNumber（配列。例:["NH1851"]）または旧仕様odpt:flightNumbers
// （配列）のうち、この会社の便名として読み取れるものだけを対象にする。
// 他社分のコードシェア表記（例:UL3357）は無視する。
//
// 2026-09-28のご指示「NH123とANA123は同じ便。JL123とJAL123は同じ便」に
// より、接頭辞はIATA2レター（例:"NH"）だけでなく、この会社の自社コード
// （airline.code。例:"ANA"）で始まるものも同じ便として受け入れる
// （実際のODPTデータに、同じANAグループの便がIATA2レターの"NH"だけでなく
// "ANA"始まりの便名（例:"ANA4774"）でも入っていることが確認されたため。
// 以前はiata2だけを見ていたため、この形の便名が無言で除外されていた）。
function odptFlightNumberDigits(flightObj, airline) {
  const candidates = [];
  const fn = flightObj['odpt:flightNumber'];
  if (typeof fn === 'string') candidates.push(fn);
  if (Array.isArray(fn)) {
    for (const n of fn) if (typeof n === 'string') candidates.push(n);
  }
  if (Array.isArray(flightObj['odpt:flightNumbers'])) {
    for (const n of flightObj['odpt:flightNumbers']) if (typeof n === 'string') candidates.push(n);
  }
  // 同じ会社を指す接頭辞（IATA2レターと自社コードの両方）。重複は除く。
  const prefixes = [...new Set([airline.iata2, airline.code].filter(Boolean))];
  const escaped = prefixes.map((p) => p.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'));
  const re = new RegExp(`^(?:${escaped.join('|')})\\s*0*([0-9]{1,4})$`);
  for (const raw of candidates) {
    const m = raw.toUpperCase().trim().match(re);
    if (m) return m[1];
  }
  return null;
}

// "00:05"のようなHH:MM形式はそのまま読む。念のため、ISO日時
// （例:"2026-09-28T05:30:00+09:00"）で来た場合も"T"の直後のHH:MMだけを
// 取り出す（標準的なISO 8601の区切りを見るだけで、値を作文はしない）。
// どちらの形でもなければnull（推測で時刻を作らない）。
function odptTimeToHm(value) {
  if (typeof value !== 'string') return null;
  const direct = value.match(/^(\d{1,2}):(\d{2})/);
  if (direct) return normalizeTime(`${direct[1]}:${direct[2]}`);
  const iso = value.match(/T(\d{2}):(\d{2})/);
  if (iso) return normalizeTime(`${iso[1]}:${iso[2]}`);
  return null;
}

/**
 * ODPT（公共交通オープンデータセンター）からJAL/ANAの便情報取得を試みる。
 *
 * 2026-09-26のご指示により追加。トークンはRenderのEnvironmentのODPT_TOKEN
 * （Gitには書かない。このファイルのこの関数以外では一切参照しない。ログにも
 * 出力しない）。無ければ（または応答が読み取れない・0件のときも）呼び出し側
 * （fetchJalOrAnaSchedule）が②公式サイトの取得にそのまま進む。
 *
 * 【確認済みのエンドポイント】（ckan.odpt.orgの公式データセットページで
 * それぞれ実地確認済み。推測ではない）
 *   JAL: https://ckan.odpt.org/dataset/a_flightschedule-jal
 *   ANA: https://ckan.odpt.org/dataset/a_flightschedule-ana
 *   どちらも「odpt:operator=odpt.Operator:{JAL|ANA}」「acl:consumerKey=...」
 *   を付けて https://api.odpt.org/api/v4/odpt:FlightSchedule を叩く形。
 *
 * 【実データ構造（2026-09-28に再修正。実際のRenderログ＝HTTP200・応答
 * 1000件・「読み取れた便0件」をユーザーご自身が確認し、その中身も
 * 教えていただいた内容に基づく。推測ではない）】
 * 最上位の配列（list）の1要素（＝1つのitem。同じ区間・同じ会社の時刻表
 * 定義の単位）の直下に：
 *   odpt:operator             … 例:"odpt.Operator:ANA"
 *   odpt:originAirport        … 出発空港（例:"odpt.Airport:ITM"）
 *   odpt:destinationAirport   … 到着空港（例:"odpt.Airport:HND"）
 * が1組だけ入っており、その同じ区間で運航する便（複数の時刻・季節パターン）
 * が入れ子配列 odpt:flightScheduleObject[] の中にまとめられている。
 * 【重要】空港（odpt:originAirport／odpt:destinationAirport）はitem側に
 * しか無く、odpt:flightScheduleObjectの中の各要素には無い（以前はこれを
 * 誤って各要素の中から探していたため、常にnullになり「読み取れた便0件」に
 * なっていた＝今回の主因）。
 * odpt:flightScheduleObject[]の1要素＝1便ぶんの情報：
 *   odpt:flightNumber        … 配列（例:["NH1851"]）。コードシェア時は
 *                               複数要素。
 *   odpt:originTime          … 出発時刻
 *   odpt:destinationTime     … 到着時刻
 *   odpt:aircraftType        … 機種コード（例:"Q4A"）。無い便もある。
 *   odpt:isValidFrom / odpt:isValidTo … この時刻パターンの有効期間。
 * 旧フィールド名（odpt:flightNumbers／odpt:departureAirport／
 * odpt:arrivalAirport／odpt:scheduledDepartureTime等）は、実データでの
 * 呼び名が変わった場合の保険として、上記が読めなかったときだけ追加で試す
 * （読み取れなかった便は推測で埋めずその便だけ除外＝従来どおり）。
 *
 * 【1000件という応答件数について（2026-09-28、今回あらためて再確認。
 * 開発者サイト・ODPTのお知らせ・複数の技術記事を確認したが、結論は前回と
 * 変わらず）】
 * ODPTの公開API一般の仕様として、1回のリクエストで返る件数は最大1000件
 * までで、それを超えて取得するための公式なページング機能（offset・limit・
 * ページ番号等のパラメータ）は、開発者サイト・利用ガイドライン・関連する
 * 技術記事のいずれにも見当たらなかった（推測でoffset等のパラメータを
 * 追加することはしない）。そのため、1回の応答がちょうど1000件だった
 * 場合は「本当は1000件超あるが上限で切られている可能性がある」ことを
 * ログに警告として残すだけにとどめる（安全に確認できる対処法が無いため）。
 * なお今回の主因は1000件の上限そのものではなく、上記のとおり空港の
 * 読み取り位置の誤りだったため、この修正だけでも「読み取れた便0件」は
 * 解消する見込み（1000件の上限自体は別問題として残る）。
 *
 * 便名・出発地・到着地・出発時刻・到着時刻のどれか一つでも読み取れなかった
 * 便は、推測で埋めずにその便だけ除外する。同じ便名がodpt:flightScheduleObject
 * に複数回出てくることがある（曜日・季節ごとに別々の時刻表定義に分かれて
 * いるため）ので、便名が重複したものは最初に見つかったものだけを残す
 * （画面の便検索で同じ便が二重に出ないようにするため）。
 * 全便が除外されて0件になったときは「ODPTエラー・件数0・キー無し」の
 * どれとも同じ扱いとして②（公式）に進む（このご指示のとおり）。
 */
function odptLog(...args) { console.log('[ODPT]', ...args); }
function odptLogError(...args) { console.error('[ODPT]', ...args); }

async function fetchFromOdpt(airline) {
  const apiKey = process.env.ODPT_TOKEN;
  if (!apiKey) {
    odptLog(`${airline.code}: ODPT_TOKENが未設定のため②公式へ進みます。`);
    return { ok: false, flights: [], failReason: 'ODPT_TOKEN が未設定です（Renderの環境変数を確認してください）。公式時刻表を使います。' };
  }
  const url = `https://api.odpt.org/api/v4/odpt:FlightSchedule?odpt:operator=odpt.Operator:${encodeURIComponent(airline.code)}&acl:consumerKey=${encodeURIComponent(apiKey)}`;
  // トークンは絶対にログに出さない（エンドポイントだけ、値を***に置き換えて記録）。
  const safeUrl = url.replace(encodeURIComponent(apiKey), '***');
  odptLog(`${airline.code}: リクエスト先 ->`, safeUrl);
  try {
    // 2026-09-28のご指示によりHTTPステータスを必ずログに残す（成功・失敗を
    // 問わず）。fetchWithTimeoutAndStatus()はfetchWithTimeout()の姉妹版で、
    // 他の呼び出し元には一切影響しない。2026-10-07のご指示により、タイム
    // アウトでの強制中断はやめ、返事が返るまで待つ。
    const res = await fetchWithTimeoutAndStatus(url);
    odptLog(`${airline.code}: HTTPステータス=${res.status}`);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const text = res.text;
    let list;
    try {
      list = JSON.parse(text);
    } catch (_err) {
      throw new Error('ODPTの応答をJSONとして読み取れませんでした。');
    }
    if (!Array.isArray(list)) throw new Error('ODPTの応答が想定した配列形式ではありませんでした。');

    odptLog(`${airline.code}: 応答件数=${list.length}`);
    if (list.length === 1000) {
      odptLogError(`${airline.code}: 応答がちょうど1000件＝ODPT側の上限で切られている可能性があります（公式には超過分を取得するページング機能が見当たらないため、これ以上は取得できません）。`);
    }
    if (list.length) {
      odptLog(`${airline.code}: 1件目の実キー名 ->`, Object.keys(list[0]));
      odptLog(`${airline.code}: 1件目の内容 ->`, JSON.stringify(list[0]));
    }

    const allFlights = [];
    let itemsWithoutNested = 0;
    let itemsMissingAirport = 0;
    for (const item of list) {
      if (!item || typeof item !== 'object') continue;
      const nested = Array.isArray(item['odpt:flightScheduleObject']) ? item['odpt:flightScheduleObject'] : null;
      const flightObjs = nested && nested.length ? nested : [item]; // 入れ子が無いitemだけ、保険として自分自身も試す
      if (!nested || !nested.length) itemsWithoutNested++;
      // 2026-09-28のご指示（実際のRenderログでユーザーご自身が確認した実データ
      // 構造）：odpt:originAirport・odpt:destinationAirportは、各便
      // （flightObj＝odpt:flightScheduleObjectの中の1要素）の中ではなく、
      // 外側のitem側に1組だけ入っている（同じ区間の複数の便時刻を1つの
      // itemにまとめているため）。そのため空港はitem（外側）から読み、
      // flightObj（内側）からは読まない（以前はflightObj側を見ていたため
      // 常にnullになり「読み取れた便0件」になっていた＝今回の主因）。
      // 旧フィールド名（odpt:departureAirport／odpt:arrivalAirport）は
      // 保険として引き続き試す。
      const depIcao = odptAirportToIcao(item['odpt:originAirport'] || item['odpt:departureAirport']);
      const arrIcao = odptAirportToIcao(item['odpt:destinationAirport'] || item['odpt:arrivalAirport']);
      if (!depIcao || !arrIcao) itemsMissingAirport++;
      for (const flightObj of flightObjs) {
        if (!flightObj || typeof flightObj !== 'object') continue;
        const number = odptFlightNumberDigits(flightObj, airline);
        const depTime = odptTimeToHm(flightObj['odpt:originTime'] || flightObj['odpt:scheduledDepartureTime'] || flightObj['odpt:departureTime'] || flightObj['odpt:scheduledTime']);
        const arrTime = odptTimeToHm(flightObj['odpt:destinationTime'] || flightObj['odpt:scheduledArrivalTime'] || flightObj['odpt:arrivalTime']);
        if (!number || !depIcao || !arrIcao || !depTime || !arrTime) continue; // 読み取れない項目がある便は推測で埋めず除外
        // odpt:aircraftTypeも実データで確認済みのため、あれば入れる
        // （無ければ従来どおり空欄。推測で埋めない）。
        const aircraftType = typeof flightObj['odpt:aircraftType'] === 'string' ? flightObj['odpt:aircraftType'] : '';
        allFlights.push({ number, depIcao, depTime, arrIcao, arrTime, aircraftType });
      }
    }
    if (itemsWithoutNested) {
      odptLog(`${airline.code}: odpt:flightScheduleObjectが無いitemが${itemsWithoutNested}件ありました（item自体をそのまま便として試しました）。`);
    }
    if (itemsMissingAirport) {
      odptLog(`${airline.code}: odpt:originAirport/odpt:destinationAirportが読み取れないitemが${itemsMissingAirport}件ありました（該当itemの便はすべて除外）。`);
    }

    // 同じ便名が複数回出てくることがある（曜日・季節ごとに別々の時刻表定義に
    // 分かれているため）ので、最初に見つかったものだけを残す（画面の便検索で
    // 同じ便が二重に出ないようにするため。2026-09-28のご指示）。
    const byNumber = new Map();
    for (const f of allFlights) {
      if (!byNumber.has(f.number)) byNumber.set(f.number, f);
    }
    const flights = [...byNumber.values()];
    if (allFlights.length !== flights.length) {
      odptLog(`${airline.code}: 同じ便名の重複${allFlights.length - flights.length}件を除いて${flights.length}件にしました。`);
    }

    if (!flights.length) {
      odptLogError(`${airline.code}: 応答は${list.length}件あったが、読み取れた便情報が0件（フィールド名が想定と違う可能性）。②公式へ進みます。`);
      throw new Error('ODPTの応答から使える形の便情報が0件でした（フィールド名が想定と違う可能性があります）。');
    }
    odptLog(`${airline.code}: 読み取り成功 ${flights.length}件。`);
    return { ok: true, flights, failReason: null };
  } catch (err) {
    odptLogError(`${airline.code}: 取得失敗 ->`, err.message, '②公式へ進みます。');
    return { ok: false, flights: [], failReason: `取得失敗：${err.message}` };
  }
}


/**
 * 公式サイトのHTML時刻表からの取得を試みる（未対応の会社向けの、常に失敗する
 * 骨格）。現時点ではどの会社もこの関数を使っていない（ADO・SKY・APJ・JJPは
 * 下のrararakt.comによるtier-2フォールバックに移行済み）。将来、公式にも
 * rararakt.comにも無い新しい会社が追加された場合の安全な既定値として残して
 * いる。
 */
// ----------------------------------------------------------------------------
// FlyTeam（flyteam.jp）：ODPT・公式のどちらにも載っていない特定の1便だけを、
// 便名検索の「3番目」として個別に確認する取得元。
// -----------------------------------------------------------------------------
// 2026-09-26のご指示により追加。ODPT・公式（JAL XML／ANA PDF）はどちらも
// 「その航空会社の時刻表をまとめて1回で取得する」方式のため、まとめて取得
// した結果にたまたまその1便が含まれていないと（例：ANAウイングス運航便が
// ANA公式PDFの対象外、ODPTの応答にその番号が無い等）、探している便だけが
// 見つからなくなる。そこで、まとめて取得した時刻表のどこにも見つからな
// かった1便だけ、flyteam.jpの「便名ごとのページ」を個別に見に行く
// （実際に呼ぶのはroutes/api.jsのbuildTodayFlights。ここfetchers/flights.js
// 側は1便ぶんの取得ロジックだけを持つ）。
//
// 【確認済みのURL・HTML構造】（2026-09-26、実際のページをブラウザで開いて
// 実地確認済み。推測ではない）
//   https://flyteam.jp/flightnumber/NH774  （全日空 NH774便）
//   https://flyteam.jp/flightnumber/JL201  （日本航空 JL201便）
//   https://flyteam.jp/flightnumber/NH1087 （全日空 NH1087便・ANAウイングス
//     の他社運航便でも同じURL形式・同じ構造で確認済み）
// いずれも通常のGETで200・サーバー側で組み立て済みの生HTML（JavaScript
// 実行不要）としてテーブルが返ってくることを確認済み（fetch()で取得した
// 生レスポンスをその場で確認した）。
//   区間名は<meta name="description">に
//     「...は、{出発地}発{到着地}行きで運航されているフライトです。」
//   という決まった文で入っている（{出発地}/{到着地}は「東京(羽田)」等、
//   既存のANA_CITY_TO_ICAOと同じ表記のため、新しい対応表は作らずそのまま
//   流用する。対応が無い地名は推測で埋めずその便を除外する）。
//   時刻表本体は<table class="timetable mgntop10 w100p">の中の2行1組の
//   <tr>（1行目に出発・到着・所要時間・運航日・機種・有効期間、2行目は
//   座席クラスの内訳で不要）。出発・到着時刻には稀に
//   <abbr class="is-terminal" ...>(D)</abbr>のようなターミナル表記が
//   付くため、時刻の数字部分（先頭のHH:MM）だけを取り出す。
// ----------------------------------------------------------------------------

const FLYTEAM_ROW_RE = /<td rowspan="2" class="is-dep-time nowrap ">\s*([\d:]{3,5})[\s\S]*?<td rowspan="2" class="is-arr-time nowrap ">\s*([\d:]{3,5})[\s\S]*?<td rowspan="2" class="nowrap ">[^<]*<\/td>\s*<td class="nowrap ">([^<]*)<\/td>\s*<td class="nowrap ">[\s\S]*?<\/td>\s*<td class="nowrap ">\s*(?:<a[^>]*>([^<]*)<\/a>)?\s*<\/td>\s*<td class="">\s*([\d/-]*)\s*<\/td>/g;

// "2026/9/3-10/10"（同じ年内の月日省略あり）または"2026/10/11"（単日）を
// {start, end}のISO日付に変換する。想定と違う形式はnull（推測で埋めない＝
// 呼び出し側で「期間指定なし＝常に対象」として扱う）。
function flyteamParsePeriod(rangeText) {
  const m = String(rangeText || '').trim().match(/^(\d{4})\/(\d{1,2})\/(\d{1,2})(?:-(?:(\d{4})\/)?(\d{1,2})\/(\d{1,2}))?$/);
  if (!m) return null;
  const [, y1, mo1, d1, y2, mo2, d2] = m;
  const start = isoDateFromJp(y1, mo1, d1);
  if (!mo2) return { start, end: start };
  const end = isoDateFromJp(y2 || y1, mo2, d2);
  return { start, end };
}

const FLYTEAM_WEEKDAY_JA = ['日', '月', '火', '水', '木', '金', '土'];

// 有効期間（あれば）と運航曜日（「毎日」または「月・火・水・日」等）の
// どちらも満たすかどうか。運航日欄が読み取れない・空のときは「毎日」と
// 同じ扱いにする（安全側＝除外しすぎない）。
function flyteamMatchesToday(daysText, todayDateStr, period) {
  if (period && (todayDateStr < period.start || todayDateStr > period.end)) return false;
  const text = String(daysText || '').trim();
  if (text === '毎日' || !text) return true;
  const todayWeekday = FLYTEAM_WEEKDAY_JA[new Date(`${todayDateStr}T00:00:00+09:00`).getUTCDay()];
  return text.split('・').includes(todayWeekday);
}

function flyteamLog(...args) { console.log('[FlyTeam]', ...args); }
function flyteamLogError(...args) { console.error('[FlyTeam]', ...args); }

/**
 * 便名検索で1.ODPT・2.公式のどちらにもその1便が見つからなかったときだけ
 * 呼ばれる、3番目の取得元。airline.iata2 + 便名数字（例:"NH"+"774"）の
 * URLに直接アクセスする。
 * @param {object} airline AIRLINESの1要素（iata2を使う）
 * @param {string} numberDigits 便名の数字部分（例:"774"）
 */
async function fetchFromFlyTeam(airline, numberDigits) {
  const url = `https://flyteam.jp/flightnumber/${airline.iata2}${numberDigits}`;
  flyteamLog(`${airline.iata2}${numberDigits}: リクエスト先 ->`, url);
  try {
    const html = await fetchWithTimeout(url, 10000);

    const descMatch = html.match(/<meta name="description" content="([^"]*)"/);
    const routeMatch = descMatch && descMatch[1].match(/は、(.+?)発(.+?)行きで運航されている/);
    if (!routeMatch) throw new Error('区間名を読み取れませんでした（ページ構造が変わった可能性があります）');
    const depName = routeMatch[1].trim();
    const arrName = routeMatch[2].trim();
    const depIcao = ANA_CITY_TO_ICAO[depName] || null;
    const arrIcao = ANA_CITY_TO_ICAO[arrName] || null;
    if (!depIcao || !arrIcao) throw new Error(`区間（${depName} / ${arrName}）に対応するICAOコードが見つかりませんでした`);

    const today = todayJstDateString();
    const rows = [];
    let m;
    FLYTEAM_ROW_RE.lastIndex = 0;
    while ((m = FLYTEAM_ROW_RE.exec(html))) {
      const [, depTimeRaw, arrTimeRaw, daysText, aircraftType, rangeText] = m;
      rows.push({
        depTime: normalizeTime(depTimeRaw),
        arrTime: normalizeTime(arrTimeRaw),
        daysText,
        aircraftType: (aircraftType || '').trim(),
        period: flyteamParsePeriod(rangeText),
      });
    }
    if (!rows.length) throw new Error('時刻表テーブルを読み取れませんでした（ページ構造が変わった可能性があります）');

    const todayRows = rows.filter((r) => flyteamMatchesToday(r.daysText, today, r.period));
    const picked = (todayRows.length ? todayRows : rows)[0];
    flyteamLog(`${airline.iata2}${numberDigits}: ${rows.length}行中${todayRows.length}行が本日該当。採用: ${picked.depTime}->${picked.arrTime}`);

    return {
      ok: true,
      flights: [{ number: numberDigits, depIcao, depTime: picked.depTime, arrIcao, arrTime: picked.arrTime, aircraftType: picked.aircraftType }],
      source: 'flyteam',
      url, // 2026-09-28のご指示「失敗時はURLとHTTPを画面に」：成功時も含め常にURLを返す。
      failReason: null,
    };
  } catch (err) {
    flyteamLogError(`${airline.iata2}${numberDigits}: 取得失敗 ->`, err.message);
    // err.messageはfetchWithTimeout()がHTTPエラー時に'HTTP 404'のような形で
    // 投げているため、そのままfailReasonに含めればHTTPステータスも画面に出る。
    return { ok: false, flights: [], source: null, url, failReason: `FlyTeamの取得失敗：${err.message}` };
  }
}

/**
 * 5番目・最終手段：ODPT・公式・FlyTeam・rararaktのいずれにも見つからな
 * かったときのGoogle検索リンク。Google自体を自動解析（スクレイピング）
 * すると、構造変化やbot対策で簡単に壊れ、しかも「推測で埋めない」という
 * 方針とも相性が悪いため、機械的な解析はせず、Google検索へのリンクだけを
 * 返す（ユーザーご自身の目で確認していただく、という文字通りの最後の手段）。
 */
function googleFlightSearchUrl(flightNumberFull) {
  return `https://www.google.com/search?q=${encodeURIComponent(`${flightNumberFull} フライト 運航状況`)}`;
}

async function fetchFromHtml(airline, date) {
  return { ok: false, flights: [], failReason: '時刻表HTMLの自動解析は未対応です。' };
}

// ----------------------------------------------------------------------------
// AIRDO（ADO）・スカイマーク（SKY）・Peach（APJ）・Jetstar Japan（JJP）：
// 公式サイトから安全に自動取得できないため、依頼の仕様書で名指しされている
// tier-2の参考データ源 rararakt.com/flightnbr/ の一般公開ビュー（data.js）
// から取得する。
// -----------------------------------------------------------------------------
// 【正直な注意】この開発環境（Mac側のシェル・クラウド側のシェルのどちらも）
// からは rararakt.com への通信がブロックされていて、実際のdata.jsの生データ
// までは開発環境からは確認できない。ユーザーのMac上のブラウザ（Claudeの
// ブラウザ機能）で実際に https://rararakt.com/flightnbr/data.js を開き、
// 実データ（2026年夏ダイヤ、695件、ADO/SKY/APJ/JJPのコードもこのアプリの
// AIRLINES一覧と一致）を直接確認したうえで、その実データに対して下記の
// 解析ロジックの単体テストを行っている。ただし starflyer.jp 等の既存の公式
// サイト取得と同様、実機（Render）からこのサイトに実際に到達できるかどうか
// は、この場では検証できていない（到達できなければ、この4社は「取得失敗」
// として扱われ、ok:falseになるだけで、アプリ全体が落ちることはない）。
// ----------------------------------------------------------------------------

const RARARAKT_DATA_URL = 'https://rararakt.com/flightnbr/data.js';

/**
 * data.js（普通のJavaScriptのソース。全体としては変数キーがクオートされて
 * いない等、JSONとしては不正）の中から、`flights: [ ... ]` の部分文字列
 * だゑを、角括弧の対応を自分で数えることで安全に取り出す。文字列の中に
 * 出てくる [ ] はカウントしない（引用符の中かどうかを見ながら読み進める）。
 * third-partyのJSをeval/new Functionで実行することは一切しない。対応する
 * 閉じ括弧が見つからない（＝構造が想定と違う）ときは null を返す。
 */
function extractRararaktFlightsArray(js) {
  const markerIdx = js.indexOf('flights:');
  if (markerIdx === -1) return null;
  const start = js.indexOf('[', markerIdx);
  if (start === -1) return null;

  let depth = 0;
  let inString = false;
  let stringChar = null;
  let escaped = false;

  for (let i = start; i < js.length; i += 1) {
    const ch = js[i];
    if (inString) {
      if (escaped) escaped = false;
      else if (ch === '\\') escaped = true;
      else if (ch === stringChar) inString = false;
      continue;
    }
    if (ch === '"' || ch === "'") { inString = true; stringChar = ch; continue; }
    if (ch === '[') depth += 1;
    else if (ch === ']') {
      depth -= 1;
      if (depth === 0) return js.slice(start, i + 1);
    }
  }
  return null;
}

// rararakt.com上の日本語の地名（出発地・到着地）→ このアプリのICAOコード。
// data/airports.json と突き合わせて実在を確認できた地名だけを載せている。
//
// 【あえて含めていない地名（推測しない）】
// ・「茨城」＝茨城空港は、このアプリのdata/airports.jsonに空港データが
//   そもそも無いため、ICAOコードを決め打ちできない。
// ・「下地島」＝data/airports.jsonにある唯一の宮古島エリアの空港（ROMY）は、
//   名称自体が「宮古（下地島は含まない）」となっており、下地島空港とは
//   別物のため、ROMYに割り当てるのは誤り。
// ・ソウル／マニラ／上海／台北／香港／シンガポール／バンコク／高雄などの
//   国際線都市名も、このアプリの国内線データには無いため対象外。
const RARARAKT_CITY_TO_ICAO = {
  '羽田': 'RJTT', '成田': 'RJAA', '新千歳': 'RJCC', '函館': 'RJCH',
  '旭川': 'RJEC', '釧路': 'RJCK', '女満別': 'RJCM', '帯広': 'RJCB',
  '仙台': 'RJSS', '松山': 'RJOM', '熊本': 'RJFT', '石垣': 'ROIG',
  '神戸': 'RJBE', '福岡': 'RJFF', '那覇': 'ROAH', '長崎': 'RJFU',
  '関西': 'RJBB', '高松': 'RJOT', '高知': 'RJOK', '鹿児島': 'RJFK',
  '中部': 'RJGG', '大分': 'RJFO', '奄美': 'RJKA', '宮崎': 'RJFM',
};

const RARARAKT_TIME_RE = /^\d{1,2}:\d{2}$/;

/**
 * JSON.parse済みのflights配列（生の行の配列）から、指定した会社コード
 * （例: "ADO"）ぶんの便だけを取り出す。地名が未対応（国際線・茨城・下地島
 * 等、RARARAKT_CITY_TO_ICAOに無い）、または出発・到着どちらかの時刻が
 * 無い行（曜日限定便などでrararakt側にも時刻が載っていない）は、時刻や
 * 空港を推測で埋めたりせず、安全側で黙って除外する。
 */
function parseRararaktFlights(rawArray, icao3) {
  const flights = [];
  if (!Array.isArray(rawArray)) return flights;
  for (const row of rawArray) {
    if (!Array.isArray(row) || row.length < 8) continue;
    const [company, number, depCity, arrCity, , , depTimeRaw, arrTimeRaw] = row;
    if (company !== icao3) continue;

    const depIcao = RARARAKT_CITY_TO_ICAO[depCity];
    const arrIcao = RARARAKT_CITY_TO_ICAO[arrCity];
    if (!depIcao || !arrIcao) continue;

    if (!depTimeRaw || !arrTimeRaw) continue;
    if (!RARARAKT_TIME_RE.test(String(depTimeRaw)) || !RARARAKT_TIME_RE.test(String(arrTimeRaw))) continue;

    flights.push({
      number: String(number),
      depIcao, depTime: normalizeTime(depTimeRaw),
      arrIcao, arrTime: normalizeTime(arrTimeRaw),
      aircraftType: '', // rararakt側に機材の記載が無いため空欄
    });
  }
  return flights;
}

// data.js（全社共通の1ファイル）を取得し、flights配列（JSON.parse済み・
// 会社で絞り込む前の生の配列）を返す。2026-10-07のご指示により、1回の
// fetchAllAirlineSchedules()呼び出しの中で複数社が必要とした場合に、この
// 関数だけを複数回呼ばず済むよう、呼び出し側（fetchAllAirlineSchedules）で
// 結果を共有する（この関数自体は変更なし＝取得先・解析方法は同じ）。
async function fetchRararaktRawArray() {
  const js = await fetchWithTimeout(RARARAKT_DATA_URL, 12000);
  const arrayText = extractRararaktFlightsArray(js);
  if (!arrayText) throw new Error('flights配列が見つかりませんでした（ページ構造が変わった可能性があります）');
  try {
    return JSON.parse(arrayText);
  } catch (parseErr) {
    throw new Error(`flights配列の解析に失敗しました：${parseErr.message}`);
  }
}

// getRaraRaw：fetchAllAirlineSchedules()から渡される「共有のdata.js取得」
// 関数（省略時はこの関数が自分で1回だけ取得する＝routes/api.jsからの単独
// 呼び出し等、既存の使い方はそのまま）。
async function fetchRararaktSchedule(icao3, getRaraRaw) {
  try {
    const rawArray = await (getRaraRaw ? getRaraRaw() : fetchRararaktRawArray());
    const flights = parseRararaktFlights(rawArray, icao3);
    if (!flights.length) throw new Error('解析結果が0件（対象路線が無い、またはページ構造が変わった可能性があります）');

    return {
      ok: true,
      flights,
      source: 'rararakt',
      url: RARARAKT_DATA_URL,
      failReason: null,
      note: '非公式の参考データ（rararakt.com/flightnbr/）を使用中。時刻は変更される場合があります。',
    };
  } catch (err) {
    return { ok: false, flights: [], source: null, url: RARARAKT_DATA_URL, failReason: `参考データ（rararakt.com）の取得失敗：${err.message}` };
  }
}

/**
 * rararakt.comを「常時の既定ソース」ではなく「最終手段」として使うための
 * 共通ラッパー。
 * ・primaryResult（公式サイト／同梱バンドル／ODPTなど、この会社にとっての
 *   本来の取得手段の結果）がすでに成功（ok:true かつ1件以上）していれば、
 *   rararaktには一切問い合わせず、そのまま返す（常時rararakt禁止のため）。
 * ・primaryResultが失敗（またはok:trueでも0件）のときだけ、最後の手段として
 *   rararaktを試す。rararaktも失敗すれば、primaryResultの失敗理由（例えば
 *   「ODPT_TOKENが未設定」等）をそのまま返す（rararaktの失敗理由で
 *   上書きしない＝本来の原因が画面から分かるように）。
 * ・rararaktが成功したときは、画面（public/js/app.js）でひと目で分かる
 *   よう、note（表示文言）に「非公式・最終手段」であることと、なぜ
 *   最終手段を使うことになったか（primaryResultの失敗理由）の両方を入れる。
 */
async function withRararaktFallback(icao3, primaryResult, getRaraRaw) {
  if (primaryResult && primaryResult.ok && primaryResult.flights && primaryResult.flights.length) {
    return primaryResult;
  }

  let raraResult;
  try {
    raraResult = await fetchRararaktSchedule(icao3, getRaraRaw);
  } catch (err) {
    raraResult = { ok: false, flights: [], source: null, failReason: `参考データ（rararakt.com）の取得失敗：${err.message}` };
  }

  if (!raraResult.ok || !raraResult.flights.length) {
    // rararaktも失敗、または対象路線が無い → 本来の手段の失敗理由をそのまま返す。
    return primaryResult;
  }

  const reason = (primaryResult && primaryResult.failReason) ? `${primaryResult.failReason}のため使用` : '公式サイト・同梱データのいずれも利用できないため使用';
  return {
    ...raraResult,
    note: `${reason}。非公式のデータ（rararakt）です。時刻は変更される場合があります。`,
  };
}

// JAL・ANA専用の取得の流れ（1. 公式 → 2. ODPT → 3. rararakt）は、
// fetchJalOfficialSchedule／fetchAnaOfficialSchedule／fetchJalOrAnaSchedule
// （このファイルの上の方、SKY/JJP/ANA/JALの解析ロジックのすぐ後ろ）に移設
// 済み。

// ----------------------------------------------------------------------------
// 共通ヘルパー
// ----------------------------------------------------------------------------

// 2026-09-28のご指示「[ODPT]ログはトークン有無・HTTPステータス・件数のみ」
// に対応するための、fetchWithTimeout()の姉妹版。既存のfetchWithTimeout()は
// 成功時にHTTPステータスを捨ててしまう（本文だけ返す）ため、他の呼び出し元
// （多数）に影響しないよう、ODPT専用にステータスも返すバージョンを別に
// 用意した。ヘッダーの扱いはfetchWithTimeout()と同じ。
// 2026-10-07のご指示により、タイムアウトでの強制中断（AbortController）を
// やめた。ODPTの返事が返るまで待ち、「This operation was aborted」を
// ODPTには出さない。接続そのものが失敗した場合（DNS・切断等）はfetch()が
// 自然にエラーを投げるので、その場合だけ呼び出し元のcatchで②公式へ進む
// （この関数はODPT専用。他社が使うfetchWithTimeout()は変えていないため、
// ODPT以外の取得先・タイムアウトには一切影響しない）。
async function fetchWithTimeoutAndStatus(url) {
  const res = await fetch(url, {
    headers: {
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
      'Accept': 'application/json,text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
      'Accept-Language': 'ja,en-US;q=0.9,en;q=0.8',
    },
  });
  const text = await res.text();
  return { status: res.status, ok: res.ok, text };
}

async function fetchWithTimeout(url, timeoutMs) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, {
      signal: controller.signal,
      // Renderのサーバーから取得するため、普通のブラウザに近いヘッダーにしている
      // （ボットっぽいUser-Agentだと弾かれることがあるため）。
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,*/*;q=0.8',
        'Accept-Language': 'ja,en-US;q=0.9,en;q=0.8',
      },
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return await res.text();
  } finally {
    clearTimeout(timer);
  }
}

/**
 * 時刻表記を "H:mm" でも "HH:mm" に揃える（例: "7:40" → "07:40"）。
 * 全角コロン「：」が混ざっていても半角に直してから揃える。
 */
function normalizeTime(t) {
  const [h, m] = String(t).replace(/：/g, ':').split(':');
  return `${h.padStart(2, '0')}:${m}`;
}

function isoDateFromJp(y, m, d) {
  return `${y}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
}

/**
 * IBEX・ソラシド・FDAの解析で共通に使う「季節（有効期間）が複数ある時刻表で、
 * 今日の日付に合う方を優先する」処理。考え方はSFJのparseSfjTimetablePage内の
 * ロジックと同じ（コメント参照）。表が1つしか無い（重複していない）便は、
 * その期間が今日とずれていてもそのまま採用する。
 */
function pickFlightsPreferToday(rawFlights, todayDateStr) {
  const groups = new Map();
  for (const f of rawFlights) {
    const key = `${f.depIcao}-${f.arrIcao}-${f.number}`;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(f);
  }

  const isInPeriod = (f) => !f._period || (todayDateStr >= f._period.start && todayDateStr <= f._period.end);

  const flights = [];
  for (const group of groups.values()) {
    const inSeason = group.filter(isInPeriod);
    const picked = { ...(inSeason.length ? inSeason : group)[0] };
    delete picked._period;
    flights.push(picked);
  }
  return flights;
}

// data/airports.json（空港検索・地図表示用の一覧）をIATAコード→ICAOコードの
// 変換に流用する（Jetstar Japanの時刻表PDFがIATAコードで路線を表記して
// いるため）。新しい対応表は作らず、既存の一覧をそのまま使う。
const AIRPORTS_DATA = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'data', 'airports.json'), 'utf-8'));
const IATA_TO_ICAO = {};
for (const a of AIRPORTS_DATA.airports) IATA_TO_ICAO[a.iata] = a.icao;

// ----------------------------------------------------------------------------
// スカイマーク（SKY）・Jetstar Japan（JJP）・ANAで共通の「2列並び（往路・
// 復路）」PDF解析ロジック
// -----------------------------------------------------------------------------
// この3社の時刻表PDFはいずれも「1ページの中に、往路・復路2つの表を左右に
// 並べる」レイアウトで、`pdftotext -layout`はこの手のレイアウトを、1行の
// テキストの中に左右の位置関係を保ったまま出力する（実際のpoppler
// 22.02.0で、往路・復路2列の表を再現したテストPDFを使って、列が入れ替わら
// ないことを確認済み）。そのため、1行の中に現れる「見出しらしき文字列」や
// 「便名らしき文字列」を出現順（＝x座標の小さい順）に拾えば、1つ目が左の
// 列、2つ目が右の列だとみなせる。
// 見出しが2つとも見つかった行では、その2つのマッチ位置（index）の中間点を
// 「列の境目」として覚えておき、以後の便の行はその境目より左か右かで
// 振り分ける（見出しの片方だけ路線名が判定できない＝連絡便などで除外され、
// 見出しが1つしか無いように見える行があっても、境目の位置そのものは
// 前の見出し行のものをそのまま使い続けるため、ずれない）。
// ----------------------------------------------------------------------------
function parseTwoColumnPdfTimetable(text, headingRe, rowRe, resolveHeading, resolveRow) {
  const flights = [];
  let leftDir = null;
  let rightDir = null;
  let dividerIndex = null;

  const lines = text.split('\n');
  for (const line of lines) {
    const headingMatches = [...line.matchAll(headingRe)];
    if (headingMatches.length) {
      leftDir = resolveHeading(headingMatches[0]);
      if (headingMatches.length > 1) {
        rightDir = resolveHeading(headingMatches[1]);
        dividerIndex = (headingMatches[0].index + headingMatches[1].index) / 2;
      } else {
        rightDir = null;
        dividerIndex = null;
      }
      continue;
    }

    const rowMatches = [...line.matchAll(rowRe)];
    if (!rowMatches.length) continue;

    rowMatches.forEach((rm, i) => {
      let direction;
      if (rowMatches.length > 1) {
        direction = i === 0 ? leftDir : rightDir;
      } else if (dividerIndex !== null) {
        direction = rm.index < dividerIndex ? leftDir : rightDir;
      } else {
        direction = leftDir || rightDir;
      }
      if (!direction) return; // 未対応の地名・連絡便等で方向が分からない列は除外

      const parsed = resolveRow(rm);
      if (!parsed) return;
      flights.push({
        number: parsed.number,
        depIcao: direction.dep, depTime: normalizeTime(parsed.depTime),
        arrIcao: direction.arr, arrTime: normalizeTime(parsed.arrTime),
        aircraftType: '', // PDFに機材の記載が無いため空欄
      });
    });
  }

  return flights;
}

// ----------------------------------------------------------------------------
// スカイマーク（SKY）：公式サイトの時刻表ページから、現在有効な時刻表PDFへの
// リンクを見つけて、PDFのテキストから便名・時刻を機械的に読み取る
// -----------------------------------------------------------------------------
// https://www.skymark.co.jp/ja/timetabeleandfares/ の生HTML（JS不要。ユーザー
// のMac上のブラウザでraw fetch()して確認済み）には、更新履歴の一覧の中に、
// 時刻表PDFへのリンクと、その有効期間が文字どおり書かれている（例:
// 「【時刻表】2026年度夏ダイヤ(2026年6月1日～2026年10月24日)」）。ファイル名
// の季節パターン（timetable_2026summerUpdate.pdf等）を先読みで決め打ちせず、
// 毎回この一覧から今日の日付に合う期間のPDFを選ぶ。
//
// PDFは「便名／出発／到着」を2列（往路・復路）に並べた表で、便名（例:
// SKY703）はpdf.jsで実際のPDFを開いて文字化けせずに読み取れることを確認済み
// （Peachのような埋め込みフォントの不具合は無い）。
// 神戸乗継等の連絡便は、見出しに「[◯◯乗継]」（半角・全角の[ ]が混在）が
// 含まれる形で出てくる（例:「羽田→長崎 [神戸乗継]」）。この見出しの
// 出発地→到着地は実際の直行区間ではない（羽田→長崎/SKY○○○/という、最初の
// 区間だけの便名が載っている）ため、見出しに「[」「［」が含まれる路線は
// 丸ごと除外する（resolveHeadingでnullを返す）。
// 「茨城」「宮古(下地島)」は、既存のRARARAKT_CITY_TO_ICAOと同じ理由
// （茨城はdata/airports.jsonに空港データが無い。宮古(下地島)はdata/
// airports.jsonの宮古＝ROMYが「下地島は含まない」空港で別物）で
// SKY_CITY_TO_ICAOにも含めていない（該当路線は黙って除外される＝推測で
// 埋めない）。
// ----------------------------------------------------------------------------

const SKY_TIMETABLE_INDEX_URL = 'https://www.skymark.co.jp/ja/timetabeleandfares/';

const SKY_CITY_TO_ICAO = {
  '羽田': 'RJTT', '札幌(新千歳)': 'RJCC', '神戸': 'RJBE', '福岡': 'RJFF',
  '那覇': 'ROAH', '鹿児島': 'RJFK', '名古屋(中部)': 'RJGG', '仙台': 'RJSS',
  '長崎': 'RJFU', '奄美大島': 'RJKA',
};

function pickSkyTimetablePdfUrl(indexHtml, todayDateStr) {
  const blockRe = /href="([^"]+\.pdf)"[^>]*>\s*<span>【時刻表】[^(（]*[(（](\d{4})年(\d{1,2})月(\d{1,2})日[～〜](\d{4})年(\d{1,2})月(\d{1,2})日[)）]/g;
  const candidates = [...indexHtml.matchAll(blockRe)].map((m) => ({
    url: m[1],
    period: { start: isoDateFromJp(m[2], m[3], m[4]), end: isoDateFromJp(m[5], m[6], m[7]) },
  }));
  if (!candidates.length) return null;
  const current = candidates.find((c) => todayDateStr >= c.period.start && todayDateStr <= c.period.end);
  return (current || candidates[0]).url;
}

async function fetchSkySchedule() {
  try {
    const indexHtml = await fetchWithTimeout(SKY_TIMETABLE_INDEX_URL, 12000);
    const today = todayJstDateString();
    const pdfUrl = pickSkyTimetablePdfUrl(indexHtml, today);
    if (!pdfUrl) throw new Error('時刻表PDFへのリンクを読み取れませんでした（ページ構造が変わった可能性があります）');

    const pdfBuffer = await fetchPdfBuffer(pdfUrl, 20000);
    if (!pdfBuffer) throw new Error(`PDFを取得できませんでした（${pdfUrl}）`);

    const text = await extractPdfText(pdfBuffer, 30000);
    const headingRe = /(\S+?)→(\S+(?:\s*[\[［][^\]］]*[\]／）])?)/g;
    const rowRe = /(SKY\d{2,4})\s+(\d{1,2}:\d{2})\s+(\d{1,2}:\d{2})/g;

    const resolveHeading = (m) => {
      const dep = m[1];
      const arr = m[2];
      if (/[\[［]/.test(dep) || /[\[［]/.test(arr)) return null; // 連絡便の見出しは除外
      const depIcao = SKY_CITY_TO_ICAO[dep];
      const arrIcao = SKY_CITY_TO_ICAO[arr];
      if (!depIcao || !arrIcao) return null; // 未対応の地名（茨城・宮古(下地島)等）は除外
      return { dep: depIcao, arr: arrIcao };
    };
    const resolveRow = (m) => ({ number: m[1], depTime: m[2], arrTime: m[3] });

    const flights = parseTwoColumnPdfTimetable(text, headingRe, rowRe, resolveHeading, resolveRow);
    if (!flights.length) throw new Error('解析結果が0件（PDFの構成が変わった可能性があります）');
    return { ok: true, flights, source: 'official-pdf', failReason: null };
  } catch (err) {
    return { ok: false, flights: [], source: null, failReason: `スカイマーク公式PDFの取得失敗：${err.message}` };
  }
}

// ----------------------------------------------------------------------------
// Jetstar Japan（JJP）：公式サイトの案内ページから、現在の季節の国内線PDFを
// 見つけて、PDFのテキストから便名・時刻を機械的に読み取る
// -----------------------------------------------------------------------------
// https://www.jetstar.com/jp/ja/help/flight-schedules の生HTML（JS不要。
// ユーザーのMac上のブラウザでraw fetch()して確認済み）に、国内線PDF
// （例: https://files.jetstar.com/api/public/content/gk_timetable_26nsdom）
// へのリンクと、その有効期間（例:「2026年3月29日～2026年10月24日」）が
// そのまま載っている。ファイル名の季節コード（26nsdom等）を先読みで
// 決め打ちせず、毎回この一覧から今日の日付に合うファイルを選ぶ。
//
// PDFは「便名／出発／到着／注釈」を2列（往路・復路）に並べた表で、路線
// 見出しは「東京／成田（NRT） ✈✈✈ 大阪／関西（KIX）」のようにIATAコードが
// 括弧書きで入っているため、地名の対応表を新たに作らず、既存のdata/
// airports.jsonから作ったIATA_TO_ICAOでICAOコードに変換する。便名（例:
// GK217）はpdf.jsで実際のPDFを開いて文字化けせずに読み取れることを確認済み
// （Peachのような埋め込みフォントの不具合は無い）。
// ----------------------------------------------------------------------------

const JJP_HELP_URL = 'https://www.jetstar.com/jp/ja/help/flight-schedules';

function pickJjpDomesticPdfUrl(pageHtml, todayDateStr) {
  const blockRe = /href="(https:\/\/files\.jetstar\.com\/api\/public\/content\/gk_timetable_[a-z0-9]+dom)">(\d{4})年(\d{1,2})月(\d{1,2})日[～〜](\d{4})年(\d{1,2})月(\d{1,2})日<\/a>/g;
  const candidates = [...pageHtml.matchAll(blockRe)].map((m) => ({
    url: m[1],
    period: { start: isoDateFromJp(m[2], m[3], m[4]), end: isoDateFromJp(m[5], m[6], m[7]) },
  }));
  if (!candidates.length) return null;
  const current = candidates.find((c) => todayDateStr >= c.period.start && todayDateStr <= c.period.end);
  return (current || candidates[0]).url;
}

async function fetchJjpSchedule() {
  try {
    const pageHtml = await fetchWithTimeout(JJP_HELP_URL, 12000);
    const today = todayJstDateString();
    const pdfUrl = pickJjpDomesticPdfUrl(pageHtml, today);
    if (!pdfUrl) throw new Error('国内線時刻表PDFへのリンクを読み取れませんでした（ページ構造が変わった可能性があります）');

    const pdfBuffer = await fetchPdfBuffer(pdfUrl, 20000);
    if (!pdfBuffer) throw new Error(`PDFを取得できませんでした（${pdfUrl}）`);

    const text = await extractPdfText(pdfBuffer, 30000);
    const headingRe = /（([A-Z]{3})）\s*✈+\s*[^（]*（([A-Z]{3})）/g;
    const rowRe = /GK(\d{2,4})\s+(\d{1,2}:\d{2})\s+(\d{1,2}:\d{2})/g;

    const resolveHeading = (m) => {
      const depIcao = IATA_TO_ICAO[m[1]];
      const arrIcao = IATA_TO_ICAO[m[2]];
      if (!depIcao || !arrIcao) return null; // data/airports.jsonに無い空港は除外
      return { dep: depIcao, arr: arrIcao };
    };
    const resolveRow = (m) => ({ number: m[1], depTime: m[2], arrTime: m[3] });

    const flights = parseTwoColumnPdfTimetable(text, headingRe, rowRe, resolveHeading, resolveRow);
    if (!flights.length) throw new Error('解析結果が0件（PDFの構成が変わった可能性があります）');
    return { ok: true, flights, source: 'official-pdf', failReason: null };
  } catch (err) {
    return { ok: false, flights: [], source: null, failReason: `Jetstar Japan公式PDFの取得失敗：${err.message}` };
  }
}

// ----------------------------------------------------------------------------
// 全日空（ANA）：公式サイトの「国内線 PDF時刻表ダウンロード」から、現在の
// 季節の「全エリア」PDF（1ファイルに全路線がまとまっている）を取得して
// テキストを機械的に読み取る
// -----------------------------------------------------------------------------
// https://www.ana.co.jp/ja/jp/guide/plan/airinfo/dom-timetable/ の生HTML
// （JS不要。ユーザーのMac上のブラウザでraw fetch()して確認済み）には、
// 「2026年夏ダイヤ（2026年7月1日～2026年10月24日搭乗分）」のような見出しの
// 直後に「全エリア PDFダウンロード」のリンクがそのまま載っている（夏ダイヤ・
// 冬ダイヤの両方が常に載っているため、見出しの搭乗分期間から今日の日付に
// 合う方を選ぶ＝季節ファイル名を先読みで決め打ちしない）。
//
// このPDFはSKY・JJPと同じ「2列（往路・復路）」の表で、便名（例: NH0987）は
// pdf.jsで実際のPDFを開いて文字化けせずに読み取れることを確認済み
// （Peachのような埋め込みフォントの不具合は無い）。ANA WINGS・AIRDO等が
// 実際に運航する便もANA便名でこの一覧に出るが、これは仕様どおり（このアプリ
// は元からANAの欄にまとめて表示しており、operationNoteで注記している）。
//
// 【文字コードの注意】このPDFの日本語は、埋め込みフォントの都合で、通常の
// 漢字ではなくUnicodeの「康熙部首」等、見た目が同じ別コードポイントの文字で
// 埋め込まれていることが分かった（例:「羽田」の代わりにU+2F7B U+2F65。
// pdf.jsで実際に抽出して確認済み。Peachのような「読み取り不能な文字化け」
// ではなく、正規のUnicode文字への単純な置き換えなので安全に戻せる）。
// JavaScript標準の`.normalize('NFKC')`でほとんどの文字が通常の字に戻ることを
// 確認済みだが、「長」の部首（U+2ED1）だけはNFKCでも戻らないことが分かった
// ため、これだけ個別に置換している（normalizeAnaText参照）。
// ----------------------------------------------------------------------------

const ANA_TIMETABLE_INDEX_URL = 'https://www.ana.co.jp/ja/jp/guide/plan/airinfo/dom-timetable/';

// 2026年9月時点でANAの全エリアPDFに実際に出てくる地名（NFKC正規化後、
// 全角括弧は半角に変換される）と、data/airports.jsonで確認できたICAO
// コード。data/airports.jsonに無い地方空港（天草・対馬・壱岐・五島福江・
// 喜界島・与論・大館能代・八丈島・岩国・オホーツク紋別）は対象外（推測で
// 追加しない＝該当路線は黙って除外される）。
const ANA_CITY_TO_ICAO = {
  '東京(羽田)': 'RJTT', '東京(成田)': 'RJAA',
  '大阪(伊丹)': 'RJOO', '大阪(関西)': 'RJBB', '大阪(神戸)': 'RJBE',
  '札幌(新千歳)': 'RJCC', '福岡': 'RJFF', '名古屋(中部)': 'RJGG',
  '稚内': 'RJCW', '女満別': 'RJCM', '旭川': 'RJEC', '根室中標津': 'RJCN',
  '釧路': 'RJCK', '帯広': 'RJCB', '函館': 'RJCH', '秋田': 'RJSK',
  '庄内': 'RJSY', '富山': 'RJNT', '小松': 'RJNK', '能登': 'RJNW',
  '岡山': 'RJOB', '広島': 'RJOA', '山口宇部': 'RJDC', '鳥取': 'RJOR',
  '米子': 'RJOH', '萩・石見': 'RJOW', '徳島': 'RJOS', '高松': 'RJOT',
  '松山': 'RJOM', '高知': 'RJOK', '北九州': 'RJFR', '佐賀': 'RJFS',
  '大分': 'RJFO', '熊本': 'RJFT', '長崎': 'RJFU', '宮崎': 'RJFM',
  '鹿児島': 'RJFK', '沖縄(那覇)': 'ROAH', '宮古': 'ROMY', '石垣': 'ROIG',
  '静岡': 'RJNS', '仙台': 'RJSS', '福島': 'RJSF', '新潟': 'RJSN',
  '青森': 'RJSA', '種子島': 'RJFG', '屋久島': 'RJFC', '徳之島': 'RJKN',
  '奄美': 'RJKA', '沖永良部': 'RJKB',
};

function normalizeAnaText(text) {
  return text.normalize('NFKC').replace(/⻑/g, '長');
}

function pickAnaAllAreaPdfUrl(indexHtml, todayDateStr) {
  const blockRe = /(\d{4})年(\d{1,2})月(\d{1,2})日[～~](\d{4})年(\d{1,2})月(\d{1,2})日搭乗分[\s\S]{0,800}?href="([^"]*timetable_all_\d{8}_\d{8}\.pdf)"/g;
  const candidates = [...indexHtml.matchAll(blockRe)].map((m) => ({
    period: { start: isoDateFromJp(m[1], m[2], m[3]), end: isoDateFromJp(m[4], m[5], m[6]) },
    url: m[7].startsWith('http') ? m[7] : `https://www.ana.co.jp${m[7]}`,
  }));
  if (!candidates.length) {
    for (const m of indexHtml.matchAll(/href="([^"]*timetable_all_(\d{4})(\d{2})(\d{2})_(\d{4})(\d{2})(\d{2})\.pdf)"/g)) {
      candidates.push({ period: { start: `${m[2]}-${m[3]}-${m[4]}`, end: `${m[5]}-${m[6]}-${m[7]}` },
        url: m[1].startsWith('http') ? m[1] : `https://www.ana.co.jp${m[1]}` });
    }
  }
  if (!candidates.length) return null;
  const current = candidates.find((c) => todayDateStr >= c.period.start && todayDateStr <= c.period.end);
  return (current || candidates[0]).url;
}

async function fetchAnaOfficialSchedule() {
  try {
    const indexHtml = await fetchWithTimeout(ANA_TIMETABLE_INDEX_URL, 12000);
    const today = todayJstDateString();
    const pdfUrl = pickAnaAllAreaPdfUrl(indexHtml, today);
    if (!pdfUrl) throw new Error('全エリアPDFへのリンクを読み取れませんでした（ページ構造が変わった可能性があります）');

    const pdfBuffer = await fetchPdfBuffer(pdfUrl, 45000);
    if (!pdfBuffer) throw new Error(`PDFを取得できませんでした（${pdfUrl}）`);

    const rawText = await extractPdfText(pdfBuffer, 90000);
    const text = normalizeAnaText(rawText);
    const headingRe = /([^\s→]+)→([^\s→]+)/g;
    const rowRe = /(NH\d{3,4})\s+(\d{1,2}:\d{2})\s+(\d{1,2}:\d{2})/g;

    const resolveHeading = (m) => {
      const depIcao = ANA_CITY_TO_ICAO[m[1]];
      const arrIcao = ANA_CITY_TO_ICAO[m[2]];
      if (!depIcao || !arrIcao) return null; // 未対応の地名（天草・対馬等）は除外
      return { dep: depIcao, arr: arrIcao };
    };
    // 便名は他社（SFJ・ADO等）と同じく先頭の0を取り除いた形にそろえる
    // （例:「NH0051」→「51」）。全て0にはならない前提（実在の便名のため）。
    const resolveRow = (m) => ({ number: m[1].slice(2).replace(/^0+(?=\d)/, ''), depTime: m[2], arrTime: m[3] });

    const flights = parseTwoColumnPdfTimetable(text, headingRe, rowRe, resolveHeading, resolveRow);
    if (!flights.length) throw new Error('解析結果が0件（PDFの構成が変わった可能性があります）');
    return { ok: true, flights, source: 'official-pdf', failReason: null };
  } catch (err) {
    return { ok: false, flights: [], source: null, failReason: `ANA公式PDFの取得失敗：${err.message}` };
  }
}

// ----------------------------------------------------------------------------
// 日本航空（JAL）：公式サイトの時刻表検索が使っている路線別XMLを直接取得
// -----------------------------------------------------------------------------
// 依頼「JAL/ANAはキー待ちのまま公式またはバンドルを試す。キーが無いのに
// ODPTだけ試して終わるな」を受けて、今回新たに調査した内容。
//
// JALの時刻表検索フォーム（https://www.jal.co.jp/jp/ja/dom/route/time/）は
// 見た目上は検索してからでないと表が出ないページだが、実際に検索を実行して
// ユーザーのMac上のブラウザの通信ログを確認したところ、検索結果画面の裏側で
//   https://www.jal.co.jp/dom/time/xml/{ご搭乗月}/{出発地3レター}_{到着地3レター}.xml
// というXML（<time><fltno>JAL 501</fltno><std>06:35</std><sta>08:05</sta>
// ...</time>の繰り返し）を直接取得していることを確認した（JAL自身の
// domTimetableControl.js内のXML_BASE_PATH='/dom/time/xml/'からも裏付け
// 済み）。PDFの読み取りより正確・安全な、真の意味での公式・機械可読データ。
//
// ただしJALは国内線だけで100路線以上あり、「出発地×到着地」の組み合わせの
// うち実在するものだけが200を返す（存在しない組み合わせは404）。全組み合わせ
// を毎回総当たりで問い合わせるのはJALのサーバーに過大な負荷をかけることに
// なり適切ではないため、実際に路線が存在することをこのMac上のブラウザから
// 1件ずつ確認済みの主要36路線（JAL_ROUTES。羽田・伊丹・関西・中部発着）
// だけを対象にしている。これ以外の路線（地方路線同士や、JTA・RACが運航する
// 沖縄離島路線等）は対象外のため、該当便はこの一覧には出てこない（黙って
// 0件＝該当なし扱いになるだけで、誤った時刻を出すことはない）。将来路線を
// 追加したい場合は、同じ方法（実際にXMLが200で返ることを確認）でJAL_ROUTES
// に追記する。
//
// 「ご搭乗月」の値（例:"20260901_20261024"）も、時刻表ページの
// <select id="slct_month">の中身（生HTML・JS不要でそのまま載っている）を
// 毎回取得して、今日の日付が入っている期間を選ぶ（決め打ちしない）。
// ----------------------------------------------------------------------------

const JAL_TIMETABLE_INDEX_URL = 'https://www.jal.co.jp/jp/ja/dom/route/time/';
const JAL_XML_BASE = 'https://www.jal.co.jp/dom/time/xml/';

// 実在を確認済みの主要36路線。[出発地3レター, 出発地ICAO, 到着地3レター, 到着地ICAO]
const JAL_ROUTES = [
  ['HND', 'RJTT', 'CTS', 'RJCC'], ['HND', 'RJTT', 'AKJ', 'RJEC'], ['HND', 'RJTT', 'MMB', 'RJCM'],
  ['HND', 'RJTT', 'KUH', 'RJCK'], ['HND', 'RJTT', 'OBO', 'RJCB'], ['HND', 'RJTT', 'HKD', 'RJCH'],
  ['HND', 'RJTT', 'KMQ', 'RJNK'], ['HND', 'RJTT', 'ITM', 'RJOO'], ['HND', 'RJTT', 'KIX', 'RJBB'],
  ['HND', 'RJTT', 'OKJ', 'RJOB'], ['HND', 'RJTT', 'HIJ', 'RJOA'], ['HND', 'RJTT', 'UBJ', 'RJDC'],
  ['HND', 'RJTT', 'TAK', 'RJOT'], ['HND', 'RJTT', 'MYJ', 'RJOM'], ['HND', 'RJTT', 'KCZ', 'RJOK'],
  ['HND', 'RJTT', 'FUK', 'RJFF'], ['HND', 'RJTT', 'KKJ', 'RJFR'], ['HND', 'RJTT', 'OIT', 'RJFO'],
  ['HND', 'RJTT', 'NGS', 'RJFU'], ['HND', 'RJTT', 'KMJ', 'RJFT'], ['HND', 'RJTT', 'KMI', 'RJFM'],
  ['HND', 'RJTT', 'KOJ', 'RJFK'], ['HND', 'RJTT', 'ASJ', 'RJKA'], ['HND', 'RJTT', 'OKA', 'ROAH'],
  ['HND', 'RJTT', 'ISG', 'ROIG'], ['HND', 'RJTT', 'NGO', 'RJGG'],
  ['ITM', 'RJOO', 'CTS', 'RJCC'], ['ITM', 'RJOO', 'OKA', 'ROAH'], ['ITM', 'RJOO', 'FUK', 'RJFF'],
  ['ITM', 'RJOO', 'KOJ', 'RJFK'], ['ITM', 'RJOO', 'NGS', 'RJFU'],
  ['KIX', 'RJBB', 'CTS', 'RJCC'], ['KIX', 'RJBB', 'OKA', 'ROAH'],
  ['FUK', 'RJFF', 'OKA', 'ROAH'], ['NGO', 'RJGG', 'OKA', 'ROAH'], ['NGO', 'RJGG', 'CTS', 'RJCC'],
];

function pickJalMonthCode(indexHtml, todayDateStr) {
  const selectMatch = indexHtml.match(/<select name="month" id="slct_month">([\s\S]*?)<\/select>/);
  if (!selectMatch) return null;
  const options = [...selectMatch[1].matchAll(/<option value="(\d{8}_\d{8})">(\d{4})年(\d{1,2})月(\d{1,2})日[〜～](\d{4})年(\d{1,2})月(\d{1,2})日<\/option>/g)]
    .map((m) => ({
      code: m[1],
      period: { start: isoDateFromJp(m[2], m[3], m[4]), end: isoDateFromJp(m[5], m[6], m[7]) },
    }));
  if (!options.length) return null;
  const current = options.find((o) => todayDateStr >= o.period.start && todayDateStr <= o.period.end);
  return (current || options[0]).code;
}

/**
 * 1路線・片方向ぶんのXMLを解析して、便の配列を返す。JAL便名（<fltno>JAL
 * 数字</fltno>）だけを対象にする（JTA・RAC等、別会社名で出るfltnoは対象外＝
 * 推測で混ぜない）。
 */
function parseJalXml(xml, depIcao, arrIcao) {
  const flights = [];
  const timeBlocks = [...xml.matchAll(/<time>([\s\S]*?)<\/time>/g)];
  for (const block of timeBlocks) {
    const body = block[1];
    const fltnoM = body.match(/<fltno>\s*JAL\s*(\d+)\s*<\/fltno>/);
    const stdM = body.match(/<std>(\d{1,2}:\d{2})<\/std>/);
    const staM = body.match(/<sta>(\d{1,2}:\d{2})<\/sta>/);
    if (!fltnoM || !stdM || !staM) continue;
    flights.push({
      number: fltnoM[1],
      depIcao, depTime: normalizeTime(stdM[1]),
      arrIcao, arrTime: normalizeTime(staM[1]),
      aircraftType: '', // このXMLには機材の記載が無いため空欄
    });
  }
  return flights;
}

function jalLog(...args) { console.log('[JAL]', ...args); }
function jalLogError(...args) { console.error('[JAL]', ...args); }

// 2026-09-26のご指示「403ならUser-Agent等を公式ブラウザに寄せる」：
// fetchWithTimeout()共通ヘルパーは他社（ANA・SKY等）でも使っているため
// 変更せず（他は壊すな）、JAL専用にヘッダーを実際のChromeブラウザに
// 近づけたこの関数だけを新設した。トップページ（ナビゲーションで開く
// document）と、そこから読み込まれるXML（cors・same-originのリソース
// 取得）とではChromeが送るヘッダーの中身が違う（sec-fetch-*とReferer）
// ため、isNavigationで出し分ける。
async function fetchJalWithBrowserHeaders(url, timeoutMs, isNavigation) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, {
      signal: controller.signal,
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/129.0.0.0 Safari/537.36',
        'Accept': isNavigation
          ? 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8'
          : 'application/xml,text/xml,*/*;q=0.8',
        'Accept-Language': 'ja,en-US;q=0.9,en;q=0.8',
        'sec-ch-ua': '"Chromium";v="129", "Not=A?Brand";v="8", "Google Chrome";v="129"',
        'sec-ch-ua-mobile': '?0',
        'sec-ch-ua-platform': '"Windows"',
        'sec-fetch-dest': isNavigation ? 'document' : 'empty',
        'sec-fetch-mode': isNavigation ? 'navigate' : 'cors',
        'sec-fetch-site': isNavigation ? 'none' : 'same-origin',
        ...(isNavigation ? { 'Upgrade-Insecure-Requests': '1' } : { 'Referer': JAL_TIMETABLE_INDEX_URL }),
      },
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return await res.text();
  } finally {
    clearTimeout(timer);
  }
}

async function fetchJalOfficialSchedule() {
  try {
    jalLog('トップページ取得開始 ->', JAL_TIMETABLE_INDEX_URL);
    const indexHtml = await fetchJalWithBrowserHeaders(JAL_TIMETABLE_INDEX_URL, 12000, true);
    jalLog('トップページ取得成功');
    const today = todayJstDateString();
    const monthCode = pickJalMonthCode(indexHtml, today);
    if (!monthCode) throw new Error('ご搭乗月の一覧を読み取れませんでした（ページ構造が変わった可能性があります）');

    const pairs = [];
    for (const [depCode, depIcao, arrCode, arrIcao] of JAL_ROUTES) {
      pairs.push({ url: `${JAL_XML_BASE}${monthCode}/${depCode}_${arrCode}.xml`, depIcao, arrIcao });
      pairs.push({ url: `${JAL_XML_BASE}${monthCode}/${arrCode}_${depCode}.xml`, depIcao: arrIcao, arrIcao: depIcao });
    }

    const results = await Promise.allSettled(pairs.map((p) => fetchJalWithBrowserHeaders(p.url, 8000, false)));
    const flights = [];
    let fetchedCount = 0;
    const failedStatuses = new Set();
    results.forEach((r, i) => {
      if (r.status !== 'fulfilled') {
        failedStatuses.add(String(r.reason && r.reason.message));
        return; // 404（その組み合わせの路線が無い）等は黙って除外
      }
      fetchedCount += 1;
      flights.push(...parseJalXml(r.value, pairs[i].depIcao, pairs[i].arrIcao));
    });
    jalLog(`XML取得 ${fetchedCount}/${pairs.length}件成功。`, failedStatuses.size ? `失敗理由の例: ${[...failedStatuses].slice(0, 3).join(' / ')}` : '');

    if (!fetchedCount) throw new Error('主要路線のXMLをいずれも取得できませんでした（ページ構造が変わった可能性があります）');
    if (!flights.length) throw new Error('解析結果が0件（ページ構造が変わった可能性があります）');
    jalLog(`解析成功 ${flights.length}件。`);
    return { ok: true, flights, source: 'live', failReason: null };
  } catch (err) {
    jalLogError('取得失敗 ->', err.message, '③FlyTeamへ進みます。');
    return { ok: false, flights: [], source: null, failReason: `JAL公式時刻表（XML）の取得失敗：${err.message}` };
  }
}

/**
 * JAL・ANA共通（会社ぶんまとめて取得）：1. ODPT（トークン設定時のみ）→
 * 2. 公式（JALはXML／ANAはPDF）→3. rararakt.com（最終手段）の順で試す。
 *
 * 2026-09-26のご指示により、優先順位を「公式→ODPT→rararakt」から
 * 「ODPT→公式→rararakt」へ変更（ODPTの申請が通り、本物のトークンが使える
 * ようになったため）。ODPTがエラー・0件・トークン未設定のいずれであっても、
 * ここで2（公式）にそのまま進む（推測で埋めない・サイレントに諦めない）。
 *
 * 【ここでの優先順位と、便名検索全体の優先順位（画面に出るのはこちら）の
 * 関係について】ここは「会社の時刻表をまとめて1回で取得する」処理のため、
 * ODPTや公式がまとめて取得に成功していても、探している1便だけがその中に
 * 含まれない場合がある（例：ODPTがその会社の一部の便しか返さない）。その
 * 「1便だけ見つからない」場合に限り、routes/api.jsのbuildTodayFlights側で
 * さらに3.FlyTeam→4.rararakt（未使用なら）→5.Google（最終・リンクのみ）を
 * その1便だけ個別に確認する。つまり全体では
 * ①ODPT→②公式→③FlyTeam→④rararakt→⑤Google の5段階（2026-09-26のご指示）。
 */
// 2026-10-07のご指示：ODPTはfetchAllAirlineSchedules()側で、他社の通信を
// 何も走らせていない状態で先に単独で取得し、その結果をodptResultとして
// ここへ渡す（省略時だけこの関数が自分でfetchFromOdptを呼ぶ＝後方互換）。
// ODPTが便を返せたらそこで確定し、公式・rararaktは一切呼ばない。
async function fetchJalOrAnaSchedule(airline, date, fetchOfficial, getRaraRaw, odptResult) {
  const resolvedOdptResult = odptResult || await fetchFromOdpt(airline);
  if (resolvedOdptResult.ok && resolvedOdptResult.flights.length) {
    return { ...resolvedOdptResult, source: 'odpt' };
  }

  const officialResult = await fetchOfficial();
  if (officialResult.ok && officialResult.flights.length) return officialResult;

  const combinedReason = `${resolvedOdptResult.failReason || 'ODPT取得失敗'} / ${officialResult.failReason || '公式データの取得失敗'}`;
  return withRararaktFallback(airline.icao3, { ok: false, flights: [], failReason: combinedReason }, getRaraRaw);
}

// ----------------------------------------------------------------------------
// IBEXエアラインズ（IBX）：公式サイトの時刻表ページ（HTML）から取得
// -----------------------------------------------------------------------------
// https://www.ibexair.co.jp/timetable/ の1ページに、就航している空港ごとの
// 見出し（例:「新千歳空港発着便」）と、その中に路線・シーズンごとの表が
// すべて載っている（JavaScriptで表示/非表示を切り替えているだけで、HTML
// そのものには全路線・両シーズンぶんが最初から入っている）。
// 表の1行目（<thead>）に「新千歳空港 → 仙台空港」のように発着空港名が
// <span>で入っているので、これを空港名の一覧と突き合わせてICAOコードに
// 変換している。
// ----------------------------------------------------------------------------

const IBEX_TIMETABLE_URL = 'https://www.ibexair.co.jp/timetable/';

// 2026年9月時点でIBEXの時刻表ページに実際に出てくる空港名（<span>の中身）を
// そのままキーにしている。ページの見出しに新しい就航空港が増えた場合は、
// ここに追記が必要（推測で追加はしない）。
const IBEX_AIRPORT_NAME_TO_ICAO = {
  '新千歳空港': 'RJCC',
  '仙台空港': 'RJSS',
  '福島空港': 'RJSF',
  '新潟空港': 'RJSN',
  '名古屋（中部国際空港）': 'RJGG',
  '大阪（伊丹空港）': 'RJOO',
  '広島空港': 'RJOA',
  '松山空港': 'RJOM',
  '福岡空港': 'RJFF',
  '大分空港': 'RJFO',
};

const IBEX_PERIOD_RE = /(\d{4})年(\d{1,2})月(\d{1,2})日\s*[~〜～]\s*(\d{4})年(\d{1,2})月(\d{1,2})日/;

/**
 * IBEXの時刻表ページ全体（1ページ）のHTMLを解析して、便の配列を返す。
 * 「<h3 class="timetable__title">有効期間</h3>」と「<table>路線の表</table>」が
 * 出てくる順番のまま処理し、直前に見た有効期間を、その次に出てくる表の便に
 * 付ける（SFJの解析と同じ、出現順を1回だけ流し読みするやり方）。
 */
function parseIbexTimetable(html, todayDateStr) {
  let currentPeriod = null;
  const rawFlights = [];

  const blockRe = /<h3 class="timetable__title">([^<]+)<\/h3>|<table>([\s\S]*?)<\/table>/g;
  let m;
  while ((m = blockRe.exec(html))) {
    if (m[1] !== undefined) {
      const pm = m[1].match(IBEX_PERIOD_RE);
      currentPeriod = pm
        ? { start: isoDateFromJp(pm[1], pm[2], pm[3]), end: isoDateFromJp(pm[4], pm[5], pm[6]) }
        : null;
      continue;
    }

    const tableHtml = m[2];
    const spans = [...tableHtml.matchAll(/<span>([^<]+)<\/span>/g)].map((s) => s[1]);
    if (spans.length < 2) continue; // 発着空港名の<span>が無い表（想定外）は無視
    const depIcao = IBEX_AIRPORT_NAME_TO_ICAO[spans[0]];
    const arrIcao = IBEX_AIRPORT_NAME_TO_ICAO[spans[1]];
    if (!depIcao || !arrIcao) continue; // 知らない空港名（一覧に無い）は安全側で無視

    const rowRe = /<td>(\d{1,4})<\/td>\s*<td>(\d{1,2}:\d{2})<\/td>\s*<td>(\d{1,2}:\d{2})<\/td>/g;
    let rm;
    while ((rm = rowRe.exec(tableHtml))) {
      rawFlights.push({
        number: rm[1],
        depIcao, depTime: normalizeTime(rm[2]),
        arrIcao, arrTime: normalizeTime(rm[3]),
        aircraftType: '', // このページには機材の記載が無いため空欄
        _period: currentPeriod,
      });
    }
  }

  return pickFlightsPreferToday(rawFlights, todayDateStr);
}

async function fetchIbexSchedule() {
  const today = todayJstDateString();
  try {
    const html = await fetchWithTimeout(IBEX_TIMETABLE_URL, 12000);
    const flights = parseIbexTimetable(html, today);
    if (!flights.length) throw new Error('解析結果が0件（ページ構造が変わった可能性があります）');
    return { ok: true, flights, source: 'live', failReason: null };
  } catch (err) {
    return { ok: false, flights: [], source: null, failReason: `IBEX公式表の取得失敗：${err.message}` };
  }
}

// ----------------------------------------------------------------------------
// AIRDO（ADO）：公式サイトの時刻表ページ（HTML、1ページに全路線・両シーズン）
// から取得
// -----------------------------------------------------------------------------
// https://www.airdo.jp/plan/timetable/ には、路線・シーズンごとの見出し
// （<h3 data-anc="路線キー"><u>有効期間</u></h3>）と、その直後に
// <div class="row row-mg-lg"> の中に往路・復路2つぶんの
// <div class="col-50 col-100-sp"><p class="fw-bold mb-xs">出発地 ⇒ 到着地</p>
// <table class="table-line ..."><tbody>...</tbody></table></div>
// が並ぶ形で、全路線・両シーズンぶんが最初から1ページのHTMLに載っている。
// JavaScript実行前の生のHTTPレスポンス（このアプリのサーバー側fetchと同じ
// 条件）でも同じ内容が返ることを、ユーザーのMac上のブラウザから直接
// fetch()して確認済み（推測ではない）。
// 便名の欄に「82※1」のような脚注番号つきの表記が混ざることがあるため、
// 末尾の「※数字」は取り除いてから数字だけを便名として使う。
// ----------------------------------------------------------------------------

const ADO_TIMETABLE_URL = 'https://www.airdo.jp/plan/timetable/';

// 2026年9月時点でAIRDOの時刻表ページに実際に出てくる地名（<p class="fw-bold
// mb-xs">の中身）をそのままキーにしている。新しい就航地が増えた場合はここに
// 追記が必要（推測で追加はしない）。
const ADO_CITY_TO_ICAO = {
  '東京（羽田）': 'RJTT',
  '札幌（新千歳）': 'RJCC',
  '旭川': 'RJEC',
  '女満別': 'RJCM',
  '釧路': 'RJCK',
  '帯広': 'RJCB',
  '函館': 'RJCH',
  '仙台': 'RJSS',
  '名古屋': 'RJGG',
  '神戸': 'RJBE',
  '福岡': 'RJFF',
};

// 見出しの有効期間表記は「2026/3/29-2026/10/24」（夏ダイヤ）と
// 「2026/10/25〜2027/3/27」（冬ダイヤ）の2通りの区切り文字が実際に混在して
// いることを確認済みのため、ハイフン・波ダッシュ・全角チルダのいずれも
// 受け付ける。
const ADO_PERIOD_RE = /^(\d{4})\/(\d{1,2})\/(\d{1,2})[-〜～](\d{4})\/(\d{1,2})\/(\d{1,2})$/;

/**
 * 【今回の修正（AIRDOが常に0件になっていた不具合）】
 * 出発地⇒到着地のラベル（<p class="fw-bold mb-xs">）の「⇒」は、実際の
 * 生HTMLでは普通の矢印文字ではなく、HTMLの実体参照 `&rArr;` のまま出力
 * されていることを、ユーザーのMac上のブラウザでraw fetch()して確認した
 * （画面に描画されたテキストを見ると矢印に見えるため見落としやすい）。
 * これまでの解析は普通の「⇒」の文字だけを探していたため、実体参照のまま
 * では一致せず、ラベルが1件も方向判定できず、結果として便が常に0件に
 * なり、毎回rararakt.comの最終手段行きになっていた（本番の
 * airlineFetchStatus.ADO.source が 'official' にならない原因）。
 * SFJのdecodeSfjEntities()と同じ考え方で、このページで実際に使われている
 * 実体参照だけを普通の記号に戻してから解析する。
 */
function decodeAdoEntities(text) {
  return text
    .replace(/&rArr;/gi, '⇒')
    .replace(/&rarr;/gi, '→')
    .replace(/&nbsp;/gi, ' ');
}

/**
 * AIRDOの時刻表ページ（1ページに全路線・両シーズンぶんがそのままHTMLに
 * 載っている）を解析して、便の配列を返す。
 * <h3 data-anc="...">見出しで区切ってから、その区切られた範囲の中にある
 * <p class="fw-bold mb-xs">（出発地⇒到着地のラベル、往路・復路の2つ）と
 * <tbody>（その直後の表の中身、同じく2つ）を、出現順のペアとして扱う
 * （実際のページで、往路のラベル→往路の表→復路のラベル→復路の表の順に
 * 並んでいることをブラウザで確認済み）。
 */
function parseAdoTimetable(html, todayDateStr) {
  const headingRe = /<h3 data-anc="[^"]*"><u>([^<]+)<\/u><\/h3>/g;
  const headings = [...html.matchAll(headingRe)];
  const rawFlights = [];

  for (let i = 0; i < headings.length; i += 1) {
    const h = headings[i];
    const blockStart = h.index + h[0].length;
    const blockEnd = i + 1 < headings.length ? headings[i + 1].index : html.length;
    const block = html.slice(blockStart, blockEnd);

    const pm = h[1].trim().match(ADO_PERIOD_RE);
    const period = pm
      ? { start: isoDateFromJp(pm[1], pm[2], pm[3]), end: isoDateFromJp(pm[4], pm[5], pm[6]) }
      : null;

    const labels = [...block.matchAll(/<p class="fw-bold mb-xs">([^<]+)<\/p>/g)].map((m) => decodeAdoEntities(m[1]).trim());
    const tbodies = [...block.matchAll(/<tbody>([\s\S]*?)<\/tbody>/g)].map((m) => m[1]);
    if (!labels.length || labels.length !== tbodies.length) continue; // 想定外の構造は安全側で無視

    for (let j = 0; j < labels.length; j += 1) {
      const dm = labels[j].match(/^(.+?)\s*⇒\s*(.+)$/);
      if (!dm) continue;
      const depIcao = ADO_CITY_TO_ICAO[dm[1].trim()];
      const arrIcao = ADO_CITY_TO_ICAO[dm[2].trim()];
      if (!depIcao || !arrIcao) continue; // 知らない地名（一覧に無い）は安全側で無視

      const rowRe = /<tr>\s*<td>([^<]+)<\/td>\s*<td>([^<]*)<\/td>\s*<td>(\d{1,2}:\d{2})<\/td>\s*<td>[\s\S]*?<\/td>\s*<td>(\d{1,2}:\d{2})<\/td>\s*<\/tr>/g;
      let rm;
      while ((rm = rowRe.exec(tbodies[j]))) {
        const number = rm[1].trim().replace(/※\d+$/, '');
        if (!/^\d{1,4}$/.test(number)) continue; // 数字以外（想定外の行）は安全側で無視
        rawFlights.push({
          number,
          depIcao, depTime: normalizeTime(rm[3]),
          arrIcao, arrTime: normalizeTime(rm[4]),
          aircraftType: rm[2].trim(),
          _period: period,
        });
      }
    }
  }

  return pickFlightsPreferToday(rawFlights, todayDateStr);
}

async function fetchAdoSchedule() {
  const today = todayJstDateString();
  try {
    const html = await fetchWithTimeout(ADO_TIMETABLE_URL, 12000);
    const flights = parseAdoTimetable(html, today);
    if (!flights.length) throw new Error('解析結果が0件（ページ構造が変わった可能性があります）');
    return { ok: true, flights, source: 'live', failReason: null };
  } catch (err) {
    return { ok: false, flights: [], source: null, failReason: `AIRDO公式表の取得失敗：${err.message}` };
  }
}

// ----------------------------------------------------------------------------
// ソラシドエア（SNJ）：公式サイトの時刻表ページ（HTML、路線ごと）から取得
// -----------------------------------------------------------------------------
// 時刻表インデックス（https://www.solaseedair.jp/timetable/）には路線ごとの
// ページへのリンク一覧が載っているが、これはJavaScriptで後から描き込まれる
// 形になっており、このアプリのサーバー側のfetch（画面を描画しないやり方）
// では一覧を読み取れないことを、実際にNode.jsから取得して確認した。
// そのため、SFJ_ROUTES（このファイルの下の方）と同じ考え方で、実在を
// 確認済みの14路線をSOLASEED_ROUTESとして書き出しておく（推測ではなく、
// 実際に公式サイトで確認できたものだけ）。路線が増減した場合は、この一覧を
// 手動で更新する必要がある。
// 各路線ページ（例: /timetable/miya-hane/）自体はサーバー側からの取得でも
// 中身の表がそのまま読めるため、そちらは毎回取得する。夏ダイヤ・冬ダイヤの
// 両方の表がHTMLに入っており（JSでタブ切り替えしているだけ）、見出し
// （<h2 id="anc...">）に書かれた有効期間を見ながら、SFJと同じ「今日の日付に
// 合う方を優先」で選ぶ。
// ----------------------------------------------------------------------------

// 2026年9月時点で公式サイトに実在を確認した14路線（時刻表インデックスの
// 「就航路線のご案内」表と同じ組み合わせ）。namesは、路線ページの見出し文
// （例:「東京（羽田） → 宮崎」）の中で探す言い換え候補。
const SOLASEED_ROUTES = [
  { slug: 'miya-hane', a: { icao: 'RJFM', names: ['宮崎'] }, b: { icao: 'RJTT', names: ['羽田', '東京'] } },
  { slug: 'kuma-hane', a: { icao: 'RJFT', names: ['熊本'] }, b: { icao: 'RJTT', names: ['羽田', '東京'] } },
  { slug: 'naga-hane', a: { icao: 'RJFU', names: ['長崎'] }, b: { icao: 'RJTT', names: ['羽田', '東京'] } },
  { slug: 'kago-hane', a: { icao: 'RJFK', names: ['鹿児島'] }, b: { icao: 'RJTT', names: ['羽田', '東京'] } },
  { slug: 'oita-hane', a: { icao: 'RJFO', names: ['大分'] }, b: { icao: 'RJTT', names: ['羽田', '東京'] } },
  { slug: 'hane-oki', a: { icao: 'RJTT', names: ['羽田', '東京'] }, b: { icao: 'ROAH', names: ['那覇', '沖縄'] } },
  { slug: 'oki-miya', a: { icao: 'ROAH', names: ['那覇', '沖縄'] }, b: { icao: 'RJFM', names: ['宮崎'] } },
  { slug: 'oki-kago', a: { icao: 'ROAH', names: ['那覇', '沖縄'] }, b: { icao: 'RJFK', names: ['鹿児島'] } },
  { slug: 'oki-kou', a: { icao: 'ROAH', names: ['那覇', '沖縄'] }, b: { icao: 'RJBE', names: ['神戸'] } },
  { slug: 'oki-ngo', a: { icao: 'ROAH', names: ['那覇', '沖縄'] }, b: { icao: 'RJGG', names: ['中部', '名古屋'] } },
  { slug: 'oki-isg', a: { icao: 'ROAH', names: ['那覇', '沖縄'] }, b: { icao: 'ROIG', names: ['石垣'] } },
  { slug: 'oki-fuku', a: { icao: 'ROAH', names: ['那覇', '沖縄'] }, b: { icao: 'RJFF', names: ['福岡'] } },
  { slug: 'ngo-miya', a: { icao: 'RJGG', names: ['中部', '名古屋'] }, b: { icao: 'RJFM', names: ['宮崎'] } },
  { slug: 'ngo-kago', a: { icao: 'RJGG', names: ['中部', '名古屋'] }, b: { icao: 'RJFK', names: ['鹿児島'] } },
];

/**
 * 「2026年10月25日-2027年3月27日」（両端に年あり）と
 * 「2026年3月29日-10月24日」（終わりの年が省略）の両方の書き方に対応する。
 */
function parseSolaseedPeriodHeading(text) {
  let m = text.match(/(\d{4})年(\d{1,2})月(\d{1,2})日[-〜～](\d{4})年(\d{1,2})月(\d{1,2})日/);
  if (m) return { start: isoDateFromJp(m[1], m[2], m[3]), end: isoDateFromJp(m[4], m[5], m[6]) };
  m = text.match(/(\d{4})年(\d{1,2})月(\d{1,2})日[-〜～](\d{1,2})月(\d{1,2})日/);
  if (m) return { start: isoDateFromJp(m[1], m[2], m[3]), end: isoDateFromJp(m[1], m[4], m[5]) };
  return null;
}

/**
 * ソラシドの路線ページ（1路線ぶん）のHTMLを解析して、便の配列（_period付き、
 * まだ今日の日付での絞り込み前）を返す。
 */
function parseSolaseedRoutePage(html, route) {
  const rawFlights = [];
  let currentPeriod = null;

  const blockRe = /<h2[^>]*\sid="anc\d+"[^>]*>([^<]+)<\/h2>|<h3 class="c-heading _lv3">([^<]+)<\/h3>\s*<table[^>]*>([\s\S]*?)<\/table>/g;
  let m;
  while ((m = blockRe.exec(html))) {
    if (m[1] !== undefined) {
      currentPeriod = parseSolaseedPeriodHeading(m[1]);
      continue;
    }

    const headingText = m[2];
    const tableHtml = m[3];
    const aIdx = Math.min(...route.a.names.map((n) => { const i = headingText.indexOf(n); return i === -1 ? Infinity : i; }));
    const bIdx = Math.min(...route.b.names.map((n) => { const i = headingText.indexOf(n); return i === -1 ? Infinity : i; }));
    if (aIdx === Infinity || bIdx === Infinity) continue; // どちらの空港かこの見出しから分からない表は無視
    const direction = aIdx < bIdx ? { dep: route.a.icao, arr: route.b.icao } : { dep: route.b.icao, arr: route.a.icao };

    const rowRe = /<th[^>]*class="u-bg-gray-50">\s*SNA\s*(\d+)[\s\S]*?<\/th>\s*<td>([^<]*)<\/td>\s*<td>([0-9：:]+)<\/td>\s*<td>([0-9：:]+)<\/td>/g;
    let rm;
    while ((rm = rowRe.exec(tableHtml))) {
      rawFlights.push({
        number: rm[1],
        depIcao: direction.dep, depTime: normalizeTime(rm[3]),
        arrIcao: direction.arr, arrTime: normalizeTime(rm[4]),
        aircraftType: rm[2].trim(), // 例: "738"（ボーイング737-800）
        _period: currentPeriod,
      });
    }
  }

  return rawFlights;
}

async function fetchSolaseedSchedule() {
  const today = todayJstDateString();
  try {
    const results = await Promise.allSettled(
      SOLASEED_ROUTES.map((route) => fetchWithTimeout(`https://www.solaseedair.jp/timetable/${route.slug}/`, 12000))
    );

    const rawFlights = [];
    const fetchErrors = [];
    let fetchedRouteCount = 0;
    results.forEach((r, i) => {
      if (r.status === 'fulfilled') {
        fetchedRouteCount += 1;
        rawFlights.push(...parseSolaseedRoutePage(r.value, SOLASEED_ROUTES[i]));
      } else {
        fetchErrors.push(`${SOLASEED_ROUTES[i].slug}（${r.reason.message}）`);
      }
    });

    if (!fetchedRouteCount) throw new Error(`全路線ページの取得に失敗しました：${fetchErrors.join('、')}`);

    const flights = pickFlightsPreferToday(rawFlights, today);
    if (!flights.length) throw new Error('解析結果が0件（ページ構造が変わった可能性があります）');
    return { ok: true, flights, source: 'live', failReason: null };
  } catch (err) {
    return { ok: false, flights: [], source: null, failReason: `ソラシドエア公式表の取得失敗：${err.message}` };
  }
}

// ----------------------------------------------------------------------------
// フジドリームエアラインズ（FDA）：公式サイトの時刻表ページ（HTML、路線ごと）
// から取得
// -----------------------------------------------------------------------------
// まず時刻表一覧（https://www.fujidream.co.jp/timetable/）を取得し、そこに
// 載っている路線ページへのリンク（例: timetable_nkm_fuk.html。nkm=名古屋
// 小牧、fuk=福岡のようにIATAに近い略称）の一覧を集める。
// 各路線ページには、往路・復路の表がシーズン（有効期間）ごとのタブに分かれて
// 入っており（タブのボタンID・表を囲むdivのIDは、どの路線ページでも
// 「timetable-cts_tab_01」のように共通の名前になっている＝路線名とは無関係の
// 決まった部品名）、URLの「?timetable_tab=1」は初期表示のタブを選ぶだけで、
// シーズンが複数あるときはページのHTMLに両方とも入っている。そのため、
// SFJ・ソラシドと同じ「今日の日付に合う方を優先」で選んでいる。
// ----------------------------------------------------------------------------

const FDA_INDEX_URL = 'https://www.fujidream.co.jp/timetable/';

// 路線ページのURLに出てくる略称（IATAコードに近い）と、対応する空港
// （ICAOコードと、見出し文の中で探す言い換え候補）。2026年9月時点で実際に
// リンクされている路線ページから略称を拾っている。知らない略称が新しく
// 増えた場合は、その路線だけ安全側で無視する（推測で追加はしない）。
const FDA_SLUG_AIRPORT = {
  cts: { icao: 'RJCC', names: ['千歳', '新千歳'] },
  gaj: { icao: 'RJSC', names: ['山形'] },
  kij: { icao: 'RJSN', names: ['新潟'] },
  mmj: { icao: 'RJAF', names: ['松本'] },
  fsz: { icao: 'RJNS', names: ['静岡'] },
  okd: { icao: 'RJCO', names: ['丘珠'] },
  nkm: { icao: 'RJNA', names: ['小牧'] },
  aoj: { icao: 'RJSA', names: ['青森'] },
  ukb: { icao: 'RJBE', names: ['神戸'] },
  hna: { icao: 'RJSI', names: ['花巻'] },
  izo: { icao: 'RJOC', names: ['出雲'] },
  fuk: { icao: 'RJFF', names: ['福岡'] },
  sdj: { icao: 'RJSS', names: ['仙台'] },
  kcz: { icao: 'RJOK', names: ['高知'] },
  kmj: { icao: 'RJFT', names: ['熊本'] },
  koj: { icao: 'RJFK', names: ['鹿児島'] },
  ngo: { icao: 'RJGG', names: ['中部', '名古屋'] },
};

const FDA_ROUTE_HREF_RE = /timetable_([a-z]{3})_([a-z]{3})\.html/g;

function parseFdaPeriodHeading(text) {
  const m = text.match(/(\d{4})年(\d{1,2})月(\d{1,2})日[〜～](\d{4})年(\d{1,2})月(\d{1,2})日/);
  if (!m) return null;
  return { start: isoDateFromJp(m[1], m[2], m[3]), end: isoDateFromJp(m[4], m[5], m[6]) };
}

/**
 * FDAの時刻表一覧ページのHTMLから、路線ページのファイル名の組（例:
 * ["nkm","fuk"]）の一覧を、重複を除いて取り出す。知っている空港の組み合わせ
 * だけを残す（安全側）。
 */
function extractFdaRouteSlugs(indexHtml) {
  const seen = new Set();
  const routes = [];
  let m;
  FDA_ROUTE_HREF_RE.lastIndex = 0;
  while ((m = FDA_ROUTE_HREF_RE.exec(indexHtml))) {
    const [, aSlug, bSlug] = m;
    const key = `${aSlug}_${bSlug}`;
    if (seen.has(key)) continue;
    seen.add(key);
    const a = FDA_SLUG_AIRPORT[aSlug];
    const b = FDA_SLUG_AIRPORT[bSlug];
    if (!a || !b) continue; // 知らない略称の路線は安全側で無視
    routes.push({ slug: key, a, b });
  }
  return routes;
}

/**
 * FDAの路線ページ（1路線ぶん、往路・復路×シーズン数ぶんの表を含む）のHTMLを
 * 解析して、便の配列（_period付き、まだ今日の日付での絞り込み前）を返す。
 * タブのボタン（有効期間のラベル）とタブの中身（表）は、どちらも
 * 「timetable-cts_tab_連番」というIDで対応づけられている（路線名とは無関係の
 * 共通部品名。実際に複数の路線ページで確認済み）。
 */
function parseFdaRoutePage(html, route) {
  const periodByTab = new Map();
  const labelRe = /id="timetable-cts_tab_(\d+)_label"[^>]*>\s*([^<]+?)\s*<\/button>/g;
  let lm;
  while ((lm = labelRe.exec(html))) {
    periodByTab.set(lm[1], parseFdaPeriodHeading(lm[2]));
  }

  const rawFlights = [];
  let currentTab = null;
  let currentDirection = null;

  const blockRe = /id="timetable-cts_tab_(\d+)"|<th[^>]*colspan="3"[^>]*>([^<]+)<\/th>|<td[^>]*>(\d{1,4})[\s\S]*?<\/td>\s*<td[^>]*>(\d{1,2}:\d{2})<\/td>\s*<td[^>]*>(\d{1,2}:\d{2})<\/td>/g;
  let m;
  while ((m = blockRe.exec(html))) {
    if (m[1] !== undefined) {
      currentTab = m[1];
      continue;
    }
    if (m[2] !== undefined) {
      const headingText = m[2];
      const aIdx = Math.min(...route.a.names.map((n) => { const i = headingText.indexOf(n); return i === -1 ? Infinity : i; }));
      const bIdx = Math.min(...route.b.names.map((n) => { const i = headingText.indexOf(n); return i === -1 ? Infinity : i; }));
      currentDirection = (aIdx === Infinity || bIdx === Infinity)
        ? null
        : (aIdx < bIdx ? { dep: route.a.icao, arr: route.b.icao } : { dep: route.b.icao, arr: route.a.icao });
      continue;
    }
    if (!currentDirection) continue; // 方向が分からない便は採用しない
    rawFlights.push({
      number: m[3],
      depIcao: currentDirection.dep, depTime: normalizeTime(m[4]),
      arrIcao: currentDirection.arr, arrTime: normalizeTime(m[5]),
      aircraftType: '', // このページには機材の記載が無いため空欄
      _period: currentTab !== null ? periodByTab.get(currentTab) || null : null,
    });
  }

  return rawFlights;
}

async function fetchFdaSchedule() {
  const today = todayJstDateString();
  try {
    const indexHtml = await fetchWithTimeout(FDA_INDEX_URL, 12000);
    const routes = extractFdaRouteSlugs(indexHtml);
    if (!routes.length) throw new Error('時刻表一覧から路線一覧を読み取れませんでした（ページ構造が変わった可能性があります）');

    const results = await Promise.allSettled(
      routes.map((route) => fetchWithTimeout(`https://www.fujidream.co.jp/timetable/timetable_${route.slug}.html`, 12000))
    );

    const rawFlights = [];
    let fetchedRouteCount = 0;
    results.forEach((r, i) => {
      if (r.status !== 'fulfilled') return;
      fetchedRouteCount += 1;
      rawFlights.push(...parseFdaRoutePage(r.value, routes[i]));
    });

    if (!fetchedRouteCount) throw new Error('全路線ページの取得に失敗しました');

    const flights = pickFlightsPreferToday(rawFlights, today);
    if (!flights.length) throw new Error('解析結果が0件（ページ構造が変わった可能性があります）');
    return { ok: true, flights, source: 'live', failReason: null };
  } catch (err) {
    return { ok: false, flights: [], source: null, failReason: `FDA公式表の取得失敗：${err.message}` };
  }
}

// ----------------------------------------------------------------------------
// スターフライヤー（SFJ）：公式サイトの時刻表ページ（HTMLの表）から取得
// ----------------------------------------------------------------------------

// 法人向け時刻表ページ。有効期間が異なる2ページ（今の期間用・次の期間用）が
// あり、それぞれ6路線ぶんの表がまとまっている（どちらのページも、今は無い方の
// 期間の表は載っていないことが多いので、両方とも試しに取りに行く）。
// どちらもJavaScript不要の静的HTML（ユーザーのMac上のブラウザで生HTMLを
// 直接確認済み＝生のfetchでも表がそのまま取れる）。
const SFJ_TIMETABLE_URLS = [
  { url: 'https://www.starflyer.jp/sf_biz/timetable/index_biz2.html', label: 'index_biz2.html' },
  { url: 'https://www.starflyer.jp/sf_biz/timetable/index_biz.html', label: 'index_biz.html' },
];

// 公式サイトから取れなかったときの最後の手段（同梱の控えデータ）。
const SFJ_TIMETABLE_JSON_PATH = path.join(__dirname, '..', 'data', 'sfj_timetable.json');

// 路線の一覧。names は、見出し文の中に出てくる空港名の言い換え候補
// （例：中部国際空港は「中部」とも「名古屋」とも書かれることがあるため両方入れる）。
// ICAOコードは data/airports.json と合わせている。
const SFJ_ROUTES = [
  { a: { icao: 'RJTT', names: ['羽田'] }, b: { icao: 'RJFR', names: ['北九州'] } },
  { a: { icao: 'RJTT', names: ['羽田'] }, b: { icao: 'RJFF', names: ['福岡'] } },
  { a: { icao: 'RJTT', names: ['羽田'] }, b: { icao: 'RJBB', names: ['関西', '大阪'] } },
  { a: { icao: 'RJGG', names: ['中部', '名古屋'] }, b: { icao: 'RJFF', names: ['福岡'] } },
  { a: { icao: 'RJTT', names: ['羽田'] }, b: { icao: 'RJDC', names: ['山口宇部', '宇部'] } },
  { a: { icao: 'RJFF', names: ['福岡'] }, b: { icao: 'RJSS', names: ['仙台'] } },
];

const SFJ_FETCH_TIMEOUT_MS = 10000;

/**
 * HTMLの中の一部の名前つき実体参照（&rarr; 等）を、判定に使う記号に戻す。
 * このページの路線見出しは矢印を「&rarr;」「&hArr;」のような実体参照の
 * ままHTMLに出力しており、これを普通の記号に戻さないと「どちら向きか」の
 * 判定が常に失敗してしまう（実際に取得したHTMLで確認済み）。全部の実体
 * 参照を復号する汎用デコーダーは作らず、このページで実際に使われている
 * ものだけに絞って安全に変換する。
 */
function decodeSfjEntities(html) {
  return html
    .replace(/&rarr;/gi, '→')
    .replace(/&hArr;/gi, '⇔')
    .replace(/&harr;/gi, '⇔')
    .replace(/&larr;/gi, '←')
    .replace(/&nbsp;/gi, ' ');
}

/**
 * 路線見出し（例:「羽田空港（東京） → 北九州空港」）の矢印の前後にある
 * 空港名テキストから、SFJ_ROUTESのどの路線の、どちら向きかを判定する。
 * 前後どちらのテキストにどちらの空港名が入っているかで決めるので、矢印の
 * 見た目や表記ゆれには依存しない。前後どちらの空港名も紐付けられない
 * 見出しは「判定できない」として扱う（推測はしない＝その表は採用しない）。
 */
function detectSfjDirectionFromHeading(fromText, toText, routes) {
  for (const route of routes) {
    if (route.a.names.some((n) => fromText.includes(n)) && route.b.names.some((n) => toText.includes(n))) {
      return { route, direction: { dep: route.a.icao, arr: route.b.icao } };
    }
    if (route.b.names.some((n) => fromText.includes(n)) && route.a.names.some((n) => toText.includes(n))) {
      return { route, direction: { dep: route.b.icao, arr: route.a.icao } };
    }
  }
  return { route: null, direction: null };
}

// 「2026年10月25日～2027年3月27日」のように、開始・終了どちらにも西暦がついた
// 期間表記だけを「有効期間」とみなす（西暦が無い一時的な変更注記と区別するため）。
const PERIOD_RE = /(\d{4})年(\d{1,2})月(\d{1,2})日\s*[~〜～]\s*(\d{4})年(\d{1,2})月(\d{1,2})日/;

function parsePeriod(text) {
  const m = text.match(PERIOD_RE);
  if (!m) return null;
  const pad2 = (s) => String(s).padStart(2, '0');
  return {
    start: `${m[1]}-${pad2(m[2])}-${pad2(m[3])}`,
    end: `${m[4]}-${pad2(m[5])}-${pad2(m[6])}`,
    raw: m[0],
  };
}

// 路線見出し（h3）とその直後の表（table）を1組ずつ拾う正規表現。
// このページはtd/thが1行ずつ別れて出力されており、「便名の行に矢印記号や
// 時刻2つが同居する」ことは無いため、HTMLの行に平らに崩さず、表のHTMLから
// 直接 <tr><th>便名</th><td>出発</td><td>到着</td></tr> の形で行を拾う
// （IBEX・ソラシド・FDAと同じ考え方）。
const SFJ_H3_TABLE_RE = /<h3[^>]*>\s*([^<]+?)\s*→\s*([^<]+?)\s*<\/h3>[\s\S]*?<table[^>]*>([\s\S]*?)<\/table>/g;
const SFJ_ROW_RE = /<tr>\s*<th>\s*SFJ\s*(\d{1,4})\s*(?:<sup[^>]*>[\s\S]*?<\/sup>)?\s*<\/th>\s*<td>\s*([0-9：:]{3,5})\s*<\/td>\s*<td>\s*([0-9：:]{3,5})\s*<\/td>\s*<\/tr>/gi;

/**
 * ページ1枚ぶんのHTMLを解析して、便の配列と「このページの有効期間」を返す。
 * 有効期間は見出し（例:「時刻表 2026年10月25日～2027年3月27日」）から取る
 * （西暦が両方はっきり書かれているものだけを対象。parsePeriod参照）。
 *
 * --- TODO（実際のページで便が出てこない、または内容がおかしいとき） ----------
 * ・解析件数が0件になる場合は、まずSFJ_H3_TABLE_RE（路線見出しと表の組）が
 *   ヒットしているか、次にSFJ_ROW_RE（表の中の1便ぶんの行）がヒットして
 *   いるかを、実際に取得したHTMLをconsole.logして順番に確認してください。
 * ・見出しの空港名の言い方が増えた場合は、SFJ_ROUTESのnamesに言い換えを
 *   追加してください（推測の空港名は追加しないでください）。
 * -----------------------------------------------------------------------
 */
function parseSfjPage(rawHtml, routes) {
  const html = decodeSfjEntities(rawHtml);
  const period = parsePeriod(html);
  const rawFlights = [];

  let hMatch;
  SFJ_H3_TABLE_RE.lastIndex = 0;
  while ((hMatch = SFJ_H3_TABLE_RE.exec(html))) {
    const fromText = hMatch[1];
    const toText = hMatch[2];
    // 臨時のバス連絡便など、コメントアウトされて実際には表示されていない
    // 行を拾わないよう、表のHTMLからコメントを取り除いてから行を探す。
    const tableHtml = hMatch[3].replace(/<!--[\s\S]*?-->/g, '');
    const { direction } = detectSfjDirectionFromHeading(fromText, toText, routes);
    if (!direction) continue; // 空港名を紐付けられない見出しは採用しない

    let rowMatch;
    SFJ_ROW_RE.lastIndex = 0;
    while ((rowMatch = SFJ_ROW_RE.exec(tableHtml))) {
      rawFlights.push({
        number: rowMatch[1],
        depIcao: direction.dep,
        depTime: normalizeTime(rowMatch[2]),
        arrIcao: direction.arr,
        arrTime: normalizeTime(rowMatch[3]),
        aircraftType: '', // このページには機材の記載が無いため空欄
        _period: period,
      });
    }
  }

  return { flights: rawFlights, period };
}

/**
 * 同梱の控えデータ（data/sfj_timetable.json）から、今日の日付に合う季節の
 * 時刻表を読み込む。公式サイトが両方とも取れなかったときの最後の手段。
 * 今日がどちらの季節にも入っていない（境目のズレ等）ときは、開始日が
 * 一番近い季節をそのまま使う。ファイルが無い・壊れているときは null を返す。
 */
function loadSfjBundledTimetable(todayDateStr) {
  try {
    const raw = fs.readFileSync(SFJ_TIMETABLE_JSON_PATH, 'utf-8');
    const data = JSON.parse(raw);
    const seasons = data.seasons || [];
    if (!seasons.length) return null;

    let season = seasons.find((s) => todayDateStr >= s.period.start && todayDateStr <= s.period.end);
    if (!season) {
      season = seasons.slice().sort((a, b) => {
        const da = Math.abs(new Date(a.period.start) - new Date(todayDateStr));
        const db = Math.abs(new Date(b.period.start) - new Date(todayDateStr));
        return da - db;
      })[0];
    }

    const flights = (season.flights || []).map((f) => ({
      number: f.number,
      depIcao: f.depIcao,
      depTime: f.depTime,
      arrIcao: f.arrIcao,
      arrTime: f.arrTime,
      aircraftType: f.aircraftType || '',
    }));
    return { flights, label: season.label };
  } catch (err) {
    console.warn('[SFJ] 同梱の控え（data/sfj_timetable.json）の読み込みに失敗しました：', err.message);
    return null;
  }
}

/**
 * 公式サイトの2ページ（有効期間が異なる2シーズンぶん）を取りに行き、
 * それぞれ解析してから合体する。一方のページだけ取れても、そちらだけで
 * 解析を試みる。同じ発着空港＋便名が両方のページに載っている場合は、
 * pickFlightsPreferToday（IBEX/ソラシド/FDAと共通）で今日の日付に合う方を
 * 採用する。取れた便が1つも無いときはエラーを投げる（呼び出し元
 * fetchSfjSchedule が同梱の控えにフォールバックする）。
 */
async function fetchSfjLive(todayDateStr) {
  const results = await Promise.allSettled(
    SFJ_TIMETABLE_URLS.map((p) => fetchWithTimeout(p.url, SFJ_FETCH_TIMEOUT_MS))
  );

  const allRawFlights = [];
  const fetchErrors = [];
  results.forEach((r, i) => {
    if (r.status === 'fulfilled') {
      const { flights } = parseSfjPage(r.value, SFJ_ROUTES);
      allRawFlights.push(...flights);
    } else {
      fetchErrors.push(`${SFJ_TIMETABLE_URLS[i].label}（${r.reason.message}）`);
    }
  });

  if (!allRawFlights.length) {
    const detail = fetchErrors.length ? `両ページとも失敗：${fetchErrors.join('、')}` : '解析結果が0件（ページ構造が変わった可能性があります）';
    throw new Error(detail);
  }

  return pickFlightsPreferToday(allRawFlights, todayDateStr);
}


/**
 * スターフライヤーの時刻表を取得する。
 * 1. まず公式サイトの2ページ（index_biz2.html／index_biz.html）から直接取得を試みる。
 * 2. それが失敗したら、同梱の控え（data/sfj_timetable.json）を使う。
 * 3. それも無ければ、ok:false と「SFJ公式表の取得失敗」から始まる理由文を返す
 *    （呼び出し元 routes/api.js が、さらに前回成功データへのフォールバックを試みる）。
 * 戻り値の source は 'live'（公式から取得）か 'bundled-json'（同梱の控え）。
 * 画面には「公式から取得」か「控え（最終成功/同梱）」のどちらかを表示する。
 */
async function fetchSfjSchedule() {
  const today = todayJstDateString();

  try {
    const flights = await fetchSfjLive(today);

    // 簡易チェック：SFJ70は北九州→羽田便であることが分かっている。
    // 食い違っていてもエラーにはせず、ログに警告を残すだけ（安全側）。
    const sfj70 = flights.find((f) => f.number === '70');
    if (sfj70 && !(sfj70.depIcao === 'RJFR' && sfj70.arrIcao === 'RJTT')) {
      console.warn('[SFJ] SFJ70の方向判定が想定と異なります（本来は北九州→羽田）。ページ構造の解釈が誤っている可能性があります。', sfj70);
    }

    return { ok: true, flights, source: 'live', failReason: null };
  } catch (err) {
    const bundled = loadSfjBundledTimetable(today);
    if (bundled && bundled.flights.length) {
      const note = `SFJ公式表の取得失敗：${err.message}（同梱の控え「${bundled.label}」を使用中）`;
      console.warn(`[SFJ] ${note}`);
      return { ok: true, flights: bundled.flights, source: 'bundled-json', failReason: null, note };
    }
    return { ok: false, flights: [], source: null, failReason: `SFJ公式表の取得失敗：${err.message}` };
  }
}

/**
 * 全社ぶんの時刻表取得を試みる。
 * @param {string} date YYYY-MM-DD（表示中の「今日の便」日付）
 */
/**
 * 会社ごとの取得優先順位（公式HTML／同梱バンドル／ODPT → 最終手段
 * rararakt.com）を実際に適用する部分。各社固有のfetchXxxSchedule()自体は
 * 変更せず、その結果をwithRararaktFallback()（またはJAL/ANA専用の
 * fetchJalAnaSchedule()）に通すだけにしている。
 */
async function fetchAllAirlineSchedules(date) {
  const byAirline = {};
  // rararakt.com/flightnbr/data.jsは全社共通の1ファイルのため、この中で
  // 複数社が最終手段として必要とした場合に備えて、実際の通信・解析は1回
  // だけ行い全員で共有する（2026-10-07のご指示。取得先・内容は変えない。
  // 誰も必要としなければ一度も呼ばれない＝無駄な先読みはしない）。
  let rararaktRawPromise = null;
  function getRaraRaw() {
    if (!rararaktRawPromise) rararaktRawPromise = fetchRararaktRawArray();
    return rararaktRawPromise;
  }

  // 2026-10-07のご指示：ODPTが15秒のタイムアウトに間に合わない原因候補
  //「便名取得10社を全部同時に走らせていること」に対応し、ODPTを使う会社
  // （JAL・ANA）だけを2段階に分ける。
  // 第1段：ODPTだけを、他社の通信を一切走らせない状態で先に済ませる
  // （タイムアウトの秒数自体は変えない。同時に通信するのはODPT2件だけ＝
  // 従来の10件同時よりはっきり減らす）。
  const odptAirlines = AIRLINES.filter((a) => a.source === 'jal-official' || a.source === 'ana-official');
  const odptResultsByCode = {};
  await Promise.all(odptAirlines.map(async (airline) => {
    odptResultsByCode[airline.code] = await fetchFromOdpt(airline);
  }));

  // 第2段：ODPTが便を返せた会社はfetchJalOrAnaSchedule側でそこで確定済みに
  // なり、公式・rararaktは呼ばれない。ODPTが空・中断だった会社の公式・
  // rararaktと、ODPTを使わない残り8社は、第1段が終わってからまとめて
  // 同時に取得する（各社の取得方法・優先順位・判定ロジック自体は一切
  // 変えない）。
  await Promise.all(AIRLINES.map(async (airline) => {
    let result;
    try {
      if (airline.source === 'jal-official') {
        // JAL：1.ODPT（第1段で取得済み）→2.公式（路線別XML）→3.最終手段rararakt。
        result = await fetchJalOrAnaSchedule(airline, date, fetchJalOfficialSchedule, getRaraRaw, odptResultsByCode[airline.code]);
      } else if (airline.source === 'ana-official') {
        // ANA：1.ODPT（第1段で取得済み）→2.公式（全エリアPDF）→3.最終手段rararakt。
        result = await fetchJalOrAnaSchedule(airline, date, fetchAnaOfficialSchedule, getRaraRaw, odptResultsByCode[airline.code]);
      } else if (airline.source === 'sfj-html') {
        // 公式HTML→同梱バンドル（fetchSfjSchedule内部）→ 最終手段rararakt。
        result = await withRararaktFallback(airline.icao3, await fetchSfjSchedule(), getRaraRaw);
      } else if (airline.source === 'ibex-html') {
        result = await withRararaktFallback(airline.icao3, await fetchIbexSchedule(), getRaraRaw);
      } else if (airline.source === 'sna-html') {
        result = await withRararaktFallback(airline.icao3, await fetchSolaseedSchedule(), getRaraRaw);
      } else if (airline.source === 'fda-html') {
        result = await withRararaktFallback(airline.icao3, await fetchFdaSchedule(), getRaraRaw);
      } else if (airline.source === 'ado-html') {
        result = await withRararaktFallback(airline.icao3, await fetchAdoSchedule(), getRaraRaw);
      } else if (airline.source === 'sky-pdf') {
        // スカイマーク：公式PDF（テキスト解析）→ 最終手段rararakt。
        result = await withRararaktFallback(airline.icao3, await fetchSkySchedule(), getRaraRaw);
      } else if (airline.source === 'jjp-pdf') {
        // Jetstar Japan：公式PDF（テキスト解析）→ 最終手段rararakt。
        result = await withRararaktFallback(airline.icao3, await fetchJjpSchedule(), getRaraRaw);
      } else if (airline.source === 'rararakt') {
        // Peach（APJ）：公式の国内線時刻表PDFは実在し、内容も確認できるが、
        // 便名列だけがPDF自身の埋め込みフォント（ToUnicode CMap）の不具合で
        // 文字化けしており（例:"MM053"が"MM㾵㾲㾷"のように読める）、SKY・JJP
        // と同じ方法では正しい便名を機械的に取り出せないことを、pdf.jsで
        // 実際のPDFを開いて確認済み（poppler/pdftotextでも同じPDF自身の
        // データが原因のため同様に文字化けする）。誤った便名を出す方が
        // 「出さない」より危険なため、今回もPDFの自動解析はしていない。
        // 同梱の控えも無いため、最終手段のrararaktだけを試す（それも無ければ
        // officialUrlの案内のみになる）。
        result = await withRararaktFallback(airline.icao3, {
          ok: false,
          flights: [],
          failReason: '公式PDFは便名欄の文字コードに不具合があり、このアプリからは機械的に読み取れません。',
        }, getRaraRaw);
      } else {
        result = await fetchFromHtml(airline, date);
      }
    } catch (err) {
      result = { ok: false, flights: [], failReason: `予期せぬエラー：${err.message}` };
    }
    byAirline[airline.code] = {
      ...result,
      airline: { code: airline.code, name: airline.name, officialUrl: airline.officialUrl, operationNote: airline.operationNote || null },
    };
  }));
  return byAirline;
}

/**
 * 便名の文字列（例: "SFJ70", "70", "sfj70"）から、会社コードと数字部分を分ける。
 * 数字だけの入力のときは会社コードを null にして返す（検索側で全社対象にする）。
 */
function parseFlightQuery(query) {
  const trimmed = String(query || '').trim().toUpperCase();
  const match = trimmed.match(/^([A-Z]{2,3})?\s*-?\s*(\d{1,4})$/);
  if (!match) return null;
  return { code: match[1] || null, number: match[2] };
}

// fetchFromFlyTeam・fetchRararaktSchedule・googleFlightSearchUrlは、
// routes/api.jsのbuildTodayFlights内で「①ODPT・②公式のどちらにも見つから
// なかった特定の1便」だけを個別に確認する3・4・5番目の手段として使う
// （2026-09-26のご指示）。
module.exports = {
  AIRLINES,
  fetchAllAirlineSchedules,
  parseFlightQuery,
  fetchFromFlyTeam,
  fetchRararaktSchedule,
  googleFlightSearchUrl,
  fetchAnaOfficialSchedule,
};
