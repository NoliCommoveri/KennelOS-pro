// health-tests-report.js — "Health-test events" analytics (Stage 5, Build Brief
// §5). A kennel-wide, filterable view of every recorded genetic / OFA-PennHIP /
// breed-specific test event across all dogs. Derived read over Event; reuses the
// reporting framework. This is presentation, not inference — no carrier-risk math
// or genotype interpretation (§6 scope wall). It's the cross-dog complement to
// the per-dog Health-Test Summary on Dog Detail.
import { eventRepo } from '../data/eventRepo.js';
import { dogRepo } from '../data/dogRepo.js';
import { createReportView } from '../assets/reportView.js';
import { fmtDate } from '../assets/ui.js';
import { EVENT_TYPES, descriptor } from '../data/vocab.js';

const HEALTH_TEST_TYPES = ['genetic_test', 'ofa_pennhip', 'breed_specific_test'];
const TYPE_OPTIONS = EVENT_TYPES.filter((t) => HEALTH_TEST_TYPES.includes(t.value));

// A compact "label: value" of the event's type-specific details (panel/result,
// joint/method/rating, test/result — whatever the type carries).
function detailsText(ev) {
  const typeDef = descriptor(EVENT_TYPES, ev.event_type);
  if (!typeDef.fields?.length || !ev.details) return '';
  return typeDef.fields
    .filter((f) => ev.details[f.key] != null && ev.details[f.key] !== '')
    .map((f) => `${f.label}: ${ev.details[f.key]}`)
    .join(' · ');
}

async function init() {
  const [events, dogs] = await Promise.all([
    eventRepo.getAll({ includeArchived: false }),
    dogRepo.getAll({ includeArchived: true })
  ]);
  const dogsById = new Map(dogs.map((d) => [d.id, d]));
  const rows = events.filter((e) => e.subject_type === 'dog' && HEALTH_TEST_TYPES.includes(e.event_type));
  rows.sort((a, b) => (b.event_date || '').localeCompare(a.event_date || ''));
  const dogName = (e) => dogsById.get(e.subject_id)?.call_name || '—';

  createReportView({
    mount: document.getElementById('report-mount'),
    csvFilename: `health-tests-${new Date().toISOString().slice(0, 10)}.csv`,
    search: { placeholder: 'Search dog, title, or result…', text: (e) => `${dogName(e)} ${e.title || ''} ${detailsText(e)}` },
    filters: [
      { id: 'type', label: 'Test type', options: TYPE_OPTIONS, match: (e, v) => e.event_type === v }
    ],
    columns: [
      { header: 'Date', value: (e) => (e.event_date ? fmtDate(e.event_date) : ''), csv: (e) => e.event_date || '' },
      { header: 'Dog', value: dogName },
      { header: 'Type', value: (e) => e.event_type, badge: EVENT_TYPES, csv: (e) => descriptor(EVENT_TYPES, e.event_type).label },
      { header: 'Title', value: (e) => e.title || '' },
      { header: 'Details', value: detailsText }
    ],
    onRowClick: (e) => { location.href = `dog.html?id=${encodeURIComponent(e.subject_id)}`; },
    load: () => Promise.resolve(rows),
    emptyText: 'No health-test events recorded yet.'
  });
}

init();
