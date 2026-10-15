// offers-removals-report.js — "Offers & Removals" (Reports plan, phase 4). One row
// per closed offer and per family that left the list, filtered by when it happened:
// how offers ended (accepted, passed, no response) as shares of the offers closed,
// why families passed, and why families left, with the removals the list's own
// rules made ("didn't follow the list's rules": a second pass, no check-in or
// ready-check answer, the fee not received) apart from hers. Pure math in
// data/waitlistReports.js; scoped by each entry's kennel.
import { waitlistEntryRepo } from '../data/waitlistEntryRepo.js';
import { waitlistOfferRepo } from '../data/waitlistOfferRepo.js';
import { contactRepo } from '../data/contactRepo.js';
import { litterRepo } from '../data/litterRepo.js';
import { dogRepo } from '../data/dogRepo.js';
import { entryName } from '../data/waitlistRules.js';
import { offerAndExitRows, offerAndExitStats, exitLabel, EXIT_GROUPS } from '../data/waitlistReports.js';
import { litterLabel } from '../data/litterCheckin.js';
import { createReportView } from '../assets/reportView.js';
import { inScope } from '../data/kennelScope.js';
import { fmtDate } from '../assets/ui.js';
import { todayYMD } from '../data/dateUtils.js';
import { WAITLIST_OFFER_OUTCOME, descriptor } from '../data/vocab.js';
import { pct, periodSeries } from '../data/reportMath.js';
import { SERIES_COLORS } from '../assets/chartView.js';

const WHAT = [
  ...WAITLIST_OFFER_OUTCOME.filter((o) => ['accepted', 'passed', 'no_response'].includes(o.value)).map((o) => ({ value: o.value, label: `Offer ${o.label.toLowerCase()}` })),
  ...EXIT_GROUPS
];
const whatLabel = (v) => WHAT.find((w) => w.value === v)?.label || v;

async function init() {
  const [entries, offers, contacts, litters, dogs] = await Promise.all([
    waitlistEntryRepo.getAll({ includeArchived: false }),
    waitlistOfferRepo.getAll({ includeArchived: false }),
    contactRepo.getAll({ includeArchived: true }),
    litterRepo.getAll({ includeArchived: true }),
    dogRepo.getAll({ includeArchived: true })
  ]);
  const contactsById = new Map(contacts.map((c) => [c.id, c]));
  const littersById = new Map(litters.map((l) => [l.id, l]));
  const dogsById = new Map(dogs.map((d) => [d.id, d]));
  const today = todayYMD();
  const name = (r) => entryName(r.entry, contactsById.get(r.entry.contact_id) || null);
  const litter = (r) => { const l = r.offer && littersById.get(r.offer.litter_id); return l ? litterLabel(l, dogsById) : ''; };
  const reason = (r) => (r.kind === 'offer' ? (r.what === 'passed' ? r.offer.pass_reason?.label || 'Recorded by you' : '') : exitLabel(r.entry) || '');
  const rows = offerAndExitRows(entries, offers);

  createReportView({
    mount: document.getElementById('report-mount'),
    scope: (r) => inScope(r.entry),
    csvFilename: `offers-removals-${today}.csv`,
    search: { placeholder: 'Search family…', text: name },
    dateRange: { label: 'Happened', date: (r) => r.date },
    filters: [
      { id: 'what', label: 'What happened', options: WHAT, match: (r, v) => r.what === v }
    ],
    kpis: (list) => {
      const s = offerAndExitStats(list);
      const rules = s.byGroup.find((g) => g.value === 'rules').count;
      return [
        { label: 'Offers closed', value: String(s.closed), hint: s.familiesOffered ? `to ${s.familiesOffered} famil${s.familiesOffered === 1 ? 'y' : 'ies'}` : '' },
        { label: 'Accepted', value: pct(s.accepted, s.closed) || '—', hint: s.closed ? `${s.accepted} of ${s.closed} offers` : '' },
        { label: 'Passed', value: pct(s.passed, s.closed) || '—', hint: s.closed ? `${s.passed} of ${s.closed}; ${s.countedPasses} counted as a pass` : '' },
        { label: 'No response', value: pct(s.noResponse, s.closed) || '—', hint: s.closed ? `${s.noResponse} of ${s.closed} offers` : '' },
        { label: 'Families who passed', value: pct(s.familiesPassed, s.familiesOffered) || '—', hint: s.familiesOffered ? `${s.familiesPassed} of ${s.familiesOffered} offered, at least once` : '' },
        { label: 'Didn’t follow the rules', value: String(rules), hint: s.left ? `${pct(rules, s.left)} of the ${s.left} who left` : '' }
      ];
    },
    charts: (list, ctx) => {
      const s = offerAndExitStats(list);
      const ofOffers = (v) => `${v} (${pct(v, s.closed) || '0%'})`;
      const ofLeft = (v) => `${v} (${pct(v, s.left) || '0%'})`;
      const exits = list.filter((r) => r.kind === 'exit');
      const count = (rs, label) => { const m = new Map(); for (const r of rs) { const k = label(r); m.set(k, (m.get(k) || 0) + 1); } return [...m].map(([l, value]) => ({ label: l, value })); };
      const dated = list.filter((r) => r.date);
      const p = periodSeries(dated, ctx.range, { date: (r) => r.date, series: [
        { name: 'Passed', when: (r) => r.what === 'passed', color: SERIES_COLORS[1] },
        { name: 'No response', when: (r) => r.what === 'no_response', color: SERIES_COLORS[3] },
        { name: 'Removed for the rules', when: (r) => r.what === 'rules', color: SERIES_COLORS[7] }
      ] });
      return [
        { type: 'hbar', title: 'How offers ended', sort: false, showZero: true, color: SERIES_COLORS[2], format: ofOffers,
          rows: [{ label: 'Accepted', value: s.accepted }, { label: 'Passed', value: s.passed }, { label: 'No response', value: s.noResponse }],
          emptyText: 'No offers closed in this range.' },
        { type: 'hbar', title: 'Why families passed', color: SERIES_COLORS[6],
          rows: count(list.filter((r) => r.what === 'passed'), reason), emptyText: 'No passes in this range.' },
        { type: 'hbar', title: 'Why families left', sort: false, color: SERIES_COLORS[1], format: ofLeft,
          rows: s.byGroup.map((g) => ({ label: g.label, value: g.count })), emptyText: 'No one left the list in this range.' },
        { type: 'hbar', title: 'The rules they didn’t follow', color: SERIES_COLORS[7],
          rows: count(exits.filter((r) => r.what === 'rules'), reason), emptyText: 'No one was removed for the list’s rules in this range.' },
        { type: 'bar', title: `Passes and removals by ${p.granularity}`, categories: p.categories, series: p.series }
      ];
    },
    columns: [
      { header: 'Date', value: (r) => (r.date ? fmtDate(r.date) : ''), csv: (r) => r.date || '' },
      { header: 'Family', value: name },
      { header: 'What happened', value: (r) => whatLabel(r.what) },
      { header: 'Litter', value: litter },
      { header: 'Reason', value: reason },
      { header: 'Counted as a pass', value: (r) => (r.kind === 'offer' && r.offer.counts_as_pass === true ? 'Yes' : '') }
    ],
    onRowClick: (r) => { location.href = `waitlist-entry.html?id=${encodeURIComponent(r.entry.id)}`; },
    load: () => Promise.resolve(rows),
    emptyText: 'No offers closed or families left in this range.'
  });
}

init();
