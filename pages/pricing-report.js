// pricing-report.js — "Pricing" (Reports plan, phase 3). One row per placed sale with
// a price: what the pup sold for against what the litter's defaults would have set
// for that sex and registration (saleDefaults.expectedPricing — the same rule that
// prefills a new sale, Full surcharge included). Averages by registration and sex
// show whether the Full surcharge is actually being paid.
import { saleRepo } from '../data/saleRepo.js';
import { dogRepo } from '../data/dogRepo.js';
import { litterRepo } from '../data/litterRepo.js';
import { expectedPricing } from '../data/saleDefaults.js';
import { pricingRows, averageBy } from '../data/moneyReport.js';
import { createReportView } from '../assets/reportView.js';
import { inScope } from '../data/kennelScope.js';
import { fmtDate, fmtMoney } from '../assets/ui.js';
import { REGISTRATION_TYPE, RELEASED_SALE_STATUSES, SEX, descriptor } from '../data/vocab.js';
import { periodSeries, sumOf } from '../data/reportMath.js';

const money = (v) => fmtMoney(Math.round(Number(v) || 0));
const sexLabel = (v) => ({ male: 'Male', female: 'Female' }[v] || 'Sex unknown');
const regLabel = (v) => (v ? descriptor(REGISTRATION_TYPE, v).label : 'No registration');

async function init() {
  const [sales, dogs, litters] = await Promise.all([
    saleRepo.getAll({ includeArchived: false }),
    dogRepo.getAll({ includeArchived: true }),
    litterRepo.getAll({ includeArchived: true })
  ]);
  const dogsById = new Map(dogs.map((d) => [d.id, d]));
  const littersById = new Map(litters.map((l) => [l.id, l]));
  const rows = pricingRows(sales, {
    dogsById,
    isPlaced: (s) => !RELEASED_SALE_STATUSES.includes(s.status),
    expectedFor: (s) => {
      const dog = dogsById.get(s.dog_id);
      const litter = dog && dog.litter_id ? littersById.get(dog.litter_id) : null;
      return expectedPricing(dog, litter, s.registration_type).price;
    }
  });
  const breeds = [...new Set(rows.map((r) => r.dog?.breed).filter(Boolean))].sort();
  const avg = (list) => (list.length ? sumOf(list, (r) => r.price) / list.length : null);

  createReportView({
    mount: document.getElementById('report-mount'),
    scope: (r) => inScope(r.sale),
    csvFilename: `pricing-${new Date().toISOString().slice(0, 10)}.csv`,
    search: { placeholder: 'Search pup…', text: (r) => r.dog?.call_name || '' },
    dateRange: { label: 'Sold', date: (r) => r.sale.sale_date },
    filters: [
      { id: 'reg', label: 'Registration', options: REGISTRATION_TYPE, match: (r, v) => r.sale.registration_type === v },
      { id: 'sex', label: 'Sex', options: SEX.filter((s) => s.value !== 'unknown'), match: (r, v) => r.dog?.sex === v },
      ...(breeds.length > 1 ? [{ id: 'breed', label: 'Breed', options: breeds.map((b) => ({ value: b, label: b })), match: (r, v) => r.dog?.breed === v }] : [])
    ],
    kpis: (list) => {
      const vs = list.filter((r) => r.diff != null);
      const full = avg(list.filter((r) => r.sale.registration_type === 'full'));
      const limited = avg(list.filter((r) => r.sale.registration_type === 'limited'));
      return [
        { label: 'Sales', value: String(list.length) },
        { label: 'Average price', value: list.length ? money(avg(list)) : '—' },
        { label: 'Vs the litter’s price', value: vs.length ? `${sumOf(vs, (r) => r.diff) / vs.length >= 0 ? '+' : ''}${money(sumOf(vs, (r) => r.diff) / vs.length)}` : '—', hint: vs.length ? `average over ${vs.length} with a litter price` : 'no litter prices set' },
        { label: 'Full over Limited', value: full != null && limited != null ? money(full - limited) : '—', hint: 'average price difference' }
      ];
    },
    charts: (list, ctx) => {
      const groups = averageBy(list, (r) => `${sexLabel(r.dog?.sex)} · ${regLabel(r.sale.registration_type)}`, (r) => r.price);
      const p = periodSeries(list, ctx.range, { date: (r) => r.sale.sale_date, series: [{ name: 'Sale value', value: (r) => r.price }] });
      return [
        { type: 'hbar', title: 'Average price by sex and registration', format: money,
          rows: groups.map((g) => ({ label: g.key, value: g.avg, note: `${g.count} sale${g.count === 1 ? '' : 's'}` })) },
        { type: 'bar', money: true, title: `Sale value by ${p.granularity}`, format: money, categories: p.categories, series: p.series }
      ];
    },
    columns: [
      { header: 'Sold', value: (r) => (r.sale.sale_date ? fmtDate(r.sale.sale_date) : ''), csv: (r) => r.sale.sale_date || '' },
      { header: 'Pup', value: (r) => r.dog?.call_name || '—' },
      { header: 'Sex', value: (r) => r.dog?.sex || '', badge: SEX },
      { header: 'Registration', value: (r) => r.sale.registration_type || '', badge: REGISTRATION_TYPE, csv: (r) => regLabel(r.sale.registration_type) },
      { header: 'Price', value: (r) => money(r.price), csv: (r) => String(r.price), className: 'num', total: (list) => money(sumOf(list, (r) => r.price)) },
      { header: 'Litter price', value: (r) => (r.expected == null ? '' : money(r.expected)), csv: (r) => (r.expected == null ? '' : String(r.expected)), className: 'num' },
      { header: 'Difference', value: (r) => (r.diff == null ? '' : r.diff === 0 ? 'Same' : `${r.diff > 0 ? '+' : ''}${money(r.diff)}`), csv: (r) => (r.diff == null ? '' : String(r.diff)), className: 'num',
        tone: (r) => (r.diff != null && r.diff < 0 ? 'badge-amber' : null) }
    ],
    onRowClick: (r) => { location.href = `sale.html?id=${encodeURIComponent(r.sale.id)}`; },
    load: () => Promise.resolve(rows),
    emptyText: 'No priced sales in this range.'
  });
}

init();
