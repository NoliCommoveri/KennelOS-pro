// litter-finances-report.js — "Litter P&L" analytics. One row per litter: puppy-
// sale income (earned / anticipated) vs the full litter cost (litter expenses +
// each puppy's own expenses) and the net. A derived read (data/litterFinances.js)
// over Sale + Expense + Litter + Dog — no new schema, no stored aggregate. Same
// reportView framework every other report uses.
import { getLitterFinances } from '../data/litterFinances.js';
import { dogRepo } from '../data/dogRepo.js';
import { createReportView } from '../assets/reportView.js';
import { inScope } from '../data/kennelScope.js';
import { fmtDate, fmtMoney } from '../assets/ui.js';
import { sumOf } from '../data/reportMath.js';
import { LITTER_STATUS, FOSTER_DIRECTION, descriptor } from '../data/vocab.js';

async function init() {
  const [finances, dogs] = await Promise.all([
    getLitterFinances(),
    dogRepo.getAll({ includeArchived: true })
  ]);
  const dogsById = new Map(dogs.map((d) => [d.id, d]));
  const name = (id) => dogsById.get(id)?.call_name || '—';

  // Newest litters first; the money columns read right off the derived rows.
  finances.sort((a, b) => (b.litter.whelp_date || '').localeCompare(a.litter.whelp_date || ''));

  createReportView({
    mount: document.getElementById('report-mount'),
    // Active-kennel scope (Multi-Kennel Scope Spec §7) — each row IS a litter, so
    // the litter's own stamped kennel scopes its whole P&L (its income rows and its
    // cost rows all hang off it).
    scope: (f) => inScope(f.litter),
    csvFilename: `litter-pl-${new Date().toISOString().slice(0, 10)}.csv`,
    search: {
      placeholder: 'Search nickname, dam, or sire…',
      text: (f) => `${f.litter.nickname || ''} ${name(f.litter.dam_id)} ${name(f.litter.sire_id)}`
    },
    dateRange: { label: 'Whelped', date: (f) => f.litter.whelp_date },
    kpis: (rows) => {
      const earned = sumOf(rows, (f) => f.earned);
      const spent = sumOf(rows, (f) => f.totalExpenses);
      const pups = sumOf(rows, (f) => f.puppiesSold);
      return [
        { label: 'Earned', value: fmtMoney(earned) },
        { label: 'Anticipated', value: fmtMoney(sumOf(rows, (f) => f.anticipated)) },
        { label: 'Expenses', value: fmtMoney(spent) },
        { label: 'Net', value: fmtMoney(sumOf(rows, (f) => f.net)), hint: pups ? `${fmtMoney((earned - spent) / pups)} earned net per pup sold` : '' }
      ];
    },
    // Oldest → newest left to right, so the chart reads as a timeline; blue above
    // the line is a litter in profit, red below it one that cost more than it made.
    charts: (rows) => {
      const ordered = [...rows].sort((a, b) => (a.litter.whelp_date || '').localeCompare(b.litter.whelp_date || ''));
      const label = (f) => f.litter.nickname || `${name(f.litter.dam_id)} × ${name(f.litter.sire_id)}`;
      return [{
        type: 'bar', diverging: true, money: true, title: 'Net by litter', subtitle: 'Earned − expenses, oldest first',
        format: (v) => fmtMoney(v),
        categories: ordered.map((f) => ({ key: f.litter.id, label: `${label(f)}${f.litter.whelp_date ? ` (${fmtDate(f.litter.whelp_date)})` : ''}`, short: label(f) })),
        series: [{ name: 'Net', values: ordered.map((f) => f.net) }]
      }];
    },
    filters: [
      { id: 'status', label: 'Status', options: LITTER_STATUS, match: (f, v) => f.litter.status === v },
      { id: 'foster', label: 'Foster', options: FOSTER_DIRECTION, match: (f, v) => f.fosterDirection === v }
    ],
    columns: [
      { header: 'Whelp date', value: (f) => (f.litter.whelp_date ? fmtDate(f.litter.whelp_date) : ''), csv: (f) => f.litter.whelp_date || '' },
      { header: 'Dam', value: (f) => name(f.litter.dam_id) },
      { header: 'Sire', value: (f) => name(f.litter.sire_id) },
      { header: 'Sold', value: (f) => (f.puppiesSold ? String(f.puppiesSold) : ''), csv: (f) => String(f.puppiesSold), total: (rows) => String(sumOf(rows, (f) => f.puppiesSold)) },
      { header: 'Earned', value: (f) => (f.earned ? fmtMoney(f.earned) : ''), csv: (f) => String(f.earned || ''), className: 'num', total: (rows) => fmtMoney(sumOf(rows, (f) => f.earned)) },
      { header: 'Anticipated', value: (f) => (f.anticipated ? fmtMoney(f.anticipated) : ''), csv: (f) => String(f.anticipated || ''), className: 'num', total: (rows) => fmtMoney(sumOf(rows, (f) => f.anticipated)) },
      { header: 'Expenses', value: (f) => (f.totalExpenses ? fmtMoney(f.totalExpenses) : ''), csv: (f) => String(f.totalExpenses || ''), className: 'num', total: (rows) => fmtMoney(sumOf(rows, (f) => f.totalExpenses)) },
      // Reimbursable costs you've fronted but not yet been paid back for (a
      // receivable) — foster-in owner-reimbursables that are still outstanding.
      { header: 'Owed back', value: (f) => (f.reimbursablePending ? fmtMoney(f.reimbursablePending) : ''), csv: (f) => String(f.reimbursablePending || ''), className: 'num', total: (rows) => fmtMoney(sumOf(rows, (f) => f.reimbursablePending)) },
      { header: 'Net', value: (f) => fmtMoney(f.net), csv: (f) => String(f.net), className: 'num', total: (rows) => fmtMoney(sumOf(rows, (f) => f.net)) },
      { header: 'Foster', collapse: true, value: (f) => f.fosterDirection || '', badge: FOSTER_DIRECTION, csv: (f) => f.fosterDirection ? descriptor(FOSTER_DIRECTION, f.fosterDirection).label : '' },
      { header: 'Status', value: (f) => f.litter.status || '', badge: LITTER_STATUS, csv: (f) => f.litter.status ? descriptor(LITTER_STATUS, f.litter.status).label : '' }
    ],
    onRowClick: (f) => { location.href = `litter.html?id=${encodeURIComponent(f.litter.id)}`; },
    load: () => Promise.resolve(finances),
    emptyText: 'No litters recorded yet.'
  });
}

init();
