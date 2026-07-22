// placements-report.js — "Placements" analytics (Stage 5, Build Brief §5): Sales
// by status / placement_type / period. Derived read over Sale; buyer resolves to
// a Contact (there is no Buyer table). Reuses the reporting framework; no new
// schema, no stored aggregate.
import { saleRepo } from '../data/saleRepo.js';
import { dogRepo } from '../data/dogRepo.js';
import { contactRepo } from '../data/contactRepo.js';
import { createReportView } from '../assets/reportView.js';
import { fmtDate } from '../assets/ui.js';
import { PLACEMENT_TYPE, SALE_STATUS, descriptor } from '../data/vocab.js';

async function init() {
  const [sales, dogs, contacts] = await Promise.all([
    saleRepo.getAll({ includeArchived: false }),
    dogRepo.getAll({ includeArchived: true }),
    contactRepo.getAll({ includeArchived: true })
  ]);
  const dogsById = new Map(dogs.map((d) => [d.id, d]));
  const contactsById = new Map(contacts.map((c) => [c.id, c]));
  const dogName = (s) => dogsById.get(s.dog_id)?.call_name || '—';
  const buyerName = (s) => contactsById.get(s.buyer_contact_id)?.name || '—';
  const year = (s) => (s.sale_date || '').slice(0, 4);
  const years = [...new Set(sales.map(year).filter(Boolean))].sort().reverse();

  sales.sort((a, b) => (b.sale_date || '').localeCompare(a.sale_date || ''));

  createReportView({
    mount: document.getElementById('report-mount'),
    csvFilename: `placements-${new Date().toISOString().slice(0, 10)}.csv`,
    search: { placeholder: 'Search dog or buyer…', text: (s) => `${dogName(s)} ${buyerName(s)}` },
    filters: [
      { id: 'placement_type', label: 'Type', options: PLACEMENT_TYPE, match: (s, v) => s.placement_type === v },
      { id: 'status', label: 'Status', options: SALE_STATUS, match: (s, v) => s.status === v },
      { id: 'year', label: 'Year', options: years.map((y) => ({ value: y, label: y })), match: (s, v) => year(s) === v }
    ],
    columns: [
      { header: 'Sale date', value: (s) => (s.sale_date ? fmtDate(s.sale_date) : ''), csv: (s) => s.sale_date || '' },
      { header: 'Dog', value: dogName },
      { header: 'Buyer', value: buyerName },
      { header: 'Type', value: (s) => s.placement_type || '', badge: PLACEMENT_TYPE, csv: (s) => s.placement_type ? descriptor(PLACEMENT_TYPE, s.placement_type).label : '' },
      { header: 'Status', value: (s) => s.status || '', badge: SALE_STATUS, csv: (s) => s.status ? descriptor(SALE_STATUS, s.status).label : '' }
    ],
    onRowClick: (s) => { location.href = `sale.html?id=${encodeURIComponent(s.id)}`; },
    load: () => Promise.resolve(sales),
    emptyText: 'No sales recorded yet.'
  });
}

init();
