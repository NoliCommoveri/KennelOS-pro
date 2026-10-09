// pl-report.js — "Profit & Loss by Month" (Reports plan, phase 1). One row per
// month: money in (earned income, filed under the date it moved), money out
// (expenses by expense_date), net, and anticipated income falling due that month.
// Built from data/moneyReport.js over the same scoped sources as the Financials
// Overview, so the two always agree. The date range filters whole months.
import { loadMoney, incomeEntries, plByPeriod, moneyBreakdown } from '../data/moneyReport.js';
import { createReportView } from '../assets/reportView.js';
import { fmtMoney } from '../assets/ui.js';
import { periodsBetween, periodLabel, sumOf, inRange } from '../data/reportMath.js';
import { todayYMD } from '../data/dateUtils.js';
import { INCOME_COMPONENTS, EXPENSE_CATEGORIES, descriptor } from '../data/vocab.js';

const money = (v) => fmtMoney(Math.round((Number(v) || 0) * 100) / 100);

async function init() {
  const { incomeRows, expenses } = await loadMoney();
  const entries = incomeEntries(incomeRows);
  const dates = [...entries.map((e) => e.date), ...expenses.map((x) => x.expense_date)].filter(Boolean).sort();
  const today = todayYMD();
  const first = dates[0] || today;
  const last = dates[dates.length - 1] > today ? dates[dates.length - 1] : today;
  // Newest month first in the table, like every other ledger.
  const months = plByPeriod(entries, expenses, periodsBetween(first, last, 'month'), 'month').reverse();

  // Whole months: a month is in the range when any day of it is.
  const monthStart = (m) => `${m.period}-01`;

  createReportView({
    mount: document.getElementById('report-mount'),
    // Scope is applied at load (moneyReport.loadMoney), so every month already
    // holds only the active kennel's money.
    csvFilename: `profit-loss-${today}.csv`,
    dateRange: { label: 'Months', date: (m) => monthStart(m), initial: 'this_year' },
    kpis: (rows) => {
      const inc = sumOf(rows, (m) => m.income);
      const out = sumOf(rows, (m) => m.expenses);
      return [
        { label: 'Money in', value: money(inc) },
        { label: 'Money out', value: money(out) },
        { label: 'Net', value: money(inc - out), hint: inc ? `${Math.round(((inc - out) / inc) * 100)}% of money in` : '' },
        { label: 'Anticipated', value: money(sumOf(rows, (m) => m.anticipated)), hint: 'falling due in these months' }
      ];
    },
    charts: (rows, ctx) => {
      const asc = [...rows].reverse();
      const cats = asc.map((m) => ({ key: m.period, label: periodLabel(m.period), short: periodLabel(m.period, { short: true }) + (m.period.endsWith('-01') ? ` ’${m.period.slice(2, 4)}` : '') }));
      let run = 0;
      const running = asc.map((m) => { run += m.net; return { x: m.period, y: Math.round(run * 100) / 100 }; });
      const within = (ymd) => inRange(ymd, ctx.range);
      const { income, spent } = moneyBreakdown(entries, expenses, within);
      return [
        { type: 'bar', money: true, title: 'Money in vs money out', format: money, categories: cats,
          series: [{ name: 'Money in', values: asc.map((m) => m.income) }, { name: 'Money out', values: asc.map((m) => m.expenses) }] },
        { type: 'line', money: true, title: 'Running net', subtitle: 'Net added up month by month across the range', format: money, categories: cats,
          series: [{ name: 'Running net', points: running }] },
        { type: 'hbar', title: 'Money in by source', format: money,
          rows: [...income].map(([k, v]) => ({ label: descriptor(INCOME_COMPONENTS, k).label, value: v })) },
        { type: 'hbar', title: 'Money out by category', format: money, color: '#eb6834',
          rows: [...spent].map(([k, v]) => ({ label: descriptor(EXPENSE_CATEGORIES, k).label, value: v })) }
      ];
    },
    columns: [
      { header: 'Month', value: (m) => periodLabel(m.period), csv: (m) => m.period },
      { header: 'Money in', value: (m) => (m.income ? money(m.income) : ''), csv: (m) => String(m.income), className: 'num', total: (rows) => money(sumOf(rows, (m) => m.income)) },
      { header: 'Money out', value: (m) => (m.expenses ? money(m.expenses) : ''), csv: (m) => String(m.expenses), className: 'num', total: (rows) => money(sumOf(rows, (m) => m.expenses)) },
      { header: 'Net', value: (m) => money(m.net), csv: (m) => String(m.net), className: 'num', total: (rows) => money(sumOf(rows, (m) => m.net)) },
      { header: 'Anticipated', value: (m) => (m.anticipated ? money(m.anticipated) : ''), csv: (m) => String(m.anticipated), className: 'num', total: (rows) => money(sumOf(rows, (m) => m.anticipated)) }
    ],
    load: () => Promise.resolve(months),
    emptyText: 'No money in or out in this range.'
  });
}

init();
