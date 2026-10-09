// reportView.js — the single reusable reporting component (Build Brief A4). It
// takes a record list + column config + optional filters/search, renders a
// table, and offers "export visible rows to CSV". Stage 2 proves it with the
// Active Roster (B2); every later stage's report plugs into this same component
// instead of getting bespoke rendering.
//
// Column config:
//   { header, value:(r)=>string, badge?:vocabArray, csv?:(r)=>string, className?, total? }
//     value — plain-text accessor (also the CSV value unless `csv` overrides).
//     badge — if set, the cell renders value() as a colored badge for that vocab.
//     csv   — override the exported value (defaults to value()).
//     tone  — optional (r)=>badgeClass|null: renders value() inside a badge of that
//             class for this row only (e.g. an amber/red "entries close" date).
//             The class comes from page code, never user data; the text is escaped.
//     total — optional (rows)=>string: this column's figure in a Total row under the
//             table, over the VISIBLE rows (so it follows every filter). Plain text.
//
// `groupBy` (optional) — (r)=>string: when consecutive visible rows change group,
// a full-width group header row (escaped text) is inserted. Rows aren't re-sorted,
// so the caller's load() order decides the grouping. CSV export is unaffected.
//
// Reports plan, phase 1 — every report also gets, when its page asks:
//   dateRange — { label, date:(r)=>YYYY-MM-DD, initial? } adds a preset menu (All
//               time / This year / Last year / Last 12 months / Custom From–To);
//               rows outside it are filtered out like any other filter.
//   kpis      — (rows, ctx)=>[{ label, value, hint? }]: a stat strip above the table.
//   charts    — (rows, ctx)=>[chartSpec…] (assets/chartView.js): drawn above the
//               table from the same visible rows, so charts follow the filters too.
//   ctx is { range: { from, to }, preset, records } — `records` the scoped set
//   before filters, for a chart that needs the whole span.
//   rowsFor   — (records, ctx)=>rows: a summary report; see the option below.
// And always: a "Print / PDF" button and a letterhead that only shows on paper
// (assets/printView.js), listing the date range, filters and search in effect.
import Papa from '../vendor/papaparse.min.mjs';
import { esc, badge as badgeHtml, fmtDate } from './ui.js';
import { mountScopeChip } from './kennelScopeUI.js';
import { mountChart } from './chartView.js';
import { wirePrintHeader, printButton } from './printView.js';
import { RANGE_PRESETS, rangeFor, inRange, rangeLabel } from '../data/reportMath.js';
import { todayYMD } from '../data/dateUtils.js';

function downloadCsv(filename, text) {
  const blob = new Blob([text], { type: 'text/csv;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}

export function createReportView(opts) {
  const {
    mount,
    columns,
    filters = [],
    search,                       // { placeholder, text:(r)=>string }
    load,                         // async () => records[]
    onRowClick,                   // optional (r) => void
    scope = null,                 // optional (r) => bool — the ACTIVE-KENNEL predicate
                                  // (Multi-Kennel Scope Spec §7), same contract as
                                  // listView's. Every report is scoped; the flavor
                                  // depends on what the row IS — a stamped record
                                  // (`inScope`), a dog (`dogInScope`), or a polymorphic
                                  // event scoped through its subject (`subjectInScope`).
                                  // Applied before search/filters, so the CSV export
                                  // exports the scoped set too.
    csvFilename = 'report.csv',
    emptyText = 'No matching records.',
    groupBy = null,
    dateRange = null,             // { label, date:(r)=>YMD, initial? }
    kpis = null,                  // (rows, ctx) => [{ label, value, hint? }]
    charts = null,                // (rows, ctx) => [chartSpec]
    title = null,                 // the printed title; defaults to the page's <h1>
    rowsFor = null                // (records, ctx) => displayRows: a SUMMARY report
                                  // (one row per category, source…) — the filters,
                                  // search and date range pick the records, then this
                                  // groups them; table, totals and CSV show its rows,
                                  // while kpis/charts still get the records
  } = opts;

  let all = [];
  const state = { q: '', filters: {}, preset: dateRange?.initial || 'all', from: '', to: '' };
  const currentRange = () => rangeFor(state.preset, todayYMD(), { from: state.from, to: state.to });

  // --- Toolbar ---
  const toolbar = document.createElement('div');
  toolbar.className = 'list-toolbar';

  let searchInput = null;
  if (search) {
    searchInput = document.createElement('input');
    searchInput.type = 'search';
    searchInput.placeholder = search.placeholder || 'Search…';
    searchInput.addEventListener('input', () => { state.q = searchInput.value.trim().toLowerCase(); render(); });
    toolbar.appendChild(searchInput);
  }

  // The date range: a preset menu, and From / To inputs while it's Custom.
  let customWrap = null;
  if (dateRange) {
    const sel = document.createElement('select');
    sel.setAttribute('aria-label', dateRange.label || 'Date range');
    for (const p of RANGE_PRESETS) {
      const el = document.createElement('option');
      el.value = p.value;
      el.textContent = p.value === 'all' ? `${dateRange.label || 'Date'}: All time` : p.label;
      if (p.value === state.preset) el.selected = true;
      sel.appendChild(el);
    }
    customWrap = document.createElement('span');
    customWrap.className = 'range-custom';
    customWrap.hidden = state.preset !== 'custom';
    customWrap.innerHTML = '<input type="date" aria-label="From"> <span class="muted">to</span> <input type="date" aria-label="To">';
    const [fromEl, toEl] = customWrap.querySelectorAll('input');
    fromEl.addEventListener('change', () => { state.from = fromEl.value; render(); });
    toEl.addEventListener('change', () => { state.to = toEl.value; render(); });
    sel.addEventListener('change', () => {
      state.preset = sel.value;
      customWrap.hidden = state.preset !== 'custom';
      render();
    });
    toolbar.appendChild(sel);
    toolbar.appendChild(customWrap);
  }

  for (const f of filters) {
    const sel = document.createElement('select');
    sel.setAttribute('aria-label', f.label);
    const optAll = document.createElement('option');
    optAll.value = '';
    optAll.textContent = f.label + ': All';
    sel.appendChild(optAll);
    for (const o of f.options) {
      const el = document.createElement('option');
      el.value = o.value;
      el.textContent = o.label;
      sel.appendChild(el);
    }
    sel.addEventListener('change', () => { state.filters[f.id] = sel.value; render(); });
    toolbar.appendChild(sel);
  }

  const spacer = document.createElement('div');
  spacer.className = 'toolbar-spacer';
  toolbar.appendChild(spacer);

  const countEl = document.createElement('span');
  countEl.className = 'muted';
  toolbar.appendChild(countEl);

  // The "🏠 <kennel> only" chip — see listView's copy: a scoped report has to say
  // so, or a short table reads as missing data. Empty when unscoped.
  if (scope) {
    const chip = document.createElement('div');
    toolbar.appendChild(chip);
    mountScopeChip(chip);
  }

  const exportBtn = document.createElement('button');
  exportBtn.className = 'btn btn-sm no-print';
  exportBtn.textContent = '⬇ Export visible to CSV';
  exportBtn.addEventListener('click', exportVisible);

  // Paper only: the letterhead, describing what's on screen when it prints. One
  // per page: a page with two report boxes (Active Breeding, Financials' Income)
  // gets it on the first; the second's button prints the same page (the first's
  // header refreshes itself on beforeprint).
  // (A header inside this mount is about to be replaced, so it doesn't count.)
  const firstOnPage = ![...document.querySelectorAll('.print-header')].some((h) => !mount.contains(h));
  const printHead = firstOnPage ? document.createElement('div') : null;
  let fillHead = async () => {};
  if (printHead) {
    printHead.className = 'print-header';
    fillHead = wirePrintHeader(printHead, {
      title: title || document.querySelector('main h1')?.textContent?.trim() || undefined,
      getDetails: printDetails
    });
  }
  toolbar.appendChild(printButton(fillHead));
  toolbar.appendChild(exportBtn);

  const kpiWrap = document.createElement('div');
  kpiWrap.className = 'stat-grid report-kpis';
  kpiWrap.hidden = !kpis;
  const chartWrap = document.createElement('div');
  chartWrap.className = 'report-charts';
  chartWrap.hidden = !charts;
  const tableWrap = document.createElement('div');
  tableWrap.className = 'report-table';
  tableWrap.style.overflowX = 'auto';

  mount.innerHTML = '';
  if (printHead) mount.appendChild(printHead);
  mount.appendChild(toolbar);
  mount.appendChild(kpiWrap);
  mount.appendChild(chartWrap);
  mount.appendChild(tableWrap);
  const mounted = []; // chart handles, one per chart slot

  // What the printout says it shows: date range, each set filter, the search.
  function printDetails() {
    const out = [];
    if (dateRange) out.push(`${dateRange.label || 'Date'}: ${rangeLabel(state.preset, currentRange(), fmtDate)}`);
    for (const f of filters) {
      const v = state.filters[f.id];
      if (v) out.push(`${f.label}: ${f.options.find((o) => String(o.value) === String(v))?.label ?? v}`);
    }
    if (state.q) out.push(`Search: “${state.q}”`);
    return out;
  }

  function visibleRecords() {
    const range = dateRange ? currentRange() : null;
    return all.filter((r) => {
      if (scope && !scope(r)) return false;
      if (range && !inRange(dateRange.date(r), range)) return false;
      if (state.q && search?.text && !search.text(r).toLowerCase().includes(state.q)) return false;
      for (const f of filters) {
        const v = state.filters[f.id];
        if (v && !f.match(r, v)) return false;
      }
      return true;
    });
  }

  function cellHtml(c, r) {
    const v = c.value(r);
    if (c.badge && v) return badgeHtml(c.badge, v);
    const tone = c.tone && v ? c.tone(r) : null;
    if (tone) return `<span class="badge ${esc(tone)}">${esc(v)}</span>`;
    return v ? esc(v) : '<span class="faint">—</span>';
  }

  const summaryCtx = () => ({ range: dateRange ? currentRange() : { from: null, to: null }, preset: state.preset, records: scope ? all.filter(scope) : all });
  // The rows the table shows (and CSV exports): the visible records, or rowsFor's
  // summary of them.
  const displayRows = (records) => (rowsFor ? rowsFor(records, summaryCtx()) : records);

  function renderSummary(rows) {
    const ctx = summaryCtx();
    if (kpis) {
      const tiles = kpis(rows, ctx) || [];
      kpiWrap.innerHTML = tiles.map((t) => `<div class="stat"><div class="stat-num">${esc(t.value)}</div><div class="stat-label">${esc(t.label)}</div>${t.hint ? `<div class="stat-hint">${esc(t.hint)}</div>` : ''}</div>`).join('');
      kpiWrap.hidden = !tiles.length;
    }
    if (charts) {
      const specs = (charts(rows, ctx) || []).filter(Boolean);
      chartWrap.hidden = !specs.length;
      while (mounted.length > specs.length) { mounted.pop().handle.destroy(); chartWrap.lastElementChild?.remove(); }
      specs.forEach((spec, i) => {
        if (mounted[i]) { mounted[i].handle.update(spec); return; }
        const slot = document.createElement('div');
        slot.className = 'chart-slot';
        chartWrap.appendChild(slot);
        mounted.push({ slot, handle: mountChart(slot, spec) });
      });
    }
  }

  function totalsRow(rows) {
    if (!columns.some((c) => c.total)) return '';
    const cells = columns.map((c, i) => {
      const v = c.total ? c.total(rows) : (i === 0 ? 'Total' : '');
      return `<td class="${c.className || ''}">${v ? esc(v) : ''}</td>`;
    }).join('');
    return `<tfoot><tr class="total-row">${cells}</tr></tfoot>`;
  }

  function render() {
    const records = visibleRecords();
    renderSummary(records);
    const rows = displayRows(records);
    countEl.textContent = rowsFor ? `${records.length} of ${all.length} records` : `${rows.length} of ${all.length}`;
    exportBtn.disabled = rows.length === 0;
    if (!rows.length) {
      tableWrap.innerHTML = `<div class="card empty-state">${esc(emptyText)}</div>`;
      return;
    }
    const head = columns.map((c) => `<th>${esc(c.header)}</th>`).join('');
    let lastGroup = null;
    const body = rows.map((r, i) => {
      const cells = columns.map((c) => `<td class="${c.className || ''}">${cellHtml(c, r)}</td>`).join('');
      let groupRow = '';
      if (groupBy) {
        const g = groupBy(r);
        if (g !== lastGroup) groupRow = `<tr class="group-row"><td colspan="${columns.length}">${esc(g)}</td></tr>`;
        lastGroup = g;
      }
      return `${groupRow}<tr class="${onRowClick ? 'clickable' : ''}" data-idx="${i}">${cells}</tr>`;
    }).join('');
    tableWrap.innerHTML = `<table class="data"><thead><tr>${head}</tr></thead><tbody>${body}</tbody>${totalsRow(rows)}</table>`;

    if (onRowClick) {
      tableWrap.querySelectorAll('tbody tr[data-idx]').forEach((tr) => {
        tr.addEventListener('click', () => onRowClick(rows[Number(tr.dataset.idx)]));
      });
    }
  }

  function exportVisible() {
    const rows = displayRows(visibleRecords());
    const data = rows.map((r) => {
      const o = {};
      for (const c of columns) o[c.header] = c.csv ? c.csv(r) : c.value(r);
      return o;
    });
    const csv = Papa.unparse({ fields: columns.map((c) => c.header), data });
    downloadCsv(csvFilename, csv);
  }

  async function refresh() {
    all = await load();
    render();
  }

  refresh();
  return { refresh, get records() { return all; } };
}
