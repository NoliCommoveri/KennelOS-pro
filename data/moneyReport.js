// moneyReport.js — money in and out by period, for the Profit & Loss by Month
// report and Year in Review (Reports plan, phase 1). A derived read, like
// incomeView.js and litterFinances.js: nothing stored.
//
// It reads the SAME two sources the Financials Overview does, scoped the same
// way, so the reports can never disagree with it: income rows from
// incomeView.getIncomeRows (scoped at the source) and the Expense ledger, each
// expense scoped through the subject it hangs off (Multi-Kennel Scope Spec §7).
//
// P&L is CASH BASIS: earned income is filed under the date its money moved (each
// component's `when`, incomeView.saleComponentDate), expenses under expense_date.
// Anticipated income is reported separately, under its due date, never in Net.
// Non-cash pick value is never money in.
import { getIncomeRows } from './incomeView.js';
import { expenseRepo } from './expenseRepo.js';
import { dogRepo } from './dogRepo.js';
import { litterRepo } from './litterRepo.js';
import { pairingRepo } from './pairingRepo.js';
import { subjectInScope } from './kennelScope.js';
import { periodKey } from './reportMath.js';

// The in-scope income rows and expenses, loaded once.
export async function loadMoney() {
  const [incomeRows, allExpenses, dogs, litters, pairings] = await Promise.all([
    getIncomeRows({ includeArchived: false }),
    expenseRepo.getAll({ includeArchived: false }),
    dogRepo.getAll({ includeArchived: true }),
    litterRepo.getAll({ includeArchived: true }),
    pairingRepo.getAll({ includeArchived: true })
  ]);
  const maps = {
    dog: new Map(dogs.map((d) => [d.id, d])),
    litter: new Map(litters.map((l) => [l.id, l])),
    pairing: new Map(pairings.map((p) => [p.id, p]))
  };
  const expenses = allExpenses.filter((x) => subjectInScope(x.subject_type, x.subject_id, maps));
  return { incomeRows, expenses };
}

// Flatten income rows into one dated entry per cash component:
// { date, amount, state: 'earned' | 'anticipated', component, source_type, row }.
// PURE.
export function incomeEntries(incomeRows) {
  const out = [];
  for (const r of incomeRows) {
    for (const c of r.components || []) {
      if (c.state !== 'earned' && c.state !== 'anticipated') continue; // pick is non-cash
      out.push({ date: c.when || r.date || '', due: c.due || '', amount: Number(c.amount) || 0, state: c.state, component: c.component, source_type: r.source_type, row: r });
    }
  }
  return out;
}

// One row per period: { period, income (earned), anticipated, expenses, net,
// cumulative } with every period present. Entries/expenses outside the periods
// are left out. PURE.
export function plByPeriod(entries, expenses, periods, granularity = 'month') {
  const rows = new Map(periods.map((p) => [p, { period: p, income: 0, anticipated: 0, expenses: 0, net: 0, cumulative: 0 }]));
  for (const e of entries) {
    const row = rows.get(periodKey(e.date, granularity));
    if (!row) continue;
    if (e.state === 'earned') row.income += e.amount;
    else row.anticipated += e.amount;
  }
  for (const x of expenses) {
    const row = rows.get(periodKey(x.expense_date, granularity));
    if (row) row.expenses += Number(x.amount) || 0;
  }
  let run = 0;
  for (const row of rows.values()) {
    row.net = row.income - row.expenses;
    run += row.net;
    row.cumulative = run;
  }
  return [...rows.values()];
}

// Totals by key over a date range: earned income by component, expenses by
// category. PURE. `inRangeFn(ymd)` decides membership.
export function moneyBreakdown(entries, expenses, inRangeFn) {
  const income = new Map();
  const spent = new Map();
  for (const e of entries) if (e.state === 'earned' && inRangeFn(e.date)) income.set(e.component, (income.get(e.component) || 0) + e.amount);
  for (const x of expenses) if (inRangeFn(x.expense_date)) spent.set(x.category, (spent.get(x.category) || 0) + (Number(x.amount) || 0));
  return { income, spent };
}

// --- Receivables (Reports plan, phase 3) -------------------------------------------------

// How overdue money still owed is, in buckets, in menu order.
export const AGE_BUCKETS = [
  { value: 'not_due', label: 'Not due yet' },
  { value: 'd30',     label: '1–30 days overdue' },
  { value: 'd60',     label: '31–60 days overdue' },
  { value: 'd90',     label: '61–90 days overdue' },
  { value: 'd90plus', label: 'Over 90 days overdue' },
  { value: 'undated', label: 'No due date' }
];

const dayMs = (ymd) => Date.UTC(Number(ymd.slice(0, 4)), Number(ymd.slice(5, 7)) - 1, Number(ymd.slice(8, 10)));

// Days past due (negative = not due yet; null = no due date).
export function daysOverdue(dueYMD, today) {
  if (!dueYMD) return null;
  return Math.round((dayMs(today) - dayMs(dueYMD)) / 86400000);
}

export function ageBucket(dueYMD, today) {
  const d = daysOverdue(dueYMD, today);
  if (d == null) return 'undated';
  if (d <= 0) return 'not_due';
  if (d <= 30) return 'd30';
  if (d <= 60) return 'd60';
  if (d <= 90) return 'd90';
  return 'd90plus';
}

// Money still owed to the program: every anticipated income component (a deposit
// not yet in, a balance, transport and boarding, a stud fee), aged by the due date
// she SET (a sale's balance_due_date) — a component without one is "No due date",
// never aged from the sale date,
// plus foster costs fronted and not yet paid back (litterFinances.reimbursablePending,
// one row per litter, no due date). PURE. `fosterOwed` = [{ litter, amount, label }].
export function receivableRows(entries, today, fosterOwed = []) {
  const rows = entries.filter((e) => e.state === 'anticipated' && e.amount > 0).map((e) => ({
    due: e.due || '',
    amount: e.amount,
    component: e.component,
    who: e.row.counterparty,
    what: e.row.dog,
    href: e.row.href,
    source_type: e.source_type,
    bucket: ageBucket(e.due, today)
  }));
  for (const f of fosterOwed) {
    if (!(f.amount > 0)) continue;
    rows.push({ due: '', amount: f.amount, component: 'foster_reimbursable', who: f.label, what: f.litterLabel || '', href: `litter.html?id=${encodeURIComponent(f.litter.id)}`, source_type: 'litter', bucket: 'undated' });
  }
  return rows.sort((a, b) => (a.due || '9999').localeCompare(b.due || '9999'));
}

// --- Pricing ------------------------------------------------------------------------------

// One row per placed sale with a price: the sale, its pup and litter, and the price
// the litter's defaults would have prefilled for that sex and registration
// (saleDefaults.expectedPricing). PURE; `expectedFor(sale)` is injected.
export function pricingRows(sales, { dogsById, isPlaced, expectedFor }) {
  return sales
    .filter((s) => isPlaced(s) && s.price !== '' && s.price != null && Number.isFinite(Number(s.price)))
    .map((s) => {
      const dog = dogsById.get(s.dog_id) || null;
      const expected = expectedFor(s);
      return { sale: s, dog, price: Number(s.price), expected: expected == null ? null : Number(expected), diff: expected == null ? null : Number(s.price) - Number(expected) };
    })
    .sort((a, b) => (b.sale.sale_date || '').localeCompare(a.sale.sale_date || ''));
}

// Average of `value` per group key: [{ key, avg, count }].
export function averageBy(rows, key, value) {
  const m = new Map();
  for (const r of rows) {
    const k = key(r);
    const acc = m.get(k) || { key: k, sum: 0, count: 0 };
    acc.sum += Number(value(r)) || 0;
    acc.count += 1;
    m.set(k, acc);
  }
  return [...m.values()].map((a) => ({ key: a.key, avg: a.sum / a.count, count: a.count }));
}

// --- Breeding-dog return -----------------------------------------------------------------

// Per dam and sire of a litter in `litters`: what their litters' puppies brought in
// (earned and still anticipated, from the income rows carrying those litter ids —
// sales and credited application fees), stud fees the dog earned itself (outgoing
// stud income rows on its id), and its own lifetime costs (expenses on the dog).
// A litter's income counts for BOTH its parents — this is each dog's view, not a
// split. PURE.
export function dogReturnRows({ dogs, litters, incomeRows, expenses, sales, isPlaced }) {
  const out = [];
  for (const dog of dogs) {
    const role = dog.sex === 'female' ? 'dam' : dog.sex === 'male' ? 'sire' : null;
    if (!role) continue;
    const mine = litters.filter((l) => (role === 'dam' ? l.dam_id : l.sire_id) === dog.id && l.status !== 'expected');
    const studRows = incomeRows.filter((r) => r.source_type === 'stud' && r.dog_id === dog.id);
    if (!mine.length && !studRows.length) continue;
    const ids = new Set(mine.map((l) => l.id));
    const pupRows = incomeRows.filter((r) => r.litter_id && ids.has(r.litter_id));
    const pupIds = new Set(dogs.filter((d) => d.litter_id && ids.has(d.litter_id)).map((d) => d.id));
    const pupsSold = new Set(sales.filter((s) => isPlaced(s) && pupIds.has(s.dog_id)).map((s) => s.dog_id)).size;
    const earned = pupRows.reduce((t, r) => t + r.earned, 0);
    const studFees = studRows.reduce((t, r) => t + r.earned, 0);
    const anticipated = pupRows.reduce((t, r) => t + r.anticipated, 0) + studRows.reduce((t, r) => t + r.anticipated, 0);
    const costs = expenses.filter((x) => x.subject_type === 'dog' && x.subject_id === dog.id).reduce((t, x) => t + (Number(x.amount) || 0), 0);
    out.push({ dog, role, litters: mine.length, pupsSold, earned, studFees, anticipated, costs, net: earned + studFees - costs });
  }
  return out.sort((a, b) => b.net - a.net);
}
