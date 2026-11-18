// ============================================================================
// lib/pdfText.js
// -----------------------------------------------------------------------------
// スカイマーク（SKY）・Jetstar Japan（JJP）・ANAの時刻表PDFから、便名・時刻の
// 「文字」そのものを取り出すための道具箱です。
//
// lib/pdfPreview.js（PDFの1ページ目を画像に変換する道具）と同じ考え方で、
// このMac／実機（Render）に元から入っているpoppler（pdftotextコマンド）を
// 使います。新しいnpmパッケージは追加していません。
// pdftotextの `-layout` オプションは、表のような横並びのレイアウトのとき、
// 元のPDF上の左右位置をできるだけ保ったまま1行のテキストにしてくれるため、
// 「2列並び（往路／復路）の時刻表」でも列が入れ替わらずに済みます
// （実際のpoppler（バージョン22.02.0）で、往路・復路2列の表を再現した
// テストPDFを使って、列がずれずに読み取れることを確認済み）。
//
// pdftotext自体が入っていない環境（ENOENT）や、変換に失敗したときは例外を
// 投げます。呼び出し側（fetchers/flights.js）でそれを捕まえて「次の手段
// （同梱の控え、無ければrararakt.com）」に安全に進めます。
// ============================================================================

const os = require('os');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { execFile } = require('child_process');

function execFileAsync(cmd, args, opts) {
  return new Promise((resolve, reject) => {
    execFile(cmd, args, opts, (err, stdout, stderr) => {
      if (err) reject(Object.assign(err, { stderr }));
      else resolve({ stdout, stderr });
    });
  });
}

/**
 * PDFのバイト列から、レイアウトをできるだけ保ったテキスト
 * （`pdftotext -layout`の標準出力）を返す。
 * ・pdftotextコマンドが無い環境ではENOENTの例外がそのまま投げられる。
 * ・変換に失敗した場合も例外を投げる。
 * どちらも呼び出し側で捕まえて「次の手段」に進める前提。
 */
async function extractPdfText(pdfBuffer, timeoutMs) {
  const tmpBase = path.join(os.tmpdir(), `wxbrief-pdftext-${crypto.randomUUID()}`);
  const pdfPath = `${tmpBase}.pdf`;
  try {
    fs.writeFileSync(pdfPath, pdfBuffer);
    const { stdout } = await execFileAsync(
      'pdftotext',
      ['-layout', pdfPath, '-'],
      { timeout: timeoutMs || 20000, maxBuffer: 1024 * 1024 * 64 }
    );
    return stdout;
  } finally {
    try { fs.unlinkSync(pdfPath); } catch (_err) { /* 無視（後片付け） */ }
  }
}

module.exports = { extractPdfText };
