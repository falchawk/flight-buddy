// ============================================================================
// fetchers/swimAip.js
// -----------------------------------------------------------------------------
// SWIM AIP閲覧サービス（f2eapr）から、メイン空港ごとのAD 2「Lost
// Communication Procedures（通信途絶時の手続き）」の原文だけを取り出すための
// 道具箱です（2026-09-29のご指示）。
//
// 【実地確認した本物の構成（推測なし。built-in browserで実際に開いて確認）】
// ・起点はご指示のURL：
//   https://web.swim.mlit.go.jp/f2eapr/AIP/html/{DATE}/frame/index-en-JP.html
//   （{DATE}はAIRAC発効日。YYYYMMDD）。このフレーム自体には本文が無いため、
//   実際に本文を持つ目次ページ {BASE}/{DATE}/eAIP/{DATE}/JP-menu-en-JP.html
//   を直接使う（同じホスト・同じ日付フォルダの中。新しいホストは作らない）。
// ・目次ページの実物のHTMLを確認したところ、各空港ごとに
//     <a id="AD-2.{ICAO}" ... href="pdf/JP-AD-2-{ICAO}-en-JP.pdf">
//   という実リンクがあり（RJTT・RJFFで実際に確認済み）、この href の値を
//   その場で読み取って使う（ファイル名パターンをこちら側で決め打ちしない。
//   属性の並び順が変わっても読めるよう、id/hrefどちらが先でも拾う）。
// ・本文はそのPDF（1空港1ファイル。AD 2.1～AD 2.24の全項目を含む）。
//   Lost Communication Proceduresは独立した章見出しではなく、
//   「AD 2.22 FLIGHT PROCEDURES」内の番号付き項目として書かれている
//   （実例：RJTT="3. Lost communication procedures for arrival aircraft
//   under radar navigational guidance..."、RJFF="2. Lost Communication
//   Procedures for Arrival Aircraft under radar navigational guidance..."。
//   実際に2空港分のPDFをpdf.jsで開いて確認済み）。
// ・ENRの全国共通文（AD 2以外の章）はこの仕組みでは触れない（そもそも
//   AD-2.{ICAO}ページしか開かないため）。
//
// 【ログインについて】
// このAIP閲覧ページは実地確認時、ログイン無しで開けることもあれば、
// アクセスの仕方によってはSWIMログイン画面（top.swim.mlit.go.jp/swim/login）
// へ転送されることも確認した（未ログインで弾かれるのは正常＝ご指示の
// とおり）。どちらの場合でも安全に動くよう、ATIS・NOTAM・空港プロファイルと
// 完全に同じ既存のセッション付きフェッチ（lib/swimSession.jsのswimFetch。
// ログインが必要なら自動でログインし、Cookieをサーバー側で使い回す）を
// そのまま使う。新しいログイン経路（裏口）は作らない。
//
// 【AIRACの日付フォールバック】
// 2026-09-03は実地確認済みの実在の発効日（ご指示で頂いたもの）。次回以降の
// AIRAC（28日周期）ではこのフォルダが無くなるため、28日周期で「今日以前で
// 一番新しい候補」から古い方へ向けて何周期か遡って試す。ホスト・パス構造は
// 変えず、日付部分だけを実在の周期で動かす（新しいURLパターンを推測で
// 作らない）。
//
// 【推測しない・偽の手続きを書かない】
// ・目次に該当空港のAD-2リンクが無い／PDFが取得できない／PDF内にLost
//   Communication Procedures相当の項目が見つからない、のいずれでも
//   ok:falseを返すだけで、それらしい文面を作らない（呼び出し側
//   ＝routes/api.jsで「未取得」表示になる）。
// ============================================================================

const { swimFetch } = require('./lib/swimSession');
const { extractPdfText } = require('./lib/pdfText');
const { parseAd2, PARSER_VERSION } = require('./aipAd2');
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');
const crypto = require('crypto');

// AD 2 の PDF 本文（pdftotext）をディスクに保存しておき、解析ロジックを変えた時は PDF を取り直さず再解析する。
// 保存先は SWIM の取得結果（swim.json）と同じ親フォルダの aip-text/（パックには入れない）。
const textCachePath = (icao) => path.join(process.env.AIP_CACHE_DIR || '/workspace/fb-staging/aip-text', `${icao}.txt.gz`);
function readTextCache(icao, url) {
  try {
    const raw = zlib.gunzipSync(fs.readFileSync(textCachePath(icao))).toString('utf8');
    const nl = raw.indexOf('\n');
    return raw.slice(0, nl) === url ? raw.slice(nl + 1) : null;
  } catch (_e) { return null; }
}
function writeTextCache(icao, url, text) {
  try {
    fs.mkdirSync(path.dirname(textCachePath(icao)), { recursive: true });
    fs.writeFileSync(textCachePath(icao), zlib.gzipSync(`${url}\n${text}`));
  } catch (_e) { /* キャッシュできなくても動く */ }
}
const sha1 = (t) => crypto.createHash('sha1').update(t).digest('hex').slice(0, 16);

const AIP_BASE_URL = 'https://web.swim.mlit.go.jp/f2eapr/AIP/html';
// 実地確認済みの実在AIRAC発効日（2026-09-29のご指示で頂いたもの）。
const AIP_KNOWN_AIRAC_DATE = '2026-09-03';
const AIRAC_CYCLE_DAYS = 28;
// 今日以前で一番新しい候補から、実在の周期で何周期分遡って試すか
// （約半年ぶん。「近い過去の版を探す」というご指示のため、際限なく
// 遡ったりはしない）。
const AIP_DATE_CANDIDATES_TO_TRY = 6;
const AIP_PDF_EXTRACT_TIMEOUT_MS = 30000;

function pad2(n) {
  return String(n).padStart(2, '0');
}
function formatYyyymmdd(date) {
  return `${date.getUTCFullYear()}${pad2(date.getUTCMonth() + 1)}${pad2(date.getUTCDate())}`;
}

// 実在の発効日（AIP_KNOWN_AIRAC_DATE）を基準に、28日周期で「今日以前で
// 一番新しい候補」から古い方へ日付候補を作る（ホスト・パス構造は変えず、
// 日付部分だけを実在の周期で動かす）。
function buildAipDateCandidates(now) {
  const anchor = new Date(`${AIP_KNOWN_AIRAC_DATE}T00:00:00Z`);
  const diffDays = Math.floor((now.getTime() - anchor.getTime()) / 86400000);
  const cyclesElapsed = Math.floor(diffDays / AIRAC_CYCLE_DAYS);
  const candidates = [];
  for (let back = 0; back < AIP_DATE_CANDIDATES_TO_TRY; back++) {
    const cycleIndex = cyclesElapsed - back;
    if (cycleIndex < 0) break;
    const d = new Date(anchor.getTime() + cycleIndex * AIRAC_CYCLE_DAYS * 86400000);
    candidates.push(formatYyyymmdd(d));
  }
  if (candidates.length === 0) candidates.push(AIP_KNOWN_AIRAC_DATE.replace(/-/g, ''));
  return candidates;
}

// 目次HTML（JP-menu-en-JP.html）から、指定ICAOのAD-2本文への実リンク
// （id="AD-2.{ICAO}"を持つ<a>タグのhref）だけを読み取る。属性の並び順
// （id/hrefどちらが先か）に依存しないよう、タグ全体をまず取り出してから
// その中でhrefを探す。ファイル名パターンをこちら側で決め打ちしない。
function findAd2HrefForIcao(menuHtml, icao) {
  const idNeedle = `id="AD-2.${icao}"`;
  const tagRe = /<a\b[^>]*>/gi;
  let m;
  while ((m = tagRe.exec(menuHtml)) !== null) {
    const tag = m[0];
    if (tag.includes(idNeedle)) {
      const hrefMatch = /href="([^"]*)"/i.exec(tag);
      if (hrefMatch && hrefMatch[1]) return hrefMatch[1];
    }
  }
  return null;
}

// ---- PDF本文からLost Communication Procedures相当の項目だけを切り出す ------
// 実地確認済み（RJTT・RJFFの実物PDFで検証）：
// ・本文中の番号付き項目は "N.   タイトル"（数字＋ピリオド＋空白＋大文字
//   始まりの語）、その中の手順ステップは "1)   …" のように閉じ括弧を使う
//   ため混同しない。
// ・終わりは「次の番号付き項目（N+1.）」か「次のAD 2.NN見出し」の早い方。
const LOST_COMM_KEYWORD_RE = /(lost\s+communications?|communications?\s+failure|com\s+failure|radio\s+(?:communications?\s+)?failure)/i;
const AD2_HEADING_RE = /AD\s?2\.\d{1,2}\s+[A-Z]{4,}/g;
const ITEM_HEAD_RE = /\b(\d{1,2})\.\s+(?=[A-Z])/g;
const MAX_SECTION_CHARS = 4000; // 想定外に長い場合の安全弁

function extractLostCommSection(rawPdfText) {
  // pdftotext -layout は改行・桁揃えの空白が付くため、まず1個の空白に畳んで
  // から探す（キーワードが行またぎになっていても拾えるようにするため）。
  const text = String(rawPdfText || '').replace(/\s+/g, ' ').trim();
  const kw = LOST_COMM_KEYWORD_RE.exec(text);
  if (!kw) return null;
  const kwIndex = kw.index;

  // キーワードが属するAD 2.NN見出しの範囲内だけで番号付き項目を探す
  // （別の見出しの番号と混同しないため）。
  AD2_HEADING_RE.lastIndex = 0;
  let lastHeading = null;
  let hm;
  while ((hm = AD2_HEADING_RE.exec(text)) && hm.index < kwIndex) {
    lastHeading = hm;
  }
  const searchFloor = lastHeading ? lastHeading.index + lastHeading[0].length : 0;

  ITEM_HEAD_RE.lastIndex = searchFloor;
  let lastItemHead = null;
  let im;
  while ((im = ITEM_HEAD_RE.exec(text)) && im.index < kwIndex) {
    lastItemHead = im;
  }

  let sectionStart;
  let itemNumber = null;
  if (lastItemHead) {
    sectionStart = lastItemHead.index;
    itemNumber = parseInt(lastItemHead[1], 10);
  } else {
    // 番号付き項目が見つからない（想定外の構成）ときは、直前のAD 2.NN見出し
    // の直後（無ければ先頭）を安全側の開始位置にする。
    sectionStart = searchFloor;
  }

  let sectionEnd = text.length;
  if (itemNumber !== null) {
    const nextItemRe = new RegExp(`\\b${itemNumber + 1}\\.\\s+(?=[A-Z])`);
    const tail = text.slice(kwIndex);
    const nextItemMatch = nextItemRe.exec(tail);
    if (nextItemMatch) sectionEnd = Math.min(sectionEnd, kwIndex + nextItemMatch.index);
  }
  AD2_HEADING_RE.lastIndex = 0;
  const headingTail = text.slice(kwIndex);
  const nextHeadingMatch = AD2_HEADING_RE.exec(headingTail);
  if (nextHeadingMatch) sectionEnd = Math.min(sectionEnd, kwIndex + nextHeadingMatch.index);

  sectionEnd = Math.min(sectionEnd, sectionStart + MAX_SECTION_CHARS);
  const section = text.slice(sectionStart, sectionEnd).trim();
  return section.length > 20 ? section : null;
}

// 1空港ぶん：目次→AD-2リンク発見→PDF取得→本文抽出、を日付候補（新しい順）
// で試す。フォルダ自体が無い（目次取得が404）ときだけ次の日付候補へ進む。
// 目次は取れたが該当空港のリンクが無い／PDFに項目が見つからない、は
// 「その空港は未取得」として確定させる（別の日付を探し直したりしない）。
// 目次は全空港で同じなので、1回の実行で日付ごとに1回だけ取る（SWIM への負荷を減らす）
const menuCache = new Map();
function fetchMenu(menuUrl) {
  if (!menuCache.has(menuUrl)) {
    menuCache.set(menuUrl, swimFetch(menuUrl).then(async (r) => { const html = r.ok ? await r.text() : ''; return { status: r.status, ok: r.ok, html, hash: html ? sha1(html) : null }; }));
  }
  return menuCache.get(menuUrl);
}

// prev: 前回の結果 {ok,text,url,reason}。目次の AD 2 リンク（AIRAC 日付入りの PDF URL）が前回と同じなら
// PDF を取り直さず前回の結果を使う（＝毎回確認し、変わった時だけ差し替え）。deadline を過ぎたら PDF は次回へ回す。
async function fetchLostCommForIcao(icao, dateCandidates, prev, deadline) {
  let lastReason = '取得失敗';
  for (const dateStr of dateCandidates) {
    const menuUrl = `${AIP_BASE_URL}/${dateStr}/eAIP/${dateStr}/JP-menu-en-JP.html`;
    let menuRes;
    try {
      menuRes = await fetchMenu(menuUrl);
    } catch (err) {
      lastReason = `SWIM通信エラー：${err.message}`;
      continue;
    }
    if (menuRes.status === 404) {
      // このAIRAC日付のフォルダ自体が無い→次の（より古い）候補へ。
      lastReason = `AIRAC ${dateStr} 版が見つかりません（404）`;
      continue;
    }
    if (!menuRes.ok) {
      lastReason = `目次取得エラー（HTTP ${menuRes.status}）`;
      continue;
    }
    const menuHtml = menuRes.html;
    const href = findAd2HrefForIcao(menuHtml, icao);
    if (!href) {
      // フォルダは実在するが、この空港のAD-2リンクが目次に無い→未取得
      // （別の日付を探し直さない。ご指示どおり推測でURLを組み立てない）。
      return { ok: false, reason: `目次に${icao}のAD 2リンクが見つかりません`, url: menuUrl };
    }
    const pdfUrl = new URL(href, menuUrl).toString();
    const menuHash = menuRes.hash;
    const sameUrl = Boolean(prev && prev.url === pdfUrl);
    const prevOk = sameUrl && prev.ad2 && prev.ad2.parserV === PARSER_VERSION && (prev.ok || prev.final);
    // 1) 前回と同じ PDF（AIRAC 日付入りの URL が同じ）で、目次も前回から変わっていなければ取り直さない
    if (prevOk && prev.menuHash === menuHash) return { ...prev, reused: true };
    // 2) 目次が変わった（AIP AMDT の差し替えの可能性）：PDF の ETag / Last-Modified だけ HEAD で確認し、同じなら取り直さない
    if (prevOk && prev.etag) {
      try {
        const h = await swimFetch(pdfUrl, { method: 'HEAD' });
        if (h.ok && h.headers.get('etag') === prev.etag && h.headers.get('last-modified') === prev.lastModified) return { ...prev, menuHash, reused: true };
      } catch (_e) { /* 確認できなければ取り直す */ }
    }
    // 3) 解析ロジックだけ新しくなった：保存済みの PDF 本文から再解析（通信なし）
    // 保存済み本文を使うのは「解析ロジックが新しくなっただけ」の時だけ（目次が変わって ETag も違う／確認できない時は必ず取り直す）
    const parserOutdated = sameUrl && !(prev.ad2 && prev.ad2.parserV === PARSER_VERSION);
    let pdfText = parserOutdated ? readTextCache(icao, pdfUrl) : null;
    let meta = { etag: prev && prev.etag, lastModified: prev && prev.lastModified };
    if (!pdfText) {
      if (deadline && Date.now() > deadline) {
        return prev && prev.ok ? { ...prev, reused: true, pendingUrl: pdfUrl } : { ok: false, reason: 'PDFは次回の更新で取得します（1回の取得時間の上限）', url: pdfUrl, pending: true };
      }
      let pdfRes;
      try {
        pdfRes = await swimFetch(pdfUrl);
      } catch (err) {
        return { ok: false, reason: `PDF取得の通信エラー：${err.message}`, url: pdfUrl };
      }
      if (!pdfRes.ok) {
        return { ok: false, reason: `PDF取得エラー（HTTP ${pdfRes.status}）`, url: pdfUrl };
      }
      let pdfBuffer;
      try {
        const arrayBuffer = await pdfRes.arrayBuffer();
        pdfBuffer = Buffer.from(arrayBuffer);
      } catch (err) {
        return { ok: false, reason: `PDF読み取りエラー：${err.message}`, url: pdfUrl };
      }
      try {
        pdfText = await extractPdfText(pdfBuffer, AIP_PDF_EXTRACT_TIMEOUT_MS);
      } catch (err) {
        return { ok: false, reason: `PDF本文抽出エラー：${err.message}`, url: pdfUrl };
      }
      meta = { etag: pdfRes.headers.get('etag'), lastModified: pdfRes.headers.get('last-modified') };
      writeTextCache(icao, pdfUrl, pdfText);
    }
    let ad2 = null;
    try { ad2 = parseAd2(pdfText, icao); } catch (err) { ad2 = { parserV: PARSER_VERSION, unparsed: ['AD 2 全体'], error: err.message }; }
    const common = { url: pdfUrl, ad2, menuHash, etag: meta.etag || null, lastModified: meta.lastModified || null };
    const section = extractLostCommSection(pdfText);
    if (!section) {
      return { ok: false, reason: 'PDF内にLost Communication Procedures相当の項目が見つかりません', final: true, ...common };
    }
    return { ok: true, text: section, ...common };
  }
  return { ok: false, reason: lastReason, url: null };
}

/**
 * メイン空港ごとのLost Communication Proceduresを取得する。
 * @param {string[]} icaoCodes 対象空港のICAOコード一覧（メイン空港）
 * @returns {Promise<{ok: boolean, byIcao: object}>}
 *   byIcao[icao] = { ok, text, url, reason }
 */
async function fetchLostCommProceduresByIcao(icaoCodes, prevByIcao = {}, deadline = 0) {
  const requestedIcaos = Array.isArray(icaoCodes) ? [...new Set(icaoCodes.filter(Boolean))] : [];
  const byIcao = {};
  if (requestedIcaos.length === 0) {
    return { ok: false, byIcao };
  }
  if (!process.env.SWIM_USER || !process.env.SWIM_PASS) {
    for (const icao of requestedIcaos) {
      byIcao[icao] = { ok: false, text: null, url: null, reason: 'SWIM未設定：ID/PASSWORD未設定' };
    }
    return { ok: false, byIcao };
  }

  const dateCandidates = buildAipDateCandidates(new Date());

  // 3並列で順に処理（締め切り判定を PDF ごとに効かせるため）
  let next = 0;
  const one = async (icao) => {
    try {
      const result = await fetchLostCommForIcao(icao, dateCandidates, prevByIcao[icao], deadline);
      byIcao[icao] = { ok: result.ok, text: result.ok ? result.text : null, url: result.url || null, reason: result.ok ? null : result.reason,
        final: Boolean(result.final), pending: Boolean(result.pending), reused: Boolean(result.reused), fetchedAt: result.reused ? (result.fetchedAt || null) : new Date().toISOString(),
        ad2: result.ad2 || null, menuHash: result.menuHash || null, etag: result.etag || null, lastModified: result.lastModified || null };
    } catch (err) {
      byIcao[icao] = { ok: false, text: null, url: null, reason: `想定外のエラー：${err.message}` };
    }
  };
  await Promise.all(Array.from({ length: 3 }, async () => { while (next < requestedIcaos.length) await one(requestedIcaos[next++]); }));

  const anyOk = requestedIcaos.some((icao) => byIcao[icao] && byIcao[icao].ok);
  return { ok: anyOk, byIcao };
}

// routes/api.js側のwithHardTimeout専用：想定外に固まった・例外を投げた
// 場合でも、同じ形の「空だが安全な」結果を返す（更新全体を止めないため）。
function buildAipFallback() {
  return { ok: false, byIcao: {} };
}

module.exports = { fetchLostCommProceduresByIcao, buildAipFallback, extractLostCommSection, findAd2HrefForIcao, buildAipDateCandidates };
