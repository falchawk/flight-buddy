// テスト専用：global fetch を差し替えて SWIM を模擬する（実ネットワークには出ない）。
// 呼ばれた URL＋空港を SWIM_STUB_LOG（1行1件）に追記。挙動は SWIM_STUB_PLAN（JSON）で決める。
'use strict';
const fs = require('fs');
const plan = JSON.parse(process.env.SWIM_STUB_PLAN || '{}');
const logf = process.env.SWIM_STUB_LOG;
const rec = (s) => { if (logf) fs.appendFileSync(logf, s + '\n'); };
const json = (o, status = 200) => new Response(JSON.stringify(o), { status, headers: { 'content-type': 'application/json' } });
globalThis.fetch = async (url, opt = {}) => {
  const u = String(url);
  const body = opt.body ? JSON.parse(opt.body) : {};
  if (!u.startsWith('https://web.swim.mlit.go.jp/')) { rec(`OTHER ${u}`); throw new Error('stub: unexpected host'); }
  if (u.includes('/f2appr/')) {
    const icao = body.aerodrome;
    rec(`profile ${icao}`);
    if ((plan.profileErr || []).includes(icao)) return json({ exception: { message: 'stub exception' } });
    return json({ ret: { errorInfoDTO: { result: 'OK' }, metarSpeciBodyData: [`METAR ${icao} 241000Z 00000KT 9999 FEW030 10/05 Q1020`], tafBodyData: [] } });
  }
  if (u.includes('/f2dnrq/')) {
    const key = body.fir === 'RJJJ' ? `RJJJ-${body.scopeEnroute === '0' ? 'enroute' : 'warning'}` : body.location;
    rec(`notam ${key}`);
    if ((plan.notamErr || []).includes(key)) return json({}, 500);
    return json({ ret: { result: '0', notamList: [{ number: `A0001/26-${key}`, location: body.location || 'RJJJ', list: 'stub' }] } });
  }
  if (u.includes('/f2atrq/')) {
    const list = body.searchConditionsDTO.locationList;
    rec(`atis ${list.join(',')}`);
    if (plan.atisErr) return json({}, 500);
    return json({ ret: { atisInfoDTO: { locationList: list, fltxDataInfList: list.map((i) => `ATIS ${i} A 241000Z`) } } });
  }
  rec(`OTHER ${u}`);
  throw new Error('stub: unexpected path');
};
