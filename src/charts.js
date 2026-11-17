// charts.js — tiny dependency-free SVG line charts with a synced crosshair.
// Each chart: one y-axis, one measure; optional background bands, x-ranges,
// reference lines, per-point colouring, point markers and a dashed comparison series.

const NS = 'http://www.w3.org/2000/svg';
const el = (tag, attrs = {}, parent) => {
  const n = document.createElementNS(NS, tag);
  for (const [k, v] of Object.entries(attrs)) n.setAttribute(k, v);
  if (parent) parent.appendChild(n);
  return n;
};

export class LineChart {
  /**
   * @param {HTMLElement} host
   * @param {object} o
   *  title, unit, yMin, yMax (number | (maxData)=>number), log (bool),
   *  bands: [{from,to,label,cls}], refs: [{y,label,cls}],
   *  fmt: (v)=>string, onHover: (t|null)=>void
   */
  constructor(host, o) {
    this.o = { yMin: 0, xMin: 0, fmt: (v) => v.toFixed(0), labels: () => ({ x: 'h', noTx: 'cf' }), hoverX: (t) => t.toFixed(1), xTicks: null, ...o };
    this.W = 360; this.H = 200;
    this.m = { l: 44, r: 40, t: 22, b: 26 };
    host.classList.add('chart');
    const head = document.createElement('div');
    head.className = 'chart-head';
    head.innerHTML = `<span class="chart-title"></span><span class="chart-value" aria-live="off"></span>`;
    host.appendChild(head);
    this.titleEl = head.querySelector('.chart-title');
    this.valueEl = head.querySelector('.chart-value');
    this.svg = el('svg', { viewBox: `0 0 ${this.W} ${this.H}`, role: 'img' }, host);
    this.setTitle(o.title);
    this.gBands = el('g', {}, this.svg);
    this.gGrid = el('g', { class: 'grid' }, this.svg);
    this.gData = el('g', {}, this.svg);
    this.gHover = el('g', { class: 'hover', visibility: 'hidden' }, this.svg);
    this.hLine = el('line', { class: 'crosshair' }, this.gHover);
    this.hDot = el('circle', { r: 4.5, class: 'hover-dot' }, this.gHover);
    this.hDotCf = el('circle', { r: 3.5, class: 'hover-dot cf' }, this.gHover);
    this.hLabel = el('text', { class: 'hover-label' }, this.gHover);
    const hit = el('rect', {
      x: this.m.l, y: this.m.t, width: this.W - this.m.l - this.m.r,
      height: this.H - this.m.t - this.m.b, fill: 'transparent',
    }, this.svg);
    const toT = (ev) => {
      const r = this.svg.getBoundingClientRect();
      const x = ((ev.clientX - r.left) / r.width) * this.W;
      return Math.max(this.xMin, Math.min(this.xMax, this.xInv(x)));
    };
    hit.addEventListener('pointermove', (ev) => o.onHover?.(toT(ev)));
    hit.addEventListener('pointerleave', () => o.onHover?.(null));
    this.series = []; this.xMax = 30; this.xMin = this.o.xMin; this.hoverT = null;
  }

  x(t) { return this.m.l + ((t - this.xMin) / (this.xMax - this.xMin)) * (this.W - this.m.l - this.m.r); }
  xInv(px) { return this.xMin + ((px - this.m.l) / (this.W - this.m.l - this.m.r)) * (this.xMax - this.xMin); }
  y(v) {
    const { log } = this.o;
    const lo = log ? Math.log10(this.yMin) : this.yMin;
    const hi = log ? Math.log10(this.yMax) : this.yMax;
    const vv = log ? Math.log10(Math.max(v, this.yMin)) : v;
    const f = (Math.min(hi, Math.max(lo, vv)) - lo) / (hi - lo);
    return this.H - this.m.b - f * (this.H - this.m.t - this.m.b);
  }

  /** series: [{ pts: [[t, v, colorClass?]], cls, dashed, name }] */
  update(series, xMax, xMin = this.o.xMin) {
    this.series = series; this.xMax = xMax; this.xMin = xMin;
    const all = series.flatMap((s) => s.pts.map((p) => p[1]));
    const dataMax = all.length ? Math.max(...all) : 1;
    this.yMin = this.o.yMin;
    this.yMax = typeof this.o.yMax === 'function' ? this.o.yMax(dataMax) : this.o.yMax;
    this.drawFrame();
    this.drawData();
    this.drawHover();
  }

  drawFrame() {
    const { m, W, H } = this;
    this.gBands.replaceChildren();
    this.gGrid.replaceChildren();
    for (const b of this.o.bands || []) {
      const y1 = this.y(Math.min(b.to, this.yMax)), y0 = this.y(Math.max(b.from, this.yMin));
      if (y0 - y1 < 1) continue;
      el('rect', { x: m.l, y: y1, width: W - m.l - m.r, height: y0 - y1, class: `band ${b.cls}` }, this.gBands);
      if (y0 - y1 >= 10) {
        const t = el('text', { x: W - m.r + 4, y: (y0 + y1) / 2 + 3.5, class: 'band-label' }, this.gBands);
        t.textContent = b.label;
      }
    }
    // y ticks
    const ticks = this.o.log
      ? [10, 30, 100, 300, 1000].filter((v) => v >= this.yMin && v <= this.yMax)
      : niceTicks(this.yMin, this.yMax, 4);
    for (const v of ticks) {
      const yy = this.y(v);
      el('line', { x1: m.l, x2: W - m.r, y1: yy, y2: yy }, this.gGrid);
      const t = el('text', { x: m.l - 6, y: yy + 3.5, 'text-anchor': 'end', class: 'tick' }, this.gGrid);
      t.textContent = this.o.tickFmt ? this.o.tickFmt(v) : String(v);
    }
    // x ticks (years)
    // vertical bands / reference lines on the x axis
    for (const b of this.o.xBands || []) {
      const x0 = this.x(Math.max(b.from, this.xMin)), x1 = this.x(Math.min(b.to, this.xMax));
      if (x1 - x0 < 1) continue;
      el('rect', { x: x0, y: m.t, width: x1 - x0, height: H - m.t - m.b, class: `band ${b.cls}` }, this.gBands);
      const t = el('text', { x: x0 + 4, y: m.t + 10, class: 'band-label' }, this.gBands);
      t.textContent = typeof b.label === 'function' ? b.label() : b.label;
    }
    const span = this.xMax - this.xMin;
    const step = this.o.xTicks ? this.o.xTicks(span) : (span > 40 ? 10 : 5);
    for (let t = Math.ceil(this.xMin / step) * step; t <= this.xMax + 1e-9; t += step) {
      const xx = this.x(t);
      const tx = el('text', { x: xx, y: H - m.b + 15, 'text-anchor': 'middle', class: 'tick' }, this.gGrid);
      tx.textContent = this.o.xTickFmt ? this.o.xTickFmt(t) : t;
    }
    for (const r of this.o.xRefs || []) {
      const v = typeof r.x === 'function' ? r.x() : r.x;
      if (v == null || v < this.xMin || v > this.xMax) continue;
      const xx = this.x(v);
      el('line', { x1: xx, x2: xx, y1: m.t, y2: H - m.b, class: `ref ${r.cls || ''}` }, this.gGrid);
      const t = el('text', { x: xx + 3, y: r.top ? m.t + 22 : H - m.b - 4, class: `ref-label ${r.cls || ''}` }, this.gGrid);
      t.textContent = typeof r.label === 'function' ? r.label() : r.label;
    }
    const ax = el('text', { x: W - m.r, y: H - 2, 'text-anchor': 'end', class: 'tick axis-name' }, this.gGrid);
    ax.textContent = this.o.labels().x;
    const un = el('text', { x: m.l - 6, y: 11, 'text-anchor': 'end', class: 'tick axis-name' }, this.gGrid);
    un.textContent = typeof this.o.unit === 'function' ? this.o.unit() : this.o.unit;
    el('line', { x1: m.l, x2: W - m.r, y1: H - m.b, y2: H - m.b, class: 'baseline' }, this.gGrid);
    for (const r of this.o.refs || []) {
      const v = typeof r.y === 'function' ? r.y() : r.y;
      if (v < this.yMin || v > this.yMax) continue;
      const yy = this.y(v);
      el('line', { x1: m.l, x2: W - m.r, y1: yy, y2: yy, class: `ref ${r.cls || ''}` }, this.gGrid);
      const t = el('text', { x: m.l + 4, y: yy - 4, class: `ref-label ${r.cls || ''}` }, this.gGrid);
      t.textContent = typeof r.label === 'function' ? r.label() : r.label;
    }
  }

  drawData() {
    this.gData.replaceChildren();
    for (const s of this.series) {
      if (!s.pts.length) continue;
      if (s.marker) { const pt = s.pts[0]; el('circle', { cx: this.x(pt[0]), cy: this.y(pt[1]), r: 5.5, class: `end-dot ${pt[2] || s.cls}` }, this.gData); continue; }
      // split into runs of equal colour class (KDIGO colouring)
      let run = [], cls = s.pts[0][2] || s.cls;
      const flush = () => {
        if (run.length < 1) return;
        const d = run.map((p, i) => `${i ? 'L' : 'M'}${this.x(p[0]).toFixed(1)},${this.y(p[1]).toFixed(1)}`).join('');
        el('path', { d, class: `line ${cls} ${s.dashed ? 'dashed' : ''}` }, this.gData);
      };
      for (const p of s.pts) {
        const c = p[2] || s.cls;
        if (c !== cls) { run.push(p); flush(); run = [p]; cls = c; } else run.push(p);
      }
      flush();
      if (!s.dashed && !s.noValue) {
        const last = s.pts[s.pts.length - 1];
        el('circle', { cx: this.x(last[0]), cy: this.y(last[1]), r: 4, class: `end-dot ${last[2] || s.cls}` }, this.gData);
        this.valueEl.textContent = this.o.fmt(last[1]);
      }
    }
  }

  setTitle(html) {
    this.titleEl.innerHTML = html;
    this.svg.setAttribute('aria-label', this.titleEl.textContent);
  }

  setHover(t) { this.hoverT = t; this.drawHover(); }

  drawHover() {
    const t = this.hoverT;
    const main = this.series.find((s) => !s.dashed && !s.marker);
    if (t == null || !main || !main.pts.length) { this.gHover.setAttribute('visibility', 'hidden'); return; }
    const p = nearest(main.pts, t);
    if (!p) { this.gHover.setAttribute('visibility', 'hidden'); return; }
    this.gHover.setAttribute('visibility', 'visible');
    const xx = this.x(p[0]);
    Object.entries({ x1: xx, x2: xx, y1: this.m.t, y2: this.H - this.m.b }).forEach(([k, v]) => this.hLine.setAttribute(k, v));
    this.hDot.setAttribute('cx', xx); this.hDot.setAttribute('cy', this.y(p[1]));
    this.hDot.setAttribute('class', `hover-dot ${p[2] || main.cls}`);
    const cf = this.series.find((s) => s.dashed && !s.marker);
    const L = this.o.labels();
    let label = `${this.o.hoverX(p[0])} · ${this.o.fmt(p[1])}`;
    const q = cf && nearest(cf.pts, t);
    if (q) {
      this.hDotCf.setAttribute('visibility', 'visible');
      this.hDotCf.setAttribute('cx', this.x(q[0])); this.hDotCf.setAttribute('cy', this.y(q[1]));
      label += ` (${L.noTx}: ${this.o.fmt(q[1])})`;
    } else this.hDotCf.setAttribute('visibility', 'hidden');
    this.hLabel.textContent = label;
    const right = xx > this.W / 2;
    this.hLabel.setAttribute('x', right ? xx - 6 : xx + 6);
    this.hLabel.setAttribute('text-anchor', right ? 'end' : 'start');
    this.hLabel.setAttribute('y', 12);
  }
}

function nearest(pts, t) {
  if (!pts.length || t > pts[pts.length - 1][0] + 0.06) return null;
  let lo = 0, hi = pts.length - 1;
  while (hi - lo > 1) { const mid = (lo + hi) >> 1; if (pts[mid][0] < t) lo = mid; else hi = mid; }
  return Math.abs(pts[lo][0] - t) < Math.abs(pts[hi][0] - t) ? pts[lo] : pts[hi];
}

function niceTicks(lo, hi, n) {
  const span = hi - lo;
  const raw = span / n;
  const mag = 10 ** Math.floor(Math.log10(raw));
  const step = [1, 2, 2.5, 5, 10].map((k) => k * mag).find((s) => span / s <= n + 0.5);
  const out = [];
  for (let v = Math.ceil(lo / step) * step; v <= hi + 1e-9; v += step) out.push(+v.toFixed(6));
  return out;
}
