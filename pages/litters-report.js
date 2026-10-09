// litters-report.js — "Litters over time" analytics (Stage 5, Build Brief §5).
// Reuses the Stage 1 reporting framework (list + columns + filters + CSV export)
// exactly as Active Roster does. A derived read over Litter — no new schema, no
// stored aggregate. Whelp counts by year are surfaced as a filterable Year
// column rather than a pre-rolled rollup; the chart and tiles are computed from
// the visible rows on every render (Reports plan, phase 1).
import { litterRepo } from '../data/litterRepo.js';
import { dogRepo } from '../data/dogRepo.js';
import { createReportView } from '../assets/reportView.js';
import { inScope } from '../data/kennelScope.js';
import { fmtDate } from '../assets/ui.js';
import { periodSeries, sumOf } from '../data/reportMath.js';
import { LITTER_STATUS, descriptor } from '../data/vocab.js';

async function init() {
  const [litters, dogs] = await Promise.all([
    litterRepo.getAll({ includeArchived: false }),
    dogRepo.getAll({ includeArchived: true })
  ]);
  const dogsById = new Map(dogs.map((d) => [d.id, d]));
  const name = (id) => dogsById.get(id)?.call_name || '—';
  const year = (l) => (l.whelp_date || '').slice(0, 4);

  litters.sort((a, b) => (b.whelp_date || '').localeCompare(a.whelp_date || ''));

  createReportView({
    mount: document.getElementById('report-mount'),
    // Active-kennel scope (Multi-Kennel Scope Spec §7).
    scope: inScope,
    csvFilename: `litters-${new Date().toISOString().slice(0, 10)}.csv`,
    search: { placeholder: 'Search nickname, dam, or sire…', text: (l) => `${l.nickname || ''} ${name(l.dam_id)} ${name(l.sire_id)}` },
    dateRange: { label: 'Whelped', date: (l) => l.whelp_date },
    filters: [
      { id: 'status', label: 'Status', options: LITTER_STATUS, match: (l, v) => l.status === v }
    ],
    kpis: (rows) => {
      const born = rows.filter((l) => Number(l.puppies_born_total) > 0);
      const total = sumOf(born, (l) => l.puppies_born_total);
      return [
        { label: 'Litters', value: String(rows.length) },
        { label: 'Puppies born', value: String(total) },
        { label: 'Born alive', value: String(sumOf(born, (l) => l.puppies_born_alive)) },
        { label: 'Average litter', value: born.length ? (total / born.length).toFixed(1) : '—', hint: born.length ? `over ${born.length} with counts` : '' }
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
    load: () => Promise.resolve(litters),
    emptyText: 'No litters recorded yet.'
  });
}

init();
