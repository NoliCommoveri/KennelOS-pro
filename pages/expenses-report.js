// expenses-report.js — "Expenses by Category" (Reports plan, phase 3): the tax-time
// summary. A summary report (reportView `rowsFor`): the date range, filters and
// search pick expenses, and the table shows one row per category with its total,
// entry count and share. The expenses are moneyReport.loadMoney's — scoped exactly
// as the Financials Overview scopes them — so the totals always agree with it.
import { loadMoney } from '../data/moneyReport.js';
import { createReportView } from '../assets/reportView.js';
import { fmtMoney } from '../assets/ui.js';
import { EXPENSE_CATEGORIES, EXPENSE_SUBJECT_TYPES, descriptor } from '../data/vocab.js';
import { periodSeries, sumOf, rankBy } from '../data/reportMath.js';
import { SERIES_COLORS } from '../assets/chartView.js';

const money = (v) => fmtMoney(Math.round((Number(v) || 0) * 100) / 100);

async function init() {
  const { expenses } = await loadMoney();
  expenses.sort((a, b) => (b.expense_date || '').localeCompare(a.expense_date || ''));

  createReportView({
    mount: document.getElementById('report-mount'),
    csvFilename: `expenses-by-category-${new Date().toISOString().slice(0, 10)}.csv`,
    search: { placeholder: 'Search notes or vendor…', text: (x) => `${x.description || ''} ${x.vendor || ''} ${x.notes || ''}` },
    dateRange: { label: 'Spent', date: (x) => x.expense_date, initial: 'this_year' },
    filters: [
      { id: 'category', label: 'Category', options: EXPENSE_CATEGORIES, match: (x, v) => x.category === v },
      { id: 'subject', label: 'Spent on', options: EXPENSE_SUBJECT_TYPES, match: (x, v) => x.subject_type === v }
    ],
    rowsFor: (list) => {
      const total = sumOf(list, (x) => x.amount);
      return EXPENSE_CATEGORIES.map((c) => {
        const xs = list.filter((x) => x.category === c.value);
        const amount = sumOf(xs, (x) => x.amount);
        return { category: c.value, amount, count: xs.length, share: total ? amount / total : 0 };
      }).filter((r) => r.count);
    },
    kpis: (list) => {
      const total = sumOf(list, (x) => x.amount);
      const top = rankBy(list, { key: (x) => x.category, value: (x) => x.amount })[0];
      return [
        { label: 'Total spent', value: money(total) },
        { label: 'Entries', value: String(list.length) },
        { label: 'Largest category', value: top ? descriptor(EXPENSE_CATEGORIES, top.key).label : '—', hint: top ? money(top.value) : '' },
        { label: 'Mileage logged', value: sumOf(list, (x) => x.miles) ? `${Math.round(sumOf(list, (x) => x.miles))} mi` : '—', hint: `${list.filter((x) => Number(x.miles) > 0).length} mileage entries` }
      ];
    },
    charts: (list, ctx) => {
      const p = periodSeries(list, ctx.range, { date: (x) => x.expense_date, series: [{ name: 'Spent', value: (x) => x.amount, color: SERIES_COLORS[1] }] });
      return [
        { type: 'hbar', title: 'By category', format: money, color: SERIES_COLORS[1], max: 15,
          rows: rankBy(list, { key: (x) => x.category, label: (k) => descriptor(EXPENSE_CATEGORIES, k).label, value: (x) => x.amount }) },
        { type: 'bar', money: true, title: `Spent by ${p.granularity}`, format: money, categories: p.categories, series: p.series }
      ];
    },
    columns: [
      { header: 'Category', value: (r) => r.category, badge: EXPENSE_CATEGORIES, csv: (r) => descriptor(EXPENSE_CATEGORIES, r.category).label },
      { header: 'Entries', value: (r) => String(r.count), total: (rows) => String(sumOf(rows, (r) => r.count)) },
      { header: 'Amount', value: (r) => money(r.amount), csv: (r) => String(Math.round(r.amount * 100) / 100), className: 'num', total: (rows) => money(sumOf(rows, (r) => r.amount)) },
      { header: 'Share', value: (r) => `${Math.round(r.share * 100)}%`, total: (rows) => (rows.length ? '100%' : '') }
    ],
    onRowClick: (r) => { location.href = `financials.html?view=expenses&bucket=${encodeURIComponent(r.category)}`; },
    load: () => Promise.resolve(expenses),
    emptyText: 'No expenses in this range.'
  });
}

init();
