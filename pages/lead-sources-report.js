// lead-sources-report.js — "Lead Sources & Referrers" (Reports plan, phase 3). A
// summary report over placed sales (released ones left out): one row per lead
// source (Sale.lead_source, free text — grouped case-insensitively, trimmed) with
// sales, sale value and share, and a chart of the contacts who referred buyers
// (Sale.referred_by_contact_id).
import { loadLeadSources, leadSourceKey as sourceKey } from '../data/reportSources.js';
import { leadFigures } from '../data/reportFigures.js';
import { createReportView } from '../assets/reportView.js';
import { fmtMoney } from '../assets/ui.js';
import { sumOf, rankBy } from '../data/reportMath.js';
import { SERIES_COLORS } from '../assets/chartView.js';

const money = (v) => fmtMoney(Math.round(Number(v) || 0));
const price = (s) => (Number.isFinite(Number(s.price)) && s.price !== '' && s.price != null ? Number(s.price) : 0);

async function init() {
  const src = await loadLeadSources();
  const { label } = src;
  const contactName = new Map(src.contacts.map((c) => [c.id, c.name || '—']));

  createReportView({
    mount: document.getElementById('report-mount'),
    scope: src.scope,
    csvFilename: `lead-sources-${new Date().toISOString().slice(0, 10)}.csv`,
    dateRange: { label: 'Sold', date: src.date },
    rowsFor: (list) => {
      const total = sumOf(list, price);
      return [...new Set(list.map(sourceKey))].map((k) => {
        const xs = list.filter((s) => sourceKey(s) === k);
        return { key: k, label: label(k), sales: xs.length, value: sumOf(xs, price), share: total ? sumOf(xs, price) / total : 0 };
      }).sort((a, b) => b.sales - a.sales || b.value - a.value);
    },
    kpis: (list) => {
      const f = leadFigures(list, sourceKey);
      const { top } = f;
      return [
        { label: 'Sales', value: String(f.sales) },
        { label: 'Top source', value: top ? label(top.key) : '—', hint: top ? `${top.value} sale${top.value === 1 ? '' : 's'}` : '' },
        { label: 'Referred', value: String(f.referred), hint: `${f.referrers} referrers` },
        { label: 'Source not recorded', value: String(f.unrecorded) }
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
    load: () => Promise.resolve(src.rows),
    emptyText: 'No placed sales in this range.'
  });
}

init();
