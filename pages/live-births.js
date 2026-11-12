// live-births.js — "Live-birth summary" analytics (Stage 5, Build Brief §5).
// Derived from Litter birth fields as a PER-LITTER table (§5: "not a stored
// rate"). The live % column is computed per row from that litter's own
// alive/total — never a kennel-wide average persisted anywhere. Only litters
// that recorded a birth total appear (an expected, not-yet-whelped litter has
// nothing to summarize yet).
//
// Lite keeps this page, so it reads only shared modules: never reportSources.js
// or reportFigures.js, which are Pro-only (K13-7). Its loader is the same as
// reportSources.loadLiveBirths, which Kels's Pro insights use.
import { litterRepo } from '../data/litterRepo.js';
import { dogRepo } from '../data/dogRepo.js';
import { inScope } from '../data/kennelScope.js';
import { editionFlags } from '../data/editionConfig.js';
import { createReportView } from '../assets/reportView.js';
import { fmtDate } from '../assets/ui.js';
import { periodSeries, sumOf, pct, liveBirthFigures } from '../data/reportMath.js';

// The litters with a recorded birth total, newest first.
async function loadLiveBirths() {
  const [all, dogs] = await Promise.all([litterRepo.getAll({ includeArchived: false }), dogRepo.getAll({ includeArchived: true })]);
  const rows = all.filter((l) => Number.isFinite(Number(l.puppies_born_total)))
    .sort((a, b) => (b.whelp_date || '').localeCompare(a.whelp_date || ''));
  return { rows, scope: inScope, date: (l) => l.whelp_date, dogs };
}

function livePct(l) {
  const total = Number(l.puppies_born_total);
  const alive = Number(l.puppies_born_alive);
  if (!Number.isFinite(total) || total <= 0 || !Number.isFinite(alive)) return '';
  return `${Math.round((alive / total) * 100)}%`;
}

async function init() {
  // Lite has no Reports hub to go back to.
  if (!editionFlags.reports) document.getElementById('all-reports')?.remove();
  // Only litters with a recorded birth total have a live-birth story to tell.
  const src = await loadLiveBirths();
  const dogsById = new Map(src.dogs.map((d) => [d.id, d]));
  const name = (id) => dogsById.get(id)?.call_name || '—';

  createReportView({
    mount: document.getElementById('report-mount'),
    // Active-kennel scope (Multi-Kennel Scope Spec §7) — one row per litter, and a
    // litter carries its own kennel. Live % is per-row, so scoping never distorts
    // it: it is never a kennel-wide average that could mix two kennels together.
    scope: src.scope,
    csvFilename: `live-births-${new Date().toISOString().slice(0, 10)}.csv`,
    search: { placeholder: 'Search dam or sire…', text: (l) => `${name(l.dam_id)} ${name(l.sire_id)}` },
    dateRange: { label: 'Whelped', date: src.date },
    // The tiles pool the VISIBLE litters' own counts on each render (born and
    // alive summed, then divided): a derived figure for what's on screen, never a
    // stored kennel-wide rate.
    kpis: (rows) => {
      const f = liveBirthFigures(rows);
      return [
        { label: 'Litters', value: String(f.litters) },
        { label: 'Total born', value: String(f.born) },
        { label: 'Born alive', value: String(f.alive) },
        { label: 'Live births', value: pct(f.alive, f.born) || '—', hint: 'alive ÷ born, these litters' }
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
    load: () => Promise.resolve(src.rows),
    emptyText: 'No litters with recorded birth counts yet.'
  });
}

init();
