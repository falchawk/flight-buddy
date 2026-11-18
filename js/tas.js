// TAS早見表（ISA固定・圧縮性考慮）。旧アプリ(wx-brief)の計算式をそのまま移植。完全オフライン。
(function () {
  const G0 = 9.80665, R = 287.05287, GAMMA = 1.4, T0 = 288.15, LAPSE = 0.0065, M_PER_FT = 0.3048, TROPO_M = 11000;
  const T_TROPO = T0 - LAPSE * TROPO_M;
  const A0_KT = (Math.sqrt(GAMMA * R * T0) * 3600) / 1852;
  const DELTA_EXP = G0 / (LAPSE * R);
  const THETA_TROPO = T_TROPO / T0;
  const DELTA_TROPO = Math.pow(THETA_TROPO, DELTA_EXP);
  const STRATO = G0 / (R * T_TROPO);
  const theta = (h) => { const m = h * M_PER_FT; return m <= TROPO_M ? (T0 - LAPSE * m) / T0 : THETA_TROPO; };
  const delta = (h) => { const m = h * M_PER_FT; return m <= TROPO_M ? Math.pow(1 - (LAPSE * m) / T0, DELTA_EXP) : DELTA_TROPO * Math.exp(-STRATO * (m - TROPO_M)); };
  const a = (h) => A0_KT * Math.sqrt(theta(h));
  function iasToMach(ias, h) { const qc = Math.pow(1 + 0.2 * Math.pow(ias / A0_KT, 2), 3.5) - 1; return Math.sqrt(5 * (Math.pow(qc / delta(h) + 1, 1 / 3.5) - 1)); }
  function machToIas(M, h) { const qc = delta(h) * (Math.pow(1 + 0.2 * M * M, 3.5) - 1); return A0_KT * Math.sqrt(5 * (Math.pow(qc + 1, 1 / 3.5) - 1)); }
  const ALTS = Array.from({ length: 31 }, (_, i) => 40000 - i * 1000);
  const COLS = [
    { label: 'IAS250', kind: 'ias', v: 250 }, { label: 'IAS280', kind: 'ias', v: 280 }, { label: 'IAS310', kind: 'ias', v: 310 },
    { label: 'IAS320', kind: 'ias', v: 320 }, { label: 'M0.76', kind: 'mach', v: 0.76 }, { label: 'M0.78', kind: 'mach', v: 0.78 },
    { label: 'M0.79', kind: 'mach', v: 0.79 },
  ];
  const over = (c, h) => (c.kind === 'ias' ? iasToMach(c.v, h) > 0.79 : machToIas(c.v, h) > 320);
  const tas = (c, h) => (c.kind === 'ias' ? iasToMach(c.v, h) * a(h) : c.v * a(h));
  const cls = (r) => (r >= 470 ? 'tas-cell-red' : r >= 460 ? 'tas-cell-yellow' : r >= 450 ? 'tas-cell-green' : '');
  const fmt = (n, d) => n.toFixed(d).replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  function build(table) {
    const head = COLS.map((c) => `<th>${c.label}</th>`).join('');
    const body = ALTS.map((h) => {
      const cells = COLS.map((c) => {
        if (over(c, h)) return '<td class="tas-cell-dash">‐</td>';
        const r = Math.round(tas(c, h)); const k = cls(r);
        return `<td${k ? ` class="${k}"` : ''}>${r}</td>`;
      }).join('');
      return `<tr><th>FL${String(h / 100).padStart(3, '0')}<span class="tas-alt-ft">${fmt(h, 0)} ft</span></th>${cells}</tr>`;
    }).join('');
    table.innerHTML = `<thead><tr><th>ALT</th>${head}</tr></thead><tbody>${body}</tbody>`;
  }
  window.FBTas = { build, iasToMach, machToIas };
})();
