// ============================================================================
// lib/swimSession.js
// -----------------------------------------------------------------------------
// SWIM（国交省 System-Wide Information Management）へのログインと、ログイン後の
// セッション（Cookie）をサーバー上で使い回すための道具箱です。
//
// 【ブラウザで実地確認した本物の流れ（推測なし）】
// 1. GET  https://top.swim.mlit.go.jp/swim/login
//    → ポータル側（top.swim.mlit.go.jp）のCookie（XSRF-TOKEN含む）が付く。
// 2. POST https://top.swim.mlit.go.jp/swim/api/login
//    body: { userId: <ID>, password: <パスワード> }（JSON）
//    header: X-XSRF-TOKEN に、1.で受け取ったXSRF-TOKENクッキーの値をそのまま入れる
//    （AngularのHttpClientXsrfModuleの標準動作。main.jsのソースで確認済み）。
//    成功すると { statusCode: 0, datas: { redirectUrl: "..." } } が返る
//    （main.js内 `window.location.href=i.datas.redirectUrl` の実装を確認済み）。
// 3. その redirectUrl を（Cookieを保ったまま）GETで辿ると、実際の業務サイト
//    （web.swim.mlit.go.jp）側のセッションCookieが発行される
//    （ブラウザでログイン後、実際に web.swim.mlit.go.jp に遷移し、ATIS取得
//    APIが正常に動くことを確認済み）。
//
// redirectUrlの中身は毎回サーバーが返す値をそのまま使うだけで、URLそのものを
// このファイルにハードコードすることはしません（推測を避けるため）。
//
// 取れるのはSWIMの「ATIS情報リクエストサービス」（fetchers/swim.js）だけです。
// 通常METAR・TAFはSWIM側では取得しません（今回のご指示どおり、SWIM＝ATISのみ・
// METAR/TAFはMET-AIR優先＋AWCフォールバック）。
//
// 【Cookieのドメイン一致について】
// top.swim.mlit.go.jp → web.swim.mlit.go.jp という2つのサブドメインをまたぐ
// ログインのため、Set-CookieにDomain属性（例: Domain=.swim.mlit.go.jp）が
// 付いている場合は、そのCookieを両方のサブドメインで使い回せるようにして
// います（Domain属性が無いCookieは、発行元のホスト名だけに厳密に絞る＝
// 通常のブラウザと同じ挙動）。
//
// 【失敗理由の見える化（このターンのご指示）】
// ログイン〜取得のどこで・なぜ失敗したかをRenderのサーバログ（console.log/
// console.error、"[SWIM]"で始まる行）に必ず残し、投げるエラーには短い理由
// コード（err.code）を必ず付けます。ID・パスワードの値そのものは一切ログに
// 出しません。redirectUrl等、一度きりのトークンを含み得るURLも、ログには
// ホスト名だけを出し、パス・クエリはそのまま出しません。
// ============================================================================

const LOGIN_PAGE_URL = 'https://top.swim.mlit.go.jp/swim/login';
const LOGIN_API_URL = 'https://top.swim.mlit.go.jp/swim/api/login';
const USER_AGENT = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';
const MAX_REDIRECT_HOPS = 8;

// MET-AIR側（lib/metairSession.js）と同じ安全弁：1回のHTTP通信は最大10秒、
// ログイン処理全体は最大20秒で必ず諦める（想定外に固まってAPI全体を
// 止めてしまうことを防ぐため）。
const FETCH_TIMEOUT_MS = 10000;
const OVERALL_LOGIN_TIMEOUT_MS = 20000;

function fetchWithTimeout(url, options = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  return fetch(url, { ...options, signal: controller.signal }).finally(() => clearTimeout(timer));
}

// Cookieは { name, value, domain, hostOnly } の配列で持つ（プロセスが生きて
// いる間だけメモリに置く。ディスクには保存しない＝秘密をファイルに残さない
// ため）。domainはSet-CookieのDomain属性（無ければ発行元のホスト名＝
// hostOnly:true）。
let cookieStore = [];
let loggedIn = false;
let loginPromise = null;

// Flight Buddy 追加（2026-11-18）：15分ごとの短命プロセスで毎回ログインし直さないよう、
// Cookie を SWIM_COOKIE_JAR（既定 /workspace/fb-secrets/swim-cookies.json。リポジトリ外・
// ディレクトリ 700・ファイル 600）に保存して使い回す。ID・パスワードは保存しない。
const fs = require('fs');
const path = require('path');
const COOKIE_JAR = process.env.SWIM_COOKIE_JAR || '/workspace/fb-secrets/swim-cookies.json';
const JAR_MAX_AGE_MS = 6 * 3600 * 1000;
function loadJar() {
  try {
    const st = fs.statSync(COOKIE_JAR);
    if (Date.now() - st.mtimeMs > JAR_MAX_AGE_MS) return;
    const d = JSON.parse(fs.readFileSync(COOKIE_JAR, 'utf8'));
    if (Array.isArray(d.cookies) && d.cookies.length && d.loggedIn) { cookieStore = d.cookies; loggedIn = true; }
  } catch (_e) { /* 無ければ新規ログイン */ }
}
function saveJar() {
  try {
    fs.mkdirSync(path.dirname(COOKIE_JAR), { recursive: true, mode: 0o700 });
    fs.chmodSync(path.dirname(COOKIE_JAR), 0o700);
    fs.writeFileSync(COOKIE_JAR, JSON.stringify({ loggedIn, cookies: cookieStore }), { mode: 0o600 });
    fs.chmodSync(COOKIE_JAR, 0o600);
  } catch (e) { console.error('[SWIM] Cookie保存失敗:', e.code || e.message); }
}
loadJar();

function log(...args) {
  console.log('[SWIM]', ...args);
}
function logError(...args) {
  console.error('[SWIM]', ...args);
}

// エラーに短い理由コード（err.code）を付けて投げるためのヘルパー。
// fetchers/swim.jsはこのcodeだけを見て画面向けの短いラベルに変換する。
function makeError(code, message) {
  const err = new Error(message);
  err.code = code;
  return err;
}

function domainOf(url) {
  try {
    return new URL(url).hostname.toLowerCase();
  } catch (_err) {
    return null;
  }
}

function getSetCookies(res) {
  // Node 18系以降のfetch（undici）はgetSetCookie()で複数のSet-Cookieを
  // 個別に取り出せる。無い実行環境向けに、単一文字列のフォールバックも
  // 用意しておく（複数Cookieが1行に混ざる可能性はあるが、無いよりまし）。
  if (typeof res.headers.getSetCookie === 'function') {
    return res.headers.getSetCookie();
  }
  const single = res.headers.get('set-cookie');
  return single ? [single] : [];
}

function absorbSetCookies(url, res) {
  const hostname = domainOf(url);
  if (!hostname) return;
  const setCookies = getSetCookies(res);
  for (const line of setCookies) {
    const firstPart = line.split(';')[0];
    const eq = firstPart.indexOf('=');
    if (eq <= 0) continue;
    const name = firstPart.slice(0, eq).trim();
    const value = firstPart.slice(eq + 1).trim();
    if (!name) continue;

    const domainMatch = line.match(/;\s*Domain=([^;]+)/i);
    let domain = hostname;
    let hostOnly = true;
    if (domainMatch) {
      domain = domainMatch[1].trim().toLowerCase().replace(/^\./, '');
      hostOnly = false;
    }

    cookieStore = cookieStore.filter((c) => !(c.name === name && c.domain === domain && c.hostOnly === hostOnly));
    cookieStore.push({ name, value, domain, hostOnly });
  }
}

function cookieMatches(cookie, hostname) {
  if (cookie.hostOnly) return hostname === cookie.domain;
  return hostname === cookie.domain || hostname.endsWith(`.${cookie.domain}`);
}

function cookieHeaderFor(url) {
  const hostname = domainOf(url);
  if (!hostname) return '';
  return cookieStore
    .filter((c) => cookieMatches(c, hostname))
    .map((c) => `${c.name}=${c.value}`)
    .join('; ');
}

function getCookieValue(url, name) {
  const hostname = domainOf(url);
  if (!hostname) return null;
  const found = cookieStore.find((c) => c.name === name && cookieMatches(c, hostname));
  return found ? found.value : null;
}

function resetSession() {
  cookieStore = [];
  loggedIn = false;
}
function persistSession() { if (loggedIn) saveJar(); }

/**
 * 3xxが返る限りGETで辿り続け、途中のCookieもすべて吸収する。
 * リンク先はサーバーが返す値をそのまま使うだけで、URLを推測・合成しない。
 */
async function followRedirects(startUrl) {
  let url = startUrl;
  for (let hop = 0; hop < MAX_REDIRECT_HOPS; hop++) {
    let res;
    try {
      res = await fetchWithTimeout(url, {
        redirect: 'manual',
        headers: {
          'User-Agent': USER_AGENT,
          Cookie: cookieHeaderFor(url),
        },
      });
    } catch (e) {
      logError('リダイレクト追跡中の通信エラー:', domainOf(url), e.message);
      throw makeError('REDIRECT_FAILED', `SWIMログイン後の遷移で通信エラーが発生しました（${e.message}）。`);
    }
    absorbSetCookies(url, res);
    log('リダイレクト追跡:', domainOf(url), '→ status', res.status);
    if (res.status >= 300 && res.status < 400) {
      const location = res.headers.get('location');
      if (!location) return res;
      url = new URL(location, url).toString();
      continue;
    }
    return res;
  }
  throw makeError('REDIRECT_FAILED', 'リダイレクトが多すぎます（SWIMログイン後の遷移）。');
}

async function performLogin() {
  const swimUser = process.env.SWIM_USER;
  const swimPass = process.env.SWIM_PASS;
  if (!swimUser || !swimPass) {
    throw makeError('ENV_MISSING', 'SWIM未設定：環境変数 SWIM_USER / SWIM_PASS が未設定です。');
  }

  resetSession();
  log('ログイン開始');

  // 1. ログイン画面を開いてXSRF-TOKEN等の初期Cookieを受け取る。
  let loginPageRes;
  try {
    loginPageRes = await fetchWithTimeout(LOGIN_PAGE_URL, { headers: { 'User-Agent': USER_AGENT } });
  } catch (e) {
    logError('ログインページ取得の通信エラー:', e.message);
    throw makeError('LOGIN_PAGE_FETCH_FAILED', `SWIMログイン画面の取得に失敗しました（${e.message}）。`);
  }
  absorbSetCookies(LOGIN_PAGE_URL, loginPageRes);
  if (!loginPageRes.ok) {
    logError('ログインページ取得HTTPエラー:', loginPageRes.status);
    throw makeError('LOGIN_PAGE_FETCH_FAILED', `SWIMログイン画面の取得に失敗しました（HTTP ${loginPageRes.status}）。`);
  }

  const xsrfToken = getCookieValue(LOGIN_PAGE_URL, 'XSRF-TOKEN');
  log('ログインページ取得OK（XSRF-TOKEN取得=', Boolean(xsrfToken), '）');

  // 2. ログインAPIへPOST（実地確認済み：POST /swim/api/login, JSON {userId,password}）。
  let loginRes;
  try {
    loginRes = await fetchWithTimeout(LOGIN_API_URL, {
      method: 'POST',
      headers: {
        'User-Agent': USER_AGENT,
        'Content-Type': 'application/json',
        Cookie: cookieHeaderFor(LOGIN_API_URL),
        ...(xsrfToken ? { 'X-XSRF-TOKEN': xsrfToken } : {}),
      },
      body: JSON.stringify({ userId: swimUser, password: swimPass }),
    });
  } catch (e) {
    logError('ログインAPI通信エラー:', e.message);
    throw makeError('LOGIN_PAGE_FETCH_FAILED', `SWIMログインAPIへの通信に失敗しました（${e.message}）。`);
  }
  absorbSetCookies(LOGIN_API_URL, loginRes);

  let loginJson;
  try {
    loginJson = await loginRes.json();
  } catch (_err) {
    logError('ログイン応答の解析失敗（HTTP', loginRes.status, '）');
    throw makeError('LOGIN_RESPONSE_UNREADABLE', `SWIMログイン応答を読み取れませんでした（HTTP ${loginRes.status}）。`);
  }
  if (!loginJson || typeof loginJson !== 'object') {
    logError('ログイン応答が想定外の形式（オブジェクトではない）');
    throw makeError('LOGIN_RESPONSE_UNREADABLE', `SWIMログイン応答の形式が想定と異なります（HTTP ${loginRes.status}）。`);
  }

  log('ログインAPI応答: HTTP', loginRes.status, ' statusCode=', loginJson.statusCode);

  if (!loginRes.ok || loginJson.statusCode !== 0) {
    const msg = loginJson && loginJson.message ? loginJson.message : `HTTP ${loginRes.status}`;
    logError('ログイン失敗:', msg);
    throw makeError('LOGIN_FAILED', `SWIMログインに失敗しました（${msg}）。IDまたはパスワードをご確認ください。`);
  }

  const redirectUrl = loginJson.datas && loginJson.datas.redirectUrl;
  if (!redirectUrl) {
    logError('redirectUrlが応答に含まれていない');
    throw makeError('NO_REDIRECT_URL', 'SWIMログイン応答にredirectUrlがありませんでした。');
  }
  log('ログインAPI成功。遷移先ホスト:', domainOf(redirectUrl));

  // 3. 実際に業務サイト（web.swim.mlit.go.jp）へ遷移し、そちらのセッション
  //    Cookieを受け取る。
  const finalRes = await followRedirects(redirectUrl);
  if (!finalRes.ok) {
    logError('ログイン後の画面取得HTTPエラー:', finalRes.status);
    throw makeError('REDIRECT_FAILED', `SWIMログイン後の画面取得に失敗しました（HTTP ${finalRes.status}）。`);
  }

  loggedIn = true;
  saveJar();
  log('ログイン成功');
}

/**
 * ログイン済みであることを保証する（未ログインなら今ログインする。複数箇所
 * から同時に呼ばれても、実際のログイン処理は1回だけ走る）。
 */
async function ensureLoggedIn() {
  if (loggedIn) return;
  if (!loginPromise) {
    // 個々の通信にはfetchWithTimeoutで上限を付けているが、二重の安全策として
    // ログイン処理全体にも上限を付ける（想定外に長く固まってAPI全体を
    // 止めてしまうことがないように）。
    const timeoutPromise = new Promise((_resolve, reject) => {
      setTimeout(() => {
        reject(makeError('TIMEOUT', `SWIMログイン処理が${OVERALL_LOGIN_TIMEOUT_MS / 1000}秒以内に終わりませんでした。`));
      }, OVERALL_LOGIN_TIMEOUT_MS);
    });
    loginPromise = Promise.race([performLogin(), timeoutPromise]).finally(() => {
      loginPromise = null;
    });
  }
  await loginPromise;
}

/**
 * web.swim.mlit.go.jp配下のAPIをCookie付きで呼ぶ。セッション切れ（ログイン画面
 * へ戻された等）を検知したら、1回だけ再ログインしてやり直す
 * （「セッションはサーバで使い回す。切れたら再ログイン」というご指示のため）。
 */
// SWIM への同時リクエスト数の上限（全空港を15分ごとに取るため、礼儀として絞る。既定4）
const SWIM_MAX_PARALLEL = Math.max(1, Number(process.env.SWIM_MAX_PARALLEL) || 4);
let swimActive = 0;
const swimWaiters = [];
async function withSlot(fn) {
  if (swimActive >= SWIM_MAX_PARALLEL) await new Promise((r) => swimWaiters.push(r));
  swimActive++;
  try { return await fn(); } finally { swimActive--; const next = swimWaiters.shift(); if (next) next(); }
}
let swimRequestCount = 0;
const requestCount = () => swimRequestCount;

async function swimFetch(url, options = {}) {
  await ensureLoggedIn();

  const doFetch = () => withSlot(() => { swimRequestCount++; return fetchWithTimeout(url, {
      ...options,
      headers: {
        'User-Agent': USER_AGENT,
        Cookie: cookieHeaderFor(url),
        ...(options.headers || {}),
      },
    }); });

  let res;
  try {
    res = await doFetch();
  } catch (e) {
    logError('本文取得の通信エラー:', e.message);
    throw makeError('FETCH_FAILED', `SWIM通信エラー：${e.message}`);
  }
  absorbSetCookies(url, res);
  if (process.env.SWIM_DEBUG) log('リクエスト:', domainOf(url), '→ status', res.status);

  if (res.status === 401 || res.status === 403) {
    // セッション切れとみなし、1回だけ再ログインして再試行する。
    log('認証エラーを検知。再ログインします。');
    loggedIn = false;
    await ensureLoggedIn();
    try {
      res = await doFetch();
    } catch (e) {
      logError('再ログイン後の再取得で通信エラー:', e.message);
      throw makeError('FETCH_FAILED', `SWIM通信エラー：${e.message}`);
    }
    absorbSetCookies(url, res);
    log('再試行:', domainOf(url), '→ status', res.status);
  }

  return res;
}

module.exports = { swimFetch, ensureLoggedIn, resetSession, persistSession, requestCount };
