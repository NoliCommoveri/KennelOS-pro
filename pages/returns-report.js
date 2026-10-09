// returns-report.js — "Returns & Voids" (Reports plan, phase 3). Sales that ended
// without the pup staying placed (vocab.RELEASED_SALE_STATUSES: cancelled by the
// buyer, voided, returned), with why (Sale.end_reason — required on voided and
// returned) and her note. The share is out of every sale made in the same range.
import { saleRepo } from '../data/saleRepo.js';
import { dogRepo } from '../data/dogRepo.js';
import { contactRepo } from '../data/contactRepo.js';
import { createReportView } from '../assets/reportView.js';
import { inScope } from '../data/kennelScope.js';
import { fmtDate } from '../assets/ui.js';
import { SALE_STATUS, SALE_END_REASON, RELEASED_SALE_STATUSES, isLostSale, descriptor } from '../data/vocab.js';
import { inRange, rankBy, pct } from '../data/reportMath.js';
import { SERIES_COLORS } from '../assets/chartView.js';

const reasonLabel = (s) => (s.end_reason ? descriptor(SALE_END_REASON, s.end_reason).label : s.status === 'cancelled' ? 'Buyer cancelled' : 'Reason not recorded');

async function init() {
  const [sales, dogs, contacts] = await Promise.all([
    saleRepo.getAll({ includeArchived: false }), dogRepo.getAll({ includeArchived: true }), contactRepo.getAll({ includeArchived: true })
  ]);
  const dogName = new Map(dogs.map((d) => [d.id, d.call_name || '—']));
  const contactName = new Map(contacts.map((c) => [c.id, c.name || '—']));
  const ended = sales.filter((s) => RELEASED_SALE_STATUSES.includes(s.status)).sort((a, b) => (b.sale_date || '').localeCompare(a.sale_date || ''));
  const allInScope = sales.filter(inScope);

  createReportView({
    mount: document.getElementById('report-mount'),
    scope: inScope,
    csvFilename: `returns-voids-${new Date().toISOString().slice(0, 10)}.csv`,
    search: { placeholder: 'Search pup or buyer…', text: (s) => `${dogName.get(s.dog_id) || ''} ${contactName.get(s.buyer_contact_id) || ''}` },
    dateRange: { label: 'Sold', date: (s) => s.sale_date },
    filters: [
      { id: 'status', label: 'Ended as', options: SALE_STATUS.filter((x) => RELEASED_SALE_STATUSES.includes(x.value)), match: (s, v) => s.status === v },
      { id: 'reason', label: 'Reason', options: SALE_END_REASON, match: (s, v) => s.end_reason === v }
    ],
    kpis: (list, ctx) => {
      const made = allInScope.filter((s) => inRange(s.sale_date, ctx.range)).length;
      const health = list.filter((s) => ['pup_died', 'failed_health_check', 'health_problem'].includes(s.end_reason)).length;
      return [
        { label: 'Ended', value: String(list.length), hint: made ? `${pct(list.length, made)} of ${made} sales in range` : '' },
        { label: 'Lost pups', value: String(list.filter(isLostSale).length), hint: 'voided, or returned for health' },
        { label: 'Health-related', value: String(health) },
        { label: 'Buyer cancelled', value: String(list.filter((s) => s.status === 'cancelled').length) }
      ];
    },
    charts: (list) => [{ type: 'hbar', title: 'Why sales ended', color: SERIES_COLORS[7], rows: rankBy(list, { key: reasonLabel }), emptyText: 'No sales ended in this range.' }],
    columns: [
      { header: 'Sold', value: (s) => (s.sale_date ? fmtDate(s.sale_date) : ''), csv: (s) => s.sale_date || '' },
      { header: 'Pup', value: (s) => dogName.get(s.dog_id) || '—' },
      { header: 'Buyer', value: (s) => contactName.get(s.buyer_contact_id) || '—' },
      { header: 'Ended as', value: (s) => s.status, badge: SALE_STATUS, csv: (s) => descriptor(SALE_STATUS, s.status).label },
      { header: 'Why', value: reasonLabel },
      { header: 'Note', value: (s) => s.end_note || '' }
    ],
    onRowClick: (s) => { location.href = `sale.html?id=${encodeURIComponent(s.id)}`; },
    load: () => Promise.resolve(ended),
    emptyText: 'No sales have ended without the pup staying placed.'
  });
}

init();
