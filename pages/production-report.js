// production-report.js — "Dam & Sire Production" (Reports plan, phase 2). One row
// per dog that parented a whelped litter in the active kennel: litters, puppies,
// live %, average litter, sex split, ages, and the dam flags. The numbers come from
// data/breedingReports.js (pure); scope is the LITTER's kennel, so an outside stud
// shows for the litters he sired here.
import { dogRepo } from '../data/dogRepo.js';
import { litterRepo } from '../data/litterRepo.js';
import { productionRows, BACK_TO_BACK_DAYS, LIFETIME_LITTERS_FLAG } from '../data/breedingReports.js';
import { createReportView } from '../assets/reportView.js';
import { inScopeOnly } from '../data/kennelScope.js';
import { fmtDate } from '../assets/ui.js';
import { DOG_STATUS, descriptor } from '../data/vocab.js';
import { sumOf, pct, periodLabel } from '../data/reportMath.js';
import { SERIES_COLORS } from '../assets/chartView.js';

const ROLES = [{ value: 'dam', label: 'Dams' }, { value: 'sire', label: 'Sires' }];
const one = (v) => (v == null ? '' : (Math.round(v * 10) / 10).toFixed(1));
const ages = (r) => (r.firstAge == null ? '' : r.firstAge === r.lastAge ? `${r.firstAge} mo` : `${r.firstAge}–${r.lastAge} mo`);
function flags(r) {
  const out = [];
  if (r.backToBack) out.push(`Back-to-back ×${r.backToBack}`);
  if (r.lifetimeFlag) out.push(`${r.litters} lifetime litters`);
  return out.join(' · ');
}

// The visible rows' litters, each once (a dam's row and a sire's row share it), so
// the Total row never double-counts and still works with only sires shown.
const uniqueLitters = (list) => [...new Map(list.flatMap((r) => r.litterList).map((l) => [l.id, l])).values()];
const counts = (l) => l.puppies_born_total !== '' && l.puppies_born_total != null && Number.isFinite(Number(l.puppies_born_total));

async function init() {
  const [dogs, litters] = await Promise.all([
    dogRepo.getAll({ includeArchived: true }),
    litterRepo.getAll({ includeArchived: false })
  ]);
  const rows = productionRows({ dogs, litters: inScopeOnly(litters), puppies: dogs.filter((d) => d.litter_id) });

  createReportView({
    mount: document.getElementById('report-mount'),
    csvFilename: `production-${new Date().toISOString().slice(0, 10)}.csv`,
    search: { placeholder: 'Search dog…', text: (r) => `${r.dog.call_name || ''} ${r.dog.registered_name || ''}` },
    filters: [
      { id: 'role', label: 'Dams & sires', options: ROLES, match: (r, v) => r.role === v },
      { id: 'status', label: 'Status', options: DOG_STATUS, match: (r, v) => r.dog.status === v },
      { id: 'flag', label: 'Flags', options: [{ value: 'any', label: 'Flagged only' }], match: (r) => Boolean(flags(r)) }
    ],
    kpis: (list) => {
      const counted = uniqueLitters(list).filter(counts);
      const born = sumOf(counted, (l) => l.puppies_born_total);
      return [
        { label: 'Dams', value: String(list.filter((r) => r.role === 'dam').length) },
        { label: 'Sires', value: String(list.filter((r) => r.role === 'sire').length) },
        { label: 'Average litter', value: counted.length ? one(born / counted.length) : '—', hint: counted.length ? `${counted.length} litters with counts` : '' },
        { label: 'Flagged dams', value: String(list.filter((r) => flags(r)).length), hint: `litters < ${Math.round(BACK_TO_BACK_DAYS / 30)} mo apart, or ${LIFETIME_LITTERS_FLAG}+` }
      ];
    },
    charts: (list) => [
      { type: 'hbar', title: 'Average litter size', subtitle: 'Puppies born per litter', max: 12, format: one,
        rows: list.filter((r) => r.avgLitter != null).map((r) => ({ label: r.dog.call_name || '—', value: r.avgLitter, note: `${r.litters} litter${r.litters === 1 ? '' : 's'}` })) },
      { type: 'hbar', title: 'Born alive', subtitle: 'Share of puppies born alive', max: 12, color: SERIES_COLORS[2], format: (v) => `${Math.round(v)}%`, showZero: true,
        rows: list.filter((r) => r.livePct != null).map((r) => ({ label: r.dog.call_name || '—', value: r.livePct * 100, note: `${r.alive} of ${r.born}` })) }
    ],
    columns: [
      { header: 'Dog', value: (r) => r.dog.call_name || '' },
      { header: 'Role', value: (r) => (r.role === 'dam' ? 'Dam' : 'Sire') },
      { header: 'Status', value: (r) => r.dog.status || '', badge: DOG_STATUS, csv: (r) => (r.dog.status ? descriptor(DOG_STATUS, r.dog.status).label : '') },
      { header: 'Litters', value: (r) => String(r.litters), total: (list) => String(uniqueLitters(list).length) },
      { header: 'Born', value: (r) => String(r.born), total: (list) => String(sumOf(uniqueLitters(list).filter(counts), (l) => l.puppies_born_total)) },
      { header: 'Alive', value: (r) => String(r.alive), total: (list) => String(sumOf(uniqueLitters(list).filter(counts), (l) => l.puppies_born_alive)) },
      { header: 'Live %', value: (r) => (r.livePct == null ? '' : `${Math.round(r.livePct * 100)}%`),
        total: (list) => { const ls = uniqueLitters(list).filter(counts); return pct(sumOf(ls, (l) => l.puppies_born_alive), sumOf(ls, (l) => l.puppies_born_total)) || ''; } },
      { header: 'Avg litter', value: (r) => one(r.avgLitter) },
      { header: 'Males / females', value: (r) => (r.males || r.females ? `${r.males} / ${r.females}` : '') },
      { header: 'Whelps', className: 'num', value: (r) => (r.firstWhelp === r.lastWhelp ? fmtDate(r.firstWhelp) : `${periodLabel(r.firstWhelp.slice(0, 7))} – ${periodLabel(r.lastWhelp.slice(0, 7))}`), csv: (r) => `${r.firstWhelp} – ${r.lastWhelp}` },
      { header: 'Age at litters', value: ages, className: 'num' },
      { header: 'Flags', value: flags, tone: () => 'badge-amber', className: 'num' }
    ],
    onRowClick: (r) => { location.href = `dog.html?id=${encodeURIComponent(r.dog.id)}`; },
    load: () => Promise.resolve(rows),
    emptyText: 'No whelped litters recorded yet.'
  });
}

init();
