// 日の出・日没（NOAA簡易式）。完全オフライン計算。build_pack.pyと同じ式。
(function () {
  const rad = (d) => (d * Math.PI) / 180, deg = (r) => (r * 180) / Math.PI;
  function calc(lat, lon, y, m, d, rising) {
    const start = Date.UTC(y, 0, 0);
    const n = Math.round((Date.UTC(y, m - 1, d) - start) / 86400000);
    const lngHour = lon / 15;
    const t = n + ((rising ? 6 : 18) - lngHour) / 24;
    const M = 0.9856 * t - 3.289;
    let L = (M + 1.916 * Math.sin(rad(M)) + 0.02 * Math.sin(rad(2 * M)) + 282.634) % 360;
    if (L < 0) L += 360;
    let RA = deg(Math.atan(0.91764 * Math.tan(rad(L)))) % 360;
    if (RA < 0) RA += 360;
    RA = (RA + (Math.floor(L / 90) * 90 - Math.floor(RA / 90) * 90)) / 15;
    const sinDec = 0.39782 * Math.sin(rad(L));
    const cosDec = Math.cos(Math.asin(sinDec));
    const cosH = (Math.cos(rad(90.833)) - sinDec * Math.sin(rad(lat))) / (cosDec * Math.cos(rad(lat)));
    if (cosH > 1 || cosH < -1) return null;
    let H = rising ? 360 - deg(Math.acos(cosH)) : deg(Math.acos(cosH));
    H /= 15;
    const T = H + RA - 0.06571 * t - 6.622;
    let UT = (T - lngHour) % 24;
    if (UT < 0) UT += 24;
    return Date.UTC(y, m - 1, d) + UT * 3600000;
  }
  // dateStr: "YYYY-MM-DD"（JSTの日付）→ {sunrise, sunset} JSTの "HH:MM"
  function sunTimesJst(lat, lon, dateStr) {
    const [y, m, d] = dateStr.split('-').map(Number);
    const fmt = (ms, want) => {
      if (ms == null) return null;
      const jst = new Date(ms + 9 * 3600000);
      const day = jst.toISOString().slice(0, 10);
      if (day < want) ms += 86400000; else if (day > want) ms -= 86400000;
      return new Date(ms + 9 * 3600000).toISOString().slice(11, 16);
    };
    return { sunrise: fmt(calc(lat, lon, y, m, d, true), dateStr), sunset: fmt(calc(lat, lon, y, m, d, false), dateStr) };
  }
  window.FBSun = { sunTimesJst };
})();
