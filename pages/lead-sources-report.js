// lead-sources-report.js — "Lead Sources & Referrers" (Reports plan, phase 3). A
// summary report over placed sales (released ones left out): one row per lead
// source (Sale.lead_source, free text — grouped case-insensitively, trimmed) with
// sales, sale value and share, and a chart of the contacts who referred buyers
// (Sale.referred_by_contact_id).
import { saleRepo } from '../data/saleRepo.js';
import { contactRepo } from '../data/contactRepo.js';
import { createReportView } from '../assets/reportView.js';
import { inScope } from '../data/kennelScope.js';
import { fmtMoney } from '../assets/ui.js';
import { RELEASED_SALE_STATUSES } from '../data/vocab.js';
import { sumOf, rankBy } from '../data/reportMath.js';
import { SERIES_COLORS } from '../assets/chartView.js';

const money = (v) => fmtMoney(Math.round(Number(v) || 0));
const price = (s) => (Number.isFinite(Number(s.price)) && s.price !== '' && s.price != null ? Number(s.price) : 0);
const sourceKey = (s) => String(s.lead_source || '').trim().toLowerCase();

async function init() {
  const [sales, contacts] = await Promise.all([saleRepo.getAll({ includeArchived: false }), contactRepo.getAll({ includeArchived: true })]);
  const contactName = new Map(contacts.map((c) => [c.id, c.name || '—']));
  const placed = sales.filter((s) => !RELEASED_SALE_STATUSES.includes(s.status));
  // The spelling shown for a source: the most common one used.
  const display = new Map();
  for (const s of placed) {
    const k = sourceKey(s);
    if (!k) continue;
    const m = display.get(k) || new Map();
    m.set(s.lead_source.trim(), (m.get(s.lead_source.trim()) || 0) + 1);
    display.set(k, m);
  }
  const label = (k) => (k ? [...display.get(k).entries()].sort((a, b) => b[1] - a[1])[0][0] : 'Not recorded');

  createReportView({
    mount: document.getElementById('report-mount'),
    scope: inScope,
    csvFilename: `lead-sources-${new Date().toISOString().slice(0, 10)}.csv`,
    dateRange: { label: 'Sold', date: (s) => s.sale_date },
    rowsFor: (list) => {
      const total = sumOf(list, price);
      return [...new Set(list.map(sourceKey))].map((k) => {
        const xs = list.filter((s) => sourceKey(s) === k);
        return { key: k, label: label(k), sales: xs.length, value: sumOf(xs, price), share: total ? sumOf(xs, price) / total : 0 };
      }).sort((a, b) => b.sales - a.sales || b.value - a.value);
    },
    kpis: (list) => {
      const top = rankBy(list.filter(sourceKey), { key: sourceKey })[0];
      const referred = list.filter((s) => s.referred_by_contact_id);
      return [
        { label: 'Sales', value: String(list.length) },
        { label: 'Top source', value: top ? label(top.key) : '—', hint: top ? `${top.value} sale${top.value === 1 ? '' : 's'}` : '' },
        { label: 'Referred', value: String(referred.length), hint: `${new Set(referred.map((s) => s.referred_by_contact_id)).size} referrers` },
        { label: 'Source not recorded', value: String(list.filter((s) => !sourceKey(s)).length) }
      ];
    },
    charts: (list) => [
      { type: 'hbar', title: 'Sales by lead source', rows: rankBy(list, { key: sourceKey, label }) },
      { type: 'hbar', title: 'Top referrers', subtitle: 'Buyers each contact referred', color: SERIES_COLORS[2],
        rows: rankBy(list, { key: (s) => s.referred_by_contact_id, label: (id) => contactName.get(id) || '—' }), emptyText: 'No referrals recorded in this range.' }
    ],
    columns: [
      { header: 'Lead source', value: (r) => r.label },
      { header: 'Sales', value: (r) => String(r.sales), total: (rows) => String(sumOf(rows, (r) => r.sales)) },
      { header: 'Sale value', value: (r) => money(r.value), csv: (r) => String(r.value), className: 'num', total: (rows) => money(sumOf(rows, (r) => r.value)) },
      { header: 'Share of value', value: (r) => `${Math.round(r.share * 100)}%` }
    ],
    load: () => Promise.resolve(placed),
    emptyText: 'No placed sales in this range.'
  });
}

init();
