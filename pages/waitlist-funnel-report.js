// waitlist-funnel-report.js — "Waitlist Funnel" (Reports plan, phase 2). One row per
// family's time on a kennel's list, filtered by when they applied: how far they got
// (applied → approved → on the list → offered → placed), why the ones who left did,
// how their offers ended and why they passed, and how long placement took. Pure
// math in data/waitlistReports.js; scoped by each entry's kennel.
import { waitlistEntryRepo } from '../data/waitlistEntryRepo.js';
import { waitlistOfferRepo } from '../data/waitlistOfferRepo.js';
import { contactRepo } from '../data/contactRepo.js';
import { saleRepo } from '../data/saleRepo.js';
import { entryName } from '../data/waitlistRules.js';
import { FUNNEL_STAGES, funnelStage, funnelCounts, exitReasons, offerOutcomes, daysToPlacement, median } from '../data/waitlistReports.js';
import { createReportView } from '../assets/reportView.js';
import { inScope } from '../data/kennelScope.js';
import { fmtDate } from '../assets/ui.js';
import { todayYMD } from '../data/dateUtils.js';
import { daysBetween } from '../data/breedingReports.js';
import { WAITLIST_ENTRY_STATUS, descriptor } from '../data/vocab.js';
import { pct } from '../data/reportMath.js';
import { SERIES_COLORS } from '../assets/chartView.js';

async function init() {
  const [entries, offers, contacts, sales] = await Promise.all([
    waitlistEntryRepo.getAll({ includeArchived: false }),
    waitlistOfferRepo.getAll({ includeArchived: false }),
    contactRepo.getAll({ includeArchived: true }),
    saleRepo.getAll({ includeArchived: true })
  ]);
  const contactsById = new Map(contacts.map((c) => [c.id, c]));
  const salesById = new Map(sales.map((s) => [s.id, s]));
  const offered = new Set(offers.map((o) => o.entry_id));
  const today = todayYMD();
  const name = (e) => entryName(e, contactsById.get(e.contact_id) || null);
  const offersFor = (list) => { const ids = new Set(list.map((e) => e.id)); return offers.filter((o) => ids.has(o.entry_id)); };
  entries.sort((a, b) => (b.applied_date || '').localeCompare(a.applied_date || ''));

  createReportView({
    mount: document.getElementById('report-mount'),
    scope: inScope,
    csvFilename: `waitlist-funnel-${today}.csv`,
    search: { placeholder: 'Search family…', text: name },
    dateRange: { label: 'Applied', date: (e) => e.applied_date },
    filters: [
      { id: 'status', label: 'Status', options: WAITLIST_ENTRY_STATUS, match: (e, v) => e.status === v },
      { id: 'stage', label: 'Got as far as', options: FUNNEL_STAGES.map((s, i) => ({ value: String(i), label: s.label })), match: (e, v) => funnelStage(e, offered) === Number(v) }
    ],
    kpis: (list) => {
      const placed = list.filter((e) => funnelStage(e, offered) === 4).length;
      const days = median(daysToPlacement(list, salesById));
      return [
        { label: 'Applied', value: String(list.length) },
        { label: 'On the list now', value: String(list.filter((e) => e.status === 'active').length) },
        { label: 'Placed', value: String(placed), hint: list.length ? `${pct(placed, list.length)} of applicants` : '' },
        { label: 'Applied → placed', value: days == null ? '—' : `${Math.round(days)} days`, hint: days == null ? '' : 'median' }
      ];
    },
    charts: (list) => {
      const { outcomes, reasons } = offerOutcomes(offersFor(list));
      return [
        { type: 'hbar', title: 'How far families got', sort: false, showZero: true,
          rows: funnelCounts(list, offersFor(list)).map((s) => ({ label: s.label, value: s.count })) },
        { type: 'hbar', title: 'Why families left', color: SERIES_COLORS[1], rows: exitReasons(list), emptyText: 'No one has left the list in this range.' },
        { type: 'hbar', title: 'How offers ended', color: SERIES_COLORS[2], rows: outcomes, emptyText: 'No offers have closed yet.' },
        { type: 'hbar', title: 'Why families passed', color: SERIES_COLORS[6], rows: reasons, emptyText: 'No passes in this range.' }
      ];
    },
    columns: [
      { header: 'Applied', value: (e) => (e.applied_date ? fmtDate(e.applied_date) : ''), csv: (e) => e.applied_date || '' },
      { header: 'Family', value: name },
      { header: 'Status', value: (e) => e.status || '', badge: WAITLIST_ENTRY_STATUS, csv: (e) => (e.status ? descriptor(WAITLIST_ENTRY_STATUS, e.status).label : '') },
      { header: 'Got as far as', value: (e) => FUNNEL_STAGES[funnelStage(e, offered)].label },
      { header: 'Days', value: (e) => {
        const sale = e.placed_sale_id ? salesById.get(e.placed_sale_id) : null;
        if (sale?.sale_date && e.applied_date) return `${daysBetween(e.applied_date, sale.sale_date)} to placement`;
        if (e.status === 'active' && e.applied_date) return `${daysBetween(e.applied_date, today)} so far`;
        return '';
      } }
    ],
    onRowClick: (e) => { location.href = `waitlist-entry.html?id=${encodeURIComponent(e.id)}`; },
    load: () => Promise.resolve(entries),
    emptyText: 'No waitlist applications in this range.'
  });
}

init();
