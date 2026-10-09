// reportMath.js — the small, pure arithmetic every report and chart shares:
// date-range presets, period bucketing (month / year), and "nice" axis ticks.
// PURE: no Dexie, no DOM, no clock (callers pass `today`), so it's unit-tested
// in tests/reportMath.test.js. Dates are the app's YYYY-MM-DD strings, compared
// lexicographically like everywhere else.

// --- Date ranges -------------------------------------------------------------------

// The presets the report date-range control offers, in menu order. `custom` reads
// the From / To inputs; `all` is no range at all.
export const RANGE_PRESETS = [
  { value: 'all',       label: 'All time' },
  { value: 'this_year', label: 'This year' },
  { value: 'last_year', label: 'Last year' },
  { value: 'last_12',   label: 'Last 12 months' },
  { value: 'custom',    label: 'Custom…' }
];

const pad = (n) => String(n).padStart(2, '0');

// { from, to } for a preset, as YYYY-MM-DD (either may be null = open-ended).
// `custom` passes `from`/`to` through.
export function rangeFor(preset, today, { from = null, to = null } = {}) {
  const y = Number(today.slice(0, 4));
  switch (preset) {
    case 'this_year': return { from: `${y}-01-01`, to: `${y}-12-31` };
    case 'last_year': return { from: `${y - 1}-01-01`, to: `${y - 1}-12-31` };
    case 'last_12': {
      // The current month and the eleven before it, whole months.
      const m = Number(today.slice(5, 7));
      const start = new Date(Date.UTC(y, m - 12, 1));
      return { from: `${start.getUTCFullYear()}-${pad(start.getUTCMonth() + 1)}-01`, to: today };
    }
    case 'custom': return { from: from || null, to: to || null };
    default: return { from: null, to: null };
  }
}

// Is a YYYY-MM-DD date inside the range? An undated record is only "in" an
// open (all-time) range.
export function inRange(ymd, { from = null, to = null } = {}) {
  if (!from && !to) return true;
  if (!ymd) return false;
  if (from && ymd < from) return false;
  if (to && ymd > to.slice(0, 10)) return false;
  return true;
}

// A one-line description of a range for a printed report ("Jan 1, 2026 – Dec 31, 2026").
export function rangeLabel(preset, range, fmt = (d) => d) {
  if (preset === 'all' || (!range.from && !range.to)) return 'All time';
  if (range.from && range.to) return `${fmt(range.from)} – ${fmt(range.to)}`;
  return range.from ? `From ${fmt(range.from)}` : `Through ${fmt(range.to)}`;
}

// --- Periods -----------------------------------------------------------------------

// The bucket a date falls in: 'YYYY-MM' by month, 'YYYY' by year.
export function periodKey(ymd, granularity = 'month') {
  if (!ymd) return '';
  return granularity === 'year' ? ymd.slice(0, 4) : ymd.slice(0, 7);
}

// Monthly buckets read well up to about two years; beyond that, years.
export function granularityFor(fromYMD, toYMD) {
  if (!fromYMD || !toYMD) return 'year';
  const months = (Number(toYMD.slice(0, 4)) - Number(fromYMD.slice(0, 4))) * 12
    + (Number(toYMD.slice(5, 7)) - Number(fromYMD.slice(5, 7))) + 1;
  return months <= 24 ? 'month' : 'year';
}

// Every period key from one date to another, inclusive, so empty months still
// get a (zero) bar instead of the axis silently skipping them.
export function periodsBetween(fromYMD, toYMD, granularity = 'month') {
  if (!fromYMD || !toYMD || fromYMD > toYMD) return [];
  const out = [];
  if (granularity === 'year') {
    for (let y = Number(fromYMD.slice(0, 4)); y <= Number(toYMD.slice(0, 4)); y++) out.push(String(y));
    return out;
  }
  let y = Number(fromYMD.slice(0, 4));
  let m = Number(fromYMD.slice(5, 7));
  const endY = Number(toYMD.slice(0, 4));
  const endM = Number(toYMD.slice(5, 7));
  while (y < endY || (y === endY && m <= endM)) {
    out.push(`${y}-${pad(m)}`);
    m += 1;
    if (m > 12) { m = 1; y += 1; }
  }
  return out;
}

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

// 'YYYY-MM' → "Mar 2026" (or "Mar" with short: true); 'YYYY' stays as is.
export function periodLabel(key, { short = false } = {}) {
  if (!key || key.length === 4) return key || '';
  const m = MONTHS[Number(key.slice(5, 7)) - 1] || key;
  return short ? m : `${m} ${key.slice(0, 4)}`;
}

// The periods a set of dated records spans, filled in end to end — for a chart's
// x-axis when the report has no explicit range ("All time"). Clamped to the
// range when one is given.
export function periodsFor(dates, range = {}, granularity = null) {
  const ds = dates.filter(Boolean).sort();
  const from = range.from || ds[0];
  const to = range.to || ds[ds.length - 1];
  if (!from || !to) return { granularity: granularity || 'month', periods: [] };
  const g = granularity || granularityFor(from, to);
  return { granularity: g, periods: periodsBetween(from, to, g) };
}

// Sum `value(item)` into period buckets keyed by `date(item)`. Returns a Map in
// `periods` order with every period present (0 when empty); items outside the
// periods are ignored.
export function bucketSum(items, periods, { date, value = () => 1, granularity = 'month' }) {
  const out = new Map(periods.map((p) => [p, 0]));
  for (const it of items) {
    const k = periodKey(date(it), granularity);
    if (out.has(k)) out.set(k, out.get(k) + (Number(value(it)) || 0));
  }
  return out;
}

// --- Axes ----------------------------------------------------------------------------

// Clean axis ticks from 0 (or a negative min) to at least max: 1/2/2.5/5 × 10^n
// steps, about `target` of them. `integer` (counts: litters, pups) never steps
// below 1 or by 2.5, so there's no "1.5 litters" tick. Returns { ticks, min, max }.
export function niceTicks(minValue, maxValue, target = 4, { integer = false } = {}) {
  let lo = Math.min(0, Number(minValue) || 0);
  let hi = Math.max(0, Number(maxValue) || 0);
  if (lo === hi) hi = lo + 1;
  const raw = (hi - lo) / target;
  const mag = 10 ** Math.floor(Math.log10(raw));
  const steps = (integer ? [1, 2, 5, 10] : [1, 2, 2.5, 5, 10]).map((s) => s * mag);
  let step = steps.find((s) => s >= raw) || 10 * mag;
  if (integer) step = Math.max(1, Math.round(step));
  lo = Math.floor(lo / step) * step;
  hi = Math.ceil(hi / step) * step;
  const ticks = [];
  for (let v = lo; v <= hi + step / 1e6; v += step) ticks.push(Math.round(v * 1e6) / 1e6);
  return { ticks, min: lo, max: hi };
}

// Compact axis numbers: 1,500 → "1.5k", 2,000,000 → "2M"; money adds "$".
export function compactNumber(n, { money = false } = {}) {
  const v = Number(n) || 0;
  const sign = v < 0 ? '-' : '';
  const a = Math.abs(v);
  const s = a >= 1e6 ? `${trim(a / 1e6)}M` : a >= 1e3 ? `${trim(a / 1e3)}k` : trim(a);
  return `${sign}${money ? '$' : ''}${s}`;
}
function trim(x) {
  return String(Math.round(x * 10) / 10);
}

// A percentage with no false precision: 0.875 → "88%"; null when undefined.
export function pct(part, whole) {
  const w = Number(whole);
  if (!w) return null;
  return `${Math.round((Number(part) / w) * 100)}%`;
}

// --- Chart data -----------------------------------------------------------------------

// The categories + series of a by-period column or line chart (assets/chartView.js)
// over `rows`: one category per period across the report's range (or the rows'
// own span for "All time"), and one series per `series` entry summing
// `value(row)` for rows where `when(row)` (default: every row). Months for spans
// up to two years, else years.
// `yearMarks: false` drops the ’26 on January (a chart that's all one year).
export function periodSeries(rows, range, { date, series, yearMarks = true }) {
  const { granularity, periods } = periodsFor(rows.map(date), range || {});
  const short = (p) => periodLabel(p, { short: true }) + (yearMarks && p.endsWith('-01') ? ` ’${p.slice(2, 4)}` : '');
  const categories = periods.map((p) => ({ key: p, label: periodLabel(p), short: granularity === 'month' && (periods.length > 6 || !yearMarks) ? short(p) : periodLabel(p) }));
  return {
    granularity,
    categories,
    series: series.map((s) => {
      const keep = s.when ? rows.filter(s.when) : rows;
      const sums = bucketSum(keep, periods, { date, value: s.value || (() => 1), granularity });
      return { name: s.name, color: s.color, values: periods.map((p) => sums.get(p)) };
    })
  };
}

// Group rows by a key and sum a value: [{ key, label, value }] sorted largest
// first — the rows of a ranked horizontal bar chart.
export function rankBy(rows, { key, label = (k) => k, value = () => 1 }) {
  const m = new Map();
  for (const r of rows) {
    const k = key(r);
    if (k == null || k === '') continue;
    m.set(k, (m.get(k) || 0) + (Number(value(r)) || 0));
  }
  return [...m.entries()].map(([k, v]) => ({ key: k, label: label(k), value: v })).sort((a, b) => b.value - a.value);
}

// Sum a numeric accessor over rows; blanks and non-numbers count as 0.
export function sumOf(rows, value) {
  return rows.reduce((t, r) => t + (Number(value(r)) || 0), 0);
}
