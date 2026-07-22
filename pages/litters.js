// litters.js — Litter List screen. Shared listView with litter-specific filters
// (status, dam, sire) and columns. Whelp-date range filtering is offered as a
// simple "year" filter to stay within the shared dropdown-filter component.
import { litterRepo } from '../data/litterRepo.js';
import { dogRepo } from '../data/dogRepo.js';
import { createListView } from '../assets/listView.js';
import { badge, fmtDate, esc } from '../assets/ui.js';
import { LITTER_STATUS, FOSTER_DIRECTION } from '../data/vocab.js';

const mount = document.getElementById('litter-list');

async function init() {
  const dogs = await dogRepo.getAll({ includeArchived: true });
  const dogsById = new Map(dogs.map((d) => [d.id, d]));
  const dogName = (id) => {
    const d = dogsById.get(id);
    return d ? d.call_name : '';
  };
  // The litter's breed is the dam's breed (the program runs multiple breeds, so
  // it's worth showing at a glance). Sourced from the dam Dog record, not stored.
  const damBreed = (l) => dogsById.get(l.dam_id)?.breed || '';

  const litters = await litterRepo.getAll({ includeArchived: true });
  const damIds = [...new Set(litters.map((l) => l.dam_id).filter(Boolean))];
  const sireIds = [...new Set(litters.map((l) => l.sire_id).filter(Boolean))];
  const nameOptions = (ids) => ids
    .map((id) => ({ value: id, label: dogName(id) || '(unknown)' }))
    .sort((a, b) => a.label.localeCompare(b.label));
  const years = [...new Set(litters.map((l) => (l.whelp_date || '').slice(0, 4)).filter(Boolean))]
    .sort().reverse().map((y) => ({ value: y, label: y }));

  createListView({
    mount,
    search: {
      placeholder: 'Search by nickname, dam, or sire name…',
      text: (l) => `${l.nickname || ''} ${dogName(l.dam_id)} ${dogName(l.sire_id)} ${damBreed(l)} ${l.litter_registration_number || ''}`
    },
    filters: [
      { id: 'status', label: 'Status', options: LITTER_STATUS, match: (l, v) => l.status === v },
      { id: 'dam', label: 'Dam', options: nameOptions(damIds), match: (l, v) => l.dam_id === v },
      { id: 'sire', label: 'Sire', options: nameOptions(sireIds), match: (l, v) => l.sire_id === v },
      { id: 'foster', label: 'Foster', options: FOSTER_DIRECTION, match: (l, v) => l.foster_direction === v },
      { id: 'year', label: 'Whelp year', options: years, match: (l, v) => (l.whelp_date || '').slice(0, 4) === v }
    ],
    // Nickname, Dam, Sire, and Status stay visible at every width; Breed, Whelp
    // date, and Born collapse behind the row's "more details" toggle on phones so
    // the table never forces horizontal scroll (same pattern as the Dog List).
    columns: [
      { header: 'Nickname', cell: (l) => l.nickname ? esc(l.nickname) : '<span class="faint">—</span>' },
      { header: 'Dam', cell: (l) => `<strong>${esc(dogName(l.dam_id) || '—')}</strong>` },
      { header: 'Sire', cell: (l) => `<strong>${esc(dogName(l.sire_id) || '—')}</strong>` },
      { header: 'Breed', collapse: true, cell: (l) => { const b = damBreed(l); return b ? esc(b) : '<span class="faint">—</span>'; } },
      { header: 'Whelp date', collapse: true, cell: (l) => l.whelp_date ? esc(fmtDate(l.whelp_date)) : '<span class="faint">—</span>' },
      { header: 'Born', collapse: true, cell: (l) => l.puppies_born_total != null && l.puppies_born_total !== '' ? esc(String(l.puppies_born_total)) : '<span class="faint">—</span>' },
      { header: 'Status', cell: (l) => badge(LITTER_STATUS, l.status) + (l.foster_direction ? ' ' + badge(FOSTER_DIRECTION, l.foster_direction) : '') }
    ],
    onRowClick: (l) => { location.href = `litter.html?id=${encodeURIComponent(l.id)}`; },
    load: (o) => litterRepo.getAll(o),
    emptyText: 'No litters yet. Click “+ Add Litter” to record the first one.'
  });
}

init();
