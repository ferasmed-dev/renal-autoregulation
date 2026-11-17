// Run with:  node --test   (or: npm test)
import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as M from '../src/model.js';

const P = (o = {}) => M.withParams(o);
const H = (o = {}) => M.haemodynamics(P(o), 0);
const at = (traj, hours, dt = 0.25) => traj[Math.round(hours / dt)];

test('healthy steady state: GFR 125 mL/min, RBF 1, P_GC 55 mmHg, urine ≈ 1 mL/kg/h', () => {
  const s = M.initialState(P());
  assert.ok(Math.abs(s.gfr - 125) < 0.5);
  assert.ok(Math.abs(s.rbf - 1) < 1e-6);
  assert.ok(Math.abs(s.P_GC - 55) < 1e-6);
  assert.ok(s.uo > 0.9 && s.uo < 1.3, `UO ${s.uo}`);
  assert.equal(s.stage, 0);
  assert.ok(Math.abs(s.cr - 1) < 1e-9);
});

test('autoregulation: GFR and RBF flat across 93–180 mmHg, roughly kept down to 80, fall below', () => {
  for (const m of [100, 120, 150, 180]) {
    assert.ok(Math.abs(H({ MAP: m }).gfr - 125) < 1, `MAP ${m}`);
    assert.ok(Math.abs(H({ MAP: m }).rbf - 1) < 0.01);
  }
  assert.ok(H({ MAP: 80 }).gfr > 0.85 * 125, 'kept within ~15 % at the lower limit');
  assert.ok(H({ MAP: 70 }).gfr < 0.7 * 125, 'falls below the autoregulatory range');
  assert.ok(H({ MAP: 60 }).gfr < H({ MAP: 70 }).gfr);
  assert.ok(H({ MAP: 50 }).gfr < 10);
});

test('low perfusion: PG dilate the afferent and Ang II constricts the efferent', () => {
  const low = H({ MAP: 85, volume: 0.75 });
  assert.ok(low.pgEff > 0 && low.angII > 1);
  assert.ok(low.Re > 1, 'efferent constricted');
});

test('NSAID or ACEi alone barely matter in a well-perfused kidney', () => {
  assert.ok(Math.abs(H({ nsaid: true }).gfr - 125) < 1);
  assert.ok(Math.abs(H({ acei: true }).gfr - 125) < 1);
});

test('with reduced perfusion, NSAID ↓ GFR (afferent closes) and ACEi ↓ GFR (efferent opens); both together worst', () => {
  const base = { MAP: 85, volume: 0.75 };
  const b = H(base), n = H({ ...base, nsaid: true }), a = H({ ...base, acei: true }), both = H({ ...base, nsaid: true, acei: true });
  assert.ok(n.gfr < 0.75 * b.gfr, `NSAID ${b.gfr} → ${n.gfr}`);
  assert.ok(n.Ra > b.Ra, 'NSAID: afferent resistance up');
  assert.ok(a.gfr < 0.9 * b.gfr, `ACEi ${b.gfr} → ${a.gfr}`);
  assert.ok(a.Re < b.Re, 'ACEi: efferent resistance down');
  assert.ok(both.gfr < Math.min(n.gfr, a.gfr));
});

test('below the lower limit the sympathetic system constricts the afferent', () => {
  assert.ok(H({ MAP: 60 }).symp > H({ MAP: 85 }).symp);
  assert.ok(H({ MAP: 60 }).Ra > H({ MAP: 80 }).Ra);
});

test('urine indices: prerenal looks functional, ATN looks established, diuretics confound FENa', () => {
  const pre = M.observe(0, 1, 0, P({ MAP: 68 }));
  assert.equal(pre.indices, 'functional');
  assert.ok(pre.fena < 1 && pre.uNa < 20 && pre.uCrPCr > 40 && pre.ifr < 1);
  const atn = M.observe(0, 5, 0.65, P({ MAP: 85 }));
  assert.equal(atn.indices, 'established');
  assert.ok(atn.fena > 1 && atn.uNa > 20 && atn.uCrPCr < 30);
  const diur = M.observe(0, 1, 0, P({ MAP: 85, volume: 0.8, diuretic: true }));
  assert.ok(diur.fena > 1, 'FENa > 1 % despite a purely prerenal state');
});

test('KDIGO staging from creatinine and urine output', () => {
  const mk = (pts) => pts.map(([t, cr, uo = 1]) => ({ t, cr, uo }));
  assert.equal(M.kdigoStage(mk([[0, 1], [24, 1.2]])).stage, 0);
  assert.equal(M.kdigoStage(mk([[0, 1], [24, 1.3]])).crStage, 1, '≥0.3 within 48 h');
  assert.equal(M.kdigoStage(mk([[0, 1], [60, 1.25], [100, 1.5]])).crStage, 1, '×1.5 within 7 days');
  assert.equal(M.kdigoStage(mk([[0, 1], [48, 2.1]])).crStage, 2);
  assert.equal(M.kdigoStage(mk([[0, 1], [48, 3.0]])).crStage, 3);
  assert.equal(M.kdigoStage(mk([[0, 2.5], [24, 4.1]])).crStage, 3, '≥4.0 with an acute rise');
  const uo = (val, hours) => mk(Array.from({ length: hours * 4 + 1 }, (_, i) => [i / 4, 1, val]));
  assert.equal(M.kdigoStage(uo(0.4, 6)).uoStage, 1);
  assert.equal(M.kdigoStage(uo(0.4, 12)).uoStage, 2);
  assert.equal(M.kdigoStage(uo(0.2, 24)).uoStage, 3);
  assert.equal(M.kdigoStage(uo(0, 12)).uoStage, 3, 'anuria 12 h');
  assert.equal(M.kdigoStage(uo(0.4, 5)).uoStage, 0, 'not enough time observed');
});

test('creatinine lags behind GFR (kinetics)', () => {
  const tr = M.simulatePreset({ params: {}, events: [{ t: 1, set: { MAP: 65 } }] }, 48);
  assert.ok(at(tr, 1.5).gfr < 60, 'GFR falls at once');
  assert.ok(at(tr, 2).cr < 1.2, 'creatinine has barely moved after 1 h');
  assert.ok(at(tr, 25).cr > 1.5, 'and is clearly up after a day');
});

test('values never negative or NaN in extreme settings', () => {
  const tr = M.simulatePreset({ params: { MAP: 30, volume: 0.3, nsaid: true, acei: true, diuretic: true }, events: [] }, 200, 0.5);
  for (const s of tr) {
    for (const k of ['gfr', 'rbf', 'cr', 'uo', 'D', 'P_GC']) assert.ok(Number.isFinite(s[k]) && s[k] >= 0, `${k}=${s[k]}`);
    assert.ok(s.D <= 0.99);
  }
});

// ---------- presets ----------

test('preset healthy: stable for 21 days', () => {
  const tr = M.simulatePreset(M.PRESETS.healthy, 504);
  assert.ok(tr.every((s) => Math.abs(s.gfr - 125) < 0.5 && s.stage === 0 && s.D === 0));
});

test('preset triple whammy: NSAID added → prerenal AKI without tubular injury; reverses after stopping', () => {
  const tr = M.simulatePreset(M.PRESETS.tripleWhammy, 240);
  const before = at(tr, 23), after = at(tr, 30);
  assert.ok(after.gfr < 0.6 * before.gfr, `GFR ${before.gfr} → ${after.gfr}`);
  assert.ok(at(tr, 95).stage >= 1, 'KDIGO AKI');
  assert.ok(tr.every((s) => s.D < 0.05), 'functional, no ATN');
  assert.ok(at(tr, 95).fena > 1, 'FENa misleadingly > 1 % because of the diuretic');
  assert.ok(at(tr, 144).gfr > 120 && at(tr, 144).stage === 0, 'recovers within ~2 days of stopping');
});

test('preset brief shock: prerenal fall, little injury, back to baseline in days', () => {
  const tr = M.simulatePreset(M.PRESETS.briefShock, 504);
  assert.ok(at(tr, 15).gfr < 20);
  const maxD = Math.max(...tr.map((s) => s.D));
  assert.ok(maxD > 0.02 && maxD < 0.2, `max injury ${maxD}`);
  assert.ok(at(tr, 168).stage === 0);
});

test('preset prolonged shock: ATN with KDIGO 3, established indices, recovery in ~10–15 days', () => {
  const tr = M.simulatePreset(M.PRESETS.prolongedShock, 504);
  const maxD = Math.max(...tr.map((s) => s.D));
  assert.ok(maxD > 0.45, `max injury ${maxD}`);
  assert.ok(tr.some((s) => s.stage === 3));
  assert.equal(at(tr, 72).indices, 'established');
  assert.ok(at(tr, 74).gfr < 40, 'GFR stays low after perfusion is restored (maintenance)');
  assert.ok(at(tr, 336).D < 0.05 && at(tr, 336).gfr > 100, 'mostly recovered by day 14');
  assert.ok(at(tr, 168).D > 0.1, 'not yet by day 7');
});

test('preset MAP 65 target: below the autoregulatory range → prerenal, then slow injury', () => {
  const tr = M.simulatePreset(M.PRESETS.icuTarget65, 504);
  assert.equal(at(tr, 14).indices, 'functional');
  assert.ok(at(tr, 14).gfr < 60);
  assert.ok(at(tr, 84).D > 0.1, 'sustained hypoperfusion starts tubular injury');
  assert.ok(at(tr, 504).D < 0.02);
});

test('counterfactual: no drugs keeps GFR up in the triple-whammy scenario', () => {
  const tx = M.simulatePreset(M.PRESETS.tripleWhammy, 96);
  const cf = M.simulatePreset(M.PRESETS.tripleWhammy, 96, 0.25, { nsaid: false, acei: false, diuretic: false });
  assert.ok(at(cf, 60).gfr > 1.5 * at(tx, 60).gfr);
});

test('model functions are pure', () => {
  const p = P({ MAP: 70 });
  const copy = JSON.stringify(p);
  const a = M.simulatePreset(M.PRESETS.briefShock, 24);
  const b = M.simulatePreset(M.PRESETS.briefShock, 24);
  M.haemodynamics(p);
  assert.equal(JSON.stringify(p), copy);
  assert.deepEqual(a, b);
});
