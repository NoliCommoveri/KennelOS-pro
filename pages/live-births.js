// live-births.js — "Live-birth summary" analytics (Stage 5, Build Brief §5).
// Derived from Litter birth fields as a PER-LITTER table (§5: "not a stored
// rate"). The live % column is computed per row from that litter's own
// alive/total — never a kennel-wide average persisted anywhere. Only litters
// that recorded a birth total appear (an expected, not-yet-whelped litter has
// nothing to summarize yet).
import { litterRepo } from '../data/litterRepo.js';
import { dogRepo } from '../data/dogRepo.js';
import { createReportView } from '../assets/reportView.js';
import { inScope } from '../data/kennelScope.js';
import { fmtDate } from '../assets/ui.js';
import { periodSeries, sumOf, pct } from '../data/reportMath.js';

function livePct(l) {
  const total = Number(l.puppies_born_total);
  const alive = Number(l.puppies_born_alive);
  if (!Number.isFinite(total) || total <= 0 || !Number.isFinite(alive)) return '';
  return `${Math.round((alive / total) * 100)}%`;
}

async function init() {
  const [allLitters, dogs] = await Promise.all([
    litterRepo.getAll({ includeArchived: false }),
    dogRepo.getAll({ includeArchived: true })
  ]);
  const dogsById = new Map(dogs.map((d) => [d.id, d]));
  const name = (id) => dogsById.get(id)?.call_name || '—';
  // Only litters with a recorded birth total have a live-birth story to tell.
  const litters = allLitters.filter((l) => Number.isFinite(Number(l.puppies_born_total)));
  litters.sort((a, b) => (b.whelp_date || '').localeCompare(a.whelp_date || ''));

  createReportView({
    mount: document.getElementById('report-mount'),
    // Active-kennel scope (Multi-Kennel Scope Spec §7) — one row per litter, and a
    // litter carries its own kennel. Live % is per-row, so scoping never distorts
    // it: it is never a kennel-wide average that could mix two kennels together.
    scope: inScope,
    csvFilename: `live-births-${new Date().toISOString().slice(0, 10)}.csv`,
    search: { placeholder: 'Search dam or sire…', text: (l) => `${name(l.dam_id)} ${name(l.sire_id)}` },
    dateRange: { label: 'Whelped', date: (l) => l.whelp_date },
    // The tiles pool the VISIBLE litters' own counts on each render (born and
    // alive summed, then divided): a derived figure for what's on screen, never a
    // stored kennel-wide rate.
    kpis: (rows) => {
      const born = sumOf(rows, (l) => l.puppies_born_total);
      const alive = sumOf(rows, (l) => l.puppies_born_alive);
      return [
        { label: 'Litters', value: String(rows.length) },
        { label: 'Total born', value: String(born) },
        { label: 'Born alive', value: String(alive) },
        { label: 'Live births', value: pct(alive, born) || '—', hint: 'alive ÷ born, these litters' }
      ];
    },
    charts: (rows, ctx) => {
      const p = periodSeries(rows.filter((l) => l.whelp_date), ctx.range, {
        date: (l) => l.whelp_date,
        series: [
          { name: 'Born alive', value: (l) => l.puppies_born_alive },
          { name: 'Born deceased', value: (l) => l.puppies_born_deceased }
        ]
      });
      return [{ type: 'bar', stacked: true, title: `Puppies born by ${p.granularity}`, subtitle: 'Alive and deceased, stacked', categories: p.categories, series: p.series }];
    },
    columns: [
      { header: 'Whelp date', value: (l) => (l.whelp_date ? fmtDate(l.whelp_date) : ''), csv: (l) => l.whelp_date || '' },
      { header: 'Litter', value: (l) => `${name(l.dam_id)} × ${name(l.sire_id)}` },
      { header: 'Total born', value: (l) => String(l.puppies_born_total ?? ''), total: (rows) => String(sumOf(rows, (l) => l.puppies_born_total)) },
      { header: 'Born alive', value: (l) => String(l.puppies_born_alive ?? ''), total: (rows) => String(sumOf(rows, (l) => l.puppies_born_alive)) },
      { header: 'Born deceased', value: (l) => String(l.puppies_born_deceased ?? ''), total: (rows) => String(sumOf(rows, (l) => l.puppies_born_deceased)) },
      { header: 'Live %', value: livePct, total: (rows) => pct(sumOf(rows, (l) => l.puppies_born_alive), sumOf(rows, (l) => l.puppies_born_total)) || '' }
    ],
    onRowClick: (l) => { location.href = `litter.html?id=${encodeURIComponent(l.id)}`; },
    load: () => Promise.resolve(litters),
    emptyText: 'No litters with recorded birth counts yet.'
  });
}

init();
