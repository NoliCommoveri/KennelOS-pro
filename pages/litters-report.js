// litters-report.js — "Litters over time" analytics (Stage 5, Build Brief §5).
// Reuses the Stage 1 reporting framework (list + columns + filters + CSV export)
// exactly as Active Roster does. A derived read over Litter — no new schema, no
// stored aggregate. Whelp counts by year are surfaced as a filterable Year
// column rather than a pre-rolled rollup.
import { litterRepo } from '../data/litterRepo.js';
import { dogRepo } from '../data/dogRepo.js';
import { createReportView } from '../assets/reportView.js';
import { fmtDate } from '../assets/ui.js';
import { LITTER_STATUS, descriptor } from '../data/vocab.js';

async function init() {
  const [litters, dogs] = await Promise.all([
    litterRepo.getAll({ includeArchived: false }),
    dogRepo.getAll({ includeArchived: true })
  ]);
  const dogsById = new Map(dogs.map((d) => [d.id, d]));
  const name = (id) => dogsById.get(id)?.call_name || '—';
  const year = (l) => (l.whelp_date || '').slice(0, 4);
  const years = [...new Set(litters.map(year).filter(Boolean))].sort().reverse();

  litters.sort((a, b) => (b.whelp_date || '').localeCompare(a.whelp_date || ''));

  createReportView({
    mount: document.getElementById('report-mount'),
    csvFilename: `litters-${new Date().toISOString().slice(0, 10)}.csv`,
    search: { placeholder: 'Search nickname, dam, or sire…', text: (l) => `${l.nickname || ''} ${name(l.dam_id)} ${name(l.sire_id)}` },
    filters: [
      { id: 'year', label: 'Year', options: years.map((y) => ({ value: y, label: y })), match: (l, v) => year(l) === v },
      { id: 'status', label: 'Status', options: LITTER_STATUS, match: (l, v) => l.status === v }
    ],
    columns: [
      { header: 'Whelp date', value: (l) => (l.whelp_date ? fmtDate(l.whelp_date) : ''), csv: (l) => l.whelp_date || '' },
      { header: 'Year', value: year },
      { header: 'Nickname', value: (l) => l.nickname || '' },
      { header: 'Dam', value: (l) => name(l.dam_id) },
      { header: 'Sire', value: (l) => name(l.sire_id) },
      { header: 'Born total', value: (l) => (l.puppies_born_total ?? '') === '' ? '' : String(l.puppies_born_total) },
      { header: 'Born alive', value: (l) => (l.puppies_born_alive ?? '') === '' ? '' : String(l.puppies_born_alive) },
      { header: 'Status', value: (l) => l.status || '', badge: LITTER_STATUS, csv: (l) => l.status ? descriptor(LITTER_STATUS, l.status).label : '' }
    ],
    onRowClick: (l) => { location.href = `litter.html?id=${encodeURIComponent(l.id)}`; },
    load: () => Promise.resolve(litters),
    emptyText: 'No litters recorded yet.'
  });
}

init();
