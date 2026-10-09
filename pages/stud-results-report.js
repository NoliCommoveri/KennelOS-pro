// stud-results-report.js — "Stud Results" (Reports plan, phase 3). One row per stud
// service, outgoing or incoming: the litter it produced (a litter whose pairing_id
// is the service's pairing — breedingReports.studResultRows), puppies born, the fee
// and any pick. Incoming services are your dams bred to outside studs.
import { studServiceRepo } from '../data/studServiceRepo.js';
import { litterRepo } from '../data/litterRepo.js';
import { dogRepo } from '../data/dogRepo.js';
import { contactRepo } from '../data/contactRepo.js';
import { studResultRows } from '../data/breedingReports.js';
import { createReportView } from '../assets/reportView.js';
import { inScope } from '../data/kennelScope.js';
import { fmtDate, fmtMoney } from '../assets/ui.js';
import { STUD_SERVICE_DIRECTION, STUD_SERVICE_STATUS, FEE_STRUCTURE, descriptor } from '../data/vocab.js';
import { sumOf, rankBy } from '../data/reportMath.js';

const when = (r) => r.service.sent_date || r.service.returned_date || '';
const fee = (r) => (r.service.fee_amount === '' || r.service.fee_amount == null ? 0 : Number(r.service.fee_amount) || 0);

async function init() {
  const [services, litters, dogs, contacts] = await Promise.all([
    studServiceRepo.getAll({ includeArchived: false }), litterRepo.getAll({ includeArchived: true }),
    dogRepo.getAll({ includeArchived: true }), contactRepo.getAll({ includeArchived: true })
  ]);
  const dogName = new Map(dogs.map((d) => [d.id, d.call_name || '—']));
  const contactName = new Map(contacts.map((c) => [c.id, c.name || '—']));
  const rows = studResultRows(services, litters).sort((a, b) => when(b).localeCompare(when(a)));
  const outgoing = (r) => r.service.direction === 'outgoing';

  createReportView({
    mount: document.getElementById('report-mount'),
    scope: (r) => inScope(r.service),
    csvFilename: `stud-results-${new Date().toISOString().slice(0, 10)}.csv`,
    search: { placeholder: 'Search dog or partner…', text: (r) => `${dogName.get(r.service.our_dog_id) || ''} ${dogName.get(r.service.partner_dog_id) || ''} ${contactName.get(r.service.partner_contact_id) || ''}` },
    dateRange: { label: 'Sent', date: when },
    filters: [
      { id: 'direction', label: 'Direction', options: STUD_SERVICE_DIRECTION, match: (r, v) => r.service.direction === v },
      { id: 'status', label: 'Status', options: STUD_SERVICE_STATUS, match: (r, v) => r.service.status === v }
    ],
    kpis: (list) => {
      const litterRows = list.filter((r) => r.litter);
      return [
        { label: 'Services', value: String(list.length), hint: `${list.filter(outgoing).length} outgoing, ${list.length - list.filter(outgoing).length} incoming` },
        { label: 'Litters produced', value: String(litterRows.length) },
        { label: 'Puppies born', value: String(sumOf(litterRows, (r) => r.born)), hint: litterRows.length ? `${(sumOf(litterRows, (r) => r.born) / litterRows.length).toFixed(1)} a litter` : '' },
        { label: 'Fees earned', value: fmtMoney(sumOf(list.filter((r) => outgoing(r) && r.service.status === 'completed'), fee)) || '$0.00', hint: 'completed outgoing' }
      ];
    },
    charts: (list) => [{
      type: 'hbar', title: 'Puppies sired, by our stud', subtitle: 'From the litters outgoing services produced',
      rows: rankBy(list.filter((r) => outgoing(r) && r.litter), { key: (r) => r.service.our_dog_id, label: (id) => dogName.get(id) || '—', value: (r) => r.born }),
      emptyText: 'No litters recorded from outgoing services yet.'
    }],
    columns: [
      { header: 'Sent', value: (r) => (when(r) ? fmtDate(when(r)) : ''), csv: when },
      { header: 'Direction', value: (r) => r.service.direction || '', badge: STUD_SERVICE_DIRECTION, csv: (r) => descriptor(STUD_SERVICE_DIRECTION, r.service.direction).label },
      { header: 'Our dog', value: (r) => dogName.get(r.service.our_dog_id) || '—' },
      { header: 'Partner dog', value: (r) => dogName.get(r.service.partner_dog_id) || '—' },
      { header: 'Status', value: (r) => r.service.status || '', badge: STUD_SERVICE_STATUS, csv: (r) => descriptor(STUD_SERVICE_STATUS, r.service.status).label },
      { header: 'Litter', value: (r) => (r.litter ? (r.litter.whelp_date ? `Whelped ${fmtDate(r.litter.whelp_date)}` : 'Expected') : '') },
      { header: 'Born', value: (r) => (r.born == null ? '' : String(r.born)), total: (list) => String(sumOf(list, (r) => r.born)) },
      { header: 'Fee', value: (r) => (fee(r) ? fmtMoney(fee(r)) : ''), csv: (r) => String(fee(r)), className: 'num' },
      { header: 'Terms', value: (r) => (r.service.fee_structure ? descriptor(FEE_STRUCTURE, r.service.fee_structure).label : '') }
    ],
    onRowClick: (r) => { location.href = `stud-service.html?id=${encodeURIComponent(r.service.id)}`; },
    load: () => Promise.resolve(rows),
    emptyText: 'No stud services recorded in this range.'
  });
}

init();
