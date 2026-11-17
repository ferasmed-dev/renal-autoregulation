// model.js — Renal autoregulation, NSAIDs / ACE inhibitors and the prerenal → ATN continuum.
// Pure functions only (no DOM, no globals mutated). Units:
//   pressures mmHg · GFR mL/min · time hours · creatinine mg/dL · urine mL/kg/h ·
//   resistances in arbitrary units normalised so the healthy afferent resistance = 1.
//
// TEACHING TOOL — NOT FOR CLINICAL USE. See README.md for every assumption.

/** Default parameters. [phys] = standard physiology / guideline value;
 *  [assumption] = tuning choice of the simulator. */
export const DEFAULTS = Object.freeze({
  MAP: 93,             // [phys] mean arterial pressure, mmHg
  volume: 1,           // effective circulating volume, fraction of normal (1 = euvolaemic)
  nsaid: false,        // NSAID (blocks prostaglandin synthesis)
  acei: false,         // ACE inhibitor / ARB (blocks Ang II)
  diuretic: false,     // loop/thiazide diuretic (volume ↓, natriuresis ↑)
  weightKg: 70,        // [phys] body weight, for urine output per kg and creatinine volume
  baselineCr: 1.0,     // [phys] baseline serum creatinine, mg/dL
  // --- haemodynamics
  P_BS: 10,            // [phys] Bowman's space pressure, mmHg
  PI_GC: 25,           // [phys] mean glomerular oncotic pressure, mmHg
  PGC_HEALTHY: 55,     // [phys] healthy glomerular capillary pressure, mmHg
  GFR_HEALTHY: 125,    // [phys] mL/min
  LLA: 80,             // [phys] lower limit of autoregulation, mmHg
  ULA: 180,            // [phys] upper limit of autoregulation, mmHg
  myoExpLow: 1.86,     // [assumption] myogenic afferent dilation below 93 mmHg
  angGain: 0.5,        // [assumption] Ang II rise per unit of neurohormonal activation
  effAng: 0.35,        // [assumption] efferent constriction per unit Ang II rise
  sympGain: 0.6,       // [assumption] sympathetic afferent constriction per unit activation
  sympBelow: 0.2,      // [assumption] extra sympathetic drive below the lower limit (quadratic)
  pgGain: 0.38,        // [assumption] PG-mediated afferent dilation per unit activation
  aceBlock: 0.8,       // [assumption] fraction of Ang II effect removed by ACEi/ARB
  nsaidBlock: 0.9,     // [assumption] fraction of PG synthesis removed by an NSAID
  diureticVolume: 0.1, // [assumption] effective volume lost with a diuretic
  // --- ischaemia and tubular injury
  ischemiaRBF: 0.6,    // [assumption] relative renal blood flow below which the outer medulla becomes hypoxic
  kInjury: 0.06,       // [assumption] tubular injury rate per hour at full ischaemia
  repairHours: 96,     // [assumption] repair time constant → ~95 % recovery in 10–15 days
  injuryGfrExp: 2,     // [assumption] GFR × (1 − injury)^exp (backleak, obstruction, TGF)
  // --- urine
  fewBase: 1.0,        // [phys] fractional excretion of water, % (≈ 1.8 L/day at GFR 125)
  fenaBase: 0.6,       // [phys] fractional excretion of Na, %
  plasmaNa: 140,       // [phys] mEq/L
});

/** Neurohormonal activation (sympathetic, renin–Ang II, PGs) from low pressure and low effective volume. */
export function activation(p) {
  const vol = Math.max(0.3, Math.min(1.2, p.volume - (p.diuretic ? p.diureticVolume : 0)));
  return Math.max(0, (93 - p.MAP) / 13) + Math.max(0, (1 - vol) / 0.3);
}

const Re0 = (p) => (p.PGC_HEALTHY) / (93 - p.PGC_HEALTHY); // healthy Re with Ra = 1
const Kf = (p) => p.GFR_HEALTHY / (p.PGC_HEALTHY - p.P_BS - p.PI_GC);

/** Instantaneous haemodynamics for given params and tubular injury D (0–1). */
export function haemodynamics(p, D = 0) {
  // Above 93 mmHg (up to the upper limit) the myogenic reflex holds P_GC and flow at their
  // 93-mmHg values whatever the drugs/volume: compute that state and scale Ra to the pressure.
  if (p.MAP > 93) {
    const ref = haemodynamics({ ...p, MAP: 93 }, D);
    const mapC = Math.min(p.ULA, p.MAP);
    const ReAbs = ref.Re * Re0(p);
    const RaAuto = ReAbs * (mapC - ref.P_GC) / ref.P_GC;
    const Ra = RaAuto;
    const P_GC = p.MAP * ReAbs / (Ra + ReAbs);
    const rbf = (p.MAP / (Ra + ReAbs)) / (93 / (1 + Re0(p)));
    const filtration = Math.max(0, Kf(p) * (P_GC - p.P_BS - p.PI_GC));
    const gfr = filtration * Math.pow(1 - Math.min(0.99, Math.max(0, D)), p.injuryGfrExp);
    return { ...ref, myo: Ra / ref.Ra * ref.myo, Ra, P_GC, rbf, gfr, gfrNoInjury: filtration };
  }
  const H = activation(p);
  const below = Math.max(0, p.LLA - p.MAP) / 10;
  const angII = 1 + p.angGain * H;                                   // Ang II index (1 = basal)
  const angEff = 1 + (angII - 1) * (p.acei ? 1 - p.aceBlock : 1);   // after ACEi/ARB
  const pg = p.pgGain * H;                                           // PG index (0 = basal)
  const pgEff = pg * (p.nsaid ? 1 - p.nsaidBlock : 1);              // after NSAID
  const symp = p.sympGain * (H + p.sympBelow * below * below);       // afferent vasoconstrictor tone
  // Myogenic reflex (intrinsic) below 93 mmHg: dilates the afferent, but less than fully
  // (the rest needs prostaglandins); exhausted below the lower limit of autoregulation.
  const myo = Math.pow(Math.max(p.LLA, p.MAP) / 93, p.myoExpLow);
  const Ra = myo * (1 + symp) / (1 + pgEff);
  const Re = Re0(p) * (1 + p.effAng * (angEff - 1));
  const P_GC = Math.max(0, p.MAP) * Re / (Ra + Re);
  const rbf = (Math.max(0, p.MAP) / (Ra + Re)) / (93 / (1 + Re0(p))); // relative renal blood flow
  const filtration = Math.max(0, Kf(p) * (P_GC - p.P_BS - p.PI_GC));
  const gfr = filtration * Math.pow(1 - Math.min(0.99, Math.max(0, D)), p.injuryGfrExp);
  return { H, angII, angEff, pg, pgEff, symp, myo, Ra, Re: Re / Re0(p), P_GC, rbf, gfr, gfrNoInjury: filtration, gfrHealthy: p.GFR_HEALTHY };
}

/** Urine output and indices. FE water and FE Na fall with neurohormonal avidity,
 *  rise with tubular injury (lost concentrating/reabsorbing capacity) and with diuretics. */
export function urine(p, gfr, H, D) {
  const avid = Math.min(1, H / 1.5);
  const few = p.fewBase * (1 - 0.2 * Math.min(1, H)) + 6 * D + (p.diuretic ? 0.5 : 0);   // %
  const fena = p.fenaBase * (1 - 0.9 * avid) + 4 * D + (p.diuretic ? 2 : 0);             // %
  const mlMin = gfr * few / 100;
  const uo = (mlMin * 60) / p.weightKg;                    // mL/kg/h
  const uNa = gfr > 0.5 ? (p.plasmaNa * fena) / few : NaN; // mEq/L  (UNa = PNa·FENa/FEw)
  const uCrPCr = 100 / few;                                // creatinine is filtered, not reabsorbed
  const ifr = uNa / uCrPCr;                                // renal failure index = UNa·PCr/UCr
  return { few, fena, uo, uNa, uCrPCr, ifr };
}

/** Classify the urine indices with the classic cut-offs (functional vs established). */
export function classifyIndices(u) {
  if (!Number.isFinite(u.uNa)) return 'anuria';
  const votes = [u.uNa < 20 ? -1 : 1, u.fena < 1 ? -1 : 1, u.ifr < 1 ? -1 : 1, u.uCrPCr > 40 ? -1 : u.uCrPCr < 20 ? 1 : 0];
  const s = votes.reduce((a, b) => a + b, 0);
  return s <= -2 ? 'functional' : s >= 2 ? 'established' : 'indeterminate';
}

// ---------------------------------------------------------------- KDIGO AKI staging

/** KDIGO 2012 AKI stage (0–3) at the last point of a history of {t (h), cr, uo}.
 *  Creatinine: ≥0.3 mg/dL rise within 48 h, or ratio to the lowest value in the
 *  previous 7 days (≥1.5 → 1, ≥2 → 2, ≥3 or ≥4.0 mg/dL → 3).
 *  Urine output (mean over the window): <0.5 mL/kg/h for 6 h → 1, for 12 h → 2;
 *  <0.3 for 24 h or anuria (<0.05) for 12 h → 3. */
export function kdigoStage(hist) {
  if (!hist.length) return { stage: 0, crStage: 0, uoStage: 0 };
  const now = hist[hist.length - 1];
  const within = (h) => {
    const out = [];
    for (let i = hist.length - 1; i >= 0 && now.t - hist[i].t <= h + 1e-9; i--) out.push(hist[i]);
    return out;
  };
  const minCr = (h) => Math.min(...within(h).map((x) => x.cr));
  const ratio = now.cr / minCr(168);
  let crStage = 0;
  if (ratio >= 3 || (now.cr >= 4 && now.cr - minCr(48) >= 0.3)) crStage = 3;
  else if (ratio >= 2) crStage = 2;
  else if (ratio >= 1.5 || now.cr - minCr(48) >= 0.3) crStage = 1;
  const meanUO = (h) => {
    if (now.t - hist[0].t < h - 1e-9) return Infinity; // not enough observation time yet
    const w = within(h); return w.reduce((a, x) => a + x.uo, 0) / w.length;
  };
  let uoStage = 0;
  if (meanUO(24) < 0.3 || meanUO(12) < 0.05) uoStage = 3;
  else if (meanUO(12) < 0.5) uoStage = 2;
  else if (meanUO(6) < 0.5) uoStage = 1;
  return { stage: Math.max(crStage, uoStage), crStage, uoStage };
}

// ---------------------------------------------------------------- state & integration

/** Phase of the prerenal → ATN → repair course. */
export function phase(s, prevD) {
  const rising = s.D > prevD + 1e-6;
  if (s.D < 0.05) return s.H > 0.8 && s.gfr < 0.85 * s.gfrHealthy ? 'prerenal' : 'normal';
  if (rising) return s.D < 0.3 ? 'initiation' : 'extension';
  if (s.ischaemic) return 'maintenance';
  return s.D > 0.3 && s.t - (s.lastIschaemiaT ?? -1e9) < 48 ? 'maintenance' : 'repair';
}

/** Full observation for a state {t, cr, D}. */
export function observe(t, cr, D, p, extra = {}) {
  const h = haemodynamics(p, D);
  const u = urine(p, h.gfr, h.H, D);
  return { t, cr, D, MAP: p.MAP, ...h, ...u, ischaemic: h.rbf < p.ischemiaRBF, lastIschaemiaT: extra.lastIschaemiaT, indices: classifyIndices(u) };
}

/** Start at steady state: creatinine already adapted to the initial GFR (a patient who
 *  has been in this situation for a while), so the scenario begins stable. */
export function initialState(p = DEFAULTS) {
  const g = haemodynamics(p, 0).gfr;
  const cr0 = g > 1 ? (p.baselineCr * p.GFR_HEALTHY) / g : p.baselineCr * 10;
  const s = observe(0, cr0, 0, p);
  return { ...s, phase: phase(s, 0), ...kdigoStage([{ t: 0, cr: cr0, uo: s.uo }]) };
}

/** One explicit Euler step (dt in hours). Creatinine production is fixed at the
 *  rate that gives baselineCr at a healthy GFR; its volume of distribution is total body water. */
export function step(s, p, dt, history = null) {
  const vdDl = 0.6 * p.weightKg * 10;                       // total body water, dL
  const gen = (p.GFR_HEALTHY * 0.6) * p.baselineCr;          // mg/h  (GFR mL/min → dL/h = ×0.6)
  const cur = haemodynamics(p, s.D);                         // vessels respond at once to new params
  const clear = cur.gfr * 0.6 * s.cr;                        // mg/h
  const cr = Math.max(0.05, s.cr + ((gen - clear) / vdDl) * dt);
  const ischaemia = Math.max(0, (p.ischemiaRBF - cur.rbf) / p.ischemiaRBF);
  const dD = ischaemia > 0 ? p.kInjury * ischaemia * (1 - s.D) : -s.D / p.repairHours;
  const D = Math.min(0.99, Math.max(0, s.D + dD * dt));
  const t = s.t + dt;
  const lastIschaemiaT = ischaemia > 0 ? t : s.lastIschaemiaT;
  const o = observe(t, cr, D, p, { lastIschaemiaT });
  const ph = phase(o, s.D);
  const k = history ? kdigoStage([...history, { t, cr, uo: o.uo }]) : { stage: 0, crStage: 0, uoStage: 0 };
  return { ...o, phase: ph, ...k };
}

export function withParams(over = {}) { return { ...DEFAULTS, ...over }; }

// ---------------------------------------------------------------- scenario presets

/** Each preset: params at t = 0 and timed events ({ t: hours, set: {...} }).
 *  Names and expected behaviour live in i18n.js. Generic clinical situations. */
export const PRESETS = {
  healthy: { params: { MAP: 93, volume: 1 }, events: [] },
  tripleWhammy: {
    params: { MAP: 88, volume: 0.8, acei: true, diuretic: true },
    events: [
      { t: 24, set: { nsaid: true } },
      { t: 96, set: { nsaid: false, acei: false, diuretic: false, volume: 1, MAP: 93 } },
    ],
  },
  briefShock: {
    params: { MAP: 93, volume: 1 },
    events: [{ t: 12, set: { MAP: 55, volume: 0.7 } }, { t: 18, set: { MAP: 88, volume: 1 } }],
  },
  prolongedShock: {
    params: { MAP: 93, volume: 1 },
    events: [
      { t: 12, set: { MAP: 55, volume: 0.7 } },
      { t: 48, set: { MAP: 65, volume: 0.9 } },
      { t: 72, set: { MAP: 85, volume: 1 } },
    ],
  },
  icuTarget65: {
    params: { MAP: 93, volume: 1 },
    events: [{ t: 12, set: { MAP: 65 } }, { t: 84, set: { MAP: 85 } }],
  },
};

/** Parameters in force at time t for a preset (base + events already due). */
export function paramsAt(preset, t, base = DEFAULTS) {
  let p = { ...base, ...preset.params };
  for (const ev of preset.events || []) if (t >= ev.t - 1e-9) p = { ...p, ...ev.set };
  return p;
}

/** Simulate a preset including its timed events. `override` applies for the whole run
 *  (e.g. { nsaid:false, acei:false, diuretic:false } for the "no drugs" counterfactual). */
export function simulatePreset(preset, hours = 504, dt = 0.25, override = {}) {
  let p = { ...paramsAt(preset, 0), ...override };
  let s = initialState(p);
  const out = [s];
  const hist = [{ t: 0, cr: s.cr, uo: s.uo }];
  const n = Math.round(hours / dt);
  for (let i = 0; i < n; i++) {
    p = { ...paramsAt(preset, s.t), ...override };
    s = step(s, p, dt, hist);
    hist.push({ t: s.t, cr: s.cr, uo: s.uo });
    out.push(s);
  }
  return out;
}

/** Steady-state autoregulation curve (no injury): RBF and GFR vs MAP for given drugs/volume. */
export function autoregulationCurve(p, from = 40, to = 180, stepMmHg = 2) {
  const pts = [];
  for (let m = from; m <= to + 1e-9; m += stepMmHg) {
    const h = haemodynamics({ ...p, MAP: m }, 0);
    pts.push({ MAP: m, rbf: h.rbf, gfr: h.gfr });
  }
  return pts;
}
