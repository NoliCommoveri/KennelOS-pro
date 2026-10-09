// chartView.js — the app's own small SVG charts for reports (Reports plan, phase
// 1). No vendored charting library: like the pedigree tree, these are plain SVG
// strings, so they work offline, print crisp, and add a few KB instead of a
// canvas library. Three forms cover every report:
//
//   barChart   — columns over categories (periods, litters…): one series, grouped
//                series, stacked series, or one signed series (diverging: a gain
//                above the baseline, a loss below it).
//   lineChart  — series over a category axis (months) or a numeric one (age in days).
//   hbarChart  — a ranked list of horizontal bars (lead sources, reasons…).
//
// Each render* function is PURE (spec + width in, HTML string out), so it's
// unit-tested in tests/chartView.test.js. mountChart() is the only DOM part: it
// renders at the container's real width, re-renders when that changes (including
// for print), and wires the hover tooltip. Every user-derived string is esc()'d.
//
// Marks follow one spec everywhere: columns at most 24px thick with a 4px rounded
// data end and a square baseline, a 2px surface gap between touching marks, 2px
// lines, end dots with a 2px surface ring, hairline gridlines, and text in ink
// tokens (never the series color). Two or more series always get a legend.
// Categorical colors are assigned in a FIXED order (never cycled; more than 8
// series fold into "Other" upstream) from a palette validated for color-vision
// deficiency on a white surface; see SERIES_COLORS.
import { niceTicks, compactNumber } from '../data/reportMath.js';

// The same escaping as ui.js's esc(), kept local so this module loads in Node
// (ui.js wires document listeners at import) and stays unit-testable.
const esc = (v) => String(v ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

// Categorical slots, in order (validated: adjacent pairs clear CVD ΔE 8 on white).
export const SERIES_COLORS = ['#2a78d6', '#eb6834', '#1baf7a', '#eda100', '#e87ba4', '#008300', '#4a3aa7', '#e34948'];
// A signed single series (net per litter): blue above the baseline, red below.
export const DIVERGING = { positive: '#2a78d6', negative: '#e34948' };
const INK = { primary: '#1c2430', secondary: '#5c6773', muted: '#8a94a1', grid: '#e6e9ee', axis: '#c3c9d2', surface: '#ffffff' };

const FONT = 11;
const MAX_BAR = 24;
const GAP = 2;

const r1 = (n) => Math.round(n * 10) / 10;
const defaultFormat = (v) => (Number(v) || 0).toLocaleString();

// The color for series i: an explicit one wins, else its fixed slot.
const colorFor = (s, i) => s.color || SERIES_COLORS[i % SERIES_COLORS.length];

// A column from y0 (baseline side) to y1 (data end), rounded only at the data end.
function columnPath(x, w, yBase, yEnd, radius = 4) {
  const h = Math.abs(yEnd - yBase);
  if (h < 0.5) return '';
  const r = Math.min(radius, w / 2, h);
  if (yEnd < yBase) { // grows up
    return `M${r1(x)},${r1(yBase)}V${r1(yEnd + r)}Q${r1(x)},${r1(yEnd)} ${r1(x + r)},${r1(yEnd)}H${r1(x + w - r)}Q${r1(x + w)},${r1(yEnd)} ${r1(x + w)},${r1(yEnd + r)}V${r1(yBase)}Z`;
  }
  return `M${r1(x)},${r1(yBase)}V${r1(yEnd - r)}Q${r1(x)},${r1(yEnd)} ${r1(x + r)},${r1(yEnd)}H${r1(x + w - r)}Q${r1(x + w)},${r1(yEnd)} ${r1(x + w)},${r1(yEnd - r)}V${r1(yBase)}Z`;
}
// A square-ended block (an interior stacked segment).
function blockPath(x, w, yA, yB) {
  const top = Math.min(yA, yB);
  const h = Math.abs(yB - yA);
  if (h < 0.5) return '';
  return `M${r1(x)},${r1(top)}h${r1(w)}v${r1(h)}h${r1(-w)}Z`;
}
// Same as columnPath, but horizontal: from xBase to xEnd, rounded at xEnd.
function rowPath(y, h, xBase, xEnd, radius = 4) {
  const w = xEnd - xBase;
  if (w < 0.5) return '';
  const r = Math.min(radius, h / 2, w);
  return `M${r1(xBase)},${r1(y)}H${r1(xEnd - r)}Q${r1(xEnd)},${r1(y)} ${r1(xEnd)},${r1(y + r)}V${r1(y + h - r)}Q${r1(xEnd)},${r1(y + h)} ${r1(xEnd - r)},${r1(y + h)}H${r1(xBase)}Z`;
}

// Tooltip text rides on a hit target as data-tip: lines joined by \n, escaped.
const tip = (lines) => esc(lines.filter(Boolean).join('\n'));

// Colors are fixed by the series' position in the spec (or its own color), so a
// series with nothing to show keeps its slot: it's just left out of the legend.
function legendHtml(series) {
  if (series.length < 2) return '';
  const shown = series.map((s, i) => ({ s, color: colorFor(s, i) })).filter(({ s }) => !s.empty);
  if (shown.length < 2) return '';
  return `<div class="chart-legend">${shown.map(({ s, color }) =>
    `<span class="chart-key"><span class="chart-swatch" style="background:${color}"></span>${esc(s.name)}</span>`).join('')}</div>`;
}

function shell(spec, svg, series = []) {
  const head = spec.title ? `<div class="chart-title">${esc(spec.title)}</div>` : '';
  const sub = spec.subtitle ? `<div class="chart-sub">${esc(spec.subtitle)}</div>` : '';
  return `<figure class="chart">${head}${sub}${legendHtml(series)}${svg}<div class="chart-tip" hidden></div></figure>`;
}

function emptyChart(spec) {
  return shell(spec, `<div class="chart-empty">${esc(spec.emptyText || 'Nothing to chart for this selection.')}</div>`);
}

// Y axis gridlines + tick labels for a vertical value scale.
function yAxis(ticks, y, left, right, axisFormat) {
  return ticks.map((t) => `<line x1="${left}" x2="${right}" y1="${r1(y(t))}" y2="${r1(y(t))}" stroke="${t === 0 ? INK.axis : INK.grid}" stroke-width="1"/>`
    + `<text x="${left - 6}" y="${r1(y(t) + 3.5)}" text-anchor="end" font-size="${FONT}" fill="${INK.muted}" class="tnum">${esc(axisFormat(t))}</text>`).join('');
}

// Show every nth category label so they never collide.
function labelStep(labels, band) {
  const widest = Math.max(1, ...labels.map((l) => String(l).length)) * FONT * 0.6 + 8;
  return Math.max(1, Math.ceil(widest / Math.max(band, 1)));
}

// --- Columns -------------------------------------------------------------------------

// spec: { title?, subtitle?, categories: [{ key, label, short? }], series: [{ name,
// values: [number per category], color? }], stacked?, diverging?, height?, format?,
// axisFormat?, money?, emptyText?, ariaLabel? }
export function renderBarChart(spec, width = 640) {
  const cats = spec.categories || [];
  const series = (spec.series || []).filter((s) => s && Array.isArray(s.values));
  const values = series.flatMap((s) => s.values.map((v) => Number(v) || 0));
  if (!cats.length || !series.length || values.every((v) => v === 0)) return emptyChart(spec);

  const format = spec.format || defaultFormat;
  const axisFormat = spec.axisFormat || ((v) => compactNumber(v, { money: spec.money }));
  const H = spec.height || 220;
  const W = Math.max(240, width);
  const pad = { top: 12, right: 8, bottom: 26, left: 44 };
  const plotW = W - pad.left - pad.right;
  const plotH = H - pad.top - pad.bottom;

  // Extent: stacked bars sum per category (positives and negatives separately).
  let lo = 0;
  let hi = 0;
  cats.forEach((_, i) => {
    if (spec.stacked) {
      let p = 0; let n = 0;
      for (const s of series) { const v = Number(s.values[i]) || 0; if (v >= 0) p += v; else n += v; }
      hi = Math.max(hi, p); lo = Math.min(lo, n);
    } else {
      for (const s of series) { const v = Number(s.values[i]) || 0; hi = Math.max(hi, v); lo = Math.min(lo, v); }
    }
  });
  const { ticks, min, max } = niceTicks(lo, hi, 4, { integer: values.every(Number.isInteger) });
  const y = (v) => pad.top + plotH - ((v - min) / (max - min)) * plotH;
  const y0 = y(0);

  const band = plotW / cats.length;
  const groups = spec.stacked ? 1 : series.length;
  const barW = Math.max(2, Math.min(MAX_BAR, (band * 0.72 - GAP * (groups - 1)) / groups));
  const groupW = barW * groups + GAP * (groups - 1);

  let marks = '';
  let hits = '';
  cats.forEach((c, i) => {
    const x0 = pad.left + band * i + (band - groupW) / 2;
    if (spec.stacked) {
      let up = 0; let down = 0;
      const parts = series.map((s, si) => ({ v: Number(s.values[i]) || 0, si })).filter((p) => p.v !== 0);
      const lastUp = [...parts].reverse().find((p) => p.v > 0);
      const lastDown = [...parts].reverse().find((p) => p.v < 0);
      for (const p of parts) {
        const fromV = p.v > 0 ? up : down;
        const toV = fromV + p.v;
        if (p.v > 0) up = toV; else down = toV;
        // The 2px surface gap: each segment gives up GAP at its data-side edge.
        const yA = y(fromV);
        const yB = y(toV) + (p.v > 0 ? GAP : -GAP) * (p === (p.v > 0 ? lastUp : lastDown) ? 0 : 1);
        const isEnd = p === lastUp || p === lastDown;
        const d = isEnd ? columnPath(x0, barW, yA, y(toV)) : blockPath(x0, barW, yA, yB);
        if (d) marks += `<path d="${d}" fill="${colorFor(series[p.si], p.si)}"/>`;
      }
    } else {
      series.forEach((s, si) => {
        const v = Number(s.values[i]) || 0;
        const fill = spec.diverging ? (v < 0 ? DIVERGING.negative : DIVERGING.positive) : colorFor(s, si);
        const d = columnPath(x0 + si * (barW + GAP), barW, y0, y(v));
        if (d) marks += `<path d="${d}" fill="${fill}"/>`;
      });
    }
    const lines = [c.label, ...series.map((s) => `${series.length > 1 ? `${s.name}: ` : ''}${format(Number(s.values[i]) || 0)}`)];
    if (spec.stacked && series.length > 1) lines.push(`Total: ${format(series.reduce((t, s) => t + (Number(s.values[i]) || 0), 0))}`);
    hits += `<rect class="chart-hit" x="${r1(pad.left + band * i)}" y="${pad.top}" width="${r1(band)}" height="${plotH}" data-tip="${tip(lines)}"/>`;
  });

  const step = labelStep(cats.map((c) => c.short || c.label), band);
  const xLabels = cats.map((c, i) => (i % step === 0
    ? `<text x="${r1(pad.left + band * i + band / 2)}" y="${H - 8}" text-anchor="middle" font-size="${FONT}" fill="${INK.secondary}">${esc(c.short || c.label)}</text>` : '')).join('');

  const svg = `<svg class="chart-svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}" role="img" aria-label="${esc(spec.ariaLabel || spec.title || 'Chart')}">
    ${yAxis(ticks, y, pad.left, W - pad.right, axisFormat)}${marks}${xLabels}${hits}</svg>`;
  const legend = series.map((s) => ({ ...s, empty: s.values.every((v) => !Number(v)) }));
  return shell(spec, svg, spec.diverging ? [] : legend);
}

// --- Lines ---------------------------------------------------------------------------

// spec: { title?, subtitle?, categories?: [{ key, label, short? }] (category x) OR
// numeric x when absent, series: [{ name, points: [{ x, y }], color? }] (x = a
// category key, or a number), xFormat?, format?, axisFormat?, height?, money?,
// xLabel? (axis caption for numeric x), xMin? (numeric x: start the axis here) }
export function renderLineChart(spec, width = 640) {
  const series = (spec.series || []).filter((s) => s && (s.points || []).length);
  if (!series.length) return emptyChart(spec);
  const format = spec.format || defaultFormat;
  const axisFormat = spec.axisFormat || ((v) => compactNumber(v, { money: spec.money }));
  const xFormat = spec.xFormat || ((v) => String(v));
  const H = spec.height || 240;
  const W = Math.max(240, width);
  const labelRoom = series.length <= 4 ? Math.min(110, Math.max(...series.map((s) => s.name.length)) * FONT * 0.6 + 14) : 8;
  const pad = { top: 12, right: labelRoom, bottom: spec.xLabel ? 38 : 26, left: 44 };
  const plotW = W - pad.left - pad.right;
  const plotH = H - pad.top - pad.bottom;

  const cats = spec.categories || null;
  let xPos;
  let xTicks;
  if (cats) {
    const band = plotW / Math.max(cats.length - 1, 1);
    const idx = new Map(cats.map((c, i) => [c.key, i]));
    xPos = (x) => pad.left + (cats.length === 1 ? plotW / 2 : band * (idx.get(x) ?? 0));
    const step = labelStep(cats.map((c) => c.short || c.label), band);
    xTicks = cats.map((c, i) => (i % step === 0 ? { at: xPos(c.key), text: c.short || c.label } : null)).filter(Boolean);
  } else {
    const xs = series.flatMap((s) => s.points.map((p) => Number(p.x)));
    // spec.xMin pins the axis start (growth: day 0, birth) below the data.
    const xMin = spec.xMin != null ? Math.min(Number(spec.xMin), ...xs) : Math.min(...xs);
    const xMax = Math.max(...xs);
    const span = xMax - xMin || 1;
    xPos = (x) => pad.left + ((Number(x) - xMin) / span) * plotW;
    const t = niceTicks(xMin, xMax, 6).ticks.filter((v) => v >= xMin && v <= xMax);
    xTicks = t.map((v) => ({ at: xPos(v), text: xFormat(v) }));
  }
  const ys = series.flatMap((s) => s.points.map((p) => Number(p.y) || 0));
  const { ticks, min, max } = niceTicks(Math.min(...ys), Math.max(...ys), 4, { integer: ys.every(Number.isInteger) });
  const y = (v) => pad.top + plotH - ((v - min) / (max - min)) * plotH;

  let lines = '';
  const ends = [];
  series.forEach((s, si) => {
    const pts = (cats ? s.points.filter((p) => cats.some((c) => c.key === p.x)) : [...s.points].sort((a, b) => a.x - b.x));
    if (!pts.length) return;
    const color = colorFor(s, si);
    const d = pts.map((p, i) => `${i ? 'L' : 'M'}${r1(xPos(p.x))},${r1(y(Number(p.y) || 0))}`).join('');
    lines += `<path d="${d}" fill="none" stroke="${color}" stroke-width="2" stroke-linejoin="round" stroke-linecap="round"/>`;
    const last = pts[pts.length - 1];
    lines += `<circle cx="${r1(xPos(last.x))}" cy="${r1(y(Number(last.y) || 0))}" r="4" fill="${color}" stroke="${INK.surface}" stroke-width="2"/>`;
    ends.push({ name: s.name, y: y(Number(last.y) || 0), x: xPos(last.x) });
  });

  // Direct end labels for up to four series, nudged apart so they never overlap.
  let endLabels = '';
  if (series.length <= 4) {
    ends.sort((a, b) => a.y - b.y);
    for (let i = 1; i < ends.length; i++) if (ends[i].y - ends[i - 1].y < FONT + 2) ends[i].y = ends[i - 1].y + FONT + 2;
    endLabels = ends.map((e) => `<text x="${r1(e.x + 8)}" y="${r1(e.y + 3.5)}" font-size="${FONT}" fill="${INK.secondary}">${esc(e.name)}</text>`).join('');
  }

  // Hover: one hit column per x position, listing every series' value there.
  const xKeys = cats ? cats.map((c) => c.key) : [...new Set(series.flatMap((s) => s.points.map((p) => Number(p.x))))].sort((a, b) => a - b);
  let hits = '';
  xKeys.forEach((k, i) => {
    const at = xPos(k);
    const prev = i ? xPos(xKeys[i - 1]) : pad.left;
    const next = i < xKeys.length - 1 ? xPos(xKeys[i + 1]) : W - pad.right;
    const left = i ? (prev + at) / 2 : pad.left;
    const right = i < xKeys.length - 1 ? (at + next) / 2 : W - pad.right;
    const label = cats ? cats[i].label : xFormat(k);
    const rows = series.map((s) => {
      const p = s.points.find((q) => (cats ? q.x === k : Number(q.x) === k));
      return p ? `${series.length > 1 ? `${s.name}: ` : ''}${format(Number(p.y) || 0)}` : null;
    });
    if (!rows.some(Boolean)) return;
    hits += `<rect class="chart-hit" data-cross="${r1(at)}" x="${r1(left)}" y="${pad.top}" width="${r1(Math.max(right - left, 1))}" height="${plotH}" data-tip="${tip([label, ...rows])}"/>`;
  });

  const xText = xTicks.map((t) => `<text x="${r1(t.at)}" y="${pad.top + plotH + 16}" text-anchor="middle" font-size="${FONT}" fill="${INK.secondary}">${esc(t.text)}</text>`).join('');
  const caption = spec.xLabel ? `<text x="${r1(pad.left + plotW / 2)}" y="${H - 4}" text-anchor="middle" font-size="${FONT}" fill="${INK.muted}">${esc(spec.xLabel)}</text>` : '';
  const svg = `<svg class="chart-svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}" role="img" aria-label="${esc(spec.ariaLabel || spec.title || 'Chart')}">
    ${yAxis(ticks, y, pad.left, W - pad.right, axisFormat)}
    <line class="chart-cross" x1="0" x2="0" y1="${pad.top}" y2="${pad.top + plotH}" stroke="${INK.axis}" stroke-width="1" visibility="hidden"/>
    ${lines}${endLabels}${xText}${caption}${hits}</svg>`;
  return shell(spec, svg, series);
}

// --- Ranked horizontal bars -------------------------------------------------------------

// spec: { title?, subtitle?, rows: [{ label, value, note? }], format?, color?, emptyText?,
// max? (rows shown; the rest fold into "Other"), sort? (false keeps the given order —
// a funnel's stages), showZero? (keep 0 rows — a 0% rate is an answer, not a blank) }
export function renderHbarChart(spec, width = 640) {
  let rows = (spec.rows || []).filter((r) => Number(r.value) > 0 || (spec.showZero && r.value != null));
  if (spec.sort !== false) rows = rows.sort((a, b) => b.value - a.value);
  if (!rows.some((r) => Number(r.value) > 0) && !(spec.showZero && rows.length)) rows = [];
  if (!rows.length) return emptyChart(spec);
  const limit = spec.max || 10;
  if (rows.length > limit) {
    const rest = rows.slice(limit - 1);
    rows = [...rows.slice(0, limit - 1), { label: `Other (${rest.length})`, value: rest.reduce((t, r) => t + Number(r.value), 0) }];
  }
  const format = spec.format || defaultFormat;
  const W = Math.max(240, width);
  const rowH = 26;
  const barH = Math.min(16, rowH - 8);
  const labelW = Math.min(Math.max(...rows.map((r) => String(r.label).length)) * FONT * 0.62 + 12, W * 0.4);
  const valueW = Math.max(...rows.map((r) => format(r.value).length)) * FONT * 0.62 + 10;
  const left = labelW;
  const right = W - valueW;
  const H = rows.length * rowH + 4;
  const top = Math.max(...rows.map((r) => Number(r.value)), 1e-9);
  const x = (v) => left + (Number(v) / top) * (right - left);
  const color = spec.color || SERIES_COLORS[0];
  const body = rows.map((r, i) => {
    const yy = i * rowH + 2;
    const cy = yy + rowH / 2;
    const d = rowPath(cy - barH / 2, barH, left, Math.max(x(r.value), left + 1));
    return `<text x="${r1(left - 8)}" y="${r1(cy + 4)}" text-anchor="end" font-size="${FONT + 1}" fill="${INK.primary}">${esc(r.label)}</text>`
      + (d ? `<path d="${d}" fill="${color}"/>` : '')
      + `<text x="${r1(x(r.value) + 6)}" y="${r1(cy + 4)}" font-size="${FONT + 1}" fill="${INK.secondary}" class="tnum">${esc(format(r.value))}</text>`
      + `<rect class="chart-hit" x="0" y="${yy}" width="${W}" height="${rowH}" data-tip="${tip([r.label, format(r.value), r.note])}"/>`;
  }).join('');
  const svg = `<svg class="chart-svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}" role="img" aria-label="${esc(spec.ariaLabel || spec.title || 'Chart')}">${body}</svg>`;
  return shell(spec, svg);
}

const RENDERERS = { bar: renderBarChart, line: renderLineChart, hbar: renderHbarChart };

// A chart as HTML at a given width; spec.type picks the form.
export function renderChart(spec, width = 640) {
  const fn = RENDERERS[spec.type || 'bar'];
  if (!fn) throw new Error(`Unknown chart type "${spec.type}".`);
  return fn(spec, width);
}

// --- DOM: mount, resize, tooltip --------------------------------------------------------

// Render `spec` into `el` at el's width, keep it sized to el, and wire the hover
// tooltip. Returns { update(spec), destroy() }.
export function mountChart(el, spec) {
  let current = spec;
  let lastW = 0;
  const draw = (force = false) => {
    const w = Math.floor(el.clientWidth || 640);
    if (!force && w === lastW) return;
    lastW = w;
    el.innerHTML = renderChart(current, w);
  };
  draw(true);

  const onMove = (e) => {
    const hit = e.target.closest && e.target.closest('.chart-hit');
    const fig = el.querySelector('.chart');
    const box = el.querySelector('.chart-tip');
    const cross = el.querySelector('.chart-cross');
    if (!fig || !box) return;
    if (!hit) { box.hidden = true; if (cross) cross.setAttribute('visibility', 'hidden'); return; }
    box.replaceChildren(...hit.getAttribute('data-tip').split('\n').map((line, i) => {
      const div = document.createElement('div');
      if (i === 0) div.className = 'chart-tip-head';
      div.textContent = line;
      return div;
    }));
    box.hidden = false;
    const fr = fig.getBoundingClientRect();
    const px = e.clientX - fr.left;
    const py = e.clientY - fr.top;
    const flip = px > fr.width - box.offsetWidth - 16;
    box.style.left = `${Math.max(0, flip ? px - box.offsetWidth - 12 : px + 12)}px`;
    box.style.top = `${Math.max(0, py - box.offsetHeight - 8)}px`;
    if (cross && hit.dataset.cross) {
      cross.setAttribute('x1', hit.dataset.cross); cross.setAttribute('x2', hit.dataset.cross);
      cross.setAttribute('visibility', 'visible');
    }
  };
  const onLeave = () => {
    const box = el.querySelector('.chart-tip');
    if (box) box.hidden = true;
    const cross = el.querySelector('.chart-cross');
    if (cross) cross.setAttribute('visibility', 'hidden');
  };
  el.addEventListener('pointermove', onMove);
  el.addEventListener('pointerleave', onLeave);

  const ro = typeof ResizeObserver !== 'undefined' ? new ResizeObserver(() => draw()) : null;
  ro?.observe(el);
  // Paper is a different width than the screen: redraw for print, and back after.
  const onPrint = () => draw(true);
  window.addEventListener('beforeprint', onPrint);
  window.addEventListener('afterprint', onPrint);

  return {
    update(next) { current = next; draw(true); },
    destroy() {
      ro?.disconnect();
      el.removeEventListener('pointermove', onMove);
      el.removeEventListener('pointerleave', onLeave);
      window.removeEventListener('beforeprint', onPrint);
      window.removeEventListener('afterprint', onPrint);
    }
  };
}
