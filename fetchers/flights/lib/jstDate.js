// ============================================================================
// lib/jstDate.js
// -----------------------------------------------------------------------------
// 「日本時間（JST）で今日は何月何日か」を調べるための小さな道具箱です。
// Renderのサーバーは世界のどこか（多くはUTC=協定世界時）で動いているため、
// サーバーの時計をそのまま使うと日付がズレることがあります。ここで必ず
// JST（UTC+9時間）に直してから日付を取り出します。
// ============================================================================

/**
 * 今の瞬間を「JSTの日付文字列（例: 2026-09-17）」にして返す。
 * カレンダー日1回ルール（Botへの解説依頼は1日1回まで）の判定に使う。
 */
function todayJstDateString() {
  const now = new Date();
  const jst = new Date(now.getTime() + 9 * 60 * 60 * 1000);
  return jst.toISOString().slice(0, 10); // "YYYY-MM-DD" の部分だけ取り出す
}

/**
 * 今の瞬間を「JSTの日時文字列（例: 2026-09-17 21:05）」にして返す。
 * 画面に「最終成功：日時」のように表示するときに使う。
 */
function nowJstDisplayString() {
  const now = new Date();
  const jst = new Date(now.getTime() + 9 * 60 * 60 * 1000);
  const iso = jst.toISOString(); // 例: 2026-09-17T12:05:00.000Z
  return `${iso.slice(0, 10)} ${iso.slice(11, 16)} JST`;
}

/**
 * 今の瞬間の「JSTの時（0〜23）」を返す。
 * 深夜確認（JST 00:00〜04:00）の判定に使う（routes/api.js参照）。
 */
function nowJstHour() {
  const now = new Date();
  const jst = new Date(now.getTime() + 9 * 60 * 60 * 1000);
  return jst.getUTCHours();
}

module.exports = { todayJstDateString, nowJstDisplayString, nowJstHour };
