// pairings.js — Pairing List screen. Shared listView with pairing-specific
// filters (status, type, sire, dam), columns, and row navigation.
import { pairingRepo } from '../data/pairingRepo.js';
import { dogRepo } from '../data/dogRepo.js';
import { createListView } from '../assets/listView.js';
import { badge, fmtDate, esc } from '../assets/ui.js';
import { PAIRING_STATUS, PAIRING_TYPE } from '../data/vocab.js';

const mount = document.getElementById('pairing-list');

async function init() {
  // Resolve sire/dam ids to names for display and search (include archived so a
  // pairing referencing a retired/archived dog still shows a name).
  const dogs = await dogRepo.getAll({ includeArchived: true });
  const dogsById = new Map(dogs.map((d) => [d.id, d]));
  const dogName = (id) => {
    const d = dogsById.get(id);
    return d ? d.call_name : '';
  };

  // Sire/dam filter options are the dogs actually used across pairings (keeps the
  // dropdowns short and relevant).
  const pairings = await pairingRepo.getAll({ includeArchived: true });
  const sireIds = [...new Set(pairings.map((p) => p.sire_id).filter(Boolean))];
  const damIds = [...new Set(pairings.map((p) => p.dam_id).filter(Boolean))];
  const nameOptions = (ids) => ids
    .map((id) => ({ value: id, label: dogName(id) || '(unknown)' }))
    .sort((a, b) => a.label.localeCompare(b.label));

  createListView({
    mount,
    search: {
      placeholder: 'Search by sire or dam name…',
      text: (p) => `${dogName(p.sire_id)} ${dogName(p.dam_id)}`
    },
    filters: [
      { id: 'status', label: 'Status', options: PAIRING_STATUS, match: (p, v) => p.status === v },
      { id: 'type', label: 'Type', options: PAIRING_TYPE, match: (p, v) => p.pairing_type === v },
      { id: 'sire', label: 'Sire', options: nameOptions(sireIds), match: (p, v) => p.sire_id === v },
      { id: 'dam', label: 'Dam', options: nameOptions(damIds), match: (p, v) => p.dam_id === v }
    ],
    columns: [
      { header: 'Sire', cell: (p) => `<strong>${esc(dogName(p.sire_id) || '—')}</strong>` },
      { header: 'Dam', cell: (p) => `<strong>${esc(dogName(p.dam_id) || '—')}</strong>` },
      { header: 'Type', cell: (p) => badge(PAIRING_TYPE, p.pairing_type) },
      { header: 'Planned', cell: (p) => p.planned_date ? esc(fmtDate(p.planned_date)) : '<span class="faint">—</span>' },
      { header: 'Due', cell: (p) => p.expected_due_date ? esc(fmtDate(p.expected_due_date)) : '<span class="faint">—</span>' },
      { header: 'Status', cell: (p) => badge(PAIRING_STATUS, p.status) }
    ],
    onRowClick: (p) => { location.href = `pairing.html?id=${encodeURIComponent(p.id)}`; },
    load: (o) => pairingRepo.getAll(o),
    emptyText: 'No pairings yet. Click “+ Add Pairing” to record the first breeding.'
  });
}

init();
