// ============================================================================
// lib/pdfPreview.js
// -----------------------------------------------------------------------------
// AUPQ035・AUPQ078・FXFE502・FXFE5782・FXJP854のPDFを、このアプリの画面の
// 中にそのまま見せるための道具箱です（2026-10-06より、ASAS・FSASは気象庁の
// PNGを直接取得するように変わったため、ここでのPDF取得は扱いません。
// fetchers/chikyuki.jsのresolveGroundChartPng参照）。
//
// 気象庁のPDFを<iframe>や<object>で直接埋め込むと、ブラウザやOSのPDF
// ビューア次第で白い箱になることがあるため、このサーバーがPDFを取得します。
// FXFE502・FXFE5782は1ページ目だけをPNG画像に変換してから<img>として渡し
// ます（画像への変換には、このMacに元から入っているpoppler（pdftoppm
// コマンド）を使います。新しいnpmパッケージは追加していません）。
//
// 変換したPNG・取得したPDFはいずれも、このサーバーが再起動するまでの間
// だけメモリ上に置いておきます（前回成功分のフォールバック用）。今回の
// 取得・変換に失敗した資料は、直前に成功した分があればそれを「前回成功分」
// として使い回し、メモリにも無ければ画像・PDFなし（外部へのリンクだけ）に
// なります（推測URL・推測データは絶対に使いません）。
//
// PREVIEW_CACHE（PNG画像のキャッシュ）はFXFE502・FXFE5782・ASAS・FSASの
// すべてで共用します（PNGがPDF変換由来か、気象庁からの直接取得かは
// 区別しません＝中身は同じPNGのBufferのため）。
// ============================================================================

const os = require('os');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { execFile } = require('child_process');

// key（'aupq035'など） -> { png: Buffer, sourceUrl, fetchedAt }
const PREVIEW_CACHE = new Map();

function execFileAsync(cmd, args, opts) {
  return new Promise((resolve, reject) => {
    execFile(cmd, args, opts, (err, stdout, stderr) => {
      if (err) reject(Object.assign(err, { stderr }));
      else resolve({ stdout, stderr });
    });
  });
}

/**
 * 指定URLからPDFを取得する（失敗理由つき）。HTTPが失敗した場合・中身がPDF
 * でなかった場合は { ok: false, buf: null, reason } を返す（例外は投げない
 * ＝呼び出し側で「次の候補」に進めるか、画面にreasonをそのまま出せる）。
 * reasonは「HTTP 404」「タイムアウト」「PDFでない内容」等、画面にそのまま
 * 出せる短い文字列（2026-10-06のご指示「失敗時はN/AとHTTP」用）。
 * label を渡すと、同じ理由をconsole.warnにも残す（原因調査用。パスワード等
 * は一切含まない）。
 */
async function fetchPdfBufferDetailed(url, timeoutMs, label) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  const tag = label ? `[pdfPreview:${label}]` : '[pdfPreview]';
  try {
    const res = await fetch(url, {
      signal: controller.signal,
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
        'Accept': 'application/pdf,*/*',
      },
    });
    if (!res.ok) {
      console.warn(`${tag} PDF取得失敗：HTTP ${res.status}（${url}）`);
      return { ok: false, buf: null, reason: `HTTP ${res.status}` };
    }
    const buf = Buffer.from(await res.arrayBuffer());
    if (buf.length < 5 || buf.toString('ascii', 0, 4) !== '%PDF') {
      // PDFでない（HTMLのエラーページ等）。先頭の中身が分かるよう少しだけログに残す。
      console.warn(`${tag} PDF取得失敗：中身がPDFではありません（先頭: ${JSON.stringify(buf.toString('utf-8', 0, Math.min(buf.length, 60)))}、${url}）`);
      return { ok: false, buf: null, reason: 'PDFでない内容' };
    }
    return { ok: true, buf, reason: null };
  } catch (err) {
    const reason = err.name === 'AbortError' ? 'タイムアウト' : err.message;
    console.warn(`${tag} PDF取得失敗：${reason}（${url}）`);
    return { ok: false, buf: null, reason };
  } finally {
    clearTimeout(timer);
  }
}

/**
 * 指定URLからPDFを取得する。HTTPが失敗した場合・中身がPDFでなかった
 * 場合はnullを返す（例外は投げない＝呼び出し側で「次の候補」に進める）。
 * 挙動はfetchPdfBufferDetailedと完全に同じ（内部でそれを呼ぶだけの薄い
 * ラッパー。FXFE502/FXFE5782のresolvePdfPreview用に、戻り値の形
 * （Buffer|null）を変えずそのまま残している）。
 */
async function fetchPdfBuffer(url, timeoutMs, label) {
  const result = await fetchPdfBufferDetailed(url, timeoutMs, label);
  return result.ok ? result.buf : null;
}

/**
 * PDFのバイト列を受け取り、1ページ目だけをPNGに変換して返す（Buffer）。
 * 失敗したら例外を投げる（呼び出し側で「次の候補」に進める）。
 * Renderの無料プラン等、CPUが遅い環境での変換遅延を見込み、タイムアウトは
 * 少し余裕を持たせている（20秒→30秒）。
 */
async function pdfFirstPageToPng(pdfBuffer) {
  const tmpBase = path.join(os.tmpdir(), `wxbrief-pdfprev-${crypto.randomUUID()}`);
  const pdfPath = `${tmpBase}.pdf`;
  const outPrefix = `${tmpBase}-out`;
  const outPath = `${outPrefix}.png`;
  try {
    fs.writeFileSync(pdfPath, pdfBuffer);
    await execFileAsync('pdftoppm', ['-png', '-f', '1', '-l', '1', '-r', '110', '-singlefile', pdfPath, outPrefix], { timeout: 30000 });
    return fs.readFileSync(outPath);
  } finally {
    try { fs.unlinkSync(pdfPath); } catch (_err) { /* 無視（後片付け） */ }
    try { fs.unlinkSync(outPath); } catch (_err) { /* 無視（後片付け） */ }
  }
}

function cachePreviewPng(key, png, meta) {
  PREVIEW_CACHE.set(key, { png, sourceUrl: meta.sourceUrl, fetchedAt: meta.fetchedAt });
}

function getCachedPreviewPng(key) {
  const entry = PREVIEW_CACHE.get(key);
  return entry ? entry.png : null;
}

function getCachedPreviewMeta(key) {
  const entry = PREVIEW_CACHE.get(key);
  return entry ? { sourceUrl: entry.sourceUrl, fetchedAt: entry.fetchedAt } : null;
}

module.exports = {
  fetchPdfBuffer,
  fetchPdfBufferDetailed,
  pdfFirstPageToPng,
  cachePreviewPng,
  getCachedPreviewPng,
  getCachedPreviewMeta,
};
