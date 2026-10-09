// placements-report.js — "Placements" analytics (Stage 5, Build Brief §5): Sales
// by status / registration_type / period. Derived read over Sale; buyer resolves to
// a Contact (there is no Buyer table). Reuses the reporting framework; no new
// schema, no stored aggregate.
import { saleRepo } from '../data/saleRepo.js';
import { dogRepo } from '../data/dogRepo.js';
import { contactRepo } from '../data/contactRepo.js';
import { createReportView } from '../assets/reportView.js';
import { inScope } from '../data/kennelScope.js';
import { fmtDate, fmtMoney } from '../assets/ui.js';
import { REGISTRATION_TYPE, SALE_STATUS, RELEASED_SALE_STATUSES, descriptor } from '../data/vocab.js';
import { periodSeries, sumOf } from '../data/reportMath.js';
import { SERIES_COLORS } from '../assets/chartView.js';

// A sale that went home (or is on its way): not released (voided, cancelled, returned).
const placed = (s) => !RELEASED_SALE_STATUSES.includes(s.status);
const priced = (s) => s.price !== '' && s.price != null && Number.isFinite(Number(s.price));
// Each registration keeps one color in every chart (its vocab slot), whatever is filtered.
const regColor = (v) => SERIES_COLORS[REGISTRATION_TYPE.findIndex((r) => r.value === v)];

async function init() {
  const [sales, dogs, contacts] = await Promise.all([
    saleRepo.getAll({ includeArchived: false }),
    dogRepo.getAll({ includeArchived: true }),
    contactRepo.getAll({ includeArchived: true })
  ]);
  const dogsById = new Map(dogs.map((d) => [d.id, d]));
  const contactsById = new Map(contacts.map((c) => [c.id, c]));
  const dogName = (s) => dogsById.get(s.dog_id)?.call_name || '—';
  const buyerName = (s) => contactsById.get(s.buyer_contact_id)?.name || '—';

  sales.sort((a, b) => (b.sale_date || '').localeCompare(a.sale_date || ''));

  createReportView({
    mount: document.getElementById('report-mount'),
    // Active-kennel scope (Multi-Kennel Scope Spec §7) — a sale carries the kennel
    // it was placed FROM, inherited from the dog at creation, so a dog moved or
    // sold on afterwards never re-files the historic sale.
    scope: inScope,
    csvFilename: `placements-${new Date().toISOString().slice(0, 10)}.csv`,
    search: { placeholder: 'Search dog or buyer…', text: (s) => `${dogName(s)} ${buyerName(s)}` },
    filters: [
      { id: 'registration_type', label: 'Registration', options: REGISTRATION_TYPE, match: (s, v) => s.registration_type === v },
      { id: 'status', label: 'Status', options: SALE_STATUS, match: (s, v) => s.status === v }
    ],
    dateRange: { label: 'Sold', date: (s) => s.sale_date },
    kpis: (rows) => {
      const live = rows.filter(placed);
      const withPrice = live.filter(priced);
      const full = live.filter((s) => s.registration_type === 'full').length;
      return [
        { label: 'Placements', value: String(live.length), hint: rows.length > live.length ? `${rows.length - live.length} fell through` : '' },
        { label: 'Sale value', value: fmtMoney(sumOf(withPrice, (s) => s.price)) || '$0.00', hint: 'prices, placed sales' },
        { label: 'Average price', value: withPrice.length ? fmtMoney(sumOf(withPrice, (s) => s.price) / withPrice.length) : '—' },
        { label: 'Full registration', value: live.length ? `${full} of ${live.length}` : '—' }
      ];
    },
    charts: (rows, ctx) => {
      const live = rows.filter(placed).filter((s) => s.sale_date);
      const regs = REGISTRATION_TYPE.filter((r) => live.some((s) => s.registration_type === r.value));
      const p = periodSeries(live, ctx.range, {
        date: (s) => s.sale_date,
        series: regs.map((r) => ({ name: r.label, color: regColor(r.value), when: (s) => s.registration_type === r.value }))
      });
      const avg = REGISTRATION_TYPE.map((r) => {
        const xs = rows.filter(placed).filter(priced).filter((s) => s.registration_type === r.value);
        return { label: r.label, value: xs.length ? sumOf(xs, (s) => s.price) / xs.length : 0, note: `${xs.length} sale${xs.length === 1 ? '' : 's'}` };
      });
      return [
        { type: 'bar', stacked: true, title: `Placements by ${p.granularity}`, subtitle: 'By registration; sales that fell through are left out', categories: p.categories, series: p.series },
        { type: 'hbar', title: 'Average price by registration', subtitle: 'Placed sales with a price', rows: avg, format: (v) => fmtMoney(Math.round(v)) }
      ];
    },
    columns: [
      { header: 'Sale date', value: (s) => (s.sale_date ? fmtDate(s.sale_date) : ''), csv: (s) => s.sale_date || '' },
      { header: 'Dog', value: dogName },
      { header: 'Buyer', value: buyerName },
      { header: 'Price', value: (s) => (priced(s) ? fmtMoney(s.price) : ''), csv: (s) => (priced(s) ? String(s.price) : ''), className: 'num', total: (rows) => fmtMoney(sumOf(rows.filter(placed).filter(priced), (s) => s.price)) },
      { header: 'Registration', value: (s) => s.registration_type || '', badge: REGISTRATION_TYPE, csv: (s) => s.registration_type ? descriptor(REGISTRATION_TYPE, s.registration_type).label : '' },
      { header: 'Status', value: (s) => s.status || '', badge: SALE_STATUS, csv: (s) => s.status ? descriptor(SALE_STATUS, s.status).label : '' }
    ],
    onRowClick: (s) => { location.href = `sale.html?id=${encodeURIComponent(s.id)}`; },
    load: () => Promise.resolve(sales),
    emptyText: 'No sales recorded yet.'
  });
}

init();
