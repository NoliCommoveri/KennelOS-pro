// receivables-report.js — "Receivables" (Reports plan, phase 3): money still owed to
// the program. Every anticipated income component (incomeView's own split: a deposit
// not yet in, a balance, transport, boarding, a stud fee) under its due date, plus
// foster costs fronted and not yet paid back (litterFinances.reimbursablePending).
// Aged into buckets from today. Pure math in data/moneyReport.js.
import { loadMoney, incomeEntries, receivableRows, AGE_BUCKETS, daysOverdue } from '../data/moneyReport.js';
import { getLitterFinances } from '../data/litterFinances.js';
import { dogRepo } from '../data/dogRepo.js';
import { contactRepo } from '../data/contactRepo.js';
import { createReportView } from '../assets/reportView.js';
import { inScope } from '../data/kennelScope.js';
import { fmtDate, fmtMoney } from '../assets/ui.js';
import { todayYMD } from '../data/dateUtils.js';
import { INCOME_COMPONENTS, descriptor } from '../data/vocab.js';
import { sumOf } from '../data/reportMath.js';
import { SERIES_COLORS } from '../assets/chartView.js';

const money = (v) => fmtMoney(Math.round((Number(v) || 0) * 100) / 100);
const WHAT = [...INCOME_COMPONENTS.filter((c) => c.value !== 'pick'), { value: 'foster_reimbursable', label: 'Foster costs owed back' }];
const OVERDUE = ['d30', 'd60', 'd90', 'd90plus'];

async function init() {
  const today = todayYMD();
  const [{ incomeRows }, finances, dogs, contacts] = await Promise.all([
    loadMoney(), getLitterFinances(), dogRepo.getAll({ includeArchived: true }), contactRepo.getAll({ includeArchived: true })
  ]);
  const name = new Map(dogs.map((d) => [d.id, d.call_name || '—']));
  const contactName = new Map(contacts.map((c) => [c.id, c.name || '—']));
  const fosterOwed = finances.filter((f) => inScope(f.litter) && f.reimbursablePending > 0).map((f) => ({
    litter: f.litter, amount: f.reimbursablePending,
    label: contactName.get(f.litter.foster_partner_contact_id) || 'Foster partner',
    litterLabel: f.litter.nickname || `${name.get(f.litter.dam_id) || '—'} × ${name.get(f.litter.sire_id) || '—'}`
  }));
  const rows = receivableRows(incomeEntries(incomeRows), today, fosterOwed);

  createReportView({
    mount: document.getElementById('report-mount'),
    csvFilename: `receivables-${today}.csv`,
    search: { placeholder: 'Search who or which pup…', text: (r) => `${r.who} ${r.what}` },
    filters: [
      { id: 'bucket', label: 'Age', options: AGE_BUCKETS, match: (r, v) => r.bucket === v },
      { id: 'what', label: 'For', options: WHAT, match: (r, v) => r.component === v }
    ],
    kpis: (list) => {
      const overdue = list.filter((r) => OVERDUE.includes(r.bucket));
      const soon = list.filter((r) => r.due && r.due >= today && daysOverdue(r.due, today) >= -30);
      return [
        { label: 'Owed to you', value: money(sumOf(list, (r) => r.amount)), hint: `${list.length} item${list.length === 1 ? '' : 's'}` },
        { label: 'Overdue', value: money(sumOf(overdue, (r) => r.amount)), hint: `${overdue.length} item${overdue.length === 1 ? '' : 's'}` },
        { label: 'Due in 30 days', value: money(sumOf(soon, (r) => r.amount)) },
        { label: 'Foster owed back', value: money(sumOf(list.filter((r) => r.component === 'foster_reimbursable'), (r) => r.amount)) }
      ];
    },
    charts: (list) => [{
      type: 'hbar', title: 'How overdue', sort: false, format: money, color: SERIES_COLORS[1],
      rows: AGE_BUCKETS.map((b) => ({ label: b.label, value: sumOf(list.filter((r) => r.bucket === b.value), (r) => r.amount), note: `${list.filter((r) => r.bucket === b.value).length} items` })),
      emptyText: 'Nothing is owed to you.'
    }],
    columns: [
      { header: 'Due', value: (r) => (r.due ? fmtDate(r.due) : ''), csv: (r) => r.due },
      { header: 'From', value: (r) => r.who },
      { header: 'Pup / litter', value: (r) => r.what },
      { header: 'For', value: (r) => descriptor(WHAT, r.component).label },
      { header: 'Amount', value: (r) => money(r.amount), csv: (r) => String(r.amount), className: 'num', total: (list) => money(sumOf(list, (r) => r.amount)) },
      { header: 'Age', value: (r) => descriptor(AGE_BUCKETS, r.bucket).label, className: 'num',
        tone: (r) => (r.bucket === 'd90plus' || r.bucket === 'd90' ? 'badge-red' : OVERDUE.includes(r.bucket) ? 'badge-amber' : null) }
    ],
    onRowClick: (r) => { if (r.href) location.href = r.href; },
    load: () => Promise.resolve(rows),
    emptyText: 'Nothing is owed to you.'
  });
}

init();
