// ============================================================================
// fetchers/swim/aipAd2.js
// -----------------------------------------------------------------------------
// SWIM AIP の AD 2 PDF（pdftotext -layout の本文）から、AIRPORT タブ用に
//   AD 2.2  標高・磁気偏差（MAG VAR）
//   AD 2.12 滑走路（番号・真方位・長さ×幅・PCR・路面・進入端標高）
//   AD 2.18 ATS 通信施設（周波数）
// を取り出す。読めなかった項目は null / 空配列にして、`unparsed` に項目名を残す（推測で埋めない）。
// ============================================================================
'use strict';

const PARSER_VERSION = 4; // 解析ロジックを変えたら上げる（キャッシュ済み本文から再解析される）

// 「RJDC AD 2.12 …」形式の見出しで AD 2 を項目ごとに切る
function splitSections(text, icao) {
  const re = new RegExp(`^[ \\t]*${icao}\\s+AD\\s?2\\.(\\d{1,2})\\s+[A-Z]`, 'gm');
  const heads = [];
  let m;
  while ((m = re.exec(text))) heads.push({ n: Number(m[1]), idx: m.index });
  const out = {};
  heads.forEach((h, i) => {
    const end = i + 1 < heads.length ? heads[i + 1].idx : text.length;
    if (out[h.n] === undefined) out[h.n] = text.slice(h.idx, end);
  });
  return out;
}

// 表の「項目番号」行（例 "      3    Elevation/ Reference temperature  15ft / 30°C"）から、項目 N の本文（複数行）を取る
function numberedItem(section, n) {
  if (!section) return null;
  const lines = section.split('\n');
  const startRe = new RegExp(`^\\s{0,12}${n}\\s{2,}\\S`);
  const anyRe = /^\s{0,12}(\d{1,2})\s{2,}\S/;
  let s = -1;
  for (let i = 0; i < lines.length; i++) if (startRe.test(lines[i])) { s = i; break; }
  if (s < 0) return null;
  const buf = [lines[s]];
  for (let i = s + 1; i < lines.length; i++) {
    const mm = anyRe.exec(lines[i]);
    if (mm && Number(mm[1]) !== n) break;
    buf.push(lines[i]);
  }
  return buf.join('\n');
}
const afterLabel = (item) => (item || '').split('\n').map((l, i) => (i === 0 ? l.replace(/^\s*\d{1,2}\s{2,}/, '') : l)).join('\n');
// 先頭行は「項目名   値」。2個以上の空白で区切った右側が値
function itemValue(item) {
  if (!item) return null;
  const first = item.split('\n')[0].replace(/^\s*\d{1,2}\s{2,}/, '');
  const parts = first.split(/\s{2,}/);
  return parts.length > 1 ? parts.slice(1).join(' ').trim() : null;
}

const itemFlat = (item) => (item ? item.replace(/^\s*\d{1,2}\s{2,}/, '').replace(/\s+/g, ' ').trim() : null);

function parseElevation(sec2) {
  const v = itemFlat(numberedItem(sec2, 3));
  if (!v) return null;
  // 「Elevation/ Reference temperature」の見出しが折り返されても値（… ft / …）を拾う
  const mf = /(-?\d+(?:\.\d+)?)\s*(?:ft|FT)\b/.exec(v);
  if (mf) return { ft: Math.round(Number(mf[1])), raw: v };
  const mm = /(-?\d+(?:\.\d+)?)\s*m\b/.exec(v);
  if (mm) return { ft: Math.round(Number(mm[1]) * 3.28084), raw: v };
  return null;
}

function parseMagVar(sec2) {
  const v = itemFlat(numberedItem(sec2, 5));
  if (!v) return null;
  const m = /(\d+(?:\.\d+)?)\s*°\s*([EW])(?:\s*\((\d{4})\))?(?:\s*\/\s*([^\s].*))?/.exec(v);
  if (m) { const ac = m[4] ? m[4].trim() : null; return { deg: Number(m[1]), dir: m[2], year: m[3] ? Number(m[3]) : null, annualChange: ac && ac !== '-' ? ac : null, raw: v }; }
  if (/\bNil\b/i.test(v)) return { nil: true, raw: v }; // AIP 自体が Nil（自衛隊の飛行場など）
  return { raw: v };
}

// 滑走路行：  16L   149.88°   3360×60   PCR 1000/F/C/X/T   353357.23N   THR ELEV : 21.8FT
const RWY_ROW = /^\s*([0-3]\d[LRC]?|H\d+)\s+(.*?)\s*([\d,]+(?:\.\d+)?)\s*[×xX*]\s*([\d,]+(?:\.\d+)?)/;
function parseRunways(sec12) {
  if (!sec12) return [];
  const lines = sec12.split('\n');
  const rows = [];
  let cur = null;
  let done = false;
  for (const ln of lines) {
    if (/^\s*Strip\b|Slope of RWY|^\s*Civil Aviation Bureau/.test(ln)) { done = true; continue; } // 表の後半（ストリップ・RESA）以降は読まない
    if (done) continue;
    const m = RWY_ROW.exec(ln);
    if (m) {
      const brg = /^(\d{1,3}(?:\.\d+)?)\s*°?$/.exec(m[2].trim());
      cur = { id: m[1], trueBrg: brg ? Number(brg[1]) : null, lengthM: Number(m[3].replace(/,/g, '')), widthM: Number(m[4].replace(/,/g, '')), pcr: null, surface: null, thrElevFt: null, _txt: [] };
      rows.push(cur);
      cur._txt.push(ln);
      continue;
    }
    if (cur) cur._txt.push(ln);
  }
  for (const r of rows) {
    const t = r._txt.join('\n');
    const pcr = /PC[RN]\s*[\d]+\s*\/?\s*[A-Z](?:\/[A-Z0-9]+)*\*?/.exec(t);
    if (pcr) r.pcr = pcr[0].replace(/\s+/g, '').replace(/^(PC[RN])/, '$1 ');
    const sf = /\b(Asphalt[- ]?Concrete|Asphalt|Concrete|Grooved|Gravel|Grass|Soil|Sod|Coral|Dirt|Turf)\b[^\n]*/i.exec(t.replace(/PC[RN]\s*[\d/A-Z*]+/g, ''));
    if (sf) r.surface = sf[0].replace(/\s{2,}.*$/, '').trim();
    const te = /THR(?:\s*ELEV)?\s*:?\s*(-?[\d.]+)\s*FT/i.exec(t);
    if (te) r.thrElevFt = Number(te[1]);
    delete r._txt;
  }
  return rows;
}

// ATS 通信施設（AD 2.18）：サービス行（APP / TWR / GND …）ごとに周波数をまとめる
const FREQ_RE = /(\d{3}\.\d{1,3})\s*MHz(\([^)]*\))?/gi;
const HOURS_RE = /\bH24\b|\bHJ\b|\bHN\b|\b\d{4}\s*-\s*\d{4}\b|\bMON-FRI[^\n]*|\bO\/R\b|\bON REQUEST\b/i;
const NOT_SERVICE = new Set(['SERVICE', 'CALL', 'HOURS', 'FREQUENCY', 'DESIGNATION', 'REMARKS', 'RJ', 'AD', 'CIVIL', 'AIP', 'NIL']);
function parseFreqs(sec18) {
  if (!sec18) return [];
  const lines = sec18.split('\n').slice(1);
  const groups = [];
  let cur = null;
  const startRe = /^(\s{0,30})([A-Z][A-Za-z/&.-]{0,9})\s{2,}(\S.*)$/;
  const cand = (ln) => {
    const sm = startRe.exec(ln);
    return sm && !NOT_SERVICE.has(sm[2].toUpperCase()) && sm[2] === sm[2].toUpperCase() && !/^\d/.test(sm[3]) ? { indent: sm[1].length, service: sm[2] } : null;
  };
  // サービス名（APP・TWR・AFIS・A/G …）は表の一番左の列。その列の字下げ（最小値±3）に揃う行だけを新しいサービスとみなす
  const indents = lines.map(cand).filter(Boolean).map((c) => c.indent);
  const minIndent = indents.length ? Math.min(...indents) : 0;
  for (const ln of lines) {
    if (/^\s*Civil Aviation Bureau/.test(ln) || /^\s*[A-Z]{4} AD2-\d+/.test(ln)) continue;
    const c = cand(ln);
    if (c && c.indent <= minIndent + 3) {
      cur = { service: c.service, callsign: null, lines: [ln] };
      groups.push(cur);
      continue;
    }
    if (cur) cur.lines.push(ln);
  }
  const out = [];
  for (const g of groups) {
    const first = g.lines[0].replace(/^\s*[A-Za-z/&.-]+\s{2,}/, '');
    const beforeFreq = first.split(FREQ_RE)[0] || '';
    g.callsign = beforeFreq.replace(HOURS_RE, '').replace(/\s{2,}.*$/, '').trim() || null;
    // 周波数＋時間帯：時間帯が現れるたびに（既に時間帯を持つグループなら）新しいグループ
    let sub = null;
    let lastHoursSub = null;
    const subs = [];
    for (const ln of g.lines) {
      const hm = HOURS_RE.exec(ln);
      const fqs = [...ln.matchAll(FREQ_RE)].map((m) => ({ mhz: m[1], note: m[2] ? m[2].replace(/[()]/g, '') : null }));
      if (!sub || (hm && sub.hours)) { sub = { hours: null, freqs: [] }; subs.push(sub); }
      if (hm && !sub.hours) { sub.hours = hm[0].replace(/\s+/g, ' ').trim(); lastHoursSub = sub; }
      const season = !hm && lastHoursSub && /\(([A-Z]{3}\s*-\s*[A-Z]{3})\)/.exec(ln); // 時間帯の下に付く季節表記 (APR-SEP)
      if (season) lastHoursSub.hours += ` (${season[1].replace(/\s+/g, '')})`;
      sub.freqs.push(...fqs);
    }
    subs.forEach((s, k) => { if (!s.freqs.length && s.hours && k > 0) { const pv = subs.slice(0, k).reverse().find((x) => x.freqs.length); if (pv) pv.hours += ` ／ ${s.hours}`; } });
    for (const s of subs) {
      if (!s.freqs.length) continue;
      const emerg = s.freqs.filter((f) => f.note === 'E').map((f) => f.mhz);
      const norm = s.freqs.filter((f) => f.note !== 'E');
      out.push({ service: g.service, callsign: g.callsign, mhz: norm.map((f) => f.mhz), primary: (norm.find((f) => f.note === '1') || {}).mhz || null,
        emergency: emerg, hours: s.hours });
    }
  }
  return out;
}

// text: pdftotext 全文。戻り値の unparsed に「読めなかった項目」を入れる
function parseAd2(text, icao) {
  const sec = splitSections(String(text || ''), icao);
  const unparsed = [];
  const elevation = parseElevation(sec[2]);
  const magvar = parseMagVar(sec[2]);
  const runways = parseRunways(sec[12]);
  const freqs = parseFreqs(sec[18]);
  const freqsNil = Boolean(sec[18]) && !freqs.length && /^\s*Nil\s*$/m.test(sec[18]);
  if (!sec[2]) unparsed.push('AD 2.2');
  else { if (!elevation) unparsed.push('標高'); if (!magvar || (magvar.deg === undefined && !magvar.nil)) unparsed.push('磁気偏差'); }
  if (!sec[12]) unparsed.push('AD 2.12'); else if (!runways.length) unparsed.push('滑走路');
  if (!sec[18]) unparsed.push('AD 2.18'); else if (!freqs.length && !freqsNil) unparsed.push('周波数');
  return { parserV: PARSER_VERSION, elevationFt: elevation ? elevation.ft : null, elevationRaw: elevation ? elevation.raw : null,
    magvar, runways, freqs, freqsNil, unparsed };
}

module.exports = { parseAd2, PARSER_VERSION, splitSections };
