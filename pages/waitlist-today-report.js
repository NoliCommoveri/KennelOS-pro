// waitlist-today-report.js — "Waitlist Today" (Reports plan, phase 4). A snapshot,
// not a range: the families on the list now, in list order, with what they want
// (a girl, a boy, either), their program and breed, how long they've waited, the
// passes they've used and whether they're paused. Places, pauses and passes come
// from waitlistRules.js, the same functions the Waitlist page uses; the counts
// from data/waitlistReports.js. Scoped by each entry's kennel.
import { loadWaitlistToday } from '../data/reportSources.js';
import { waitingFigures } from '../data/reportFigures.js';
import { entryName, passesUsed } from '../data/waitlistRules.js';
import { sexWanted, listedSince, waitBuckets, median } from '../data/waitlistReports.js';
import { createReportView } from '../assets/reportView.js';
import { inScope, isScoped } from '../data/kennelScope.js';
import { fmtDate } from '../assets/ui.js';
import { todayYMD } from '../data/dateUtils.js';
import { daysBetween } from '../data/breedingReports.js';
import { WAITLIST_PREF_SEX, descriptor } from '../data/vocab.js';
import { pct, rankBy } from '../data/reportMath.js';
import { SERIES_COLORS } from '../assets/chartView.js';

async function init() {
  const today = todayYMD();
  const src = await loadWaitlistToday(today);
  const { rows: onList, paused, waited, place, kennelName, offers, programs, programsById, contacts } = src;
  const contactsById = new Map(contacts.map((c) => [c.id, c]));
  const name = (e) => entryName(e, contactsById.get(e.contact_id) || null);
  const program = (e) => programsById.get(e.waitlist_program_id)?.name || '';
  const kennelCount = new Set(onList.filter(inScope).map((e) => e.kennel_id)).size;

  // Families not on the list yet, for the pipeline tiles (scoped like the rows).
  const { pipeline } = src;
  const toReview = pipeline.filter((e) => e.status === 'applied').length;
  const feeDue = pipeline.filter((e) => e.status === 'approved').length;

  const programOptions = programs.filter((p) => !p.is_archived).map((p) => ({ value: p.id, label: p.name }));
  const breeds = [...new Set(onList.map((e) => (e.pref_breed || '').trim()).filter(Boolean))];

  createReportView({
    mount: document.getElementById('report-mount'),
    scope: src.scope,
    csvFilename: `waitlist-today-${today}.csv`,
    search: { placeholder: 'Search family…', text: name },
    filters: [
      { id: 'sex', label: 'Wants', options: WAITLIST_PREF_SEX, match: (e, v) => (e.pref_sex || 'any') === v },
      { id: 'paused', label: 'Paused', options: [{ value: 'yes', label: 'Paused' }, { value: 'no', label: 'Not paused' }], match: (e, v) => paused(e) === (v === 'yes') },
      ...(programOptions.length ? [{ id: 'program', label: 'Program', options: programOptions, match: (e, v) => e.waitlist_program_id === v }] : [])
    ],
    kpis: (list) => {
      const f = waitingFigures(list, { paused, waited });
      const m = f.medianWait;
      return [
        { label: 'Waiting now', value: String(f.waiting), hint: `${f.paused} paused` },
        { label: 'Want a girl', value: String(f.girl), hint: pct(f.girl, f.waiting) || '' },
        { label: 'Want a boy', value: String(f.boy), hint: pct(f.boy, f.waiting) || '' },
        { label: 'Either', value: String(f.either), hint: pct(f.either, f.waiting) || '' },
        { label: 'Time waiting', value: m == null ? '—' : `${Math.round(m)} days`, hint: m == null ? '' : 'median' },
        { label: 'Not on the list yet', value: String(toReview + feeDue), hint: `${toReview} to review, ${feeDue} fee due` }
      ];
    },
    charts: (list) => {
      const total = list.length;
      const share = (v) => `${v} (${pct(v, total) || '0%'})`;
      const charts = [
        { type: 'hbar', title: 'What they’re waiting for', sort: false, showZero: true, color: SERIES_COLORS[4], format: share,
          rows: sexWanted(list).map((s) => ({ label: s.label, value: s.count })) },
        { type: 'hbar', title: 'How long they’ve waited', sort: false, showZero: true, format: share, rows: waitBuckets(list, today) }
      ];
      if (programOptions.length) {
        charts.push({ type: 'hbar', title: 'By program', color: SERIES_COLORS[2], format: share,
          rows: rankBy(list, { key: (e) => program(e) || 'No program' }) });
      }
      if (breeds.length > 1) {
        charts.push({ type: 'hbar', title: 'By breed', color: SERIES_COLORS[3], format: share,
          rows: rankBy(list, { key: (e) => (e.pref_breed || '').trim() || 'Any breed' }) });
      }
      return charts;
    },
    groupBy: kennelCount > 1 && !isScoped() ? kennelName : null,
    columns: [
      { header: 'Place', value: (e) => `#${place.get(e.id)}`, csv: (e) => String(place.get(e.id)) },
      { header: 'Family', value: name },
      { header: 'Wants', value: (e) => descriptor(WAITLIST_PREF_SEX, e.pref_sex || 'any').label },
      ...(breeds.length > 1 ? [{ header: 'Breed', value: (e) => (e.pref_breed || '').trim() || 'Any' }] : []),
      ...(programOptions.length ? [{ header: 'Program', value: program }] : []),
      { header: 'Waiting since', value: (e) => (listedSince(e) ? fmtDate(listedSince(e)) : ''), csv: (e) => listedSince(e) || '' },
      { header: 'Days', value: (e) => { const d = waited(e); return d == null ? '' : String(d); } },
      { header: 'Passes used', value: (e) => String(passesUsed(e, offers)) },
      { header: 'Paused', value: (e) => (paused(e) ? 'Paused' : ''), tone: (e) => (paused(e) ? 'badge-amber' : null) }
    ],
    onRowClick: (e) => { location.href = `waitlist-entry.html?id=${encodeURIComponent(e.id)}`; },
    load: () => Promise.resolve(onList),
    emptyText: 'No families are on the list right now.'
  });
}

init();
