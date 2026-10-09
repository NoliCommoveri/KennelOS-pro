// show-record-report.js — "Show Record" (Reports plan, phase 3). One row per show
// result (a `show` event with entry_status 'shown'), across every dog in scope:
// show, judge, class, award and points (showPoints.eventPoints — the same number the
// dog page's championship progress counts). Titles earned in the range come from
// title_earned events. Planned and entered shows live on the Shows page.
import { dogRepo } from '../data/dogRepo.js';
import { eventRepo } from '../data/eventRepo.js';
import { eventPoints, normalizeJudge } from '../data/showPoints.js';
import { createReportView } from '../assets/reportView.js';
import { subjectInScope } from '../data/kennelScope.js';
import { fmtDate } from '../assets/ui.js';
import { TITLE_TRACKS, descriptor } from '../data/vocab.js';
import { sumOf, rankBy, inRange } from '../data/reportMath.js';
import { SERIES_COLORS } from '../assets/chartView.js';

const plural = (n, word) => `${n} ${word}${n === 1 ? '' : 's'}`;

async function init() {
  const [dogs, shows, titles] = await Promise.all([
    dogRepo.getAll({ includeArchived: true }), eventRepo.getByType('show'), eventRepo.getByType('title_earned')
  ]);
  const dogsById = new Map(dogs.map((d) => [d.id, d]));
  const name = (id) => dogsById.get(id)?.call_name || '—';
  const inScopeDog = (e) => subjectInScope('dog', e.subject_id, { dog: dogsById });
  const results = shows.filter((e) => e.details?.entry_status === 'shown').sort((a, b) => b.event_date.localeCompare(a.event_date));
  const shownDogs = [...new Set(results.map((e) => e.subject_id))].map((id) => ({ value: id, label: name(id) })).sort((a, b) => a.label.localeCompare(b.label));
  // The judge as written most often, for a normalized judge key.
  const judgeName = new Map();
  for (const e of results) { const k = normalizeJudge(e.details?.judge); if (k && !judgeName.has(k)) judgeName.set(k, String(e.details.judge).trim()); }

  createReportView({
    mount: document.getElementById('report-mount'),
    scope: inScopeDog,
    csvFilename: `show-record-${new Date().toISOString().slice(0, 10)}.csv`,
    search: { placeholder: 'Search dog, show or judge…', text: (e) => `${name(e.subject_id)} ${e.details?.show_name || ''} ${e.details?.judge || ''}` },
    dateRange: { label: 'Shown', date: (e) => e.event_date },
    filters: [
      { id: 'dog', label: 'Dog', options: shownDogs, match: (e, v) => e.subject_id === v },
      { id: 'track', label: 'Points toward', options: TITLE_TRACKS, match: (e, v) => e.details?.points_toward === v }
    ],
    kpis: (list, ctx) => {
      const earned = titles.filter((t) => inScopeDog(t) && inRange(t.event_date, ctx.range));
      return [
        { label: 'Results', value: String(list.length), hint: plural(new Set(list.map((e) => e.subject_id)).size, 'dog') + ' shown' },
        { label: 'Points won', value: String(sumOf(list, eventPoints)) },
        { label: 'Pointed wins', value: String(list.filter((e) => eventPoints(e) > 0).length), hint: `${plural(list.filter((e) => eventPoints(e) >= 3).length, 'major')} (3+ points)` },
        { label: 'Titles earned', value: String(earned.length), hint: earned.map((t) => `${name(t.subject_id)} ${t.details?.title_abbreviation || ''}`.trim()).slice(0, 3).join(', ') }
      ];
    },
    charts: (list) => [
      { type: 'hbar', title: 'Points by dog', rows: rankBy(list, { key: (e) => e.subject_id, label: name, value: eventPoints }), emptyText: 'No points won in this range.' },
      { type: 'hbar', title: 'Points by judge', color: SERIES_COLORS[6], max: 10,
        rows: rankBy(list, { key: (e) => normalizeJudge(e.details?.judge), label: (k) => judgeName.get(k) || k, value: eventPoints }), emptyText: 'No points won in this range.' }
    ],
    columns: [
      { header: 'Date', value: (e) => fmtDate(e.event_date), csv: (e) => e.event_date },
      { header: 'Dog', value: (e) => name(e.subject_id) },
      { header: 'Show', value: (e) => e.details?.show_name || e.title || '' },
      { header: 'Judge', value: (e) => e.details?.judge || '' },
      { header: 'Class', value: (e) => e.details?.class || '' },
      { header: 'Award', value: (e) => e.details?.placement || '' },
      { header: 'Points', value: (e) => (eventPoints(e) ? String(eventPoints(e)) : ''), csv: (e) => String(eventPoints(e)), total: (rows) => String(sumOf(rows, eventPoints)) },
      { header: 'Toward', value: (e) => (e.details?.points_toward ? descriptor(TITLE_TRACKS, e.details.points_toward).label : '') }
    ],
    onRowClick: (e) => { location.href = `dog.html?id=${encodeURIComponent(e.subject_id)}`; },
    load: () => Promise.resolve(results),
    emptyText: 'No show results recorded in this range.'
  });
}

init();
