// active-breeding.js — Active Pairings & Litters report (Stage 3 Brief §7,
// step 10). Two reportView instances over the same reusable component the
// Active Roster (Stage 2) proved out; "active" means non-archived, the same
// defining filter roster.js uses.
import { pairingRepo } from '../data/pairingRepo.js';
import { litterRepo } from '../data/litterRepo.js';
import { dogRepo } from '../data/dogRepo.js';
import { createReportView } from '../assets/reportView.js';
import { fmtDate } from '../assets/ui.js';
import { descriptor, PAIRING_TYPE, PAIRING_STATUS, LITTER_STATUS } from '../data/vocab.js';

async function init() {
  const dogs = await dogRepo.getAll({ includeArchived: true });
  const dogsById = new Map(dogs.map((d) => [d.id, d]));
  const dogName = (id) => dogsById.get(id)?.call_name || '';
  const label = (vocab, v) => (v ? descriptor(vocab, v).label : '');

  createReportView({
    mount: document.getElementById('pairings-mount'),
    csvFilename: `active-pairings-${new Date().toISOString().slice(0, 10)}.csv`,
    search: {
      placeholder: 'Search by sire or dam name…',
      text: (p) => `${dogName(p.sire_id)} ${dogName(p.dam_id)}`
    },
    filters: [
      { id: 'status', label: 'Status', options: PAIRING_STATUS, match: (p, v) => p.status === v },
      { id: 'type', label: 'Type', options: PAIRING_TYPE, match: (p, v) => p.pairing_type === v }
    ],
    columns: [
      { header: 'Sire', value: (p) => dogName(p.sire_id) },
      { header: 'Dam', value: (p) => dogName(p.dam_id) },
      { header: 'Type', value: (p) => p.pairing_type || '', badge: PAIRING_TYPE, csv: (p) => label(PAIRING_TYPE, p.pairing_type) },
      { header: 'Planned', value: (p) => (p.planned_date ? fmtDate(p.planned_date) : ''), csv: (p) => p.planned_date || '' },
      { header: 'Due', value: (p) => (p.expected_due_date ? fmtDate(p.expected_due_date) : ''), csv: (p) => p.expected_due_date || '' },
      { header: 'Status', value: (p) => p.status || '', badge: PAIRING_STATUS, csv: (p) => label(PAIRING_STATUS, p.status) }
    ],
    onRowClick: (p) => { location.href = `pairing.html?id=${encodeURIComponent(p.id)}`; },
    load: () => pairingRepo.getAll({ includeArchived: false }),
    emptyText: 'No active pairings match these filters.'
  });

  createReportView({
    mount: document.getElementById('litters-mount'),
    csvFilename: `active-litters-${new Date().toISOString().slice(0, 10)}.csv`,
    search: {
      placeholder: 'Search by dam or sire name…',
      text: (l) => `${dogName(l.dam_id)} ${dogName(l.sire_id)} ${l.litter_registration_number || ''}`
    },
    filters: [
      { id: 'status', label: 'Status', options: LITTER_STATUS, match: (l, v) => l.status === v }
    ],
    columns: [
      { header: 'Dam', value: (l) => dogName(l.dam_id) },
      { header: 'Sire', value: (l) => dogName(l.sire_id) },
      { header: 'Whelp date', value: (l) => (l.whelp_date ? fmtDate(l.whelp_date) : ''), csv: (l) => l.whelp_date || '' },
      { header: 'Born', value: (l) => (l.puppies_born_total != null && l.puppies_born_total !== '' ? String(l.puppies_born_total) : '') },
      { header: 'Status', value: (l) => l.status || '', badge: LITTER_STATUS, csv: (l) => label(LITTER_STATUS, l.status) }
    ],
    onRowClick: (l) => { location.href = `litter.html?id=${encodeURIComponent(l.id)}`; },
    load: () => litterRepo.getAll({ includeArchived: false }),
    emptyText: 'No active litters match these filters.'
  });
}

init();
