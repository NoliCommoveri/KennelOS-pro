// stud-services-report.js — "Stud services" analytics (Stage 5, Build Brief §5):
// outgoing/incoming arrangements by status, with partner and (linked) pairing.
// Derived read over StudService; reuses the reporting framework. No new schema.
import { studServiceRepo } from '../data/studServiceRepo.js';
import { dogRepo } from '../data/dogRepo.js';
import { contactRepo } from '../data/contactRepo.js';
import { createReportView } from '../assets/reportView.js';
import { STUD_SERVICE_DIRECTION, STUD_SERVICE_STATUS, descriptor } from '../data/vocab.js';

const FEE_STRUCTURES_WITH_PICK = ['pick_of_litter', 'flat_plus_pick'];

async function init() {
  const [services, dogs, contacts] = await Promise.all([
    studServiceRepo.getAll({ includeArchived: false }),
    dogRepo.getAll({ includeArchived: true }),
    contactRepo.getAll({ includeArchived: true })
  ]);
  const dogsById = new Map(dogs.map((d) => [d.id, d]));
  const contactsById = new Map(contacts.map((c) => [c.id, c]));
  const dogName = (id) => dogsById.get(id)?.call_name || '—';
  const contactName = (id) => contactsById.get(id)?.name || '—';

  createReportView({
    mount: document.getElementById('report-mount'),
    csvFilename: `stud-services-${new Date().toISOString().slice(0, 10)}.csv`,
    search: { placeholder: 'Search dog or partner…', text: (s) => `${dogName(s.our_dog_id)} ${dogName(s.partner_dog_id)} ${contactName(s.partner_contact_id)}` },
    filters: [
      { id: 'direction', label: 'Direction', options: STUD_SERVICE_DIRECTION, match: (s, v) => s.direction === v },
      { id: 'status', label: 'Status', options: STUD_SERVICE_STATUS, match: (s, v) => s.status === v }
    ],
    columns: [
      { header: 'Direction', value: (s) => s.direction || '', badge: STUD_SERVICE_DIRECTION, csv: (s) => s.direction ? descriptor(STUD_SERVICE_DIRECTION, s.direction).label : '' },
      { header: 'Our dog', value: (s) => dogName(s.our_dog_id) },
      { header: 'Partner dog', value: (s) => dogName(s.partner_dog_id) },
      { header: 'Partner contact', value: (s) => contactName(s.partner_contact_id) },
      { header: 'Status', value: (s) => s.status || '', badge: STUD_SERVICE_STATUS, csv: (s) => s.status ? descriptor(STUD_SERVICE_STATUS, s.status).label : '' },
      { header: 'Pick value', value: (s) => (FEE_STRUCTURES_WITH_PICK.includes(s.fee_structure) && s.pick_value_amount != null ? `$${Number(s.pick_value_amount).toFixed(2)}` : '') },
      { header: 'Pairing', value: (s) => (s.pairing_id ? 'linked' : ''), csv: (s) => (s.pairing_id ? 'linked' : '') }
    ],
    onRowClick: (s) => { location.href = `stud-service.html?id=${encodeURIComponent(s.id)}`; },
    load: () => Promise.resolve(services),
    emptyText: 'No stud services recorded yet.'
  });
}

init();
