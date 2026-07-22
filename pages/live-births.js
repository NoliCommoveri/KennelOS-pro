// live-births.js — "Live-birth summary" analytics (Stage 5, Build Brief §5).
// Derived from Litter birth fields as a PER-LITTER table (§5: "not a stored
// rate"). The live % column is computed per row from that litter's own
// alive/total — never a kennel-wide average persisted anywhere. Only litters
// that recorded a birth total appear (an expected, not-yet-whelped litter has
// nothing to summarize yet).
import { litterRepo } from '../data/litterRepo.js';
import { dogRepo } from '../data/dogRepo.js';
import { createReportView } from '../assets/reportView.js';
import { fmtDate } from '../assets/ui.js';

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
    csvFilename: `live-births-${new Date().toISOString().slice(0, 10)}.csv`,
    search: { placeholder: 'Search dam or sire…', text: (l) => `${name(l.dam_id)} ${name(l.sire_id)}` },
    columns: [
      { header: 'Whelp date', value: (l) => (l.whelp_date ? fmtDate(l.whelp_date) : ''), csv: (l) => l.whelp_date || '' },
      { header: 'Litter', value: (l) => `${name(l.dam_id)} × ${name(l.sire_id)}` },
      { header: 'Total born', value: (l) => String(l.puppies_born_total ?? '') },
      { header: 'Born alive', value: (l) => String(l.puppies_born_alive ?? '') },
      { header: 'Born deceased', value: (l) => String(l.puppies_born_deceased ?? '') },
      { header: 'Live %', value: livePct }
    ],
    onRowClick: (l) => { location.href = `litter.html?id=${encodeURIComponent(l.id)}`; },
    load: () => Promise.resolve(litters),
    emptyText: 'No litters with recorded birth counts yet.'
  });
}

init();
