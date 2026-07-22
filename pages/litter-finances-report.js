// litter-finances-report.js — "Litter P&L" analytics. One row per litter: puppy-
// sale income (earned / anticipated) vs the full litter cost (litter expenses +
// each puppy's own expenses) and the net. A derived read (data/litterFinances.js)
// over Sale + Expense + Litter + Dog — no new schema, no stored aggregate. Same
// reportView framework every other report uses.
import { getLitterFinances } from '../data/litterFinances.js';
import { dogRepo } from '../data/dogRepo.js';
import { createReportView } from '../assets/reportView.js';
import { fmtDate, fmtMoney } from '../assets/ui.js';
import { LITTER_STATUS, FOSTER_DIRECTION, descriptor } from '../data/vocab.js';

async function init() {
  const [finances, dogs] = await Promise.all([
    getLitterFinances(),
    dogRepo.getAll({ includeArchived: true })
  ]);
  const dogsById = new Map(dogs.map((d) => [d.id, d]));
  const name = (id) => dogsById.get(id)?.call_name || '—';
  const year = (f) => (f.litter.whelp_date || '').slice(0, 4);
  const years = [...new Set(finances.map(year).filter(Boolean))].sort().reverse();

  // Newest litters first; the money columns read right off the derived rows.
  finances.sort((a, b) => (b.litter.whelp_date || '').localeCompare(a.litter.whelp_date || ''));

  createReportView({
    mount: document.getElementById('report-mount'),
    csvFilename: `litter-pl-${new Date().toISOString().slice(0, 10)}.csv`,
    search: {
      placeholder: 'Search nickname, dam, or sire…',
      text: (f) => `${f.litter.nickname || ''} ${name(f.litter.dam_id)} ${name(f.litter.sire_id)}`
    },
    filters: [
      { id: 'year', label: 'Year', options: years.map((y) => ({ value: y, label: y })), match: (f, v) => year(f) === v },
      { id: 'status', label: 'Status', options: LITTER_STATUS, match: (f, v) => f.litter.status === v },
      { id: 'foster', label: 'Foster', options: FOSTER_DIRECTION, match: (f, v) => f.fosterDirection === v }
    ],
    columns: [
      { header: 'Whelp date', value: (f) => (f.litter.whelp_date ? fmtDate(f.litter.whelp_date) : ''), csv: (f) => f.litter.whelp_date || '' },
      { header: 'Dam', value: (f) => name(f.litter.dam_id) },
      { header: 'Sire', value: (f) => name(f.litter.sire_id) },
      { header: 'Sold', value: (f) => (f.puppiesSold ? String(f.puppiesSold) : ''), csv: (f) => String(f.puppiesSold) },
      { header: 'Earned', value: (f) => (f.earned ? fmtMoney(f.earned) : ''), csv: (f) => String(f.earned || '') },
      { header: 'Anticipated', value: (f) => (f.anticipated ? fmtMoney(f.anticipated) : ''), csv: (f) => String(f.anticipated || '') },
      { header: 'Expenses', value: (f) => (f.totalExpenses ? fmtMoney(f.totalExpenses) : ''), csv: (f) => String(f.totalExpenses || '') },
      // Reimbursable costs you've fronted but not yet been paid back for (a
      // receivable) — foster-in owner-reimbursables that are still outstanding.
      { header: 'Owed back', value: (f) => (f.reimbursablePending ? fmtMoney(f.reimbursablePending) : ''), csv: (f) => String(f.reimbursablePending || '') },
      { header: 'Net', value: (f) => fmtMoney(f.net), csv: (f) => String(f.net) },
      { header: 'Foster', collapse: true, value: (f) => f.fosterDirection || '', badge: FOSTER_DIRECTION, csv: (f) => f.fosterDirection ? descriptor(FOSTER_DIRECTION, f.fosterDirection).label : '' },
      { header: 'Status', value: (f) => f.litter.status || '', badge: LITTER_STATUS, csv: (f) => f.litter.status ? descriptor(LITTER_STATUS, f.litter.status).label : '' }
    ],
    onRowClick: (f) => { location.href = `litter.html?id=${encodeURIComponent(f.litter.id)}`; },
    load: () => Promise.resolve(finances),
    emptyText: 'No litters recorded yet.'
  });
}

init();
