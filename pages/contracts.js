// contracts.js — Contract List screen.
import { contractRepo } from '../data/contractRepo.js';
import { createListView } from '../assets/listView.js';
import { badge, esc } from '../assets/ui.js';
import { CONTRACT_TYPE, CONTRACT_STATUS } from '../data/vocab.js';

const mount = document.getElementById('contract-list');

const titleAsc = (a, b) => (a.title || '').localeCompare(b.title || '');
const typeAsc = (a, b) => (a.contract_type || '').localeCompare(b.contract_type || '');
const statusAsc = (a, b) => (a.status || '').localeCompare(b.status || '');
const signedDateAsc = (a, b) => (a.signed_date || a.created_at || '').localeCompare(b.signed_date || b.created_at || '');
const signedDateDesc = (a, b) => signedDateAsc(b, a);

createListView({
  mount,
  // The fallout: contracts not tied to any sale or stud service (co-own,
  // lease, other, and any unlinked sale/stud contract). Sale/stud-service
  // contracts live on their Sales/Stud Services cards instead.
  baseFilter: (c) => !c.related_sale_id && !c.related_stud_service_id,
  sort: signedDateDesc,
  search: {
    placeholder: 'Search title, terms…',
    text: (c) => `${c.title || ''} ${c.terms_summary || ''}`
  },
  filters: [
    { id: 'type', label: 'Type', options: CONTRACT_TYPE, match: (c, v) => c.contract_type === v },
    { id: 'status', label: 'Status', options: CONTRACT_STATUS, match: (c, v) => c.status === v }
  ],
  columns: [
    { header: 'Title', sortable: true, sortFn: titleAsc, cell: (c) => `<strong>${esc(c.title || '(untitled)')}</strong>` },
    { header: 'Type', sortable: true, sortFn: typeAsc, cell: (c) => badge(CONTRACT_TYPE, c.contract_type) },
    { header: 'Status', sortable: true, sortFn: statusAsc, cell: (c) => badge(CONTRACT_STATUS, c.status) },
    { header: 'Signed date', sortable: true, sortFn: signedDateAsc, cell: (c) => c.signed_date ? esc(c.signed_date) : '<span class="faint">—</span>' }
  ],
  onRowClick: (c) => { location.href = `contract.html?id=${encodeURIComponent(c.id)}`; },
  load: (o) => contractRepo.getAll(o),
  emptyText: 'No other contracts yet. Sale and stud-service contracts live on their Sales and Stud Services cards.'
});
