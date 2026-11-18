// ============================================================================
// lib/flightCategory.js
// -----------------------------------------------------------------------------
// METARの生テキストから「雲底（シーリング）」と「視程」を読み取り、
// VFR / MVFR / IFR / LIFR（有視界飛行方式の目安を表す、米FAA式の4段階）を
// 判定するための道具箱です。
//
// 実際に呼ばれるのは、AWC・Ogimetなど公開ソースから本物のMETARテキストが
// 取れた空港だけです（fetchers/publicMetar.js・lib/metarPriority.js参照）。
// SWIMはATIS専用のサービスのためMETARテキスト自体を持たず（常にtext:null）、
// この分類ロジックは呼ばれません（呼び出し側でtextが無いときは分類も行わない
// 設計にしています。2026-09-28のご指示によりMET-AIRからのMETAR取得＝旧
// fetchers/metair.jsは全廃済み）。
//
// 【判定のしきい値（米FAAの定義）】
//   ※ Flight Buddy では日本の航空法優先に変更（旧版は IFR/VFR の境界が視程 3sm）:
//   IFR/VFR の境界 ＝ 航空法施行規則 第5条第4号（地上視程 5,000m・雲高 300m≒1,000ft）
//   MVFR/LIFR だけ FAA 基準。正本は scripts/flightcat.py（ここは同じ値に揃えてある）
//   VFR ： シーリング(雲底) > 3,000ft   かつ 視程 > 5sm（統計マイル）
//   MVFR： シーリング 1,000〜3,000ft    または 視程 5,000m〜5sm
//   IFR ： シーリング   500〜1,000ft    または 視程 1sm〜5,000m
//   LIFR： シーリング < 500ft           または 視程 < 1sm
// シーリングと視程のどちらか悪い方（より制限の厳しい方）を採用します
// （どちらか片方しか読み取れなかったときは、読み取れた方だけで判定します）。
//
// 【視程の単位について】
// 日本を含むICAO標準のMETARは視程をメートル（4桁の数字。例: 9999=10km以上、
// 0800=800m）で報告しますが、米国式の統計マイル表記（例: 10SM, 3SM, 1/2SM,
// P6SM）で書かれたMETARにも対応しています（どちらの形式が来ても、内部では
// 統計マイルに揃えてから判定します）。CAVOK（雲・視程とも良好）は視程10km
// 以上・シーリング無しとして扱います。
// ============================================================================

const METERS_PER_STATUTE_MILE = 1609.344;

/**
 * METARの視程グループを探して、統計マイル（sm）に揃えて返す。
 * 見つからなければ null。
 */
function parseVisibilitySm(metarText) {
  const text = ` ${metarText} `;

  if (/\bCAVOK\b/.test(text)) return 10000 / METERS_PER_STATUTE_MILE; // 10km以上として扱う

  // 米国式：例 "10SM" "3SM" "1/2SM" "M1/4SM"（M=未満） "P6SM"（P=超）
  // 分数（"1 1/2SM"のような整数+分数）にも対応する。
  const usMatch = text.match(/\s(M|P)?(\d{1,2})(?:\s(\d)\/(\d))?SM\b/);
  if (usMatch) {
    const [, , whole, num, den] = usMatch;
    let sm = Number(whole);
    if (num && den) sm += Number(num) / Number(den);
    return sm;
  }
  const usFractionOnlyMatch = text.match(/\s(M|P)?(\d)\/(\d)SM\b/);
  if (usFractionOnlyMatch) {
    const [, , num, den] = usFractionOnlyMatch;
    return Number(num) / Number(den);
  }

  // ICAO/日本式：風のグループの直後に出てくる4桁の視程（メートル）。
  // 例: "...12008KT 9999 FEW020..." の "9999"。
  // 風グループ（KT/MPSで終わる、風向風速のグループ）を先に探し、その直後の
  // 4桁数字を視程として読み取る（RVRの "R27/1200" 等と混同しないため）。
  const windMatch = text.match(/\s(?:\d{3}|VRB)\d{2}(?:G\d{2})?(?:KT|MPS)\s+(?:\d{3}V\d{3}\s+)?(\d{4})M?\b/);
  if (windMatch) {
    const meters = Number(windMatch[1]);
    return meters / METERS_PER_STATUTE_MILE;
  }

  return null;
}

/**
 * METARの雲グループ（BKN/OVC/VV）から、最も低いシーリング（雲底）を
 * フィート単位で返す。FEW・SCTはシーリングに数えない（ICAO/FAAの定義どおり）。
 * BKN/OVC/VVがまったく無い（＝晴れている、またはCAVOK）ときは null
 * （＝シーリングの制限なしとして扱う）。
 */
function parseCeilingFt(metarText) {
  if (/\bCAVOK\b/.test(metarText)) return null; // シーリング無しとして扱う

  const cloudRe = /\b(BKN|OVC|VV)(\d{3})\b/g;
  let lowest = null;
  let m;
  while ((m = cloudRe.exec(metarText))) {
    const heightFt = Number(m[2]) * 100;
    if (lowest === null || heightFt < lowest) lowest = heightFt;
  }
  return lowest;
}

/**
 * METARの生テキストから、シーリング（ft）と視程（sm）を読み取る。
 * どちらも読み取れなかった項目は null（＝その項目からは判定しない）。
 */
function parseMetarCeilingVisibility(metarText) {
  if (!metarText) return { ceilingFt: null, visibilitySm: null };
  return {
    ceilingFt: parseCeilingFt(metarText),
    visibilitySm: parseVisibilitySm(metarText),
  };
}

function categoryFromCeiling(ceilingFt) {
  if (ceilingFt === null || ceilingFt === undefined) return null; // 制限なし＝この軸からは判定しない
  if (ceilingFt < 500) return 'LIFR';
  if (ceilingFt < 1000) return 'IFR';
  if (ceilingFt <= 3000) return 'MVFR'; // MVFRは1,000〜3,000ft（3,000ftを含む）、VFRは3,000ft超
  return 'VFR';
}

function categoryFromVisibility(visibilitySm) {
  if (visibilitySm === null || visibilitySm === undefined) return null;
  if (visibilitySm < 1) return 'LIFR';
  if (visibilitySm * METERS_PER_STATUTE_MILE < 5000) return 'IFR'; // 航空法施行規則 第5条第4号：地上視程 5,000m
  if (visibilitySm <= 5) return 'MVFR';
  return 'VFR';
}

const CATEGORY_RANK = { LIFR: 0, IFR: 1, MVFR: 2, VFR: 3 };

/**
 * シーリング・視程それぞれから求めた区分のうち、悪い方（より制限が厳しい方）
 * を採用する。どちらも読み取れなかったときは null（＝判定不能）。
 */
function classifyFlightCategory({ ceilingFt, visibilitySm }) {
  const fromCeiling = categoryFromCeiling(ceilingFt);
  const fromVisibility = categoryFromVisibility(visibilitySm);
  if (!fromCeiling && !fromVisibility) return null;
  if (!fromCeiling) return fromVisibility;
  if (!fromVisibility) return fromCeiling;
  return CATEGORY_RANK[fromCeiling] <= CATEGORY_RANK[fromVisibility] ? fromCeiling : fromVisibility;
}

/**
 * METARの生テキストを渡すと、判定結果一式を返す（呼び出し側の一括ヘルパー）。
 * metarTextが空のときは全項目nullを返す（推測はしない）。
 */
function classifyMetarText(metarText) {
  const { ceilingFt, visibilitySm } = parseMetarCeilingVisibility(metarText);
  return { category: classifyFlightCategory({ ceilingFt, visibilitySm }), ceilingFt, visibilitySm };
}

module.exports = {
  parseMetarCeilingVisibility,
  classifyFlightCategory,
  classifyMetarText,
};
