// litters-report.js — "Litters over time" analytics (Stage 5, Build Brief §5).
// Reuses the Stage 1 reporting framework (list + columns + filters + CSV export)
// exactly as Active Roster does. A derived read over Litter — no new schema, no
// stored aggregate. Whelp counts by year are surfaced as a filterable Year
// column rather than a pre-rolled rollup; the chart and tiles are computed from
// the visible rows on every render (Reports plan, phase 1).
import { loadLitters } from '../data/reportSources.js';
import { litterFigures } from '../data/reportFigures.js';
import { createReportView } from '../assets/reportView.js';
import { fmtDate } from '../assets/ui.js';
import { periodSeries, sumOf } from '../data/reportMath.js';
import { LITTER_STATUS, descriptor } from '../data/vocab.js';

async function init() {
  const src = await loadLitters();
  const dogsById = new Map(src.dogs.map((d) => [d.id, d]));
  const name = (id) => dogsById.get(id)?.call_name || '—';
  const year = (l) => (l.whelp_date || '').slice(0, 4);

  createReportView({
    mount: document.getElementById('report-mount'),
    // Active-kennel scope (Multi-Kennel Scope Spec §7).
    scope: src.scope,
    csvFilename: `litters-${new Date().toISOString().slice(0, 10)}.csv`,
    search: { placeholder: 'Search nickname, dam, or sire…', text: (l) => `${l.nickname || ''} ${name(l.dam_id)} ${name(l.sire_id)}` },
    dateRange: { label: 'Whelped', date: src.date },
    filters: [
      { id: 'status', label: 'Status', options: LITTER_STATUS, match: (l, v) => l.status === v }
    ],
    kpis: (rows) => {
      const f = litterFigures(rows);
      return [
        { label: 'Litters', value: String(f.litters) },
        { label: 'Puppies born', value: String(f.born) },
        { label: 'Born alive', value: String(f.alive) },
        { label: 'Average litter', value: f.avgLitter == null ? '—' : f.avgLitter.toFixed(1), hint: f.counted ? `over ${f.counted} with counts` : '' }
      ];
    },
    charts: (rows, ctx) => {
      const dated = rows.filter((l) => l.whelp_date);
      const p = periodSeries(dated, ctx.range, { date: (l) => l.whelp_date, series: [{ name: 'Litters' }] });
      const pups = periodSeries(dated, ctx.range, { date: (l) => l.whelp_date, series: [{ name: 'Puppies born', value: (l) => l.puppies_born_total }] });
      return [
        { type: 'bar', title: `Litters by ${p.granularity}`, categories: p.categories, series: p.series },
        { type: 'bar', title: `Puppies born by ${p.granularity}`, categories: pups.categories, series: pups.series }
      ];
    },
    columns: [
      { header: 'Whelp date', value: (l) => (l.whelp_date ? fmtDate(l.whelp_date) : ''), csv: (l) => l.whelp_date || '' },
      { header: 'Year', value: year },
      { header: 'Nickname', value: (l) => l.nickname || '' },
      { header: 'Dam', value: (l) => name(l.dam_id) },
      { header: 'Sire', value: (l) => name(l.sire_id) },
      { header: 'Born total', value: (l) => (l.puppies_born_total ?? '') === '' ? '' : String(l.puppies_born_total), total: (rows) => String(sumOf(rows, (l) => l.puppies_born_total)) },
      { header: 'Born alive', value: (l) => (l.puppies_born_alive ?? '') === '' ? '' : String(l.puppies_born_alive), total: (rows) => String(sumOf(rows, (l) => l.puppies_born_alive)) },
      { header: 'Status', value: (l) => l.status || '', badge: LITTER_STATUS, csv: (l) => l.status ? descriptor(LITTER_STATUS, l.status).label : '' }
    ],
    onRowClick: (l) => { location.href = `litter.html?id=${encodeURIComponent(l.id)}`; },
    load: () => Promise.resolve(src.rows),
    emptyText: 'No litters recorded yet.'
  });
}

init();
