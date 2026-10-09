// heat-cycles-report.js — "Heat Cycles" (Reports plan, phase 3). One row per female
// with heat_cycle events: heats on record, her usual days between them, and a
// predicted next heat (last + her average; needs two heats) with due-soon / overdue
// marks. Derived from her own history (breedingReports.heatRows), never stored.
import { dogRepo } from '../data/dogRepo.js';
import { eventRepo } from '../data/eventRepo.js';
import { heatRows } from '../data/breedingReports.js';
import { createReportView } from '../assets/reportView.js';
import { dogInScope } from '../data/kennelScope.js';
import { fmtDate } from '../assets/ui.js';
import { todayYMD } from '../data/dateUtils.js';
import { DOG_STATUS, descriptor } from '../data/vocab.js';

const STATUS = [
  { value: 'overdue',  label: 'Overdue',  badge: 'badge-red' },
  { value: 'due_soon', label: 'Due soon', badge: 'badge-amber' },
  { value: 'ok',       label: 'Later',    badge: 'badge-neutral' }
];
const months = (days) => (days == null ? '' : `${(days / 30.44).toFixed(1)} mo`);

async function init() {
  const today = todayYMD();
  const [dogs, events] = await Promise.all([dogRepo.getAll({ includeArchived: false }), eventRepo.getByType('heat_cycle')]);
  const rows = heatRows(dogs.filter((d) => d.sex === 'female' && dogInScope(d)), events, today);

  createReportView({
    mount: document.getElementById('report-mount'),
    csvFilename: `heat-cycles-${today}.csv`,
    search: { placeholder: 'Search female…', text: (r) => r.dog.call_name || '' },
    filters: [
      { id: 'next', label: 'Next heat', options: STATUS, match: (r, v) => r.status === v },
      { id: 'status', label: 'Status', options: DOG_STATUS, match: (r, v) => r.dog.status === v }
    ],
    kpis: (list) => [
      { label: 'Females tracked', value: String(list.length) },
      { label: 'Due in 30 days', value: String(list.filter((r) => r.status === 'due_soon').length) },
      { label: 'Overdue', value: String(list.filter((r) => r.status === 'overdue').length), hint: 'predicted date passed, no heat logged' },
      { label: 'Usual interval', value: (() => { const xs = list.filter((r) => r.avgInterval); return xs.length ? months(xs.reduce((t, r) => t + r.avgInterval, 0) / xs.length) : '—'; })(), hint: 'average across these females' }
    ],
    charts: (list) => [{
      type: 'hbar', title: 'Usual time between heats', subtitle: 'Average days between logged heats', format: (v) => `${Math.round(v)} days`,
      rows: list.filter((r) => r.avgInterval).map((r) => ({ label: r.dog.call_name || '—', value: r.avgInterval, note: `${r.heats} heats; ${r.shortest}–${r.longest} days` })),
      emptyText: 'Log two heats on a female to see her interval.'
    }],
    columns: [
      { header: 'Female', value: (r) => r.dog.call_name || '' },
      { header: 'Status', value: (r) => r.dog.status || '', badge: DOG_STATUS, csv: (r) => (r.dog.status ? descriptor(DOG_STATUS, r.dog.status).label : '') },
      { header: 'Heats logged', value: (r) => String(r.heats) },
      { header: 'Last heat', value: (r) => fmtDate(r.last), csv: (r) => r.last },
      { header: 'Usual interval', value: (r) => (r.avgInterval ? `${r.avgInterval} days (${months(r.avgInterval)})` : 'Needs two heats') },
      { header: 'Next heat (predicted)', value: (r) => (r.next ? fmtDate(r.next) : ''), csv: (r) => r.next || '' },
      { header: 'When', value: (r) => (r.until == null ? '' : r.until < 0 ? `${-r.until} days overdue` : r.until === 0 ? 'Today' : `in ${r.until} days`),
        tone: (r) => descriptor(STATUS, r.status).badge || null }
    ],
    onRowClick: (r) => { location.href = `dog.html?id=${encodeURIComponent(r.dog.id)}`; },
    load: () => Promise.resolve(rows),
    emptyText: 'No heat cycles logged yet.'
  });
}

init();
