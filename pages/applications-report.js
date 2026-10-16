// applications-report.js — "Applications" (Reports plan, phase 4). One row per
// application, filtered by when it came in: how often families apply (days between
// applications), how many she approves, how many of those go on the list, how long
// approval and the fee take, and what they ask for: every answer that decides which
// pup they're offered (sex, what it's for, which parents, and breed and color where
// those vary or count). Pure math in
// data/waitlistReports.js; scoped by each entry's kennel.
import { loadApplications } from '../data/reportSources.js';
import { applicationFigures } from '../data/reportFigures.js';
import { entryName, waitlistConfig } from '../data/waitlistRules.js';
import {
  applicationGaps, wasApproved, wasDecided, wasListed, daysToApprove, daysToFee, sexWanted, mean, median,
  purposesWanted, purposesText, PARENT_CHOICES, parentChoice, parentsWanted, parentsNamed, breedsWanted, colorsWanted
} from '../data/waitlistReports.js';
import { createReportView } from '../assets/reportView.js';
import { inScope } from '../data/kennelScope.js';
import { fmtDate } from '../assets/ui.js';
import { todayYMD } from '../data/dateUtils.js';
import { daysBetween } from '../data/breedingReports.js';
import { WAITLIST_ENTRY_STATUS, WAITLIST_PREF_SEX, PLACEMENT_PURPOSE, descriptor, cleanPurposes } from '../data/vocab.js';
import { pct, periodSeries, rankBy } from '../data/reportMath.js';
import { SERIES_COLORS } from '../assets/chartView.js';

const days = (n) => (n == null ? '—' : `${Math.round(n)} day${Math.round(n) === 1 ? '' : 's'}`);

async function init() {
  const src = await loadApplications();
  const { rows: entries, programs, contacts, dogs, kennels } = src;
  const dogsById = new Map(dogs.map((d) => [d.id, d]));
  const dogName = (id) => dogsById.get(id)?.call_name || dogsById.get(id)?.registered_name || 'A dog no longer on file';
  const contactsById = new Map(contacts.map((c) => [c.id, c]));
  const programsById = new Map(programs.map((p) => [p.id, p]));
  const today = todayYMD();
  const name = (e) => entryName(e, contactsById.get(e.contact_id) || null);
  const program = (e) => programsById.get(e.waitlist_program_id)?.name || '';

  // Days since the application before it (in the whole scoped set, so a filter
  // doesn't change a row's own gap).
  const gapBefore = new Map();
  const scoped = entries.filter((e) => inScope(e) && e.applied_date).sort((a, b) => a.applied_date.localeCompare(b.applied_date));
  scoped.forEach((e, i) => { if (i) gapBefore.set(e.id, daysBetween(scoped[i - 1].applied_date, e.applied_date)); });

  const programOptions = programs.filter((p) => !p.is_archived).map((p) => ({ value: p.id, label: p.name }));

  // Breed and color only where they decide anything: breed when families named
  // more than one, color when one of her kennels matches on it.
  const inScopeEntries = entries.filter(inScope);
  const showBreed = breedsWanted(inScopeEntries).filter((b) => b.value).length > 1;
  const showColor = kennels.some((k) => waitlistConfig(k).color_matching && inScopeEntries.some((e) => e.kennel_id === k.id));
  const parentsText = (e) => {
    const mode = parentChoice(e);
    if (mode === 'all') return 'Any';
    const names = [...new Set([...(e.listen_sire_ids || []), ...(e.listen_dam_ids || [])])].map(dogName).join(', ');
    return mode === 'selected' ? `Only ${names}` : `Any but ${names}`;
  };

  createReportView({
    mount: document.getElementById('report-mount'),
    scope: inScope,
    csvFilename: `applications-${today}.csv`,
    search: { placeholder: 'Search family…', text: name },
    dateRange: { label: 'Applied', date: src.date },
    filters: [
      { id: 'status', label: 'Status', options: WAITLIST_ENTRY_STATUS, match: (e, v) => e.status === v },
      { id: 'sex', label: 'Wants', options: WAITLIST_PREF_SEX, match: (e, v) => (e.pref_sex || 'any') === v },
      { id: 'purpose', label: 'For', options: [...PLACEMENT_PURPOSE.map((p) => ({ value: p.value, label: p.label.split(' (')[0] })), { value: 'any', label: 'Any purpose' }],
        match: (e, v) => { const l = cleanPurposes(e.pref_purposes); return v === 'any' ? !l.length : l.includes(v); } },
      { id: 'parents', label: 'Parents', options: PARENT_CHOICES, match: (e, v) => parentChoice(e) === v },
      ...(programOptions.length ? [{ id: 'program', label: 'Program', options: programOptions, match: (e, v) => e.waitlist_program_id === v }] : [])
    ],
    kpis: (list) => {
      const f = applicationFigures(list);
      return [
        { label: 'Applications', value: String(f.count) },
        { label: 'Between applications', value: days(f.meanGap), hint: f.gaps ? `average; median ${days(f.medianGap)}` : '' },
        { label: 'Approved', value: pct(f.approved, f.decided) || '—', hint: f.decided ? `${f.approved} of ${f.decided} decided` : '' },
        { label: 'Approved → on the list', value: pct(f.listed, f.approved) || '—', hint: f.approved ? `${f.listed} of ${f.approved}` : '' },
        { label: 'Applied → approved', value: days(f.daysToApprove), hint: f.daysToApprove != null ? 'median' : '' },
        { label: 'Approved → fee paid', value: days(f.daysToFee), hint: f.daysToFee != null ? 'median' : '' }
      ];
    },
    charts: (list, ctx) => {
      const dated = list.filter((e) => e.applied_date);
      const p = periodSeries(dated, ctx.range, { date: (e) => e.applied_date, series: [{ name: 'Applications' }] });
      const total = list.length;
      const share = (v) => `${v} (${pct(v, total) || '0%'})`;
      const answers = (rows) => rows.map((s) => ({ label: s.label, value: s.count }));
      const charts = [
        { type: 'bar', title: `Applications by ${p.granularity}`, categories: p.categories, series: p.series },
        { type: 'hbar', title: 'A boy or a girl', sort: false, showZero: true, color: SERIES_COLORS[4], format: share, rows: answers(sexWanted(list)) },
        { type: 'hbar', title: 'What the pup is for', subtitle: 'Families can pick more than one', sort: false, showZero: true, color: SERIES_COLORS[0], format: share, rows: answers(purposesWanted(list)) },
        { type: 'hbar', title: 'Which parents', sort: false, showZero: true, color: SERIES_COLORS[6], format: share, rows: answers(parentsWanted(list)) }
      ];
      const asked = parentsNamed(list, 'selected', dogName);
      if (asked.length) charts.push({ type: 'hbar', title: 'Parents they asked for', color: SERIES_COLORS[6], format: share, rows: asked });
      const skipped = parentsNamed(list, 'except', dogName);
      if (skipped.length) charts.push({ type: 'hbar', title: 'Parents they’d rather skip', color: SERIES_COLORS[7], format: share, rows: skipped });
      if (showBreed) charts.push({ type: 'hbar', title: 'Breed', sort: false, color: SERIES_COLORS[3], format: share, rows: answers(breedsWanted(list)) });
      if (showColor) charts.push({ type: 'hbar', title: 'Color', subtitle: 'Families can pick more than one', sort: false, color: SERIES_COLORS[5], format: share, rows: answers(colorsWanted(list)) });
      if (programOptions.length) {
        charts.push({ type: 'hbar', title: 'By program', color: SERIES_COLORS[2], format: share,
          rows: rankBy(list, { key: (e) => program(e) || 'No program' }) });
      }
      return charts;
    },
    columns: [
      { header: 'Applied', value: (e) => (e.applied_date ? fmtDate(e.applied_date) : ''), csv: (e) => e.applied_date || '' },
      { header: 'Family', value: name },
      { header: 'Status', value: (e) => e.status || '', badge: WAITLIST_ENTRY_STATUS, csv: (e) => (e.status ? descriptor(WAITLIST_ENTRY_STATUS, e.status).label : '') },
      { header: 'Wants', value: (e) => descriptor(WAITLIST_PREF_SEX, e.pref_sex || 'any').label },
      { header: 'For', value: purposesText },
      { header: 'Parents', value: parentsText },
      ...(showBreed ? [{ header: 'Breed', value: (e) => String(e.pref_breed ?? '').trim() || 'Any' }] : []),
      ...(showColor ? [{ header: 'Color', value: (e) => (Array.isArray(e.pref_colors) ? e.pref_colors.join(', ') : String(e.pref_colors ?? '').trim()) || 'Any' }] : []),
      ...(programOptions.length ? [{ header: 'Program', value: program }] : []),
      { header: 'Days since the one before', value: (e) => (gapBefore.has(e.id) ? String(gapBefore.get(e.id)) : '') },
      { header: 'Days to approve', value: (e) => { const d = daysToApprove(e); return d == null ? '' : String(d); } },
      { header: 'Days to fee', value: (e) => { const d = daysToFee(e); return d == null ? '' : String(d); } }
    ],
    onRowClick: (e) => { location.href = `waitlist-entry.html?id=${encodeURIComponent(e.id)}`; },
    load: () => Promise.resolve(entries),
    emptyText: 'No applications in this range.'
  });
}

init();
