// health-gaps-report.js — "Health-Testing Gaps" (Reports plan, phase 3). Per dog: its
// planned tests (Dog.planned_tests) against the results logged for it, matched by
// test name exactly as the dog page's Planned Tests panel matches them
// (eventRepo.testTokensOf, case-insensitive, trimmed) — advisory, so a result typed
// under another name reads as missing. Adult dogs only (no puppies, no deceased).
import { dogRepo } from '../data/dogRepo.js';
import { eventRepo, testTokensOf } from '../data/eventRepo.js';
import { testGapRows } from '../data/breedingReports.js';
import { createReportView } from '../assets/reportView.js';
import { dogInScope } from '../data/kennelScope.js';
import { DOG_STATUS, SEX, descriptor } from '../data/vocab.js';
import { rankBy } from '../data/reportMath.js';
import { SERIES_COLORS } from '../assets/chartView.js';

const TEST_TYPES = ['genetic_test', 'ofa_pennhip', 'breed_specific_test'];
const COVERAGE = [
  { value: 'complete', label: 'All logged',     badge: 'badge-green' },
  { value: 'gaps',     label: 'Missing some',   badge: 'badge-amber' },
  { value: 'no_plan',  label: 'No tests planned', badge: 'badge-gray' }
];
const coverage = (r) => (!r.planned.length ? 'no_plan' : r.missing.length ? 'gaps' : 'complete');

async function init() {
  const [dogs, ...byType] = await Promise.all([dogRepo.getAll({ includeArchived: false }), ...TEST_TYPES.map((t) => eventRepo.getByType(t))]);
  const rows = testGapRows(dogs.filter((d) => dogInScope(d) && d.status !== 'puppy' && d.status !== 'deceased'), byType.flat(), testTokensOf);

  createReportView({
    mount: document.getElementById('report-mount'),
    csvFilename: `health-testing-gaps-${new Date().toISOString().slice(0, 10)}.csv`,
    search: { placeholder: 'Search dog or test…', text: (r) => `${r.dog.call_name || ''} ${r.planned.join(' ')}` },
    filters: [
      { id: 'coverage', label: 'Coverage', options: COVERAGE, match: (r, v) => coverage(r) === v },
      { id: 'status', label: 'Status', options: DOG_STATUS, match: (r, v) => r.dog.status === v },
      { id: 'sex', label: 'Sex', options: SEX, match: (r, v) => r.dog.sex === v }
    ],
    kpis: (list) => [
      { label: 'Dogs', value: String(list.length) },
      { label: 'All planned tests logged', value: String(list.filter((r) => coverage(r) === 'complete').length) },
      { label: 'Missing some', value: String(list.filter((r) => coverage(r) === 'gaps').length), hint: `${list.reduce((t, r) => t + r.missing.length, 0)} tests in all` },
      { label: 'No tests planned', value: String(list.filter((r) => coverage(r) === 'no_plan').length) }
    ],
    charts: (list) => [{
      type: 'hbar', title: 'Most-missed tests', subtitle: 'Planned but no matching result logged', color: SERIES_COLORS[1], max: 12,
      rows: rankBy(list.flatMap((r) => r.missing.map((t) => ({ t }))), { key: (x) => x.t.toLowerCase(), label: (k) => list.flatMap((r) => r.missing).find((t) => t.toLowerCase() === k) || k }),
      emptyText: 'Every planned test has a result logged.'
    }],
    columns: [
      { header: 'Dog', value: (r) => r.dog.call_name || '' },
      { header: 'Status', value: (r) => r.dog.status || '', badge: DOG_STATUS, csv: (r) => (r.dog.status ? descriptor(DOG_STATUS, r.dog.status).label : '') },
      { header: 'Breed', value: (r) => r.dog.breed || '' },
      { header: 'Planned', value: (r) => String(r.planned.length) },
      { header: 'Logged', value: (r) => String(r.done.length) },
      { header: 'Missing', value: (r) => r.missing.join(', ') },
      { header: 'Coverage', value: (r) => coverage(r), badge: COVERAGE, csv: (r) => descriptor(COVERAGE, coverage(r)).label }
    ],
    onRowClick: (r) => { location.href = `dog.html?id=${encodeURIComponent(r.dog.id)}`; },
    load: () => Promise.resolve(rows),
    emptyText: 'No adult dogs to check.'
  });
}

init();
