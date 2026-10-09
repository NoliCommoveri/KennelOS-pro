// dog-return-report.js — "Breeding-Dog Return" (Reports plan, phase 3). Per dam and
// sire: what their litters' puppies brought in, stud fees the dog earned, their own
// lifetime costs, and the net. Income and expenses come from moneyReport.loadMoney
// (scoped like Financials); litters are scoped by their own kennel. A litter's
// income counts for BOTH parents — each row is that dog's view, so the rows don't
// add up to the program's total (the page says so; there is no Total row for that).
import { loadMoney, dogReturnRows } from '../data/moneyReport.js';
import { dogRepo } from '../data/dogRepo.js';
import { litterRepo } from '../data/litterRepo.js';
import { saleRepo } from '../data/saleRepo.js';
import { createReportView } from '../assets/reportView.js';
import { inScopeOnly } from '../data/kennelScope.js';
import { fmtMoney } from '../assets/ui.js';
import { DOG_STATUS, RELEASED_SALE_STATUSES, descriptor } from '../data/vocab.js';

const money = (v) => fmtMoney(Math.round((Number(v) || 0) * 100) / 100);
const ROLES = [{ value: 'dam', label: 'Dams' }, { value: 'sire', label: 'Sires' }];

async function init() {
  const [{ incomeRows, expenses }, dogs, litters, sales] = await Promise.all([
    loadMoney(),
    dogRepo.getAll({ includeArchived: true }),
    litterRepo.getAll({ includeArchived: false }),
    saleRepo.getAll({ includeArchived: false })
  ]);
  const rows = dogReturnRows({
    dogs, litters: inScopeOnly(litters), incomeRows, expenses, sales,
    isPlaced: (s) => !RELEASED_SALE_STATUSES.includes(s.status)
  });

  createReportView({
    mount: document.getElementById('report-mount'),
    csvFilename: `breeding-dog-return-${new Date().toISOString().slice(0, 10)}.csv`,
    search: { placeholder: 'Search dog…', text: (r) => r.dog.call_name || '' },
    filters: [
      { id: 'role', label: 'Dams & sires', options: ROLES, match: (r, v) => r.role === v },
      { id: 'status', label: 'Status', options: DOG_STATUS, match: (r, v) => r.dog.status === v }
    ],
    kpis: (list) => {
      const best = list[0];
      return [
        { label: 'Dogs', value: String(list.length) },
        { label: 'Best net', value: best ? best.dog.call_name || '—' : '—', hint: best ? money(best.net) : '' },
        { label: 'In the red', value: String(list.filter((r) => r.net < 0).length), hint: 'costs over income so far' },
        { label: 'Still to come', value: money(list.reduce((t, r) => t + r.anticipated, 0)), hint: 'anticipated, all rows (litters shared by two parents count twice)' }
      ];
    },
    charts: (list) => [{
      type: 'bar', diverging: true, money: true, title: 'Net by dog', subtitle: 'Earned from their pups + stud fees − their own costs',
      format: money, categories: list.map((r) => ({ key: r.dog.id, label: r.dog.call_name || '—' })),
      series: [{ name: 'Net', values: list.map((r) => r.net) }]
    }],
    columns: [
      { header: 'Dog', value: (r) => r.dog.call_name || '' },
      { header: 'Role', value: (r) => (r.role === 'dam' ? 'Dam' : 'Sire') },
      { header: 'Status', value: (r) => r.dog.status || '', badge: DOG_STATUS, csv: (r) => (r.dog.status ? descriptor(DOG_STATUS, r.dog.status).label : '') },
      { header: 'Litters', value: (r) => String(r.litters) },
      { header: 'Pups sold', value: (r) => String(r.pupsSold) },
      { header: 'From pups', value: (r) => money(r.earned), csv: (r) => String(r.earned), className: 'num' },
      { header: 'Stud fees', value: (r) => (r.studFees ? money(r.studFees) : ''), csv: (r) => String(r.studFees), className: 'num' },
      { header: 'Own costs', value: (r) => money(r.costs), csv: (r) => String(r.costs), className: 'num' },
      { header: 'Net', value: (r) => money(r.net), csv: (r) => String(r.net), className: 'num', tone: (r) => (r.net < 0 ? 'badge-red' : null) },
      { header: 'Still to come', value: (r) => (r.anticipated ? money(r.anticipated) : ''), csv: (r) => String(r.anticipated), className: 'num' }
    ],
    onRowClick: (r) => { location.href = `dog.html?id=${encodeURIComponent(r.dog.id)}`; },
    load: () => Promise.resolve(rows),
    emptyText: 'No dams or sires with litters or stud income yet.'
  });
}

init();
