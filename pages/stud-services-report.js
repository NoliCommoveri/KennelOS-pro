// stud-services-report.js — "Stud services" analytics (Stage 5, Build Brief §5):
// outgoing/incoming arrangements by status, with partner and (linked) pairing.
// Derived read over StudService; reuses the reporting framework. No new schema.
import { studServiceRepo } from '../data/studServiceRepo.js';
import { dogRepo } from '../data/dogRepo.js';
import { contactRepo } from '../data/contactRepo.js';
import { createReportView } from '../assets/reportView.js';
import { inScope } from '../data/kennelScope.js';
import { STUD_SERVICE_DIRECTION, STUD_SERVICE_STATUS, descriptor } from '../data/vocab.js';
import { fmtDate, fmtMoney } from '../assets/ui.js';
import { periodSeries, sumOf } from '../data/reportMath.js';
import { SERIES_COLORS } from '../assets/chartView.js';

const when = (s) => s.sent_date || s.returned_date || '';
const dirColor = (v) => SERIES_COLORS[STUD_SERVICE_DIRECTION.findIndex((d) => d.value === v)];

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
    // Active-kennel scope (Multi-Kennel Scope Spec §7) — a stud service is stamped
    // from OUR dog, never the partner's, so an incoming service files under the
    // kennel whose stud did the work. The partner dog stays external and
    // scope-transparent; only the arrangement is scoped.
    scope: inScope,
    csvFilename: `stud-services-${new Date().toISOString().slice(0, 10)}.csv`,
    search: { placeholder: 'Search dog or partner…', text: (s) => `${dogName(s.our_dog_id)} ${dogName(s.partner_dog_id)} ${contactName(s.partner_contact_id)}` },
    filters: [
      { id: 'direction', label: 'Direction', options: STUD_SERVICE_DIRECTION, match: (s, v) => s.direction === v },
      { id: 'status', label: 'Status', options: STUD_SERVICE_STATUS, match: (s, v) => s.status === v }
    ],
    dateRange: { label: 'Sent', date: when },
    kpis: (rows) => {
      const out = rows.filter((s) => s.direction === 'outgoing');
      const inc = rows.filter((s) => s.direction === 'incoming');
      return [
        { label: 'Outgoing', value: String(out.length), hint: `${out.filter((s) => s.status === 'completed').length} completed` },
        { label: 'Incoming', value: String(inc.length), hint: `${inc.filter((s) => s.status === 'completed').length} completed` },
        { label: 'Fees earned', value: fmtMoney(sumOf(out.filter((s) => s.status === 'completed'), (s) => s.fee_amount)) || '$0.00', hint: 'completed outgoing' },
        { label: 'Fees paid', value: fmtMoney(sumOf(inc.filter((s) => s.status === 'completed'), (s) => s.fee_amount)) || '$0.00', hint: 'completed incoming' }
      ];
    },
    charts: (rows, ctx) => {
      const dated = rows.filter(when);
      const p = periodSeries(dated, ctx.range, {
        date: when,
        series: STUD_SERVICE_DIRECTION.map((d) => ({ name: d.label, color: dirColor(d.value), when: (s) => s.direction === d.value }))
      });
      return [{ type: 'bar', title: `Stud services by ${p.granularity}`, subtitle: 'By the date sent', categories: p.categories, series: p.series }];
    },
    columns: [
      { header: 'Sent', value: (s) => (when(s) ? fmtDate(when(s)) : ''), csv: when },
      { header: 'Direction', value: (s) => s.direction || '', badge: STUD_SERVICE_DIRECTION, csv: (s) => s.direction ? descriptor(STUD_SERVICE_DIRECTION, s.direction).label : '' },
      { header: 'Our dog', value: (s) => dogName(s.our_dog_id) },
      { header: 'Partner dog', value: (s) => dogName(s.partner_dog_id) },
      { header: 'Partner contact', value: (s) => contactName(s.partner_contact_id) },
      { header: 'Status', value: (s) => s.status || '', badge: STUD_SERVICE_STATUS, csv: (s) => s.status ? descriptor(STUD_SERVICE_STATUS, s.status).label : '' },
      { header: 'Fee', value: (s) => (s.fee_amount != null && s.fee_amount !== '' ? fmtMoney(s.fee_amount) : ''), csv: (s) => (s.fee_amount ?? '') === '' ? '' : String(s.fee_amount), className: 'num' },
      { header: 'Pick value', value: (s) => (FEE_STRUCTURES_WITH_PICK.includes(s.fee_structure) && s.pick_value_amount != null ? `$${Number(s.pick_value_amount).toFixed(2)}` : '') },
      { header: 'Pairing', value: (s) => (s.pairing_id ? 'linked' : ''), csv: (s) => (s.pairing_id ? 'linked' : '') }
    ],
    onRowClick: (s) => { location.href = `stud-service.html?id=${encodeURIComponent(s.id)}`; },
    load: () => Promise.resolve(services),
    emptyText: 'No stud services recorded yet.'
  });
}

init();
