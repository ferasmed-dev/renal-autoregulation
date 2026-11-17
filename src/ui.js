// ui.js — DOM, animation loop, explanations and language switch.
// All physiology lives in model.js; all text lives in i18n.js.
import * as M from './model.js';
import { LineChart } from './charts.js';
import { DICT, LANGS } from './i18n.js';

const DT = 0.25; // hours per Euler step
const $ = (id) => document.getElementById(id);
const GFR0 = M.DEFAULTS.GFR_HEALTHY;

// ---------------------------------------------------------------- language
let lang = pickLang();
function pickLang() {
  const q = new URLSearchParams(location.search).get('lang');
  if (q && DICT[q]) return q;
  try { const s = localStorage.getItem('ra-lang'); if (s && DICT[s]) return s; } catch { /* storage unavailable */ }
  return (navigator.language || 'es').toLowerCase().startsWith('es') ? 'es' : 'en';
}
const T = (key, args) => { const v = DICT[lang][key] ?? DICT.es[key] ?? key; return typeof v === 'function' ? v(args || {}) : v; };
const nf = (v, d = 0) => (Number.isFinite(v) ? v.toLocaleString(LANGS[lang], { minimumFractionDigits: d, maximumFractionDigits: d }) : '—');
const signedPct = (frac) => `${frac >= 0 ? '+' : '−'}${nf(Math.abs(frac) * 100)} %`;
const stageName = (n) => (n ? T('stage.n', { n }) : T('stage.0'));

function updateUrl() {
  const url = new URL(location.href);
  url.searchParams.set('lang', lang);
  if (activePreset) url.searchParams.set('preset', activePreset); else url.searchParams.delete('preset');
  history.replaceState(null, '', url);
}

function setLang(l) {
  lang = l;
  try { localStorage.setItem('ra-lang', l); } catch { /* ignore */ }
  updateUrl();
  applyStaticText();
  setupCharts();
  syncControls();
  renderLog();
  setPlaying(playing);
  $('cycle').replaceChildren();
  render(true);
}

function applyStaticText() {
  document.documentElement.lang = lang;
  document.title = T('doc.title');
  document.querySelector('meta[name="description"]').setAttribute('content', T('doc.desc'));
  document.querySelectorAll('[data-i18n]').forEach((el) => { el.innerHTML = T(el.dataset.i18n); });
  document.querySelectorAll('[data-i18n-aria]').forEach((el) => el.setAttribute('aria-label', T(el.dataset.i18nAria)));
  $('normals-list').innerHTML = T('normals.list').map((li) => `<li>${li}</li>`).join('');
  document.querySelectorAll('[data-lang]').forEach((b) => b.setAttribute('aria-pressed', String(b.dataset.lang === lang)));
  document.querySelectorAll('.btn.preset').forEach((b) => { b.textContent = T(`p.${b.dataset.key}`); });
  $('btn-link').textContent = T('deeplink');
  if (G.svg) {
    G.svg.setAttribute('aria-label', T('g.aria'));
    G.static.forEach(([el, key]) => { el.textContent = T(key); });
  }
}

// ---------------------------------------------------------------- state
const ui = { speed: 6, horizonDays: 21, showCf: true };
let params = { ...M.DEFAULTS };
let state, cfState, hist, cfHist, khist, cfKhist, playing = false, drugsEver = false;
let activePreset = null, pendingEvents = [], prev = null, logEntries = [];

const cfParams = () => ({ ...params, nsaid: false, acei: false, diuretic: false });

// ---------------------------------------------------------------- controls
const SLIDERS = [
  { id: 's-map', key: 'MAP', out: 'o-map', label: 'name.MAP', fmt: (v) => `${nf(v)} mmHg` },
  { id: 's-vol', key: 'volume', out: 'o-vol', label: 'name.volume', fmt: (v) => `${nf(v * 100)} %` },
  { id: 'a-isch', key: 'ischemiaRBF', out: 'o-isch', label: 'a.isch', fmt: (v) => `${nf(v * 100)} %` },
  { id: 'a-kinj', key: 'kInjury', out: 'o-kinj', label: 'a.kinj', fmt: (v) => `${nf(v, 3)} ${T('u.perh')}` },
  { id: 'a-repair', key: 'repairHours', out: 'o-repair', label: 'a.repair', fmt: (v) => `${nf(v)} ${T('u.h')}` },
  { id: 'a-pg', key: 'pgGain', out: 'o-pg', label: 'a.pg', fmt: (v) => nf(v, 2) },
  { id: 'a-ang', key: 'effAng', out: 'o-ang', label: 'a.ang', fmt: (v) => nf(v, 2) },
  { id: 'a-weight', key: 'weightKg', out: 'o-weight', label: 'a.weight', fmt: (v) => `${nf(v)} kg`, resets: true },
  { id: 'a-cr0', key: 'baselineCr', out: 'o-cr0', label: 'a.cr0', fmt: (v) => `${nf(v, 2)} mg/dL`, resets: true },
];
const UI_SLIDERS = [
  { id: 's-speed', key: 'speed', out: 'o-speed', fmt: (v) => `${nf(v)} ${T('u.hps')}` },
  { id: 'a-horizon', key: 'horizonDays', out: 'o-horizon', fmt: (v) => `${nf(v)} ${T('u.days')}` },
];
const DRUGS = [['t-nsaid', 'nsaid'], ['t-acei', 'acei'], ['t-diuretic', 'diuretic']];

function syncControls() {
  for (const s of SLIDERS) { $(s.id).value = params[s.key]; $(s.out).textContent = s.fmt(params[s.key]); }
  for (const s of UI_SLIDERS) { $(s.id).value = ui[s.key]; $(s.out).textContent = s.fmt(ui[s.key]); }
  for (const [id, key] of DRUGS) $(id).checked = params[key];
  $('t-cf').checked = ui.showCf;
  document.querySelectorAll('.btn.preset').forEach((b) => b.setAttribute('aria-pressed', String(b.dataset.key === activePreset)));
  $('preset-expect').innerHTML = activePreset ? `${T('expected')} ${T(`pe.${activePreset}`)}` : '';
  $('btn-link').hidden = !activePreset;
}

function setupControls() {
  for (const s of SLIDERS) {
    let before = null;
    $(s.id).addEventListener('input', (e) => {
      if (!before) before = state;
      params = { ...params, [s.key]: +e.target.value };
      $(s.out).textContent = s.fmt(params[s.key]);
      if (s.resets) { clearPreset(); reset(); before = null; return; }
      paramsChanged(null);
    });
    $(s.id).addEventListener('change', () => {
      if (s.resets || !before) { before = null; return; }
      const b = before, a = state, v = params[s.key];
      before = null;
      clearPreset();
      addLog(a.t, () => T('log.param', { what: `${T(s.label).replace(/<[^>]+>/g, '')} → ${s.fmt(v)}`, g0: nf(b.gfr), g1: nf(a.gfr) }));
    });
  }
  for (const s of UI_SLIDERS) {
    $(s.id).addEventListener('input', (e) => {
      ui[s.key] = +e.target.value;
      $(s.out).textContent = s.fmt(ui[s.key]);
      if (s.key === 'horizonDays') { setPlaying(playing); render(true); }
    });
  }
  for (const [id, key] of DRUGS) $(id).addEventListener('change', (e) => { pendingEvents = []; clearPreset(); setDrug(key, e.target.checked); });
  $('t-cf').addEventListener('change', (e) => { ui.showCf = e.target.checked; render(true); });
  $('btn-play').addEventListener('click', () => setPlaying(!playing));
  $('btn-reset').addEventListener('click', () => { if (activePreset) loadPreset(activePreset, false); else reset(); });
  $('btn-defaults').addEventListener('click', () => {
    const keep = { MAP: params.MAP, volume: params.volume, nsaid: params.nsaid, acei: params.acei, diuretic: params.diuretic };
    params = { ...M.DEFAULTS, ...keep };
    ui.horizonDays = 21; syncControls(); paramsChanged(() => T('log.defaults'));
  });
  $('btn-link').addEventListener('click', async () => {
    const url = new URL(location.href);
    url.searchParams.set('preset', activePreset); url.searchParams.set('lang', lang);
    try { await navigator.clipboard.writeText(url.toString()); $('btn-link').textContent = T('copied'); } catch { /* clipboard unavailable */ }
    setTimeout(() => { $('btn-link').textContent = T('deeplink'); }, 1500);
  });
  const row = $('presets');
  for (const key of Object.keys(M.PRESETS)) {
    const b = document.createElement('button');
    b.type = 'button'; b.className = 'btn preset'; b.dataset.key = key;
    b.addEventListener('click', () => loadPreset(key));
    row.appendChild(b);
  }
  document.querySelectorAll('[data-lang]').forEach((b) => b.addEventListener('click', () => setLang(b.dataset.lang)));
  document.addEventListener('keydown', (e) => {
    if (e.target.matches('input, textarea, select, button, summary')) return;
    if (e.code === 'Space') { e.preventDefault(); setPlaying(!playing); }
  });
}

function clearPreset() { if (activePreset) { activePreset = null; syncControls(); updateUrl(); } }

function loadPreset(key, autoplay = true) {
  const pr = M.PRESETS[key];
  params = { ...M.DEFAULTS, ...pr.params, weightKg: params.weightKg, baselineCr: params.baselineCr };
  activePreset = key;
  syncControls();
  reset();
  pendingEvents = (pr.events || []).map((e) => ({ ...e }));
  for (const ev of pendingEvents) {
    addLog(0, () => T('log.scheduled', { what: describeSet(ev.set), t: nf(ev.t) }));
  }
  updateUrl();
  setPlaying(autoplay);
}

function describeSet(set) {
  return Object.entries(set).map(([k, v]) => {
    if (typeof v === 'boolean') return `${T(`name.${k}`)} ${T(v ? 'on' : 'off')}`;
    if (k === 'MAP') return `${T('name.MAP')} ${nf(v)} mmHg`;
    if (k === 'volume') return `${T('name.volume')} ${nf(v * 100)} %`;
    return `${k} ${v}`;
  }).join(', ');
}

function setPlaying(on) {
  const done = state.t >= ui.horizonDays * 24 - 1e-9;
  playing = on && !done;
  const b = $('btn-play');
  b.textContent = playing ? T('pause') : (done ? T('end') : T('play'));
  b.setAttribute('aria-pressed', String(playing));
}

// ---------------------------------------------------------------- simulation
function withStage(s, kh) { return { ...s, ...M.kdigoStage(kh) }; }

function reset() {
  state = M.initialState(params);
  cfState = M.initialState(cfParams());
  hist = [state]; cfHist = [cfState];
  khist = [{ t: 0, cr: state.cr, uo: state.uo }];
  cfKhist = [{ t: 0, cr: cfState.cr, uo: cfState.uo }];
  drugsEver = params.nsaid || params.acei || params.diuretic;
  pendingEvents = [];
  prev = { stage: state.stage, phase: state.phase, oligo: state.uo < 0.5, belowLLA: params.MAP < params.LLA, injured: state.D > 0.02, tFall: null, lagLogged: false, gfrStart: state.gfr };
  logEntries = [];
  const s0 = state, map0 = params.MAP;
  addLog(0, () => T('log.start', { gfr: nf(s0.gfr), cr: nf(s0.cr, 2), map: nf(map0) }));
  if (map0 < params.LLA) addLog(0, () => T('log.lla', { map: nf(map0) }), 'warn');
  setPlaying(false);
  render(true);
}

/** Live parameter change: vessels respond immediately (same t, creatinine and injury). */
function paramsChanged(what) {
  const before = state;
  state = withStage(M.observe(state.t, state.cr, state.D, params, { lastIschaemiaT: state.lastIschaemiaT }), khist);
  state.phase = M.phase(state, before.D);
  cfState = withStage(M.observe(cfState.t, cfState.cr, cfState.D, cfParams(), { lastIschaemiaT: cfState.lastIschaemiaT }), cfKhist);
  hist.push(state); cfHist.push(cfState);
  const after = state;
  if (what) addLog(after.t, () => T('log.param', { what: what(), g0: nf(before.gfr), g1: nf(after.gfr) }));
  checkTransitions();
  render(true);
}

function setDrug(key, on, fromEvent = false) {
  const before = state;
  params = { ...params, [key]: on };
  if (on) drugsEver = true;
  if (fromEvent) syncControls();
  paramsChanged(null);
  const after = state;
  if (on) addLog(after.t, () => T('log.drugOn', { name: T(`name.${key}`), g0: nf(before.gfr), g1: nf(after.gfr), d: signedPct(after.gfr / Math.max(1e-9, before.gfr) - 1) }), 'tx');
  else addLog(after.t, () => T('log.drugOff', { name: T(`name.${key}`), g0: nf(before.gfr), g1: nf(after.gfr) }));
}

function applyDueEvents() {
  for (const ev of pendingEvents) {
    if (ev.done || state.t < ev.t - 1e-9) continue;
    ev.done = true;
    const before = state;
    const drugs = Object.entries(ev.set).filter(([k]) => ['nsaid', 'acei', 'diuretic'].includes(k));
    const other = Object.fromEntries(Object.entries(ev.set).filter(([k]) => !['nsaid', 'acei', 'diuretic'].includes(k)));
    for (const [k, v] of drugs) if (params[k] !== v) setDrug(k, v, true);
    if (Object.keys(other).length) {
      params = { ...params, ...other };
      syncControls();
      const desc = describeSet(other);
      paramsChanged(null);
      const after = state;
      addLog(after.t, () => T('log.param', { what: desc, g0: nf(before.gfr), g1: nf(after.gfr) }));
    }
  }
}

function stepOnce() {
  applyDueEvents();
  state = M.step(state, params, DT, khist);
  khist.push({ t: state.t, cr: state.cr, uo: state.uo });
  cfState = M.step(cfState, cfParams(), DT, cfKhist);
  cfKhist.push({ t: cfState.t, cr: cfState.cr, uo: cfState.uo });
  hist.push(state); cfHist.push(cfState);
  checkTransitions();
}

function checkTransitions() {
  const s = state;
  const below = params.MAP < params.LLA;
  if (below !== prev.belowLLA) { const map = params.MAP; addLog(s.t, below ? () => T('log.lla', { map: nf(map) }) : () => T('log.llaOk', { map: nf(map) }), below ? 'warn' : 'tx'); }
  if (prev.tFall == null && s.gfr < 0.75 * prev.gfrStart) prev.tFall = s.t;
  if (s.stage !== prev.stage) {
    const a = prev.stage, b = s.stage, cr = s.cr, uo = s.uo;
    const why = b > a ? (s.crStage >= b && s.uoStage >= b ? 'why.both' : s.crStage >= b ? 'why.cr' : 'why.uo') : null;
    addLog(s.t, () => T('log.stage', { a: stageName(a), b: stageName(b), cr: nf(cr, 2), uo: nf(uo, 2), why: why ? T(why) : '' }), b > a ? 'warn' : 'tx');
  }
  if (!prev.lagLogged && s.crStage >= 1 && prev.tFall != null) {
    prev.lagLogged = true; const h = s.t - prev.tFall;
    addLog(s.t, () => T('log.lag', { h: nf(h, 1) }));
  }
  const oligo = s.uo < 0.5;
  if (oligo !== prev.oligo) { const uo = s.uo; addLog(s.t, oligo ? () => T('log.oligo', { uo: nf(uo, 2) }) : () => T('log.oligoEnd', { uo: nf(uo, 2) }), oligo ? 'warn' : 'tx'); }
  const injured = s.D > 0.02;
  if (injured && !prev.injured) addLog(s.t, () => T('log.injury'), 'warn');
  if (s.phase !== prev.phase) { const a = prev.phase, b = s.phase; addLog(s.t, () => T('log.phase', { a: T(`phase.${a}`), b: T(`phase.${b}`) })); }
  prev = { ...prev, stage: s.stage, phase: s.phase, oligo, belowLLA: below, injured: injured || prev.injured };
}

/** Log entries keep a text factory so they can be re-rendered in another language. */
function addLog(t, make, cls = '') {
  logEntries.push({ t, make, cls });
  $('log').prepend(logItem(logEntries[logEntries.length - 1]));
}
function logItem(e) {
  const li = document.createElement('li');
  if (e.cls) li.className = e.cls;
  li.innerHTML = `<b>${T('log.year', { t: nf(e.t, 1) })}</b> · ${e.make()}`;
  return li;
}
function renderLog() { $('log').replaceChildren(...logEntries.slice().reverse().map(logItem)); }

// ---------------------------------------------------------------- schematic SVG
const NS = 'http://www.w3.org/2000/svg';
const svgEl = (tag, attrs = {}, parent) => {
  const n = document.createElementNS(NS, tag);
  for (const [k, v] of Object.entries(attrs)) n.setAttribute(k, v);
  if (parent) parent.appendChild(n);
  return n;
};
const SUB = (base, sub) => `${base}<tspan baseline-shift="sub" font-size="72%">${sub}</tspan>`;

const AFF = 'M10,150 L212,150';
const TUFT = 'M212,150 C250,150 242,92 282,88 C322,84 300,140 322,128 C344,116 330,74 362,84 C398,96 362,150 392,168 C418,184 398,240 360,236 C324,232 348,196 314,206 C282,216 300,252 264,236 C232,222 246,184 276,180 C304,176 300,160 330,156 C368,151 398,150 428,150';
const EFF = 'M428,150 L630,150';
const TUBULE = 'M372,268 C392,296 420,304 470,310 C520,316 560,312 630,316';
const RE0 = 1; // haemodynamics() returns Re already normalised to healthy

const G = {};
function buildSchematic() {
  const svg = svgEl('svg', { viewBox: '0 -34 640 470', role: 'img' });
  G.svg = svg;
  $('glomerulus').appendChild(svg);
  svgEl('circle', { cx: 320, cy: 165, r: 118, fill: 'var(--surface-2)', stroke: 'var(--capsule)', 'stroke-width': 3 }, svg);
  svgEl('path', { d: TUBULE, fill: 'none', stroke: 'var(--capsule)', 'stroke-width': 30 }, svg);
  svgEl('path', { d: 'M350,240 ' + TUBULE.replace('M372,268', 'L372,268'), fill: 'none', stroke: 'var(--surface-2)', 'stroke-width': 24 }, svg);
  G.affWall = svgEl('path', { d: AFF, fill: 'none', stroke: 'var(--wall)' }, svg);
  G.effWall = svgEl('path', { d: EFF, fill: 'none', stroke: 'var(--wall)' }, svg);
  svgEl('path', { d: TUFT, fill: 'none', stroke: 'var(--wall)', 'stroke-width': 13, 'stroke-linecap': 'round', 'stroke-linejoin': 'round' }, svg);
  G.affLumen = svgEl('path', { d: AFF, fill: 'none', stroke: 'var(--blood-2)' }, svg);
  G.effLumen = svgEl('path', { d: EFF, fill: 'none', stroke: 'var(--blood-2)' }, svg);
  G.tuftLumen = svgEl('path', { d: TUFT, fill: 'none', stroke: 'var(--blood-2)', 'stroke-width': 8, 'stroke-linecap': 'round', 'stroke-linejoin': 'round' }, svg);
  G.pgG = svgEl('g', {}, svg); G.sympG = svgEl('g', {}, svg); G.angG = svgEl('g', {}, svg);
  G.blood = svgEl('g', {}, svg); G.filt = svgEl('g', {}, svg);
  G.route = svgEl('path', { d: AFF + ' ' + TUFT.replace('M212,150', 'L212,150') + ' ' + EFF.replace('M428,150', 'L428,150'), fill: 'none', stroke: 'none' }, svg);
  G.tuftPath = svgEl('path', { d: TUFT, fill: 'none', stroke: 'none' }, svg);
  G.tubPath = svgEl('path', { d: TUBULE, fill: 'none', stroke: 'none' }, svg);
  const text = (x, y, cls = '', anchor = 'start') => svgEl('text', { x, y, class: cls, 'text-anchor': anchor }, svg);
  G.static = [[text(16, 100), 'g.aff'], [text(624, 100, '', 'end'), 'g.eff'], [text(320, -16, 'lbl-2', 'middle'), 'g.cap']];
  G.mapTxt = text(16, 82, 'lbl-2');
  G.pgcTxt = text(320, 6, 'lbl-big', 'middle');
  G.gfrTxt = text(630, 300, '', 'end');
  G.raTxt = text(16, 215, 'lbl-2'); G.reTxt = text(624, 215, 'lbl-2', 'end');
  G.pgLbl = text(16, 232, 'lbl-2'); G.sympLbl = text(16, 248, 'lbl-2'); G.angLbl = text(624, 232, 'lbl-2', 'end');
  G.static.push([G.pgLbl, 'g.pg'], [G.sympLbl, 'g.symp'], [G.angLbl, 'g.ang']);
  G.nsaidX = text(16, 264, 'lbl-blocked'); G.aceiX = text(624, 248, 'lbl-blocked', 'end');
  // cortex / outer medulla strip
  const y0 = 340;
  G.cortex = svgEl('rect', { x: 10, y: y0, width: 620, height: 34, rx: 6, fill: 'var(--band-g1)' }, svg);
  G.medulla = svgEl('rect', { x: 10, y: y0 + 38, width: 620, height: 46, rx: 6, fill: 'var(--band-g1)' }, svg);
  G.static.push([text(20, y0 + 22), 'g.cortex'], [text(20, y0 + 66), 'g.medulla']);
  G.cells = [];
  for (let i = 0; i < 22; i++) G.cells.push(svgEl('rect', { x: 250 + i * 17, y: y0 + 50, width: 14, height: 22, rx: 3 }, svg));
  G.len = G.route.getTotalLength(); G.tuftLen = G.tuftPath.getTotalLength(); G.tubLen = G.tubPath.getTotalLength();
  G.tubStart = G.tubPath.getPointAtLength(0);
  G.bloodDots = [];
  for (let i = 0; i < 34; i++) G.bloodDots.push({ el: svgEl('circle', { r: 3.4, fill: 'var(--blood)' }, G.blood), s: (i / 34) * G.len });
  G.filtDots = []; G.emitAcc = 0;
}

function glyphs(group, n, x0, x1, y, shape, color) {
  group.replaceChildren();
  for (let i = 0; i < n; i++) {
    const x = x0 + ((i + 0.5) / Math.max(1, n)) * (x1 - x0);
    if (shape === 'plus') {
      svgEl('circle', { cx: x, cy: y, r: 6, fill: color }, group);
      svgEl('path', { d: `M${x - 3.5},${y} H${x + 3.5} M${x},${y - 3.5} V${y + 3.5}`, stroke: '#fff', 'stroke-width': 2 }, group);
    } else {
      svgEl('path', { d: `M${x - 5},${y + 4} L${x},${y - 5} L${x + 5},${y + 4} Z`, fill: color }, group);
    }
  }
}
function crossOut(group, x0, x1, y) {
  svgEl('path', { d: `M${x0},${y - 9} L${x1},${y + 9} M${x0},${y + 9} L${x1},${y - 9}`, class: 'glyph-x' }, group);
}

function vesselDims(Rrel) {
  const lumen = Math.max(4, Math.min(24, 13 * Math.pow(Rrel, -1.1)));
  const wall = Math.max(3, Math.min(14, 5 * Math.pow(Rrel, 0.9)));
  return { lumen, outer: lumen + 2 * wall };
}

function mix(a, b, t) { return a.map((v, i) => Math.round(v + (b[i] - v) * t)); }

function drawSchematic(s) {
  const a = vesselDims(s.Ra), e = vesselDims(s.Re / RE0);
  G.affLumen.setAttribute('stroke-width', a.lumen); G.affWall.setAttribute('stroke-width', a.outer);
  G.effLumen.setAttribute('stroke-width', e.lumen); G.effWall.setAttribute('stroke-width', e.outer);
  const press = Math.max(0, Math.min(1, (s.P_GC - 35) / 25));
  G.tuftLumen.setAttribute('stroke-width', (5 + 4 * press).toFixed(1));
  const nPg = Math.min(5, Math.round((s.pg / 0.6) * 5));
  const nSymp = Math.min(5, Math.round((s.symp / 1.2) * 5));
  const nAng = Math.min(6, Math.round(((s.angII - 1) / 0.75) * 6));
  glyphs(G.pgG, nPg, 30, 200, 150 + a.outer / 2 + 12, 'plus', '#2a78d6');
  glyphs(G.sympG, nSymp, 30, 200, 150 - a.outer / 2 - 10, 'tri', '#e2733f');
  glyphs(G.angG, nAng, 440, 610, 150 - e.outer / 2 - 10, 'tri', '#7b5cd6');
  if (params.nsaid && nPg) crossOut(G.pgG, 30, 200, 150 + a.outer / 2 + 12);
  if (params.acei && nAng) crossOut(G.angG, 440, 610, 150 - e.outer / 2 - 10);
  G.nsaidX.textContent = params.nsaid ? `${T('name.nsaid')}: PG ${T('g.blocked')}` : '';
  G.aceiX.textContent = params.acei ? `${T('name.acei')}: Ang II ${T('g.blocked')}` : '';
  G.mapTxt.textContent = T('g.map', { v: nf(params.MAP) });
  G.raTxt.textContent = `Ra ×${nf(s.Ra, 2)}`;
  G.reTxt.textContent = `Re ×${nf(s.Re, 2)}`;
  G.pgcTxt.innerHTML = `${SUB('P', 'GC')} = ${nf(s.P_GC, 1)} mmHg`;
  G.gfrTxt.textContent = T('g.gfr', { v: nf(s.gfr) });
  // medulla colour: green (well oxygenated) → dark red (ischaemic)
  const hyp = Math.max(0, Math.min(1, (1 - s.rbf) / (1 - params.ischemiaRBF * 0.5)));
  const dark = matchMedia('(prefers-color-scheme: dark)').matches;
  const [r, g, b] = dark ? mix([43, 74, 39], [150, 40, 40], hyp) : mix([207, 232, 200], [176, 52, 52], hyp);
  G.medulla.setAttribute('fill', `rgb(${r},${g},${b})`);
  G.static.find(([, k]) => k === 'g.medulla')[0].setAttribute('style', !dark && hyp > 0.55 ? 'fill:#fff' : '');
  const nDead = Math.round(s.D * G.cells.length);
  G.cells.forEach((c, i) => {
    const dead = i < nDead;
    c.setAttribute('fill', dead ? '#8e1f2a' : '#f3d9c9');
    c.setAttribute('stroke', dead ? 'none' : '#b9705c');
    c.setAttribute('transform', dead ? `translate(0,${(i % 3) * 3}) rotate(${(i % 2 ? 12 : -10)} ${250 + i * 17 + 7} 401)` : '');
  });
  const o2 = Math.round(100 * Math.min(1, s.rbf));
  $('m-o2').style.width = `${o2}%`; $('m-o2-v').textContent = `${o2} %`;
  $('m-o2').style.background = s.ischaemic ? 'var(--g4)' : 'var(--accent)';
  $('m-inj').style.width = `${Math.round(s.D * 100)}%`; $('m-inj-v').textContent = `${nf(s.D * 100)} %`;
  const pb = $('phase-badge');
  pb.textContent = T(`phase.${s.phase}`);
  pb.className = `phase-badge ph-${s.phase}`;
}

function animateParticles(dtSec) {
  const s = state;
  const speed = 140 * Math.max(0.1, s.rbf);
  for (const d of G.bloodDots) {
    d.s = (d.s + speed * dtSec) % G.len;
    const p = G.route.getPointAtLength(d.s);
    d.el.setAttribute('cx', p.x.toFixed(1)); d.el.setAttribute('cy', p.y.toFixed(1));
  }
  G.emitAcc += dtSec * 7 * (s.gfr / GFR0);
  while (G.emitAcc >= 1 && G.filtDots.length < 120) {
    G.emitAcc -= 1;
    const p0 = G.tuftPath.getPointAtLength((0.12 + 0.76 * Math.random()) * G.tuftLen);
    G.filtDots.push({ el: svgEl('circle', { r: 2.6, fill: 'var(--filtrate)' }, G.filt), x0: p0.x, y0: p0.y, ph: 0, tl: 0 });
  }
  G.emitAcc = Math.min(G.emitAcc, 2);
  for (const f of G.filtDots) {
    if (f.ph < 1) {
      f.ph += dtSec / 1.6;
      const k = Math.min(1, f.ph), ease = k * k * (3 - 2 * k);
      f.el.setAttribute('cx', (f.x0 + (G.tubStart.x - f.x0) * ease).toFixed(1));
      f.el.setAttribute('cy', (f.y0 + (G.tubStart.y - f.y0) * ease + Math.sin(k * Math.PI) * 10).toFixed(1));
    } else {
      f.tl += dtSec * 120;
      const p = G.tubPath.getPointAtLength(Math.min(f.tl, G.tubLen));
      f.el.setAttribute('cx', p.x.toFixed(1)); f.el.setAttribute('cy', p.y.toFixed(1));
    }
  }
  G.filtDots = G.filtDots.filter((f) => { if (f.tl >= G.tubLen) { f.el.remove(); return false; } return true; });
}

// ---------------------------------------------------------------- explanations
function renderCycle(s) {
  const injuring = s.ischaemic || ['initiation', 'extension', 'maintenance'].includes(s.phase);
  const items = [
    [s.H > 0.2, s.H > 0.2 ? T('cy.1', { map: nf(params.MAP), vol: nf((params.volume - (params.diuretic ? params.diureticVolume : 0)) * 100) }) : T('cy.1off', { map: nf(params.MAP) })],
    [s.pg > 0.03, T('cy.2', { blocked: params.nsaid && s.pg > 0.03 })],
    [s.angII > 1.03, T('cy.3', { blocked: params.acei && s.angII > 1.03 })],
    [s.gfr < 0.85 * GFR0, s.gfr < 0.85 * GFR0 ? T(s.D > 0.05 ? 'cy.4atn' : 'cy.4low', { gfr: nf(s.gfr), p: nf(s.P_GC, 1) }) : T('cy.4ok', { gfr: nf(s.gfr), p: nf(s.P_GC, 1) })],
    [params.MAP < params.LLA, T('cy.5')],
    [injuring, T('cy.6', { o2: nf(100 * Math.min(1, s.rbf)) })],
    [s.phase === 'repair', T('cy.7', { d: nf(s.D * 100) })],
  ];
  const ol = $('cycle');
  if (!ol.children.length) items.forEach(() => ol.appendChild(document.createElement('li')));
  items.forEach(([on, html], i) => {
    const li = ol.children[i];
    li.classList.toggle('on', on);
    if (li.innerHTML !== html) li.innerHTML = html;
  });
  const parts = [];
  if (params.nsaid) parts.push(T('tn.nsaid'));
  if (params.acei) parts.push(T('tn.acei'));
  if (params.diuretic) parts.push(T('tn.diur'));
  if (params.MAP <= 72) parts.push(T('tn.icu'));
  if (s.D > 0.05) parts.push(T('tn.atn'));
  if (s.stage >= 3 && s.uo < 0.3) parts.push(T('tn.dialysis'));
  const tn = $('treat-note');
  tn.hidden = !parts.length;
  const html = parts.map((p) => `<p>${p}</p>`).join('');
  if (tn.innerHTML !== html) tn.innerHTML = html;
}

function renderTiles(s) {
  const uoLabel = s.uo < 0.05 ? T('tile.anuria') : s.uo < 0.5 ? T('tile.oliguria') : T('tile.ok');
  const tiles = [
    [T('tile.gfr'), `${nf(s.gfr)}<small>mL/min</small>`, T('tile.ofNormal', { v: nf((s.gfr / GFR0) * 100) })],
    [T('tile.rbf'), `${nf(s.rbf * 100)}<small>%</small>`, T('tile.ofNormal', { v: nf(s.rbf * 100) })],
    [T('tile.cr'), `${nf(s.cr, 2)}<small>mg/dL</small>`, `<span class="stage-chip k-${s.stage}">${stageName(s.stage)}</span>`],
    [T('tile.uo'), `${nf(s.uo, 2)}<small>mL/kg/h</small>`, uoLabel],
    [T('tile.inj'), `${nf(s.D * 100)}<small>%</small>`, T(`phase.${s.phase}`)],
  ];
  $('tiles').innerHTML = tiles.map(([k, v, d]) => `<div class="tile"><div class="k">${k}</div><div class="v">${v}</div><div class="d">${d}</div></div>`).join('');
}

function renderIndices(s) {
  const th = T('ix.th');
  const rows = [
    ['Na<sub>o</sub> (mEq/L)', nf(s.uNa), '&lt; 20', '&gt; 20', s.uNa < 20],
    [lang === 'es' ? 'EFNa (%)' : 'FENa (%)', nf(s.fena, 2), '&lt; 1 %', '&gt; 1 %', s.fena < 1],
    [lang === 'es' ? 'IFR' : 'RFI', nf(s.ifr, 2), '&lt; 1', '&gt; 1', s.ifr < 1],
    [lang === 'es' ? 'Cr<sub>o</sub> / Cr<sub>p</sub>' : 'U/P creatinine', nf(s.uCrPCr), '&gt; 40', '&lt; 20', s.uCrPCr > 40],
  ];
  const anuria = !Number.isFinite(s.uNa);
  $('ix-table').innerHTML = `<table class="ix"><thead><tr>${th.map((h) => `<th>${h}</th>`).join('')}</tr></thead><tbody>${
    rows.map(([n, v, f, e, isF]) => `<tr><td>${n}</td><td class="now">${v}</td><td class="${!anuria && isF ? 'hit' : ''}">${f}</td><td class="${!anuria && !isF ? 'hit' : ''}">${e}</td></tr>`).join('')
  }</tbody></table><span class="verdict v-${s.indices}">${T(`ix.verdict.${s.indices}`)}</span>`;
  $('ix-diuretic').hidden = !params.diuretic;
}

// ---------------------------------------------------------------- charts
let charts = null;
const hoverAll = (src) => (t) => Object.entries(charts).forEach(([k, c]) => { if ((k === 'curve') === (src === 'curve')) c.setHover(t); });
function setupCharts() {
  const time = {
    onHover: hoverAll('time'),
    labels: () => ({ x: T('x.days'), noTx: T('hover.noTx') }),
    hoverX: (d) => T('hover.day', { v: nf(d, 1) }),
    xTicks: (span) => (span <= 7 ? 1 : span <= 21 ? 3 : 5),
  };
  const defs = {
    curve: ['c-curve', { title: T('c.curve'), unit: '%', xMin: 40, yMax: 130, onHover: hoverAll('curve'),
      labels: () => ({ x: T('curve.x'), noTx: T('hover.noTx') }), hoverX: (m) => `${T('name.MAP')} ${nf(m)}`, xTicks: () => 20,
      xBands: [{ from: 80, to: 180, label: () => T('curve.range'), cls: 'b-range' }],
      xRefs: [{ x: 65, label: () => T('curve.icu'), cls: 'icu' }, { x: () => params.MAP, label: () => T('curve.now'), cls: 'now', top: true }],
      fmt: (v) => `${nf(v)} %`, tickFmt: (v) => nf(v) }],
    map: ['c-map', { ...time, title: T('c.map'), unit: 'mmHg', yMin: 30, yMax: 150, fmt: (v) => `${nf(v)} mmHg`,
      refs: [{ y: 80, label: () => T('ref.lla') }, { y: 65, label: () => T('curve.icu'), cls: 'icu' }] }],
    gfr: ['c-gfr', { ...time, title: T('c.gfr'), unit: 'mL/min', yMax: 140, fmt: (v) => `${nf(v)} mL/min`, refs: [{ y: 125, label: () => T('ref.healthy') }] }],
    cr: ['c-cr', { ...time, title: T('c.cr'), unit: 'mg/dL', yMax: (m) => Math.max(3, Math.ceil(m + 0.5)), fmt: (v) => `${nf(v, 2)} mg/dL`, tickFmt: (v) => nf(v, v < 10 && v % 1 ? 1 : 0) }],
    uo: ['c-uo', { ...time, title: T('c.uo'), unit: 'mL/kg/h', yMax: (m) => Math.max(1.6, Math.ceil(m * 5) / 5), fmt: (v) => `${nf(v, 2)} mL/kg/h`,
      tickFmt: (v) => nf(v, 1), bands: [{ from: 0, to: 0.5, label: '', cls: 'b-oligo' }], refs: [{ y: 0.5, label: () => T('ref.oligo') }, { y: 0.3, label: () => T('ref.03') }] }],
    fena: ['c-fena', { ...time, title: T('c.fena'), unit: '%', yMax: (m) => Math.max(3, Math.ceil(m)), fmt: (v) => `${nf(v, 2)} %`, tickFmt: (v) => nf(v, v % 1 ? 1 : 0), refs: [{ y: 1, label: () => T('ref.fena') }] }],
    inj: ['c-inj', { ...time, title: T('c.inj'), unit: '%', yMax: 100, fmt: (v) => `${nf(v)} %` }],
  };
  charts = {};
  for (const [k, [id, o]] of Object.entries(defs)) { $(id).replaceChildren(); charts[k] = new LineChart($(id), o); }
}

const phaseCls = (ph) => (ph === 'normal' ? 'ph-normal' : ph === 'prerenal' ? 'ph-prerenal' : ph === 'repair' ? 'ph-repair' : 'ph-atn');

function renderCharts() {
  const cfOn = ui.showCf && drugsEver;
  $('cf-legend').hidden = !cfOn;
  const xMax = ui.horizonDays;
  const every = Math.max(1, Math.ceil(hist.length / 700));
  const thin = (h) => h.filter((_, i) => i % every === 0 || i === h.length - 1);
  const H = thin(hist), C = thin(cfHist);
  const mk = (h, f, cls) => h.map((s) => [s.t / 24, f(s), cls?.(s)]);
  const S = (f, colour) => ({ pts: mk(H, f, colour), cls: 's-main' });
  const CF = (f) => ({ pts: mk(C, f), cls: 's-cf', dashed: true });
  const both = (f, colour) => (cfOn ? [CF(f), S(f, colour)] : [S(f, colour)]);
  charts.map.update([S((s) => s.MAP)], xMax);
  charts.gfr.update(both((s) => s.gfr, (s) => phaseCls(s.phase)), xMax);
  charts.cr.update(both((s) => s.cr, (s) => `k-${s.stage}`), xMax);
  charts.uo.update(both((s) => s.uo), xMax);
  charts.fena.update(both((s) => s.fena), xMax);
  charts.inj.update(both((s) => s.D * 100), xMax);
  // steady-state autoregulation curve for the current drugs/volume
  const curve = M.autoregulationCurve(params, 40, 150, 2);
  const series = [
    { pts: curve.map((c) => [c.MAP, (c.rbf) * 100]), cls: 's-rbf', noValue: true },
    { pts: curve.map((c) => [c.MAP, (c.gfr / GFR0) * 100]), cls: 's-main', noValue: true },
  ];
  if (ui.showCf && (params.nsaid || params.acei || params.diuretic)) {
    const cfc = M.autoregulationCurve(cfParams(), 40, 150, 2);
    series.unshift({ pts: cfc.map((c) => [c.MAP, (c.gfr / GFR0) * 100]), cls: 's-cf', dashed: true });
  }
  const now = M.haemodynamics(params, 0);
  series.push({ pts: [[Math.max(40, Math.min(150, params.MAP)), (now.gfr / GFR0) * 100]], cls: 's-main', marker: true });
  charts.curve.update(series, 150, 40);
  charts.curve.valueEl.textContent = `${T('curve.gfr')} ${nf((now.gfr / GFR0) * 100)} %`;
}

function renderTable() {
  const det = document.querySelector('.table-view');
  if (!det.open) return;
  const cfOn = drugsEver;
  const rows = [];
  for (let h = 0; h <= state.t + 1e-9; h += 6) { const r = hist.find((x) => x.t >= h - DT / 2); if (r) rows.push(r); }
  if (rows[rows.length - 1] !== state) rows.push(state);
  const cfAt = (t) => cfHist.find((c) => Math.abs(c.t - t) < DT / 2);
  const th = T('th').filter((_, i) => i !== 3 || cfOn);
  $('data-table').innerHTML = `<div class="table-wrap"><table><thead><tr>${th.map((h) => `<th>${h}</th>`).join('')}</tr></thead><tbody>${
    rows.map((s) => `<tr><td>${nf(s.t, 1)}</td><td>${nf(s.MAP)}</td><td>${nf(s.gfr)}</td>${cfOn ? `<td>${cfAt(s.t) ? nf(cfAt(s.t).gfr) : ''}</td>` : ''}<td>${nf(s.cr, 2)}</td><td>${nf(s.uo, 2)}</td><td>${nf(s.D * 100)}</td><td>${nf(s.fena, 2)}</td><td>${stageName(s.stage)}</td><td>${T(`phase.${s.phase}`)}</td></tr>`).join('')}</tbody></table></div>`;
}

// ---------------------------------------------------------------- render loop
let lastUi = 0, lastTable = 0;
function render(force = false) {
  $('clock').textContent = T('clock', { h: nf(state.t, 1), d: Math.floor(state.t / 24) + 1 });
  drawSchematic(state);
  const now = performance.now();
  if (force || now - lastUi > 150) {
    lastUi = now;
    renderCycle(state); renderTiles(state); renderIndices(state); renderCharts();
    if (force || now - lastTable > 1000) { lastTable = now; renderTable(); }
  }
}

let lastTs = null, acc = 0;
function frame(ts) {
  const dtSec = lastTs == null ? 0 : Math.min(0.1, (ts - lastTs) / 1000);
  lastTs = ts;
  if (playing) {
    acc += dtSec * ui.speed;
    const end = ui.horizonDays * 24;
    while (acc >= DT && state.t < end - 1e-9) { stepOnce(); acc -= DT; render(); }
    if (state.t >= end - 1e-9) { acc = 0; setPlaying(false); addLog(state.t, () => T('log.end')); render(true); }
  }
  if (!matchMedia('(prefers-reduced-motion: reduce)').matches || playing) animateParticles(dtSec);
  requestAnimationFrame(frame);
}

// ---------------------------------------------------------------- boot
setupControls();
buildSchematic();
setupCharts();
applyStaticText();
document.querySelector('.table-view').addEventListener('toggle', renderTable);
syncControls();
reset();
const qp = new URLSearchParams(location.search).get('preset');
if (qp && M.PRESETS[qp]) loadPreset(qp);
requestAnimationFrame(frame);

// small hook for automated checks (no effect on the app)
window.__sim = {
  get state() { return state; }, get hist() { return hist; }, get cfHist() { return cfHist; }, get params() { return params; },
  get lang() { return lang; }, get preset() { return activePreset; }, setLang, loadPreset, setPlaying,
  runTo(h) { setPlaying(false); const end = Math.min(h, ui.horizonDays * 24); while (state.t < end - 1e-9) { stepOnce(); render(); } render(true); },
};
