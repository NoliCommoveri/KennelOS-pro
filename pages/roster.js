// roster.js — the Active Roster report (Build Brief B2): all non-archived dogs,
// filterable and exportable. First real use of the reusable reportView, proving
// the reporting framework before later stages build their reports on it.
import { dogRepo } from '../data/dogRepo.js';
import { contactRepo } from '../data/contactRepo.js';
import { createReportView } from '../assets/reportView.js';
import { fmtDate } from '../assets/ui.js';
import { descriptor, SEX, DOG_STATUS, OWNERSHIP_TYPE } from '../data/vocab.js';

async function init() {
  const [contacts, breeds] = await Promise.all([
    contactRepo.getAll({ includeArchived: true }),
    dogRepo.getBreeds()
  ]);
  const contactName = (id) => contacts.find((c) => c.id === id)?.name || '';
  const label = (vocab, v) => (v ? descriptor(vocab, v).label : '');

  createReportView({
    mount: document.getElementById('roster-mount'),
    csvFilename: `active-roster-${new Date().toISOString().slice(0, 10)}.csv`,
    search: {
      placeholder: 'Search by name…',
      text: (d) => `${d.call_name || ''} ${d.registered_name || ''}`
    },
    filters: [
      { id: 'status', label: 'Status', options: DOG_STATUS, match: (d, v) => d.status === v },
      { id: 'sex', label: 'Sex', options: SEX, match: (d, v) => d.sex === v },
      { id: 'ownership', label: 'Ownership', options: OWNERSHIP_TYPE, match: (d, v) => d.ownership_type === v },
      { id: 'breed', label: 'Breed', options: breeds.map((b) => ({ value: b, label: b })), match: (d, v) => d.breed === v }
    ],
    columns: [
      { header: 'Call name', value: (d) => d.call_name || '' },
      { header: 'Registered name', value: (d) => d.registered_name || '' },
      { header: 'Sex', value: (d) => d.sex || '', badge: SEX, csv: (d) => label(SEX, d.sex) },
      { header: 'Breed', value: (d) => d.breed || '' },
      // Display localized; export the raw YYYY-MM-DD so the CSV stays sortable.
      { header: 'DOB', value: (d) => (d.date_of_birth ? fmtDate(d.date_of_birth) : ''), csv: (d) => d.date_of_birth || '' },
      { header: 'Status', value: (d) => d.status || '', badge: DOG_STATUS, csv: (d) => label(DOG_STATUS, d.status) },
      { header: 'Ownership', value: (d) => d.ownership_type || '', badge: OWNERSHIP_TYPE, csv: (d) => label(OWNERSHIP_TYPE, d.ownership_type) },
      { header: 'Owner', value: (d) => contactName(d.owner_contact_id) }
    ],
    onRowClick: (d) => { location.href = `dog.html?id=${encodeURIComponent(d.id)}`; },
    // Active Roster = non-archived only (the report's defining filter).
    load: () => dogRepo.getAll({ includeArchived: false }),
    emptyText: 'No active dogs match these filters.'
  });
}

init();
